import { trunksFor } from "../trunks/index.js";
import type { Call, Reply } from "./handlers.js";

/**
 * R17-A: `/trunk` (and `/trunks`). On its own it lists the owner's Trunks and opens where they are
 * kept; `/trunk <name> <message>` talks to one in its own conversation and answers with what it said.
 * A message written `@name …` in the message box is sent this way too (public/trunks.js).
 */
const say = (text: string, client?: Reply["client"]): Reply => (client ? { text, client } : { text });

export async function trunkCommand(call: Call): Promise<Reply> {
  // Chat routing verifies the live owner account and narrows permissions in its own runner.
  if (call.surface === "chat") return say("Send /trunk from your own direct chat through the chat router.");
  // Integrator (R17-A): Trunks are the owner's, like /account; a household profile is refused outright.
  call.host.requireOwner("/trunk");
  const trunks = trunksFor(call.host.runtime);
  if (!trunks || trunks.mode("trunks") === "off")
    return say("Trunks are switched off. Switch them on in Customize → Specialists, under Trunks.", { do: "go", home: "customize:specialists" });
  const [first = "", ...rest] = call.argument.trim().split(/\s+/);
  if (!first) {
    const lines = trunks.records.list().filter((t) => !t.hidden).map((t) => `@${t.handle} — ${t.name}${t.title ? `, ${t.title}` : ""}`);
    return say(lines.length ? ["Your Trunks:", ...lines].join("\n") : "You have no Trunks yet. Make one in Customize.", { do: "go", home: "customize:specialists" });
  }
  const trunk = trunks.records.resolve(first);
  const message = rest.join(" ").trim();
  if (!message) return say(`Opening ${trunk.name}'s conversation.`, { do: "open-session", id: trunk.chatSessionId });
  if (call.access === "read") return say("This key can only look, so it cannot talk to a Trunk.");
  const answer = await trunks.say(trunk.id, message);
  if (answer.queued) return say(`${trunk.name} is busy; your message is waiting in its conversation.`);
  return say(`@${trunk.handle}: ${answer.output ?? ""}`.trim());
}
