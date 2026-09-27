import type { ToolDescription } from "./contracts.js";
import { estimateTokens } from "./contracts.js";

/**
 * The tool catalog is charged to the model on every single round, so it is the one part of the
 * context that grows with the product rather than with the conversation. This module keeps it
 * small in three ways: tools live in named groups that stay collapsed until they are needed, the
 * generated JSON schemas are stripped of everything the model cannot act on, and the cost of the
 * catalog is measured so compaction can be decided on the conversation alone.
 */

/** Toolboxes a tool can belong to. "core" is always open; "other" catches anything unrecognised. */
export const toolGroups = [
  "core", "files", "code", "git", "web", "browser", "desktop", "memory", "memory-extra", "documents",
  "data", "research", "media", "personal", "channels", "schedules", "agents", "skills", "settings", "services", "other",
] as const;

/** Name prefixes that decide a tool's group when the tool does not name one itself. */
const groupPrefixes: readonly (readonly [string, readonly string[]])[] = [
  ["core", ["user.", "tools.", "answer"]],
  ["files", ["files.", "workspace.", "folders."]],
  ["code", ["code.", "terminal.", "shell.", "build.", "tests.", "lint.", "patch.", "process.", "debug.", "artifacts."]],
  ["git", ["git.", "github.", "gitlab."]],
  // Another computer reached over SSH: its files and the few programs it is allowed to run. It has
  // a box of its own rather than sharing "files", because everything in it is somewhere else.
  ["remote", ["remote."]],
  ["web", ["web.", "http."]],
  // mac7/vault-autofill: filling one of the owner's saved sign-ins is a thing done to a page.
  ["browser", ["browser.", "page.", "signin."]],
  ["desktop", ["desktop.", "screen.", "apps.", "clipboard.", "windows.", "computer."]],
  // R17-F (integration review): memory blocks, finding facts by label, the learning timeline, meaning
  // search, lessons and outside memory services get a box of their own, before "memory" so these
  // names win. In "memory" they pushed the opened-boxes answer past its budget (tests/catalog-diet).
  ["memory-extra", ["memory.block_", "memory.find", "memory.label", "memory.outside_", "history.meaning", "learning.journey", "lessons."]],
  // A finished task's own record is history, so "runs." belongs with the rest of what happened.
  // "learning." is the learning core's one read-only question about what worked before (src/fly-core).
  ["memory", ["memory.", "knowledge.", "history.", "sessions.", "scratch.", "templates.", "notes.", "labels.", "projects.", "runs.", "learning.",
    // mac4/bucket-20: choosing the project for a request, and handing a conversation on.
    "project.", "conversation."]],
  // Wave 8: the to-do list is a box of its own rather than a corner of memory. Filing it under
  // memory reads tidier, but it put three more tools into a box almost every task opens, and the
  // opened-catalog budget in tests/catalog-diet.test.mjs is there to stop exactly that. A box of
  // its own costs one line while it is closed and is opened only when the owner wants a to-do.
  ["todos", ["todos."]],
  // Wave 8: the Obsidian bridge writes documents into a folder and reads them back, so it is a
  // documents tool under a different name.
  ["documents", ["documents.", "pdf.", "library.", "obsidian."]],
  ["data", ["data.", "sql.", "database.", "sheets.", "tables.", "csv.", "forecast.", "leads."]],
  ["research", ["research.", "papers.", "citations.", "sources."]],
  ["media", ["media.", "images.", "image.", "audio.", "video.", "voice.", "speech.", "camera."]],
  // R17-C (integration review): the owner's own accounts, music, house and files sent into chats —
  // one box, before "agents" so a Teams transcript is not taken for a team of agents.
  ["personal", ["gmail.", "gcal.", "gdrive.", "outlook.", "teams.summary", "spotify.", "home.", "x.search", "chat.send_file"]],
  ["channels", ["channels.", "telegram.", "slack.", "discord.", "email.", "mail.", "messages.", "whatsapp."]],
  // Watches and the morning brief are recurring things that come and tell you something, so they
  // live with the rest of the assistant's own clockwork rather than in the unrecognised box.
  ["schedules", ["schedules.", "heartbeat.", "triggers.", "reminders.", "timers.", "webhooks.", "monitor.", "monitors.", "brief.", "workflows.", "flows.", "queue.",
    // mac4/bucket-20: finding a better flow.
    "flow."]],
  ["agents", ["agents.", "specialists.", "delegate.", "procedures.", "plans.", "teams.", "orchestration.", "profiles.",
    // mac4/bucket-20: ways of working, the fleet, and the market of shared assistants.
    "mode.", "fleet.", "assistant."]],
  // mac4/bucket-20: tools a connected program lends over its socket; a box of their own, since
  // they are somebody else's and come and go with the program.
  ["client", ["client."]],
  // Bucket 21: the tools for people building a program on Branch.
  // bucket-15: drafting an add-on and searching what plugins bring sit with the rest of what extends Branch.
  ["skills", ["skills.", "plugins.", "recipes.", "mcp.", "sdk.", "addon."]],
  // The owner's own instruction files (AGENTS.md, SOUL.md and the rest) are part of how Branch is
  // set up, so they file under settings rather than opening a box of their own for two tools.
  ["settings", ["settings.", "help.", "preferences.", "policy.", "secrets.", "locker.", "usage.", "costs.", "models.", "context."]],
  // A service the owner turned into tools from its own OpenAPI description. These have their own
  // box rather than the unrecognised one, which closes as soon as there are more than a dozen
  // things in it — one ordinary document can bring far more tools than that on its own.
  ["services", ["api."]],
];

/** The group a tool belongs to, worked out from its name. */
export function inferToolGroup(name: string): string {
  for (const [group, prefixes] of groupPrefixes)
    if (prefixes.some((prefix) => name === prefix || name.startsWith(prefix))) return group;
  return "other";
}

/** The tool that opens a collapsed toolbox. Handled by the runtime, not by the registry. */
/**
 * One line per tool when a box is opened, so the answer stays the same size however many tools the
 * box grows to hold. Opening the three largest boxes at once had crept to within 27 characters of
 * the limit, which meant the next tool anybody registered would have broken an unrelated test;
 * trimming descriptions by hand only ever buys that back once. The whole description is still one
 * `tools.describe` away.
 */
const listingLimit = 90;
export function shorten(description: string): string {
  const text = description.trim();
  if (text.length <= listingLimit) return text;
  const sentence = text.slice(0, listingLimit + 2).match(/^(.*?[.!?])\s/);
  if (sentence?.[1] && sentence[1].length <= listingLimit) return sentence[1];
  // The ellipsis counts too, so the clip leaves room for it rather than going one over the cap.
  const room = listingLimit - 1;
  const cut = text.lastIndexOf(" ", room);
  return text.slice(0, cut > 40 ? cut : room).trimEnd() + "…";
}

export const expandToolName = "tools.expand";
/** Longest tool description sent to the model; the rest stays in the tool's own documentation. */
export const maxToolDescriptionChars = 200;
const maxSchemaDescriptionChars = 120;
/** A regular expression longer than this tells the model nothing it can use, so it is dropped. */
const maxPatternChars = 40;
/** How many unrecognised tools ("other") stay open before that toolbox is worth closing too. */
export const unrecognisedOpenUpTo = 12;
/**
 * Schema keywords the model cannot act on. Every call is parsed against the real zod schema before
 * a tool sees it, so these bounds are still enforced; sending them is pure catalog weight.
 */
const droppedKeywords = new Set([
  "$schema", "title", "minLength", "maxLength", "minItems", "maxItems", "multipleOf",
  "exclusiveMinimum", "exclusiveMaximum", "uniqueItems", "readOnly", "writeOnly",
]);
/** Keys whose values are maps of names to schemas, so their keys are never schema keywords. */
const schemaMaps = new Set(["properties", "$defs", "definitions", "patternProperties"]);
/** Keys whose values are data, not schemas, and must survive untouched. */
const literalKeywords = new Set(["enum", "const", "default", "examples", "required"]);

const capped = (text: string, limit: number): string =>
  text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + "…";

const isOpenOrClosed = (value: unknown): boolean =>
  value === false || (!!value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);

/**
 * Strips a generated JSON schema down to what the model needs to make a correct call: types,
 * property names, enum values, required lists and short descriptions. Bounds, dialect lines and
 * machine-generated patterns go; the registry still validates every call against the real schema.
 */
export function slimSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slimSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  const source = node as Record<string, unknown>;
  const hasFormat = typeof source.format === "string";
  for (const [key, value] of Object.entries(source)) {
    if (droppedKeywords.has(key)) continue;
    if (key === "pattern" && (hasFormat || String(value).length > maxPatternChars)) continue;
    if (key === "additionalProperties" && isOpenOrClosed(value)) continue;
    if (key === "required" && Array.isArray(value) && !value.length) continue;
    if (key === "propertyNames" && isBareString(value)) continue;
    if (key === "description" && typeof value === "string") out[key] = capped(value, maxSchemaDescriptionChars);
    else if (literalKeywords.has(key)) out[key] = value;
    else if (schemaMaps.has(key) && value && typeof value === "object") out[key] = slimMap(value as Record<string, unknown>);
    else out[key] = slimSchema(value);
  }
  return withoutDefaulted(out);
}

const isBareString = (value: unknown): boolean =>
  !!value && typeof value === "object" && Object.entries(value).length === 1 && (value as { type?: unknown }).type === "string";

/**
 * A property with a default need not be sent, but the generator lists it as required all the same.
 * Taking those out shortens the required list and stops the model filling in values it can leave out.
 */
function withoutDefaulted(schema: Record<string, unknown>): Record<string, unknown> {
  const required = schema.required, properties = schema.properties;
  if (!Array.isArray(required) || !properties || typeof properties !== "object") return schema;
  const map = properties as Record<string, { default?: unknown } | undefined>;
  const kept = required.filter((name) => typeof name !== "string" || !(map[name] && "default" in map[name]));
  if (kept.length === required.length) return schema;
  return kept.length ? { ...schema, required: kept } : Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "required"));
}

/** Slims each schema in a name-to-schema map without treating the names as schema keywords. */
function slimMap(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(map)) out[name] = slimSchema(schema);
  return out;
}

/** One tool as the model sees it after the diet: short description, stripped schema. */
export function slimTool(tool: ToolDescription): ToolDescription {
  return {
    name: tool.name,
    description: capped(tool.description, maxToolDescriptionChars),
    parameters: slimSchema(tool.parameters) as Record<string, unknown>,
  };
}

export interface CatalogGroup {
  group: string;
  tools: number;
  expanded: boolean;
}
export interface CatalogStats {
  /** Tools the run is allowed to use. */
  tools: number;
  /** Tools actually described to the model this round. */
  shown: number;
  groups: number;
  collapsed: number;
  characters: number;
  estimatedTokens: number;
}
export interface CatalogOptions {
  /** Groups open from the first round. */
  expanded?: readonly string[];
  /** A tool used within this many rounds stays visible even after its group closes again. */
  recentRounds?: number;
  /** Where a tool's group comes from; defaults to its name. */
  groupOf?: (name: string) => string;
}

/**
 * What the model is shown each round: the open toolboxes, anything used recently, and one line per
 * closed toolbox with a count. Opening a toolbox lasts for the rest of the conversation.
 */
export class ToolCatalog {
  private readonly expanded = new Set<string>(["core"]);
  private readonly usedAt = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private readonly recentRounds: number;
  private readonly groupOf: (name: string) => string;
  private round = 0;
  constructor(private readonly all: readonly ToolDescription[], options: CatalogOptions = {}) {
    this.recentRounds = options.recentRounds ?? 3;
    this.groupOf = options.groupOf ?? inferToolGroup;
    for (const group of options.expanded ?? []) this.expanded.add(group);
    for (const tool of this.all) {
      const group = this.groupOf(tool.name);
      this.counts.set(group, (this.counts.get(group) ?? 0) + 1);
    }
  }
  /**
   * Whether a toolbox is open. "other" holds tools whose names the product does not recognise —
   * an installed skill, a connected server — so nothing in the words of a request can point at it.
   * A handful of those stay open; once there are enough of them to be worth hiding, they close.
   */
  private isOpen(group: string): boolean {
    if (this.expanded.has(group)) return true;
    return group === "other" && (this.counts.get(group) ?? 0) <= unrecognisedOpenUpTo;
  }
  /** Every group the run has tools in, with its size and whether it is open. */
  groups(): CatalogGroup[] {
    return [...this.counts].map(([group, tools]) => ({ group, tools, expanded: this.isOpen(group) }));
  }
  /**
   * Opens toolboxes for the rest of the conversation; unknown names come back as such. The answer
   * lists what is now available by name and purpose only: the full schemas arrive with the next
   * round's catalog anyway, and repeating them here would sit in the conversation for good.
   */
  expand(names: readonly string[]): { opened: string[]; unknown: string[]; tools: { name: string; description: string }[] } {
    const known = new Set(this.groups().map((group) => group.group));
    const opened: string[] = [], unknown: string[] = [];
    for (const raw of names) {
      const name = String(raw).trim().toLowerCase();
      if (!known.has(name)) unknown.push(name);
      else if (!this.expanded.has(name)) { this.expanded.add(name); opened.push(name); }
    }
    const inOpened = new Set(opened);
    return {
      opened, unknown,
      tools: this.all.filter((tool) => inOpened.has(this.groupOf(tool.name)))
        .map((tool) => ({ name: tool.name, description: shorten(tool.description) })),
    };
  }
  /** Remembers that a tool was called, so it stays visible for the next few rounds. */
  noteUse(name: string): void {
    this.usedAt.set(name, this.round);
  }
  /** Moves the catalog on to the next model round. */
  nextRound(): void {
    this.round++;
  }
  private visible(name: string): boolean {
    if (this.isOpen(this.groupOf(name))) return true;
    const at = this.usedAt.get(name);
    return at !== undefined && this.round - at <= this.recentRounds;
  }
  /** The tools described to the model this round, plus the opener when something is still closed. */
  descriptions(): ToolDescription[] {
    if (!this.all.length) return [];
    const shown = this.all.filter((tool) => this.visible(tool.name));
    const closed = this.groups().filter((group) => !group.expanded && group.tools);
    return closed.length ? [...shown, opener(closed)] : shown;
  }
  stats(): CatalogStats {
    const shown = this.descriptions();
    const characters = JSON.stringify(shown).length;
    return {
      tools: this.all.length,
      shown: shown.length,
      groups: this.groups().length,
      collapsed: this.groups().filter((group) => !group.expanded).length,
      characters,
      estimatedTokens: Math.ceil(characters / 4),
    };
  }
}

/** The description of `tools.expand`, listing what is still closed and how big each toolbox is. */
function opener(closed: CatalogGroup[]): ToolDescription {
  const list = closed.map((group) => `${group.group}: ${group.tools} tools`).join("; ");
  return {
    name: expandToolName,
    description: `Open a toolbox to see the tools inside it and use them. Still closed — ${list}. Open one before saying a task cannot be done.`,
    parameters: {
      type: "object",
      properties: { groups: { type: "array", items: { type: "string", enum: closed.map((group) => group.group) } } },
      required: ["groups"],
    },
  };
}


/** Words that suggest a toolbox, used to open the likely ones before the first round. */
const groupWords: Record<string, readonly string[]> = {
  files: ["file", "files", "folder", "folders", "directory", "rename", "read", "write", "copy", "move", "delete", "path", "workspace", "text"],
  code: ["code", "function", "compile", "build", "test", "tests", "bug", "refactor", "script", "command", "terminal"],
  git: ["git", "commit", "branch", "repo", "repository", "diff", "merge", "push", "pull", "github", "pr"],
  web: ["web", "online", "internet", "website", "url", "link", "google", "browse", "news", "price", "lookup"],
  browser: ["browser", "click", "form", "login", "sign", "signin", "account", "portal", "tab", "screenshot", "checkout"],
  desktop: ["desktop", "window", "app", "clipboard", "screen"],
  memory: ["remember", "remembered", "memory", "forget", "earlier", "yesterday", "last", "decided", "conversation", "history", "note", "notes"],
  documents: ["document", "documents", "pdf", "contract", "lease", "invoice", "manual", "report"],
  data: ["data", "spreadsheet", "csv", "table", "database", "sql", "rows", "column", "chart"],
  research: ["research", "paper", "papers", "study", "citation", "sources", "compare"],
  media: ["image", "picture", "photo", "video", "audio", "song", "music", "transcribe", "record", "speak", "aloud", "voice"],
  channels: ["message", "telegram", "slack", "discord", "email", "mail", "inbox", "reply", "send", "chat"],
  schedules: ["schedule", "remind", "reminder", "tomorrow", "daily", "weekly", "every", "later", "recurring", "alarm", "watch", "monitor", "brief", "morning"],
  agents: ["delegate", "specialist", "specialists", "agent", "agents", "parallel", "plan", "procedure", "team"],
  skills: ["skill", "skills", "plugin", "plugins", "recipe", "how-to"],
  settings: ["setting", "settings", "preference", "model", "cost", "spending", "password", "secret", "permission"],
  services: ["api", "service", "endpoint", "integration", "notion", "operation", "openapi"],
  // bugfix-9: "Make me a Trunk: …" opens the Trunks box, so Branch is offered trunk.propose (src/trunks/propose.ts).
  trunks: ["trunk", "trunks"],
};

export interface RelevanceSignals {
  /** What the person just asked for. */
  prompt: string;
  /** A few recent messages, weighed less than the prompt. */
  recent?: readonly string[];
  /** The project the conversation belongs to, when there is one. */
  project?: string;
  /** Tools this conversation has already used. */
  recentTools?: readonly string[];
}

/**
 * A cheap lexical guess at which toolboxes this task needs, so an ordinary request never has to
 * spend a round opening one. No model call and no network: words in, group names out.
 */
export function rankGroups(signals: RelevanceSignals, available: readonly string[], limit = 3): string[] {
  const scores = new Map<string, number>();
  const bump = (group: string, by: number) => scores.set(group, (scores.get(group) ?? 0) + by);
  const weigh = (text: string, weight: number) => {
    const words = new Set(String(text).toLowerCase().match(/[a-z][a-z0-9_-]*/g) ?? []);
    for (const group of available) {
      if (group === "core") continue;
      if (words.has(group)) bump(group, weight * 2);
      for (const word of groupWords[group] ?? []) if (words.has(word)) bump(group, weight);
    }
  };
  weigh(signals.prompt, 3);
  weigh((signals.recent ?? []).join(" "), 1);
  if (signals.project) weigh(signals.project, 2);
  for (const tool of signals.recentTools ?? []) bump(inferToolGroup(tool), 4);
  const order = new Map(available.map((group, at) => [group, at]));
  return [...scores.entries()]
    .filter(([group, score]) => score > 0 && available.includes(group) && group !== "core")
    .sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .slice(0, Math.max(0, limit))
    .map(([group]) => group);
}

/** The old fixed compaction threshold, kept as the lowest the derived one may go. */
export const compactionThresholdFloor = 11000;
/** Room left for the model's own answer when working out how much conversation fits. */
export const answerReserve = 2048;

/**
 * How much conversation may build up before older turns are folded into a summary. Derived from
 * what is left once the catalog and the answer have their share, never below the old constant so a
 * large catalog cannot drive the conversation budget to nothing and make compaction thrash.
 */
export function derivedCompactionThreshold(catalog: number, limit: number, reserve = answerReserve): number {
  return Math.max(compactionThresholdFloor, limit - catalog - reserve);
}

export interface ContextBudget {
  /** The most this request may weigh. */
  limit: number;
  /** The share the instructions take inside `messages`. */
  system: number;
  /** The share the tool catalog takes. */
  catalog: number;
  /** The whole conversation, instructions included. */
  messages: number;
  /** Room held back for the answer. */
  reserve: number;
  /** What the conversation may reach before it is compacted. */
  threshold: number;
  /** What is still free; negative means the request no longer fits. */
  headroom: number;
}

/** One round's accounting: what the limit is, where it went, and what is left. */
export function contextBudget(input: { limit: number; system: number; catalog: number; messages: number; reserve?: number }): ContextBudget {
  const reserve = input.reserve ?? answerReserve;
  return {
    limit: input.limit,
    system: input.system,
    catalog: input.catalog,
    messages: input.messages,
    reserve,
    threshold: derivedCompactionThreshold(input.catalog, input.limit, reserve),
    headroom: input.limit - input.catalog - input.messages,
  };
}

/** The catalog's own weight, in the same estimated tokens the rest of the budget uses. */
export const catalogTokens = (tools: readonly ToolDescription[]): number => estimateTokens(tools);
