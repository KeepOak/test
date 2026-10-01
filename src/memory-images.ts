import { z } from "zod";
import type { Attachments } from "./attachments.js";
import type { ToolContext } from "./contracts.js";
import { MemoryDataSchema, memoryScope, visibleTo, writableTo, type MemoryRecord } from "./memory.js";
import type { MemoryProvider } from "./memory-provider.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { memoryAgent } from "./trunks/memory-scope.js";

const factId = z.string().min(1).max(200);
const revision = z.number().int().positive();
const pictureTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
type Parts = { store: Store; attachments: Attachments; provider: MemoryProvider };

function privateFact(parts: Parts, context: ToolContext, id: string, expectedRevision?: number) {
  parts.store.profiles.requireOwner("Tying a saved fact to a local picture");
  const owner = memoryScope(parts.store, context), agent = memoryAgent(context);
  if (parts.provider.view(owner).settings.mode !== "built-in") throw new Error("Picture references are kept only in this computer's memory");
  const record = parts.store.get("memory", owner, id) as MemoryRecord | undefined;
  if (!record || !visibleTo(record, agent) || !writableTo(record, agent) || record.data.scope === "shared")
    throw new Error("That private fact is not available");
  if (expectedRevision !== undefined && record.revision !== expectedRevision)
    throw new Error("Memory changed since you opened it. Reload it before saving.");
  return { owner, record, data: MemoryDataSchema.parse(record.data) };
}

function writableFact(parts: Parts, context: ToolContext, id: string, expectedRevision: number) {
  const fact = privateFact(parts, context, id, expectedRevision);
  if (parts.store.review.settings(fact.owner).requireApproval)
    throw new Error("Picture references cannot be changed while memory changes require review");
  return fact;
}

async function sourcePicture(parts: Parts, owner: string, image: { sessionId: string; attachmentId: string }) {
  if (!parts.store.ownsSession(owner, image.sessionId) || parts.store.sessionTemporary(image.sessionId)) return null;
  try {
    const found = await parts.attachments.locate(image.sessionId, image.attachmentId);
    if (!parts.store.ownsSession(owner, image.sessionId) || parts.store.sessionTemporary(image.sessionId)
      || found.ref.kind !== "picture" || !pictureTypes.has(found.ref.mediaType)) return null;
    return found.ref;
  } catch { return null; }
}

async function attachPicture(parts: Parts, context: ToolContext, input: { id: string; attachmentId: string; expectedRevision: number }) {
  if (!context.permissions.has("documents.read")) throw new Error("Permission denied: documents.read");
  const before = writableFact(parts, context, input.id, input.expectedRevision);
  const sessionId = parts.store.run(context.runId)?.sessionId;
  if (!sessionId) throw new Error("This task has no conversation to take a picture from");
  if (parts.store.memorySuppressed(before.owner, sessionId)) throw new Error("Memory from this conversation was forgotten");
  const image = { sessionId, attachmentId: input.attachmentId };
  if (!await sourcePicture(parts, before.owner, image)) throw new Error("Attach a kept PNG, JPEG, WebP or GIF from this persistent conversation");
  const current = writableFact(parts, context, input.id, input.expectedRevision);
  if (parts.store.memorySuppressed(current.owner, sessionId)) throw new Error("Memory from this conversation was forgotten");
  const saved = parts.store.save("memory", current.owner, input.id, { ...current.data, image }) as MemoryRecord;
  return { id: saved.id, revision: saved.revision, attached: true, retention: "The original stays with its conversation; no copy was made." };
}

async function readPicture(parts: Parts, context: ToolContext, id: string) {
  if (!context.permissions.has("documents.read")) throw new Error("Permission denied: documents.read");
  const before = privateFact(parts, context, id);
  if (!before.data.image) return { available: false, reason: "This fact has no picture reference" };
  const found = await sourcePicture(parts, before.owner, before.data.image);
  const current = privateFact(parts, context, id, before.record.revision);
  if (!found || !current.data.image) return { available: false, reason: "The original picture is no longer available in its conversation" };
  const image = current.data.image;
  return { available: true, name: found.name, mediaType: found.mediaType,
    open: `/api/attachments/file?${new URLSearchParams({ session: image.sessionId, id: image.attachmentId })}`,
    retention: "The original stays with its conversation. This link still requires the authenticated attachment viewer." };
}

async function detachPicture(parts: Parts, context: ToolContext, input: { id: string; expectedRevision: number }) {
  const before = writableFact(parts, context, input.id, input.expectedRevision);
  const sourceAvailable = before.data.image ? Boolean(await sourcePicture(parts, before.owner, before.data.image)) : false;
  const current = writableFact(parts, context, input.id, input.expectedRevision);
  const { image: _image, ...data } = current.data; void _image;
  const saved = parts.store.save("memory", current.owner, input.id, data) as MemoryRecord;
  return { id: saved.id, revision: saved.revision, detached: true, sourceAvailable,
    retention: "Only this fact's current reference was removed. Its undo history and the conversation's original are unchanged." };
}

export function registerMemoryImages(registry: ToolRegistry, parts: Parts): void {
  registry.register({ name: "memory.attach_image", permission: "memory.write",
    description: "Tie an existing private saved fact to a kept picture attached to this conversation. Requires documents.read too. Local memory only; no copy, vision call or extra image retention. Temporary conversations and shared facts cannot be tied.",
    parameters: z.object({ id: factId, attachmentId: z.string().regex(/^[a-f0-9]{16}$/), expectedRevision: revision }).strict(),
    execute: async (input, context) => attachPicture(parts, context, input) });
  registry.register({ name: "memory.image", permission: "memory.read",
    description: "Check a private fact's local picture and return its authenticated viewer link if the original still exists. Requires documents.read too. It does not open the image or call a vision model.",
    parameters: z.object({ id: factId }).strict(), execute: async ({ id }, context) => readPicture(parts, context, id) });
  registry.register({ name: "memory.detach_image", permission: "memory.write",
    description: "Remove a private fact's current local picture reference. Does not delete the conversation's original or undo history. A missing original can still be detached.",
    parameters: z.object({ id: factId, expectedRevision: revision }).strict(),
    execute: async (input, context) => detachPicture(parts, context, input) });
}
