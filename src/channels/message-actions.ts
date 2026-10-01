import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { ChannelRouter } from "./router.js";
import type { OwnerCheck } from "./connectors.js";

export const OwnMessagesSchema = z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(50).default(20) }).strict();
export const OwnMessageSchema = z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64),
  messageId: z.string().min(1).max(64) }).strict();
const EditSchema = OwnMessageSchema.extend({ text: z.string().trim().min(1).max(4096) }).strict();
export type OwnMessageTarget = z.infer<typeof OwnMessageSchema>;

/**
 * Outside Full Access, changing or deleting what other people already read is asked about once, for this exact message.
 * Full Access does not ask (owner ruling 2026-09-30: there only dangerous commands and loosening a protection ask), and
 * src/runtime.ts consults this hold only outside Full Access.
 */
export function ownMessageHold(tool: string): { reason: string; onceOnly: true } | null {
  return tool === "channels.edit_message" || tool === "channels.delete_message"
    ? { reason: "Changing or deleting a message people may already have read asks first, just this once", onceOnly: true } : null;
}

/** Only recorded own deliveries are editable; arbitrary transport message IDs are never enough. */
export function registerOwnMessageTools(registry: ToolRegistry, router: ChannelRouter, people: OwnerCheck): void {
  registry.register({ name: "channels.own_messages", permission: "channels.send",
    description: "List recent messages Branch itself successfully sent to one chat, with exact message IDs and edit/delete availability. Only retained delivery-ledger messages are included; this does not read anybody else's chat history.",
    parameters: OwnMessagesSchema, targets: (input) => [{ kind: "read", path: `${input.channel}:${input.chatId}` }],
    execute: async (input, context) => { people.requireOwner("Reading Branch's own sent chat messages"); router.requireMessageActionOwner(context); return router.ownMessages(input); } });
  registry.register({ name: "channels.edit_message", permission: "channels.send",
    description: "When the owner asks, replace one earlier text message Branch itself sent. Use channels.own_messages for its exact message ID. Requires a retained own-delivery record and an app supporting edits; never edits somebody else's message. Service time limits and failures are returned honestly.",
    parameters: EditSchema, targets: (input) => [{ kind: "write", path: `${input.channel}:${input.chatId}` }],
    execute: async (input, context) => { people.requireOwner("Editing Branch's own sent chat message"); return router.actOnOwnMessage(input, "edit", context, input.text); } });
  registry.register({ name: "channels.delete_message", permission: "channels.send",
    description: "When the owner asks, delete one earlier message Branch itself sent. Use channels.own_messages for its exact message ID. Requires a retained own-delivery record and an app supporting deletion; never deletes somebody else's message. A deletion cannot be undone by Branch.",
    parameters: OwnMessageSchema, targets: (input) => [{ kind: "write", path: `${input.channel}:${input.chatId}` }],
    execute: async (input, context) => { people.requireOwner("Deleting Branch's own sent chat message"); return router.actOnOwnMessage(input, "delete", context); } });
}
