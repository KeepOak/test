import { z } from "zod";
import type { Store } from "../store.js";
import { audit } from "../audit.js";
import { securityShaped, secretShaped, settingsCatalogue, specFor, switchPositions, type FieldSpec, type SettingSpec } from "./catalogue.js";
import { pinnedIds, pinnedRefusal, pinFor } from "./pins.js"; // mac7/wake-pins
import { recordSettingsChange, type ChangeOrigin } from "./history.js"; // Q48
import type { ToolLister } from "../preset-moves.js";
import { markChosen } from "../ship-on.js";

/**
 * R17-S-A: one list of changes, whoever proposed them — putting settings back, a whole-app preset,
 * or a settings file. The owner sees the list, ticks what they want, and only those are written.
 * A change that makes Branch less careful is marked, and is refused unless the owner said yes to
 * that in as many words.
 */
export type Value = string | number | boolean;

export interface Change {
  /** `key.field`, which is also what the owner ticks. */
  id: string;
  key: string;
  field: string;
  name: string;
  nameT: string;
  label: string;
  labelT: string;
  home: string;
  from: Value;
  to: Value;
  /** True when this change makes Branch less careful or lets it reach further. */
  loosens: boolean;
  /** For a setting weighed by what it lets through (the approval preset): what would get less careful, in plain words. */
  looser?: string;
  /**
   * mac7/wake-pins: the owner pinned this setting. A whole-app preset, a settings file and putting
   * everything back all step over it rather than failing, so one pinned switch never stops an
   * import; the owner changes it by moving that one switch, or by unpinning it first.
   */
  pinned: boolean;
}

/** A value proposed for one field, before it has been checked. */
export interface Proposal { key: string; field: string; value: unknown }

const readPath = (data: Record<string, unknown>, field: string): unknown =>
  field.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), data);

function writePath(data: Record<string, unknown>, field: string, value: Value): Record<string, unknown> {
  const [head, rest] = field.split(/\.(.*)/s, 2) as [string, string | undefined];
  if (!rest) return { ...data, [head]: value };
  const inner = data[head] && typeof data[head] === "object" ? data[head] as Record<string, unknown> : {};
  return { ...data, [head]: writePath(inner, rest, value) };
}

/** The value a field accepts, or undefined when the proposal is not one it could hold. */
export function acceptValue(spec: FieldSpec, value: unknown): Value | undefined {
  const kind = spec.kind;
  // A number that also takes a word for "no figure of the owner's own" (the round limit's "auto").
  if (kind.type === "number" && kind.unset !== undefined && value === kind.unset) return kind.unset;
  // ...and one for no limit at all ("no limit"; "none" and "unlimited" are read as it too).
  if (kind.type === "number" && kind.unlimited !== undefined && typeof value === "string" && unlimitedWords.has(value.trim().toLowerCase())) return kind.unlimited;
  const schema = kind.type === "switch" ? z.enum(switchPositions)
    : kind.type === "yes-no" ? z.boolean()
      : kind.type === "choice" ? z.enum(kind.options as [string, ...string[]])
        : z.number().int().min(kind.min).max(kind.max);
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A number's range, and the words it also takes when it has them (the round limit's "auto", a task limit's "no limit"). */
export type Range = { min: number; max: number; or?: string; unlimited?: string };
export function rangeOf(field: FieldSpec): Range | null {
  const kind = field.kind;
  if (kind.type !== "number") return null;
  return { min: kind.min, max: kind.max, ...(kind.unset !== undefined ? { or: kind.unset } : {}), ...(kind.unlimited !== undefined ? { unlimited: kind.unlimited } : {}) };
}
/** The words read as a task limit's "no limit". */
const unlimitedWords = new Set(["no limit", "none", "unlimited", "no-limit"]);

/** What the field holds now; an unset or unreadable value counts as its starting value. */
export function currentValue(store: Store, owner: string, spec: SettingSpec, field: FieldSpec): Value {
  const data = spec.read ? spec.read(store, owner) : (store.get("settings", owner, spec.key)?.data ?? {}) as Record<string, unknown>;
  let saved = readPath(data, field.field);
  // An older record with only a yes/no stands for "when needed" (src/feature-switches.ts, modeOf).
  if (saved === undefined && field.field === "mode" && spec.keepsEnabled && data.enabled === true) saved = "when-needed";
  const accepted = acceptValue(field, saved);
  if (accepted !== undefined) return accepted;
  // A number saved between whole steps, on a setting the app itself keeps that way (the dictation wait takes
  // 1.5 seconds), is read as it is, so a change from it is weighed against what is really in force.
  const kind = field.kind;
  if (kind.type === "number" && kind.fractions && typeof saved === "number" && Number.isFinite(saved) && saved >= kind.min && saved <= kind.max) return saved;
  // A choice saved outside the list ("custom" approval rules) is shown as it is, and counts as the
  // least known position, so moving away from it asks for the separate yes. The approval preset is the
  // exception: a move of it is weighed by what the rules answer before and after (`SettingSpec.weigh`).
  return field.kind.type === "choice" && typeof saved === "string" ? saved.slice(0, 40) : field.initial;
}

/** Every value a field can hold (a number's two ends): enough to tell whether one value is its most careful. */
export function holdable(field: FieldSpec): Value[] {
  const kind = field.kind;
  if (kind.type === "switch") return [...switchPositions];
  if (kind.type === "yes-no") return [true, false];
  if (kind.type === "choice") return [...kind.options];
  return [kind.min, kind.max];
}

/** Ordered magnitude; loosens() applies the field's protective or reach direction. */
function reachOf(field: FieldSpec, value: Value): number {
  const kind = field.kind;
  if (kind.type === "switch") return switchPositions.indexOf(value as (typeof switchPositions)[number]);
  if (kind.type === "yes-no") return value ? 1 : 0;
  if (kind.type === "choice") return kind.options.indexOf(String(value));
  return value as number;
}

export function loosens(field: FieldSpec, from: Value, to: Value, spec?: Pick<SettingSpec, "key">): boolean {
  // Fails closed: a "plain" field on a setting that sounds like safety counts as less careful either way.
  if (field.guard === "plain") return !!spec && securityShaped.test(spec.key) && from !== to;
  const up = reachOf(field, to) > reachOf(field, from);
  const down = reachOf(field, to) < reachOf(field, from);
  // A choice list is written most careful first, so moving along it is loosening whichever guard it is.
  if (field.kind.type === "choice") return up;
  return field.guard === "reach" ? up : down;
}

/**
 * Turns proposals into the changes they would make. Anything that is not in the catalogue, sounds
 * like a secret, or is not a value the field can hold is refused with a reason; anything that would
 * change nothing is left out. `tools` are the tools Branch has, which a move of the approval preset
 * is weighed on; without them such a move counts as less careful.
 */
export function changesFor(store: Store, owner: string, proposals: readonly Proposal[], tools?: ToolLister): { changes: Change[]; refused: string[] } {
  const changes: Change[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  // mac7/wake-pins. Integration review: a store with no book of profiles has nobody but the owner
  // on it, so there is nothing for a pin to hold back and the owner's own name is the scope.
  const pinned = pinnedIds(store, store.profiles?.ownerName ?? owner);
  for (const proposal of proposals.slice(0, 500)) {
    const spec = specFor(proposal.key);
    const field = spec?.fields.find((entry) => entry.field === proposal.field);
    const id = `${proposal.key}.${proposal.field}`;
    if (!spec || !field || secretShaped.test(proposal.field)) { refused.push(`${id}: not a setting that can be changed from here`); continue; }
    const to = acceptValue(field, proposal.value);
    if (to === undefined) { refused.push(`${id}: not a value this setting can hold`); continue; }
    // Q65 review: a setting that cannot be changed right now is refused here, before anything is written.
    const refusal = spec.refuses?.(store, owner);
    if (refusal) { refused.push(`${id}: ${refusal}`); continue; }
    const from = currentValue(store, owner, spec, field);
    if (from === to || seen.has(id)) continue;
    seen.add(id);
    let looser: string | null | undefined;
    try { looser = spec.weigh?.(store, owner, field.field, to, tools); }
    catch (error) { refused.push(`${id}: ${(error as Error).message}`); continue; }
    changes.push({ id, key: spec.key, field: field.field, name: spec.name, nameT: spec.t, label: field.label, labelT: field.t,
      home: spec.home, from, to, loosens: looser === undefined ? loosens(field, from, to, spec) : looser !== null,
      ...(looser ? { looser } : {}), pinned: pinned.has(id) });
  }
  return { changes, refused };
}

/** Everything put back to how it started, or one setting only. */
export function resetProposals(key?: string): Proposal[] {
  return settingsCatalogue.filter((spec) => !key || spec.key === key)
    .flatMap((spec) => spec.fields.map((field) => ({ key: spec.key, field: field.field, value: field.initial })));
}

export type Writer = (patch: Record<string, unknown>) => void;

function writeOne(store: Store, owner: string, spec: SettingSpec, picked: Change[], writer?: Writer): void {
  const patch = Object.fromEntries(picked.map((change) => [change.field, change.to]));
  // The ship-on rule (src/ship-on.ts): a field set here is the owner's choice, so an "off" set here stays off.
  markChosen(store, owner, spec.key, Object.keys(patch));
  if (writer) return writer(patch);
  if (spec.write) return spec.write(store, owner, patch);
  let data = { ...((store.get("settings", owner, spec.key)?.data ?? {}) as Record<string, unknown>) };
  for (const change of picked) data = writePath(data, change.field, change.to);
  if (spec.keepsEnabled && picked.some((change) => change.field === "mode")) data.enabled = data.mode !== "off";
  store.save("settings", owner, spec.key, data);
}

export interface ApplyChoice {
  /** The ids the owner ticked. Nothing else is written. */
  accept: readonly string[];
  /** The owner's separate yes to changes that make Branch less careful. */
  confirmLoosening: boolean;
  /** Where the changes came from, for the record. */
  why: string;
  /**
   * mac7/wake-pins: the owner moving one switch on purpose, which a pinned setting allows. Off for
   * a preset, a settings file or putting everything back: those step over a pinned setting.
   */
  pinnedAllowed?: boolean | undefined;
  /**
   * Settings whose own save does more than write the record (a learning switch also adds or takes
   * away a tool) are saved through that, keyed by setting.
   */
  writers?: Record<string, Writer> | undefined;
  /** Q48: who made these changes and which way, for the structured change record. */
  record: ChangeOrigin;
}

/** What the setting holds once its own save has run, which may have tidied the value it was given. */
function valueNow(store: Store, owner: string, change: Change): Value {
  const spec = specFor(change.key);
  const field = spec?.fields.find((entry) => entry.field === change.field);
  return spec && field ? currentValue(store, owner, spec, field) : change.to;
}

/**
 * Writes only the ticked changes, worked out again here rather than taken from the page, so a page
 * cannot slip in a value the owner was never shown.
 */
export function applyChanges(store: Store, owner: string, changes: readonly Change[], choice: ApplyChoice): Change[] {
  return applyWithPins(store, owner, changes, choice).applied;
}

/**
 * mac7/wake-pins: the same, saying which ticked changes were stepped over because the owner pinned
 * them. Nothing here throws for a pin: an import of forty settings with one pinned among them makes
 * the other thirty-nine and says which one it left alone.
 */
export function applyWithPins(store: Store, owner: string, changes: readonly Change[], choice: ApplyChoice): { applied: Change[]; skipped: { id: string; why: string }[]; record?: string } {
  const accepted = new Set(choice.accept);
  const wanted = changes.filter((change) => accepted.has(change.id));
  const skipped = choice.pinnedAllowed ? [] : wanted.filter((change) => change.pinned)
    .map((change) => ({ id: change.id, why: pinnedRefusal(pinFor(store, store.profiles?.ownerName ?? owner, change.key, change.field)
      ?? { key: change.key, field: change.field, value: change.from, initial: change.from, keepsEnabled: false, name: change.name, label: change.label }) }));
  const skippedIds = new Set(skipped.map((entry) => entry.id));
  const picked = wanted.filter((change) => !skippedIds.has(change.id));
  const loose = picked.filter((change) => change.loosens);
  if (loose.length && !choice.confirmLoosening)
    throw new Error(`${loose.length} of these make Branch less careful (${loose.map((change) => change.label).join(", ")}). Tick "Yes, make it less careful" to go ahead, or untick them.`);
  if (!picked.length) return { applied: picked, skipped };
  // Q48: the settings, the audit entry and the change record are saved together or not at all, so a
  // record that could not be written never leaves a change behind that nothing says was made.
  const record = store.atomically(() => {
    for (const spec of settingsCatalogue) {
      const mine = picked.filter((change) => change.key === spec.key);
      if (mine.length) writeOne(store, owner, spec, mine, choice.writers?.[spec.key]);
    }
    audit(store, owner, {
      action: "policy.changed", actor: owner, subject: `${picked.length} settings changed (${choice.why})`,
      reason: picked.map((change) => `${change.id}: ${String(change.from)} → ${String(change.to)}`).join("; ").slice(0, 500),
      outcome: "saved",
    });
    // The structured record undo and "why is this on?" read. A caller from before it existed is
    // written down as unknown rather than guessed at.
    const origin: ChangeOrigin = (choice as Partial<ApplyChoice>).record ?? { writer: "unknown", source: "unknown", detail: choice.why };
    return recordSettingsChange(store, owner, origin,
      picked.map((change) => ({ setting: change.id, before: change.from, after: valueNow(store, owner, change) })));
  });
  return { applied: picked, skipped, record };
}
