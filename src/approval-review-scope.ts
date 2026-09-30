import type { Store } from "./store.js";
import { runOrigin } from "./key-context.js";

export type ReviewCategory = "message" | "share" | "spend";
export function reviewCategory(tool: string, permission: string): ReviewCategory | null {
  const words = tool.replace(/([a-z])([A-Z])/g, "$1_$2");
  if (/(^|[._-])(pay|buy|purchase|checkout|charge|transfer)([._-]|$)/i.test(words)
    || /^(payments|purchases|billing)\./.test(permission)) return "spend";
  if (/(^|[._-])(share|upload|publish|post)([._-]|$)/i.test(words)) return "share";
  if (permission === "channels.send" || /(^|[._-])(send|broadcast|forward|invite)([._-]|$)/i.test(words)) return "message";
  return null;
}

/** A helper's brief cannot broaden the owner's instruction. Missing ancestry never grants scope. */
export function ownerReviewTask(store: Store, owner: string, runId: string): string | null {
  const seen = new Set<string>();
  let id = runId;
  while (id && !seen.has(id) && seen.size < 20) {
    seen.add(id);
    const run = store.run(id);
    if (!run || run.owner !== owner || !store.events(id).some((event) => event.kind === "run.started")) return null;
    const origin = runOrigin(store, id);
    if (origin.shortLivedKey || origin.personProfileId || origin.lentTo || origin.source !== "owner") return null;
    if (!origin.parentRunId) return run.prompt.length <= 8000 ? run.prompt : null;
    id = origin.parentRunId;
  }
  return null;
}

/** A conservative extra hint, never evidence that a payload is safe or not sensitive. */
export function healthWords(args: unknown): boolean {
  let text: string;
  try { text = JSON.stringify(args) ?? ""; } catch { return true; }
  return /\b(medical|health|diagnos(?:is|es)|prescription|patient|symptoms?|treatment|lab results?|clinical|therapy|mental health)\b/i.test(text);
}

/** Non-model callers cannot establish sensitivity or recipient authorization with a second look. */
export function sensitiveActionHold(tool: string, permission: string): { reason: string; onceOnly: true } | null {
  const category = reviewCategory(tool, permission);
  if (!category) return null;
  return { onceOnly: true, reason: category === "spend" ? "Spending requires approval for this exact action."
    : "Sending or sharing requires approval for this exact content and recipient." };
}
