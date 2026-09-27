import { z } from "zod";
import type { RemoteAgents } from "../a2a-client.js";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { SessionTokens } from "../session-tokens.js";
import type { Store } from "../store.js";
import { requireInterop } from "./settings.js";

/**
 * Carrying on a conversation somewhere else: on another device (the phone through the paired
 * address, or another computer's browser), in a terminal, or with another assistant.
 *
 * - Another device gets a link that opens this very conversation and a short-lived key that may
 *   look and start tasks in that conversation only (bucket 19), and stops working at the minute
 *   shown. The key is shown to the owner once and never given to the model: only the owner's own
 *   window can ask for it.
 * - A terminal gets the one command that joins the running engine's conversation.
 * - Another assistant (an A2A one the owner added) is sent the recent conversation, with keys and
 *   saved passwords scrubbed out, and asked to carry on; its answer comes back here.
 *
 * The idea is from jcode's remote handoff; this is an independent implementation.
 */
export const HandoffSchema = z.object({
  sessionId: z.string().uuid(),
  to: z.enum(["device", "terminal", "assistant"]),
  /** How long the other device's key works for. */
  minutes: z.number().int().min(5).max(240).default(30),
  /** For "assistant": which assistant elsewhere, by name or id. */
  agent: z.string().trim().min(1).max(200).optional(),
}).strict();
export type HandoffInput = z.input<typeof HandoffSchema>;

export interface HandoffParts {
  store: Store; owner: string; tokens: SessionTokens; remoteAgents: RemoteAgents;
  scrub: (text: string) => string;
}

const clock = (iso: string): string => iso.slice(11, 16);

/** The recent part of a conversation, as plain lines, for another assistant to read. */
export function transcriptFor(store: Store, sessionId: string, scrub: (text: string) => string, limit = 20): string {
  return store.messages(sessionId)
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.from !== "branch")
    .slice(-limit)
    .map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${scrub(String(m.content)).slice(0, 2000)}`)
    .join("\n");
}

function note(store: Store, sessionId: string, text: string): void {
  store.message(sessionId, { role: "system", content: text });
}

/** Hands a conversation on. `base` is the address the other device should open. */
export async function handOff(parts: HandoffParts, input: HandoffInput, base: string, context?: ToolContext) {
  requireInterop(parts.store, parts.owner, "handoff");
  const value = HandoffSchema.parse(input);
  if (!parts.store.ownsSession(parts.owner, value.sessionId)) throw new Error("That conversation is not one of yours");
  if (value.to === "terminal") {
    return { to: "terminal", command: `branch chat --attach --session ${value.sessionId}`,
      steps: "Run this in a terminal on this computer while Branch is running; both places see the same conversation." };
  }
  if (value.to === "assistant") {
    if (!value.agent) throw new Error("Say which assistant elsewhere should carry on");
    const transcript = transcriptFor(parts.store, value.sessionId, parts.scrub);
    const answer = await parts.remoteAgents.ask({ agent: value.agent,
      task: `Please carry on this conversation from where it stopped. Here is what was said so far:\n\n${transcript}` },
    context?.signal, context?.runId);
    note(parts.store, value.sessionId, `Handed to ${answer.agent}, which answered: ${answer.answer.slice(0, 1000)}`);
    return { to: "assistant", agent: answer.agent, state: answer.state, answer: answer.answer };
  }
  // bucket 19: the key reaches this one conversation and nothing else of the owner's.
  const issued = parts.tokens.create(parts.owner, { name: `Carry on a conversation (${value.sessionId.slice(0, 8)})`, scope: "run",
    minutes: value.minutes, sessionId: value.sessionId });
  const link = `${base.replace(/\/+$/, "")}/people#handoff=${value.sessionId}`; // bucket 19: the one-conversation page
  note(parts.store, value.sessionId, `Handed to another device until ${clock(issued.entry.expiresAt)} (UTC).`);
  return {
    to: "device", link, key: issued.token, keyId: issued.entry.id, expiresAt: issued.entry.expiresAt,
    steps: "Open the link on the other device, paste the key where the app asks for it, and the conversation opens there. Take the key back in Settings at any time.",
  };
}

/** The model may hand a conversation to a terminal or another assistant, never mint a key for a device. */
export function registerHandoffTool(registry: ToolRegistry, parts: HandoffParts): void {
  registry.register({
    name: "conversation.handoff", group: "memory", permission: "sessions.handoff",
    description: "Carry this conversation on in a terminal, or hand it to an assistant elsewhere with what was said so far.",
    // Ships-on sweep (2026-09-26): the rules judge a hand-off by where the conversation goes.
    target: (args) => (args.to === "assistant" ? `hand this conversation to ${args.agent ?? "an assistant"}` : "carry this conversation on in a terminal"),
    parameters: z.object({
      to: z.enum(["terminal", "assistant"]),
      agent: z.string().trim().min(1).max(200).optional(),
    }).strict(),
    execute: async (args, context) => {
      const run = parts.store.run(context.runId);
      if (!run) throw new Error("This task has no conversation to hand on");
      return handOff(parts, { sessionId: run.sessionId, to: args.to, ...(args.agent ? { agent: args.agent } : {}) }, "", context);
    },
  });
}
