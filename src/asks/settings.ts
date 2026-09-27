import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Bucket 23 (wave mac6): "the smaller asks". Each part has the owner's three-way switch — off, when
 * needed, on — kept in a settings record of its own. What each ships as is `askShipsOn` below; a
 * saved record that cannot be read is off.
 *
 *   off          the part refuses in one plain sentence; its tools are not in the catalog at all
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * The schema is written out here rather than imported from feature-switches.ts, because that file
 * reads these same records to decide what to preload, and the two must not import each other.
 */
export const askParts = [
  "project-board", "answer-engine", "answer-pages", "article-writer", "intent-pipeline", "source-sync",
  "hindsight", "app-blocks", "analytics", "live-surfaces", "nodes", "app-server", "runtimes", "forecasts", "leads",
] as const;
export type AskPart = (typeof askParts)[number];
export const AskPartSchema = z.enum(askParts);

const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type AskMode = z.infer<typeof ModeSchema>;
const RecordSchema = z.object({ mode: ModeSchema.default("off") }).strict();

/** The settings record a part's switch is kept in. */
export const askKey = (part: AskPart): string => `asks-${part}`;

/** What each part is while nothing has been saved for it. A saved record that is damaged still reads as off. */
export const askShipsOn: Partial<Record<AskPart, AskMode>> = {
  // The owner's rule (ships on, 2026-09-26): putting a flow or schedule under a project is a label on this computer; none of (a)–(f).
  "project-board": "when-needed",
  // The owner's rule (ships on, 2026-09-26): an answer kept as a page stays in Library; nothing is put online; none of (a)–(f).
  "answer-pages": "when-needed",
  // The owner's rule (ships on, 2026-09-26): routes only the intents the owner names, by words on this computer unless they add the model stage; none of (a)–(f).
  "intent-pipeline": "when-needed",
  // The owner's rule (ships on, 2026-09-26): a page refreshes only once the owner pins it, and only through calls the rules allow outright; none of (a)–(f).
  "live-surfaces": "when-needed",
  // Kept off, by the owner's rule (off for spending, sending, outside access, heavy disk): answer-engine and analytics send data out (a search provider, usage counts); article-writer and runtimes spend;
  // nodes and app-server let the outside in (an outside client can answer approvals).
};

/** What each part is, in the owner's words, for the card and for a refusal. */
export const askLabels: Record<AskPart, string> = {
  "project-board": "Keeping each project's flows and schedules together",
  "answer-engine": "Quick answers from the web, with sources",
  "answer-pages": "Answers kept as pages",
  "article-writer": "Writing a long article from research",
  "intent-pipeline": "Sending requests where they belong",
  "source-sync": "Bringing in new items from GitHub, email and Telegram",
  hindsight: "Remembering with a Hindsight server",
  "app-blocks": "Steps for other apps",
  analytics: "Counting how Branch is used, with your consent",
  "live-surfaces": "Pages from tools that keep themselves up to date",
  nodes: "Other computers running Branch",
  "app-server": "Letting an editor drive Branch over the app-server protocol",
  runtimes: "Other agents answering a conversation (Claude Code, Codex, Copilot, Gemini CLI)",
  forecasts: "Forecasts, and how well they turned out",
  leads: "A list of prospects, filled out, scored and without duplicates",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const askTools: Record<AskPart, readonly string[]> = {
  "project-board": ["project.board", "project.assign"],
  "answer-engine": ["answer.ask"],
  "answer-pages": ["answer.page"],
  "article-writer": ["research.article"],
  "intent-pipeline": ["intent.route"],
  "source-sync": ["sources.sync", "sources.list"],
  hindsight: ["hindsight.retain", "hindsight.recall", "hindsight.reflect"],
  "app-blocks": ["blocks.list", "blocks.run"],
  analytics: [],
  "live-surfaces": [],
  nodes: ["nodes.status", "nodes.ask"],
  "app-server": [],
  runtimes: [],
  forecasts: ["forecast.add", "forecast.resolve", "forecast.score"],
  leads: ["leads.add", "leads.export", "leads.clear"],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const askToolFeatures: readonly (readonly [string, string, readonly string[], AskMode])[] = askParts
  .filter((part) => askTools[part].length > 0)
  .map((part) => [askKey(part), `${askLabels[part].charAt(0).toLowerCase()}${askLabels[part].slice(1)} is switched on`, askTools[part], askShipsOn[part] ?? "off"] as const);

export function askMode(store: Pick<Store, "get">, owner: string, part: AskPart): AskMode {
  const found = store.get("settings", owner, askKey(part));
  if (!found) return askShipsOn[part] ?? "off";
  const saved = RecordSchema.safeParse(found.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export function allAskModes(store: Pick<Store, "get">, owner: string): Record<AskPart, AskMode> {
  return Object.fromEntries(askParts.map((part) => [part, askMode(store, owner, part)])) as Record<AskPart, AskMode>;
}

export function saveAskMode(store: Store, owner: string, part: AskPart, input: unknown): AskMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, askKey(part), { mode });
  return mode;
}

export class AskOffError extends Error {
  override name = "AskOffError";
}

/** Throws the one plain sentence a switched-off part answers with. */
export function requireAsk(store: Pick<Store, "get">, owner: string, part: AskPart): void {
  if (askMode(store, owner, part) === "off")
    throw new AskOffError(`${askLabels[part]} is switched off. The owner can switch it on in Branch.`);
}

/** A part's own settings record (not its switch), read through a schema with defaults. */
export function partSettings<T>(store: Pick<Store, "get">, owner: string, key: string, schema: z.ZodType<T>): T {
  const saved = schema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return saved.success ? saved.data : schema.parse({});
}

/** Cuts text to at most this many bytes without splitting a character (a workspace file holds 32 KiB). */
export function clipBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= bytes) return text;
  return buffer.subarray(0, bytes).toString("utf8").replace(/\uFFFD$/, "");
}
