import { startedWithShortLivedKey } from "../key-context.js";
import type { CommandContext } from "./chat-commands.js";
import { chatThreadLifecycle, saveChatThreadLifecycle, sessionDurationMs } from "./thread-lifecycle.js";

const usage = "Send /session idle <duration|off> or /session max-age <duration|off> (for example, 24h). Bare /session shows this chat's limits.";
export function chatSessionCommand(argument: string, context: CommandContext): string {
  try {
    if (!context.ownerDm || startedWithShortLivedKey()) return "Choose session limits from your own live direct chat on Telegram, Discord, Slack or Matrix.";
    const { store, owner } = context.runtime;
    store.profiles.requireOwner("Choosing a chat's session expiry");
    if (!context.sessionRefusal) return "Session limits are unavailable from this chat.";
    const refusal = context.sessionRefusal();
    if (refusal) return refusal;
    const words = argument.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const field = words[0] === "idle" ? "idleTimeoutMs" : words[0] === "max-age" ? "maxAgeMs" : undefined;
    if (words.length && (!field || words.length > 2)) return usage;
    if (words.length === 2) {
      if (context.turn) return "Something is working here. Send /stop first, then choose the session limit.";
      const duration = sessionDurationMs(words[1]!);
      saveChatThreadLifecycle(store, owner, context.channel, context.chatId, { [field!]: duration });
    }
    const policy = chatThreadLifecycle(store, owner, context.channel, context.chatId);
    const show = (ms: number) => ms ? `${ms / 60_000} minutes` : "off";
    return `This chat: idle ${show(policy.idleTimeoutMs)}; maximum age ${show(policy.maxAgeMs)}. Limits are checked before your next ordinary message. Running or waiting tasks keep their conversation; earlier conversations stay in history.`;
  } catch (error) {
    return context.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
  }
}
