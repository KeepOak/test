import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WallDeps } from "../../sandbox-backends.js";
import { parseDeviceArgs } from "../args.js";
import { capabilities, mediaLimitBytes, offeredOn, textLimitBytes, type Capability } from "../capabilities.js";
import {
  cameraCommand, clipboardReadCommand, clipboardWriteCommand, linuxInputCommand, linuxScreenSizeCommand, listenCommand,
  linuxNoticeAboveCommand, locationCommand, needs, noticeCommand, notifyCommand, onWayland, openCommand, parseScreenSize, screenCommand,
  speakCommand, windowsInputCommand,
  type NodeInput, type NodeOs, type OsCommand,
} from "./commands.js";
import { holdKeyCodes } from "../../integrations/desktop-config.js";
import { xdotoolHoldChord } from "../../integrations/desktop-script-posix.js";
import { walledCommand } from "./wall.js";
import { secretHomePlaces } from "../../sandbox-seatbelt.js";
import { installedProgram, programRoot } from "../../never-break/protected.js";

/**
 * mac7/nodes: a Branch node doing one switched-on thing. Every program goes through `runner`, so
 * tests hand in a fake and nothing on the machine running the tests is touched.
 */
export interface RunOptions { cwd?: string; timeoutMs: number; maxBytes: number }
export interface RunOutput { code: number | null; stdout: Buffer; stderr: string }
export type Runner = (command: OsCommand, options: RunOptions) => Promise<RunOutput>;
export interface ActionResult { value: unknown; media?: { mime: string; name: string; data: Buffer } }

export interface ActionDeps {
  os: NodeOs;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  /** Whether a program can be found; looks along PATH by default. */
  find?: (program: string) => Promise<boolean>;
  /** The node's own folder (its key), which a walled command can never read. */
  identityDir: string;
  wall?: WallDeps;
  /** The node user's home folder; tests hand in a temporary one. */
  home?: string;
  /** computer-control: starts the long-lived notice window; tests hand in a stand-in that shows nothing. */
  spawnNotice?: NoticeSpawner;
}

/**
 * A long-lived program (the notice), and a way to end it. `exited` settles when it ends for any reason; `shown`
 * when it prints "shown" (the Windows notice does once its window is up).
 */
export interface NoticeProcess { exited: Promise<void>; shown: Promise<void>; kill(): void }
export type NoticeSpawner = (command: OsCommand) => NoticeProcess;
/**
 * The notice: `shown` settles true once it is on the screen and on top (false if it never is); `stopped` settles if
 * it ends by itself (Stop pressed, window closed, it failed).
 */
export interface Notice { shown: Promise<boolean>; stopped: Promise<string>; close(): void }

export const spawnNotice: NoticeSpawner = (command) => {
  const child = spawn(command.executable, command.args, { shell: false, windowsHide: true, env: childEnvironment(command), stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise<void>((done) => { child.once("exit", () => done()); child.once("error", () => done()); });
  let heard = "";
  const shown = new Promise<void>((done) => child.stdout?.on("data", (chunk: Buffer) => { heard = (heard + chunk.toString("utf8")).slice(-64); if (/shown/.test(heard)) done(); }));
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(command.input ?? "");
  return { exited, shown, kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } };
};

const mimeByExt: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".wav": "audio/wav", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".pdf": "application/pdf",
  ".csv": "text/csv", ".html": "text/html", ".mp4": "video/mp4" };
const mimeOf = (path: string): string => mimeByExt[extname(path).toLowerCase()] ?? "application/octet-stream";

/**
 * The environment a program starts with. Integration review: a walled `device.run` gets exactly the
 * clean one the wall built; before, the node's whole environment was spread underneath it.
 */
export function childEnvironment(command: OsCommand): NodeJS.ProcessEnv {
  return command.exactEnv ? { ...command.env } : { ...process.env, ...command.env };
}

/** Starts a program without a shell and collects at most `maxBytes` of what it prints. */
export const spawnRunner: Runner = (command, options) => new Promise((done, fail) => {
  const child = spawn(command.executable, command.args, { cwd: options.cwd, shell: false, windowsHide: true,
    env: childEnvironment(command), stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let size = 0, stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= options.maxBytes) chunks.push(chunk); else child.kill("SIGKILL"); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
  child.on("error", (error) => { clearTimeout(timer); fail(error); });
  child.on("close", (code) => { clearTimeout(timer); done({ code, stdout: Buffer.concat(chunks), stderr: stderr.slice(0, 4000) }); });
  child.stdin.end(command.input ?? "");
});

export async function onPath(program: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const candidates = isAbsolute(program) ? [program]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, program));
  for (const path of candidates) if (await access(path, constants.X_OK).then(() => true, () => false)) return true;
  return false;
}

export class NodeActions {
  private readonly runner: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly find: (program: string) => Promise<boolean>;
  constructor(private readonly deps: ActionDeps) {
    this.runner = deps.runner ?? spawnRunner;
    this.env = deps.env ?? process.env;
    this.find = deps.find ?? ((program) => onPath(program, this.env));
  }

  /** What this machine could offer: the platform's list, less whatever lacks the program it needs. */
  async available(): Promise<Capability[]> {
    const found: Capability[] = [];
    for (const capability of offeredOn(this.deps.os)) {
      const wanted = needs[this.deps.os][capability] ?? [];
      let ok = true;
      for (const need of wanted) {
        const any = await Promise.all(need.split("|").map((program) => this.find(program)));
        if (!any.includes(true)) ok = false;
      }
      if (ok) found.push(capability);
    }
    return capabilities.filter((capability) => found.includes(capability));
  }

  /**
   * Called only when the owner switches a capability on for this device. Taking one throwaway
   * picture or sound is what makes the operating system show its own permission question, here on
   * the device and at the moment the owner chose, rather than in the middle of a task later.
   */
  async prepare(capability: Capability): Promise<void> {
    if (!["camera", "screen", "listen"].includes(capability)) return;
    await this.capture(capability, { seconds: 1, facing: "back" }).catch(() => undefined);
  }

  async perform(capability: Capability, raw: unknown, folder: string | null): Promise<ActionResult> {
    const args = parseDeviceArgs(capability, raw);
    const { os } = this.deps;
    switch (capability) {
      case "camera": case "screen": case "listen": return this.capture(capability, args);
      case "location": return this.location();
      case "notify": return this.simple(notifyCommand(os, String(args.title), String(args.body ?? "")), "shown");
      case "clipboard-read": return this.clipboard();
      case "clipboard-write": return this.simple(clipboardWriteCommand(os, String(args.text), this.env), "copied");
      case "open-url": return this.simple(openCommand(os, String(args.url)), "opened");
      case "speak": return this.simple(speakCommand(os, String(args.text)), "spoken");
      case "files": return this.files(await this.usableFolder(folder), String(args.action), String(args.path ?? ""));
      case "run": return this.run(await this.usableFolder(folder), args as { executable: string; args: string[]; timeoutSeconds: number });
      case "input": return this.input(args as unknown as NodeInput);
      default: throw new Error("This device does not do that.");
    }
  }

  /** The chosen folder, refused when it would expose this node's key, its secrets or too much of the disk. */
  private async usableFolder(folder: string | null): Promise<string> {
    const chosen = needFolder(folder);
    await refuseUnsafeFolder(chosen, { home: this.deps.home ?? homedir(), identityDir: this.deps.identityDir });
    return chosen;
  }

  private async simple(command: OsCommand, done: string): Promise<ActionResult> {
    const out = await this.runner(command, { timeoutMs: 30_000, maxBytes: 4096 });
    if (out.code !== 0) throw new Error(`The device could not do it: ${out.stderr.trim().slice(0, 300) || `exit ${out.code}`}`);
    return { value: { done } };
  }

  /**
   * computer-control: one owner input from Branch's computer view. Branch lets only its owner send
   * these, only while the owner has taken over this device; here the switch (and a local `never`)
   * decides, and every one is logged on this computer.
   */
  private async input(input: NodeInput): Promise<ActionResult> {
    const { os } = this.deps;
    if (os === "win32") return this.simple(windowsInputCommand(input, input.action === "key" ? holdKeyCodes(input.chord ?? "") : []), input.action);
    if (os !== "linux") throw new Error("Using this computer's screen from Branch works on Windows and Linux (X11) for now.");
    if (onWayland(this.env)) throw new Error("This computer runs Wayland, which does not let another program move the pointer. It works on X11.");
    const chord = input.action === "key" ? xdotoolHoldChord(input.chord ?? "") : null;
    let size: { width: number; height: number } | null = null;
    if (input.action === "click" || input.action === "scroll") {
      const out = await this.runner(linuxScreenSizeCommand, { timeoutMs: 10_000, maxBytes: 256 });
      size = out.code === 0 ? parseScreenSize(out.stdout.toString("utf8")) : null;
    }
    return this.simple(linuxInputCommand(input, size, chord), input.action);
  }

  /**
   * computer-control: shows the notice that the owner is using this computer from Branch, on top of every window,
   * with a Stop. On Linux it is kept above with wmctrl; if that cannot be done the notice is closed and `stopped`
   * says why, so this computer never takes input without saying so.
   */
  startNotice(owner: string): Notice {
    const command = noticeCommand(this.deps.os, owner);
    if (!command) return { shown: Promise.resolve(false), stopped: Promise.resolve("This computer cannot show that it is being used."), close: () => undefined };
    const running = (this.deps.spawnNotice ?? spawnNotice)(command);
    let closing = false, fail: (why: string) => void = () => undefined;
    const stopped = new Promise<string>((done) => {
      fail = (why) => { if (closing) return; closing = true; running.kill(); done(why); };
      void running.exited.then(() => { if (!closing) { closing = true; done("Stop was pressed on this computer."); } });
    });
    const up = this.deps.os === "linux" ? this.keepAbove()
      : Promise.race([running.shown.then(() => true), running.exited.then(() => false), new Promise<boolean>((done) => setTimeout(() => done(false), 30_000).unref())]);
    const shown = up.then((ok) => {
      if (!ok) fail("This computer could not show on top of its screen that it is being used, so it was not used.");
      return ok && !closing;
    });
    return { shown, stopped, close: () => { closing = true; running.kill(); } };
  }

  /** Linux: asks wmctrl to keep the notice above, a few times while its window appears. */
  private async keepAbove(): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const out = await this.runner(linuxNoticeAboveCommand, { timeoutMs: 5000, maxBytes: 1024 }).catch(() => null);
      if (out?.code === 0) return true;
      await new Promise((done) => setTimeout(done, 150));
    }
    return false;
  }

  private async capture(capability: Capability, args: Record<string, unknown>): Promise<ActionResult> {
    const dir = await mkdtemp(join(tmpdir(), "branch-node-"));
    try {
      const ext = capability === "listen" ? ".wav" : capability === "camera" ? ".jpg" : ".png";
      const out = join(dir, `capture${ext}`);
      const command = capability === "screen" ? screenCommand(this.deps.os, out, this.env)
        : capability === "camera" ? cameraCommand(this.deps.os, out) : listenCommand(this.deps.os, out, Number(args.seconds ?? 5));
      if (!command) throw new Error("This device cannot do that.");
      const ran = await this.runner(command, { timeoutMs: 45_000, maxBytes: 4096 });
      if (ran.code !== 0) throw new Error(`The device could not do it: ${ran.stderr.trim().slice(0, 300) || `exit ${ran.code}`}`);
      const size = (await stat(out)).size;
      if (size > mediaLimitBytes) throw new Error("The picture or sound was larger than Branch accepts.");
      return { value: { captured: capability }, media: { mime: mimeOf(out), name: `${capability}${ext}`, data: await readFile(out) } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async location(): Promise<ActionResult> {
    const command = locationCommand(this.deps.os);
    if (!command) throw new Error("This device cannot say where it is.");
    const out = await this.runner(command, { timeoutMs: 20_000, maxBytes: 16_384 });
    const parsed = parseWhereAmI(out.stdout.toString("utf8"));
    if (out.code !== 0 || !parsed) throw new Error("The device could not find where it is.");
    return { value: parsed };
  }

  private async clipboard(): Promise<ActionResult> {
    const out = await this.runner(clipboardReadCommand(this.deps.os, this.env), { timeoutMs: 10_000, maxBytes: textLimitBytes });
    if (out.code !== 0) throw new Error("The device could not read what was copied.");
    return { value: { text: out.stdout.toString("utf8").slice(0, textLimitBytes) } };
  }

  private async files(folder: string, action: string, path: string): Promise<ActionResult> {
    const target = await inside(folder, path);
    if (action === "list") {
      const entries = await readdir(target, { withFileTypes: true });
      return { value: { entries: entries.slice(0, 200).map((entry) => ({ name: entry.name, folder: entry.isDirectory() })) } };
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error("That is not a file.");
    if (info.size > mediaLimitBytes) throw new Error("That file is larger than Branch accepts.");
    return { value: { read: path }, media: { mime: mimeOf(target), name: path.split(/[\\/]/).pop() || "file", data: await readFile(target) } };
  }

  private async run(folder: string, args: { executable: string; args: string[]; timeoutSeconds: number }): Promise<ActionResult> {
    const opened = await walledCommand(this.deps.os, folder, args,
      { hidden: [this.deps.identityDir], env: this.env, ...(this.deps.wall ? { deps: this.deps.wall } : {}) });
    try {
      const out = await this.runner({ executable: opened.start.executable, args: opened.start.args, env: stringEnv(opened.start.env), exactEnv: true },
        { cwd: folder, timeoutMs: args.timeoutSeconds * 1000, maxBytes: textLimitBytes });
      const note = await opened.finish({ exitCode: out.code ?? -1, stdout: out.stdout.toString("utf8"), stderr: out.stderr });
      return { value: { exitCode: out.code, stdout: out.stdout.toString("utf8"), stderr: out.stderr, ...(note ? { wall: note } : {}) } };
    } finally {
      await opened.close();
    }
  }
}

const stringEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

function needFolder(folder: string | null): string {
  if (!folder) throw new Error("No folder has been chosen for this device. The owner chooses one in Customize, Channels, Devices.");
  return folder;
}

const real = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Integration review (never-break on the node): the folder Branch names must not be the whole disk,
 * the home folder or anything above it, and must neither hold nor sit inside this node's key folder,
 * a place that keeps secrets (`.ssh`, `.aws`, the keychain…) or this Branch program. A hub that was
 * taken over, or a hasty choice, cannot turn `device.files` or `device.run` into a way to read them.
 */
export async function refuseUnsafeFolder(folder: string, where: { home: string; identityDir: string }): Promise<void> {
  const chosen = await real(folder), home = await real(where.home);
  const guarded = [where.identityDir, ...secretHomePlaces.map((place) => join(where.home, place)), installedProgram(programRoot())];
  const hits = within(home, chosen) || (await Promise.all(guarded.map(real)))
    .some((place) => within(place, chosen) || within(chosen, place));
  if (hits) throw new Error(`The folder ${folder} cannot be used on this device: it is the whole disk, the home folder, or it holds this device's key or other secrets. Choose a project folder instead.`);
}

/** The real place `path` names, refused unless it is inside `folder` (links included). */
export async function inside(folder: string, path: string): Promise<string> {
  const root = await realpath(folder);
  const target = await realpath(resolve(root, path || "."));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("That place is outside the chosen folder.");
  return target;
}

/** GeoClue's demo prints "Latitude: 48.85°" style lines. */
export function parseWhereAmI(text: string): { latitude: number; longitude: number; accuracyMeters: number | null } | null {
  const number = (label: string): number | null => {
    const match = new RegExp(`${label}:\\s*(-?[0-9.]+)`, "i").exec(text);
    return match ? Number(match[1]) : null;
  };
  const latitude = number("Latitude"), longitude = number("Longitude");
  if (latitude === null || longitude === null || Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
  return { latitude, longitude, accuracyMeters: number("Accuracy") };
}
