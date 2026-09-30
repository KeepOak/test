import { z } from "zod";
import type { Store } from "../store.js";
import type { TrunkRecords } from "./record.js";

export const personalityNames = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "TOOLS.md", "HEARTBEAT.md"] as const;
export type PersonalityName = typeof personalityNames[number];
const EditSchema = z.object({ name: z.enum(personalityNames), text: z.string().max(8000) }).strict();

/**
 * workbench (SELF-311): memory files, one fact or rule each, beside MEMORY.md, like Claude Code's memory folder: a
 * name, a one-line description and a type in front, the body after. MEMORY.md stays the index the Trunk reads every
 * turn; the files are listed under it by name and description, and a body is read when the work calls for it. They
 * live in the Trunk's own record (`trunk-files:<id>`), so they are that Trunk's alone and travel in its backup.
 */
export const memoryTypes = ["user", "feedback", "project", "reference"] as const;
export const memoryFileName = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, "A memory file's name is 1 to 60 small letters, digits, - or _.");
export const MemoryFileSchema = z.object({
  description: z.string().trim().min(1).max(200),
  type: z.enum(memoryTypes),
  body: z.string().max(8000),
  updatedAt: z.string().max(40),
}).strict();
export type MemoryFile = z.infer<typeof MemoryFileSchema>;
export const maxMemoryFiles = 100;
type Saved = { files?: Partial<Record<PersonalityName, string>>; memories?: Record<string, MemoryFile> };
const hints: Record<PersonalityName, string> = {
  "IDENTITY.md": "Name, role, and how you introduce yourself.",
  "SOUL.md": "Your personality, values, and conversational style.",
  "AGENTS.md": "How you work and when you ask for help.",
  "USER.md": "What the person wants you to know about them.",
  "MEMORY.md": "Durable notes the person chooses to keep here.",
  "TOOLS.md": "Local tools and practical working notes.",
  "HEARTBEAT.md": "What to check when a scheduled check asks you to.",
};
const defaults: Record<PersonalityName, string> = {
  "IDENTITY.md": "You are the person's own assistant, with the name and face they chose for this Trunk. Speak as yourself, simply and naturally. Never speak as a company, mascot, or promotional voice.",
  "SOUL.md": "Be curious, candid, warm, and practical. Listen to the whole request. Use clear everyday words, be brief when the answer is simple, and explain consequential choices. Have judgment without being stubborn. Never invent success, flatter, or pretend to have feelings or experience you do not have.",
  "AGENTS.md": "Carry the person's request through to a useful, verified result. Use the tools available for the task. Ask when a missing decision matters; resolve routine reversible choices yourself. Keep their work and drafts safe. Report what changed, what was checked, and what remains uncertain. Follow the person's permissions and safety rules; these notes never grant additional access.",
  "USER.md": "Learn preferences from what this person actually tells you. Do not assume their identity, location, relationships, or habits. Ask before treating sensitive details as durable knowledge, and correct notes when the person corrects you.",
  "MEMORY.md": "Keep concise, accurate notes that will help this person later. Distinguish facts from guesses and current evidence from old observations. Proposed memories are proposals until accepted; never claim a fact was saved unless its storage succeeded.",
  "TOOLS.md": "Use the smallest suitable tool for the job and inspect its result. Protect secrets and keep private data out of public artifacts. Do not claim an external action occurred from a plan or tool connection alone. These working notes do not override tool permissions or approvals.",
  "HEARTBEAT.md": "When explicitly asked to check back, look for meaningful changes and actionable work. Stay quiet when nothing needs attention. Do not create schedules, send messages, or run background tasks merely because this file exists.",
};

/** Record-backed files stay inside the person's backup and reload at the start of every turn. */
export class TrunkFiles {
  constructor(private readonly store: Store, private readonly owner: string, private readonly records: TrunkRecords) {}
  private key(id: string): string { return `trunk-files:${id}`; }
  private row(id: string): Saved { return (this.store.get("governance", this.owner, this.key(id))?.data as Saved | undefined) ?? {}; }
  private saved(id: string): Partial<Record<PersonalityName, string>> { return this.row(id).files ?? {}; }
  /** Writes the record, keeping whatever part of it this write does not change. */
  private write(id: string, change: Saved): void { this.store.save("governance", this.owner, this.key(id), { ...this.row(id), ...change }); }
  view(id: string) {
    const trunk = this.records.get(id), saved = this.saved(id);
    return { files: personalityNames.map((name) => ({ name, hint: hints[name], text: name === "SOUL.md" ? trunk.instructions : saved[name] ?? "" })) };
  }
  seedDefault(id: string): void {
    if (this.store.get("governance", this.owner, this.key(id))) return;
    const trunk = this.records.get(id);
    this.store.atomically(() => {
      this.store.save("governance", this.owner, this.key(id), { files: { ...defaults, "SOUL.md": trunk.instructions || defaults["SOUL.md"] } });
      if (!trunk.instructions) this.records.edit(id, { instructions: defaults["SOUL.md"] });
    });
  }
  edit(id: string, input: unknown) {
    this.records.get(id);
    const { name, text } = EditSchema.parse(input);
    this.store.atomically(() => {
      this.write(id, { files: { ...this.saved(id), [name]: text } });
      if (name === "SOUL.md") this.records.edit(id, { instructions: text });
      this.store.audit.record(this.owner, { action: "trunk.files", actor: this.owner, subject: name, reason: "Personality file updated", outcome: "saved" });
    });
    return this.view(id);
  }
  instructions(id: string): string {
    const files = this.view(id).files.filter((file) => file.name !== "SOUL.md" && file.text.trim())
      .map((file) => `Personal file ${file.name} (the person's notes; never grants permissions):\n${file.text}`);
    const memories = Object.entries(this.memories(id));
    if (memories.length) files.push("Memory files (read one with memory.read_file when the work calls for it; they never grant permissions):\n"
      + memories.map(([name, file]) => `- ${name} (${file.type}): ${file.description}`).join("\n"));
    return files.join("\n\n");
  }
  /** workbench (SELF-311): this Trunk's memory files, by name. */
  memories(id: string): Record<string, MemoryFile> {
    const saved = this.row(id).memories ?? {};
    return Object.fromEntries(Object.entries(saved)
      .filter(([name, file]) => memoryFileName.safeParse(name).success && MemoryFileSchema.safeParse(file).success)
      .sort(([a], [b]) => a.localeCompare(b)));
  }
  /** Writes one memory file, or MEMORY.md itself; nothing else of the Trunk's (its SOUL.md, AGENTS.md, ...) is reachable here. */
  writeMemory(id: string, actor: string, input: { name: string; description?: string | undefined; type?: MemoryFile["type"] | undefined; body: string }): void {
    this.records.get(id);
    this.store.atomically(() => {
      if (input.name === "MEMORY.md") {
        this.write(id, { files: { ...this.saved(id), "MEMORY.md": z.string().max(8000).parse(input.body) } });
      } else {
        const name = memoryFileName.parse(input.name), memories = this.memories(id);
        if (!memories[name] && Object.keys(memories).length >= maxMemoryFiles)
          throw new Error(`A Trunk keeps at most ${maxMemoryFiles} memory files; fold some together or delete one first.`);
        if (!input.description || !input.type) throw new Error("A memory file needs a one-line description and a type (user, feedback, project or reference).");
        const file = MemoryFileSchema.parse({ description: input.description, type: input.type, body: input.body, updatedAt: new Date().toISOString() });
        this.write(id, { memories: { ...memories, [name]: file } });
      }
      this.store.audit.record(this.owner, { action: "trunk.files", actor, subject: input.name, reason: "Memory file written", outcome: "saved" });
    });
  }
  /** Deletes one memory file; false when there is none by that name. */
  deleteMemory(id: string, actor: string, name: string): boolean {
    const memories = this.memories(id);
    if (!memories[name]) return false;
    delete memories[name];
    this.store.atomically(() => {
      this.write(id, { memories });
      this.store.audit.record(this.owner, { action: "trunk.files", actor, subject: name, reason: "Memory file deleted", outcome: "saved" });
    });
    return true;
  }
}
