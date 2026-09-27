import { z } from "zod";
import type { Store } from "./store.js";
import { PiiGuardSchema, applyPiiGuard, type PiiFinding, type PiiGuardConfig } from "./pii.js";
import { mapStrings } from "./vault.js";
import { ModerationSchema, type Moderation, type ModerationVerdict } from "./moderation.js";
import { lockdownSettingsRefusal, tickToConfirm } from "./policy-change-guard.js";

/**
 * The privacy check that sits either side of the assistant. On the way out (a message to a chat or
 * a mailbox) personal details are hidden by default and, if the owner has switched it on, the
 * provider is asked whether the message is acceptable. On the way in (what the assistant reads)
 * nothing is changed unless the owner asks for it, because reading your own files should not be
 * rewritten behind your back.
 */
export const PrivacyGuardSchema = z.object({
  pii: PiiGuardSchema.prefault({}),
  moderation: ModerationSchema.prefault({}),
}).strict();
export type PrivacyGuardConfig = z.infer<typeof PrivacyGuardSchema>;
export interface OutboundCheck {
  text: string; blocked: boolean; reason?: string;
  findings: PiiFinding[]; moderation: ModerationVerdict | null;
}
const settingsKey = "privacy-guard";

/** A privacy change the owner has not said yes to, or one made under Lockdown (answered 409). */
export class PrivacyChangeRefused extends Error {}

/** How careful each action is with a personal detail, least first. */
const care = ["off", "warn", "mask", "block"] as const;
const lessCareful = (before: string, after: string): boolean =>
  care.indexOf(after as (typeof care)[number]) < care.indexOf(before as (typeof care)[number]);

/** What in `after` is less careful than `before`, in words, or null when nothing is. */
export function privacyLooser(before: PrivacyGuardConfig, after: PrivacyGuardConfig): string | null {
  const found: string[] = [];
  if (lessCareful(before.pii.outbound, after.pii.outbound))
    found.push(`personal details in messages sent out would be ${after.pii.outbound === "off" ? "let through unchecked" : after.pii.outbound === "warn" ? "sent with only a warning" : "masked instead of held back"}`);
  if (lessCareful(before.pii.inbound, after.pii.inbound)) found.push("personal details in what Branch reads would be checked less");
  const dropped = before.pii.kinds.filter((kind) => !after.pii.kinds.includes(kind));
  if (dropped.length) found.push(`${dropped.join(", ")} would no longer be looked for`);
  const was = before.moderation, now = after.moderation;
  if (was.enabled && !now.enabled) found.push("the content check would be off");
  if (was.enabled && now.enabled && was.action === "block" && now.action === "warn") found.push("a flagged message would be sent with only a warning");
  if (now.enabled && (!was.enabled || was.endpoint !== now.endpoint || was.keyReference !== now.keyReference))
    found.push(`messages would be sent to ${now.endpoint ?? "the provider"} to be checked`);
  return found.length ? found.join("; ") : null;
}

/** Why saving `after` in place of `before` is refused, or null when it may be saved. */
export function privacyChangeRefusal(before: PrivacyGuardConfig, after: PrivacyGuardConfig, confirmLoosening: boolean, lockdown: boolean): string | null {
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  if (lockdown) return lockdownSettingsRefusal;
  if (confirmLoosening) return null;
  const looser = privacyLooser(before, after);
  return looser ? `This makes Branch less careful: ${looser}. ${tickToConfirm}` : null;
}

export class PrivacyGuard {
  constructor(private readonly store: Store, private readonly owner: string, private readonly moderation: Moderation) {}
  settings(): PrivacyGuardConfig {
    const saved = PrivacyGuardSchema.safeParse(this.store.get("settings", this.owner, settingsKey)?.data ?? {});
    return saved.success ? saved.data : PrivacyGuardSchema.parse({});
  }
  /**
   * Saves the checks. A change that makes them less careful needs the owner's separate yes (`confirmLoosening`), as
   * every other loosening setting does (src/policy-change-guard.ts); under Lockdown nothing here changes at all.
   */
  configure(input: unknown, confirmLoosening = false, lockdown = false): PrivacyGuardConfig {
    const next = PrivacyGuardSchema.parse(input ?? {});
    const refusal = privacyChangeRefusal(this.settings(), next, confirmLoosening, lockdown);
    if (refusal) throw new PrivacyChangeRefused(refusal);
    this.store.save("settings", this.owner, settingsKey, next);
    this.moderation.configure(next.moderation);
    return next;
  }
  private pii(): PiiGuardConfig { return this.settings().pii; }

  /** Everything the assistant is about to send out of this computer goes through here. */
  async outbound(text: string): Promise<OutboundCheck> {
    const rules = this.pii();
    const verdict = applyPiiGuard(text, rules.outbound, rules.kinds);
    if (verdict.blocked)
      return { text: "", blocked: true, findings: verdict.findings, moderation: null,
        reason: `The message was held back because it contains a ${verdict.findings[0]?.hint ?? "personal detail"}.` };
    const checked = await this.moderation.check(verdict.text);
    if (checked.blocked)
      return { text: "", blocked: true, findings: verdict.findings, moderation: checked,
        reason: `The message was held back by the content check (${checked.categories.join(", ") || "flagged"}).` };
    return { text: verdict.text, blocked: false, findings: verdict.findings, moderation: checked.checked ? checked : null };
  }
  /** What the assistant reads. Left exactly as it is unless the owner has asked for masking. */
  inbound<T>(value: T): T {
    const rules = this.pii();
    if (rules.inbound === "off" || rules.inbound === "warn") return value;
    return mapStrings(value, (text) => applyPiiGuard(text, rules.inbound, rules.kinds).text);
  }
}
