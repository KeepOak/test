import type { ChannelRouter } from "./router.js";

/** Local metadata only: no provider calls, chat text, sender IDs, bot names or secrets. */
export function telegramDepth(router: ChannelRouter) {
  const summary = router.summary();
  const channels = summary.channels.filter((channel) => channel.kind === "telegram");
  return {
    measuredAt: new Date().toISOString(),
    live: summary.live,
    connections: channels.map((channel) => {
      const adapter = router.adapter(channel.id);
      return {
        health: channel.health.state,
        activation: channel.activation,
        pairing: channel.pairing,
        allowlistedSenders: channel.allowlist.length,
        maxTextLength: adapter?.maxTextLength ?? null,
        typing: typeof adapter?.sendTyping === "function",
        reactions: typeof adapter?.react === "function",
        edits: typeof adapter?.edit === "function",
        buttons: typeof adapter?.sendButtons === "function",
        voiceReplies: typeof adapter?.sendVoice === "function",
      };
    }),
  };
}
