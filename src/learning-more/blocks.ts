import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { redactLeaks } from "../leak-guard.js";
import { blockedMemoryText, memoryWriteRefusal } from "../content-guard.js";
import type { Store } from "../store.js";
import { readKnobs } from "../knobs/settings.js"; // whether the note is shown, as the knobs card reads it (ship-on)

/**
 * R17-052: memory blocks — a few short, named pieces of text that sit at the start of every
 * conversation (while the part is "on") and that the assistant can rewrite itself, within a size
 * budget, so what it has just learned is in front of it for the rest of the conversation. The idea
 * follows Letta Code's memory tool (Apache-2.0) and Hermes Agent's user profile (MIT); the code is
 * Branch's own. See THIRD_PARTY_NOTICES.md.
 *
 * Blocks belong to whoever is using the app (the memory scope) and to one agent: a Trunk or a
 * specialist has blocks of its own and never sees the owner's. The "about-you" block is the owner's
 * own "about you" note from Settings (R17-S13, the `knobs-memory` record) with the budget set there;
 * this file only reads and edits that note and never puts it in front of a conversation itself,
 * because the note's own switch does that.
 */
export const aboutYouLabel = "about-you";
export const blockTotalChars = 12000;
const knobsKey = "knobs-memory";
const LabelSchema = z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, "Use lower-case letters, digits and dashes");
export const DefineBlockSchema = z.object({
  label: LabelSchema,
  description: z.string().trim().max(300).default(""),
  limit: z.number().int().min(100).max(8000).default(2000),
  /** A block only the owner may change; the assistant can still read it. */
  readOnly: z.boolean().default(false),
  value: z.string().max(8000).default(""),
}).strict();
export const EditBlockSchema = z.object({
  label: LabelSchema,
  /** replace swaps one exact passage; append adds a line at the end; set writes the whole block. */
  action: z.enum(["replace", "append", "set"]),
  old: z.string().max(8000).optional(),
  text: z.string().max(8000),
}).strict();
export const ViewBlockSchema = z.object({ label: LabelSchema.optional() }).strict();

/** Only the parts of the "about you" note this file uses; the rest of the record is kept as it is. */
const AboutYouSchema = z.object({
  aboutYouOn: z.boolean().default(false),
  aboutYou: z.string().max(8000).default(""),
  aboutYouChars: z.number().int().min(100).max(8000).default(1500),
}).passthrough();

export interface MemoryBlock {
  label: string; description: string; value: string; limit: number; readOnly: boolean;
  /** For the about-you block: whether the note is put in front of conversations (its own switch). */
  shown: boolean; updatedAt: string | null;
}
export interface Who { owner: string; agent: string }

export class MemoryBlocks {
  constructor(private readonly store: Store, private readonly db: DatabaseSync = store.sqlite) {
    db.exec(`CREATE TABLE IF NOT EXISTS lm_blocks(owner TEXT NOT NULL, agent TEXT NOT NULL, label TEXT NOT NULL,
      description TEXT NOT NULL, value TEXT NOT NULL, char_limit INTEGER NOT NULL, read_only INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(owner, agent, label))`);
  }

  list(who: Who): MemoryBlock[] {
    const rows = this.db.prepare("SELECT * FROM lm_blocks WHERE owner=? AND agent=? ORDER BY label").all(who.owner, who.agent);
    const blocks = rows.map((row) => ({
      label: String(row.label), description: String(row.description), value: String(row.value),
      limit: Number(row.char_limit), readOnly: Number(row.read_only) === 1, shown: true, updatedAt: String(row.updated_at),
    }));
    return who.agent ? blocks : [this.aboutYou(who.owner), ...blocks];
  }

  view(who: Who, label?: string): MemoryBlock[] {
    const blocks = this.list(who);
    if (!label) return blocks;
    const block = blocks.find((entry) => entry.label === label);
    if (!block) throw new Error(`There is no memory block called ${label}.`);
    return [block];
  }

  /** The owner makes, renames the purpose of, or resizes a block. */
  define(who: Who, input: unknown): MemoryBlock {
    const value = DefineBlockSchema.parse(input);
    if (value.label === aboutYouLabel) throw new Error("The about-you block is your note in Settings; change its size there.");
    if (this.list(who).length >= 12 && !this.find(who, value.label)) throw new Error("At most 12 memory blocks.");
    const text = this.checked(value.value, value.limit);
    this.db.prepare(`INSERT INTO lm_blocks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner,agent,label) DO UPDATE SET
      description=excluded.description, value=excluded.value, char_limit=excluded.char_limit, read_only=excluded.read_only, updated_at=excluded.updated_at`)
      .run(who.owner, who.agent, value.label, value.description, text, value.limit, value.readOnly ? 1 : 0, new Date().toISOString());
    return this.view(who, value.label)[0]!;
  }

  remove(who: Who, label: string): boolean {
    return this.db.prepare("DELETE FROM lm_blocks WHERE owner=? AND agent=? AND label=?").run(who.owner, who.agent, label).changes > 0;
  }

  /** An edit; `byOwner` is false for the assistant, which may not touch a read-only block. */
  edit(who: Who, input: unknown, byOwner: boolean): { block: MemoryBlock; hidden: string[] } {
    const change = EditBlockSchema.parse(input);
    const block = this.view(who, change.label)[0]!;
    if (block.readOnly && !byOwner) throw new Error(`The ${block.label} block is read-only; only the owner can change it.`);
    const next = nextValue(block.value, change);
    const { text, kinds } = redactLeaks(next);
    const kept = this.checked(text, block.limit);
    if (block.label === aboutYouLabel) this.saveAboutYou(who.owner, kept);
    else this.db.prepare("UPDATE lm_blocks SET value=?, updated_at=? WHERE owner=? AND agent=? AND label=?")
      .run(kept, new Date().toISOString(), who.owner, who.agent, block.label);
    return { block: this.view(who, block.label)[0]!, hidden: kinds };
  }

  /** The blocks put in front of a conversation, about-you left out (its own switch shows it). */
  openingText(who: Who): string {
    const parts: string[] = [];
    let used = 0;
    for (const block of this.list(who)) {
      if (block.label === aboutYouLabel || !block.value.trim()) continue;
      // A block saved before these checks is shown as a placeholder; the Memory view still has its words to remove.
      const value = blockedMemoryText(block.value) ?? block.value;
      const part = `<${block.label}${block.description ? ` — ${block.description}` : ""}; ${block.value.length}/${block.limit} characters>\n${value}`;
      if (used + part.length > blockTotalChars) break;
      parts.push(part);
      used += part.length;
    }
    return parts.join("\n\n");
  }

  private find(who: Who, label: string): boolean {
    return !!this.db.prepare("SELECT 1 AS found FROM lm_blocks WHERE owner=? AND agent=? AND label=?").get(who.owner, who.agent, label);
  }
  private checked(text: string, limit: number): string {
    // A block sits at the start of every conversation, so what it says meets the same checks as a remembered fact.
    const refused = memoryWriteRefusal(text);
    if (refused) throw new Error(refused);
    if (text.length > limit)
      throw new Error(`That would make the block ${text.length} characters long, over its budget of ${limit}. Shorten it first.`);
    return text;
  }
  private aboutYou(owner: string): MemoryBlock {
    const record = this.store.get("settings", owner, knobsKey);
    const note = AboutYouSchema.safeParse(record?.data ?? {});
    const data = note.success ? note.data : AboutYouSchema.parse({});
    // Shown as the knobs card reads it (src/knobs/settings.ts), so the block and the conversation never disagree.
    return { label: aboutYouLabel, description: "Your own words about yourself, from Settings", value: data.aboutYou,
      limit: data.aboutYouChars, readOnly: false, shown: readKnobs(this.store, owner, "memory").aboutYouOn, updatedAt: record?.updatedAt ?? null };
  }
  private saveAboutYou(owner: string, text: string): void {
    const data = (this.store.get("settings", owner, knobsKey)?.data ?? {}) as Record<string, unknown>;
    this.store.save("settings", owner, knobsKey, { ...data, aboutYou: text });
  }
}

export function nextValue(current: string, change: z.infer<typeof EditBlockSchema>): string {
  if (change.action === "set") return change.text;
  if (change.action === "append") return current ? `${current.replace(/\s+$/, "")}\n${change.text}` : change.text;
  if (!change.old) throw new Error("Say which exact passage to replace.");
  const at = current.indexOf(change.old);
  if (at < 0) throw new Error("That passage is not in the block. View the block and copy the passage exactly.");
  if (current.indexOf(change.old, at + 1) >= 0) throw new Error("That passage appears more than once. Include more of it so it is unique.");
  return current.slice(0, at) + change.text + current.slice(at + change.old.length);
}
