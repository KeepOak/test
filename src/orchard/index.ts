import { z } from "zod";
import { errorText } from "../contracts.js";
import type { Run, RunStatus } from "../contracts.js";
import type { RunSource } from "../policy.js";
import type { Store } from "../store.js";
import {
  actorName, AssignSchema, BoardEditSchema, BoardInputSchema, CardEditSchema, CardInputSchema, CommentEditSchema, CommentRemoveSchema, CommentSchema, lanes, LinkSchema,
  MoveSchema, oneLine, outsideActors, type Actor, type Board, type Card, type Comment, type Lane,
} from "./model.js";
import { OrchardStore } from "./store.js";
import { taskInTree } from "./ancestry.js";

/** The parts of the runtime Orchard uses: starting a card's task, and what a Trunk may start now. */
export interface OrchardRuntime {
  run(options: { prompt: string; source: RunSource; title: string; trunkId?: string; conversationProject?: string;
    onStarted: (run: Run) => void; onTextDelta: () => void }): Promise<Run>;

  trunkPaused(id: string): string | null;
  trunkAtOnce(id: string): string | null;
}
export interface OrchardTrunk { id: string; name: string; handle: string }
export interface OrchardDeps {
  store: Store;
  owner: string;
  runtime: OrchardRuntime;
  /** The owner's Trunks now (src/trunks), read fresh each time. */
  trunks: () => OrchardTrunk[];
  /** Whether Orchard is switched on (the flows-and-boards "kanban" switch, src/flows-boards/settings.ts). */
  on: () => boolean;
  /** Whether Lockdown is on: nothing is pulled by itself while it is. */
  lockdown: () => boolean;
}

export interface BoardSummary extends Board { counts: Record<Lane, number> }
export interface OrchardView { board: Board | null; boards: BoardSummary[]; lanes: Record<Lane, Card[]> }

const emptyLanes = (): Record<Lane, Card[]> => Object.fromEntries(lanes.map((lane) => [lane, []])) as unknown as Record<Lane, Card[]>;
export const notOwnersWords = "Only the owner can do that on the board.";

/**
 * Orchard's rules (docs/orchard-canopy.md). The owner does anything. A Trunk, Branch's assistant or a chat may post a
 * card and comment; a card they post is not pulled until the owner says yes to it (assigns it, places it in seed, or
 * presses Grow). Only the owner picks a card, resets a stuck one, removes one, links, edits or assigns.
 *
 * Pulling ("the grower") starts a planted seed card whose earlier cards are all picked, within the board's "at once",
 * one card per Trunk at a time, never for a paused Trunk or one at its own limit, and never while Lockdown is on. What
 * it starts is the owner's own task (the owner posted the card or said yes to it), held to the owner's approval rules
 * exactly as they are, so a question it asks waits on the card to be answered. What becomes of the card is read
 * from the task's own record when it ends (store.onRunFinished), never from the promise, since a task that stops to ask
 * is carried on under the same id after the yes.
 */
export class Orchard {
  readonly data: OrchardStore;
  private readonly starting = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly stopListening: () => void;
  private readonly stopFollowing: () => void;

  constructor(private readonly deps: OrchardDeps) {
    this.data = new OrchardStore(deps.store, deps.owner);
    this.data.migrate((id) => deps.store.projects.list(deps.owner).find((p) => p.id === id)?.name ?? "");
    this.stopListening = deps.store.onRunFinished((runId, status) => this.finished(runId, status));
    // A paused task carried on (Resume) goes on under a new id that names the one it carries on; the card follows it.
    this.stopFollowing = deps.store.onEvent((runId, kind, data) => {
      if (kind === "run.started" && typeof data.resumedFrom === "string") this.carriedOn(data.resumedFrom, runId);
    });
    this.recover();
  }
  close(): void { this.stopListening(); this.stopFollowing(); }
  containsRun(rootId: string, runId: string): boolean { return taskInTree(this.deps.store, rootId, runId); }
  occupies(card: Card): boolean {
    if (card.lane === "growing") return true;
    const run = card.runId ? this.deps.store.run(card.runId) : undefined;
    return !!run && (run.status === "running" || run.status === "needs_input" || this.pausedByOwner(run.id));
  }
  private get store() { return this.deps.store; }
  private get owner() { return this.deps.owner; }

  /* ---------- reading ---------- */

  boards(): BoardSummary[] {
    const cards = this.data.cards();
    return this.data.boards().map((board) => ({ ...board,
      counts: Object.fromEntries(lanes.map((lane) => [lane, cards.filter((c) => c.board === board.id && c.lane === lane).length])) as Record<Lane, number> }));
  }
  view(boardId?: string): OrchardView {
    const boards = this.boards();
    const active = this.store.projects.active(this.owner).id;
    const board = boardId ? this.data.board(boardId) : boards.find((b) => b.project === active) ?? boards[0] ?? null;
    const byLane = emptyLanes();
    if (board) for (const card of this.data.cards(board.id)) byLane[card.lane]?.push(card);
    return { board: board ? this.data.board(board.id) : null, boards, lanes: byLane };
  }
  card(id: string): Card & { comments_: Comment[]; before: string[] } {
    const card = this.data.card(id);
    return { ...card, comments_: this.data.comments(id), before: this.data.children(id) };
  }

  /* ---------- boards (the owner's) ---------- */

  addBoard(input: unknown): Board {
    const value = BoardInputSchema.parse(input);
    return this.data.addBoard(this.project(value.project), value.name);
  }
  editBoard(id: string, input: unknown): Board {
    const board = this.data.editBoard(id, BoardEditSchema.parse(input));
    this.grow();
    return board;
  }
  removeBoard(id: string): { removed: true } { this.data.removeBoard(id); return { removed: true }; }

  /* ---------- cards ---------- */

  add(input: unknown, actor: Actor): Card {
    const value = CardInputSchema.parse(input);
    const board = value.board ? this.data.board(value.board) : this.defaultBoard();
    const assignee = value.assignee ? this.trunkId(value.assignee) : "";
    for (const parent of value.after) this.data.card(parent);
    const card = this.data.addCard({ board: board.id, title: value.title, notes: value.notes, assignee,
      planted: actor.kind === "owner", by: actorName(actor) });
    for (const parent of value.after) this.data.link(parent, card.id);
    this.grow();
    return this.data.card(card.id);
  }

  edit(id: string, input: unknown): Card {
    const change = CardEditSchema.parse(input);
    const card = this.data.card(id);
    return this.data.write(card, { ...(change.title ? { title: oneLine(change.title, 200) } : {}),
      ...(change.notes !== undefined ? { notes: change.notes } : {}) }, "owner", "Edited");
  }

  /** The owner moves a card. Into growing starts it now; seed plants it (the owner's yes); a stuck card is reset first. */
  async move(id: string, input: unknown): Promise<Card> {
    const { lane, note } = MoveSchema.parse(input);
    const card = this.data.card(id);
    if (lane === card.lane) return card;
    if (lane === "growing") return this.start(id);
    if (this.occupies(card)) throw new Error("This card's task is still active. Stop its task first.");
    if (card.stuck && lane !== "blocked" && lane !== "picked") throw new Error("This card was blocked after failing too often. Reset it first.");
    const moved = this.data.write(card, { lane, ...(lane === "seed" ? { planted: true } : {}) }, "owner",
      `Moved from ${card.lane} to ${lane}${note ? `: ${oneLine(note, 500)}` : ""}`);
    if (note) this.data.comment(id, "owner", oneLine(note, 2000));
    this.grow();
    return moved;
  }

  /** The owner gives a card to a Trunk (by id or @name), or to Branch's assistant with "". It counts as the owner's yes. */
  assign(id: string, input: unknown): Card {
    const { to } = AssignSchema.parse(input);
    const card = this.data.card(id);
    if (this.occupies(card)) throw new Error("This card's task is still active. Stop its task first.");
    const assignee = to ? this.trunkId(to) : "";
    const name = assignee ? this.deps.trunks().find((t) => t.id === assignee)?.name ?? assignee : "Branch";
    const moved = this.data.write(card, { assignee, planted: true }, "owner", `Given to ${name}`);
    this.grow();
    return moved;
  }

  link(child: string, input: unknown): Card {
    const { after } = LinkSchema.parse(input);
    this.data.card(after);
    const card = this.data.card(child);
    if (after === child || this.waitsOn(after, child)) throw new Error("That would make these cards wait on each other.");
    this.data.link(after, child);
    return this.data.write(card, {}, "owner", `Waits for "${this.data.card(after).title}"`);
  }
  unlink(child: string, input: unknown): Card {
    const { after } = LinkSchema.parse(input);
    const card = this.data.card(child);
    this.data.unlink(after, child);
    this.grow();
    return this.data.write(card, {}, "owner", "No longer waits for a card");
  }

  comment(id: string, input: unknown, actor: Actor): Comment {
    const { text } = CommentSchema.parse(input);
    this.data.card(id);
    return this.data.comment(id, actorName(actor), text);
  }

  /** The owner corrects a comment of their own. A Trunk's, Branch's, a chat's or a key's words stay as they were said. */
  editComment(id: string, input: unknown): Comment {
    const { comment, text } = CommentEditSchema.parse(input);
    this.data.card(id);
    if (this.data.commentOf(id, comment).by !== "owner") throw new Error("Only your own comments can be edited; you can remove anyone's.");
    return this.data.editComment(id, comment, text);
  }
  /** The owner removes any comment on a card. */
  removeComment(id: string, input: unknown): { removed: boolean } {
    const { comment } = CommentRemoveSchema.parse(input);
    this.data.card(id);
    this.data.commentOf(id, comment);
    return { removed: this.data.removeComment(id, comment) };
  }

  /** The owner looked at a card blocked after failing too often: back to seed, count cleared, planted. */
  reset(id: string): Card {
    const card = this.data.card(id);
    if (this.occupies(card)) throw new Error("This card's task is still active. Stop its task first.");
    const moved = this.data.write(card, { lane: "seed", failures: 0, stuck: false, planted: true }, "owner", "Reset by the owner");
    this.grow();
    return moved;
  }

  remove(id: string): { removed: boolean } {
    const card = this.data.card(id);
    if (this.occupies(card)) throw new Error("This card's task is still active. Stop its task first.");
    return { removed: this.data.removeCard(id) };
  }

  /** The task working a card says it cannot go on: the card is blocked with its reason, and the owner decides. */
  block(runId: string, why: string, actor: Actor): Card {
    const card = this.data.cardOfRun(runId);
    if (!card || card.lane !== "growing") throw new Error("This task is not working on an Orchard card.");
    return this.data.write(card, { lane: "blocked" }, actorName(actor), `Blocked: ${oneLine(why, 500)}`);
  }

  /** The owner pressed Grow: the card's task starts now, as the owner's own. */
  async start(id: string): Promise<Card> {
    if (!this.deps.on()) throw new Error("Orchard is switched off. The owner can switch it on in Branch.");
    const card = this.data.card(id);
    const refusal = this.startRefusal(card);
    if (refusal) throw new Error(refusal);
    const planted = card.planted ? card : this.data.write(card, { planted: true }, "owner", "Planted by the owner");
    await this.launch(planted, "grow");
    return this.data.card(id);
  }

  /* ---------- the grower ---------- */

  /** Starts what may start now. Called after every change and every finished task, and on the engine's tick. */
  grow(): void {
    if (!this.deps.on() || this.deps.lockdown()) return;
    const cards = this.data.cards();
    const busy = new Set(cards.filter((c) => this.occupies(c) && c.assignee).map((c) => c.assignee));
    for (const board of this.data.boards()) {
      let growing = cards.filter((c) => c.board === board.id && this.occupies(c)).length;
      const ready = cards.filter((c) => c.board === board.id && c.lane === "seed" && c.planted && !c.stuck && !this.starting.has(c.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const card of ready) {
        if (growing >= board.atOnce) break;
        if (this.startRefusal(card) || (card.assignee && busy.has(card.assignee))) continue;
        if (card.assignee) busy.add(card.assignee);
        growing += 1;
        // Refused before it began (a Trunk paused a moment ago): the card is back in seed, and it waits for the next pass.
        this.launch(card, "pulled").catch(() => undefined);
      }
    }
  }

  /** Waits for every card start in flight. The window never needs this; a test does. */
  async settled(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  /** Why this card may not start now, in words, or null. */
  private startRefusal(card: Card): string | null {
    if (card.stuck) return "This card was blocked after failing too often. Reset it first.";
    if (card.lane !== "seed" && card.lane !== "blocked") return card.lane === "growing" ? "This card is already growing." : `This card is ${card.lane}.`;
    if (this.occupies(card)) return "This card's task is still active. Stop its task first.";
    const active = this.data.cards().filter((other) => this.occupies(other));
    if (active.filter((other) => other.board === card.board).length >= this.data.board(card.board).atOnce)
      return "This board is already growing as many cards as it allows. Wait for a task to finish.";
    if (card.assignee && active.some((other) => other.assignee === card.assignee)) return "This Trunk is already working on another card.";
    const waiting = card.after.map((id) => this.data.card(id)).filter((parent) => parent.lane !== "picked");
    if (waiting.length) return `This card waits for "${waiting[0]!.title}" to be picked.`;
    if (card.assignee) {
      const trunk = this.deps.trunks().find((t) => t.id === card.assignee);
      if (!trunk) return "The Trunk this card was given to is no longer here. Give it to another.";
      return this.deps.runtime.trunkPaused(trunk.id) ?? this.deps.runtime.trunkAtOnce(trunk.id);
    }
    return null;
  }

  private track(work: Promise<unknown>): void {
    const settled = work.catch(() => undefined).finally(() => this.pending.delete(settled));
    this.pending.add(settled);
  }

  /**
   * Starts the card's task and answers once it has started (or was refused before it existed); the task itself goes on.
   * A refusal before the task exists puts the card back where it was, with no failure.
   */
  private launch(card: Card, how: "grow" | "pulled"): Promise<void> {
    if (this.starting.has(card.id)) return Promise.resolve();
    this.starting.add(card.id);
    const board = this.data.board(card.board), from = card.lane;
    const started = this.data.write(card, { lane: "growing", runId: null, sessionId: null }, how === "grow" ? "owner" : "orchard",
      how === "grow" ? "Grow pressed" : "Pulled by the orchard");
    return new Promise<void>((resolve, reject) => {
      let ran = false;
      // The owner's own task: the owner posted the card or said yes to it, so it runs under the owner's own approval
      // rules, unchanged, and a yes to a question it asks carries this same task on (src/server.ts settleAsked).
      const work = this.deps.runtime.run({ prompt: this.prompt(started, board), source: "owner", title: card.title, conversationProject: board.project,
        ...(card.assignee ? { trunkId: card.assignee } : {}), onTextDelta: () => undefined,
        onStarted: (run) => {
          ran = true;
          this.starting.delete(card.id);
          this.store.event(run.id, "orchard.card", { cardId: card.id, board: card.board, how });
          // Its conversation is called by the card's title in the list, as a conversation the owner renamed is.
          try { this.store.renameConversation(this.owner, run.sessionId, { title: card.title.slice(0, 120) }); }
          catch (error) { this.store.event(run.id, "orchard.unnamed", { reason: errorText(error).slice(0, 200) }); }
          const now = this.data.find(card.id);
          if (now) this.data.write(now, { runId: run.id, sessionId: run.sessionId }, "orchard", "Its task started");
          resolve();
        } });
      this.track(work.then(() => undefined, (error: unknown) => {
        this.starting.delete(card.id);
        if (ran) return; // the task's own record says how it ended (finished below)
        const now = this.data.find(card.id);
        if (now) this.data.write(now, { lane: from, runId: null }, "orchard", `Did not start: ${oneLine(errorText(error), 300)}`);
        reject(error instanceof Error ? error : new Error(errorText(error)));
      }));
    });
  }

  /** What the card's task is asked: the card, what the cards it waited for came to, and the comments of those who work it. */
  private prompt(card: Card, board: Board): string {
    const parents = card.after.map((id) => this.data.card(id)).map((parent) => {
      const output = parent.runId ? this.store.run(parent.runId)?.output ?? "" : "";
      return `- ${parent.title}${output ? `: ${oneLine(output, 600)}` : ""}`;
    });
    // A chat's or a key's comment is somebody else's words, so it is not put in front of the task.
    const comments = this.data.comments(card.id).filter((c) => !outsideActors.includes(c.by)).slice(-10).map((c) => `- ${c.by}: ${oneLine(c.text, 400)}`);
    // The card's title comes first: it is what the task's conversation is called in the list.
    return [card.title, "", `This is a card on the Orchard board "${board.name}". Work on it.`,
      card.notes ? `Notes: ${card.notes}` : "",
      parents.length ? `It waited for these cards, and this is what came of them:\n${parents.join("\n")}` : "",
      comments.length ? `Comments on the card:\n${comments.join("\n")}` : "",
      "Say plainly what you did and what is left. If you cannot go on, call orchard.card_block with the reason."]
      .filter(Boolean).join("\n");
  }

  /** A card's task ended: completed → ripe; failed → back to seed, or blocked once it failed too often in a row;
   *  stopped → blocked; cut off by a restart → back to seed, no failure. */
  private finished(runId: string, status: RunStatus): void {
    const card = this.data.cardOfRun(runId);
    if (!card) return;
    if (card.lane !== "growing") { queueMicrotask(() => this.grow()); return; }
    if (status === "interrupted" && this.pausedByOwner(runId)) {
      this.data.write(card, {}, "orchard", "Its task was paused");
      return;
    }
    if (status === "completed") this.data.write(card, { lane: "ripe", failures: 0 }, "orchard", "Its task finished; waiting for your review");
    else if (status === "cancelled") this.data.write(card, { lane: "blocked" }, "orchard", "Its task was stopped");
    else if (status === "interrupted") this.data.write(card, { lane: "seed" }, "orchard", "Its task was cut off; it will be pulled again");
    else {
      const failures = card.failures + 1, stop = failures >= this.data.board(card.board).stopAfter;
      this.data.write(card, { lane: stop ? "blocked" : "seed", failures, stuck: stop }, "orchard",
        stop ? `Blocked after ${failures} failed tries in a row` : `Its task did not finish (${status})`);
    }
    queueMicrotask(() => this.grow());
  }

  /** The owner paused this task (Pause, src/runtime.ts): it waits for Resume, and the card keeps its place. */
  pausedByOwner(runId: string): boolean {
    return this.store.run(runId)?.status === "interrupted" && this.store.events(runId).some((event) => event.kind === "run.paused");
  }
  private carriedOn(from: string, runId: string): void {
    const card = this.data.cardOfRun(from);
    if (!card || (card.lane !== "growing" && card.lane !== "blocked")) return;
    const run = this.store.run(runId);
    this.data.write(card, { runId, sessionId: run?.sessionId ?? card.sessionId }, "orchard", "Its task carried on");
  }

  /** At start: a card left growing whose task is no longer working or waiting is settled as that task ended. */
  private recover(): void {
    for (const card of this.data.cards().filter((c) => c.lane === "growing")) {
      const run = card.runId ? this.store.run(card.runId) : undefined;
      if (run && (run.status === "running" || run.status === "needs_input" || this.pausedByOwner(run.id))) continue;
      if (run) this.finished(run.id, run.status);
      else this.data.write(card, { lane: "seed" }, "orchard", "Its task was cut off; it will be pulled again");
    }
  }

  /* ---------- helpers ---------- */

  private project(id?: string): string {
    if (!id) return this.store.projects.active(this.owner).id;
    if (!this.store.projects.list(this.owner).some((p) => p.id === id)) throw new Error("Project not found");
    return id;
  }
  private defaultBoard(): Board {
    const active = this.store.projects.active(this.owner);
    return this.data.boards().find((b) => b.project === active.id) ?? this.data.addBoard(active.id, active.name);
  }
  /** A Trunk by its id, @name or name. */
  private trunkId(given: string): string {
    const key = given.replace(/^@/, "").toLowerCase();
    const trunk = this.deps.trunks().find((t) => t.id === given || t.handle.toLowerCase() === key || t.name.toLowerCase() === key);
    if (!trunk) throw new Error(`There is no Trunk called ${oneLine(given, 64)}.`);
    return trunk.id;
  }
  /** Whether `from` already waits, directly or not, on `on`. */
  private waitsOn(from: string, on: string, seen = new Set<string>()): boolean {
    if (seen.has(from)) return false;
    seen.add(from);
    return this.data.parents(from).some((parent) => parent === on || this.waitsOn(parent, on, seen));
  }
}

export const IdSchema = z.string().uuid();
