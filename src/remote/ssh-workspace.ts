import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { ShellProcess } from "../integrations/shell-process.js";
import { posixEnvironment } from "../integrations/shell-config.js";
import { audit } from "../audit.js";
import type { Store } from "../store.js";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import { currentAccountCall } from "../accounts/context.js";

/**
 * A workspace on another computer, reached with the OpenSSH client Windows already has. Nothing is
 * installed and no password is ever handled: a computer can only be added by the short name the
 * owner already wrote in their own `~/.ssh/config`, and it is only reachable if its key is already
 * in their `known_hosts`. An unknown computer is refused rather than trusted, and Branch never
 * passes `StrictHostKeyChecking=no` — the whole point of the row is that it does not.
 *
 * `ssh` itself is the boundary the network policy would otherwise be: every byte goes through the
 * child process, so nothing here can be used to reach an address the web rules refuse. That is
 * said out loud in the docs and shown on the approval card, which names the computer.
 */
export const aliasSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  "Use the short name you gave the computer in your SSH config, such as \"tower\"");
const remoteTextPattern = /^[^\0\r\n]*$/;
const remoteTextMessage = "Remote paths, programs and arguments cannot contain NUL or a line break";
const remoteProgramSchema = z.string().regex(remoteTextPattern, remoteTextMessage).trim().min(1).max(80);
const remoteArgumentSchema = z.string().max(300).regex(remoteTextPattern, remoteTextMessage);
const remoteArgumentsSchema = z.array(remoteArgumentSchema).max(32);
const remoteExecutionSchema = z.object({ program: remoteProgramSchema, args: remoteArgumentsSchema });
/** The folder on that computer everything is kept inside; always given in full, from the root. */
export const remoteRootSchema = z.string().regex(remoteTextPattern, remoteTextMessage)
  .trim().min(1).max(300).regex(/^(\/|~\/)/, "Give the folder in full, starting at / or ~/");

export const RemoteComputerSchema = z.object({
  alias: aliasSchema,
  root: remoteRootSchema,
  /** A name the owner will recognise in the list. */
  label: z.string().trim().max(80).default(""),
  /**
   * The only programs that may be run on that computer. Empty means none: a remote computer starts
   * able to hold files and nothing else, and the owner adds what it may run one at a time.
   */
  executables: z.array(remoteProgramSchema).max(32).default([]),
  /**
   * Q4: the Trunks the owner lent this computer to, by id. A Trunk's work may use only a computer listed for it; the
   * owner's own conversations may use every one. Empty means no Trunk may.
   */
  trunks: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  addedAt: z.string().max(40).default(""),
}).strict();
export type RemoteComputer = z.infer<typeof RemoteComputerSchema>;
const ListSchema = z.object({ computers: z.array(RemoteComputerSchema).max(16).default([]) }).strict();
const remotesKey = "remote-computers";

/** Runs one of the OpenSSH programs. Replaced in tests, so no connection is ever really made. */
export interface SshRun {
  (executable: string, args: string[], signal: AbortSignal):
    Promise<{ status: string; stdout: string; stderr: string; exitCode: number | null }>;
}
export interface SshSuite { ssh: string; scp: string; sshKeygen: string }
type ExecutableExists = (path: string) => Promise<boolean>;

function environmentValue(source: NodeJS.ProcessEnv, wanted: string): string {
  return Object.entries(source).find(([name]) => name.toUpperCase() === wanted)?.[1] ?? "";
}

function sshCandidates(platform: NodeJS.Platform, source: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const root = environmentValue(source, "SYSTEMROOT") || environmentValue(source, "WINDIR");
  if (platform === "win32" && root) candidates.push(join(root, "System32", "OpenSSH", "ssh.exe"));
  if (platform === "darwin") candidates.push("/usr/bin/ssh");
  const separator = platform === "win32" ? ";" : ":";
  for (const raw of environmentValue(source, "PATH").split(separator)) {
    const folder = raw.trim().replace(/^"|"$/g, "");
    if (isAbsolute(folder)) candidates.push(join(folder, sshProgram("ssh", platform)));
  }
  return [...new Set(candidates)];
}

/** Resolves ssh once, then requires scp and ssh-keygen beside that exact executable. */
export async function resolveSshSuite(
  platform: NodeJS.Platform = process.platform, source: NodeJS.ProcessEnv = process.env,
  exists?: ExecutableExists,
): Promise<SshSuite> {
  const canRun = exists ?? (async (path: string) =>
    access(path, platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false));
  let ssh = "";
  for (const candidate of sshCandidates(platform, source)) {
    if (await canRun(candidate)) { ssh = candidate; break; }
  }
  if (!ssh) throw new Error("OpenSSH was not found in the system folder or PATH.");
  const folder = dirname(ssh);
  const scp = join(folder, sshProgram("scp", platform));
  const sshKeygen = join(folder, sshProgram("ssh-keygen", platform));
  if (!(await canRun(scp))) throw new Error("The same OpenSSH folder as ssh is missing its sibling scp.");
  if (!(await canRun(sshKeygen))) throw new Error("The same OpenSSH folder as ssh is missing its sibling ssh-keygen.");
  return { ssh, scp, sshKeygen };
}

export function sshSuiteProgram(suite: SshSuite, name: string): string {
  if (name === "ssh") return suite.ssh;
  if (name === "scp") return suite.scp;
  if (name === "ssh-keygen") return suite.sshKeygen;
  throw new Error(`Unsupported OpenSSH program: ${name}`);
}
/**
 * The real one: the OpenSSH programs Windows ships with, started as ordinary child processes with
 * the same limits every other host command gets. Nothing is downloaded and no shell is involved.
 */
export function sshRunner(timeoutMs = 60_000): SshRun {
  let resolved: Promise<SshSuite> | undefined;
  return async (executable, args, signal) => {
    resolved ??= resolveSshSuite();
    const program = sshSuiteProgram(await resolved, executable);
    const result = await new ShellProcess({
      executable: program, args,
      cwd: tmpdir(), env: sshEnvironment(), signal, timeoutMs,
      maxOutputBytes: 65536, maxMemoryMb: 512, maxCpuSeconds: 120,
    }).run();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };
}
/** The OpenSSH program's name: with `.exe` on Windows, as it is on macOS and Linux. */
export const sshProgram = (name: string, platform: NodeJS.Platform = process.platform): string =>
  `${name}${platform === "win32" ? ".exe" : ""}`;
/** The little ssh needs from this computer: where it is, and where the owner's keys are. */
export function sshEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const keep = ["PATH", "SYSTEMROOT", "WINDIR", "PROGRAMDATA", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const entry = Object.entries(source).find(([name]) => name.toUpperCase() === key);
    if (entry?.[1]) env[key] = entry[1];
  }
  // macOS and Linux keep unlocked keys in an agent; ssh finds it through SSH_AUTH_SOCK.
  Object.assign(env, posixEnvironment(["SSH_AUTH_SOCK", "USER", "LOGNAME", "TMPDIR"], source, platform));
  return { ...env, SSH_ASKPASS: "", DISPLAY: "" };
}

/** Where the owner's own SSH files live. A different folder in tests; never written to. */
export interface SshHome { config: string; knownHosts: string }
export const defaultSshHome = (): SshHome =>
  ({ config: join(homedir(), ".ssh", "config"), knownHosts: join(homedir(), ".ssh", "known_hosts") });

/** The options forced on every call: no password prompt, no question about an unknown computer. */
export const sshOptions = [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "PasswordAuthentication=no",
  "-o", "KbdInteractiveAuthentication=no",
  "-o", "NumberOfPasswordPrompts=0",
  "-o", "ConnectTimeout=10",
];

/** One literal argument for the POSIX shell OpenSSH uses at the far end. */
export function quoteRemoteArg(value: string): string {
  if (!remoteTextPattern.test(value)) throw new Error(remoteTextMessage);
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** OpenSSH sends a command string, not an argv array, so preserve every boundary in that string. */
export function remoteCommand(args: string[]): string {
  if (args.length === 0) throw new Error("A remote command needs at least one argument");
  return args.map(quoteRemoteArg).join(" ");
}

/** The `Host` names in the owner's own SSH config, and the real name each one stands for. */
export function parseSshConfig(text: string): Map<string, string> {
  const hosts = new Map<string, string>();
  let current: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyword, ...rest] = line.split(/[\s=]+/);
    const key = (keyword ?? "").toLowerCase(), value = rest.join(" ").trim();
    if (key === "host") {
      current = rest.filter((name) => !name.includes("*") && !name.includes("?"));
      for (const name of current) if (!hosts.has(name)) hosts.set(name, name);
    } else if (key === "hostname" && value) {
      for (const name of current) hosts.set(name, value);
    }
  }
  return hosts;
}

/** Whether a computer's key is already in the owner's known_hosts, by plain name. */
export function knownHostNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("|")) continue;
    const first = line.split(/\s+/)[0] ?? "";
    for (const name of first.split(","))
      names.add(name.replace(/^\[/, "").replace(/\]:\d+$/, "").toLowerCase());
  }
  return names;
}

/** A path on the other computer, kept inside that computer's root exactly as workspace paths are. */
export function remotePath(root: string, path: string): string {
  if (!remoteTextPattern.test(root) || !remoteTextPattern.test(path)) throw new Error(remoteTextMessage);
  const clean = path.replace(/\\/g, "/").trim();
  if (!clean || clean === ".") return root;
  if (clean.startsWith("/") || clean.startsWith("~") || clean.includes(":"))
    throw new Error("Give the file's place inside that computer's folder, such as \"reports/march.csv\".");
  if (clean.split("/").some((part) => part === ".." || part === "" || part.endsWith(" ")))
    throw new Error("Path denied: traversal");
  return `${root.replace(/\/+$/, "")}/${clean}`;
}

export class RemoteWorkspaces {
  constructor(
    private readonly store: Store, private readonly owner: string,
    private readonly run: SshRun, private readonly home: SshHome = defaultSshHome(),
  ) {}

  /** The computers the work may use: every one for the owner's own conversations, a Trunk's only where lent to it. */
  listFor(trunk: string | null): RemoteComputer[] {
    return this.list().filter((computer) => trunk === null || computer.trunks.includes(trunk));
  }
  /** One computer, refused by name to a Trunk the owner did not lend it to. */
  getFor(alias: string, trunk: string | null): RemoteComputer {
    const computer = this.get(alias);
    if (trunk !== null && !computer.trunks.includes(trunk)) throw new Error(trunkRemoteRefusal(alias));
    return computer;
  }

  list(): RemoteComputer[] {
    const saved = ListSchema.safeParse(this.store.get("settings", this.owner, remotesKey)?.data ?? {});
    return saved.success ? saved.data.computers : [];
  }
  get(alias: string): RemoteComputer {
    const found = this.list().find((computer) => computer.alias === alias);
    if (!found) throw new Error(`"${alias}" is not one of the computers you have set up. The owner adds those in Settings.`);
    return found;
  }

  /**
   * Adds a computer. Both halves of the check read the owner's own files and nothing else: the
   * short name has to be one they wrote in their SSH config, and its key has to be one they have
   * already accepted. Neither can be supplied here, so this cannot be used to trust a stranger.
   */
  async add(input: unknown): Promise<RemoteComputer> {
    const wanted = RemoteComputerSchema.parse({ ...(input as object ?? {}), addedAt: new Date().toISOString() });
    const config = await readFile(this.home.config, "utf8").catch(() => "");
    const hosts = parseSshConfig(config);
    const realName = hosts.get(wanted.alias);
    if (!realName)
      throw new Error(`"${wanted.alias}" is not in your SSH config, so Branch has no way to reach it. Add it there first — Branch never asks for a password.`);
    const known = knownHostNames(await readFile(this.home.knownHosts, "utf8").catch(() => ""));
    if (!known.has(realName.toLowerCase()) && !known.has(wanted.alias.toLowerCase()) && !(await this.hashedKnownHost(realName)))
      throw new Error(`Branch has never seen ${realName} before and will not take its word for who it is. Connect to it once yourself, check the key it shows you, and then add it here.`);
    const computers = [...this.list().filter((computer) => computer.alias !== wanted.alias), wanted];
    this.store.save("settings", this.owner, remotesKey, { computers });
    audit(this.store, this.owner, { action: "channel.paired", actor: this.owner,
      subject: `${wanted.alias} (${realName})`, reason: "Another computer was added as a place to work", outcome: "saved" });
    return wanted;
  }
  remove(alias: string): boolean {
    const before = this.list();
    const after = before.filter((computer) => computer.alias !== alias);
    if (after.length === before.length) return false;
    this.store.save("settings", this.owner, remotesKey, { computers: after });
    return true;
  }

  /** known_hosts can hide the names; when it does, only ssh's own tool can answer. */
  private async hashedKnownHost(host: string): Promise<boolean> {
    const out = await this.run("ssh-keygen", ["-F", host, "-f", this.home.knownHosts], AbortSignal.timeout(8000))
      .catch(() => null);
    return out?.exitCode === 0 && out.stdout.trim().length > 0;
  }

  private async ssh(computer: RemoteComputer, args: string[], signal: AbortSignal): Promise<string> {
    const out = await this.run("ssh", [...sshOptions, computer.alias, "--", remoteCommand(args)], signal);
    if (out.status !== "completed" || out.exitCode !== 0) throw new Error(explainSsh(computer.alias, out));
    return out.stdout;
  }

  /** What is in a folder on that computer. */
  async files(alias: string, path: string, signal: AbortSignal, trunk: string | null = null): Promise<{ computer: string; path: string; entries: string[] }> {
    const computer = this.getFor(alias, trunk);
    const target = remotePath(computer.root, path);
    const listed = await this.ssh(computer, ["ls", "-1A", "--", target], signal);
    return { computer: alias, path: target,
      entries: listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 500) };
  }

  /** One file's text, up to a size that fits in an answer. */
  async read(alias: string, path: string, signal: AbortSignal, trunk: string | null = null): Promise<{ computer: string; path: string; text: string }> {
    const computer = this.getFor(alias, trunk);
    const target = remotePath(computer.root, path);
    const text = await this.ssh(computer, ["cat", "--", target], signal);
    return { computer: alias, path: target, text: text.slice(0, 32768) };
  }

  /** Writes only when the local OpenSSH suite defaults scp to SFTP, never its legacy remote shell. */
  async write(alias: string, path: string, localFile: string, signal: AbortSignal): Promise<{ computer: string; path: string }> {
    const computer = this.get(alias);
    const target = remotePath(computer.root, path);
    await this.requireModernScp(signal);
    const destination = `${computer.alias}:${target}`;
    const out = await this.run("scp", [...sshOptions, "--", localFile, destination], signal);
    if (out.status !== "completed" || out.exitCode !== 0) throw new Error(explainSsh(alias, out));
    return { computer: alias, path: target };
  }

  private async requireModernScp(signal: AbortSignal): Promise<void> {
    const out = await this.run("ssh", ["-V"], signal).catch(() => null);
    const text = `${out?.stdout ?? ""}\n${out?.stderr ?? ""}`;
    const version = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/i.exec(text);
    if (out?.status === "completed" && out.exitCode === 0 && Number(version?.[1] ?? 0) >= 9) return;
    throw new Error("File copies require OpenSSH 9 or newer so scp uses SFTP instead of a remote shell.");
  }

  /**
   * Runs one of the programs the owner allowed on that computer. Anything else is refused by name,
   * so adding a computer never hands over a command line.
   */
  async execute(alias: string, executable: string, args: string[], signal: AbortSignal, trunk: string | null = null):
    Promise<{ computer: string; program: string; output: string }> {
    const command = remoteExecutionSchema.parse({ program: executable, args });
    const computer = this.getFor(alias, trunk);
    if (!computer.executables.includes(command.program))
      throw new Error(`"${command.program}" is not one of the programs ${alias} is allowed to run. The owner adds those in Settings, one at a time.`);
    const output = await this.ssh(computer, [command.program, ...command.args], signal);
    return { computer: alias, program: command.program, output: output.slice(0, 32768) };
  }
}

/** Ssh's own wording turned into something the owner can act on. */
export function explainSsh(alias: string, out: { status: string; stderr: string }): string {
  const text = out.stderr;
  if (out.status === "timed_out") return `${alias} did not answer in time.`;
  if (/host key verification failed/i.test(text))
    return `${alias} showed a different key from the one you accepted before. Branch stopped rather than carry on. Check with whoever looks after that computer.`;
  if (/permission denied/i.test(text))
    return `${alias} would not let Branch in. Check that your key is set up for it; Branch never uses a password.`;
  if (/could not resolve|connection (refused|timed out)|no route to host/i.test(text))
    return `Branch could not reach ${alias}.`;
  const line = text.split("\n").map((value) => value.trim()).find(Boolean);
  return line ? `${alias}: ${line.slice(0, 200)}` : `${alias} could not do that.`;
}

const AliasInput = { computer: aliasSchema };
export const RemoteListSchema = z.object({}).strict();
export const RemoteFilesSchema = z.object({
  ...AliasInput, path: z.string().max(300).regex(remoteTextPattern, remoteTextMessage).default("."),
}).strict();
export const RemoteReadSchema = z.object({
  ...AliasInput, path: z.string().min(1).max(300).regex(remoteTextPattern, remoteTextMessage),
}).strict();
export const RemoteRunSchema = z.object({
  ...AliasInput,
  program: remoteProgramSchema,
  args: remoteArgumentsSchema.default([]),
}).strict();

export const trunkRemoteRefusal = (alias: string): string =>
  `This Trunk may not use "${alias}". The owner lends another computer to a Trunk when adding it, under Settings, Computers.`;
/** The Trunk whose work this is: its own turn, or work it set going (a helper, a flow). */
const trunkAtWork = (context: ToolContext): string | null => context.trunk ?? currentAccountCall()?.trunk?.id ?? null;

export function registerRemoteWorkspaces(registry: ToolRegistry, remotes: RemoteWorkspaces): void {
  registry.register({
    name: "remote.list", permission: "files.read", group: "remote",
    description: "List the other computers the owner has set up to work on, and the folder each one keeps its work in.",
    parameters: RemoteListSchema,
    target: () => "the other computers set up",
    execute: async (_args, context: ToolContext) =>
      ({ computers: remotes.listFor(trunkAtWork(context)).map(({ alias, root, label, executables }) => ({ alias, root, label, executables })) }),
  });
  registry.register({
    name: "remote.files", reach: "outbound", permission: "files.read", group: "remote",
    description: "List what is in a folder on one of the owner's other computers. The folder is given relative to that computer's own working folder.",
    parameters: RemoteFilesSchema,
    target: (args) => `${args.computer}: ${args.path}`,
    execute: (args, context: ToolContext) => remotes.files(args.computer, args.path, context.signal, trunkAtWork(context)),
  });
  registry.register({
    name: "remote.read", reach: "outbound", permission: "files.read", group: "remote",
    description: "Read a text file on one of the owner's other computers.",
    parameters: RemoteReadSchema,
    target: (args) => `${args.computer}: ${args.path}`,
    execute: (args, context: ToolContext) => remotes.read(args.computer, args.path, context.signal, trunkAtWork(context)),
  });
  registry.register({
    name: "remote.run", permission: "remote.execute", group: "remote",
    description: "Run one of the programs the owner has allowed on one of their other computers. Anything not on that computer's own list is refused.",
    parameters: RemoteRunSchema,
    target: (args) => `${args.computer}: ${[args.program, ...args.args].join(" ")}`.slice(0, 300),
    execute: (args, context: ToolContext) => remotes.execute(args.computer, args.program, args.args, context.signal, trunkAtWork(context)),
  });
}
