import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";
import { teamWorkSessions } from "./team-tasks.js";

/**
 * Batch 26 (wave 8): letting old conversations go. Until this existed nothing was ever deleted
 * unless the owner deleted it one conversation at a time, so a year of daily use meant a year of
 * every word still on the disk with no way to say "keep the last three months".
 *
 * The rule is the owner's and nothing happens on its own: Branch works out what the rule would
 * sweep up and shows the list; only a plain yes deletes anything, and the conversations are handed
 * back as a saved copy first so nothing is lost to a rule the owner set months ago and forgot. Every
 * sweep is written into the record.
 */
export const RetentionSettingsSchema = z.object({
  /** Off until the owner asks for it. Off means nothing is ever proposed for deletion. */
  enabled: z.boolean().default(false),
  /**
   * Conversations older than this many days are proposed. 0 means age is not a reason.
   *
   * It is called `keepDays` because a knowledge base keeps the same number under the same name
   * (`RetentionSchema` in `src/knowledge-manage.ts`): "how long is this kept" is one idea in the
   * product, asked in one vocabulary, whether the thing being kept is a conversation or a
   * collection of documents. The other two numbers differ because the things do: a collection is
   * counted in documents and passages, a history in megabytes.
   */
  keepDays: z.number().int().min(0).max(3650).default(0),
  /** When everything together is bigger than this, the oldest are proposed. 0 means size is not a reason. */
  megabytes: z.number().int().min(0).max(100_000).default(0),
  /** Hand the owner a saved copy of everything before it goes. On, and it is meant to stay on. */
  exportBeforeDeleting: z.boolean().default(true),
}).strict();
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>;
const retentionKey = "retention";

export function retentionSettings(store: Store, owner: string): RetentionSettings {
  const saved = RetentionSettingsSchema.safeParse(store.get("settings", owner, retentionKey)?.data ?? {});
  return saved.success ? saved.data : RetentionSettingsSchema.parse({});
}
export function saveRetentionSettings(store: Store, owner: string, input: unknown): RetentionSettings {
  const value = RetentionSettingsSchema.parse(input ?? {});
  store.save("settings", owner, retentionKey, { ...value });
  audit(store, owner, { action: "policy.changed", actor: owner, subject: "how long conversations are kept",
    reason: sentenceFor(value), outcome: "saved" });
  return value;
}

/**
 * What keeping conversations longer than `before` would mean, in words, or null when `after` keeps nothing longer. A limit
 * the rule sets (an age or a size) raised, or taken away by a 0 or by switching the rule off, keeps them longer; the
 * owner's yes is asked for that (src/policy-change-guard.ts looseningRefusal), never for keeping them less long.
 */
export function retentionLooser(before: RetentionSettings, after: RetentionSettings): string | null {
  const limit = (settings: RetentionSettings, figure: number): number => (settings.enabled && figure > 0 ? figure : Infinity);
  const [daysWas, daysNow] = [limit(before, before.keepDays), limit(after, after.keepDays)];
  const [sizeWas, sizeNow] = [limit(before, before.megabytes), limit(after, after.megabytes)];
  const found: string[] = [];
  if (daysNow > daysWas) found.push(daysNow === Infinity ? "conversations would be kept for ever" : `conversations would be kept ${daysNow} days instead of ${daysWas}`);
  if (sizeNow > sizeWas) found.push(sizeNow === Infinity ? "conversations would be kept whatever room they take" : `conversations would be kept up to ${sizeNow} MB instead of ${sizeWas} MB`);
  return found.length ? found.join("; ") : null;
}

/** The rule in one sentence, for the settings screen and for the record. */
export function sentenceFor(settings: RetentionSettings): string {
  if (!settings.enabled) return "Conversations are kept for ever; nothing is ever deleted by itself.";
  const parts: string[] = [];
  if (settings.keepDays > 0) parts.push(`older than ${settings.keepDays} day${settings.keepDays === 1 ? "" : "s"}`);
  // "Everything together" means the words and the files. It used to mean the words alone, which made
  // a conversation holding a film count as a few kilobytes, so the limit was saying something it was
  // not doing. Nothing is ever deleted without the owner's yes, so the honest number changes what is
  // offered, never what goes.
  if (settings.megabytes > 0)
    parts.push(`the oldest, once everything together — the words and the files attached to them — is over ${settings.megabytes} MB`);
  if (!parts.length) return "No rule is set yet, so nothing is proposed for deletion.";
  return `Branch offers to delete conversations ${parts.join(", and ")}. It always asks first.`;
}

export const PruneSchema = z.object({
  /** Nothing is deleted until this is true, and it can only come from the owner pressing the button. */
  approve: z.boolean().default(false),
  /** The conversations to delete. Empty means everything the rule proposed. */
  sessionIds: z.array(z.string().uuid()).max(200).default([]),
}).strict();

export interface PruneCandidate {
  sessionId: string; createdAt: string; messageCount: number; bytes: number; why: string;
}

export class ConversationRetention {
  constructor(
    private readonly store: Store, private readonly owner: string,
    /** What "now" is, so the rule can be tried against a history that is not today's. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** R17-A (Trunks): conversations the rule never sweeps up — a Trunk's own, and its rooms'. */
  keeps: (sessionId: string) => boolean = () => false;

  /** What the rule would sweep up, and the sentence that goes above the list. Nothing is deleted. */
  propose(): { settings: RetentionSettings; sentence: string; conversations: PruneCandidate[]; bytes: number } {
    const settings = retentionSettings(this.store, this.owner);
    const sentence = sentenceFor(settings);
    if (!settings.enabled || (settings.keepDays === 0 && settings.megabytes === 0))
      return { settings, sentence, conversations: [], bytes: this.store.prunableSessions(this.owner, 0, 0, this.now()).bytes };
    const found = this.store.prunableSessions(this.owner, settings.keepDays, settings.megabytes, this.now());
    // Q61: a team turn still running needs its room and its own conversation to write its answers to.
    const teamWork = teamWorkSessions(this.store.sqlite, this.owner);
    const kept = (sessionId: string) => this.keeps(sessionId) || teamWork.has(sessionId);
    return { settings, sentence, conversations: found.conversations.filter((entry) => !kept(entry.sessionId)), bytes: found.bytes };
  }

  /**
   * Deletes what the owner said yes to, handing back a saved copy of each one first. Without that
   * yes it only answers with the proposal, so pressing the button by accident deletes nothing.
   */
  prune(input: unknown): {
    deleted: boolean; sentence: string; conversations: PruneCandidate[];
    exported: { sessionId: string; archive: unknown }[]; removed: string[];
  } {
    const wanted = PruneSchema.parse(input ?? {});
    const proposal = this.propose();
    const chosen = wanted.sessionIds.length
      ? proposal.conversations.filter((entry) => wanted.sessionIds.includes(entry.sessionId))
      : proposal.conversations;
    if (!wanted.approve)
      return { deleted: false, sentence: proposal.sentence, conversations: chosen, exported: [], removed: [] };
    const settings = proposal.settings;
    const exported: { sessionId: string; archive: unknown }[] = [];
    const removed: string[] = [];
    for (const entry of chosen) {
      if (settings.exportBeforeDeleting) {
        const archive = this.safeExport(entry.sessionId);
        if (archive === null) continue;
        exported.push({ sessionId: entry.sessionId, archive });
      }
      this.store.forgetSession(this.owner, entry.sessionId);
      removed.push(entry.sessionId);
    }
    audit(this.store, this.owner, { action: "history.pruned", actor: this.owner,
      subject: `${removed.length} conversation(s)`,
      reason: settings.exportBeforeDeleting
        ? "The owner agreed to let old conversations go; a saved copy was handed back first"
        : "The owner agreed to let old conversations go",
      outcome: "deleted" });
    return { deleted: true, sentence: proposal.sentence, conversations: chosen, exported, removed };
  }

  /**
   * A copy of one conversation, or null when it cannot be copied — it is too big to archive, or a
   * task of its own is still running. A conversation that cannot be saved is never deleted.
   */
  private safeExport(sessionId: string): unknown | null {
    try { return this.store.exportSession(this.owner, sessionId); } catch { return null; }
  }
}
