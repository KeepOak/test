import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { GitRun } from "../git-checkpoint.js";
import { WORKTREE_HOME } from "../integrations/git.js";
import type { Store } from "../store.js";
import { codingOn, partSettings, requireCoding } from "./settings.js";

/**
 * R17-036: a copy of its own (a Git worktree) for each helper a task hands work to, by default (the owner's ruling,
 * 2026-09-30), and, only when the owner switches `forks` on, a conversation forked into its own copy. The copies live where
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
  /** Give each helper a task hands work to a copy of its own (on: the owner's ruling, 2026-09-30). */
  perHelper: z.boolean().default(true),
  /** Let a conversation be forked into a copy of its own. Off: each fork keeps a whole copy on disk for as long as it lives. */
  forks: z.boolean().default(false),
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
    if (!partSettings(store, owner, "worktrees", WorktreeSettingsSchema).forks)
      throw new Error("Forking a conversation into its own copy of the project is off, because each fork keeps a whole copy on disk. The owner can switch it on (coding worktrees: forks).");
    if (worktreeScope()) throw new Error("This conversation already works in a copy of the project.");
    const branched = await this.deps.branchSession(owner, input);
    const name = `fork-${short(branched.sessionId)}`, branch = `branch/fork-${short(branched.sessionId)}`;
    await this.deps.git.worktree({ folder: ".", action: "add", name, branch }, signal);
    const fork = { sessionId: branched.sessionId, name, branch, folder: this.deps.projectFolder(), createdAt: new Date().toISOString() };
    this.saveForks([...this.forks(), fork]);
    return { ...fork, path: this.scopeFor(fork.folder, name) };
  }

  /** Forgets a fork and removes its copy, only when the copy holds no unsaved change (its line of work is kept). */
  async remove(sessionId: string, signal: AbortSignal) {
    const fork = this.forks().find((entry) => entry.sessionId === sessionId);
    if (!fork) throw new Error("That conversation has no copy of its own.");
    // The Git helper removes with --force, so unsaved work is looked for here first and kept.
    const copy = join(this.deps.root, this.scopeFor(fork.folder, fork.name));
    if (existsSync(copy)) {
      const dirty = await this.deps.run(copy, ["status", "--porcelain"], signal).catch(() => null);
      if (dirty?.status !== "completed" || dirty.exitCode !== 0 || dirty.stdout.trim())
        throw new Error("That copy holds changes that are not saved yet, so it was kept. Save or undo them first.");
    }
    await this.deps.git.worktree({ folder: ".", action: "remove", name: fork.name }, signal);
    this.saveForks(this.forks().filter((entry) => entry.sessionId !== sessionId));
    return { removed: fork.name };
  }

  /** Where this task works: its conversation's copy, a new copy for a helper, or null for the usual place. */
  async placeTask(run: { id: string; sessionId: string }, context: ToolContext, parent: ToolContext | undefined): Promise<TaskPlace | null> {
    const { store, owner } = this.deps;
    if (worktreeScope()) return null;
    // workbench (SELF-302): a helper its lead asked to give a copy of its own gets one, whatever the switches say: the
    // switches decide what happens by default; the lead can explicitly request a copy for one helper.
    if (parent && context.ownCopy) return this.helperPlace(run, context);
    if (!codingOn(store, owner, "worktrees")) return null;
    if (!parent) return this.forkPlace(run);
    if (!partSettings(store, owner, "worktrees", WorktreeSettingsSchema).perHelper) return null;
    return this.helperPlace(run, context);
  }

  private forkPlace(run: { id: string; sessionId: string }): TaskPlace | null {
    const fork = this.forks().find((entry) => entry.sessionId === run.sessionId);
    if (!fork) return null;
    const scope = this.scopeFor(fork.folder, fork.name), workspace = join(this.deps.root, scope);
    if (!existsSync(workspace)) {
      this.deps.note(run.id, "worktree.missing", { path: scope });
      return null;
    }
    this.deps.note(run.id, "worktree.used", { path: scope, branch: fork.branch });
    return { scope, workspace, release: async () => undefined };
  }

  private async helperPlace(run: { id: string }, context: ToolContext): Promise<TaskPlace | null> {
    const folder = this.deps.projectFolder(), cwd = join(this.deps.root, folder);
    const head = await this.deps.run(cwd, ["rev-parse", "HEAD"], context.signal).catch(() => null);
    if (!head || head.status !== "completed" || head.exitCode !== 0) {
      // A copy asked for by name is never skipped without a word: the helper then works in the usual place.
      if (context.ownCopy) this.deps.note(run.id, "worktree.skipped", { reason: "The project is not a git repository with a commit, so there is nothing to copy." });
      return null;
    }
    const name = `helper-${short(run.id)}`, branch = `branch/helper-${short(run.id)}`;
    try { await this.deps.git.worktree({ folder: ".", action: "add", name, branch }, context.signal); }
    catch (error) { this.deps.note(run.id, "worktree.skipped", { reason: String((error as Error).message).slice(0, 200) }); return null; }
    const scope = this.scopeFor(folder, name), workspace = join(this.deps.root, scope), base = head.stdout.trim();
    this.deps.note(run.id, "worktree.used", { path: scope, branch });
    return { scope, workspace, release: () => this.releaseHelper(run.id, { cwd, workspace, name, branch, base, scope }) };
  }

  /** Removes a helper's copy only on proof that it holds nothing; otherwise keeps it and says where. */
  private async releaseHelper(runId: string, copy: { cwd: string; workspace: string; name: string; branch: string; base: string; scope: string }): Promise<void> {
    const signal = AbortSignal.timeout(60_000);
    const dirty = await this.deps.run(copy.workspace, ["status", "--porcelain"], signal).catch(() => null);
    const ahead = await this.deps.run(copy.workspace, ["rev-list", "--count", `${copy.base}..HEAD`], signal).catch(() => null);
    const proven = dirty?.status === "completed" && dirty.exitCode === 0 && !dirty.stdout.trim()
      && ahead?.status === "completed" && ahead.exitCode === 0 && ahead.stdout.trim() === "0";
    if (!proven) { this.deps.note(runId, "worktree.kept", { path: copy.scope, branch: copy.branch }); return; }
    await this.deps.git.worktree({ folder: ".", action: "remove", name: copy.name }, signal).catch(() => undefined);
    await this.deps.run(copy.cwd, ["branch", "-D", copy.branch], signal).catch(() => undefined);
    this.deps.note(runId, "worktree.removed", { path: copy.scope });
  }
}
