import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import { chatOwnerOnly, runOrigin, startedFromChat, startedWithShortLivedKey } from "../key-context.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { settingsCatalogue, specFor, type FieldSpec, type SettingSpec } from "./catalogue.js";
import { applyWithPins, changesFor, currentValue, holdable, loosens, rangeOf, type Change, type Proposal, type Range, type Value, type Writer } from "./changes.js";
import { pinnedIds } from "./pins.js";
import type { ChangeOrigin } from "./history.js";
import { planUndo, undoSettingsChange, whySetting } from "./undo.js"; // Q49
import { lockedDown } from "../lockdown.js";
import { clarifyRequest } from "./clarify.js";
import type { ToolLister } from "../preset-moves.js";

/**
 * Changing Branch's own settings by asking for it: "turn the wake word on", "switch off the learning
 * core", "which of my settings would help with this?". The owner decides; Branch says what it would
 * change and does it only on the owner's yes.
 *
 *   - `settings.find` takes the owner's own words ("turn the wake word on") and, before anything is
 *     planned, either asks one question — when the words fit several settings or none — or gives the
 *     exact before and after for the one setting they fit, leaving out what is already as asked (Q50).
 *   - `settings.list` reads the catalogue (src/settings-kit/catalogue.ts): every switch, choice and
 *     number the owner can change, with what it is set to now. Nothing else in the settings table —
 *     connections, keys, people, Lockdown — is ever listed or changed here.
 *   - `settings.change` makes ordinary changes. The runtime asks the owner first, whatever the rules
 *     say (`settingsHold`); "yes for this conversation" is remembered like any other answer.
 *   - `settings.loosen` is the only way to make a change that leaves Branch less careful or lets it
 *     reach further. It is asked about every time, a yes is never kept, and the model cannot answer
 *     it: the question goes to the owner. `settings.change` refuses such a change and says so.
 *   - Q49: `settings.why` says who or what last set one setting, from the change records only, and
 *     `settings.undo` puts back one recorded change, asked about first like `settings.change`. An
 *     undo that would leave Branch less careful is refused: that is the owner's, on the Recent
 *     changes card, because the question the owner is shown names only the record, not what it loosens.
 *
 * Every write goes through the same path as the window's presets and settings file (`applyWithPins`,
 * with the same writers), so pins, the audit record and the tools a switch adds or removes all follow.
 * Only the owner, in a conversation they started, gets any of this: a household profile, a
 * short-lived key, a chat app, a lent conversation, a schedule, a trigger or another program is refused
 * before anything is read.
 */

export const settingsToolNames = ["settings.find", "settings.list", "settings.change", "settings.loosen", "settings.why", "settings.undo"] as const;

const changeReason = "Branch asks before it changes its own settings";
/** The ordinary change's reason, which the question leaves out once its words say the change (dogfood E2). */
export const settingsChangeReason = changeReason;
const undoReason = "Branch asks before it undoes a change to its own settings";
const loosenReason = "This makes Branch less careful, so it is asked about every time";

/** Why a settings tool call must be put to the owner whatever the rules say, or null. */
export function settingsHold(tool: string, args?: unknown): { reason: string; onceOnly: boolean } | null {
  if (tool === "settings.loosen") return { reason: loosenReason, onceOnly: true };
  // A change that may leave Branch less careful is asked about every time, in the one question: the owner's yes to it
  // is what lets settings.change make it, so a less careful change never needs a second tool and a second yes.
  if (tool === "settings.change") return mayLoosen(args) ? { reason: loosenReason, onceOnly: true } : { reason: changeReason, onceOnly: false };
  if (tool === "settings.undo") return { reason: undoReason, onceOnly: false };
  return null;
}

/** Refuses anybody but the owner, in a conversation the owner started, before anything is read. */
function ownerHere(store: Store, context: ToolContext): void {
  const what = "Changing Branch's own settings";
  store.profiles.requireOwner(what);
  const origin = context.runId && store.run(context.runId) ? runOrigin(store, context.runId) : null;
  if (startedWithShortLivedKey() || origin?.shortLivedKey)
    throw new Error(`${what} is for the owner only, and a short-lived key cannot do it. Do it in the Branch app.`);
  if (startedFromChat(context, store)) throw chatOwnerOnly(what);
  if (origin?.personProfileId || origin?.lentTo)
    throw new Error(`${what} is for the owner only, and this conversation belongs to somebody else.`);
  // Either one saying "not the owner" is enough: a manual run carries its source on the context and
  // nothing in the task's record, and a helper carries it in the record and nothing on the context.
  const outside = [origin?.source, context.source].find((source) => source !== undefined && source !== "owner");
  if (outside)
    throw new Error(`${what} happens only in a conversation you started yourself, not from a ${outside}. Ask Branch in the app.`);
}

/** Whether this call comes from the owner, in a conversation they started: `ownerHere` without the throw. */
function ownerIsHere(store: Store, context: ToolContext): boolean {
  try { ownerHere(store, context); return true; } catch { return false; }
}

type Shown = string | number | boolean;
function choicesOf(field: FieldSpec): Shown[] | Range {
  if (field.kind.type === "switch") return ["off", "when-needed", "on"];
  if (field.kind.type === "yes-no") return [false, true];
  if (field.kind.type === "choice") return [...field.kind.options];
  return rangeOf(field)!;
}

/** Which way is the less careful one, in words the model can repeat. */
function carefulness(field: FieldSpec): string | null {
  if (field.guard === "reach") return "turning it up lets Branch do or reach more";
  if (field.guard === "guard") return "turning it down takes a protection away";
  return null;
}

interface Row {
  setting: string; name: string; label: string; where: string;
  value: Shown; startsAs: Shown; choices: Shown[] | Range;
  lessCareful: string | null; pinned: boolean; note?: string;
}
function row(store: Store, owner: string, spec: SettingSpec, field: FieldSpec, pinned: Set<string>): Row {
  const id = `${spec.key}.${field.field}`;
  return { setting: id, name: spec.name, label: field.label, where: spec.home, value: currentValue(store, owner, spec, field),
    startsAs: field.initial, choices: choicesOf(field), lessCareful: carefulness(field), pinned: pinned.has(id),
    ...(field.note ? { note: field.note } : {}) };
}

const ListSchema = z.object({
  search: z.string().trim().max(120).optional(),
  onlyOff: z.boolean().optional(),
  onlyChanged: z.boolean().optional(),
  offset: z.number().int().min(0).max(10000).optional(),
  limit: z.number().int().min(1).max(80).optional(),
}).strict();
type ListInput = z.infer<typeof ListSchema>;

/** The catalogue, filtered: every word of `search` must appear in the setting's name, label, key or place. */
export function listSettings(store: Store, owner: string, input: ListInput): { total: number; shown: Row[]; nextOffset: number | null } {
  const words = (input.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const pinned = pinnedIds(store, store.profiles?.ownerName ?? owner); // the same scope as changesFor
  const rows = settingsCatalogue.flatMap((spec) => spec.fields.map((field) => row(store, owner, spec, field, pinned)))
    .filter((one) => words.every((word) => `${one.setting} ${one.name} ${one.label} ${one.where}`.toLowerCase().includes(word)))
    .filter((one) => !input.onlyOff || one.value === "off" || one.value === false)
    .filter((one) => !input.onlyChanged || one.value !== one.startsAs);
  const offset = input.offset ?? 0, limit = input.limit ?? 80;
  const shown = rows.slice(offset, offset + limit);
  const end = offset + shown.length;
  return { total: rows.length, shown, nextOffset: end < rows.length ? end : null };
}

const FindSchema = z.object({
  request: z.string().trim().min(1).max(200),
  value: z.union([z.string().trim().max(40), z.number(), z.boolean()]).optional(),
}).strict();
type FindInput = z.infer<typeof FindSchema>;

const ChangeSchema = z.object({
  changes: z.array(z.object({
    setting: z.string().trim().min(3).max(160),
    value: z.union([z.string().trim().max(40), z.number(), z.boolean()]),
  }).strict()).min(1).max(40),
}).strict();
type ChangeInput = z.infer<typeof ChangeSchema>;

/** `key.field` into a proposal; the key never holds a dot, a field may ("files.soul"). */
function proposalOf(entry: ChangeInput["changes"][number]): Proposal | string {
  const dot = entry.setting.indexOf(".");
  if (dot < 1) return `"${entry.setting}" is not a setting. Use the name settings.list gives, such as wake-word.mode.`;
  const key = entry.setting.slice(0, dot), field = entry.setting.slice(dot + 1);
  if (!specFor(key)?.fields.some((one) => one.field === field)) return `"${entry.setting}" is not a setting Branch can change this way.`;
  return { key, field, value: entry.value };
}

/**
 * Whether any change a call asks for could leave Branch less careful, from the catalogue alone: from some value the
 * setting can hold now, the value asked for is the less careful way. It reads none of the owner's settings, because
 * this is worked out before the tool's own owner check, for callers that are then refused (see describe()).
 */
export function mayLoosen(args: unknown): boolean {
  const parsed = ChangeSchema.safeParse(args);
  if (!parsed.success) return false;
  return parsed.data.changes.some((entry) => {
    const made = proposalOf(entry);
    if (typeof made === "string") return false;
    const spec = specFor(made.key)!, field = spec.fields.find((one) => one.field === made.field)!;
    return holdable(field).some((from) => loosens(field, from, made.value as Value, spec));
  });
}

interface Planned { changes: Change[]; refused: string[] }
function plan(store: Store, owner: string, input: ChangeInput, tools: ToolLister | undefined): Planned {
  const proposals: Proposal[] = [];
  const refused: string[] = [];
  for (const entry of input.changes) {
    const made = proposalOf(entry);
    if (typeof made === "string") refused.push(made); else proposals.push(made);
  }
  const checked = changesFor(store, owner, proposals, tools);
  return { changes: checked.changes, refused: [...refused, ...checked.refused] };
}

/** Q48: a change asked for in a conversation is written down with the conversation it came from. */
function talked(store: Store, context: ToolContext): ChangeOrigin {
  const sessionId = context.runId ? store.run(context.runId)?.sessionId : undefined;
  return { writer: "conversation", source: "talk", detail: "asked for in a conversation", runId: context.runId, sessionId };
}

const said = (change: Change): string => `${change.name}, ${change.label}: ${String(change.from)} → ${String(change.to)}`;
/** The same, with what it would make less careful when that is known, for a refusal and for the owner's question. */
const saidWhy = (change: Change): string => `${said(change)}${change.looser ? ` (${change.looser})` : ""}`;

/**
 * What the owner is asked about: exactly what the call asks for, from the call alone. It reads
 * nothing, because the runtime works out a call's target before the tool's own owner check runs, and
 * a refused caller (a chat, a key, a household task) must not get Branch to read the owner's settings.
 */
function describe(input: ChangeInput): string {
  return input.changes.map((entry) => `${entry.setting} → ${String(entry.value)}`).join("; ").slice(0, 600);
}

/**
 * Q50: the exact before and after a settings change would make, for the question the owner is asked
 * ("Wake word, Mode: off → on"), or null. Worked out only once the caller is known to be the owner in
 * a conversation they started, so a refused caller never gets Branch to read the owner's settings;
 * `describe` above stays the call's target, which rules and kept answers match against.
 */
export function settingsPreview(store: Store, tool: string, args: unknown, context: ToolContext, tools?: ToolLister): { text: string; named: boolean } | null {
  if (tool !== "settings.change" && tool !== "settings.loosen") return null;
  const input = ChangeSchema.safeParse(args);
  if (!input.success || !ownerIsHere(store, context)) return null;
  const { changes, refused } = plan(store, context.owner, input.data, tools);
  // A pinned setting is stepped over when the change is saved, so it is shown staying as it is.
  const shown = (change: Change): string => change.pinned
    ? `${change.name}, ${change.label}: stays ${String(change.from)} (pinned)` : saidWhy(change);
  const text = (changes.length ? changes.map(shown).join("; ") : "every setting is already as asked").slice(0, 600);
  // Dogfood E2 (Mac mini's review): the words name the call whole only when every setting asked for is among them.
  return { text, named: changes.length > 0 && !refused.length };
}

/** Both change tools: the same plan, the same save, one rule about which may make Branch less careful. */
function changeTool(loosen: boolean, store: Store, writers: () => Record<string, Writer>, tools: ToolLister) {
  return async (input: ChangeInput, context: ToolContext) => {
    ownerHere(store, context);
    // Q65 review: as in the window (src/settings-kit/api.ts). Lockdown keeps its own copy of what it took over and
    // writes it back when it ends, so a change made underneath it would loosen it now or be thrown away then.
    if (lockedDown(store, context.owner)) throw new Error("Lockdown is on, so settings cannot be changed. The owner turns it off in Settings first.");
    const { changes, refused } = plan(store, context.owner, input, tools);
    const loose = changes.filter((change) => change.loosens);
    // A less careful change reaches here only after the owner's own yes to this one call: settingsHold asks about it
    // every time and never keeps the answer (mayLoosen), whatever the rules say. So the yes the owner gave is the one
    // settings.loosen would have asked for, and asking a second time made nothing change (dogfood A1).
    if (loosen && !loose.length)
      throw new Error("None of these makes Branch less careful. Use settings.change for them.");
    // NAS b86e65a: a change that loosens only from where the owner set it by hand (a "custom" choice outside its
    // list), or only by what it lets through (a move of the approval preset, Q201), was not asked about once-only,
    // since the catalogue alone could not tell. Its yes may be a kept one, so settings.change does not make it:
    // settings.loosen asks for it, every time. The words say what would get less careful when that is known.
    if (!loosen && loose.length && !mayLoosen(input))
      throw new Error(`These would make Branch less careful: ${loose.map(saidWhy).join("; ")}. Ask with settings.loosen, which asks the owner every time.`);
    if (!changes.length) return { changed: [], refused, note: "Nothing needed changing: every setting is already as asked." };
    if (context.dryRun) return { wouldChange: changes.map(said), refused };
    const { applied, skipped } = applyWithPins(store, context.owner, changes, {
      accept: changes.map((change) => change.id), confirmLoosening: loosen || loose.length > 0, why: "asked for in a conversation",
      // A pinned setting stays as the owner fixed it: only the owner, moving the switch by hand, changes it.
      pinnedAllowed: false, writers: writers(), record: talked(store, context) });
    return { changed: applied.map(said), skipped, refused };
  };
}

const WhySchema = z.object({ setting: z.string().trim().min(3).max(160) }).strict();
const UndoSchema = z.object({ record: z.string().trim().min(1).max(80) }).strict();

/** Q49: "why is this on?", answered from the change records only. */
function whyTool(store: Store) {
  return async (input: z.infer<typeof WhySchema>, context: ToolContext) => {
    ownerHere(store, context);
    const answer = whySetting(store, context.owner, input.setting);
    if (!answer) throw new Error(`"${input.setting}" is not a setting. Use the name settings.list gives, such as wake-word.mode.`);
    return answer;
  };
}

/** Q49: undoing one recorded change, never one that would leave Branch less careful. */
function undoTool(store: Store, writers: () => Record<string, Writer>, tools: ToolLister) {
  return async (input: z.infer<typeof UndoSchema>, context: ToolContext) => {
    ownerHere(store, context);
    if (lockedDown(store, context.owner)) throw new Error("Lockdown is on, so settings cannot be changed. Turn it off first.");
    const { changes } = planUndo(store, context.owner, input.record, tools);
    const loose = changes.filter((change) => change.loosens);
    if (loose.length)
      throw new Error(`Undoing this would make Branch less careful: ${loose.map(saidWhy).join("; ")}. Only the owner can do that, on the Recent changes card in Settings.`);
    if (context.dryRun) return { wouldPutBack: changes.map(said) };
    const asked = talked(store, context);
    const done = undoSettingsChange(store, context.owner, input.record, { confirmLoosening: false, writers: writers(), tools,
      by: { writer: asked.writer, runId: asked.runId, sessionId: asked.sessionId } });
    return { putBack: done.applied.map(said), record: done.record };
  };
}

export function registerSettingsTools(registry: ToolRegistry, store: Store, writers: () => Record<string, Writer>): void {
  registry.register({
    name: "settings.find", permission: "settings.read",
    description: "Before changing a setting the owner described in their own words, pass those words as request (and the value, if they said one). If it returns status \"ask\", ask the owner exactly that one question and change nothing until they answer. If it returns \"ready\", show the owner the preview (each setting from → to) and then call the tool it names. If it returns \"unchanged\", say so and change nothing.",
    parameters: FindSchema,
    target: () => "Branch's own settings",
    execute: async (input: FindInput, context: ToolContext) => { ownerHere(store, context); return clarifyRequest(store, context.owner, input, registry); },
  });
  registry.register({
    name: "settings.list", permission: "settings.read",
    description: "List Branch's own settings — every switch (off, when-needed, on), yes/no, choice and number the owner can change — with what each is set to now, how it starts, and which way is less careful. Search by words, or ask only for what is off or what was changed. Returns up to 80 rows; pass nextOffset as offset with the same filters to continue, until nextOffset is null. Use it to answer questions about Branch's settings and to suggest ones that would help; never change anything without asking.",
    parameters: ListSchema,
    target: () => "Branch's own settings",
    execute: async (input: ListInput, context: ToolContext) => { ownerHere(store, context); return listSettings(store, context.owner, input); },
  });
  registry.register({
    name: "settings.change", permission: "settings.write",
    description: "Change some of Branch's own settings, by the names settings.list gives (for example wake-word.mode to \"on\"). When the owner described the setting in their own words, call settings.find first and ask its question if it has one. The owner is asked first; a change that makes Branch less careful is asked about every time, and the owner's yes makes it.",
    parameters: ChangeSchema,
    target: (input: ChangeInput) => describe(input),
    execute: changeTool(false, store, writers, registry),
  });
  registry.register({
    name: "settings.loosen", permission: "settings.write",
    description: "Make a change to Branch's own settings that leaves it less careful or lets it reach further. The owner is asked every time, and the answer is never kept. settings.change does the same for such a change, so prefer it.",
    parameters: ChangeSchema,
    target: (input: ChangeInput) => describe(input),
    execute: changeTool(true, store, writers, registry),
  });
  registry.register({
    name: "settings.why", permission: "settings.read",
    description: "Say who or what last set one of Branch's own settings (by the name settings.list gives, such as wake-word.mode), and when: the owner in Settings, a preset, a settings file, a conversation, a typed command, or nothing that kept a record. The answer carries the change's record id, which settings.undo takes.",
    parameters: WhySchema,
    target: () => "Branch's own settings",
    execute: whyTool(store),
  });
  registry.register({
    name: "settings.undo", permission: "settings.write",
    description: "Undo one recorded change to Branch's own settings, by the record id settings.why gives, putting back exactly what each setting was before. The owner is asked first. It is refused as a whole if a setting was changed again since, is pinned, or if undoing would make Branch less careful; the owner does that one on the Recent changes card.",
    parameters: UndoSchema,
    target: (input: z.infer<typeof UndoSchema>) => `undo the settings change ${input.record}`.slice(0, 120),
    execute: undoTool(store, writers, registry),
  });
}
