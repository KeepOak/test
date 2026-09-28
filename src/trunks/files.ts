import { z } from "zod";
import type { Store } from "../store.js";
import type { TrunkRecords } from "./record.js";

export const personalityNames = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "TOOLS.md", "HEARTBEAT.md"] as const;
export type PersonalityName = typeof personalityNames[number];
const EditSchema = z.object({ name: z.enum(personalityNames), text: z.string().max(8000) }).strict();
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
  private saved(id: string): Partial<Record<PersonalityName, string>> {
    return (this.store.get("governance", this.owner, this.key(id))?.data as { files?: Partial<Record<PersonalityName, string>> })?.files ?? {};
  }
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
      this.store.save("governance", this.owner, this.key(id), { files: { ...this.saved(id), [name]: text } });
      if (name === "SOUL.md") this.records.edit(id, { instructions: text });
      this.store.audit.record(this.owner, { action: "trunk.files", actor: this.owner, subject: name, reason: "Personality file updated", outcome: "saved" });
    });
    return this.view(id);
  }
  instructions(id: string): string {
    return this.view(id).files.filter((file) => file.name !== "SOUL.md" && file.text.trim())
      .map((file) => `Personal file ${file.name} (the person's notes; never grants permissions):\n${file.text}`).join("\n\n");
  }
}
