import type { ToolDescription } from "./contracts.js";
import { estimateTokens } from "./contracts.js";
import { expandToolName, inferToolGroup, unrecognisedOpenUpTo, type CatalogGroup, type CatalogStats } from "./catalog.js";
import { ToolIndex, expandQuery, indexLine, nameUsedElsewhere, type ToolEmbedder, type ToolEntry, type ToolIndexOptions } from "./tool-index.js";
import { modeOfSource, type ContextMode } from "./tool-context-modes.js";

/**
 * Deciding, every round, which tools travel with the request. Three tiers:
 *
 *   loaded    the whole description and its inputs, ready to call
 *   indexed   one line — name and eight words — so the model knows the tool exists
 *   deferred  not in the request at all, and found only by searching for it
 *
 * The tools the task is always allowed (core), the ones it has just used, the ones it asked for
 * and the ones this computer has learned it needs are loaded; everything else is scored on the
 * words of the request. A hard ceiling on the whole tool section is then applied by moving the
 * weakest loaded tools down, so a thousand installed tools cost no more than a dozen.
 */
export const toolSearchName = "tools.search";
export const toolDescribeName = "tools.describe";
export const toolNoteName = "tools.note";
/** The whole tool section of one request, in estimated tokens. */
export const defaultToolBudgetTokens = 2500;
/** How many one-line tools the index may advertise. */
export const defaultIndexLines = 40;
/**
 * How many tools may travel in full at once, on top of the core ones. A task works on a handful
 * of tools at a time; the rest are a line in the index or a search away, so opening a large
 * toolbox no longer means carrying all of it.
 */
export const defaultMaxLoaded = 12;
/** Tools loaded by name never fall below this many rounds of stickiness. */
const searchedBonus = 400, expandedBonus = 60, recentBonus = 90, preloadBonus = 220, staleePenalty = 5;

/**
 * Finding tools by meaning as well as by words is off until the owner turns it on, because it
 * sends something out of this computer. This is the sentence they are shown before they decide.
 */
export const meaningSearchExplanation = (
  /** Who receives it, named: the connection that compares writing, as the owner set it up. */
  receiver = "the model you have connected for comparing writing",
): string =>
  "Branch finds a tool by the words in your request. Turn this on and it will also compare "
  + "what you asked for against what each tool says it does, which means sending your request, "
  + `and one line about each tool, to ${receiver}. `
  + "Nothing else about the request, and nothing you have saved, goes with it.";
/** Where the choice is kept. False, and nothing about a request is ever sent for this. */
export const meaningSearchSetting = "tool-meaning-search";
/** Whether the owner has turned it on. Read fresh, so turning it off takes effect at once. */
export function meaningSearchOn(
  store: { get(kind: string, owner: string, id: string): { data: unknown } | undefined }, owner: string,
): boolean {
  return (store.get("settings", owner, meaningSearchSetting)?.data as { enabled?: unknown } | undefined)?.enabled === true;
}

export interface PreloadedTool { name: string; reason: string }
/**
 * How many of a search's matches carry their own input schema. The first few are what the assistant
 * is actually choosing between; naming twenty schemas would cost more than the round it saves.
 */
export const inputsWithSearch = 3;
/** A tool the assistant has just found or asked for by name, ready to call. */
export interface FoundTool {
  name: string;
  purpose: string;
  /** What to do with it, in a sentence — the remembered note for it, when there is one. */
  use: string;
  /** Its own inputs, so it can be called in the very next step rather than looked up again. */
  inputs?: unknown;
}
export interface ToolLoaderOptions {
  /** Toolboxes open from the first round; their tools are strongly preferred. */
  expanded?: readonly string[];
  /** A tool used within this many rounds stays loaded. */
  recentRounds?: number;
  groupOf?: (name: string) => string;
  external?: (name: string) => boolean;
  noteOf?: (name: string) => string;
  budgetTokens?: number;
  indexLines?: number;
  /** The most tools that may travel in full at once, besides the core ones. */
  maxLoaded?: number;
  /** What past tasks say this one will need, loaded before the first round. */
  preload?: readonly PreloadedTool[];
  /** Tools nobody has used for a long time: not advertised unless the task asks for them. */
  demoted?: readonly string[];
  /**
   * QA Q065: tools that travel in full every round, like the core ones, and are never moved down to make room. Only a
   * tool this task may use and that is not switched off is pinned; any other name here is ignored.
   */
  pinned?: readonly string[];
  /**
   * Tools belonging to a feature the owner has switched **off**. The three-way switch already
   * promises that "off" means the feature refuses in one plain sentence and its tools are not
   * advertised — but searching still offered them, and they still won. On the plan's five-way
   * window `troubleshoot.run` (fixing failed commands: off as it ships) came first in all three of
   * one task's shell searches, ahead of `code.run`, which is the actual shell. Calling it would
   * only have been refused. These are left out of searching, out of the index and out of the loaded
   * set; asking for one by name says plainly that it is switched off.
   */
  hidden?: readonly string[];
  /**
   * Integration (mac7/speed): whether a hidden tool may be named when it is searched for or asked
   * for by name. True for the owner's own three-way switches, where "you can switch this on in
   * Settings" is the useful thing to say. **False under Lockdown**, which switches those same
   * features off and is not something the person can undo from here: naming them would both give
   * the wrong advice and say what Lockdown is there not to say. They then read as absent.
   */
  nameHidden?: boolean;
  /** The words of the task, used to score what is worth listing. */
  signals?: { prompt?: string; recent?: readonly string[]; project?: string };
  /** Set only when the owner has switched meaning search on; otherwise searching is by words. */
  embedder?: ToolEmbedder;
  /**
   * Where a tool came from ("mcp:<id>", "plugin:<id>"); the product's own tools have none. A tool with a source waits
   * in the short index until the task searches for it, asks for it by name or uses it, unless the owner set its
   * source to "always" (src/tool-context-modes.ts).
   */
  sourceOf?: (name: string) => string | undefined;
  /** The owner's choice per source, read again every round so a change reaches a task that is already working. */
  contextModes?: () => Readonly<Record<string, ContextMode>>;
}
export interface LoaderStats extends CatalogStats {
  loaded: number;
  indexed: number;
  deferred: number;
  budgetTokens: number;
  preloadedFromHistory: string[];
}
interface Plan {
  loaded: ToolEntry[];
  indexed: ToolEntry[];
  deferred: number;
  descriptions: ToolDescription[];
}

export class ToolLoader {
  private index: ToolIndex;
  private readonly byName = new Map<string, ToolDescription>();
  /**
   * Where each tool sits in the registry. The tool section is sent in this order rather than in
   * score order, so the part of a request a provider can cache does not shuffle when the
   * assistant simply uses one of the tools it already had.
   */
  private readonly order = new Map<string, number>();
  private readonly expandedGroups = new Set<string>(["core"]);
  /** Toolboxes the assistant opened itself: an explicit ask, preferred over a guess. */
  private readonly openedGroups = new Set<string>();
  private readonly counts = new Map<string, number>();
  private readonly usedAt = new Map<string, number>();
  private readonly asked = new Set<string>();
  /**
   * selfdev: tools the task named in tools.describe, newest last. tools.describe answers "loaded, call it now",
   * and a model whose tools are its own (Claude through the owner's subscription) can call only what its tool list
   * holds, so these travel in full even past the ceiling, never squeezed out by a guess. At most `namedKept`.
   */
  private readonly named = new Set<string>();
  /** Tools that have already travelled to the model in full in this task; see `plan()`. */
  private readonly sent = new Set<string>();
  private readonly preloaded: PreloadedTool[];
  private readonly demoted: Set<string>;
  private readonly hidden: Set<string>;
  private readonly pinned: Set<string>;
  /** Whether a hidden tool may be named at all; see `ToolLoaderOptions.nameHidden`. */
  private readonly nameHidden: boolean;
  private readonly recentRounds: number;
  private readonly budgetTokens: number;
  private readonly indexLines: number;
  private readonly maxLoaded: number;
  private readonly groupOf: (name: string) => string;
  private readonly sourceOf: (name: string) => string | undefined;
  private readonly contextModes: () => Readonly<Record<string, ContextMode>>;
  private readonly signals: { prompt?: string; recent?: readonly string[]; project?: string };
  private round = 0;
  private version = 0;
  private cached: { at: number; plan: Plan } | undefined;
  constructor(private all: readonly ToolDescription[], options: ToolLoaderOptions = {}) {
    this.groupOf = options.groupOf ?? inferToolGroup;
    this.sourceOf = options.sourceOf ?? (() => undefined);
    this.contextModes = options.contextModes ?? (() => ({}));
    this.recentRounds = options.recentRounds ?? 3;
    this.budgetTokens = options.budgetTokens ?? defaultToolBudgetTokens;
    this.indexLines = options.indexLines ?? defaultIndexLines;
    this.maxLoaded = options.maxLoaded ?? defaultMaxLoaded;
    this.signals = options.signals ?? {};
    this.demoted = new Set(options.demoted ?? []);
    this.hidden = new Set(options.hidden ?? []);
    this.pinned = new Set(options.pinned ?? []);
    this.nameHidden = options.nameHidden ?? true;
    this.index = new ToolIndex(all, options);
    if (options.embedder) this.index.embedder = options.embedder;
    this.take(all);
    for (const group of options.expanded ?? []) this.expandedGroups.add(group);
    this.preloaded = (options.preload ?? []).filter((entry) => this.byName.has(entry.name));
    for (const entry of this.preloaded) this.asked.add(entry.name);
  }
  /** What history said to load before the first round, and why. */
  preloadedFromHistory(): PreloadedTool[] { return [...this.preloaded]; }
  /**
   * The toolboxes the assistant opened for itself in this task, as opposed to the ones that are
   * always open or were guessed from the words of the request. These are the ones worth carrying
   * into the next task in the same conversation: an explicit ask is not a guess.
   */
  openedToolboxes(): string[] { return [...this.openedGroups]; }
  /**
   * Takes in tools that arrived while the task was working — a server that has just connected, a
   * plugin the owner switched on — so they are searchable from the next round. Everything the task
   * has already opened, found or used is kept.
   */
  refresh(tools: readonly ToolDescription[], options: ToolIndexOptions = {}): void {
    this.all = tools;
    const embedder = this.index.embedder;
    this.index = new ToolIndex(tools, { groupOf: this.groupOf, ...options });
    if (embedder) this.index.embedder = embedder;
    this.take(tools);
    this.version++;
  }
  /** Files every tool by name, by toolbox and by the place it holds in the registry. */
  private take(tools: readonly ToolDescription[]): void {
    this.byName.clear(); this.counts.clear(); this.order.clear();
    for (const [at, tool] of tools.entries()) {
      this.byName.set(tool.name, tool);
      this.order.set(tool.name, at);
      const group = this.groupOf(tool.name);
      this.counts.set(group, (this.counts.get(group) ?? 0) + 1);
    }
  }
  nextRound(): void { this.round++; this.version++; }
  noteUse(name: string): void { this.usedAt.set(name, this.round); this.version++; }
  groups(): CatalogGroup[] {
    return [...this.counts].map(([group, tools]) => ({ group, tools, expanded: this.isOpen(group) }));
  }
  /**
   * Whether a toolbox is open. "other" holds tools whose names the product does not recognise — an
   * installed skill, a connected server — so nothing in the words of a request can point at them
   * and nothing would bring them back. A handful stay in view; once there are enough of them to be
   * worth hiding, they close and are reached by searching like everything else.
   */
  private isOpen(group: string): boolean {
    return this.expandedGroups.has(group) || this.smallUnknownBox(group);
  }
  private smallUnknownBox(group: string): boolean {
    return group === "other" && (this.counts.get(group) ?? 0) <= unrecognisedOpenUpTo;
  }
  /** Opens toolboxes, the older way of finding tools, now a shortcut over the same index. */
  expand(names: readonly string[]): { opened: string[]; unknown: string[]; tools: { name: string; description: string }[] } {
    const known = new Set(this.counts.keys());
    const opened: string[] = [], unknown: string[] = [];
    for (const raw of names) {
      const name = String(raw).trim().toLowerCase();
      if (!known.has(name)) unknown.push(name);
      else if (!this.openedGroups.has(name)) { this.expandedGroups.add(name); this.openedGroups.add(name); opened.push(name); }
    }
    this.version++;
    const inOpened = new Set(opened);
    return { opened, unknown, tools: this.index.entries.filter((entry) => inOpened.has(entry.group))
      .map((entry) => ({ name: entry.name, description: entry.purpose })) };
  }
  /**
   * Finds tools by what the person wants to do. Only tools this task is already allowed to use are
   * in the index at all, so a narrowed task can never find one it is not permitted; every match
   * stays loaded for the rest of the conversation, as far as the budget allows.
   */
  async search(query: string, limit = 8): Promise<{ matches: FoundTool[]; searched: string; switchedOff?: string[] }> {
    const wanted = Math.min(Math.max(1, limit), 20);
    const found = this.index.embedder
      ? await this.index.searchByMeaning(query, wanted + this.hidden.size) : this.index.search(query, wanted + this.hidden.size);
    // A feature the owner switched off refuses; offering its tools as the answer to "what can do
    // this" costs a round and teaches nothing.
    const hits = found.filter((hit) => !this.hidden.has(hit.entry.name)).slice(0, wanted);
    // A tool that is here but switched off is not offered — calling it would only be refused — but
    // the assistant is told it exists, by name, so it can say which setting would allow it instead
    // of telling the person Branch cannot do the thing at all. A fresh install has everything off;
    // "off" must not read as "absent".
    const offButHere = this.nameHidden
      ? found.filter((hit) => this.hidden.has(hit.entry.name)).slice(0, wanted).map((hit) => hit.entry.name)
      : [];
    for (const hit of hits) this.asked.add(hit.entry.name);
    this.version++;
    return { searched: String(query).slice(0, 200),
      matches: hits.map((hit, at) => this.found(hit.entry.name, hit.entry.purpose, hit.entry.note, at < inputsWithSearch)),
      ...(offButHere.length ? { switchedOff: offButHere } : {}) };
  }
  /** Loads named tools. A name this task may not use is unknown here, exactly like a misspelling. */
  describe(names: readonly string[]): { loaded: FoundTool[]; unknown: string[]; switchedOff?: string[] } {
    const loaded: FoundTool[] = [], unknown: string[] = [], switchedOff: string[] = [];
    for (const raw of names.slice(0, 16)) {
      const asked = String(raw).trim();
      // mac7/speed: a model that has worked with other coding assistants asks for their names.
      // `shell.execute` was asked for by name twice in one bench task and refused both times.
      // The real name is tried first, so nothing here can shadow a tool that actually exists.
      const here = this.index.entry(asked) ? asked : (nameUsedElsewhere(asked) ?? asked);
      const entry = this.index.entry(here);
      if (!entry) { unknown.push(asked); continue; }
      // Named outright rather than called "unknown": the owner can switch it on, and a task told
      // "that does not exist" would go looking for something else instead of saying so.
      if (this.hidden.has(here)) { (this.nameHidden ? switchedOff : unknown).push(this.nameHidden ? here : asked); continue; }
      this.asked.add(here);
      this.named.delete(here); this.named.add(here);
      while (this.named.size > namedKept) this.named.delete(this.named.values().next().value!);
      const found = this.found(here, entry.purpose, entry.note, true);
      loaded.push(here === asked ? found
        : { ...found, use: `${asked} is called ${here} here. ${found.use}` });
    }
    this.version++;
    return { loaded, unknown, ...(switchedOff.length ? { switchedOff } : {}) };
  }
  /**
   * One tool as an answer to "what can do this". `inputs` is the tool's own schema, sent with the
   * best few matches so the tool can be **called straight away**.
   *
   * Before this, a search said "its inputs are in the tool list from your next step", and the only
   * way to get them was another round. Window 8 on the plan shows what that cost: 27 of Branch's 95
   * rounds did no work on the task at all, they looked for a tool — and `fix-range` spent five of
   * its ten rounds alternating search, search, describe, search, describe before calling anything.
   * A round trip is the whole cost of a task, so handing back the inputs with the answer removes one
   * every time a tool has to be found.
   */
  private found(name: string, purpose: string, note: string, withInputs: boolean): FoundTool {
    const base = this.byName.get(name);
    return {
      name, purpose,
      use: note || `Call ${name} now; its inputs are below.`,
      ...(withInputs && base ? { inputs: base.parameters } : {}),
    };
  }
  /** What this task has done counts on top of the words: asked for, opened, or used just now. */
  private bonusFor(entry: ToolEntry, waiting: boolean): number {
    let score = 0;
    if (this.asked.has(entry.name)) score += this.preloaded.some((p) => p.name === entry.name) ? preloadBonus : searchedBonus;
    // A tool nothing in a request can point at has to be carried or it is lost, so a small box of
    // unrecognised names counts as strongly as a toolbox the assistant opened on purpose. A tool whose
    // source the owner left on "load when needed" is not carried that way: it has its line in the index.
    if (this.openedGroups.has(entry.group) || (!waiting && this.smallUnknownBox(entry.group))) score += searchedBonus;
    else if (!waiting && this.expandedGroups.has(entry.group)) score += expandedBonus;
    if (this.justUsed(entry)) score += recentBonus;
    if (this.demoted.has(entry.name)) score -= staleePenalty;
    return score;
  }
  /**
   * A tool the assistant has called in the last few rounds. It is in the middle of using it, so it
   * keeps its place whatever else is competing for one: a tool that vanishes between the call and
   * the follow-up call leaves the task stuck.
   */
  private justUsed(entry: ToolEntry): boolean {
    const at = this.usedAt.get(entry.name);
    return at !== undefined && this.round - at <= this.recentRounds;
  }
  /** A core tool, or one pinned beside them; the index holds only tools this task may use (see `search`). */
  private always(entry: ToolEntry): boolean {
    return entry.group === "core" || (this.pinned.has(entry.name) && this.byName.has(entry.name) && !this.hidden.has(entry.name));
  }
  descriptions(): ToolDescription[] { return this.plan().descriptions; }
  stats(): LoaderStats {
    const plan = this.plan();
    const characters = JSON.stringify(plan.descriptions).length;
    return {
      tools: this.all.length, shown: plan.descriptions.length, groups: this.counts.size,
      collapsed: this.groups().filter((group) => !group.expanded).length,
      characters, estimatedTokens: Math.ceil(characters / 4),
      loaded: plan.loaded.length, indexed: plan.indexed.length, deferred: plan.deferred,
      budgetTokens: this.budgetTokens, preloadedFromHistory: this.preloaded.map((entry) => entry.name),
    };
  }
  /** What is loaded, listed and left out this round. Worked out once and reused within the round. */
  private plan(): Plan {
    if (this.cached && this.cached.at === this.version) return this.cached.plan;
    const terms = queryTerms(this.signals);
    // Read once per round: a source switched to "always" or back reaches a working task from its next round.
    const modes = this.contextModes();
    const modeOf = (name: string): ContextMode | undefined => {
      const source = this.sourceOf(name);
      return source === undefined ? undefined : modeOfSource(modes, source);
    };
    // Ties are broken by the order tools were registered in, never by their names. Opening a large
    // toolbox scores most of its tools the same, so the cap below decides which of them travel; when
    // that decision went alphabetically, registering one new tool whose name happened to sort early
    // silently pushed an existing one out, and the test that noticed was in another area entirely.
    // Registration order keeps what is already there in place and puts anything new at the back.
    const scored = this.index.entries.map((entry, at) => {
      const lexical = this.index.score(terms, entry);
      const mode = modeOf(entry.name);
      return { entry, at, lexical, mode, score: lexical + this.bonusFor(entry, mode === "when-needed") };
    }).sort((a, b) => b.score - a.score || a.at - b.at);
    // A source the owner set to "always" travels in full every round, like the core: never guessed at, never squeezed.
    const always = (hit: { entry: ToolEntry; mode: ContextMode | undefined }) => hit.mode === "always" && !this.hidden.has(hit.entry.name);
    const core = scored.filter((hit) => this.always(hit.entry) || always(hit)).map((hit) => hit.entry);
    const rest = scored.filter((hit) => !this.always(hit.entry) && !always(hit));
    // One on "load when needed" comes in only when the task asked for it, opened its toolbox itself or used it.
    const reachable = (hit: { entry: ToolEntry; mode: ContextMode | undefined }) => hit.mode === "when-needed"
      ? this.openedGroups.has(hit.entry.group) : this.isOpen(hit.entry.group);
    const candidates = rest.filter((hit) => hit.score > 0 && !this.hidden.has(hit.entry.name)
      && (this.asked.has(hit.entry.name) || reachable(hit) || this.usedAt.has(hit.entry.name)));
    // Tools in use come first and are never squeezed out by the cap; the rest fill what is left,
    // best first, and are the ones the ceiling takes back if the section is still too heavy.
    const inUse = candidates.filter((hit) => this.justUsed(hit.entry));
    const others = candidates.filter((hit) => !this.justUsed(hit.entry));
    // Which tools get a place is decided on merit exactly as it always was. What is new is the
    // line after: a tool that has already travelled in full and did not win a place this round is
    // put back on the end rather than dropped. Before this, the first edit of a task took the last
    // free place and pushed whichever tool scored lowest out — eighteen tools went out, eighteen
    // came back, one of them different — and every provider holding the front of the request had to
    // read the whole thing again from that round on. There was no shortage of room when it
    // happened: 1,362 tokens of the 2,500 the tool section is allowed. The count is a count of
    // guesses worth making, not a reason to take away a tool the task has already been shown.
    // Kept tools go last, so the token budget in `fit` — the ceiling the model actually feels —
    // takes them back first if the section really is too heavy.
    // A tool the task asked for by name — found by searching, or pre-loaded because history or a
    // switch says this work needs it — is not a guess, and is not made to compete for a place with
    // one. The count is then shared among the toolboxes the guesses come from, so no single box can
    // take every remaining place (see `shareOut`).
    const requested = others.filter((hit) => this.asked.has(hit.entry.name));
    const rest2 = others.filter((hit) => !this.asked.has(hit.entry.name));
    // A toolbox the assistant opened for itself is an explicit ask too, so its tools fill the
    // places in score order exactly as they did before. Only the boxes the *product* guessed from
    // the words of the request share what is left, so no guess can take every place.
    const opened = rest2.filter((hit) => this.openedGroups.has(hit.entry.group));
    const guesses = rest2.filter((hit) => !this.openedGroups.has(hit.entry.group));
    const room = Math.max(0, this.maxLoaded - inUse.length - requested.length);
    const fromOpened = opened.slice(0, room);
    const onMerit = [...requested, ...fromOpened, ...shareOut(guesses, Math.max(0, room - fromOpened.length))];
    const chosen = new Set([...inUse, ...onMerit].map((hit) => hit.entry.name));
    const kept = others.filter((hit) => this.sent.has(hit.entry.name) && !chosen.has(hit.entry.name));
    const wanted = [...inUse, ...onMerit, ...kept];
    // Only tools the words of the request actually point at are worth a line; the rest are a
    // search away, and saying so once costs less than naming forty tools nobody asked about.
    const listable = rest.filter((hit) => hit.lexical > 0 && !this.demoted.has(hit.entry.name)
      && !this.hidden.has(hit.entry.name)).map((hit) => hit.entry);
    // What each tool is to this round, for the budget's ceiling: in use, won on merit, or only kept from before.
    // A tool the task found or named is not one of the product's guesses: under the ceiling it goes after them.
    const found = (hit: { entry: ToolEntry }): Role =>
      this.asked.has(hit.entry.name) && !this.preloaded.some((p) => p.name === hit.entry.name) ? "found" : "merit";
    const role = new Map<string, Role>([...inUse.map((hit) => [hit.entry.name, "use"] as const),
      ...onMerit.map((hit) => [hit.entry.name, found(hit)] as const), ...kept.map((hit) => [hit.entry.name, "kept"] as const)]);
    for (const name of this.named) if (role.has(name)) role.set(name, "named");
    const waiting = rest.filter((hit) => hit.mode === "when-needed" && !this.hidden.has(hit.entry.name)).map((hit) => hit.entry);
    const plan = this.fit(core, wanted.map((hit) => hit.entry), listable, rest.length, role, waiting);
    for (const entry of plan.loaded) this.sent.add(entry.name);
    this.cached = { at: this.version, plan };
    return plan;
  }
  /**
   * Brings the tool section under its ceiling. The weakest loaded tool is moved down to a line in
   * the index first, while it is only a guess or kept from before; a tool the task found or is using
   * outranks the index, so the index is trimmed before one of those goes. With a thousand tools the
   * index lines are the product's own guesses too, and a longer one used to push a just-found tool
   * out of the round that was meant to call it. Each step is strictly smaller than the one before,
   * so this always terminates under the budget.
   */
  private fit(core: ToolEntry[], wanted: ToolEntry[], listable: ToolEntry[], total: number, role: ReadonlyMap<string, Role>,
    waiting: readonly ToolEntry[] = []): Plan {
    let loaded = [...wanted];
    let lines = this.indexLines;
    for (let step = 0; step <= wanted.length + this.indexLines; step++) {
      const shown = new Set(loaded.map((entry) => entry.name));
      const indexed = listable.filter((entry) => !shown.has(entry.name)).slice(0, lines);
      const deferred = total - loaded.length - indexed.length;
      const descriptions = this.render([...core, ...loaded], indexed, deferred, sourceIndex(waiting, shown, indexed, this.sourceOf));
      if (estimateTokens(descriptions) < this.budgetTokens || (!loaded.length && !lines))
        return { loaded: [...core, ...loaded], indexed, deferred, descriptions };
      const fewer = loaded.length ? withoutWeakest(loaded, role, core) : loaded;
      const leaving = loaded.find((entry, at) => fewer[at] !== entry);
      const asked = leaving !== undefined && ["found", "use"].includes(role.get(leaving.name) ?? "merit");
      if (fewer.length < loaded.length && !(asked && lines)) loaded = fewer;
      else if (lines) lines = Math.max(0, lines - 4);
      // Only tools the task named itself are left: they travel, as tools.describe said they would.
      else return { loaded: [...core, ...loaded], indexed, deferred, descriptions };
    }
    return { loaded: core, indexed: [], deferred: total, descriptions: this.render(core, [], total, sourceIndex(waiting, new Set(), [], this.sourceOf)) };
  }
  /** The tool list as the model receives it: full tools, then the index, then the toolbox opener. */
  private render(loaded: readonly ToolEntry[], indexed: readonly ToolEntry[], deferred: number, sources: readonly string[] = []): ToolDescription[] {
    const full = [...loaded].sort((a, b) => Number(a.group !== "core") - Number(b.group !== "core")
      || (this.order.get(a.name) ?? 0) - (this.order.get(b.name) ?? 0)).map((entry) => {
      const base = this.byName.get(entry.name)!;
      return { name: base.name, parameters: base.parameters,
        description: entry.note ? `${entry.description} Remembered: ${entry.note}` : entry.description };
    });
    const closed = this.groups().filter((group) => !group.expanded && group.tools);
    return [...full, searchTool(indexed, deferred, this.index.size, sources), describeTool(), noteTool(),
      ...(closed.length ? [opener(closed)] : [])];
  }
}

/**
 * Shares the places among the toolboxes in play instead of letting one of them take every place.
 *
 * "Add a --verbose flag to the command line and document it in the README" opens two toolboxes,
 * code and documents. The words say "document" and "README" loudly, so every one of the twelve
 * places went to documents tools and the task was shown **none** of the twelve coding tools — not
 * files.read, not files.edit. Opening a toolbox and then being shown nothing from it is a defect,
 * and it costs a whole round trip: the task has to search for a tool before it can begin.
 *
 * So the best tool from each box is taken, then the second best from each, and so on, until the
 * places run out. The order tools are sent in does not change (that is decided in `render`), the
 * count does not change, and a box that wins on merit still gets more places than one that does
 * not — it simply cannot take them all.
 */
/** What a loaded tool is to this round: one the task is using, one that won a place on merit, or one only kept from before. */
type Role = "use" | "found" | "merit" | "kept" | "named";
/** selfdev: how many tools named in tools.describe are kept in full at once. */
const namedKept = 24;
/**
 * The loaded tools less the one the section can best spare, the last of the weakest kind: a tool only kept from an earlier
 * round goes first; then one that won a place on merit whose toolbox still has another tool loaded, so every toolbox that
 * won a place keeps one while the budget allows; then any tool that won on merit; then one the task found or named
 * itself; a tool in use goes last of all.
 */
function withoutWeakest(loaded: readonly ToolEntry[], role: ReadonlyMap<string, Role>, always: readonly ToolEntry[] = []): ToolEntry[] {
  const inBox = new Map<string, number>();
  // A pinned tool travels whatever happens, so a box that has one still has a tool when its last loaded one goes.
  for (const entry of [...always, ...loaded]) inBox.set(entry.group, (inBox.get(entry.group) ?? 0) + 1);
  const roleOf = (entry: ToolEntry): Role => role.get(entry.name) ?? "merit";
  const lastWhere = (keep: (entry: ToolEntry) => boolean): number => {
    for (let at = loaded.length - 1; at >= 0; at--) if (keep(loaded[at]!)) return at;
    return -1;
  };
  const at = [lastWhere((entry) => roleOf(entry) === "kept"),
    lastWhere((entry) => roleOf(entry) === "merit" && (inBox.get(entry.group) ?? 0) > 1),
    lastWhere((entry) => roleOf(entry) === "merit"), lastWhere((entry) => roleOf(entry) === "found"),
    lastWhere((entry) => roleOf(entry) !== "named")]
    .find((found) => found >= 0) ?? -1;
  return at < 0 ? [...loaded] : [...loaded.slice(0, at), ...loaded.slice(at + 1)];
}

function shareOut<T extends { entry: { group: string }; score: number; at: number }>(ranked: readonly T[], room: number): T[] {
  if (ranked.length <= room) return [...ranked];
  const queues = new Map<string, T[]>();
  for (const hit of ranked) queues.set(hit.entry.group, [...(queues.get(hit.entry.group) ?? []), hit]);
  const taken: T[] = [];
  // Best box first, because `ranked` is in score order and a Map keeps the order keys arrived in.
  while (taken.length < room) {
    const before = taken.length;
    for (const queue of queues.values()) {
      if (taken.length >= room) break;
      const next = queue.shift();
      if (next) taken.push(next);
    }
    if (taken.length === before) break; // every box is empty
  }
  return taken.sort((a, b) => b.score - a.score || a.at - b.at);
}

const queryTerms = (signals: { prompt?: string; recent?: readonly string[]; project?: string }): string[] =>
  [...new Set(expandQuery([signals.prompt ?? "", (signals.recent ?? []).join(" "), signals.project ?? ""].join(" ")))];

/**
 * The short index of tools whose source is on "load when needed" and that are neither loaded nor already listed this
 * round. A few of them are listed one line each, name and purpose; once there are more than that, each source gets one
 * line — its name, how many tools, and while there are few sources the first words of what its first tools do — so ten
 * connected servers cost about as much as one tool. Everything is still found by `tools.search`.
 */
export const sourceLinesUpTo = 4;
const sourcesWithPurposesUpTo = 6;
export function sourceIndex(waiting: readonly ToolEntry[], loaded: ReadonlySet<string>, indexed: readonly ToolEntry[],
  sourceOf: (name: string) => string | undefined): string[] {
  const listed = new Set(indexed.map((entry) => entry.name));
  const left = waiting.filter((entry) => !loaded.has(entry.name) && !listed.has(entry.name));
  if (!left.length) return [];
  if (left.length <= sourceLinesUpTo) return left.map(indexLine);
  const bySource = new Map<string, ToolEntry[]>();
  for (const entry of left) {
    const source = sourceOf(entry.name) ?? entry.group;
    bySource.set(source, [...(bySource.get(source) ?? []), entry]);
  }
  const few = bySource.size <= sourcesWithPurposesUpTo;
  return [...bySource].map(([source, entries]) => `${source} (${entries.length})${few
    ? `: ${entries.slice(0, 3).map((entry) => entry.purpose.split(" ").slice(0, 5).join(" ")).join("; ")}` : ""}`);
}

/** The searcher, carrying the short index of tools that are not loaded this round. */
function searchTool(indexed: readonly ToolEntry[], deferred: number, total: number, sources: readonly string[] = []): ToolDescription {
  const listed = (indexed.length ? `\nSome of what is here:\n${indexed.map(indexLine).join("\n")}` : "")
    + (sources.length ? `\nConnected, loaded when needed (search by what you want or by the source's name, or load a name with ${toolDescribeName}):\n${sources.join("\n")}` : "");
  return {
    name: toolSearchName,
    description: `Find a tool by saying what you want to do, in your own words. There are ${total} tools on this computer and ${deferred} of them are not described in this message at all; searching is how you reach them, and anything you find stays available afterwards. Search before saying a task cannot be done.${listed}`,
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  };
}
const describeTool = (): ToolDescription => ({
  name: toolDescribeName,
  description: "Load tools you already know the exact names of, so you can call them. A name that is not here is unknown.",
  parameters: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
});
const noteTool = (): ToolDescription => ({
  name: toolNoteName,
  description: "Remember one short thing about a tool for next time, such as a value it always needs. The person can read and delete these.",
  parameters: { type: "object", properties: { tool: { type: "string" }, note: { type: "string" } }, required: ["tool", "note"] },
});
function opener(closed: CatalogGroup[]): ToolDescription {
  const list = closed.map((group) => `${group.group}: ${group.tools}`).join("; ");
  return {
    name: expandToolName,
    description: `Open a whole toolbox at once when a task clearly belongs to one. Still closed — ${list}. Searching by what you want to do is usually quicker.`,
    parameters: { type: "object", properties: { groups: { type: "array", items: { type: "string", enum: closed.map((group) => group.group) } } }, required: ["groups"] },
  };
}
