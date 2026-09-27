/**
 * Flag one reply ("Flag this reply"): one or more reasons and an optional note, kept on this computer against
 * that one reply. Nothing is sent anywhere by keeping one. The flags can be listed and removed, and only the owner
 * asking for an export gets them out, as one document holding each flagged reply and its note and nothing else: no
 * other message of the conversation, no file and no memory.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";

/** The six reasons the dialog offers, in its order. */
export const flagReasons = ["wrong", "ignored", "unasked", "unsafe", "unclear", "other"] as const;
export const ReplyFlagSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.number().int().positive(),
  reasons: z.array(z.enum(flagReasons)).min(1).max(flagReasons.length).transform((picked) => flagReasons.filter((r) => picked.includes(r))),
  note: z.string().trim().max(2000).default(""),
}).strict();

export interface ReplyFlag {
  id: string; sessionId: string; messageId: number; reasons: (typeof flagReasons)[number][];
  note: string; reply: string; at: string;
}
const Saved = z.object({ flags: z.array(z.custom<ReplyFlag>()).max(200).default([]) }).strict();
const key = "reply-flags";
const maxFlags = 200;
const maxReply = 8000;

/** What the owner is told when a flag is kept; the window shows these words. */
export const keptWords = "Flagged. Kept on this computer only.";

const text = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "")).join("")
      : "";

export class ReplyFlags {
  constructor(private readonly store: Store, private readonly owner: () => string) {}

  /**
   * What any reader may see (GET /api/reply-flags, open to a short-lived key like other reads): which replies are
   * flagged and why, never the reply's words or the note. Those leave only through the owner's export.
   */
  marks(): Pick<ReplyFlag, "id" | "sessionId" | "messageId" | "reasons" | "at">[] {
    return this.list().map(({ id, sessionId, messageId, reasons, at }) => ({ id, sessionId, messageId, reasons, at }));
  }
  list(): ReplyFlag[] {
    const saved = Saved.safeParse(this.store.get("settings", this.owner(), key)?.data ?? {});
    return saved.success ? saved.data.flags : [];
  }
  private save(flags: ReplyFlag[]): void {
    this.store.save("settings", this.owner(), key, { flags: flags.slice(-maxFlags) });
  }

  /** Keeps one flag. The reply's words are read here from the conversation, never taken from the request. */
  add(input: unknown): { flag: ReplyFlag; said: string } {
    const wanted = ReplyFlagSchema.parse(input);
    const owner = this.owner();
    const message = this.store.sessionView(owner, wanted.sessionId).messages
      .find((entry) => entry.messageId === wanted.messageId);
    if (!message || message.role !== "assistant") throw new Error("Only a reply can be flagged, and that one is not in this conversation.");
    const flags = this.list().filter((flag) => !(flag.sessionId === wanted.sessionId && flag.messageId === wanted.messageId));
    const flag: ReplyFlag = { id: randomUUID(), ...wanted, reply: text(message.content).slice(0, maxReply), at: new Date().toISOString() };
    this.save([...flags, flag]);
    return { flag, said: keptWords };
  }

  remove(id: string): { removed: boolean; said: string } {
    const flags = this.list();
    const kept = flags.filter((flag) => flag.id !== id);
    if (kept.length === flags.length) throw new Error("There is no such flag.");
    this.save(kept);
    return { removed: true, said: "Flag removed." };
  }

  /** The owner's export: every kept flag, each only its reply and note. Written into the record of what happened. */
  exported(): { exportedAt: string; flags: ReplyFlag[] } {
    const flags = this.list();
    const owner = this.owner();
    audit(this.store, owner, { action: "data.exported", actor: owner, subject: `${flags.length} flagged replies`,
      reason: "You exported your reports", source: "owner", outcome: "exported" });
    return { exportedAt: new Date().toISOString(), flags };
  }
}
