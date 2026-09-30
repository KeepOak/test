import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { GitRun } from "../git-checkpoint.js";
import { WORKTREE_HOME } from "../integrations/git.js";
import type { Store } from "../store.js";
import { codingOn, partSettings, requireCoding } from "./settings.js";

/**
 * R17-036: a conversation forked into its own copy of the project (a Git worktree), and, when the
 * owner asks for it, a copy of its own for each helper a task hands work to. The copies live where
 * every parallel copy already lives (`.branch-worktrees`, src/integrations/git.ts), are made with the
 * owner's own Git (hooks off, never asking for a password), and a helper's copy is removed afterwards
 * only when it provably holds nothing: no commits of its own and no unsaved change. Otherwise it is
 * kept and the task's record says where. The per-helper idea and the "remove only on proof" rule are
 * Hermes's (`tools/subagent_worktree.py`, MIT); this is written for Branch.
 *
 * While a task works in a copy, its file tools resolve inside that copy (the scope below, read by the
 * workspace's `scope` in src/index.ts) and its commands start there (`context.workspace`).
 */
const place = new AsyncLocalStorage<string>();
/** The copy the current task works in, as a folder relative to the workspace, or undefined. */
export const worktreeScope = (): string | undefined => place.getStore();
export const inWorktree = <T>(scope: string, work: () => Promise<T>): Promise<T> => place.run(scope, work);

export const WorktreeSettingsSchema = z.object({
  /** Give each helper a task hands work to a copy of its own. */
  perHelper: z.boolean().default(false),
}).strict();
const ForksSchema = z.object({
  forks: z.array(z.object({ sessionId: z.string().uuid(), name: z.string(), branch: z.string(), folder: z.string(), createdAt: z.string() }).strict()).max(200).default([]),
}).strict();
const forksKey = "coding-worktree-forks";

export interface TaskPlace { scope: string; workspace: string; release(): Promise<void> }
export interface WorktreeGit {
  worktree(input: { folder: string; action: "add" | "remove"; name: string; branch?: string }, signal: AbortSignal): Promise<unknown>;
}
export interface WorktreeDeps {
  store: Store; owner: string; root: string;
  /** The active project's folder inside the workspace ("" for the whole workspace). */
  projectFolder: () => string;
  git: WorktreeGit; run: GitRun;
  branchSession: (owner: string, input: { sessionId: string; messageId: number }) => Promise<{ sessionId: string }>;
  note: (runId: string, kind: string, data: Record<string, unknown>) => void;
}

const short = (id: string): string => id.replace(/-/g, "").slice(0, 8);

export class WorktreePlaces {
  /** Sources held by live helpers, including copies that are still being created. */
  private readonly helperSources = new Map<string, string>();
  /** Prevents new descendants while this instance is removing their parent copy. */
  private readonly removing = new Set<string>();
  private requireAvailableSource(scope: string): void {
    if ([...this.removing].some((parent) => scope === parent || scope.startsWith(`${parent}/`)))
      throw new Error("The assigned project copy is being removed, so a nested copy could not be started.");
  }
  constructor(private readonly deps: WorktreeDeps) {}

  private scopeFor(folder: string, name: string): string {
    return posix.join(folder, WORKTREE_HOME, name).replace(/^\.\//, "");
  }
  forks() {
    const saved = ForksSchema.safeParse(this.deps.store.get("settings", this.deps.owner, forksKey)?.data ?? {});
    return saved.success ? saved.data.forks : [];
  }
  private saveForks(forks: z.infer<typeof ForksSchema>["forks"]): void {
    this.deps.store.save("settings", this.deps.owner, forksKey, { forks: forks.slice(-200) });
  }

  /** Forks a conversation at a message into a new one that works in its own copy of the project. */
  async fork(input: { sessionId: string; messageId: number }, signal: AbortSignal) {
    const { store, owner } = this.deps;
    requireCoding(store, owner, "worktrees");
    if (worktreeScope()) throw new Error("This conversation already works in a copy of the project.");
    const folder = this.deps.projectFolder();
    this.requireAvailableSource(folder);
    const pending = `fork:${input.sessionId}`;
    if (this.helperSources.has(pending)) throw new Error("A project copy is already being created for this conversation.");
    this.helperSources.set(pending, folder);
    try {
      const branched = await this.deps.branchSession(owner, input);
      this.requireAvailableSource(folder);
      const name = `fork-${short(branched.sessionId)}`, branch = `branch/fork-${short(branched.sessionId)}`;
      await inWorktree(folder, () => this.deps.git.worktree({ folder: ".", action: "add", name, branch }, signal));
      const fork = { sessionId: branched.sessionId, name, branch, folder, createdAt: new Date().toISOString() };
      this.saveForks([...this.forks(), fork]);
      return { ...fork, path: this.scopeFor(fork.folder, name) };
    } finally { this.helperSources.delete(pending); }
  }

  /** Forgets a fork and removes its copy, only when the copy holds no unsaved change (its line of work is kept). */
  async remove(sessionId: string, signal: AbortSignal) {
    const fork = this.forks().find((entry) => entry.sessionId === sessionId);
    if (!fork) throw new Error("That conversation has no copy of its own.");
    // The Git helper removes with --force, so unsaved work is looked for here first and kept.
    const scope = this.scopeFor(fork.folder, fork.name), copy = join(this.deps.root, scope);
    const keepChildren = async () => {
      if (await this.hasChildren(scope, copy))
        throw new Error("That copy holds active or retained nested copies, so it was kept. Finish or remove those copies first.");
    };
    this.requireAvailableSource(scope);
    this.removing.add(scope);
    try {
      await keepChildren();
      if (existsSync(copy)) {
        const dirty = await this.deps.run(copy, ["status", "--porcelain"], signal).catch(() => null);
        if (dirty?.status !== "completed" || dirty.exitCode !== 0 || dirty.stdout.trim())
          throw new Error("That copy holds changes that are not saved yet, so it was kept. Save or undo them first.");
      }
      await keepChildren();
      await inWorktree(fork.folder, () => this.deps.git.worktree({ folder: ".", action: "remove", name: fork.name }, signal));
      this.saveForks(this.forks().filter((entry) => entry.sessionId !== sessionId));
      return { removed: fork.name };
    } finally { this.removing.delete(scope); }
  }

  /** Where this task works: its conversation's copy, a new copy for a helper, or null for the usual place. */
  async placeTask(run: { id: string; sessionId: string }, context: ToolContext, parent: ToolContext | undefined): Promise<TaskPlace | null> {
    const { store, owner } = this.deps;
    if (!parent) {
      const recovered = await this.recoverHelper(run, context);
      if (recovered) return recovered;
    }
    const assigned = worktreeScope() ?? this.deps.projectFolder();
    if (assigned.split(/[\\/]/).includes(WORKTREE_HOME) && !existsSync(join(this.deps.root, assigned))) {
      this.deps.note(run.id, "worktree.missing", { path: assigned });
      throw new Error("The assigned project copy is missing, so this task stopped before working in another folder.");
    }
    if (worktreeScope() && !parent) return null;
    // workbench (SELF-302): a helper its lead asked to give a copy of its own gets one, whatever the switches say: the
    // switches decide what happens by default (it ships off, a whole copy on disk each time), the lead decides per helper.
    if (parent && context.ownCopy) return this.helperPlace(run, context);
    if (!codingOn(store, owner, "worktrees")) {
      if (!parent && this.forks().some((fork) => fork.sessionId === run.sessionId))
        throw new Error("This conversation is assigned to a project copy, but project copies are switched off. Enable them before continuing this conversation.");
      return null;
    }
    if (!parent) return this.forkPlace(run);
    if (!partSettings(store, owner, "worktrees", WorktreeSettingsSchema).perHelper) return null;
    return this.helperPlace(run, context);
  }

  /** Reattaches only a helper copy recorded by this conversation's exact continuation lineage. */
  private async recoverHelper(run: { id: string; sessionId: string }, context: ToolContext): Promise<TaskPlace | null> {
    const current = this.deps.store.run(run.id);
    if (!current) throw new Error("The task's saved workspace record is unavailable.");
    const pending = [run.id], seen = new Set<string>();
    const placements: { runId: string; data: Record<string, unknown> }[] = [];
    const removed = new Set<string>();
    let required = false, resumed = false, continuing = false;
    const unavailable = () => new Error("The helper's recorded project copy could not be safely restored. It was not started in another folder.");
    while (pending.length) {
      if (seen.size >= 200) throw unavailable();
      const id = pending.pop()!;
      if (seen.has(id)) throw unavailable();
      seen.add(id);
      const saved = this.deps.store.run(id);
      if (!saved || saved.owner !== current.owner || saved.sessionId !== current.sessionId || saved.project !== current.project) throw unavailable();
      const events = this.deps.store.events(id);
      const starts = events.filter((event) => event.kind === "run.started");
      if (starts.length !== 1) throw unavailable();
      const start = starts[0]!.data;
      if (id === run.id) continuing = events.some((event) => event.kind === "run.continued");
      required ||= start.ownCopy === true;
      for (const event of events) {
        if (event.kind === "worktree.used" && ("source" in event.data || (typeof event.data.branch === "string" && event.data.branch.startsWith("branch/helper-"))))
          placements.push({ runId: id, data: event.data });
        if (event.kind === "worktree.removed" && typeof event.data.path === "string") removed.add(event.data.path);
      }
      const links = [start.resumedFrom, start.originFrom].filter((value): value is string => typeof value === "string");
      const eligible: string[] = [];
      for (const from of links) {
        const prior = this.deps.store.run(from);
        // originFrom can mark a lead woken by a different helper: that is provenance, not a copy assignment.
        if (prior && prior.owner === current.owner && prior.sessionId === current.sessionId && prior.project === current.project) eligible.push(from);
        else if (from === start.resumedFrom) throw unavailable();
      }
      const next = [...new Set(eligible)];
      if (next.length > 1) throw unavailable();
      if (next.length) { resumed = true; pending.push(next[0]!); }
    }
    if (!placements.length) {
      if (required && (resumed || continuing)) throw unavailable();
      return null;
    }
    if (!required && !codingOn(this.deps.store, this.deps.owner, "worktrees")) throw unavailable();
    const first = placements[0]!, data = first.data;
    const origin = typeof data.originRunId === "string" ? data.originRunId : first.runId;
    if (!seen.has(origin) || typeof data.path !== "string" || typeof data.source !== "string" || typeof data.branch !== "string"
      || typeof data.base !== "string" || !/^[a-f0-9]{40,64}$/i.test(data.base)) throw unavailable();
    const name = `helper-${short(origin)}`, branch = `branch/helper-${short(origin)}`;
    const folder = data.source, scope = data.path;
    if (removed.has(scope)) throw unavailable();
    if (folder.includes("\\") || isAbsolute(folder) || folder.split("/").some((part) => part === ".." || part === ".")
      || scope !== this.scopeFor(folder, name) || data.branch !== branch) throw unavailable();
    for (const prior of placements) {
      const identity = prior.data;
      if (identity.path !== scope || identity.source !== folder || identity.branch !== branch || identity.base !== data.base
        || (typeof identity.originRunId === "string" ? identity.originRunId : prior.runId) !== origin) throw unavailable();
    }
    this.requireAvailableSource(scope);
    this.helperSources.set(run.id, scope);
    try {
      const workspace = resolve(this.deps.root, scope), cwd = resolve(this.deps.root, folder);
      const samePath = (left: string, right: string) => process.platform === "win32"
        ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
      const root = await realpath(this.deps.root);
      const actual = await realpath(workspace).catch(() => null);
      const source = await realpath(cwd).catch(() => null);
      const contained = (path: string) => {
        const inside = relative(root, path);
        return inside !== "" && !isAbsolute(inside) && !inside.split(/[\\/]/).includes("..");
      };
      let expectedSource = cwd, expectedCopy = workspace;
      // Source preparation publishes this exact managed root through an in-workspace directory link.
      // Resolve only that root; nested redirects still have to equal the recorded physical suffix.
      if (scope.startsWith("branch-agent-source/.branch-worktrees/")
        && (folder === "branch-agent-source" || folder.startsWith("branch-agent-source/.branch-worktrees/"))) {
        const logicalRoot = resolve(this.deps.root, "branch-agent-source");
        const managedRoot = await realpath(logicalRoot).catch(() => null);
        if (!managedRoot || !contained(managedRoot)) throw unavailable();
        const managedTop = await this.deps.run(logicalRoot, ["rev-parse", "--show-toplevel"], context.signal).catch(() => null);
        const managedActual = managedTop?.status === "completed" && managedTop.exitCode === 0 && managedTop.stdout.trim()
          ? await realpath(resolve(managedTop.stdout.trim())).catch(() => null) : null;
        if (!managedActual || !samePath(managedActual, managedRoot)) throw unavailable();
        expectedSource = resolve(managedRoot, relative(logicalRoot, cwd));
        expectedCopy = resolve(managedRoot, relative(logicalRoot, workspace));
      }
      if (!actual || !source || !contained(actual) || (source !== root && !contained(source))
        || !samePath(actual, expectedCopy) || !samePath(source, expectedSource)) throw unavailable();
      const top = await this.deps.run(workspace, ["rev-parse", "--show-toplevel"], context.signal).catch(() => null);
      const line = await this.deps.run(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"], context.signal).catch(() => null);
      const ancestor = await this.deps.run(workspace, ["merge-base", "--is-ancestor", data.base, "HEAD"], context.signal).catch(() => null);
      const copyActual = top?.status === "completed" && top.exitCode === 0 && top.stdout.trim()
        ? await realpath(resolve(top.stdout.trim())).catch(() => null) : null;
      if (!copyActual || !samePath(copyActual, actual)
        || line?.status !== "completed" || line.exitCode !== 0 || line.stdout.trim() !== branch
        || ancestor?.status !== "completed" || ancestor.exitCode !== 0) throw unavailable();
      const sourceTop = await this.deps.run(cwd, ["rev-parse", "--show-toplevel"], context.signal).catch(() => null);
      const sourceActual = sourceTop?.status === "completed" && sourceTop.exitCode === 0 && sourceTop.stdout.trim()
        ? await realpath(resolve(sourceTop.stdout.trim())).catch(() => null) : null;
      if (!sourceActual || !samePath(sourceActual, source)) throw unavailable();
      const copyCommon = await this.deps.run(workspace, ["rev-parse", "--git-common-dir"], context.signal).catch(() => null);
      const sourceCommon = await this.deps.run(cwd, ["rev-parse", "--git-common-dir"], context.signal).catch(() => null);
      const copyGit = copyCommon?.status === "completed" && copyCommon.exitCode === 0 && copyCommon.stdout.trim()
        ? await realpath(resolve(workspace, copyCommon.stdout.trim())).catch(() => null) : null;
      const sourceGit = sourceCommon?.status === "completed" && sourceCommon.exitCode === 0 && sourceCommon.stdout.trim()
        ? await realpath(resolve(cwd, sourceCommon.stdout.trim())).catch(() => null) : null;
      if (!copyGit || !sourceGit || !samePath(copyGit, sourceGit)) throw unavailable();
      this.deps.note(run.id, "worktree.used", { path: scope, branch, source: folder, base: data.base, originRunId: origin, recovered: true });
      // Keep a restored copy: its original retained work belongs to the original helper's record.
      return { scope, workspace, release: async () => { this.helperSources.delete(run.id); } };
    } catch (error) { this.helperSources.delete(run.id); context.signal.throwIfAborted(); throw error; }
  }

  private forkPlace(run: { id: string; sessionId: string }): TaskPlace | null {
    const fork = this.forks().find((entry) => entry.sessionId === run.sessionId);
    if (!fork) return null;
    const scope = this.scopeFor(fork.folder, fork.name), workspace = join(this.deps.root, scope);
    if (!existsSync(workspace)) {
      this.deps.note(run.id, "worktree.missing", { path: scope });
      throw new Error("This conversation’s project copy is missing, so this task stopped before working in the original project.");
    }
    this.deps.note(run.id, "worktree.used", { path: scope, branch: fork.branch });
    return { scope, workspace, release: async () => undefined };
  }

  private async helperPlace(run: { id: string }, context: ToolContext): Promise<TaskPlace | null> {
    const folder = worktreeScope() ?? this.deps.projectFolder();
    this.requireAvailableSource(folder);
    this.helperSources.set(run.id, folder);
    let placed = false;
    try {
      const copy = await this.createHelper(run, context, folder);
      placed = copy !== null;
      return copy;
    } finally { if (!placed) this.helperSources.delete(run.id); }
  }

  private async createHelper(run: { id: string }, context: ToolContext, folder: string): Promise<TaskPlace | null> {
    const cwd = join(this.deps.root, folder);
    const head = await this.deps.run(cwd, ["rev-parse", "HEAD"], context.signal).catch(() => null);
    if (!head || head.status !== "completed" || head.exitCode !== 0 || !head.stdout.trim()) {
      context.signal.throwIfAborted();
      const reason = "The helper needs a separate project copy, but the project has no readable Git commit. The helper was not started in the shared project.";
      this.deps.note(run.id, "worktree.failed", { reason });
      throw new Error(reason);
    }
    const name = `helper-${short(run.id)}`, branch = `branch/helper-${short(run.id)}`;
    try { await inWorktree(folder, () => this.deps.git.worktree({ folder: ".", action: "add", name, branch }, context.signal)); }
    catch {
      context.signal.throwIfAborted();
      const reason = "The helper’s separate project copy could not be created, so the helper was not started in the shared project.";
      this.deps.note(run.id, "worktree.failed", { reason });
      throw new Error(reason);
    }
    const scope = this.scopeFor(folder, name), workspace = join(this.deps.root, scope), base = head.stdout.trim();
    if (!existsSync(workspace)) {
      this.deps.note(run.id, "worktree.missing", { path: scope });
      throw new Error("The helper’s assigned project copy is missing after creation, so the helper was not started in the shared project.");
    }
    this.deps.note(run.id, "worktree.used", { path: scope, branch, source: folder, base });
    return { scope, workspace, release: async () => {
      try { await this.releaseHelper(run.id, { cwd, workspace, name, branch, base, scope, folder }); }
      finally { this.helperSources.delete(run.id); }
    } };
  }

  private async hasChildren(scope: string, workspace: string): Promise<boolean> {
    const liveChildren = () => [...this.helperSources.values()].some((source) => source === scope || source.startsWith(`${scope}/`));
    if (liveChildren()) return true;
    const children = await readdir(join(workspace, WORKTREE_HOME)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : null);
    // A kept nested copy may be ignored by Git; retain the parent even if its Git status is clean.
    return children === null || children.length > 0 || liveChildren();
  }

  /** Removes a helper's copy only on proof that it holds nothing; otherwise keeps it and says where. */
  private async releaseHelper(runId: string, copy: { cwd: string; workspace: string; name: string; branch: string; base: string; scope: string; folder: string }): Promise<void> {
    const signal = AbortSignal.timeout(60_000);
    if ([...this.removing].some((parent) => copy.scope === parent || copy.scope.startsWith(`${parent}/`))) {
      this.deps.note(runId, "worktree.kept", { path: copy.scope, branch: copy.branch, reason: "parent-removal" }); return;
    }
    this.removing.add(copy.scope);
    try {
      if (await this.hasChildren(copy.scope, copy.workspace)) {
        this.deps.note(runId, "worktree.kept", { path: copy.scope, branch: copy.branch, reason: "nested-copies" }); return;
      }
      const dirty = await this.deps.run(copy.workspace, ["status", "--porcelain"], signal).catch(() => null);
      const ahead = await this.deps.run(copy.workspace, ["rev-list", "--count", `${copy.base}..HEAD`], signal).catch(() => null);
      const proven = dirty?.status === "completed" && dirty.exitCode === 0 && !dirty.stdout.trim()
        && ahead?.status === "completed" && ahead.exitCode === 0 && ahead.stdout.trim() === "0";
      if (!proven) { this.deps.note(runId, "worktree.kept", { path: copy.scope, branch: copy.branch }); return; }
      if (await this.hasChildren(copy.scope, copy.workspace)) {
        this.deps.note(runId, "worktree.kept", { path: copy.scope, branch: copy.branch, reason: "nested-copies" }); return;
      }
      const removed = await inWorktree(copy.folder, () => this.deps.git.worktree({ folder: ".", action: "remove", name: copy.name }, signal)).catch(() => null);
      if (!removed) { this.deps.note(runId, "worktree.kept", { path: copy.scope, branch: copy.branch, reason: "removal-failed" }); return; }
      await this.deps.run(copy.cwd, ["branch", "-D", copy.branch], signal).catch(() => undefined);
      this.deps.note(runId, "worktree.removed", { path: copy.scope });
    } finally { this.removing.delete(copy.scope); }
  }
}
