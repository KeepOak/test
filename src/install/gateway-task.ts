import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { runTool, systemTool, type RunTool } from "./windows.js";

/**
 * UP-PLATFORM-002, Windows: the operating system keeps Branch's background gateway running. A scheduled task starts
 * `"Branch Agent.exe" --branch-gateway` itself (no script host, no console) and Task Scheduler starts it again when
 * it stops by accident: a minute later, up to three times. A gateway that ends on purpose (another copy already runs,
 * the owner switched it off) exits cleanly and is left alone.
 *
 * Where `schtasks` is refused (some managed or locked-down accounts answer "Access is denied"), a shortcut in the
 * person's own Startup folder starts the same program at sign-in instead. Nothing restarts it there, but it starts.
 *
 * The task's settings follow OpenClaw's `src/daemon/schtasks-xml.ts` and the fallback decision its
 * `shouldFallbackToStartupEntry` (`src/daemon/schtasks-layout.ts`), https://github.com/openclaw/openclaw, MIT; the
 * localized "access is denied" words follow Hermes Agent's `hermes_cli/gateway_windows.py`,
 * https://github.com/NousResearch/hermes-agent, MIT.
 */
export const gatewayTaskName = "Branch Agent daemon";
export const gatewayFlag = "--branch-gateway";
export const startupShortcutName = "Branch Agent gateway.lnk";
/** What was registered last and how, so a window that opens again does not ask Task Scheduler every time. */
export const gatewayTaskMarker = "gateway-task.json";

export interface GatewayTaskInput {
  /** The installed app's own program ("Branch Agent.exe"). */
  executable: string;
  /** Start at sign-in (the owner's "Start with Windows"); off, the task only restarts a gateway it started itself. */
  atSignIn: boolean;
  /** `DOMAIN\user` the task belongs to; without one it is left to the Users group, as OpenClaw does. */
  user: string | null;
}

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Task Scheduler's own XML: needed to switch off the battery stops and set restart on failure. */
export function gatewayTaskXml(input: GatewayTaskInput): string {
  const user = input.user ? escapeXml(input.user) : null;
  const trigger = input.atSignIn
    ? `\n  <Triggers>\n    <LogonTrigger>\n      <Enabled>true</Enabled>${user ? `\n      <UserId>${user}</UserId>` : ""}\n    </LogonTrigger>\n  </Triggers>`
    : "";
  const principal = user ? `\n      <UserId>${user}</UserId>\n      <LogonType>InteractiveToken</LogonType>` : "\n      <GroupId>S-1-5-32-545</GroupId>";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps Branch Agent working with the window closed, and starts it again if it stops by accident.</Description>
  </RegistrationInfo>${trigger}
  <Principals>
    <Principal id="Author">${principal}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(input.executable)}</Command>
      <Arguments>${gatewayFlag}</Arguments>
      <WorkingDirectory>${escapeXml(win32.dirname(input.executable))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/** `schtasks /XML` reads UTF-16 little-endian with a byte-order mark on every language of Windows. */
export const taskXmlBytes = (xml: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);

export const createTaskArgs = (xmlPath: string, name = gatewayTaskName) => ["/Create", "/F", "/TN", name, "/XML", xmlPath];
export const runTaskArgs = (name = gatewayTaskName) => ["/Run", "/TN", name];
export const deleteTaskArgs = (name = gatewayTaskName) => ["/Delete", "/F", "/TN", name];
export const queryTaskArgs = (name = gatewayTaskName) => ["/Query", "/TN", name];

/** schtasks' "access is denied" in the languages Hermes Agent lists, and a few more whose words are plain ASCII. */
const accessDenied = new RegExp([
  "access is denied", "acceso denegado", "zugriff verweigert", "acc[eè]s refus[eé]", "accesso negato", "acesso negado",
  "přístup byl odepřen", "拒绝访问", "拒絕存取", "アクセスが拒否されました", "액세스가 거부되었습니다",
].join("|"), "i");

/** Refused, or stuck until it was stopped: the Startup folder is used instead. Any other failure is a real problem. */
export function shouldFallBackToStartup(error: unknown): boolean {
  const cause = (error as { cause?: { killed?: boolean; code?: unknown; signal?: unknown } } | null)?.cause;
  if (cause?.killed || cause?.code === "ETIMEDOUT") return true;
  const detail = error instanceof Error ? error.message : String(error);
  return accessDenied.test(detail) || /timed out|produced no output/i.test(detail);
}

/** The person's own Startup folder: what is there starts when they sign in, with no administrator rights. */
export function startupShortcutPath(env: NodeJS.ProcessEnv = process.env): string {
  const roaming = env.APPDATA?.trim() || (env.USERPROFILE?.trim() ? join(env.USERPROFILE.trim(), "AppData", "Roaming") : "");
  if (!roaming) throw new Error("Windows did not say where this account's Startup folder is.");
  return join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", startupShortcutName);
}

export interface StartupShortcut { path: string; target: string; arguments: string; workingDirectory: string; description: string }
export type WriteShortcut = (shortcut: StartupShortcut) => Promise<void>;

/**
 * Writes the shortcut through Windows' own shell object from PowerShell, with every value handed over in the
 * environment so nothing is quoted into the command. No VBScript: Windows is removing it.
 */
export const powershellShortcut: WriteShortcut = (shortcut) => new Promise((resolve, reject) => {
  const script = "$l=(New-Object -ComObject WScript.Shell).CreateShortcut($env:BRANCH_LNK);$l.TargetPath=$env:BRANCH_LNK_TARGET;"
    + "$l.Arguments=$env:BRANCH_LNK_ARGS;$l.WorkingDirectory=$env:BRANCH_LNK_DIR;$l.Description=$env:BRANCH_LNK_WHAT;$l.Save()";
  const env = { ...process.env, BRANCH_LNK: shortcut.path, BRANCH_LNK_TARGET: shortcut.target, BRANCH_LNK_ARGS: shortcut.arguments,
    BRANCH_LNK_DIR: shortcut.workingDirectory, BRANCH_LNK_WHAT: shortcut.description };
  execFile(systemTool(win32.join("WindowsPowerShell", "v1.0", "powershell.exe")), ["-NoProfile", "-NonInteractive", "-Command", script],
    { env, windowsHide: true, timeout: 30000 }, (error, _out, stderr) =>
      error ? reject(new Error(`The Startup shortcut could not be written: ${(stderr || error.message).trim().slice(0, 300)}`)) : resolve());
});

export interface GatewayTaskDeps {
  run?: RunTool;
  writeShortcut?: WriteShortcut;
  env?: NodeJS.ProcessEnv;
  systemRoot?: string;
}
export type GatewaySupervision = "task" | "startup" | "none";

const schtasks = (deps: GatewayTaskDeps) => systemTool("schtasks.exe", deps.systemRoot);
const exists = (path: string) => access(path).then(() => true, () => false);

/** The account the task belongs to, from Windows' own variables. */
export function taskUser(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.USERNAME?.trim(), domain = env.USERDOMAIN?.trim();
  return name ? (domain ? `${domain}\\${name}` : name) : null;
}

/** An installed app's program, never a plain Node from a source checkout, which has no `--branch-gateway`. */
export function isAppProgram(executable: string): boolean {
  return Boolean(executable) && !/^node(\.exe)?$/i.test(win32.basename(executable));
}

export interface RegisterInput extends GatewayTaskInput {
  /** Where the task's XML is written for the moment it is read (the data folder). */
  dataDir: string;
}

/**
 * Registers the task, or where schtasks is refused, the Startup shortcut (only when starting at sign-in is wanted:
 * without it there is nothing a shortcut could do). Answers how the gateway is looked after now.
 */
export async function registerGatewayTask(input: RegisterInput, deps: GatewayTaskDeps = {}): Promise<GatewaySupervision> {
  if (!isAppProgram(input.executable)) throw new Error("Only the installed Branch Agent app can keep working in the background on Windows.");
  const run = deps.run ?? runTool, xmlPath = join(input.dataDir, "gateway-task.xml");
  await writeFile(xmlPath, taskXmlBytes(gatewayTaskXml(input)));
  try {
    await run(schtasks(deps), createTaskArgs(xmlPath));
    await rm(startupShortcutPath(deps.env), { force: true }).catch(() => undefined); // the task starts it now
    return "task";
  } catch (error) {
    if (!shouldFallBackToStartup(error)) throw error;
    if (!input.atSignIn) { await rm(startupShortcutPath(deps.env), { force: true }).catch(() => undefined); return "none"; }
    await (deps.writeShortcut ?? powershellShortcut)({ path: startupShortcutPath(deps.env), target: input.executable,
      arguments: gatewayFlag, workingDirectory: win32.dirname(input.executable), description: "Branch Agent, working with the window closed" });
    return "startup";
  } finally { await rm(xmlPath, { force: true }).catch(() => undefined); }
}

/** Takes the task and the Startup shortcut away; whichever is not there is simply not there. */
export async function removeGatewayTask(deps: GatewayTaskDeps = {}): Promise<void> {
  await (deps.run ?? runTool)(schtasks(deps), deleteTaskArgs()).catch(() => undefined);
  await rm(startupShortcutPath(deps.env), { force: true }).catch(() => undefined);
}

/** How the gateway is looked after on this computer right now: the task, the Startup shortcut, or neither. */
export async function gatewaySupervision(deps: GatewayTaskDeps = {}): Promise<GatewaySupervision> {
  if (await (deps.run ?? runTool)(schtasks(deps), queryTaskArgs()).then(() => true, () => false)) return "task";
  return (await exists(startupShortcutPath(deps.env))) ? "startup" : "none";
}

/** Starts the gateway through its task, so Task Scheduler restarts it if it stops by accident. */
export async function runGatewayTask(deps: GatewayTaskDeps = {}): Promise<void> {
  await (deps.run ?? runTool)(schtasks(deps), runTaskArgs());
}

interface Marker { hash: string; kind: GatewaySupervision }

/**
 * Registered as `input` asks, doing nothing when the last registration was the same and is still there. Called each
 * time the window starts the gateway and when "Start with Windows" changes, so the sign-in trigger follows that switch.
 */
export async function ensureGatewayTask(input: RegisterInput, deps: GatewayTaskDeps = {}): Promise<GatewaySupervision> {
  const hash = createHash("sha256").update(gatewayTaskXml(input)).digest("hex"), file = join(input.dataDir, gatewayTaskMarker);
  const saved = await readFile(file, "utf8").then((text) => JSON.parse(text) as Marker, () => null);
  // "none" (refused, with nothing wanted at sign-in) is not asked again until what is wanted changes.
  if (saved?.hash === hash && (saved.kind === "none" || (await gatewaySupervision(deps)) === saved.kind)) return saved.kind;
  const kind = await registerGatewayTask(input, deps);
  await writeFile(file, JSON.stringify({ hash, kind } satisfies Marker)).catch(() => undefined);
  return kind;
}

/** Only for a computer where the window registered the task: "Start with Windows" changed, so its trigger follows. */
export async function followSignInChoice(input: RegisterInput, deps: GatewayTaskDeps = {}): Promise<GatewaySupervision | null> {
  if (!(await exists(join(input.dataDir, gatewayTaskMarker)))) return null;
  return ensureGatewayTask(input, deps);
}

/** Forgets the registration, so the next window registers again (after `branch daemon uninstall`). */
export const forgetGatewayTask = (dataDir: string) => rm(join(dataDir, gatewayTaskMarker), { force: true }).catch(() => undefined);
