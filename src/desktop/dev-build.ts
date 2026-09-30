import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { removeTree } from "./remove-tree.js";
import { setPriority } from "node:os";
import { activeDeadline, quietPriority, type BuildGate } from "./quiet-build.js";
import { join, relative, sep } from "node:path";
import { useBuiltOutput } from "./build-output.js";
import { linkRuntime, partFolder, readPointer, runtimeVersion, sealAppFolder } from "./app-folders.js";

/**
 * The Beta update channel: like Hermes Desktop, Branch follows one line of work and builds the newest merged change
 * on this computer, instead of waiting for a published Stable release. It needs git and Node here.
 *
 * A build keeps one folder of its own in the data folder's `updates/` (which the assistant may never change, and which
 * the copy of the data folder leaves out), so the next build only fetches what is new, reinstalls packages only when
 * package-lock.json changed, and compiles only what changed. It still builds exactly the commit that was looked up, on
 * Beta's own line, after the history shows it goes forward from the running change. Every program runs hidden, never
 * asks for a password or sign-in (the repository is public), runs no hook and no setting kept in that folder, and is
 * given a time limit.
 */
/** The line of work Beta builds. Named here only, and never chosen by anyone, so it can move to main later. */
export const betaLine = "redesign/window";

export interface RunOptions {
  cwd?: string; timeoutMs: number; env?: Record<string, string>;
  /**
   * The program only computes and writes files (compiling, packaging), so a paused build may suspend it in place.
   * Anything that holds a network connection (git fetch, npm ci) is left to finish, and the next program waits.
   */
  pausable?: boolean;
}
export interface Run {
  (file: string, args: string[], options: RunOptions): Promise<string>;
}
/** The build's own stages, in order; the updater shows each with its time. "installing" is skipped when nothing changed. */
export type DevStage = "fetching" | "installing" | "building";

export const minutes = (count: number) => count * 60_000;
const quietGit = ["-c", "credential.helper=", "-c", "core.askPass="];

/** An error from a program the build ran: the words say what did not finish, `detail` is its output's key line. */
export class RunError extends Error {
  constructor(message: string, readonly detail: string | null) { super(message); }
}

/**
 * The line of a program's output that says what went wrong: the last one naming an error, else the last line at all.
 * The update screen shows it under the plain words, so the owner sees the real reason without opening the log.
 */
export function keyLine(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  // npm's own pointers and field lines say where its log is or which call failed, not what went wrong.
  const noise = /complete log of this run|^npm (error|err!)( (code|errno|syscall|path|command|cwd|signal|lifecycle)\b|\s*$)/i;
  const exact = /\bE[A-Z]{2,}:|\berror TS\d+|\bfatal:|\b\w*Error:/;
  const named = /\b(error|err!|failed|cannot|not found)\b/i;
  const line = lines.find((one) => exact.test(one) && !noise.test(one)) ?? lines.find((one) => named.test(one) && !noise.test(one)) ?? lines[0];
  return line ? line.slice(0, 300) : null;
}

/**
 * The real runner: hidden, no prompts, npm through the command shell Windows needs for `npm.cmd`; output to `log`.
 * With a gate (the build's own process, build-host.ts), each program waits while the build is paused, a pausable one
 * is suspended in place, its time limit counts only the time it ran, and one that runs out is ended with everything it
 * started (npm's own children too).
 */
export function realRun(platform: NodeJS.Platform = process.platform, log?: string, gate?: BuildGate): Run {
  const env = buildEnv(process.env, platform);
  return async (file, args, options) => {
    await gate?.ready();
    const [program, programArgs] = platform === "win32" && file === "npm"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", "npm", ...args]]
      : [file, args];
    const started = Date.now();
    const { code, stdout, stderr, timedOut, failed } = await runProgram(program, programArgs, {
      cwd: options.cwd, env: options.env ? { ...env, ...options.env } : env, timeoutMs: options.timeoutMs,
      pausable: options.pausable === true, group: platform !== "win32" && gate !== undefined }, gate);
    const output = `${stdout}\n${stderr}`, error = failed || code !== 0;
    if (log) await appendFile(log, `$ ${file} ${args.join(" ")}  (${Math.round((Date.now() - started) / 1000)} s${error ? ", failed" : ""})\n${output.trim()}\n\n`).catch(() => undefined);
    if (!error) return stdout;
    const lastLine = ((timedOut ? null : failed) ?? stderr).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
    throw new RunError(`${file} ${args[0] ?? ""} did not finish${timedOut ? " in time" : ""}${lastLine ? `: ${lastLine.slice(0, 300)}` : "."}`, keyLine(output));
  };
}

interface Finished { code: number | null; stdout: string; stderr: string; timedOut: boolean; failed: string | null }
const outputLimit = 64 << 20;
/** One program, hidden; its output kept up to 64 MB. `group`: in a process group of its own, so it is held and ended whole. */
function runProgram(program: string, args: string[], options: { cwd: string | undefined; env: NodeJS.ProcessEnv; timeoutMs: number; pausable: boolean; group: boolean },
  gate?: BuildGate): Promise<Finished> {
  return new Promise((resolve) => {
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, timedOut = false, failed: string | null = null;
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: options.group, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    // Everything it started first (npm's own children too), through the gate, while it is still there to be followed.
    const end = () => { void (pid !== undefined && gate ? gate.end(pid) : Promise.resolve()).then(() => child.kill()); };
    const keep = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) { failed ??= "its output was larger than 64 MB"; end(); return; }
      into.push(chunk);
    };
    child.stdout!.on("data", keep(out));
    child.stderr!.on("data", keep(err));
    if (pid !== undefined) gate?.started(pid, options.pausable);
    // Outside the build's own process (the updater's quick looks at GitHub), each program is lowered as it starts.
    if (pid !== undefined && !gate) try { setPriority(pid, quietPriority); } catch { /* it has already ended */ }
    const stop = activeDeadline(options.timeoutMs, () => (pid !== undefined && gate ? gate.heldMs(pid) : 0), () => { timedOut = true; end(); });
    const done = (code: number | null, why: string | null) => {
      stop();
      if (pid !== undefined) gate?.ended(pid);
      resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), timedOut, failed: failed ?? why ?? (timedOut ? "it ran out of time" : null) });
    };
    child.once("error", (error) => done(null, error.message));
    child.once("close", (code, signal) => done(code, code === null && !timedOut && !failed ? `it was ended by ${signal ?? "the system"}` : null));
  });
}

/**
 * What the build's programs see: this computer's own environment without the running app's own switches (a
 * BRANCH_* or ELECTRON_* value meant for this app must not steer the build), with prompts off, and on a Mac the
 * places Homebrew puts git and Node, which an app started from the Dock is not told about.
 */
export function buildEnv(from: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(from).filter(([key]) => !/^(BRANCH|ELECTRON)_/i.test(key)));
  const extraPath = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  return {
    ...kept,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "",
    // NAS cfc3808 follow-up: the Dev check's history holds commits only, and git would fetch a missing one lazily with
    // all its trees (14,720 for one train on 2026-09-25) instead of through the check's own commits-only fetch.
    GIT_NO_LAZY_FETCH: "1",
    PATH: [...extraPath, from.PATH ?? ""].filter(Boolean).join(platform === "win32" ? ";" : ":"),
  };
}

/** Whether this computer has what a Beta build needs; the reason in plain words when it does not. */
export async function devToolsMissing(run: Run): Promise<string | null> {
  const missing: string[] = [];
  for (const [tool, args] of [["git", ["--version"]], ["node", ["--version"]], ["npm", ["--version"]]] as const) {
    try { await run(tool, [...args], { timeoutMs: 20_000 }); } catch { missing.push(tool); }
  }
  if (!missing.length) return null;
  return `The Beta channel builds Branch on this computer, and ${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not found. Install git and Node.js (which includes npm), then check again, or choose Stable.`;
}

/** The newest commit on Beta's line of work, read with git (not GitHub's rate-limited web API). */
/** The whole-suite workflow a Beta change must have passed, on a push to Beta's line, before it is taken. */
export const wholeSuiteWorkflow = "checks.yml";
/**
 * Beta takes the newest change whose whole suite passed on GitHub, not simply the newest change: runs on the line are
 * batched, so its tip is often not checked yet, or was cancelled for a newer one. GitHub is asked only when the tip
 * moved (one small request, unauthenticated); when it cannot answer, the last passing change found is kept. Null when
 * none is known yet, and the tip is taken as before.
 */
export function newestGreen(fetchImpl: typeof fetch = globalThis.fetch, now: () => number = Date.now): (repo: string, tip: string) => Promise<string | null> {
  let lastTip: string | null = null, green: string | null = null, askedAt = 0;
  return async (repo, tip) => {
    // The same tip is asked about again only while it is not the passing change itself: a tip still being checked turns
    // green later without moving, and remembering the older answer kept the owner a change behind until the next merge.
    // Every five minutes at most, so GitHub's unauthenticated allowance (60 an hour) is never the limit.
    if (tip === lastTip && green && (green === tip || now() - askedAt < 5 * 60_000)) return green;
    try {
      const url = `https://api.github.com/repos/${repo}/actions/workflows/${wholeSuiteWorkflow}/runs?branch=${encodeURIComponent(betaLine)}&event=push&status=success&per_page=1`;
      const response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json", "user-agent": "Branch-Agent-updater" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return green;
      const body = await response.json() as { workflow_runs?: { head_sha?: unknown; head_branch?: unknown }[] };
      const sha = body.workflow_runs?.[0]?.head_sha;
      if (typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) && body.workflow_runs?.[0]?.head_branch === betaLine) { green = sha; lastTip = tip; askedAt = now(); }
    } catch { /* offline or refused: the last passing change found stands */ }
    return green;
  };
}

export async function remoteHead(run: Run, repo: string): Promise<string> {
  const out = await run("git", [...quietGit, "ls-remote", `https://github.com/${repo}.git`, `refs/heads/${betaLine}`], { timeoutMs: 60_000 });
  // ls-remote matches the end of ref names, so only the line naming exactly Beta's ref counts.
  const want = `refs/heads/${betaLine}`;
  const sha = out.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find(([id, ref]) => /^[0-9a-f]{40}$/.test(id ?? "") && ref === want)?.[0];
  if (!sha) throw new Error("GitHub did not say what the newest change is. Check the internet connection and try again.");
  return sha;
}

/**
 * Dogfood F5: where the running change stands against the main line's newest one, read from the history alone (the
 * commits without their files: under 2 MB for the whole line, and only what is new after that) in the updater's own
 * folder. "behind": the newest change includes the running one, so it is newer. "ahead": the running change already
 * includes it (a train or a canary built ahead of the main line). "apart": neither includes the other. "unknown": the
 * history could not be read, and the build's own never-go-back step (neverBack) still decides.
 */
export type DevStanding = "behind" | "ahead" | "apart" | "unknown";
/**
 * NAS cfc3808: the walls every history call runs behind, as src/reach/agent-git.ts's do: no hooks, https only.
 * Redirects are followed for the first request only (git's own default), and the walls keep them to https: GitHub
 * forwards Branch's current name after a move, and refusing that would leave every answer unknown (Q210).
 */
const historyWalls = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=initial"];
/**
 * Q209: git reads `protocol.<name>.allow` before `protocol.allow`, so a setting in the history folder's own config could
 * allow another protocol past the walls. `GIT_ALLOW_PROTOCOL` outranks every setting, and it lets only https through.
 */
const historyEnv = { GIT_ALLOW_PROTOCOL: "https" };
export async function devStanding(run: Run, historyDir: string, repo: string, running: string, head: string): Promise<DevStanding> {
  const cwd = historyDir, timeoutMs = 30_000;
  const git = (args: string[], ms = timeoutMs) => run("git", [...quietGit, ...historyWalls, ...args], { cwd, timeoutMs: ms, env: historyEnv });
  const has = (commit: string) => git(["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false);
  // NAS cfc3808: a link or a file planted where the history goes is never followed; the build's own step decides.
  const found = await lstat(historyDir).catch(() => null);
  if (found && (found.isSymbolicLink() || !found.isDirectory())) return "unknown";
  if (!found) await run("git", ["init", "--quiet", "--bare", historyDir], { timeoutMs, env: historyEnv }).catch(() => undefined);
  for (const [commit, ref] of [[head, "refs/branch/head"], [running, "refs/branch/running"]] as const) {
    if (!(await has(commit)))
      await git(["fetch", "--quiet", "--filter=tree:0", "--no-tags", `https://github.com/${repo}.git`, commit], minutes(5)).catch(() => undefined);
    // Kept by name, so the next look fetches only what is new after it, not the whole line again (NAS cfc3808).
    if (await has(commit)) await git(["update-ref", ref, commit]).catch(() => undefined);
  }
  if (!(await has(head)) || !(await has(running))) return "unknown";
  // One question whose answer is a change id: a walk that fails is unknown, never "apart" (NAS cfc3808).
  const shared = await git(["merge-base", running, head]).then((out) => out.trim(), () => "");
  if (!/^[0-9a-f]{40}$/.test(shared)) return "unknown";
  return shared === running ? "behind" : shared === head ? "ahead" : "apart";
}

/**
 * What `npm run package:desktop` runs, in package.json. A commit whose script is exactly this is built in those steps
 * one by one, so the version can be stamped between compiling and packaging; any other is run as its script says.
 */
export const packageSteps = "npm run build && node scripts/dependency-notices.mjs && node scripts/package-desktop.mjs";

/** Where Beta's line is kept inside the build's own history, fetched afresh by every build. */
export const lineRef = "refs/branch/line";
/**
 * The build folder's git settings, written over whatever is there before every build: nothing a setting could run
 * (fsmonitor, filters, an editor, a pager) and no remote to follow. Everything is fetched from an address given
 * on the command line, behind the same walls as the history check.
 */
export const buildGitConfig = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tlogallrefupdates = false\n";

/** What the last good package install left: installed again when any of it differs from what this build has. */
export interface PackagesRecord { lock: string; node: string; npm: string; platform: string; arch: string; tree: string }
const packagesRecordName = "packages.json";

/**
 * Whether this build needs `npm ci`: the reason in plain words, or null when node_modules is exactly what the last
 * install from the same package-lock.json left, installed by the same Node and npm for the same computer.
 */
export function packagesNeeded(record: PackagesRecord | null, now: Omit<PackagesRecord, "tree">, tree: string | null): string | null {
  if (!record) return "no earlier install is on record";
  if (record.lock !== now.lock) return "package-lock.json changed";
  if (record.node !== now.node || record.npm !== now.npm) return "Node or npm changed";
  if (record.platform !== now.platform || record.arch !== now.arch) return "the computer changed";
  if (!tree) return "node_modules is missing";
  if (tree !== record.tree) return "node_modules is not what the last install left";
  return null;
}

/**
 * One fingerprint of a whole folder: every file's path, size and contents (about 2.5 s for Branch's 466 MB of
 * node_modules). Links are named, never followed. Inside the desktop app, Electron reads `.asar` files as folders;
 * `original-fs` reads them as the files they are, as plain Node does. Null when the folder is not there.
 */
export async function folderDigest(root: string): Promise<string | null> {
  const fs = plainFs();
  const top = await fs.lstat(root).catch(() => null);
  if (!top?.isDirectory()) return null;
  const files: [string, string, boolean][] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push([relative(root, path).split(sep).join("/"), path, entry.isSymbolicLink()]);
    }
  };
  await walk(root);
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const [name, path, link] of files) {
    const body = link ? Buffer.from(`link:${await fs.readlink(path)}`) : await fs.readFile(path);
    hash.update(`${name}\0${body.length}\0`).update(createHash("sha256").update(body).digest());
  }
  return hash.digest("hex");
}

type PlainFs = { lstat: typeof lstat; readdir: typeof readdir; readFile: typeof readFile; readlink: (path: string) => Promise<string> };
function plainFs(): PlainFs {
  if (!process.versions.electron) return { lstat, readdir, readFile, readlink: (path) => readlink(path) };
  return (createRequire(import.meta.url)("original-fs") as { promises: PlainFs }).promises;
}

/**
 * What tsc wrote for sources that are gone: an incremental build never removes them, and a fresh clone would not
 * have them, so they are removed before building. Only tsc's own kinds of file, outside the folders the copy scripts
 * rebuild whole (scripts/copy-*.mjs).
 */
export function staleOutputs(distFiles: string[], sourceFiles: string[]): string[] {
  const sources = new Set(sourceFiles.map((name) => name.replace(/\.(c?)ts$/, ".$1js")));
  const copied = /^(data|handbook|bundled-add-ons)\//;
  return distFiles.filter((name) => {
    const kind = /^(.*?)(\.d\.c?ts|\.c?js\.map|\.c?js)$/.exec(name);
    if (!kind || copied.test(name) || name === "build-info.json") return false;
    const base = kind[1]!, ext = kind[2]!;
    const js = ext.startsWith(".d.") ? `${base}${ext === ".d.cts" ? ".cjs" : ".js"}` : ext.endsWith(".map") ? `${base}${ext.slice(0, -4)}` : `${base}${ext}`;
    return !sources.has(js);
  });
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return out;
}

/**
 * The build folder must be a real folder of this person's, and so must the checkout and its `.git` inside it: a link
 * or a file planted there is never followed, and nothing is built.
 */
export async function prepareBuildFolder(buildDir: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(buildDir, { recursive: true });
  const uid = process.getuid?.();
  for (const path of [buildDir, join(buildDir, "source"), join(buildDir, "source", ".git")]) {
    const found = await lstat(path).catch(() => null);
    if (found && (found.isSymbolicLink() || !found.isDirectory() || (platform !== "win32" && uid !== undefined && found.uid !== uid)))
      throw new Error("The folder Beta builds in is not a plain folder of yours, so nothing was built. Choose Stable, or remove the updates folder in Branch's data folder and try again.");
  }
  // macOS and Linux: closed to everyone else, as the updater's other folders are.
  if (platform !== "win32") await chmod(buildDir, 0o700);
}

export interface DevBuildPlan {
  repo: string;
  /** The build's own folder, kept between builds (in the data folder's `updates/`). */
  buildDir: string;
  commit: string; running: string | null; assetName: string;
  platform?: NodeJS.Platform; arch?: string;
  onStage: (stage: DevStage, state: "running" | "skipped") => void;
  /** The version this commit is built as, known once its source is here, before anything is installed or built. */
  onVersion?: (version: string) => void;
  /**
   * The owner confirmed, in the window, moving to this exact commit although it does not contain the running change
   * (a copy built from another line of work). Only then is the never-go-back step left out; the updater checks it.
   */
  otherLineConfirmed?: boolean;
  /**
   * Where GitHub publishes its own build of each Beta change (build-output.ts): taken, once checked, instead of compiling
   * here. Left out (tests, a runner handed in), the change is always compiled here.
   */
  builtOutput?: { repo: string; waitMs?: number };
  /** A line for the build's log (what was waited for, why GitHub's build was not used). */
  note?: (line: string) => void;
  /**
   * Windows, versioned app folders (app-folders.ts): the new version is laid out as `<root>/app-<version>/` beside the
   * running one (`running`, its program folder), sharing its Electron runtime by hard links; nothing is packaged.
   */
  appFolder?: { root: string; running: string; executableName: string };
}
/**
 * Windows: the app folder itself (nothing to zip and unzip again), or with versioned app folders the new version's own
 * folder, already in place beside the running one. macOS and Linux: the download, as a release has.
 */
export type DevBuilt = { version: string; reusedPackages: boolean } & ({ folder: string } | { appFolder: string } | { archive: string; checksumFile: string });

/** The source of one change, checked out and shown to be on Beta's line (see `fetchSource`). */
export interface FetchedSource {
  source: string;
  git: (args: string[], timeoutMs?: number) => Promise<string>;
  /** package-lock.json's hash, read before anything is stamped. */
  lock: string;
  committedAt: number;
  version: string;
}

/**
 * The first half of every Beta build, packaged or live (src/hot-update/live-build.ts): exactly `commit` is fetched from
 * Beta's own line, shown to be on it, checked out whole, shown to go forward from the running change, and its version
 * read. Nothing is installed or built yet.
 */
export async function fetchSource(run: Run, plan: Pick<DevBuildPlan, "repo" | "buildDir" | "commit" | "running" | "platform" | "onStage" | "onVersion" | "otherLineConfirmed">): Promise<FetchedSource> {
  const { repo, buildDir, commit, running } = plan;
  const platform = plan.platform ?? process.platform;
  const source = join(buildDir, "source"), url = `https://github.com/${repo}.git`;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("The Beta build is not set up on this computer, so nothing was changed.");
  await prepareBuildFolder(buildDir, platform);
  const git = (args: string[], timeoutMs = 30_000) => run("git", [...quietGit, ...historyWalls, ...args], { cwd: source, timeoutMs, env: historyEnv });
  plan.onStage("fetching", "running");
  if (!(await lstat(join(source, ".git")).catch(() => null))) await run("git", ["init", "--quiet", source], { timeoutMs: 30_000, env: historyEnv });
  // Removed first, so a link planted where the settings go is never written through.
  await rm(join(source, ".git", "config"), { force: true });
  await writeFile(join(source, ".git", "config"), buildGitConfig);
  await clearStaleLocks(join(source, ".git"));
  // Only what is new since the last build arrives; the line itself is fetched, so the commit can be shown to be on it.
  await git(["fetch", "--quiet", "--no-tags", "--force", url, `+refs/heads/${betaLine}:${lineRef}`], minutes(15));
  if (!(await git(["merge-base", "--is-ancestor", commit, lineRef]).then(() => true, () => false)))
    throw new Error(`The change that was looked up (${commit.slice(0, 7)}) is not on Beta's line of work, so nothing was built.`);
  await git(["checkout", "--quiet", "--force", "--detach", commit], minutes(5));
  // Everything the last build left goes, except what makes this one fast: packages (checked below), tsc's build info
  // and its output (stale outputs are removed below).
  await git(["clean", "-ffdxq", "-e", "/node_modules/", "-e", "/.build-cache/", "-e", "/dist/"], minutes(5));
  const head = (await git(["rev-parse", "HEAD"])).trim();
  if (head !== commit) throw new Error("The source did not arrive at the change that was looked up, so nothing was built.");
  if (running && running !== commit && plan.otherLineConfirmed !== true) await neverBack(git, url, running, commit);
  // Read before the version is stamped into it: the stamp changes the lockfile on every build.
  const lock = createHash("sha256").update(await readFile(join(source, "package-lock.json"))).digest("hex");
  const committedAt = Number((await git(["show", "-s", "--format=%ct", commit])).trim());
  // Known now, stamped only after compiling: tsc reads package.json (NodeNext), and a new version in it on every
  // build made each compile a full one (about 40 s instead of a few).
  const version = await devVersion(source, committedAt, commit);
  plan.onVersion?.(version);
  return { source, git, lock, committedAt, version };
}

/**
 * The change's compiled output: GitHub's own build of it when the plan names where to find it and it checks out in full
 * (build-output.ts), otherwise `npm run build` here, as before. Answers where it came from.
 */
export async function compileChange(run: Run, plan: Pick<DevBuildPlan, "builtOutput" | "note" | "buildDir" | "commit">, source: string): Promise<"github" | "here"> {
  if (plan.builtOutput) {
    const got = await useBuiltOutput({ repo: plan.builtOutput.repo, commit: plan.commit, source,
      ...(plan.builtOutput.waitMs !== undefined ? { waitMs: plan.builtOutput.waitMs } : {}), ...(plan.note ? { log: plan.note } : {}) });
    if (got.used) { plan.note?.(`Used GitHub's build of this change (sha256 ${got.digest}), checked in ${Math.round(got.ms / 1000)} s; nothing was compiled here.`); return "github"; }
    plan.note?.(`Compiling here: ${got.why}.`);
  }
  await run("npm", ["run", "build"], { cwd: source, timeoutMs: minutes(30), env: quietEnv(plan.buildDir), pausable: true });
  return "here";
}

/** npm ci only when needed, and the stale outputs of removed sources taken out of dist/, before a build (live or packaged). */
export async function readyToCompile(run: Run, plan: Pick<DevBuildPlan, "buildDir" | "onStage" | "platform" | "arch">, fetched: FetchedSource): Promise<boolean> {
  const platform = plan.platform ?? process.platform, arch = plan.arch ?? process.arch;
  const now = { lock: fetched.lock, ...(await toolVersions(run)), platform, arch };
  await removeTree(join(plan.buildDir, "tmp"));
  await mkdir(join(plan.buildDir, "tmp"), { recursive: true });
  const reused = await packages(run, plan, fetched.source, now);
  const sources = (await listFiles(join(fetched.source, "src"))).filter((name) => /\.c?ts$/.test(name) && !/\.d\.c?ts$/.test(name));
  for (const stale of staleOutputs(await listFiles(join(fetched.source, "dist")), sources)) await rm(join(fetched.source, "dist", stale), { force: true });
  return reused;
}

/**
 * Builds exactly `commit` of Beta's line in the build folder. Returns the app (or its download) and the version it
 * was stamped with. A failure leaves the installed app untouched.
 */
export async function buildDev(run: Run, plan: DevBuildPlan): Promise<DevBuilt> {
  const { buildDir, commit, assetName } = plan;
  const platform = plan.platform ?? process.platform, arch = plan.arch ?? process.arch;
  const { source, lock, committedAt, version } = await fetchSource(run, plan);
  const now = { lock, ...(await toolVersions(run)), platform, arch };
  // The packager empties the whole of %TEMP%\electron-packager when it starts, so two builds at once (another copy of
  // Branch, a developer's own packaging) wiped each other's app on 2026-09-27. Each build has a temporary folder of its own.
  await removeTree(join(buildDir, "tmp"));
  await mkdir(join(buildDir, "tmp"), { recursive: true });
  const reusedPackages = await packages(run, plan, source, now);
  plan.onStage("building", "running");
  await rm(join(source, "dist", "build-info.json"), { force: true });
  const sources = (await listFiles(join(source, "src"))).filter((name) => /\.c?ts$/.test(name) && !/\.d\.c?ts$/.test(name));
  for (const stale of staleOutputs(await listFiles(join(source, "dist")), sources)) await rm(join(source, "dist", stale), { force: true });
  // Windows: the app folder is what the update swaps in, so the zip and its checksum are left out.
  const release = platform === "win32" ? [] : ["--release"], env = quietEnv(buildDir), timeoutMs = minutes(30), pausable = true;
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (plan.appFolder && platform === "win32" && await lstat(join(source, "scripts", "assemble-app.mjs")).then((found) => found.isFile(), () => false)) {
    const appFolder = await intoAppFolder(run, plan, plan.appFolder, { source, committedAt, version });
    await recordPackages(buildDir, source, now);
    return { version, reusedPackages, appFolder };
  }
  if (manifest?.scripts?.["package:desktop"] === packageSteps) {
    // The same three steps the commit's own `npm run package:desktop` runs, with the version stamped after compiling.
    await compileChange(run, plan, source);
    await stampDevVersion(source, committedAt, commit);
    await run("node", ["scripts/dependency-notices.mjs"], { cwd: source, timeoutMs, env, pausable });
    await run("node", ["scripts/package-desktop.mjs", ...release], { cwd: source, timeoutMs, env, pausable });
  } else {
    // A commit that packages differently is built its own way, whole.
    await stampDevVersion(source, committedAt, commit);
    await run("npm", ["run", "package:desktop", ...(release.length ? ["--", ...release] : [])], { cwd: source, timeoutMs, env, pausable });
  }
  // The built app must say which change it is, or the next check could not tell it is current and could not see
  // going back from it (a change older than the Dev channel itself has no such record).
  const stamped = await readFile(join(source, "dist", "build-info.json"), "utf8").then((text) => JSON.parse(text)?.commit, () => null);
  if (stamped !== commit)
    throw new Error("The Beta build does not record which change it was made from, so nothing was changed. It is offered again once the newest change can say so.");
  // Packaging fetches Electron's own program into node_modules the first time; the record now includes it.
  await recordPackages(buildDir, source, now);
  const out = join(source, "release");
  return platform === "win32"
    ? { version, reusedPackages, folder: out }
    : { version, reusedPackages, archive: join(out, assetName), checksumFile: join(out, `${assetName}.sha256`) };
}

/**
 * Versioned app folders: the change compiled (or GitHub's build of it taken), stamped, and laid out beside the running
 * version as `<root>/app-<version>/`, with no packager and no new program. Its Electron runtime is the running one's, by
 * hard links, when Electron did not change; otherwise Electron's own stock folder, copied and checked by the change's
 * own script. The app (resources/app) is the change's own script's too, pruned as packaging prunes it. The folder is
 * made as `app-<version>.part` and renamed only once whole, so a cut-off build is never taken for a version.
 */
async function intoAppFolder(run: Run, plan: DevBuildPlan, target: NonNullable<DevBuildPlan["appFolder"]>,
  built: { source: string; committedAt: number; version: string }): Promise<string> {
  const { source, version } = built, env = quietEnv(plan.buildDir), timeoutMs = minutes(30), pausable = true;
  await compileChange(run, plan, source);
  await stampDevVersion(source, built.committedAt, plan.commit);
  await run("node", ["scripts/dependency-notices.mjs"], { cwd: source, timeoutMs, env, pausable });
  await writeFile(join(source, "dist", "build-info.json"), `${JSON.stringify({ commit: plan.commit, builtAt: new Date().toISOString() })}
`);
  const part = partFolder(target.root, version);
  await removeTree(part);
  const electron = await readFile(join(source, "node_modules", "electron", "package.json"), "utf8").then((text) => String(JSON.parse(text)?.version), () => null);
  if (electron && electron === await runtimeVersion(target.running)) {
    const linked = await linkRuntime(target.running, part, target.executableName);
    plan.note?.(`Shared the running version's Electron ${electron} (${linked.files} files, ${linked.copied} copied): no program was made.`);
  } else {
    await run("node", ["scripts/assemble-app.mjs", "--runtime", part, "--name", target.executableName], { cwd: source, timeoutMs, env, pausable });
    plan.note?.(`Electron changed (${await runtimeVersion(target.running) ?? "unknown"} to ${electron ?? "unknown"}): Electron's own stock program was copied and checked, not built.`);
  }
  await run("node", ["scripts/assemble-app.mjs", "--app", join(part, "resources", "app")], { cwd: source, timeoutMs, env, pausable });
  const stamped = await readFile(join(part, "resources", "app", "dist", "build-info.json"), "utf8").then((text) => JSON.parse(text)?.commit, () => null);
  if (stamped !== plan.commit) throw new Error("The new version's folder does not record which change it was made from, so nothing was changed.");
  return sealAppFolder(target.root, version, await readPointer(target.root));
}

/**
 * The lock files git leaves when it is stopped part way (its time limit, the computer shutting down): with the folder
 * kept, one left behind would stop every later build ("index.lock: File exists"). One older than the longest time any
 * build's git is given cannot belong to a git still working, so it goes; a newer one is left, and that build waits.
 */
export const gitLocks = ["index.lock", "HEAD.lock", "config.lock", "shallow.lock", "packed-refs.lock", "refs/branch/line.lock"];
export async function clearStaleLocks(gitDir: string, now = Date.now()): Promise<void> {
  for (const name of gitLocks) {
    const path = join(gitDir, ...name.split("/")), found = await lstat(path).catch(() => null);
    if (found?.isFile() && now - found.mtimeMs > minutes(15)) await rm(path, { force: true });
  }
}

/** npm ci only when the record says it is needed; the record is gone while an install runs, so a cut one is redone. */
async function packages(run: Run, plan: Pick<DevBuildPlan, "buildDir" | "onStage">, source: string, now: Omit<PackagesRecord, "tree">): Promise<boolean> {
  const recordPath = join(plan.buildDir, packagesRecordName);
  const record = await readFile(recordPath, "utf8").then(packagesRecord, () => null);
  const needed = packagesNeeded(record, now, record ? await folderDigest(join(source, "node_modules")) : null);
  if (!needed) { plan.onStage("installing", "skipped"); return true; }
  plan.onStage("installing", "running");
  await rm(recordPath, { force: true });
  await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source, timeoutMs: minutes(30), env: quietEnv(plan.buildDir) });
  await recordPackages(plan.buildDir, source, now);
  return false;
}

/**
 * The build's own temporary folder, for every program that writes temporary files (npm, the packager), and fewer
 * things at once: Node's file and hashing threads down to two (from four) and npm's downloads to four at a time (from
 * fifteen), so the build takes one or two cores and a trickle of the disk rather than all of both.
 */
export const quietEnv = (buildDir: string): Record<string, string> => {
  const tmp = join(buildDir, "tmp");
  return { TEMP: tmp, TMP: tmp, TMPDIR: tmp, UV_THREADPOOL_SIZE: "2", npm_config_maxsockets: "4" };
};
export const ownTemp = quietEnv;

async function toolVersions(run: Run): Promise<{ node: string; npm: string }> {
  const [node, npm] = await Promise.all([run("node", ["--version"], { timeoutMs: 20_000 }), run("npm", ["--version"], { timeoutMs: 20_000 })]);
  return { node: node.trim(), npm: npm.trim() };
}

async function recordPackages(buildDir: string, source: string, now: Omit<PackagesRecord, "tree">): Promise<void> {
  const tree = await folderDigest(join(source, "node_modules"));
  if (!tree) return;
  const record: PackagesRecord = { ...now, tree };
  // Written whole or not at all: a record cut off by a crash would otherwise be what every later build reads.
  const path = join(buildDir, packagesRecordName), part = `${path}.part`;
  await writeFile(part, `${JSON.stringify(record, null, 2)}\n`);
  await rename(part, path);
}

/**
 * The record as written, or null (install again) when it is cut off. Anything else that is not a record differs from
 * this build's in every field, so packagesNeeded installs again for it too.
 */
function packagesRecord(text: string): PackagesRecord | null {
  try { return JSON.parse(text) as PackagesRecord; } catch { return null; }
}

/**
 * The change offered must already contain the one running: a Beta or a release can be built from a newer change
 * than the main line's head for a while. The running change is fetched by its id when the build's history lacks it.
 * Anything that cannot be shown to go forward stops the build: a change that cannot be found, or a failed check.
 */
async function neverBack(git: (args: string[], timeoutMs?: number) => Promise<string>, url: string, running: string, commit: string): Promise<void> {
  const known = () => git(["cat-file", "-e", `${running}^{commit}`]).then(() => true, () => false);
  let found = await known();
  if (!found) {
    await git(["fetch", "--quiet", "--no-tags", url, running], minutes(5)).catch(() => undefined);
    found = await known();
  }
  if (!found)
    throw new Error(`Branch could not find the change the version running now was built from (${running.slice(0, 7)}), so it cannot tell whether the newest Beta change is newer. Nothing was changed. Choose Stable, or try again later.`);
  const shared = await git(["merge-base", running, commit]).then((out) => out.trim(), () => null);
  if (shared !== running)
    throw new Error(`The newest Beta change does not include the version running now (change ${running.slice(0, 7)}), so installing it would go back. Nothing was changed; it is offered again once it catches up.`);
}

/** The version a commit is built as, read from its package.json and lockfile without changing them. */
export async function devVersion(sourceDir: string, committedAt: number, commit: string): Promise<string> {
  const read = (name: string) => readFile(join(sourceDir, name), "utf8").then((text) => JSON.parse(text), () => null);
  return versionFor(await read("package.json"), await read("package-lock.json"), committedAt, commit);
}

function versionFor(manifest: { name?: unknown; version?: unknown } | null, lock: { version?: unknown; packages?: Record<string, { version?: unknown }> } | null, committedAt: number, commit: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(manifest?.version));
  if (manifest?.name !== "branch-agent" || !match || !lock || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version
    || !Number.isSafeInteger(committedAt) || committedAt < 1 || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error("The source's version could not be read, so nothing was built.");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}-dev.${committedAt}-g${commit.slice(0, 12)}`;
}

/**
 * Like Beta's stamp (scripts/beta-release.mjs), only for the build: a Dev build of 0.19.2's line is
 * 0.19.3-dev.<commit time>-g<commit> (one identifier: the Windows packager takes at most four dotted parts). The commit makes every build's version its own, so the update's record can
 * tell whether the swap landed even for two changes made in the same second; Beta (0.19.3-beta.N sorts below it)
 * never offers the same line's older code, and that line's Stable release sorts above it. Which Dev change is newer
 * is decided by the history (neverBack), never by these numbers: commit times need not increase.
 */
export async function stampDevVersion(sourceDir: string, committedAt: number, commit: string): Promise<string> {
  const manifestPath = join(sourceDir, "package.json"), lockPath = join(sourceDir, "package-lock.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")), lock = JSON.parse(await readFile(lockPath, "utf8"));
  const version = versionFor(manifest, lock, committedAt, commit);
  manifest.version = lock.version = lock.packages[""].version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return version;
}
