import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { shippedUnlessChosen } from "./ship-on.js";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import { scanSkill, describeFindings } from "./skill-scan.js";

/**
 * Bucket 12: the owner's own saved prompts — the things they ask for often, kept in groups, each
 * with an optional typed command of its own (`/weekly`), earlier wordings kept, and blanks
 * (`{{topic}}`) filled in when it is used.
 *
 * A saved prompt only ever becomes the text of an ordinary message. Using one starts the same task
 * typing it would start, through the same key checks and approval rules, so nothing here can do
 * more than the person using it could already do by typing. The idea of prompts in groups with a
 * command each follows LibreChat's prompt groups (MIT); the code is written for Branch.
 *
 * The switch ships on (the owner's rule, src/ship-on.ts): a saved prompt is only ever a message the owner could type.
 *   off          nothing can be saved or used, and a typed `/name` is what it always was
 *   when-needed  saved commands work when typed, but no menu lists them (`/prompts` does)
 *   on           saved commands work and every `/` menu lists them
 */
export const PromptLibrarySettingsSchema = z.object({ mode: FeatureModeSchema.default("off") }).strict();
export type PromptLibrarySettings = z.infer<typeof PromptLibrarySettingsSchema>;
const settingsKey = "prompt-library", itemsKey = "prompt-library-items";
export const maxPrompts = 200;
const maxVersions = 10;

/** A command a saved prompt answers to: lowercase letters, digits and dashes, starting with a letter. */
export const promptCommandPattern = /^[a-z][a-z0-9-]{0,31}$/;
const blankPattern = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;
/** A finished message that would be read as a command: a slash first, past spaces and invisible characters. */
const readsAsCommand = /^[\s\u200B-\u200D\u2060\uFEFF]*[/\uFF0F]/;
/** Blanks Branch fills in by itself. `{{input}}` is whatever follows the command. */
export const builtInBlanks = ["today", "input"] as const;

export const PromptInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(8000)
    .refine((body) => !body.startsWith("/"), "A saved prompt cannot start with /, or it would be read as a command again."),
  group: z.string().trim().max(40).default(""),
  description: z.string().trim().max(200).default(""),
  command: z.union([z.literal(""), z.string().trim().toLowerCase().regex(promptCommandPattern,
    "A command is lowercase letters, digits and dashes, starting with a letter, at most 32 long")]).default(""),
}).strict();
export type PromptInput = z.input<typeof PromptInputSchema>;

export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
  group: string;
  description: string;
  command: string;
  /** Earlier wordings, newest first. */
  versions: { body: string; savedAt: string }[];
  uses: number;
  createdAt: string;
  updatedAt: string;
}

type Reader = Pick<Store, "get">;
type Writer = Pick<Store, "get" | "save">;

// The owner's rule (ships on, 2026-09-26): saved prompts are the owner's own messages, and every / menu lists them; none of (a)–(f).
export const promptLibraryShipsAs: FeatureMode = "on";

export function promptLibrarySettings(store: Reader, owner: string): PromptLibrarySettings {
  const saved = PromptLibrarySettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, settingsKey, saved.data, { mode: promptLibraryShipsAs }) : PromptLibrarySettingsSchema.parse({});
}
export function savePromptLibrarySettings(store: Writer, owner: string, input: unknown): PromptLibrarySettings {
  const value = PromptLibrarySettingsSchema.parse(input ?? {});
  store.save("settings", owner, settingsKey, value);
  return value;
}
export const promptLibraryMode = (store: Reader, owner: string): FeatureMode => promptLibrarySettings(store, owner).mode;

export const switchedOffSentence = "Saved prompts are switched off. Switch them on in Automations › Procedures.";
/** Refuses in one plain sentence while the switch is off. */
export function assertLibraryOn(store: Reader, owner: string): void {
  if (promptLibraryMode(store, owner) === "off") throw new Error(switchedOffSentence);
}

export function listPrompts(store: Reader, owner: string): SavedPrompt[] {
  const data = store.get("settings", owner, itemsKey)?.data as { prompts?: SavedPrompt[] } | undefined;
  return Array.isArray(data?.prompts) ? data.prompts : [];
}
function writePrompts(store: Writer, owner: string, prompts: SavedPrompt[]): void {
  store.save("settings", owner, itemsKey, { prompts });
}

/** The groups in the order they first appear, with how many prompts each holds; "" is "Ungrouped". */
export function promptGroups(prompts: readonly SavedPrompt[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const prompt of prompts) counts.set(prompt.group, (counts.get(prompt.group) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }));
}

/** The blanks a prompt asks for, in order, without the ones Branch fills in by itself. */
export function blanksIn(body: string): string[] {
  const names = [...body.matchAll(blankPattern)].map((match) => match[1]!);
  return [...new Set(names)].filter((name) => !(builtInBlanks as readonly string[]).includes(name));
}

/** Why a command name cannot be used, or null. `taken` answers for the shipped command table. */
export function commandProblem(command: string, prompts: readonly SavedPrompt[], selfId: string | undefined, taken: (name: string) => boolean): string | null {
  if (!command) return null;
  if (taken(command)) return `/${command} is already one of Branch's own commands, so a saved prompt cannot use it.`;
  const other = prompts.find((prompt) => prompt.command === command && prompt.id !== selfId);
  return other ? `/${command} already opens your saved prompt "${other.title}".` : null;
}

function assertNoSecret(body: string): void {
  const found = scanSkill(body).filter((finding) => finding.kind === "secret");
  if (found.length) throw new Error(`The prompt was not saved because it ${describeFindings(found)}. Keep keys in Settings › Secrets instead.`);
}

/** Saves a new prompt, or a new wording of one; the wording it had is kept, up to ten back. */
export function savePrompt(store: Writer, owner: string, input: unknown, taken: (name: string) => boolean, now = new Date()): SavedPrompt {
  assertLibraryOn(store, owner);
  const value = PromptInputSchema.parse(input);
  assertNoSecret(value.body);
  const prompts = listPrompts(store, owner);
  const problem = commandProblem(value.command, prompts, value.id, taken);
  if (problem) throw new Error(problem);
  const at = now.toISOString();
  const index = value.id ? prompts.findIndex((prompt) => prompt.id === value.id) : -1;
  if (value.id && index < 0) throw new Error("That saved prompt is not here any more; reload the list.");
  if (index < 0 && prompts.length >= maxPrompts) throw new Error(`You can keep at most ${maxPrompts} saved prompts. Remove one first.`);
  const before = index >= 0 ? prompts[index]! : undefined;
  const versions = before && before.body !== value.body
    ? [{ body: before.body, savedAt: before.updatedAt }, ...before.versions].slice(0, maxVersions)
    : before?.versions ?? [];
  const saved: SavedPrompt = {
    id: before?.id ?? randomUUID(), title: value.title, body: value.body, group: value.group,
    description: value.description, command: value.command, versions,
    uses: before?.uses ?? 0, createdAt: before?.createdAt ?? at, updatedAt: at,
  };
  if (index >= 0) prompts[index] = saved; else prompts.push(saved);
  writePrompts(store, owner, prompts);
  return saved;
}

export function removePrompt(store: Writer, owner: string, id: string): { removed: boolean } {
  assertLibraryOn(store, owner);
  const prompts = listPrompts(store, owner);
  const kept = prompts.filter((prompt) => prompt.id !== id);
  if (kept.length === prompts.length) return { removed: false };
  writePrompts(store, owner, kept);
  return { removed: true };
}

/** Counts one use, so the list can put the ones used most first. */
export function countUse(store: Writer, owner: string, id: string): void {
  const prompts = listPrompts(store, owner);
  const found = prompts.find((prompt) => prompt.id === id);
  if (!found) return;
  found.uses += 1;
  writePrompts(store, owner, prompts);
}

/**
 * Reads what followed a command: `name=value` or `name="a few words"` pairs for named blanks, and
 * everything else as the `input`.
 */
export function readArguments(argument: string): { named: Record<string, string>; rest: string } {
  const named: Record<string, string> = {};
  const rest = argument.replace(/(?:^|\s)([a-z][a-z0-9_]{0,39})=("([^"]*)"|\S+)/g, (_all, name: string, raw: string, quoted?: string) => {
    named[name] = quoted ?? raw;
    return " ";
  }).trim();
  return { named, rest };
}

/**
 * The finished message: every blank filled in. A single blank of the owner's own takes the free
 * text; a prompt with no blanks gets the free text on a line of its own after it. A blank nobody
 * filled stops it with the list of what is missing, so a half-filled prompt is never sent.
 */
export function fillPrompt(body: string, values: Record<string, string>, rest = "", now = new Date()): string {
  const blanks = blanksIn(body);
  const filled: Record<string, string> = { ...values, today: now.toISOString().slice(0, 10) };
  const open = blanks.filter((name) => !filled[name]?.trim());
  if (rest && open.length === 1) filled[open[0]!] = rest;
  if (rest && !("input" in filled)) filled.input = rest;
  const missing = blanks.filter((name) => !filled[name]?.trim());
  if (missing.length) throw new Error(`This prompt needs ${missing.map((name) => `${name}=…`).join(" ")}.`);
  const usesInput = /\{\{\s*input\s*\}\}/.test(body);
  const text = body.replace(blankPattern, (_all, name: string) => filled[name] ?? "");
  const extra = rest && !usesInput && !blanks.some((name) => filled[name] === rest) ? `\n\n${rest}` : "";
  const message = (text + extra).trim();
  if (message.length > 16000) throw new Error("The filled-in prompt is longer than a message may be.");
  // Integrator (bucket 12): what fills a blank never turns the prompt into another command.
  if (readsAsCommand.test(message)) throw new Error("The filled-in prompt starts with /, so it would be read as a command; it was not sent.");
  return message;
}

/* ---------- carrying prompts between installs ---------- */

export const PromptLibraryFileSchema = z.object({
  format: z.literal("branch-prompt-library"),
  version: z.literal(1),
  prompts: z.array(z.object({
    title: z.string().max(200), body: z.string().max(16000), group: z.string().max(100).optional(),
    description: z.string().max(400).optional(), command: z.string().max(64).optional(),
  }).strict()).max(maxPrompts),
}).strict();

export function exportPrompts(store: Reader, owner: string) {
  return {
    format: "branch-prompt-library" as const, version: 1 as const,
    prompts: listPrompts(store, owner).map(({ title, body, group, description, command }) => ({ title, body, group, description, command })),
  };
}

/**
 * Adds the prompts of a library file. A prompt whose title is already here is left alone; a command
 * that is already taken is dropped from the new prompt and said so. Nothing carrying a key is taken in.
 */
export function importPrompts(store: Writer, owner: string, input: unknown, taken: (name: string) => boolean) {
  assertLibraryOn(store, owner);
  const file = PromptLibraryFileSchema.parse(input);
  const added: string[] = [], skipped: string[] = [], notes: string[] = [];
  for (const entry of file.prompts) {
    const current = listPrompts(store, owner);
    if (current.some((prompt) => prompt.title === entry.title.trim())) { skipped.push(entry.title); continue; }
    const command = entry.command && !commandProblem(entry.command, current, undefined, taken) ? entry.command : "";
    if (entry.command && !command) notes.push(`"${entry.title}" came without its command /${entry.command}, which is already taken.`);
    try {
      savePrompt(store, owner, { ...entry, command }, taken);
      added.push(entry.title);
    } catch (error) {
      notes.push(`"${entry.title}" was not added: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { added, skipped, notes };
}
