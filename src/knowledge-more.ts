import { z } from "zod";
import type { KnowledgeBases } from "./knowledge-bases.js";
import type { KnowledgeCards, RefreshCost } from "./knowledge-cards.js";
import { GraphSchema, type KnowledgeGraph } from "./knowledge-graph.js";
import { MergeSchema, RenameSchema, RetentionSchema, SplitSchema, type KnowledgeManagement } from "./knowledge-manage.js";
import { PicturesSchema, type KnowledgePictures } from "./knowledge-pictures.js";
import { SummariseSchema, type KnowledgeSummaries } from "./knowledge-summary.js";
import type { Proposal } from "./memory-review.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { accessAgent } from "./trunks/memory-scope.js";

/**
 * The tools and routes for everything a knowledge base gained in this batch: a written summary, a
 * map of the things it mentions, pictures described in words, the housekeeping — renaming, merging,
 * splitting, saving out and bringing back — and turning what was said in recent conversations into
 * cards the owner can accept into a collection.
 *
 * Reading is under the permission for reading the person's documents and changing is under the one
 * for changing them, so nothing new has to be granted for any of it.
 */
export const RefreshSchema = z.object({
  collection: z.string().trim().min(1).max(120),
  /** How many recent conversations to read for things worth keeping. */
  conversations: z.number().int().min(1).max(10).default(3),
}).strict();

/** Everything these features hold together, so the panel gets it in one request. */
export interface KnowledgeExtras {
  graphs: ReturnType<KnowledgeGraph["summary"]>;
  sizes: ReturnType<KnowledgeManagement["sizes"]>;
  retention: z.infer<typeof RetentionSchema>;
  picturesReady: boolean;
}
export interface KnowledgeParts {
  bases: KnowledgeBases; graph: KnowledgeGraph; summaries: KnowledgeSummaries;
  management: KnowledgeManagement; pictures: KnowledgePictures; cards?: KnowledgeCards;
}
export const extrasView = (parts: KnowledgeParts, owner: string): KnowledgeExtras => ({
  graphs: parts.graph.summary(owner), sizes: parts.management.sizes(owner),
  retention: parts.management.settings(owner), picturesReady: parts.pictures.ready(owner),
});

/**
 * Cards written up from the last few conversations and put in the review queue for this collection.
 * Nothing is added to the knowledge base here: a suggestion is made, and the owner accepts it in the
 * Memory screen exactly as with every other thing the assistant proposes to remember.
 */
export async function refreshFromConversations(
  parts: KnowledgeParts, store: Store, owner: string, input: unknown, signal?: AbortSignal, agent?: string,
): Promise<{ collection: string; staged: Proposal[]; conversations: number; cost: RefreshCost | null; reason: string }> {
  const { collection, conversations } = RefreshSchema.parse(input);
  const target = parts.bases.one(owner, collection);
  if (!parts.cards) return { collection: target.id, staged: [], conversations: 0, cost: null, reason: "Writing up conversations is not available in this launch." };
  // Wave 9: what this reading actually cost, by the same reckoning the owner was shown beforehand.
  const cost = parts.cards.cost(owner, conversations, agent);
  const recent = parts.cards.recent(owner, conversations, agent);
  const staged: Proposal[] = [];
  const reasons: string[] = [];
  for (const sessionId of recent) {
    const proposed = await parts.cards.propose(owner, { sessionId, collection: target.id }, signal, agent)
      .catch(() => ({ staged: [] as Proposal[], reason: "" }));
    staged.push(...proposed.staged);
    if (proposed.reason) reasons.push(proposed.reason);
  }
  return { collection: target.id, staged, conversations: recent.length, cost,
    reason: staged.length ? "" : (reasons[0] ?? "Nothing in those conversations was worth keeping.") };
}

export function registerKnowledgeExtras(registry: ToolRegistry, parts: KnowledgeParts, store: Store): void {
  registry.register({
    name: "knowledge.summarise", group: "documents", permission: "documents.read",
    description: "Sum up a whole knowledge base, or one subject in it, with a numbered source under every point. Kept until the files change.",
    parameters: SummariseSchema,
    execute: async (input, context) => parts.summaries.summarise(context.owner, input, context.signal),
  });
  registry.register({
    name: "knowledge.graph", group: "documents", permission: "documents.read",
    description: "Everything a knowledge base links to one name, with the passage each link came from. Build the map first with knowledge.map.",
    parameters: GraphSchema,
    execute: async (input, context) => parts.graph.neighbourhood(context.owner, input),
  });
  registry.register({
    name: "knowledge.map", group: "documents", permission: "documents.write",
    description: "Build the map of names and links for a knowledge base from the passages it holds.",
    parameters: z.object({
      collection: z.string().trim().min(1).max(120),
      useModel: z.boolean().default(false),
    }).strict(),
    execute: async (input, context) => parts.graph.build(context.owner, input.collection, input.useModel, context.signal),
  });
  registry.register({
    name: "knowledge.pictures", group: "documents", permission: "documents.write",
    description: "Describe a knowledge base's pictures with a model that can see and index each description. Each is described once; estimateOnly says what it would cost.",
    parameters: PicturesSchema,
    execute: async (input, context) => parts.pictures.describe(context.owner, input, context.signal),
  });
  registry.register({
    name: "knowledge.manage", group: "documents", permission: "documents.write",
    description: "Rename a knowledge base, merge one into another, or split one folder out into its own.",
    parameters: z.object({
      rename: RenameSchema.optional(), merge: MergeSchema.optional(), split: SplitSchema.optional(),
    }).strict(),
    target: (input: { rename?: unknown; merge?: unknown; split?: unknown }) => {
      if ((input.split as any)?.folder) return (input.split as any).folder;
      return "";
    },
    execute: async (input, context) => manage(parts, context.owner, input),
  });
  registry.register({
    name: "knowledge.refresh", group: "documents", permission: "documents.write",
    description: "Suggest fact cards for a knowledge base from the last few conversations. Suggestions only; the owner accepts them.",
    parameters: RefreshSchema,
    execute: async (input, context) => refreshFromConversations(parts, store, context.owner, input, context.signal, accessAgent(context)), // Q143
  });
}
async function manage(parts: KnowledgeParts, owner: string, input: { rename?: unknown; merge?: unknown; split?: unknown }) {
  if (input.rename) return { renamed: parts.management.rename(owner, input.rename) };
  if (input.merge) return { merged: await parts.management.merge(owner, input.merge) };
  if (input.split) return { split: parts.management.split(owner, input.split) };
  throw new Error("Say which it is: rename, merge or split");
}

/** The routes behind the Documents panel's new buttons; server.ts gains one line for all of them. */
export async function knowledgeExtrasApi(
  parts: KnowledgeParts, store: Store, owner: string, method: string, path: string, body: () => Promise<unknown>,
): Promise<unknown> {
  if (method === "GET" && path === "/api/knowledge/extras") return extrasView(parts, owner);
  if (method === "POST" && path === "/api/knowledge/summarise")
    return parts.summaries.summarise(owner, await body(), AbortSignal.timeout(180000));
  if (method === "POST" && path === "/api/knowledge/graph") return parts.graph.neighbourhood(owner, await body());
  if (method === "POST" && path === "/api/knowledge/graph/names") return parts.graph.names(owner, await body()); // p17
  if (method === "POST" && path === "/api/knowledge/map") {
    const input = z.object({ collection: z.string().min(1).max(120), useModel: z.boolean().default(false) }).parse(await body());
    return parts.graph.build(owner, input.collection, input.useModel);
  }
  if (method === "POST" && path === "/api/knowledge/pictures")
    return parts.pictures.describe(owner, await body(), AbortSignal.timeout(300000));
  if (method === "POST" && path === "/api/knowledge/manage") return manage(parts, owner, (await body()) as Record<string, unknown>);
  if (method === "POST" && path === "/api/knowledge/retention") return parts.management.configure(owner, await body());
  if (method === "POST" && path === "/api/knowledge/retention/check") return parts.management.proposeRetention(owner);
  if (method === "POST" && path === "/api/knowledge/refresh") return refreshFromConversations(parts, store, owner, await body());
  if (method === "POST" && path === "/api/knowledge/export") {
    const { collection } = z.object({ collection: z.string().min(1).max(120) }).parse(await body());
    const saved = parts.management.exportCollection(owner, collection);
    return { name: saved.name, documents: saved.documents, bytes: saved.bytes.byteLength, content: saved.bytes.toString("base64") };
  }
  if (method === "POST" && path === "/api/knowledge/import") {
    const input = z.object({ content: z.string().min(1), name: z.string().max(120).optional() }).parse(await body());
    return parts.management.importCollection(owner, Buffer.from(input.content.replace(/^data:[^,]*,/, ""), "base64"), input.name);
  }
  return undefined;
}
