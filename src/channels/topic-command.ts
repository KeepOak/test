import type { CommandContext } from "./chat-commands.js";

/** CHAT-081: create a native topic; the adapter's existing topic address keeps its session separate. */
export async function chatTopicCommand(argument: string, context: CommandContext): Promise<string> {
  try {
    if (!context.ownerDm || !context.createTopic) return "Create a topic from your own live Telegram direct chat.";
    const { store, owner } = context.runtime;
    store.profiles.requireOwner("Creating a Telegram private topic");
    if (!context.topicRefusal) return "Topic creation is unavailable from this chat.";
    const refusal = context.topicRefusal();
    if (refusal) return refusal;
    if (!argument.trim()) return "Send /topic <name> to create a separate Telegram conversation. Enable forum topic mode for this bot in BotFather first. Existing topics already have separate conversations; this chat stays as it is.";
    if (context.turn) return "Something is working here. Send /stop first, then /topic <name>.";
    if (!context.from?.messageId) return "The Telegram message identity is missing, so no topic was created.";
    if (/[\u0000-\u001f]/.test(argument)) return "Give the topic a name on one line.";
    const key = `topic-request:${context.channel}:${context.chatId}:${context.from.messageId}`;
    const previous = store.get("settings", owner, key)?.data as { address?: string } | undefined;
    if (previous) return previous.address ? `The topic from this request is ${previous.address}. Open it in Telegram to continue.`
      : "This topic request was already sent. Its outcome is uncertain; check Telegram before sending a new /topic request.";
    // Telegram has no creation idempotency key: record intent before the request, never replay an uncertain write.
    store.save("settings", owner, key, { requestedAt: new Date().toISOString() });
    const address = await context.createTopic(argument);
    store.save("settings", owner, key, { address, createdAt: new Date().toISOString() });
    return "Topic created. Open it in Telegram and send your first message to start its own conversation. This chat's conversation was kept.";
  } catch (error) {
    return context.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
  }
}
