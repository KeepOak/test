import { readFileSync } from "node:fs";
import type { ToolContext, ToolDefinition } from "./contracts.js";

/**
 * PLAT-191: a tool listed without its code. A part of Branch whose code is loaded on first use still lists its tools
 * from the start, from a card written when Branch is built (scripts/tool-cards.mjs, dist/tool-cards.json): everything
 * a model or the rules read before a call (its name, words, inputs, permission, toolbox and flags). The first time
 * anything needs more (its inputs checked, a call, what a call would touch), the part is loaded, its real tool takes
 * the card's place in the registry, and the card hands every question on to it. tests/tool-cards.test.mjs holds the
 * cards to what the real tools say.
 */
export interface ToolCard {
  name: string;
  description: string;
  permission: string;
  /** The inputs as the model sees them: the tool's own JSON schema, or its checker's. */
  schema: Record<string, unknown>;
  group?: string;
  external?: boolean;
  source?: string;
  screen?: boolean;
  reach?: "local" | "outbound";
  /** Which of the optional questions the real tool answers: what a call touches, and the command it runs. */
  answers: ("target" | "targets" | "command")[];
}

/** The card's inputs, for the registry's catalog (src/registry.ts descriptions). */
export const cardSchema = Symbol("branch.tool-card.schema");

/**
 * A card standing in for its tool. `real` loads the part (which registers the real tool in its place) and answers the
 * real tool; it throws when the part cannot give it.
 */
export function cardTool(card: ToolCard, real: () => ToolDefinition): ToolDefinition & { [cardSchema]: Record<string, unknown> } {
  const tool = {
    name: card.name, description: card.description, permission: card.permission,
    ...(card.group !== undefined ? { group: card.group } : {}),
    ...(card.external !== undefined ? { external: card.external } : {}),
    ...(card.source !== undefined ? { source: card.source } : {}),
    ...(card.screen !== undefined ? { screen: card.screen } : {}),
    ...(card.reach !== undefined ? { reach: card.reach } : {}),
    get parameters() { return real().parameters; },
    execute: (args: unknown, context: ToolContext) => real().execute(args, context),
    ...(card.answers.includes("target") ? { target: (args: unknown, context: ToolContext) => real().target!(args, context) } : {}),
    ...(card.answers.includes("targets") ? { targets: (args: unknown, context: ToolContext) => real().targets!(args, context) } : {}),
    ...(card.answers.includes("command") ? { command: (args: unknown) => real().command!(args) } : {}),
    [cardSchema]: card.schema,
  };
  return tool as ToolDefinition & { [cardSchema]: Record<string, unknown> };
}

let cards: Map<string, ToolCard> | null = null;
/** The cards written when Branch was built, by tool name; none when there are none (a source checkout before a build). */
export function toolCards(file = new URL("./tool-cards.json", import.meta.url)): Map<string, ToolCard> {
  if (cards) return cards;
  try {
    const list = JSON.parse(readFileSync(file, "utf8")) as ToolCard[];
    cards = new Map(list.map((card) => [card.name, card]));
  } catch { cards = new Map(); }
  return cards;
}

/**
 * Lists tools from their cards, each loading its part (`load`, which registers the real tools) the first time more is
 * asked of it. A tool without a card (a source checkout not yet built) loads its part at once: it is listed as before.
 */
export function listFromCards(registry: { register(tool: ToolDefinition): void; registered(name: string): ToolDefinition | undefined },
  names: readonly string[], load: () => void): void {
  const all = toolCards();
  if (names.some((name) => !all.has(name))) { load(); return; }
  for (const name of names) {
    registry.register(cardTool(all.get(name)!, () => {
      load();
      const real = registry.registered(name);
      if (!real || cardSchema in real) throw new Error(`${name} is not available now`);
      return real;
    }));
  }
}
