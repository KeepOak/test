import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import { currentPerson } from "../people/context.js";
import { boardWriter } from "../flows-boards/origin.js";
import type { Store } from "../store.js";
import type { Orchard } from "./index.js";
import { BlockSchema, CardInputSchema, CommentSchema, type Actor } from "./model.js";
export { orchardTools } from "./model.js";

/**
 * Orchard's tools, for Trunks and Branch's assistant: they read the boards, post a card (it waits for the owner's yes
 * before it is pulled), comment, and block the card their own task is working on. None of them starts work, picks a
 * card or approves anything. Each declares what it touches: only Orchard's own tables on this computer (`reach: local`,
 * target `orchard:<board or card>`), so the approval rules can name it.
 */

const id = z.string().uuid();
const actorOf = (context: ToolContext): Actor => (context.trunk ? { kind: "trunk", id: context.trunk } : { kind: "branch" });

/** Only the owner's own work, never a household person's task, a chat message, a key or another program. */
function reader(store: Store, context: ToolContext): void {
  if (currentPerson() || !store.profiles.isOwner())
    throw new Error("Only the owner's own work can read Orchard; a household person's task cannot.");
  if (!boardWriter(store, context.runId))
    throw new Error("Only the owner's own work can read Orchard; a chat message, a key or another program cannot.");
}
function writer(store: Store, context: ToolContext): void {
  if (!boardWriter(store, context.runId))
    throw new Error("Only the owner's own work can change Orchard; a chat message, a key or another program cannot.");
}

export function registerOrchardTools(registry: ToolRegistry, orchard: Orchard, store: Store): void {
  registry.register({ name: "orchard.boards", permission: "boards.read", reach: "local", target: () => "orchard:boards",
    description: "The Orchard boards: each board's name and how many cards are in seed, growing, ripe (waiting for the owner's review), picked and blocked.",
    parameters: z.object({}).strict(),
    execute: async (_args, context) => { reader(store, context); return { boards: orchard.boards() }; } });
  registry.register({ name: "orchard.cards", permission: "boards.read", reach: "local", target: (args) => `orchard:${args.board ?? "default"}`,
    description: "The cards on one Orchard board (the active project's when none is named), by column, with who each is given to and which cards it waits for.",
    parameters: z.object({ board: id.optional() }).strict(),
    execute: async (args, context) => { reader(store, context); return orchard.view(args.board); } });
  registry.register({ name: "orchard.card_add", permission: "boards.write", reach: "local", target: (args) => `orchard:${args.board ?? "default"}`,
    description: "Post a card to Orchard's seed column: a title, notes, optionally the Trunk to give it to and the cards it waits for. It is not worked on until the owner says yes to it.",
    parameters: CardInputSchema,
    execute: async (args, context) => { writer(store, context); return { card: orchard.add(args, actorOf(context)) }; } });
  registry.register({ name: "orchard.card_comment", permission: "boards.write", reach: "local", target: (args) => `orchard:${args.id}`,
    description: "Add a comment to an Orchard card, for the owner and whoever works on it.",
    parameters: CommentSchema.extend({ id }).strict(),
    execute: async ({ id: card, ...comment }, context) => { writer(store, context); return { comment: orchard.comment(card, comment, actorOf(context)) }; } });
  registry.register({ name: "orchard.card_block", permission: "boards.write", reach: "local", target: () => "orchard:this-card",
    description: "Say that the Orchard card this task is working on cannot go on, and why. The card is blocked and the owner decides what next.",
    parameters: BlockSchema,
    execute: async (args, context) => {
      writer(store, context);
      return { card: orchard.block(rootRun(store, context.runId), args.why, actorOf(context)) };
    } });
}

/** The task at the top of this one's tree: a helper blocks the card its parent task is working on. */
function rootRun(store: Store, runId: string): string {
  let current = runId;
  for (let i = 0; i < 20; i += 1) {
    const parent = store.events(current).find((event) => event.kind === "run.started")?.data.parentRunId;
    if (typeof parent !== "string" || !store.run(parent)) return current;
    current = parent;
  }
  return current;
}
