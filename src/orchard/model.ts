import { z } from "zod";

/**
 * Orchard: Branch's durable task board for several agents (docs/orchard-canopy.md). Its ideas come from Hermes Agent's
 * Kanban (`hermes_cli/kanban*.py`, MIT) and OpenClaw's Workboard, written for Branch:
 *
 *   seed     posted, waiting to be pulled (a Trunk's own card waits for the owner's yes first)
 *   growing  a task is working on it
 *   ripe     its task finished; waiting for the owner's review
 *   picked   the owner accepted it
 *   blocked  stopped: failed too often, stopped by the owner, or the worker said it cannot go on
 *
 * A card becomes an ordinary task when it is pulled, so every rule a task has (the owner's approval rules, Lockdown, a
 * Trunk's tools, computers and "at once" limit) holds for it, and nothing here loosens any of them.
 */
/** Orchard's tools (src/orchard/tools.ts), named here so the switches can list them without importing the tools. */
export const orchardTools = ["orchard.boards", "orchard.cards", "orchard.card_add", "orchard.card_comment", "orchard.card_block"] as const;

export const lanes = ["seed", "growing", "ripe", "picked", "blocked"] as const;
export type Lane = (typeof lanes)[number];
export const LaneSchema = z.enum(lanes);

/**
 * Who changed a card: the owner, Branch's own assistant, a Trunk by id, a chat app, or one of the owner's short-lived
 * keys (a script or another computer). A chat and a key may only post and comment, and what they post is not planted.
 */
export type Actor = { kind: "owner" } | { kind: "branch" } | { kind: "trunk"; id: string } | { kind: "chat" } | { kind: "key" };
/** Words from these are somebody else's: never put in front of a card's task. */
export const outsideActors: readonly string[] = ["chat", "key"];
export const actorName = (actor: Actor): string => (actor.kind === "trunk" ? `trunk:${actor.id}` : actor.kind);

export interface CardNote { at: string; by: string; what: string }
export interface Comment { id: string; at: string; by: string; text: string }
export interface Card {
  id: string; board: string; title: string; notes: string; lane: Lane;
  /** A Trunk's id, or "" for Branch's own assistant (and the helpers it starts). */
  assignee: string;
  /** The owner said yes to this card being pulled without being asked again (every card the owner posts or places). */
  planted: boolean;
  postedBy: string;
  failures: number; stuck: boolean;
  runId: string | null; sessionId: string | null;
  /** The cards this one waits for: it is pulled only once each of them is picked. */
  after: string[];
  comments: number;
  history: CardNote[];
  createdAt: string; updatedAt: string;
}
export interface Board {
  id: string; project: string; name: string;
  /** How many of its cards may grow side by side. */
  atOnce: number;
  /** Failed tries in a row after which a card is blocked until the owner resets it. */
  stopAfter: number;
  createdAt: string; updatedAt: string;
}

export const maxCards = 300;
export const maxBoards = 40;
export const maxHistory = 30;
export const maxComments = 200;

const title = z.string().trim().min(1).max(200);
const id = z.string().uuid();
export const BoardInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  project: z.string().trim().min(1).max(64).optional(),
}).strict();
export const BoardEditSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  atOnce: z.number().int().min(1).max(8).optional(),
  stopAfter: z.number().int().min(1).max(10).optional(),
}).strict();
export const CardInputSchema = z.object({
  board: id.optional(),
  title,
  notes: z.string().max(4000).default(""),
  /** A Trunk's id or @name; left out, Branch's own assistant works it. */
  assignee: z.string().trim().max(64).optional(),
  /** Cards this one waits for. */
  after: z.array(id).max(20).default([]),
}).strict();
export const CardEditSchema = z.object({ title: title.optional(), notes: z.string().max(4000).optional() }).strict();
export const MoveSchema = z.object({ lane: LaneSchema, note: z.string().max(500).optional() }).strict();
export const AssignSchema = z.object({ to: z.string().trim().max(64) }).strict();
export const LinkSchema = z.object({ after: id }).strict();
export const CommentSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
export const CommentEditSchema = z.object({ comment: id, text: z.string().trim().min(1).max(2000) }).strict();
export const CommentRemoveSchema = z.object({ comment: id }).strict();
export const BlockSchema = z.object({ why: z.string().trim().min(1).max(500) }).strict();

/** One line of somebody else's text made safe to show or to put in a prompt: no line breaks, capped. */
export function oneLine(text: string, max = 300): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
