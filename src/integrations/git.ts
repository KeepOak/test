import { realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { NeedsInputError } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import { randomUUID } from "node:crypto";
import { branchRef, explainGit, inBranchSource, type GitOutcome, type GitRunner } from "./git-run.js";

/**
 * Everyday version control for the owner: see what changed, look back through saved versions, work
 * on a named line of work and save a version. Every command runs inside the workspace (or the
 * active project's folder), never touches anything the `.branchignore` file hides, and never
 * rewrites a saved version. Sending work to a server lives in the separate remote tools.
 */
export const WORKTREE_HOME = ".branch-worktrees";
/** Q101: the remote a new address is checked under before publishing touches the folder's own remote. */
const publishCheckRemote = "branch-publish-check";

/** The real, long-form spelling of a path when it exists; otherwise the resolved path as given. */
function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}
export interface GitChange { path: string; state: string }

/**
 * Q100: where a new parallel copy called `name` goes, in the repository's copies folder (made when missing).
 * Git writes the copy through every folder on the way, so the copies folder must be a real folder in the
 * repository, and nothing may be at the copy's own place yet: a link the repository carries at either would
 * put Branch's copy somewhere else, outside the folder it was asked about (and out of reach of its trust).
 */
async function copyPlace(cwd: string, name: string): Promise<string> {
  const home = join(cwd, WORKTREE_HOME);
  await mkdir(home, { recursive: true });
  if (!(await lstat(home)).isDirectory() || canonical(home) !== join(canonical(cwd), WORKTREE_HOME))
    throw new Error(`${WORKTREE_HOME} in this folder is a link, so no parallel copy is made here: it would land outside the folder.`);
  const target = join(home, name);
  if (await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT"))
    throw new Error(`Something is already at ${WORKTREE_HOME}/${name} in this folder, so no parallel copy is made there.`);
  return target;
}

/**
 * Q107: the parallel copy called `name`, checked before it is removed. `git worktree remove --force` follows a
 * link at the copies folder or at the copy itself to whatever worktree it leads to, so the copy must be a real
 * folder at its own place in this repository; otherwise nothing is removed. Null when the copy is already gone:
 * its place is then never handed to Git, since a link could appear there before Git looks (NAS 88d4a92).
 */
async function copyToRemove(cwd: string, name: string): Promise<string | null> {
  const target = join(cwd, WORKTREE_HOME, name);
  const found = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!found) return null;
  if (!found.isDirectory() || canonical(target) !== join(canonical(cwd), WORKTREE_HOME, name))
    throw new Error(`${WORKTREE_HOME}/${name} here is not a parallel copy Branch made in this folder (it is a link, or leads elsewhere), so nothing is removed.`);
  return target;
}

export class GitTools {
  constructor(private readonly files: WorkspaceFiles, private readonly runner: GitRunner) {}
  /** Q100: told of every parallel copy made or removed here (`source` is the repository folder), for folder trust. */
  onCopy: (event: { source: string; copy: string; made: boolean }) => void = () => {};

  /** Resolves a workspace folder and refuses anything outside it, hidden, or not a folder. */
  private async folder(path: string): Promise<string> {
    const target = await this.files.checked(path, true);
    if (!(await stat(target).catch(() => null))?.isDirectory()) throw new Error("That is not a folder in your workspace.");
    return target;
  }
  /**
   * Q107 (NAS 28ba0db): the copy called `name` exactly as Git registered it, or null. Git is handed only that
   * path, so it finds the copy by what it registered and never resolves the place through a link put there after
   * the check. A folder the repository itself carries at that place is no copy, and is never handed to Git.
   */
  private async registered(cwd: string, name: string, signal: AbortSignal): Promise<string | null> {
    const home = canonical(join(cwd, WORKTREE_HOME));
    return (await this.worktreePaths(cwd, signal)).find((path) => basename(path) === name && canonical(dirname(path)) === home) ?? null;
  }
  /**
   * Every folder on Git's worktree list, exactly as Git wrote it. With `-z` each field ends in a NUL, so a newline
   * in a folder somebody made by hand cannot pass for a line of its own. Git before 2.36 has no `-z`: its lines, as before.
   */
  private async worktreePaths(cwd: string, signal: AbortSignal): Promise<string[]> {
    const fields = await this.runner.run({ cwd, args: ["worktree", "list", "--porcelain", "-z"] }, signal);
    if (fields.status === "completed")
      return fields.stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
    // Only a Git that does not know -z is read line by line: 129 is Git's answer to a switch it does not know
    // (its words are translated). Any other failure is the call's own, as it would be without -z.
    if (fields.exitCode !== 129) throw new Error(explainGit(fields));
    const stdout = (await this.run(cwd, ["worktree", "list", "--porcelain"], signal)).stdout;
    return stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9).trim());
  }
  /** Q107: removals in one repository go one at a time, so another cannot take a copy off Git's list mid-check. */
  private readonly removing = new Map<string, Promise<unknown>>();
  private async oneRemoveAt<T>(cwd: string, work: () => Promise<T>): Promise<T> {
    const key = canonical(cwd);
    const mine = (this.removing.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.removing.set(key, mine.catch(() => undefined));
    return mine;
  }
  /** Q107: the copy checked on disk and on Git's list: its registered path, null when gone, or an error. */
  private async removable(cwd: string, name: string, signal: AbortSignal): Promise<string | null> {
    if (!(await copyToRemove(cwd, name))) return null;
    const copy = await this.registered(cwd, name, signal);
    if (!copy) throw new Error(`${WORKTREE_HOME}/${name} here is not a parallel copy Git knows of, so nothing is removed.`);
    return copy;
  }
  private async run(cwd: string, args: string[], signal: AbortSignal, options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<GitOutcome> {
    const outcome = await this.runner.run({ cwd, args, ...options }, signal);
    if (outcome.status !== "completed") throw new Error(explainGit(outcome));
    return outcome;
  }
  /** Drops paths the `.branchignore` hides and anything inside the parallel-copies folder. */
  private async visible(cwd: string, paths: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const path of paths.slice(0, 200)) {
      if (!path || path.startsWith('"') || path.startsWith(`${WORKTREE_HOME}/`)) continue;
      // Git collapses an untracked folder to one entry with a trailing slash ("?? build/").
      const isDirectory = path.endsWith("/");
      const inWorkspace = relative(this.files.root, join(cwd, path)).replace(/\\/g, "/");
      if (!(await this.files.hidden(inWorkspace, isDirectory))) kept.push(path);
    }
    return kept;
  }

  async status(path: string, signal: AbortSignal) {
    const cwd = await this.folder(path);
    const lines = (await this.run(cwd, ["status", "--porcelain=v1", "--branch"], signal)).stdout.split("\n").filter(Boolean);
    const header = lines[0]?.startsWith("##") ? lines[0].slice(3) : "";
    const changes = await this.changes(cwd, lines);
    return {
      folder: path, branch: /^(?:No commits yet on )?([^. ]+)/.exec(header)?.[1] ?? "unknown",
      ahead: Number(/ahead (\d+)/.exec(header)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(header)?.[1] ?? 0),
      changes, clean: changes.length === 0,
    };
  }
  private async changes(cwd: string, lines: string[]): Promise<GitChange[]> {
    const entries = lines.filter((line) => !line.startsWith("##")).slice(0, 200)
      .map((line) => ({ code: line.slice(0, 2), path: line.slice(3).split(" -> ").at(-1)! }));
    const visible = new Set(await this.visible(cwd, entries.map((entry) => entry.path)));
    return entries.filter((entry) => visible.has(entry.path))
      .map((entry) => ({ path: entry.path, state: describeState(entry.code) }));
  }

  async diff(input: { folder: string; range?: string | undefined; staged?: boolean | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const scope = [...(input.staged ? ["--cached"] : []), ...(input.range ? [input.range] : [])];
    const names = (await this.run(cwd, ["diff", ...noPrograms, ...scope, "--name-only"], signal)).stdout.split("\n");
    const files = await this.visible(cwd, names.filter(Boolean));
    if (!files.length) return { folder: input.folder, files: [], text: "", truncated: false };
    const outcome = await this.run(cwd, ["diff", ...noPrograms, "--no-color", ...scope, "--", ...files], signal, { maxOutputBytes: 65536 });
    const text = outcome.stdout.slice(0, 24000);
    return { folder: input.folder, files, text, truncated: outcome.truncated || outcome.stdout.length > text.length };
  }

  async log(input: { folder: string; limit: number; path?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const target = input.path ? ["--", input.path] : [];
    const args = ["log", ...noPrograms, `--max-count=${input.limit}`, "--no-color", "--pretty=format:%H%x1f%an%x1f%aI%x1f%s", ...target];
    const stdout = (await this.run(cwd, args, signal)).stdout;
    const versions = stdout.split("\n").filter(Boolean).map((line) => line.split("\x1f"))
      .map(([commit, author, at, subject]) => ({ commit: (commit ?? "").slice(0, 12), author, at, summary: (subject ?? "").slice(0, 200) }));
    return { folder: input.folder, versions };
  }

  async branch(input: { folder: string; action: "list" | "create" | "switch"; name?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    if (input.action === "list") {
      const stdout = (await this.run(cwd, ["branch", "--list", "--format=%(refname:short)"], signal)).stdout;
      const current = (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
      return { folder: input.folder, current, branches: stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 200) };
    }
    if (!input.name) throw new Error("Tell me what the line of work should be called.");
    const args = input.action === "create" ? ["switch", "--create", input.name] : ["switch", input.name];
    await this.run(cwd, args, signal);
    return { folder: input.folder, current: input.name, created: input.action === "create" };
  }

  async commit(input: { folder: string; message: string; paths?: string[] | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const candidates = input.paths?.length ? input.paths : (await this.status(input.folder, signal)).changes.map((change) => change.path);
    const allowed = await this.visible(cwd, candidates);
    if (!allowed.length) throw new Error("There is nothing to save: no files have changed since the last saved version.");
    await this.run(cwd, ["add", "--", ...allowed], signal);
    const staged = (await this.run(cwd, ["diff", ...noPrograms, "--cached", "--name-only"], signal)).stdout.split("\n").filter(Boolean);
    if (!staged.length) throw new Error("There is nothing to save: no files have changed since the last saved version.");
    await this.run(cwd, ["commit", "--message", input.message], signal);
    const commit = (await this.run(cwd, ["rev-parse", "HEAD"], signal)).stdout.trim().slice(0, 12);
    return { folder: input.folder, commit, files: staged.slice(0, 100), summary: input.message.split("\n")[0]!.slice(0, 200) };
  }

  async worktree(input: { folder: string; action: "add" | "remove" | "list"; name?: string | undefined; branch?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const home = join(cwd, WORKTREE_HOME);
    if (input.action === "list") {
      const paths = await this.worktreePaths(cwd, signal);
      // Git may print a folder in a different spelling (Windows short names, case); compare real paths.
      const base = canonical(home);
      const inside = (path: string) => { const rel = relative(base, canonical(path)); return rel !== "" && !rel.startsWith(".."); };
      const mine = paths.filter(inside);
      // Q128 (NAS 9730120): a copy whose folder was deleted by hand is still on Git's list; it is shown as gone, so a
      // name that cannot be used again is explained rather than silently listed as a working copy.
      return { folder: input.folder, copies: await Promise.all(mine.map(async (path) => {
        const name = relative(base, canonical(path)).replace(/\\/g, "/");
        const there = await lstat(path).then(() => true, () => false);
        return there ? { name } : { name, gone: true };
      })) };
    }
    if (!input.name) throw new Error("Tell me what to call this parallel copy.");
    const target = join(home, input.name);
    if (input.action === "remove") {
      const name = input.name;
      return this.oneRemoveAt(cwd, async () => {
        const copy = await this.removable(cwd, name, signal);
        if (!copy) {
          this.onCopy({ source: cwd, copy: target, made: false });
          throw new Error(`There is no parallel copy called "${name}" here any more, so nothing was removed.`);
        }
        await this.run(cwd, ["worktree", "remove", "--force", copy], signal, { timeoutMs: 60000 });
        this.onCopy({ source: cwd, copy: target, made: false });
        return { folder: input.folder, name, removed: true };
      });
    }
    await copyPlace(cwd, input.name);
    const create = input.branch ? ["-b", input.branch] : ["--detach"];
    await this.run(cwd, ["worktree", "add", ...create, target], signal, { timeoutMs: 60000 });
    this.onCopy({ source: cwd, copy: target, made: true });
    return { folder: input.folder, name: input.name, path: `${WORKTREE_HOME}/${input.name}`, branch: input.branch ?? null };
  }

  /**
   * A plan branch: a parallel copy of the repository, on a line of work of its own, where a risky
   * plan or a saved procedure can be tried without touching what the owner is working on. The copy
   * lives in the same confined folder as every other parallel copy. Nothing comes back until the
   * difference has been looked at and the merge asked for.
   */
  async planStart(input: { folder: string; name: string; from?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const branch = planBranch(input.name);
    const target = await copyPlace(cwd, input.name);
    const from = input.from ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    await this.run(cwd, ["worktree", "add", "-b", branch, target, from], signal, { timeoutMs: 60000 });
    this.onCopy({ source: cwd, copy: target, made: true });
    return { folder: input.folder, name: input.name, branch, from, path: `${WORKTREE_HOME}/${input.name}`,
      note: "Work in that folder. Ask for the difference when you are done, and merge it back only when it looks right." };
  }
  /** What trying the plan changed, compared with where it started. */
  async planDiff(input: { folder: string; name: string; against?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const branch = planBranch(input.name);
    const against = input.against ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    const names = (await this.run(cwd, ["diff", ...noPrograms, "--name-only", `${against}...${branch}`], signal)).stdout.split("\n");
    const files = await this.visible(cwd, names.filter(Boolean));
    if (!files.length) return { folder: input.folder, name: input.name, branch, against, files: [], text: "", truncated: false,
      note: "The plan changed nothing that is saved on its branch yet." };
    const outcome = await this.run(cwd, ["diff", ...noPrograms, "--no-color", `${against}...${branch}`, "--", ...files], signal, { maxOutputBytes: 65536 });
    const text = outcome.stdout.slice(0, 24000);
    return { folder: input.folder, name: input.name, branch, against, files, text, truncated: outcome.truncated || outcome.stdout.length > text.length };
  }
  /** Brings the plan's work back onto the line of work the owner is on, keeping its own history. */
  async planMerge(input: { folder: string; name: string; message?: string | undefined; remove: boolean }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const branch = planBranch(input.name);
    // Checked before the merge, so a copy that is not Branch's own leaves everything as it was.
    if (input.remove) await this.removable(cwd, input.name, signal);
    const into = (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    await this.run(cwd, ["merge", "--no-ff", "--no-edit", "-m", input.message ?? `Try "${input.name}"`, branch], signal, { timeoutMs: 60000 });
    // Q107: checked again right before the remove, since the merge itself can put a link at the copy's place.
    // Reported as removed only when the remove really ran and finished; a copy already gone is left to Git never.
    let removed = false;
    if (input.remove) {
      const name = input.name;
      removed = await this.oneRemoveAt(cwd, async () => {
        const copy = await this.removable(cwd, name, signal).catch(() => undefined); // undefined: refused; null: gone
        const done = !!copy && await this.run(cwd, ["worktree", "remove", "--force", copy], signal, { timeoutMs: 60000 }).then(() => true, () => false);
        if (done || copy === null) this.onCopy({ source: cwd, copy: join(cwd, WORKTREE_HOME, name), made: false });
        return done;
      });
    }
    return { folder: input.folder, name: input.name, branch, into, merged: true, copyRemoved: removed };
  }

  /**
   * selfdev: brings a repository onto this computer for the first time, into a new folder of the workspace, from its
   * https:// address (no sign-in details in it) or from a repository folder on this computer. Hooks never run
   * (git-run.ts pins core.hooksPath), submodules are not fetched, and Branch's own source is never cloned here: that
   * is branch.prepare_source_change's protected checkout.
   */
  async clone(input: { url: string; folder: string; branch?: string | undefined }, signal: AbortSignal) {
    const source = cloneSource(input.url);
    const target = await this.files.checked(input.folder);
    const inside = relative(this.files.root, target).replace(/\\/g, "/");
    if (!inside || inside.startsWith("..")) throw new Error("Clone into a new folder inside your workspace.");
    if (/(^|\/)branch-agent-source(\/|$)/i.test(inside)) throw new Error("Branch's own source is prepared with branch.prepare_source_change, never cloned here.");
    if (await lstat(target).catch(() => null)) throw new Error(`${input.folder} already exists. Clone into a new folder.`);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    await this.run(parent, ["clone", "--no-recurse-submodules", ...(input.branch ? ["--branch", input.branch] : []), "--", source, basename(target)], signal, { timeoutMs: 600000 });
    const branch = (await this.run(target, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    return { folder: input.folder, from: source, branch, cloned: true };
  }

  /**
   * Points a folder at a repository on a server and sends its work there for the first time. The
   * address is set as a plain remote with no sign-in details in it: the push uses whatever Git
   * sign-in this computer already has, so no token is ever written into the repository's settings.
   */
  async publish(input: { folder: string; url: string; remote: string; branch?: string | undefined }, signal: AbortSignal, walked: Walked = {}) {
    const cwd = await this.folder(input.folder);
    const address = new URL(input.url);
    if (address.protocol !== "https:" || address.username || address.password)
      throw new Error("The address of a repository on a server starts with https:// and carries no sign-in details.");
    const ref = walked.ref ?? await this.sendRef(cwd, input.branch, signal), branch = shortBranch(ref);
    // Q98: publishing is a push too, so in Branch's source it gets the same checks, on the address Git will really use.
    // Q101: they run on a remote of their own, so a refused publish leaves the folder's own remote as it was (in a
    // worktree the remotes are the source checkout's).
    if (inBranchSource(cwd)) {
      // Settings for the pushed name kept outside the repository (the computer's own Git settings) would still
      // apply after the name is re-pointed, so they are refused before the folder's own remote is touched.
      const pattern = `^remote\\.${input.remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`;
      const elsewhere = await this.runner.run({ cwd, args: ["config", "--show-scope", "--get-regexp", pattern], timeoutMs: 10_000 }, signal);
      // Exit 1 is "no such settings"; anything else that did not complete (stopped, too slow, too much) is not a no.
      if (elsewhere.status !== "completed" && !(elsewhere.status === "failed" && elsewhere.exitCode === 1))
        throw new Error(`Could not read the Git settings for "${input.remote}", so nothing was sent.`);
      const lines = elsewhere.status === "completed" ? elsewhere.stdout.split("\n").filter(Boolean) : [];
      if (lines.some((line) => !/^local\s/.test(line)) || (lines.length && await this.unremovable(cwd, input.remote, pattern, signal)))
        throw new Error(`Git settings for "${input.remote}" that publishing cannot replace (kept outside the repository's own settings, or written so Git cannot remove them) say where it sends, so nothing was sent.`);
      // A name of its own for each publish: worktrees of one source share its remotes, so a fixed name could
      // be re-pointed by another publish while this one is being checked.
      const check = `${publishCheckRemote}-${randomUUID()}`;
      // Taken away even when the run is being stopped, the add included, so the unchecked address never stays behind.
      const refused = await (async () => {
        await this.run(cwd, ["remote", "add", check, address.href], signal);
        return this.validateRemoteURL(cwd, check, true, signal);
      })().finally(() => this.run(cwd, ["remote", "remove", check], AbortSignal.timeout(10_000)).catch(() => undefined));
      if (refused) throw new Error(refused);
    }
    await this.run(cwd, ["remote", "remove", input.remote], signal).catch(() => undefined);
    await this.run(cwd, ["remote", "add", input.remote, address.href], signal);
    const outcome = await this.run(cwd, ["push", "--set-upstream", input.remote, sendsTo(ref, walked.commit)], signal, { timeoutMs: 180000 });
    return { folder: input.folder, remote: input.remote, address: address.href, branch, sent: true, notes: notes(outcome) };
  }

  /**
   * Q101: whether `git remote remove` would leave some of the named remote's settings behind (a section spelt
   * `[Remote "origin"]`, which Git cannot remove), tried on a copy of the repository's settings.
   */
  private async unremovable(cwd: string, name: string, pattern: string, signal: AbortSignal): Promise<boolean> {
    const settings = resolve(cwd, (await this.run(cwd, ["rev-parse", "--git-path", "config"], signal)).stdout.trim());
    const scratch = await mkdtemp(join(tmpdir(), "branch-publish-"));
    try {
      const copy = join(scratch, "config");
      await copyFile(settings, copy);
      const removed = await this.runner.run({ cwd, args: ["config", "--file", copy, "--remove-section", `remote.${name}`], timeoutMs: 10_000 }, signal);
      const left = await this.runner.run({ cwd, args: ["config", "--file", copy, "--get-regexp", pattern], timeoutMs: 10_000 }, signal);
      // Only Git's own "no such settings" (exit 1) means nothing is left; a read that did not finish is not a no.
      return removed.status !== "completed" || !(left.status === "failed" && left.exitCode === 1);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }

  /**
   * Q79, A1: when Git run inside Branch's source, refuse LOCAL or WORKTREE scoped
   * settings that could run a program during sign-in, key management, or includes.
   */
  private async checkScopeKeys(cwd: string, signal: AbortSignal): Promise<string | void> {
    const checks: { pattern: string; desc: string }[] = [
      { pattern: "^credential\\..*helper$", desc: "credential helper" },
      { pattern: "^core\\.askPass$", desc: "password prompt command" },
      { pattern: "^core\\.sshCommand$", desc: "SSH command" },
      { pattern: "^include\\.path$", desc: "included config file" },
      { pattern: "^includeIf\\..*\\.path$", desc: "conditional included config file" },
    ];
    for (const check of checks) {
      const result = await this.runner.run({ cwd, args: ["config", "--show-scope", "--get-regexp", check.pattern], timeoutMs: 10_000 }, signal);
      if (result.status === "completed" && result.exitCode === 1) continue; // Exit 1 means no match
      if (result.status !== "completed") {
        if (result.stderr || result.exitCode !== 1) return `Could not read Git config, so nothing was sent.`;
        continue;
      }
      for (const line of result.stdout.split("\n")) {
        const match = /^(local|worktree)\s+/.exec(line);
        if (match) return `Git config "${check.desc}" is set at ${match[1]} scope, which could run a program or load untrusted settings.`;
      }
    }
  }

  /**
   * Q82: refuse an ssh:// or scp-like remote whose user or host starts with `-`: ssh is handed
   * `user@host` as one argument, so a leading dash in either could be read as an option.
   */
  private checkHostDash(url: string): string | void {
    const at = /^ssh:\/\/([^/]+)/.exec(url)?.[1] ?? /^([^/:]+):/.exec(url)?.[1];
    if (at && (at.startsWith("-") || at.split("@").at(-1)?.startsWith("-")))
      return `Remote "${url}" starts its user or host with "-", which ssh could read as an option, so nothing was sent.`;
  }

  /**
   * Q82, B: refuse a remote whose URL has been rewritten by url.<x>.insteadOf or
   * url.<x>.pushInsteadOf config, which could change what repository Git sends to.
   */
  private async checkInsteadOf(cwd: string, remote: string, isPush: boolean, signal: AbortSignal): Promise<string | void> {
    const raw = await this.runner.run({ cwd, args: ["config", "--get-all", `remote.${remote}.url`], timeoutMs: 10_000 }, signal);
    // Q96: a remote Git still reads from a .git/remotes or .git/branches file has nothing here to compare
    // its rewritten address with, so it is refused rather than let through.
    if (raw.status !== "completed")
      return `Remote "${remote}" is not set in Git's settings (it may come from an old .git/remotes or .git/branches file), so nothing was sent.`;
    const configured = raw.stdout.trim().split("\n").filter(Boolean);
    const getUrlArgs = isPush ? ["remote", "get-url", "--push", "--all", remote] : ["remote", "get-url", "--all", remote];
    const read = await this.runner.run({ cwd, args: getUrlArgs, timeoutMs: 10_000 }, signal);
    if (read.status !== "completed") return;
    const resolved = read.stdout.trim().split("\n").filter(Boolean);
    if (configured.length !== resolved.length)
      return `Remote URL was changed by url.<x>.insteadOf or url.<x>.pushInsteadOf config, which can redirect to an unexpected repository.`;
    for (let i = 0; i < configured.length; i++) {
      if (configured[i] !== resolved[i])
        return `Remote URL was changed by url.<x>.insteadOf or url.<x>.pushInsteadOf config, which can redirect to an unexpected repository.`;
    }
  }

  /**
   * C: validates remote URLs (for push or fetch) against safe format and insteadOf rewrites.
   */
  private async validateURLs(cwd: string, remote: string, isPush: boolean, signal: AbortSignal): Promise<string | void> {
    const getUrlArgs = isPush ? ["remote", "get-url", "--push", "--all", remote] : ["remote", "get-url", "--all", remote];
    const read = await this.runner.run({ cwd, args: getUrlArgs, timeoutMs: 10_000 }, signal);
    if (read.status !== "completed") return `Remote "${remote}" is not configured in this repository, so nothing was sent.`;
    const urls = read.stdout.trim().split("\n").filter(Boolean);
    if (!urls.length) return `Remote "${remote}" has no address, so nothing was sent.`;
    for (const url of urls) {
      if (!(/^https:\/\//.test(url) || /^ssh:\/\//.test(url) || /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._\/-]+$/.test(url)))
        return `Remote URL must use https://, ssh://, or scp-like format (user@host:path), but got: ${url}`;
      const dashError = this.checkHostDash(url);
      if (dashError) return dashError;
    }
    const insteadOfError = await this.checkInsteadOf(cwd, remote, isPush, signal);
    if (insteadOfError) return insteadOfError;
  }

  /**
   * Q98: the full ref a push sends: the branch named, or (none named, or `HEAD`) the branch checked out, read
   * from HEAD itself. Never a bare `HEAD`, which Git could send as a tag of that name while the contract walks
   * the worktree's HEAD; a detached HEAD has no branch to send.
   */
  private async sendRef(cwd: string, branch: string | undefined, signal: AbortSignal): Promise<string> {
    if (branch && branch !== "HEAD") return branchRef(branch);
    const outcome = await this.runner.run({ cwd, args: ["symbolic-ref", "-q", "HEAD"], timeoutMs: 10_000 }, signal);
    const ref = outcome.status === "completed" ? outcome.stdout.trim() : "";
    if (!/^refs\/heads\/./.test(ref)) throw new Error("No branch is checked out here (HEAD is detached), so name the branch to send.");
    return ref;
  }

  /**
   * Q12, C: when Git run inside Branch's source, validate that a remote is configured
   * and uses only https:// or ssh:// (including scp-like user@host:path).
   * Refuses file://, plain paths, ext::, and other transports that could execute code.
   */
  private async validateRemoteURL(cwd: string, remote: string, isPush: boolean, signal: AbortSignal): Promise<string | void> {
    if (!inBranchSource(cwd)) return;
    const scopeError = await this.checkScopeKeys(cwd, signal);
    if (scopeError) return scopeError;
    return this.validateURLs(cwd, remote, isPush, signal);
  }

  /** Sending work to a shared server; pushing the branch everyone shares asks the person first. */
  async push(input: { folder: string; remote: string; branch?: string | undefined; confirmed?: boolean | undefined }, signal: AbortSignal, walked: Walked = {}) {
    const cwd = await this.folder(input.folder);
    const urlError = await this.validateRemoteURL(cwd, input.remote, true, signal);
    if (urlError) throw new Error(urlError);
    const ref = walked.ref ?? await this.sendRef(cwd, input.branch, signal), branch = shortBranch(ref);
    if (/^refs\/heads\/(main|master)$/i.test(ref) && !input.confirmed)
      throw new NeedsInputError(`This would send your work straight to "${branch}" on ${input.remote}, the copy everyone shares. Shall I go ahead?`);
    const outcome = await this.run(cwd, ["push", input.remote, sendsTo(ref, walked.commit)], signal, { timeoutMs: 120000 });
    return { folder: input.folder, remote: input.remote, branch, sent: true, notes: notes(outcome) };
  }
  async pull(input: { folder: string; remote: string; branch?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const urlError = await this.validateRemoteURL(cwd, input.remote, false, signal);
    if (urlError) throw new Error(urlError);
    const branch = input.branch ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    const outcome = await this.run(cwd, ["pull", "--ff-only", input.remote, branch], signal, { timeoutMs: 120000 });
    return { folder: input.folder, remote: input.remote, branch, notes: notes(outcome) };
  }
}

const shortBranch = (ref: string): string => ref.replace(/^refs\/heads\//, "");
/** selfdev: where a clone may come from: an https:// address with no sign-in details, or an absolute folder path. */
function cloneSource(url: string): string {
  const text = url.trim();
  if (/^https:\/\//i.test(text)) {
    const address = new URL(text);
    if (address.username || address.password || address.search || address.hash) throw new Error("A repository address carries no sign-in details, query or fragment.");
    return address.href;
  }
  if (!/^([A-Za-z]:[\\/]|\/)/.test(text) || text.includes("::") || text.includes("\0"))
    throw new Error("Clone from an https:// address or from a repository folder on this computer, given as a full path.");
  return resolve(text);
}
/**
 * Q104: the ref is sent to the same name on the server, written out (`ref:ref`), as the pull-request push does.
 * A bare ref lets Git pick where it lands: a branch that is an alias of main (a symbolic ref) lands on main, and
 * so does a `remote.<name>.push` mapping, neither of which the main/master question sees.
 */
const sendsTo = (ref: string, commit?: string): string => `${commit ?? ref}:${ref}`;
/** Q109: what the self-development guard walked for this push, when it ran (in Branch's own source). */
export interface Walked { ref?: string | undefined; commit?: string | undefined }
const notes = (outcome: GitOutcome): string => `${outcome.stdout}\n${outcome.stderr}`.trim().slice(0, 2000);

/**
 * Q12: a diff or log never hands a file to a program a repository names (an external diff tool or a
 * textconv filter); the change is shown as Git itself reads it. See pinnedGitConfig in git-run.ts.
 */
const noPrograms = ["--no-ext-diff", "--no-textconv"] as const;

/** Every plan branch is named the same way, so one can never be mistaken for the owner's own. */
export const planBranch = (name: string): string => `plan/${name}`;

/** Git's two-letter status code in words. */
export function describeState(code: string): string {
  if (code.startsWith("??")) return "new";
  if (/U/.test(code) || code === "DD" || code === "AA") return "unmerged";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "changed";
}
