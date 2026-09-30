import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";

/**
 * Batch 20 (wave 8): one list of who may talk to the assistant, for every chat app at once.
 *
 * Each channel already carried a list of its own, which meant the same answer had to be given
 * separately for Telegram, for Slack, for email, and remembered in as many places. This is the one
 * shape: a rule names a channel (or every channel) and a sender (or every sender on it), and says
 * whether they are let through or turned away. Turning away wins over letting through, so a single
 * "never this person" rule cannot be undone by a broader one somewhere else in the list.
 *
 * The per-channel lists still work and are read as well, so nothing an owner already set up stops
 * working the day they update.
 */
export const AllowRuleSchema = z.object({
  /** The chat app this is about, or "*" for every one of them. */
  channel: z.string().trim().min(1).max(64).default("*"),
  /** The sender's id on that app, or "*" for everybody on it. */
  sender: z.string().trim().min(1).max(120).default("*"),
  decision: z.enum(["allow", "block"]).default("allow"),
  /** Who this is, in the owner's words, so the list means something a year later. */
  note: z.string().trim().max(200).default(""),
}).strict();
export type AllowRule = z.infer<typeof AllowRuleSchema>;

export const SenderAllowlistSchema = z.object({
  /**
   * What happens to somebody no rule covers: "pair" offers them a code to be approved with, "block"
   * turns them away without one; "ignore" also leaves unauthorized direct chats unanswered.
   */
  unknown: z.enum(["pair", "block", "ignore"]).default("pair"),
  rules: z.array(AllowRuleSchema).max(200).default([]),
}).strict();
export type SenderAllowlist = z.infer<typeof SenderAllowlistSchema>;
const settingsKey = "sender-allowlist";

export function readSenderAllowlist(store: Store, owner: string): SenderAllowlist {
  const saved = SenderAllowlistSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : SenderAllowlistSchema.parse({});
}
export function saveSenderAllowlist(store: Store, owner: string, input: unknown): SenderAllowlist {
  const next = SenderAllowlistSchema.parse({ ...readSenderAllowlist(store, owner), ...(input as object ?? {}) });
  store.save("settings", owner, settingsKey, next);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "who may message the assistant",
    reason: `${next.rules.length} rule(s); anybody else is ${next.unknown === "pair" ? "offered a code"
      : next.unknown === "ignore" ? "turned away without a direct-chat reply" : "turned away"}`,
    outcome: "saved",
  });
  return next;
}

/** Whether a rule is about this sender on this channel. "*" in either place means "any". */
const covers = (rule: AllowRule, channel: string, sender: string): boolean =>
  (rule.channel === "*" || rule.channel === channel) && (rule.sender === "*" || rule.sender === sender);

/**
 * What the one list says about a sender: "allow", "block", or null when no rule covers them and
 * the answer is whatever the channel's own list and pairing say. A block anywhere wins.
 */
export function decide(list: SenderAllowlist, channel: string, sender: string): "allow" | "block" | null {
  const matching = list.rules.filter((rule) => covers(rule, channel, sender));
  if (matching.some((rule) => rule.decision === "block")) return "block";
  if (matching.some((rule) => rule.decision === "allow")) return "allow";
  return null;
}
