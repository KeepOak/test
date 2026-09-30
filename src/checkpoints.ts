import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { GitRunner } from "./integrations/git-run.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { secretName, type WorkspaceHistory } from "./workspace-history.js";

/**
 * Points you can come back to. A checkpoint keeps the exact bytes of every file the assistant has
 * changed in this conversation, under a name; undo puts the last change back, and redo puts it
 * forward again. All three work on the versions the file history already keeps, so nothing new is
 * copied around and the bytes that come back are the bytes that were there.
 */
export interface UndoSummary { path: string; added: number; removed: number; diff: string }

/** The conversation a task belongs to; a task outside a conversation stands on its own. */
export function sessionOf(store: Store, context: ToolContext): string {
  const session = context.runId ? store.run(context.runId)?.sessionId : undefined;
  if (!session) throw new Error("This only works inside a conversation.");
  return session;
}

/**
 * Only three tools reach the model. Listing the points kept and putting a whole one back are the
 * owner's own choices, made from the timeline in Activity through the existing history routes, so
 * they cost the model's catalog nothing.
 */
export function registerCheckpoints(registry: ToolRegistry, store: Store, history: WorkspaceHistory): void {
  registry.register({
    name: "workspace.checkpoint", permission: "files.write", group: "files",
    description: "Keep a point to come back to: the bytes of every file changed in this conversation.",
    parameters: z.object({ label: z.string().trim().min(1).max(120).default("Checkpoint") }).strict(),
    target: () => "",
    execute: async (args, context) => history.checkpoint(sessionOf(store, context), args.label),
  });
  registry.register({
    name: "workspace.undo", permission: "files.write", group: "files",
    description: "Put the last file change in this conversation back. preview shows what would change.",
    parameters: z.object({ preview: z.boolean().default(false) }).strict(),
    target: (args) => (args.preview ? "" : "undo the last change"),
    execute: async (args, context) => {
      const session = sessionOf(store, context);
      if (args.preview) return { preview: true, change: await history.undoPlan(session) };
      return history.undo(session);
    },
  });
  registry.register({
    name: "workspace.redo", permission: "files.write", group: "files",
    description: "Put the last undone change forward again. preview shows what would change.",
    parameters: z.object({ preview: z.boolean().default(false) }).strict(),
    target: (args) => (args.preview ? "" : "redo the last undone change"),
    execute: async (args, context) => {
      const session = sessionOf(store, context);
      if (args.preview) return { preview: true, change: await history.redoPlan(session) };
      return history.redo(session);
    },
  });
}

/**
 * Wave mac2: a hidden snapshot store for the whole workspace, so putting files back also covers what
 * a command changed, and folders that are not git repositories. It is a separate git directory kept
 * in the private data folder (never inside the workspace), always called with an explicit
 * `--git-dir` and `--work-tree`, so the owner's own repository, if there is one, is never read from
 * or written to. Git itself is the one already installed on this computer; without it the caller
 * falls back to the per-file copies above and says so.
 */
export interface GitReply { ok: boolean; stdout: string; stderr: string }
/** Runs the system git with an argument array. Tests hand in a fake. */
export type GitCall = (args: string[], cwd: string, timeoutMs: number) => Promise<GitReply>;

/** The system git through the hardened runner: no shell, no hooks, no prompts. */
export function systemGit(runner: GitRunner = new GitRunner()): GitCall {
  return async (args, cwd, timeoutMs) => {
    try {
      const result = await runner.run({ cwd, args, timeoutMs, maxOutputBytes: 16 * 1024 * 1024 }, AbortSignal.timeout(timeoutMs + 5000));
      return { ok: result.status === "completed", stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  };
}

/**
 * Never copied into the store: a snapshot must not become a second place a password or key is kept.
 * These ignore lines are the cheap first filter; `secretName` (workspace-history.ts) is the rule, and
 * `take` checks every path against it, because a workspace's own .gitignore outranks these lines.
 * Big generated folders are left out for the same reason they are there.
 */
export const snapshotExcludes = [
  ".env", ".env.*", ".ssh/", ".aws/", "*credentials*", "*secret*", "*secrets*", "id_rsa*", "id_ed25519*",
  "*.pem", "*.key", "*.p12", "*.pfx", "node_modules/", "dist/", "release/", ".branch/",
];
const treeId = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const stepMs = 30_000;
/** A workspace past these is not snapshotted (the per-file copies still work); a bigger file is left out. */
export const snapshotCaps = { files: 100_000, fileBytes: 50 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024 };
/** Bytes are kept exactly as they are: no line-ending or filter conversion, whatever the workspace's .gitattributes say. */
const exactBytes = "* -text -filter -diff -merge -ident -working-tree-encoding\n";
/** The owner's own global ignore file is not read, so what a snapshot covers does not depend on it. */
const NO_EXCLUDES = join(tmpdir(), "branch-excludes-disabled-does-not-exist");

export class SnapshotStore {
  private ready: Promise<boolean> | undefined;
  /** Why snapshots were turned off for this launch (a snapshot failed or took too long), or "". */
  unavailableReason = "";
  constructor(private readonly folder: string, readonly workTree: string, private readonly git: GitCall | null) {}

  /** One hidden store per workspace folder, named by a hash of its path. */
  get gitDir(): string {
    return join(this.folder, createHash("sha256").update(resolve(this.workTree)).digest("hex").slice(0, 16));
  }
  /** Whether snapshots can be taken here: git is installed and the store could be set up. */
  async available(): Promise<boolean> {
    return !this.unavailableReason && await (this.ready ??= this.prepare());
  }
  private call(args: string[]): Promise<GitReply> {
    if (!this.git) return Promise.resolve({ ok: false, stdout: "", stderr: "Git is not installed" });
    return this.git(["-c", `core.excludesFile=${NO_EXCLUDES}`, "--git-dir", this.gitDir, "--work-tree", this.workTree, ...args], this.workTree, stepMs);
  }
  private async prepare(): Promise<boolean> {
    if (!this.git) return false;
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    const exists = await stat(join(this.gitDir, "HEAD")).then(() => true, () => false);
    if (!exists) {
      const made = await this.git(["init", "--quiet", "--bare", this.gitDir], this.folder, stepMs);
      if (!made.ok) { this.unavailableReason = `The snapshot store could not be set up: ${firstLine(made.stderr)}`; return false; }
    }
    const settings: [string, string][] = [["core.autocrlf", "false"], ["core.symlinks", "true"], ["core.fsmonitor", "false"], ["gc.auto", "0"]];
    for (const [key, value] of settings)
      if (!(await this.git(["--git-dir", this.gitDir, "config", key, value], this.folder, stepMs)).ok) return false;
    await mkdir(join(this.gitDir, "info"), { recursive: true });
    await writeFile(join(this.gitDir, "info", "exclude"), snapshotExcludes.join("\n") + "\n");
    await writeFile(join(this.gitDir, "info", "attributes"), exactBytes);
    return true;
  }
  /**
   * One snapshot step at a time: two `git add` runs on the one hidden index would trip over its lock, and a failed take
   * turns snapshots off until Branch restarts. A task's snapshot now runs beside its first model call (src/rewind.ts),
   * so the next message's can start while the last one's is still going.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  /** Records every workspace file (except the excluded ones) and returns the snapshot's id. */
  take(): Promise<string> {
    return this.inTurn(() => this.takeNow());
  }
  private async takeNow(): Promise<string> {
    if (!(await this.available())) throw new Error("Snapshots need Git, which is not installed on this computer.");
    const pathspecs = join(this.gitDir, "branch-pathspecs");
    const skipped = await this.unwanted();
    await writeFile(pathspecs, [".", ...skipped.map((path) => `:(top,exclude,literal)${path}`)].join("\0") + "\0");
    const added = await this.call(["add", "--all", `--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"]);
    const tree = added.ok ? await this.call(["write-tree"]) : added;
    const id = tree.stdout.trim();
    if (tree.ok && treeId.test(id)) return id;
    // A workspace too big to record in time would hold up every task; stop trying for this launch.
    return this.giveUp(firstLine(tree.stderr));
  }
  /**
   * The paths git would record that must not be: a secret-looking name anywhere in the path (whatever
   * the workspace's own .gitignore says) and a file over the size cap. Too many files, or too many
   * bytes in all, and no snapshot is taken.
   */
  private async unwanted(): Promise<string[]> {
    const listed = await this.call(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (!listed.ok) return this.giveUp(firstLine(listed.stderr));
    const paths = [...new Set(listed.stdout.split("\0").filter(Boolean))];
    if (paths.length > snapshotCaps.files) return this.giveUp(`the workspace has more than ${snapshotCaps.files} files`);
    const skipped: string[] = [];
    let total = 0;
    for (const path of paths) {
      if (path.split("/").some((part) => secretName.test(part))) { skipped.push(path); continue; }
      const size = await lstat(join(this.workTree, path)).then((info) => (info.isFile() ? info.size : 0), () => 0);
      if (size > snapshotCaps.fileBytes) skipped.push(path);
      else total += size;
    }
    if (total > snapshotCaps.totalBytes) return this.giveUp("the workspace holds more than 2 GB");
    return skipped;
  }
  private giveUp(why: string): never {
    this.unavailableReason = `Snapshots are off until Branch restarts, because one could not be taken: ${why}`;
    throw new Error(this.unavailableReason);
  }
  /**
   * Puts the workspace back to a snapshot: every kept file gets its kept bytes, and a file that has
   * appeared since (and is not excluded) is removed. Take a snapshot first if this should be undoable.
   */
  restore(id: string): Promise<{ changed: string[]; removed: string[] }> {
    if (!treeId.test(id)) return Promise.reject(new Error("That snapshot id is not valid"));
    return this.inTurn(() => this.restoreNow(id));
  }
  private async restoreNow(id: string): Promise<{ changed: string[]; removed: string[] }> {
    await this.takeNow();
    const diff = await this.call(["diff-index", "--cached", "--no-renames", "--name-status", "-z", id, "--"]);
    if (!diff.ok) throw new Error(`The snapshot could not be read: ${firstLine(diff.stderr)}`);
    const { changed, added } = parseNameStatus(diff.stdout);
    const doomed = added.map((path) => insideWorkTree(this.workTree, path)); // every path is checked before any is removed
    for (const target of doomed) await rm(target, { force: true });
    if (!(await this.call(["read-tree", id])).ok) throw new Error("The snapshot is not kept any more");
    const written = await this.call(["checkout-index", "--all", "--force"]);
    if (!written.ok) throw new Error(`The files could not be put back: ${firstLine(written.stderr)}`);
    return { changed, removed: added };
  }
}

/** Splits `git diff-index --name-status -z` output into every changed path and the added ones. */
export function parseNameStatus(output: string): { changed: string[]; added: string[] } {
  const parts = output.split("\0").filter((part) => part !== "");
  const changed: string[] = [], added: string[] = [];
  for (let at = 0; at + 1 < parts.length; at += 2) {
    const status = parts[at]!, path = parts[at + 1]!;
    changed.push(path);
    if (status.startsWith("A")) added.push(path);
  }
  return { changed, added };
}

/** A path git reported, resolved inside the work tree; anything that would leave it, or pass through a link, is refused. */
export function insideWorkTree(root: string, path: string): string {
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || path.includes("\0")) throw new Error(`Refused to touch ${path}`);
  let current = resolve(root);
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refused to touch ${path}: it is behind a link`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.replace(/^(fatal|error):\s*/i, "").trim()).find(Boolean)?.slice(0, 200) ?? "git did not say why";
}
