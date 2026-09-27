import type { Call, Reply } from "../commands/handlers.js";
import { flowsBoardsFor } from "../flows-boards/index.js";
import { offSentence } from "../flows-boards/settings.js";
import { lanes, type Actor, type Card, type Lane } from "./model.js";

/**
 * `/orchard`, in the window, the terminal and chat apps (the table entry is in src/commands/catalog.ts). It works on the
 * active project's board. From a chat app it may only look, post a card (which waits for the owner's yes before it is
 * worked on) and comment; starting, moving, picking and resetting are the owner's, with full access, never from a chat.
 */
type Handler = (call: Call) => Reply | Promise<Reply>;
const say = (text: string): Reply => ({ text });
const usage = "Use /orchard, /orchard show <n>, /orchard add <title>, /orchard comment <n> <words>, or (the owner) /orchard grow|pick|reset <n> and /orchard move <n> seed|ripe|picked|blocked.";
const ownersOnly = "Only the owner can do that, in the Branch app or the owner's terminal. From here you can look, add a card and comment.";

const numbered = (cards: Record<Lane, Card[]>): Card[] => lanes.flatMap((lane) => cards[lane]);
function listed(board: string, cards: Card[]): string {
  if (!cards.length) return `${board}: no cards yet. Add one with /orchard add <title>.`;
  return [`${board}:`, ...cards.map((card, i) => `${i + 1}. [${card.lane}] ${card.title}${card.planted ? "" : " (waiting for the owner's yes)"}`)].join("\n");
}

export const orchard: Handler = (call) => {
  const boards = flowsBoardsFor(call.host.runtime);
  if (!boards) return say("This part of Branch is not in this copy.");
  if (boards.mode("kanban") === "off") return say(offSentence("kanban"));
  const { orchard: o } = boards;
  const view = o.view();
  const cards = view.board ? numbered(view.lanes) : [];
  const text = call.argument.trim();
  if (!text) return say(view.board ? listed(view.board.name, cards) : "No boards yet. Add a card with /orchard add <title>.");
  const chat = call.surface === "chat";
  // Only the owner with full access posts a card that is planted; a chat or a short-lived key's card waits for the yes.
  const actor: Actor = chat ? { kind: "chat" } : call.access === "full" ? { kind: "owner" } : { kind: "key" };
  const add = /^add\s+(.+)$/is.exec(text);
  if (add) {
    if (!chat) call.host.requireOwner("/orchard add");
    const card = o.add({ title: add[1]!.trim().slice(0, 200) }, actor);
    return say(`Added to seed: ${card.title}${card.planted ? "" : ". It waits for the owner's yes before it is worked on."}`);
  }
  const match = /^(show|comment|grow|pick|reset|move)\s+(\d+)\s*(.*)$/is.exec(text);
  if (!match) return say(usage);
  const card = cards[Number(match[2]) - 1];
  if (!card) return say("There is no card with that number; /orchard lists them.");
  const verb = match[1]!.toLowerCase(), rest = match[3]!.trim();
  if (verb === "show") {
    const comments = o.card(card.id).comments_.slice(-5).map((c) => `  ${c.by}: ${c.text}`);
    return say([`${card.title} [${card.lane}]`, card.notes, ...comments].filter(Boolean).join("\n"));
  }
  if (verb === "comment") {
    if (!rest) return say("Say the comment after the number.");
    if (!chat) call.host.requireOwner("/orchard comment");
    o.comment(card.id, { text: rest }, actor);
    return say("Comment added.");
  }
  if (chat || call.access !== "full") return say(ownersOnly);
  call.host.requireOwner(`/orchard ${verb}`);
  return ownerVerb(o, card, verb, rest);
};

async function ownerVerb(o: NonNullable<ReturnType<typeof flowsBoardsFor>>["orchard"], card: Card, verb: string, rest: string): Promise<Reply> {
  if (verb === "grow") return say(`Growing: ${(await o.start(card.id)).title}`);
  if (verb === "reset") return say(`Back in seed: ${o.reset(card.id).title}`);
  const lane = verb === "pick" ? "picked" : rest.toLowerCase();
  if (!(lanes as readonly string[]).includes(lane) || lane === "growing") return say("Move it to seed, ripe, picked or blocked. /orchard grow <n> starts it.");
  return say(`Moved to ${lane}: ${(await o.move(card.id, { lane })).title}`);
}
