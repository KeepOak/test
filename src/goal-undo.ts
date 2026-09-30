import { rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { GoalMode, GoalState } from "./goal-mode.js";
import type { WorkspaceFiles } from "./files.js";
import type { WorkspaceHistory } from "./workspace-history.js";
import type { MemoryRecord } from "./memory.js";
import { forgetFactCopies, learnedOnlyFrom } from "./conversation-residue.js";

/**
 * Undoing a goal (pass 17, the prototype's "Undo this goal"): everything the goal did in its conversation, put back in one
 * step, while the conversation itself stays.
 *
 * - Its rounds stay in the history.
 * - Each file its rounds changed with Branch's own file tools goes back to how it was before the goal first changed it
 *   (a file the goal made is removed). A copy of the files as they are now is kept first.
 * - Each draft its rounds wrote in the owner's Gmail or Outlook is deleted there, only while it is still a draft: one the
 *   owner has already sent, or deleted, is left alone and said to be.
 * - Each fact memory learned only from its rounds is forgotten through the memory service (the outside one too, when it is
 *   switched on), and its kept wordings, archived copies and memory-checkpoint copies go with it, so putting a checkpoint
 *   back cannot bring it back. A fact the owner edited since, or one another task also taught, stays.
 *
 * Only a goal that recorded its rounds can be undone: guessing which tasks were its rounds could forget the wrong facts.
 */
export type DraftOutcome = "deleted" | "gone" | "sent";
export type DraftDeleter = (id: string) => Promise<DraftOutcome>;
export interface GoalUndoMemory {
  list(owner: string): Promise<MemoryRecord[]>;
  forget(owner: string, id: string): Promise<boolean>;
}
export interface GoalUndoDeps {
  db: DatabaseSync;
  owner: string;
  goals: Pick<GoalMode, "status" | "stop" | "settled" | "forget">;
  history: Pick<WorkspaceHistory, "restore" | "checkpoint">;
  files: Pick<WorkspaceFiles, "checked">;
  memory: GoalUndoMemory;
  /** Deletes one draft, by the tool that wrote it; a tool with no deleter here (its service switched off) is reported. */
  drafts: Record<string, DraftDeleter | undefined>;
}

export interface GoalUndoFile { path: string; round: number; existed: boolean }
export interface GoalUndoDraft { tool: string; id: string; to: string[]; subject: string; round: number }
export interface GoalUndoFact { id: string; text: string }
export interface GoalUndoPreview { rounds: number; files: GoalUndoFile[]; drafts: GoalUndoDraft[]; facts: GoalUndoFact[] }
export interface GoalUndoOutcome {
  rounds: number;
  files: (GoalUndoFile & { outcome: "put back" | "removed" })[];
  drafts: (GoalUndoDraft & { outcome: DraftOutcome | "failed"; reason?: string })[];
  facts: (GoalUndoFact & { outcome: "forgotten" | "failed"; reason?: string })[];
}

const draftTools = ["gmail.draft", "outlook.draft"];
const notForgotten = "The memory service did not forget this fact, so it is still kept.";
const noRounds = "This goal was started before Branch kept which tasks were its rounds, so it cannot be undone in one step.";
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export class GoalUndo {
  constructor(private readonly deps: GoalUndoDeps) {}

  /** What undoing the goal in this conversation would put back, from the engine's own records. */
  async preview(sessionId: string): Promise<GoalUndoPreview> {
    const runs = this.rounds(sessionId);
    return { rounds: runs.length, files: this.changedFiles(runs).map(({ versionId: _v, ...file }) => file), drafts: this.draftsOf(runs),
      facts: (await this.factsOf(runs)).map(({ record: _r, ...fact }) => fact) };
  }

  /** Stops the goal if it is still working, then puts back its files, deletes its drafts and forgets its facts. */
  async undo(sessionId: string): Promise<GoalUndoOutcome> {
    const runs = this.rounds(sessionId);
    const goal = this.deps.goals.status(sessionId)!;
    if (goal.status === "working" || goal.status === "paused") this.deps.goals.stop(sessionId);
    await this.deps.goals.settled(sessionId);
    this.requireIdle(sessionId);
    const files = await this.putBackFiles(sessionId, runs);
    const drafts = await this.deleteDrafts(runs);
    const facts = await this.forgetFacts(runs);
    // Keep the recorded rounds when an outside service could not undo its work, so the owner can retry.
    if (![...drafts, ...facts].some((item) => item.outcome === "failed")) this.deps.goals.forget(sessionId);
    return { rounds: runs.length, files, drafts, facts };
  }

  private rounds(sessionId: string): string[] {
    const goal: GoalState | null = this.deps.goals.status(sessionId);
    if (!goal) throw new Error("There is no goal in this conversation.");
    if (!goal.runIds?.length) throw new Error(noRounds);
    // Only this conversation's own tasks count, whatever the saved goal says.
    const own = new Set(this.deps.db.prepare("SELECT id FROM tasks WHERE session_id=?").all(sessionId).map((row) => String(row.id)));
    return goal.runIds.filter((id) => own.has(id));
  }
  private roundOf(runs: string[], runId: string): number { return runs.indexOf(runId) + 1; }

  /** The earliest copy kept before each file the rounds wrote, in the workspace's own folder (not a Trunk's). */
  private changedFiles(runs: string[]): (GoalUndoFile & { versionId: string })[] {
    const rows = this.deps.db.prepare(`SELECT id, path, existed, run_id FROM file_versions WHERE owner=? AND reason='before write'
      AND COALESCE(scope,'')='' AND run_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`).all(this.deps.owner, JSON.stringify(runs));
    const earliest = new Map<string, GoalUndoFile & { versionId: string }>();
    for (const row of rows) {
      const path = String(row.path);
      if (!earliest.has(path)) earliest.set(path, { path, round: this.roundOf(runs, String(row.run_id)), existed: Number(row.existed) === 1, versionId: String(row.id) });
    }
    return [...earliest.values()];
  }

  /** Each draft a round wrote, from the tool's own finished record (its id, and who it was to). */
  private draftsOf(runs: string[]): GoalUndoDraft[] {
    const rows = this.deps.db.prepare(`SELECT run_id, data FROM events WHERE kind='tool.completed' AND json_valid(data)
      AND json_extract(data,'$.name') IN (SELECT value FROM json_each(?)) AND run_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .all(JSON.stringify(draftTools), JSON.stringify(runs));
    const drafts: GoalUndoDraft[] = [];
    for (const row of rows) {
      const data = JSON.parse(String(row.data)) as { name?: unknown; result?: { draftId?: unknown; to?: unknown; subject?: unknown } };
      const id = text(data.result?.draftId);
      if (!id) continue;
      const to = Array.isArray(data.result?.to) ? data.result.to.map(text).filter(Boolean) : [];
      drafts.push({ tool: text(data.name), id, to, subject: text(data.result?.subject), round: this.roundOf(runs, String(row.run_id)) });
    }
    return drafts;
  }

  /** Facts learned only from the rounds (an owner's edit or another task's teaching keeps a fact). */
  private async factsOf(runs: string[]): Promise<(GoalUndoFact & { record: MemoryRecord })[]> {
    const set = new Set(runs);
    return (await this.deps.memory.list(this.deps.owner))
      .filter((record) => learnedOnlyFrom(set, record.data as { sourceRunId?: unknown; originRunId?: unknown }))
      .map((record) => ({ id: record.id, text: text(record.data.text), record }));
  }

  private async putBackFiles(sessionId: string, runs: string[]): Promise<GoalUndoOutcome["files"]> {
    const files = this.changedFiles(runs);
    if (!files.length) return [];
    // The files as they are now are kept first, so this too can be taken back from the file history.
    await this.deps.history.checkpoint(sessionId, "Before undoing a goal").catch(() => null);
    const done: GoalUndoOutcome["files"] = [];
    for (const { versionId, ...file } of files) {
      if (file.existed) { await this.deps.history.restore(versionId, { anyScope: true }); done.push({ ...file, outcome: "put back" }); continue; }
      await rm(await this.deps.files.checked(file.path), { force: true });
      done.push({ ...file, outcome: "removed" });
    }
    return done;
  }

  private async deleteDrafts(runs: string[]): Promise<GoalUndoOutcome["drafts"]> {
    const done: GoalUndoOutcome["drafts"] = [];
    for (const draft of this.draftsOf(runs)) {
      const remove = this.deps.drafts[draft.tool];
      if (!remove) { done.push({ ...draft, outcome: "failed", reason: `${draft.tool === "gmail.draft" ? "Google" : "Microsoft"} is not connected now, so the draft was left there.` }); continue; }
      try { done.push({ ...draft, outcome: await remove(draft.id) }); }
      catch (error) { done.push({ ...draft, outcome: "failed", reason: String((error as Error)?.message ?? error).slice(0, 300) }); }
    }
    return done;
  }

  private async forgetFacts(runs: string[]): Promise<GoalUndoOutcome["facts"]> {
    const done: GoalUndoOutcome["facts"] = [], gone: { id: string; owner: string }[] = [];
    for (const { record: _record, ...fact } of await this.factsOf(runs)) {
      try {
        // Forgotten only when the memory service says it forgot it; a service that answers no keeps it, and so does this.
        if (!await this.deps.memory.forget(this.deps.owner, fact.id)) { done.push({ ...fact, outcome: "failed", reason: notForgotten }); continue; }
        gone.push({ id: fact.id, owner: this.deps.owner });
        done.push({ ...fact, outcome: "forgotten" });
      } catch (error) { done.push({ ...fact, outcome: "failed", reason: String((error as Error)?.message ?? error).slice(0, 300) }); }
    }
    const db = this.deps.db;
    db.exec("BEGIN");
    const kept = done.filter((fact) => fact.outcome === "failed").map((fact) => ({ id: fact.id, owner: this.deps.owner }));
    try { forgetFactCopies(db, runs, gone, kept); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
    return done;
  }

  /** Nothing is put back underneath a task that is still working in this conversation. */
  private requireIdle(sessionId: string): void {
    if (this.deps.db.prepare("SELECT id FROM tasks WHERE session_id=? AND status IN ('running','needs_input')").get(sessionId))
      throw new Error("Wait for the task that is still working in this conversation, or stop it, first.");
  }
}

/** The HTTP side: `GET /api/sessions/<id>/goal/undo` previews it; `POST` does it. */
export async function goalUndoApi(undo: GoalUndo, owns: (sessionId: string) => boolean, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  const match = /^\/api\/sessions\/([a-f0-9-]{36})\/goal\/undo$/.exec(path);
  if (!match) return undefined;
  const id = match[1]!;
  if (!owns(id)) throw new Error("Conversation not found");
  if (method === "GET") return undo.preview(id);
  if (method !== "POST") return undefined;
  z.object({}).strict().parse(await body());
  return undo.undo(id);
}
