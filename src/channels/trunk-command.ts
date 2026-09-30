import { trunksFor } from "../trunks/index.js";
import type { CommandContext } from "./chat-commands.js";

/** One request to a named Trunk, without changing which Trunk answers ordinary messages here. */
export async function chatTrunkCommand(argument: string, context: CommandContext): Promise<string> {
  try { return await requestTrunk(argument, context); }
  catch (error) { return context.runtime.hideSecrets(error instanceof Error ? error.message : String(error)); }
}
async function requestTrunk(argument: string, context: CommandContext): Promise<string> {
  if (!context.ownerDm) return "Talk to a named Trunk from your own direct chat on Telegram, Discord, Slack or Matrix.";
  context.runtime.store.profiles.requireOwner("/trunk");
  const trunks = trunksFor(context.runtime);
  if (!trunks || trunks.mode("trunks") === "off") return "Trunks are switched off. Turn them on in Customize → Specialists.";
  const [name = "", ...words] = argument.trim().split(/\s+/);
  if (!name) {
    const roster = trunks.records.list().filter((trunk) => !trunk.hidden);
    return roster.length ? ["Your Trunks:", ...roster.map((trunk) => `@${trunk.handle} — ${trunk.name}`),
      "Send /trunk <name> <message> for one request. Your usual chat stays with the same Trunk."].join("\n") : "You have no Trunks yet.";
  }
  const trunk = trunks.records.resolve(name);
  const text = words.join(" ").trim();
  if (!text) return `Send /trunk ${trunk.handle} <message> for one request. Open its conversation in the Branch app.`;
  if (context.turn) return "Something is working in this chat. Send /stop first, then /trunk <name> <message>.";
  if (!context.trunkRefusal) return "Named Trunk requests are unavailable from this chat.";
  const refused = context.trunkRefusal(trunk.id);
  if (refused) return refused;
  const run = await context.runtime.run({ prompt: text, trunkId: trunk.id, permissions: context.permissions,
    source: "channel", channel: context.channel, onStarted: (started) => context.onTrunkStarted?.(started.id),
    onTextDelta: () => undefined });
  const answer = run.status === "completed" ? run.output || "(no reply)"
    : run.status === "needs_input" ? "This request needs your answer in the Branch app. Your usual chat is unchanged."
    : run.status === "cancelled" ? "Stopped." : "That request could not finish. See Activity in the Branch app.";
  return `@${trunk.handle}: ${answer}`;
}
