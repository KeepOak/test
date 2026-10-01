import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { compileChange, fetchSource, minutes, ownTemp, readyToCompile, stampDevVersion, type DevStage, type Run } from "../desktop/dev-build.js";
import { classify, readCompiled, shellEntries, type Classified, type Part } from "./classify.js";
import { liveBuildDir, readLiveState, stageLive } from "./live-folder.js";
import { sha256, verifyLive, type LiveManifest } from "./manifest.js";

/**
 * Live updates (hot-update): a Beta change built the light way.
 *
 * The change is fetched and checked exactly as a packaged Beta build is (src/desktop/dev-build.ts fetchSource: only the
 * exact commit, only on Beta's own line, only forward from what runs now). Then what it changed is placed (classify.ts),
 * against what each part runs now: main against the change it was packaged from, the engine and the window against the
 * changes they run. A change main must see stops here and goes the packaged way. Otherwise:
 *
 * - window only: nothing is compiled; the window's files are copied into a live build of their own;
 * - engine (and gateway): `npm run build`, tsc's incremental build and the copy steps, never packaging.
 *
 * Either way the result is a live build: its own folder, its files recorded (manifest.ts), ready to be checked again
 * and used. Nothing that runs now is touched.
 */
export interface LivePlan {
  repo: string;
  buildDir: string;
  commit: string;
  /** The newest change running now (for the never-go-back check). */
  running: string | null;
  /** The change main was packaged from; null: not recorded, and then only the packaged way is safe. */
  packaged: string | null;
  /** The change the engine runs, and the one the window is served from. */
  engineAt: string | null;
  windowAt: string | null;
  /** The program's own folder, where live builds are kept (live-folder.ts). */
  appRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  otherLineConfirmed?: boolean;
  /** See DevBuildPlan.builtOutput: GitHub's own build of the change, taken instead of compiling here. */
  builtOutput?: { repo: string; waitMs?: number };
  note?: (line: string) => void;
  onStage: (stage: DevStage, state: "running" | "skipped") => void;
  onVersion?: (version: string) => void;
}

export type LiveOutcome =
  | { tier: "shell"; version: string; reason: string }
  | { tier: "none"; version: string }
  | { tier: Exclude<Part, "shell">; version: string; parts: Set<Part>; dir: string; manifest: LiveManifest; digest: string; changed: Classified["files"] };

const commitShape = /^[0-9a-f]{40}$/;

/** The files changed from `from` to `to`, as git names them (both sides are in the build's own history). */
async function changedFiles(git: (args: string[], timeoutMs?: number) => Promise<string>, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const out = await git(["diff", "--name-only", "--no-renames", "-z", from, to], minutes(2));
  return out.split("\0").map((name) => name.trim()).filter(Boolean);
}

async function fileAt(git: (args: string[], timeoutMs?: number) => Promise<string>, commit: string, path: string): Promise<string | null> {
  return git(["show", `${commit}:${path}`]).catch(() => null);
}

/** Read every recorded compiled module, validating the exact buffer used for classification.
 * Do not walk a second, potentially changed directory tree or tolerate missing recorded modules.
 */
async function recordedModules(root: string, manifest: LiveManifest): Promise<Map<string, string>> {
  const modules = new Map<string, string>();
  for (const [path, want] of Object.entries(manifest.files)) {
    if (!path.startsWith("dist/")) continue;
    const name = path.slice("dist/".length);
    // Match readCompiled's module mapping and exclusions for copied, non-source folders.
    if (/^(data|handbook|bundled-add-ons)(\/|$)/.test(name) || !/\.c?js$/.test(name)) continue;
    const body = await readFile(join(root, path));
    if (body.length !== want.size || sha256(body) !== want.sha256)
      throw new Error("A recorded engine module changed while its graph was being read.");
    modules.set(`src/${name.replace(/\.js$/, ".ts").replace(/\.cjs$/, ".cts")}`, body.toString("utf8"));
  }
  return modules;
}

/** The exact running live engine already compiled all modules needed to classify a later window-only change.
 * Reuse only its checked immutable build, never an unlabelled build-dir/dist left by an earlier attempt.
 * A cache that is absent, incomplete, altered or no longer current simply keeps the existing compile path.
 */
async function runningModules(plan: LivePlan): Promise<Map<string, string> | null> {
  if (!plan.engineAt || plan.engineAt === plan.packaged) return null;
  try {
    const engine = (await readLiveState(plan.appRoot)).engine;
    if (!engine || engine.commit !== plan.engineAt) return null;
    const root = liveBuildDir(plan.appRoot, engine.commit);
    const manifest = await verifyLive(root, engine);
    const modules = await recordedModules(root, manifest);
    if (shellEntries.some(entry => !modules.has(entry))) return null;
    const current = (await readLiveState(plan.appRoot)).engine;
    if (!current || current.commit !== engine.commit || current.digest !== engine.digest) return null;
    return modules;
  } catch { return null; }
}

export async function buildLive(run: Run, plan: LivePlan): Promise<LiveOutcome> {
  const fetched = await fetchSource(run, plan);
  const { source, git, version } = fetched;
  const from = { shell: plan.packaged, engine: plan.engineAt ?? plan.packaged, window: plan.windowAt ?? plan.engineAt ?? plan.packaged };
  if (!from.shell || !commitShape.test(from.shell)) return { tier: "shell", version, reason: "which change this app was packaged from is not recorded" };
  const known = async (commit: string) => git(["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false);
  for (const commit of new Set([from.shell, from.engine, from.window])) {
    if (!commit || !(await known(commit))) return { tier: "shell", version, reason: "a change running now is not in the build's history" };
  }
  const sinceShell = await changedFiles(git, from.shell, plan.commit);
  const sinceEngine = await changedFiles(git, from.engine!, plan.commit);
  const sinceWindow = await changedFiles(git, from.window!, plan.commit);
  if (!sinceShell.length && !sinceEngine.length && !sinceWindow.length) return { tier: "none", version };
  const manifest = { before: await fileAt(git, from.shell, "package.json"), after: await readFile(join(source, "package.json"), "utf8") };
  const delta = classify({ changed: [...sinceEngine, ...sinceWindow], read: () => null, manifest });
  const windowOnly = delta.parts.has("window") && [...delta.parts].every(part => part === "window");
  // sinceShell may include engine code that was already compiled and applied live. That history must still be
  // classified against the packaged shell, but it does not require another compile for an unchanged engine.
  const cached = windowOnly ? await runningModules(plan) : null;
  const compiles = !cached && [...sinceShell, ...sinceEngine].some((path) => /^(src|data|docs\/handbook)\/|^tsconfig|^scripts\/(build-ts|copy-)/.test(path));
  if (cached) plan.note?.("Window-only change: reusing the verified running engine's compiled module graph; TypeScript compile skipped.");
  const reused = await readyToCompile(run, plan, fetched);
  plan.onStage("installing", reused ? "skipped" : "running");
  const env = ownTemp(plan.buildDir), timeoutMs = minutes(30);
  plan.onStage("building", "running");
  if (compiles) await compileChange(run, plan, source);
  else await run("node", ["scripts/copy-fonts.mjs"], { cwd: source, timeoutMs, env });
  const compiled = cached ?? (compiles ? await readCompiled(source) : new Map<string, string>());
  const read = (path: string) => compiled.get(path) ?? null;
  const shell = classify({ changed: sinceShell, read, manifest });
  if (shell.parts.has("shell")) {
    const why = shell.files.find((file) => file.part === "shell")?.path ?? "";
    return { tier: "shell", version, reason: `${why} is loaded by the app's main process` };
  }
  const engine = classify({ changed: sinceEngine, read, manifest });
  const window = classify({ changed: sinceWindow, read, manifest });
  // A main-process file can reach the engine's or the window's list without reaching the shell's (the running engine or
  // window is from a different change than the packaged app). It still needs main to load it, and a live update's list
  // only carries window, engine and gateway parts, so the whole update goes the packaged way instead of being refused.
  const mainFile = [...engine.files, ...window.files].find((file) => file.part === "shell");
  if (mainFile) return { tier: "shell", version, reason: `${mainFile.path} is loaded by the app's main process` };
  const parts = new Set<Part>([...engine.parts].filter((part) => part !== "window"));
  if (window.parts.has("window")) parts.add("window");
  const tier: Exclude<Part, "shell"> | null = parts.has("gateway") ? "gateway" : parts.has("engine") ? "engine" : parts.has("window") ? "window" : null;
  if (!tier) return { tier: "none", version };
  // The live build answers to its own version, as a packaged Beta build of this change would.
  await stampDevVersion(source, fetched.committedAt, plan.commit);
  const ancestors = tier === "window" ? [] : (await git(["rev-list", "--max-count=2000", plan.commit])).trim().split(/\s+/);
  const staged = await stageLive({ source, appRoot: plan.appRoot, commit: plan.commit, version, withEngine: tier !== "window", ancestors });
  return { tier, version, parts, dir: staged.dir, manifest: staged.manifest, digest: staged.digest, changed: [...engine.files, ...window.files] };
}
