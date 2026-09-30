import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, win32 } from "node:path";
import { runTool, systemTool, type RunTool } from "./windows.js";

/**
 * UP-PLATFORM-002, Windows: the operating system keeps Branch's background gateway running. A scheduled task starts
 * `"Branch Agent.exe" --branch-gateway` itself (no script host, no console) and Task Scheduler starts it again when
 * it stops by accident: a minute later, up to three times. A gateway that ends on purpose (another copy already runs,
 * the owner switched it off) exits cleanly and is left alone.
 *
 * Where Task Scheduler refuses (some managed or locked-down accounts get E_ACCESSDENIED, "Access is denied"), a
 * shortcut in the person's own Startup folder starts the same program at sign-in instead. Nothing restarts it there,
 * but it starts.
 *
 * The task's settings follow OpenClaw's `src/daemon/schtasks-xml.ts` and the fallback decision its
 * `shouldFallbackToStartupEntry` (`src/daemon/schtasks-layout.ts`), https://github.com/openclaw/openclaw, MIT. The
 * refusal is told by its HRESULT, not by schtasks' words, which are in the computer's own language.
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
  /**
   * `DOMAIN\user` the task belongs to (`taskUser`). Without one nothing is registered: a task left to a group (the
   * Users group, as OpenClaw does) would start this person's gateway at any other account's sign-in.
   */
  user: string | null;
}

export const unknownUserWords = "Windows did not say which account is signed in, so Branch did not register its background task.";

/** The account, or a refusal: never a group. */
function owner(input: GatewayTaskInput): string {
  const user = input.user?.trim();
  if (!user || /[\r\n]/.test(user)) throw new Error(unknownUserWords);
  return user;
}

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Task Scheduler's own XML: needed to switch off the battery stops and set restart on failure. */
export function gatewayTaskXml(input: GatewayTaskInput): string {
  const user = escapeXml(owner(input));
  const trigger = input.atSignIn
    ? `\n  <Triggers>\n    <LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>${user}</UserId>\n    </LogonTrigger>\n  </Triggers>`
    : "";
  const principal = `\n      <UserId>${user}</UserId>\n      <LogonType>InteractiveToken</LogonType>`;
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

/** Task Scheduler reads the XML as UTF-16 little-endian with a byte-order mark on every language of Windows. */
export const taskXmlBytes = (xml: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);

export const runTaskArgs = (name = gatewayTaskName) => ["/Run", "/TN", name];
export const deleteTaskArgs = (name = gatewayTaskName) => ["/Delete", "/F", "/TN", name];
export const queryTaskArgs = (name = gatewayTaskName) => ["/Query", "/TN", name];

/** Windows PowerShell 5.1, which every Windows 10 and 11 has, at its fixed place. */
export const powershellPath = (systemRoot?: string) => systemTool(win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), systemRoot);
const psText = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Registers the task through Task Scheduler's own interface (the one schtasks uses), from PowerShell. schtasks answers
 * every failure with exit code 1 and a sentence in the computer's language; this prints the failure's HRESULT, so a
 * refusal is told apart by number on every language of Windows (`hresult=0x80070005`, E_ACCESSDENIED).
 * RegisterTask: 6 is create-or-update, 3 is the signed-in person's own interactive token.
 */
export function registerTaskArgs(xmlPath: string, name = gatewayTaskName): string[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    "try {",
    "$s=New-Object -ComObject Schedule.Service; $s.Connect()",
    `[void]$s.GetFolder('\\').RegisterTask(${psText(name)}, [IO.File]::ReadAllText(${psText(xmlPath)}), 6, $null, $null, 3)`,
    // PowerShell wraps a failed call (MethodInvocationException, 0x80131501); the innermost exception is the real one.
    "} catch { $e=$_.Exception; while ($e.InnerException) { $e=$e.InnerException }",
    "[Console]::Error.WriteLine(('hresult=0x{0:X8} {1}' -f $e.HResult, $e.Message)); exit 1 }",
  ].join("\n");
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/** E_ACCESSDENIED (0x80070005), the "Access is denied" that some managed or locked-down accounts get. */
export const accessDeniedHresult = 0x80070005;

/** The HRESULT `registerTaskArgs` printed on failure, or null when it printed none (PowerShell itself failed). */
export function failureHresult(error: unknown): number | null {
  const found = /hresult=0x([0-9a-f]{8})/i.exec(error instanceof Error ? error.message : String(error));
  return found ? Number.parseInt(found[1]!, 16) : null;
}

/** Refused, or stuck until it was stopped: the Startup folder is used instead. Any other failure is a real problem. */
export function shouldFallBackToStartup(error: unknown): boolean {
  const cause = (error as { cause?: { killed?: boolean; code?: unknown } } | null)?.cause;
  if (cause?.killed || cause?.code === "ETIMEDOUT") return true;
  return failureHresult(error) === accessDeniedHresult;
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
  execFile(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", script],
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

/**
 * The account the task belongs to: Windows' own variables, or else the account this process runs as. Null when neither
 * says, and then nothing is registered (`GatewayTaskInput.user`).
 */
export function taskUser(env: NodeJS.ProcessEnv = process.env, account: () => string = () => userInfo().username): string | null {
  const name = env.USERNAME?.trim(), domain = env.USERDOMAIN?.trim();
  if (name) return domain ? `${domain}\\${name}` : name;
  try { return account().trim() || null; } catch { return null; }
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
 * Registers the task, or where Task Scheduler refuses, the Startup shortcut (only when starting at sign-in is wanted:
 * without it there is nothing a shortcut could do). Answers how the gateway is looked after now.
 */
export async function registerGatewayTask(input: RegisterInput, deps: GatewayTaskDeps = {}): Promise<GatewaySupervision> {
  if (!isAppProgram(input.executable)) throw new Error("Only the installed Branch Agent app can keep working in the background on Windows.");
  owner(input); // refused before anything is written: never a task for a group
  const run = deps.run ?? runTool, xmlPath = join(input.dataDir, "gateway-task.xml");
  await writeFile(xmlPath, taskXmlBytes(gatewayTaskXml(input)));
  try {
    await run(powershellPath(deps.systemRoot), registerTaskArgs(xmlPath));
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

export interface StartAgainDeps extends GatewayTaskDeps {
  /** Starts a program on its own, with no window and nothing of this process's kept open (tests hand in a stand-in). */
  start?: (file: string, args: string[], env: NodeJS.ProcessEnv) => void;
}

/**
 * After an update or a rollback (src/install/service-return.ts): the gateway is started again through its task; where
 * only the Startup shortcut looks after it (Task Scheduler refused the task), the app's gateway is started directly,
 * as the shortcut would at the next sign-in. Anything else is left to the caller as the task's own failure.
 */
export async function startGatewayAgain(executable: string, deps: StartAgainDeps = {}): Promise<"task" | "direct"> {
  try { await runGatewayTask(deps); return "task"; }
  catch (error) {
    if (!isAppProgram(executable) || !(await exists(startupShortcutPath(deps.env)))) throw error;
    const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env) };
    delete env.ELECTRON_RUN_AS_NODE; // the gateway is the app itself, never its runtime run as Node
    delete env.NODE_OPTIONS;
    (deps.start ?? startDetached)(executable, [gatewayFlag], env);
    return "direct";
  }
}

const startDetached = (file: string, args: string[], env: NodeJS.ProcessEnv): void => {
  const child = spawn(file, args, { env, detached: true, stdio: "ignore", windowsHide: true, cwd: win32.dirname(file) });
  child.on("error", () => undefined);
  child.unref();
};

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
