import { startedWithShortLivedKey } from "../key-context.js";
import type { CommandContext } from "./chat-commands.js";
import { chatPersonalities, chatPersonality, resolveChatPersonality, saveChatPersonality } from "./personality-settings.js";

export function chatPersonalityCommand(argument: string, context: CommandContext): string {
  try {
    if (!context.ownerDm || startedWithShortLivedKey()) return "Choose a reply tone from your own live direct chat on Telegram, Discord, Slack or Matrix.";
    const { store, owner } = context.runtime;
    store.profiles.requireOwner("Choosing this chat's reply tone");
    if (!context.personalityRefusal) return "Reply tones are unavailable from this chat.";
    const refusal = context.personalityRefusal();
    if (refusal) return refusal;
    if (!argument.trim()) return `This chat's reply tone: ${chatPersonality(store, owner, context.channel, context.chatId)}. Send /personality ${chatPersonalities.join(" | ")}. It changes presentation for the next task in this chat.`;
    const tone = resolveChatPersonality(argument);
    saveChatPersonality(store, owner, context.channel, context.chatId, tone);
    return `Reply tone for the next task in this chat: ${tone}. Running tasks keep their starting tone. Your Trunk's personality and other chats keep their choices.`;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") return `Choose one of: ${chatPersonalities.join(", ")}.`;
    return context.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
  }
}
