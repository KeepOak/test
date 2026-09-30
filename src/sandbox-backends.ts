import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { ShellProcess } from "./integrations/shell-process.js";
import { runAsNode } from "./child-env.js";
import { netlessEnvironment } from "./integrations/shell-config.js";
import { defaultJobObjects, jobWithin, type JobObjects } from "./integrations/job-object.js";
import type { HeldBySystem } from "./integrations/posix-limits.js";
import { systemName, type WallContext, type WallNetwork } from "./sandbox.js";
import { ApprovalRequiredError } from "./approvals.js";
import { sandboxExecPath, seatbeltArgs, secretHomePlaces } from "./sandbox-seatbelt.js";
import { bwrapArgs, bwrapAvailability, doorBridgeSource, insideDoorPorts, seccompFilter, withSeccomp } from "./sandbox-bwrap.js";
import { newPlaceholder, proxyEnvironment, SandboxProxy, type EdgeKey, type ProxyOptions } from "./sandbox-proxy.js";
import { explainDenial, siteQuestion, widenable, widenQuestion } from "./sandbox-denial.js";

/**
 * Where a program Branch Agent starts actually runs. `src/sandbox.ts` says how tightly it is held
 * — memory and processor ceilings, and whether it can reach the internet. This says in what: the
 * computer itself, a container, a Linux distribution, or Windows' own throwaway desktop.
 *
 * Nothing is installed to make any of this work. Each one is looked for on this computer and used
 * only if it is already there; a backend that is not there refuses in a sentence naming what the
 * owner would have to install. The plain box — a Windows job object — is always available, and is
 * what everything did before this existed.
 */
export const sandboxBackends = ["job-object", "docker", "wsl", "windows-sandbox"] as const;
export type SandboxBackendName = (typeof sandboxBackends)[number];

/** Plain words for the settings screen, the approval card and the refusal. */
export const sandboxBackendSentences: Record<SandboxBackendName, string> = {
  "job-object": `on this computer, held to its memory and processor limits by ${systemName()}`,
  docker: "inside a container, which cannot see anything on this computer except the folder it is given",
  wsl: "inside the Linux you already have on this computer, with a copy of the folder it is given",
  "windows-sandbox": "in Windows' own throwaway desktop, which is thrown away when it closes",
};
/** What each one has to be for, so nobody picks one expecting protection it does not give. */
export const sandboxBackendProtects: Record<SandboxBackendName, string> = {
  "job-object": "Stops a runaway script using all the memory or the processor. It does not stop it reading your files.",
  docker: "Keeps a script away from your files and your programs. Your own computer is not visible inside.",
  wsl: "Keeps a script on the Linux side, working on a copy. Changes come back only for the files you ask for.",
  "windows-sandbox": "Gives a script a fresh Windows that is deleted afterwards. It opens a window on your screen.",
};

/** How a backend is looked for: run the program and see whether it answers. Replaced in tests. */
export interface SandboxProbeResult { code: number | null; stdout: string; stderr: string; missing: boolean }
export type SandboxProbe = (executable: string, args: string[]) => Promise<SandboxProbeResult>;

export const SandboxBackendSettingsSchema = z.object({
  /** The container image a script runs in. Nothing is ever pulled: it must already be on this computer. */
  image: z.string().trim().max(200).default("node:22-alpine"),
  /** Which Linux this computer already has, by name. Empty means the default one. */
  distro: z.string().trim().max(100).default(""),
  /** Windows' throwaway desktop opens a window, so it is off until the owner says otherwise. */
  windowsSandbox: z.boolean().default(false),
}).strict();
export type SandboxBackendSettings = z.infer<typeof SandboxBackendSettingsSchema>;

/** What the owner has chosen about where scripts run, or the plain defaults. */
export function sandboxBackendSettings(store: SettingsStore, owner: string): SandboxBackendSettings {
  const saved = SandboxBackendSettingsSchema.safeParse(store.get("settings", owner, "sandbox-backends")?.data ?? {});
  return saved.success ? saved.data : SandboxBackendSettingsSchema.parse({});
}
export function saveSandboxBackendSettings(store: SettingsStore, owner: string, input: unknown): SandboxBackendSettings {
  const value = SandboxBackendSettingsSchema.parse(input ?? {});
  store.save("settings", owner, "sandbox-backends", { ...value });
  return value;
}
/** Only the two settings calls are needed here, so the whole store is not dragged in. */
export interface SettingsStore {
  get(kind: string, owner: string, key: string): { data: unknown } | undefined;
  save(kind: string, owner: string, key: string, data: Record<string, unknown>): unknown;
}

export interface SandboxSlice {
  /** The folder on this computer a sandboxed command may see. Already checked against the workspace. */
  hostPath: string;
}
export interface SandboxCommand { executable: string; args: string[] }
export interface SandboxLimits {
  timeoutMs: number; maxMemoryMb: number; maxCpuSeconds: number; maxOutputBytes: number;
  /** Whether the program may reach the internet at all. */
  network: boolean;
  /** Whether the system itself holds the memory and processor ceilings (see src/sandbox.ts). */
  job: boolean;
  /** macOS and Linux: the wall the program goes behind, when the owner's switch says so. */
  wall?: WallContext | undefined;
}
export interface SandboxRunResult {
  status: string; exitCode: number | null; stdout: string; stderr: string;
  truncated: boolean; durationMs: number; backend: SandboxBackendName;
  /** Whether Windows itself held the memory and processor ceilings, or Branch sampled them. */
  isolation: "job-object" | "sampling";
  /** macOS and Linux: what the system itself held, when the program ran in a limited process group. */
  heldBySystem?: HeldBySystem;
  /** The exact program and arguments that were started, for the record and for the tests. */
  argv: string[];
}
export interface SandboxCollected { path: string; bytes: number }
/** Exactly what gets spawned, once the backend has wrapped the command it was given. */
export interface SandboxStart { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

/** One prepared place to run in. Let go of it and whatever it made is cleaned up. */
export interface SandboxHandle {
  readonly backend: SandboxBackendName;
  /** Where the folder appears to a command running inside. */
  readonly mount: string;
  /**
   * The program and arguments that actually get started for this command. `run` uses it, and a
   * tool that keeps a program running instead of waiting for it (`process.start`) uses it too, so
   * both go through the same one place and cannot drift apart.
   */
  argvFor(command: SandboxCommand, limits: SandboxLimits): Promise<SandboxStart>;
  run(command: SandboxCommand, limits: SandboxLimits, signal: AbortSignal): Promise<SandboxRunResult>;
  /** Named files brought back out, relative to the folder. Sizes only; the files are put back in place. */
  collect(paths: string[]): Promise<SandboxCollected[]>;
  dispose(): Promise<void>;
}
export interface SandboxAvailability {
  ok: boolean;
  /** When it is not available, the one sentence the owner is shown, naming what to install. */
  reason: string;
}
export interface SandboxBackend {
  readonly name: SandboxBackendName;
  available(): Promise<SandboxAvailability>;
  prepare(slice: SandboxSlice): Promise<SandboxHandle>;
}

/** How a prepared command is actually started. Replaced in tests so no container ever runs. */
export type SandboxSpawn = (
  options: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv },
  limits: SandboxLimits, signal: AbortSignal,
) => Promise<{
  status: string; exitCode: number | null; stdout: string; stderr: string;
  truncated: boolean; durationMs: number; isolation?: "job-object" | "sampling"; heldBySystem?: HeldBySystem;
}>;

/** The real one: the same child-process machinery every other host command goes through. */
export function defaultSandboxSpawn(jobs: JobObjects = defaultJobObjects()): SandboxSpawn {
  return async (options, limits, signal) => {
    const job = limits.job
      ? await jobWithin(jobs, { maxMemoryMb: limits.maxMemoryMb, maxCpuSeconds: limits.maxCpuSeconds }, 1500)
      : null;
    const result = await new ShellProcess({
      executable: options.executable, args: options.args, cwd: options.cwd, env: options.env,
      signal, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes,
      maxMemoryMb: limits.maxMemoryMb, maxCpuSeconds: limits.maxCpuSeconds, ...(job ? { job } : {}),
    }).run();
    return { status: result.status, exitCode: result.exitCode, stdout: result.stdout,
      stderr: result.stderr, truncated: result.truncated, durationMs: result.durationMs,
      isolation: result.isolation, ...(result.heldBySystem ? { heldBySystem: result.heldBySystem } : {}) };
  };
}

/** The real one: run the program with the arguments that make it say its version. */
export function defaultSandboxProbe(spawn: SandboxSpawn = defaultSandboxSpawn()): SandboxProbe {
  return async (executable, args) => {
    const limits: SandboxLimits = { timeoutMs: 5000, maxMemoryMb: 256, maxCpuSeconds: 10, maxOutputBytes: 4096, network: false, job: false };
    try {
      const out = await spawn({ executable, args, cwd: tmpdir(), env: { SYSTEMROOT: process.env.SYSTEMROOT ?? "", PATH: process.env.PATH ?? "", ...runAsNode(executable) } },
        limits, AbortSignal.timeout(6000));
      return { code: out.exitCode, stdout: out.stdout, stderr: out.stderr, missing: out.status === "failed" && out.exitCode === null };
    } catch {
      return { code: null, stdout: "", stderr: "", missing: true };
    }
  };
}

const baseEnv = (network: boolean): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: process.env.TEMP ?? "",
  ...(network ? {} : netlessEnvironment()),
});

/** Sizes of the named files after a run, so the caller can see what the command left behind. */
async function sizesOf(root: string, paths: string[]): Promise<SandboxCollected[]> {
  const out: SandboxCollected[] = [];
  for (const path of paths.slice(0, 64)) {
    if (path.includes("..") || path.startsWith("/") || path.includes(":")) continue;
    const info = await stat(resolve(root, path)).catch(() => null);
    if (info?.isFile()) out.push({ path, bytes: info.size });
  }
  return out;
}

/** Starts what a backend prepared and shapes the answer, so all four report the same way. */
async function started(
  start: Promise<SandboxStart>, spawn: SandboxSpawn, limits: SandboxLimits,
  signal: AbortSignal, backend: SandboxBackendName,
): Promise<SandboxRunResult> {
  const ready = await start;
  const out = await spawn(ready, limits, signal);
  return { ...out, isolation: out.isolation ?? "sampling", backend, argv: [ready.executable, ...ready.args] };
}

// ------------------------------------------------------------------ the plain box

/** What everything did before this existed: the program runs here, held by a Windows job object. */
export class JobObjectBackend implements SandboxBackend {
  readonly name = "job-object" as const;
  constructor(private readonly spawn: SandboxSpawn = defaultSandboxSpawn(), private readonly wallDeps: WallDeps = {}) {}
  async available(): Promise<SandboxAvailability> { return { ok: true, reason: "" }; }
  async prepare(slice: SandboxSlice): Promise<SandboxHandle> {
    const spawn = this.spawn, mount = slice.hostPath, wallDeps = this.wallDeps;
    const plainFor = async (command: SandboxCommand, limits: SandboxLimits): Promise<SandboxStart> =>
      ({ executable: command.executable, args: command.args, cwd: mount, env: { ...baseEnv(limits.network), ...runAsNode(command.executable) } });
    // wave mac3 (os-sandbox): a program left running goes behind the wall too, with no door open.
    const argvFor = async (command: SandboxCommand, limits: SandboxLimits): Promise<SandboxStart> =>
      limits.wall ? keptWall(await openWall(limits.wall, await plainFor(command, limits), { workspace: mount, proxy: false }, wallDeps))
        : plainFor(command, limits);
    return {
      backend: this.name, mount, argvFor,
      run: (command, limits, signal) => limits.wall
        ? walledRun(plainFor(command, limits), { limits, spawn, signal, workspace: mount, deps: wallDeps })
        : started(argvFor(command, limits), spawn, limits, signal, "job-object"),
      collect: (paths) => sizesOf(mount, paths),
      dispose: async () => undefined,
    };
  }
}

// ------------------------------------------------------------------ container

/** The arguments a container run is made of, written once so the test and the code cannot drift. */
export function dockerArgv(
  options: { image: string; hostPath: string; command: SandboxCommand; limits: SandboxLimits },
): string[] {
  const { image, hostPath, command, limits } = options;
  return [
    "run", "--rm",
    "--network", limits.network ? "bridge" : "none",
    "--memory", `${Math.max(16, Math.round(limits.maxMemoryMb))}m`,
    // One processor's worth. How long it may run for is the time limit's job, not this one's.
    "--cpus", "1",
    "--read-only",
    "--workdir", "/work",
    "-v", `${hostPath}:/work:rw`,
    image, command.executable, ...command.args,
  ];
}

/**
 * A container. The folder the command may see is mounted read-write under `/work` and nothing else
 * of this computer is visible inside; the rest of the container's own filesystem is read-only.
 * Docker Desktop or Podman has to be on this computer already — neither is ever installed.
 */
export class ContainerBackend implements SandboxBackend {
  readonly name = "docker" as const;
  constructor(
    private readonly settings: SandboxBackendSettings,
    private readonly probe: SandboxProbe,
    private readonly spawn: SandboxSpawn = defaultSandboxSpawn(),
  ) {}
  private engine: string | null = null;
  async available(): Promise<SandboxAvailability> {
    for (const engine of ["docker", "podman"]) {
      const answer = await this.probe(engine, ["version", "--format", "{{.Client.Version}}"]);
      if (!answer.missing && answer.code === 0) { this.engine = engine; return { ok: true, reason: "" }; }
    }
    return { ok: false, reason: "Running things inside a container needs Docker Desktop or Podman on this computer. Neither is here, and Branch does not install either. Install one, or choose a different way to hold scripts in Settings." };
  }
  async prepare(slice: SandboxSlice): Promise<SandboxHandle> {
    const ready = await this.available();
    if (!ready.ok) throw new Error(ready.reason);
    const engine = this.engine ?? "docker", image = this.settings.image, spawn = this.spawn, host = slice.hostPath;
    const argvFor = async (command: SandboxCommand, limits: SandboxLimits): Promise<SandboxStart> =>
      ({ executable: engine, args: dockerArgv({ image, hostPath: host, command, limits }), cwd: host, env: baseEnv(limits.network) });
    return {
      backend: this.name, mount: "/work", argvFor,
      run: (command, limits, signal) => started(argvFor(command, limits), spawn, limits, signal, "docker"),
      collect: (paths) => sizesOf(host, paths),
      dispose: async () => undefined,
    };
  }
}

// ------------------------------------------------------------------ Linux on this computer

/** `C:\work\thing` as Linux sees it under WSL: `/mnt/c/work/thing`. */
export function wslPath(windowsPath: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(windowsPath);
  if (!drive) return windowsPath.split("\\").join("/");
  return `/mnt/${drive[1]!.toLowerCase()}/${windowsPath.slice(3).split("\\").join("/")}`;
}

/**
 * The Linux this computer already has. The folder is copied in before the command runs and the
 * files the caller names are copied back after, so nothing the command does reaches the original
 * until it is asked for.
 */
export class WslBackend implements SandboxBackend {
  readonly name = "wsl" as const;
  constructor(
    private readonly settings: SandboxBackendSettings,
    private readonly probe: SandboxProbe,
    private readonly spawn: SandboxSpawn = defaultSandboxSpawn(),
  ) {}
  async available(): Promise<SandboxAvailability> {
    const answer = await this.probe("wsl.exe", ["--status"]);
    if (!answer.missing && answer.code === 0) return { ok: true, reason: "" };
    return { ok: false, reason: "Running things on the Linux side needs Windows Subsystem for Linux, which is not set up on this computer. Turn it on in Windows, or choose a different way to hold scripts in Settings." };
  }
  async prepare(slice: SandboxSlice): Promise<SandboxHandle> {
    const ready = await this.available();
    if (!ready.ok) throw new Error(ready.reason);
    const staging = await mkdtemp(join(tmpdir(), "branch-wsl-"));
    const work = join(staging, "work");
    await cp(slice.hostPath, work, { recursive: true, errorOnExist: false }).catch(() => mkdir(work, { recursive: true }));
    const distro = this.settings.distro, spawn = this.spawn, host = slice.hostPath, mount = wslPath(work);
    const argvFor = async (command: SandboxCommand, limits: SandboxLimits): Promise<SandboxStart> => ({
      executable: "wsl.exe", cwd: staging, env: baseEnv(limits.network),
      args: [...(distro ? ["-d", distro] : []), "--cd", mount, "--", command.executable, ...command.args],
    });
    return {
      backend: this.name, mount, argvFor,
      run: (command, limits, signal) => started(argvFor(command, limits), spawn, limits, signal, "wsl"),
      async collect(paths) {
        const brought: SandboxCollected[] = [];
        for (const entry of await sizesOf(work, paths)) {
          await cp(resolve(work, entry.path), resolve(host, entry.path), { recursive: true }).catch(() => undefined);
          brought.push(entry);
        }
        return brought;
      },
      dispose: () => rm(staging, { recursive: true, force: true }),
    };
  }
}

// ------------------------------------------------------------------ Windows' throwaway desktop

/** The `.wsb` file Windows Sandbox is started from, written once so the test reads the real thing. */
export function windowsSandboxFile(options: { hostPath: string; command: SandboxCommand }): string {
  const line = [options.command.executable, ...options.command.args].join(" ");
  return [
    "<Configuration>",
    "  <Networking>Disable</Networking>",
    "  <MappedFolders>",
    "    <MappedFolder>",
    `      <HostFolder>${escapeXml(options.hostPath)}</HostFolder>`,
    "      <SandboxFolder>C:\\work</SandboxFolder>",
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    `    <Command>cmd.exe /c cd C:\\work &amp;&amp; ${escapeXml(line)} &gt; C:\\work\\branch-output.txt 2&gt;&amp;1</Command>`,
    "  </LogonCommand>",
    "</Configuration>",
    "",
  ].join("\n");
}
const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Windows' own throwaway desktop. It opens a window on the owner's screen and everything inside it
 * is deleted when that window closes, so it is never chosen for them: the owner has to ask for it.
 */
export class WindowsSandboxBackend implements SandboxBackend {
  readonly name = "windows-sandbox" as const;
  constructor(
    private readonly settings: SandboxBackendSettings,
    private readonly probe: SandboxProbe,
    private readonly spawn: SandboxSpawn = defaultSandboxSpawn(),
  ) {}
  async available(): Promise<SandboxAvailability> {
    if (!this.settings.windowsSandbox)
      return { ok: false, reason: "Windows' throwaway desktop opens a window on your screen, so Branch will not use it until you switch it on in Settings under Approvals." };
    const answer = await this.probe("WindowsSandbox.exe", ["/?"]);
    if (answer.missing)
      return { ok: false, reason: "Windows Sandbox is not switched on for this computer. Turn on the Windows feature called Windows Sandbox, or choose a different way to hold scripts in Settings." };
    return { ok: true, reason: "" };
  }
  async prepare(slice: SandboxSlice): Promise<SandboxHandle> {
    const ready = await this.available();
    if (!ready.ok) throw new Error(ready.reason);
    const staging = await mkdtemp(join(tmpdir(), "branch-wsb-"));
    const host = slice.hostPath, spawn = this.spawn;
    const argvFor = async (command: SandboxCommand): Promise<SandboxStart> => {
      const file = join(staging, `${randomUUID()}.wsb`);
      await writeFile(file, windowsSandboxFile({ hostPath: host, command }), "utf8");
      return { executable: "WindowsSandbox.exe", args: [file], cwd: staging, env: baseEnv(false) };
    };
    return {
      backend: this.name, mount: "C:\\work", argvFor,
      run: (command, limits, signal) => started(argvFor(command), spawn, limits, signal, "windows-sandbox"),
      collect: (paths) => sizesOf(host, paths),
      dispose: () => rm(staging, { recursive: true, force: true }),
    };
  }
}

// ------------------------------------------------------------------ choosing one

export interface SandboxBackendDeps {
  settings: SandboxBackendSettings;
  probe: SandboxProbe;
  spawn?: SandboxSpawn;
  /** How the wall looks at this computer; the probe above is used for bubblewrap unless this says otherwise. */
  wall?: WallDeps;
}
/** Every backend, built once from the owner's settings. */
export function sandboxBackendSet(deps: SandboxBackendDeps): Record<SandboxBackendName, SandboxBackend> {
  const spawn = deps.spawn ?? defaultSandboxSpawn();
  return {
    "job-object": new JobObjectBackend(spawn, { probe: deps.probe, ...deps.wall }),
    docker: new ContainerBackend(deps.settings, deps.probe, spawn),
    wsl: new WslBackend(deps.settings, deps.probe, spawn),
    "windows-sandbox": new WindowsSandboxBackend(deps.settings, deps.probe, spawn),
  };
}

/**
 * The backend a call is to use: the one the owner's rule named, or the plain box. A named backend
 * that is not on this computer is a plain refusal naming what to install — it never quietly falls
 * back to something weaker, because that would be the opposite of what the rule asked for.
 */
export async function chooseSandboxBackend(
  set: Record<SandboxBackendName, SandboxBackend>, wanted: SandboxBackendName | null | undefined,
): Promise<SandboxBackend> {
  const backend = set[wanted ?? "job-object"];
  const ready = await backend.available();
  if (!ready.ok) throw new Error(ready.reason);
  return backend;
}

/** Which backends this computer can actually offer, for the settings screen. */
export async function sandboxBackendReport(
  set: Record<SandboxBackendName, SandboxBackend>,
): Promise<{ name: SandboxBackendName; available: boolean; reason: string; runs: string; protects: string }[]> {
  const out = [];
  for (const name of sandboxBackends) {
    const ready = await set[name].available();
    out.push({ name, available: ready.ok, reason: ready.reason,
      runs: sandboxBackendSentences[name], protects: sandboxBackendProtects[name] });
  }
  return out;
}

/** The folders of a workspace one rule lets a sandboxed command see, checked and made absolute. */
export async function sliceFor(workspace: string, folders: readonly string[]): Promise<SandboxSlice> {
  if (!folders.length) return { hostPath: workspace };
  const first = folders[0]!;
  if (first.includes("..") || first.includes(":") || first.startsWith("/") || first.startsWith("\\"))
    throw new Error("A folder a script may see is given relative to your workspace, such as \"reports\".");
  const hostPath = resolve(workspace, first);
  if (!hostPath.startsWith(workspace + sep) && hostPath !== workspace)
    throw new Error("That folder is outside your workspace.");
  await mkdir(hostPath, { recursive: true });
  await readdir(hostPath);
  return { hostPath };
}

// ------------------------------------------------------------------ the wall (wave mac3, os-sandbox)

/** What the wall needs from this computer. Every piece is replaced in tests, so no wall is really built. */
export interface WallDeps {
  platform?: NodeJS.Platform;
  /** Whether a file is there; used for `/usr/bin/sandbox-exec`. */
  exists?: (path: string) => Promise<boolean>;
  /** Where the system's `bwrap` is, or null. */
  locateBwrap?: () => Promise<string | null>;
  probe?: SandboxProbe;
  realpath?: (path: string) => Promise<string>;
  kindOf?: (path: string) => "dir" | "file" | null;
  /** Branch's own data folder, never readable from behind the wall. */
  dataDir?: string | undefined;
  /** Where a request really goes; tests only. */
  upstream?: ProxyOptions["upstream"];
  /** How a site name becomes addresses; tests only (bucket-15 integration: passed through to the door). */
  resolve?: ProxyOptions["resolve"];
}
export interface WallRun { exitCode: number | null; stdout: string; stderr: string }
export interface OpenedWall {
  start: SandboxStart;
  /** After the program ends: stops on a question for the owner, or returns a sentence for the task. */
  finish(result: WallRun): Promise<string | null>;
  close(): Promise<void>;
}
interface WallPlan {
  wall: WallContext; network: WallNetwork; workspace: string; temp: string; hidden: string[]; readOnly: string[];
  extraWrites: string[]; keys: EdgeKey[]; deps: WallDeps;
  /** Q12: the program's only temporary folder is `temp` (a private one), not the system's shared ones. */
  onlyTemp: boolean;
  /** Q12: a command held to one folder by a self-development contract (no `.git` may be made in it). */
  held: boolean;
  /** Linux only: a private folder for the filter and the door, made when the wall is built. */
  staging?: string;
  /** A program left running: no door is ever opened for it. */
  doorless: boolean;
  /** Linux only: folders shown empty and read-only except for the workspace (WSL's `/mnt`). */
  covered: string[];
}

const fileExists = async (path: string): Promise<boolean> => !!(await stat(path).catch(() => null));
const kindOnDisk = (path: string): "dir" | "file" | null => {
  try { return statSync(path).isDirectory() ? "dir" : "file"; } catch { return null; }
};
async function whichBwrap(): Promise<string | null> {
  for (const dir of ["/usr/bin", "/usr/local/bin", "/bin"]) if (await fileExists(join(dir, "bwrap"))) return join(dir, "bwrap");
  return null;
}
/**
 * The name the system itself uses for a place: links followed and `/var` spelled `/private/var`. A
 * file that is not there yet is named through its folder.
 */
export function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { /* not there yet */ }
  try { return join(realpathSync(dirname(path)), basename(path)); } catch { return path; }
}
const passThrough = (start: SandboxStart): OpenedWall => ({ start, finish: async () => null, close: async () => undefined });

/**
 * A stand-in for every saved key the call asked for; the program never holds a real one. A key the
 * owner tied to no site stays a stand-in everywhere: the door refuses to send it anywhere.
 */
function edgeKeys(wall: WallContext, secrets: Readonly<Record<string, string>>): EdgeKey[] {
  return Object.entries(secrets).map(([name, value]) => {
    const site = Object.hasOwn(wall.keySites, name) ? wall.keySites[name] ?? "" : "";
    return { name, value, site, placeholder: newPlaceholder() };
  });
}

async function planWall(
  wall: WallContext, options: { workspace: string; secrets?: Readonly<Record<string, string>>; proxy?: boolean; temp?: string; held?: boolean; covered?: readonly string[] }, deps: WallDeps,
): Promise<WallPlan> {
  const real = deps.realpath ?? realpath;
  const workspace = await real(options.workspace), temp = await real(options.temp ?? tmpdir());
  const home = homedir();
  const named = [...secretHomePlaces.map((place) => join(home, place)), ...wall.unreadable, ...(deps.dataDir ? [deps.dataDir] : [])];
  // Each hidden place both as written and as the system names it, so a `/var` or a link cannot slip past.
  const hidden = [...new Set(named.flatMap((path) => [path, canonicalPath(path)]))];
  const readOnly = [...new Set((wall.readOnly ?? []).flatMap((path) => [path, canonicalPath(path)]))];
  // A yes given after the wall stopped a write lets that one file through, once — the file itself,
  // never what a link in its place points at.
  const asked = wall.granted("sandbox.write");
  for (const path of asked) wall.spend("sandbox.write", path);
  // The question names the file as the system does, so a yes naming anything else (a link) is not used.
  const extraWrites = asked.filter((path) => canonicalPath(path) === path && widenable(path, { workspace, hidden: [...hidden, ...readOnly] }));
  const keys = edgeKeys(wall, options.secrets ?? {});
  // A program left running cannot keep a door open after the call, so it gets no network instead.
  const network = options.proxy === false && (wall.network === "limited" || wall.network === "per-site") ? "none" : wall.network;
  return { wall, network, workspace, temp, hidden, readOnly, extraWrites, keys, deps, doorless: options.proxy === false, onlyTemp: !!options.temp, held: options.held === true, covered: [...(options.covered ?? [])] };
}

function doorFor(plan: WallPlan, paths?: { http: string; socks: string }): SandboxProxy | null {
  const { network, keys, wall } = plan;
  if (plan.doorless || network === "none" || (network === "open" && !keys.length)) return null;
  return new SandboxProxy({ network, keys, check: wall.siteCheck, fakeIpProxy: wall.fakeIpProxy, upstream: plan.deps.upstream,
    ...(plan.deps.resolve ? { resolve: plan.deps.resolve } : {}), ...(paths ? { paths } : {}),
    decide: (host) => wall.answer("network.site", host) ?? (network === "open" ? "allow" : "ask") });
}

const keyEnv = (keys: readonly EdgeKey[]): NodeJS.ProcessEnv => Object.fromEntries(keys.map((key) => [key.name, key.placeholder]));

async function macWall(plan: WallPlan, start: SandboxStart): Promise<{ start: SandboxStart; door: SandboxProxy | null }> {
  if (!(await (plan.deps.exists ?? fileExists)(sandboxExecPath)))
    throw new Error("macOS's own sandbox program (/usr/bin/sandbox-exec) is missing, so Branch will not start this program. Switch the wall off in Settings to run it without one.");
  const door = doorFor(plan);
  const address = door ? await door.start() : null;
  const ports = address ? [address.httpPort!, address.socksPort!] : undefined;
  // The hidden places go in as the system names them (`/private/var`, not `/var`), or macOS would not match them.
  const args = seatbeltArgs({ workspace: plan.workspace, network: plan.network, proxyPorts: ports, extraWrites: plan.extraWrites,
    unreadable: plan.hidden, readOnly: plan.readOnly, temp: plan.onlyTemp ? [plan.temp] : [plan.temp, "/private/tmp", "/private/var/tmp"], held: plan.held }, start);
  const env = { ...start.env, ...keyEnv(plan.keys), ...(address && door ? proxyEnvironment({ httpPort: address.httpPort!, socksPort: address.socksPort! }, door.secret) : {}) };
  return { door, start: { executable: sandboxExecPath, args, cwd: start.cwd, env } };
}

async function linuxWall(plan: WallPlan, start: SandboxStart): Promise<{ start: SandboxStart; door: SandboxProxy | null }> {
  const found = await bwrapAvailability(plan.deps.probe ?? defaultSandboxProbe(), plan.deps.locateBwrap ?? whichBwrap);
  if (!found.ok) throw new Error(found.reason);
  const staging = plan.staging = await mkdtemp(join(plan.temp, "branch-wall-"));
  const paths = { http: join(staging, "http.sock"), socks: join(staging, "socks.sock") };
  const door = doorFor(plan, paths);
  if (door) await door.start();
  let command: SandboxCommand = start;
  if (door) {
    const bridge = join(staging, "door.cjs");
    await writeFile(bridge, doorBridgeSource, { mode: 0o400 });
    command = { executable: process.execPath, args: [bridge, paths.http, String(insideDoorPorts.http),
      paths.socks, String(insideDoorPorts.socks), "--", start.executable, ...start.args] };
  }
  const filter = join(staging, "filter.bpf");
  await writeFile(filter, seccompFilter({ network: plan.network, ownNetwork: plan.held && plan.network !== "open" }), { mode: 0o400 });
  const onDisk = plan.deps.kindOf ?? kindOnDisk;
  // A place that is really inside a covered folder (a link into WSL's `/mnt`) is already hidden; bwrap could not cover it again.
  const kindOf = (path: string) => (plan.covered.some((folder) => [path, canonicalPath(path)].some((each) => each === folder || each.startsWith(`${folder}/`))) ? null : onDisk(path));
  // A file that is not there yet can only be let through by its folder, the narrowest bwrap can bind.
  const extraWrites = plan.extraWrites.map((path) => (kindOf(path) ? path : dirname(path)))
    .filter((path) => widenable(path, { workspace: plan.workspace, hidden: [...plan.hidden, ...plan.readOnly] }));
  const args = bwrapArgs({ workspace: plan.workspace, network: plan.network, doorDir: door ? staging : undefined,
    extraWrites, unreadable: plan.hidden, readOnly: plan.readOnly, temp: plan.temp, uid: process.getuid?.(),
    seccompFd: 9, kindOf, covered: plan.covered, canonical: canonicalPath }, command);
  const wrapped = withSeccomp(found.path, filter, args);
  // The door bridge is this program running a script, so it has to run as Node (see runAsNode).
  const env = { ...start.env, ...keyEnv(plan.keys), ...(door ? { ...proxyEnvironment({ httpPort: insideDoorPorts.http, socksPort: insideDoorPorts.socks }, door.secret), ...runAsNode(process.execPath) } : {}) };
  return { door, start: { ...wrapped, cwd: start.cwd, env } };
}

/**
 * Puts one program behind the wall. On Windows it changes nothing: the job object and Windows'
 * throwaway desktop keep doing exactly what they did. Anywhere the wall cannot be built it refuses
 * in a sentence and nothing starts — it never quietly runs the program without one.
 */
export async function openWall(
  wall: WallContext, start: SandboxStart,
  options: { workspace: string; secrets?: Readonly<Record<string, string>>; proxy?: boolean;
    /** Q12: a private temporary folder, the only one the program may write to besides the workspace. */
    temp?: string;
    /** Q12: a command held to one folder by a self-development contract. */
    held?: boolean;
    /** Linux only: folders shown empty and read-only except for the workspace (WSL's `/mnt`, `/run/WSL`). */
    covered?: readonly string[] }, deps: WallDeps = {},
): Promise<OpenedWall> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return passThrough(start);
  if (platform !== "darwin" && platform !== "linux")
    throw new Error("The wall around programs works on macOS and Linux only. Switch it off in Settings to run programs here.");
  const plan = await planWall(wall, options, deps);
  const cleanup = async () => { if (plan.staging) await rm(plan.staging, { recursive: true, force: true }).catch(() => undefined); };
  let built: { start: SandboxStart; door: SandboxProxy | null };
  try { built = platform === "darwin" ? await macWall(plan, start) : await linuxWall(plan, start); }
  catch (error) { await cleanup(); throw error; }
  const { door } = built;
  const close = async () => { await door?.close(); await cleanup(); };
  return { start: built.start, close, finish: async (result) => { await close(); return wallVerdict(plan, door, result); } };
}

/** What the task hears after a program behind the wall ended: a question, a sentence, or nothing. */
function wallVerdict(plan: WallPlan, door: SandboxProxy | null, result: WallRun): string | null {
  const site = door?.asked[0];
  if (site) throw new ApprovalRequiredError("network.site", site, siteQuestion(), "session");
  const siteless = plan.keys.filter((key) => !key.site).map((key) => key.name);
  const keysNote = siteless.length && result.exitCode !== 0
    ? `Behind the wall, ${siteless.join(", ")} reached the program only as a stand-in, because no site is set for ${siteless.length === 1 ? "it" : "them"} in Settings, Computer.`
    : null;
  const denial = explainDenial(result, { network: plan.network, workspace: plan.workspace, hidden: [...plan.hidden, ...plan.readOnly] });
  if (!denial) return keysNote;
  const path = denial.path ? canonicalPath(denial.path) : undefined;
  if (path && !widenable(path, { workspace: plan.workspace, hidden: [...plan.hidden, ...plan.readOnly] }))
    return `The wall around programs stopped this command changing ${path}. That place is always protected, so Branch will not ask to open it.`;
  // Asked once: a file the owner already let through, or refused, is not asked about again.
  if (path && plan.wall.answer("sandbox.write", path) === undefined && !plan.extraWrites.includes(path))
    throw new ApprovalRequiredError("sandbox.write", path, widenQuestion(), "session");
  return keysNote ? `${denial.message}\n${keysNote}` : denial.message;
}

/**
 * A program left running keeps its wall. It never has a door, and on Linux the filter file is only
 * read as the program starts, so what the wall set up is let go a moment after it has started.
 */
function keptWall(opened: OpenedWall): SandboxStart {
  if (opened.start.executable === sandboxExecPath) void opened.close();
  else setTimeout(() => void opened.close(), 30_000).unref();
  return opened.start;
}

/** One command behind the wall, from start to the verdict. */
async function walledRun(
  plain: Promise<SandboxStart>,
  run: { limits: SandboxLimits; spawn: SandboxSpawn; signal: AbortSignal; workspace: string; deps: WallDeps },
): Promise<SandboxRunResult> {
  const opened = await openWall(run.limits.wall!, await plain, { workspace: run.workspace }, run.deps);
  try {
    const out = await run.spawn(opened.start, run.limits, run.signal);
    const note = await opened.finish(out);
    return { ...out, stderr: note ? `${out.stderr}${out.stderr.endsWith("\n") || !out.stderr ? "" : "\n"}${note}` : out.stderr,
      isolation: out.isolation ?? "sampling", backend: "job-object", argv: [opened.start.executable, ...opened.start.args] };
  } finally {
    await opened.close();
  }
}

/** Whether this computer can build the wall, for the settings card. Nothing is started to find out on macOS. */
export async function wallReport(deps: WallDeps = {}): Promise<{ platform: string; available: boolean; reason: string }> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32")
    return { platform, available: false, reason: "On Windows, programs are held by Windows' own job object and throwaway desktop instead; this switch changes nothing here." };
  if (platform === "darwin") {
    const here = await (deps.exists ?? fileExists)(sandboxExecPath);
    return { platform, available: here, reason: here ? "" : "macOS's own sandbox program (/usr/bin/sandbox-exec) is missing on this Mac." };
  }
  if (platform !== "linux") return { platform, available: false, reason: "The wall around programs works on macOS and Linux only." };
  const found = await bwrapAvailability(deps.probe ?? defaultSandboxProbe(), deps.locateBwrap ?? whichBwrap);
  return { platform, available: found.ok, reason: found.ok ? "" : found.reason };
}
