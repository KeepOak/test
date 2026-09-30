import { chatgptPresetPrefix } from "../chatgpt-presets.js";
import { ChatGPTProvider } from "../chatgpt-provider.js";
import type { ModelPreset } from "../models.js";
import { CliAgentProvider } from "../providers/cli-agent.js";
import { ClaudeSubscriptionProvider } from "../providers/claude-subscription.js";
import { trunkSignInRefusal, unwrapProvider } from "./pool-provider.js";

export { trunkKeyRefusal, trunkSignInRefusal } from "./pool-provider.js";

/**
 * mac7/lockdown-fix (R17-005), trunks-use-subscriptions: a Trunk uses the owner's sign-in accounts (a
 * ChatGPT sign-in, an installed program's sign-in: claude, codex, gemini, copilot, and Gemini signed in
 * with Google) as the owner's own assistant does, but only for work the owner is behind. When a household
 * person, another computer, a short-lived key, a chat app or another program is behind a Trunk's work,
 * sign-ins are left out wherever the connection comes from (the task's model list, a side job, an account
 * pool) and only an API key answers: the providers' terms forbid sharing a login with anyone else.
 */
/** True for a connection that answers through somebody's sign-in rather than an API key. */
export function isSignInConnection(preset: Pick<ModelPreset, "id" | "provider">): boolean {
  const provider = unwrapProvider(preset.provider);
  return provider instanceof ChatGPTProvider || provider instanceof CliAgentProvider || provider instanceof ClaudeSubscriptionProvider
    || preset.id.startsWith(chatgptPresetPrefix) || preset.id === "google-gemini";
}

/** The connections a Trunk may use, in the same order; a refusal when none is left. */
export function trunkCandidates<T extends Pick<ModelPreset, "id" | "provider">>(candidates: readonly T[], signIns: boolean): T[] {
  if (signIns) return [...candidates];
  const usable = candidates.filter((preset) => !isSignInConnection(preset));
  if (!usable.length) throw new Error(trunkSignInRefusal);
  return usable;
}
