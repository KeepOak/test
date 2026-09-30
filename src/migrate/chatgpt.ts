import { asRecord, asString, chatRefusal, found, tidyMessages } from "./common.js";
import type { ScanInput } from "./scan.js";
import { ChatProvenanceSchema, clip, type FoundItem, type MovedMessage, type ScanResult } from "./types.js";

/** Only an export the owner supplied is read. No account, local browser or model is contacted. */
export async function scanChatGPT({ tree }: ScanInput): Promise<ScanResult> {
  const text = await tree.read("conversations.json", 32 * 1024 * 1024);
  if (!text) throw new Error("Choose a ChatGPT export containing conversations.json (up to 32 MB)");
  let exported: unknown;
  try { exported = JSON.parse(text); } catch { throw new Error("The ChatGPT conversations.json could not be read"); }
  if (!Array.isArray(exported)) throw new Error("ChatGPT conversations.json must contain a list of conversations");
  if (exported.length > 2000) throw new Error("Choose an export with at most 2000 conversations");
  const items: FoundItem[] = [], notes = [
    "Each branch is offered separately, with its original conversation and parent-linked node path. Shared messages are repeated in those branches.",
    "Only visible user and assistant text comes over as imported history. System instructions, hidden reasoning, tool messages, files, pictures and other non-text parts are left out. Nothing becomes saved memory or an instruction.",
  ];
  const seen = new Set<string>();
  for (const raw of exported) {
    const conversation = asRecord(raw), id = asString(conversation.id) || asString(conversation.conversation_id);
    if (!id || id.length > 200 || seen.has(id)) throw new Error("The export has missing, repeated or oversized conversation IDs");
    seen.add(id);
    const mapping = asRecord(conversation.mapping), ids = Object.keys(mapping);
    if (!ids.length || ids.length > 20000 || ids.some((node) => !node || node.length > 200))
      throw new Error("A ChatGPT conversation has missing or oversized mapping nodes");
    const parents = new Set<string>();
    for (const nodeId of ids) {
      const parent = asRecord(mapping[nodeId]).parent;
      if (parent !== null && parent !== undefined && (typeof parent !== "string" || !(parent in mapping)))
        throw new Error("A ChatGPT conversation has an incomplete parent mapping");
      if (typeof parent === "string") parents.add(parent);
    }
    const leaves = ids.filter((node) => !parents.has(node));
    if (!leaves.length) throw new Error("A ChatGPT conversation has no complete branch");
    for (const leaf of leaves) {
      if (items.length >= 2000) throw new Error("Choose an export with at most 2000 conversation branches");
      const path: string[] = [], visited = new Set<string>();
      let cursor: string | undefined = leaf;
      while (cursor !== undefined) {
        if (visited.has(cursor)) throw new Error("A ChatGPT conversation has a cyclic parent mapping");
        visited.add(cursor); path.push(cursor);
        if (path.length > 1000) throw new Error("A ChatGPT branch has more than 1000 mapping nodes");
        const parent = asRecord(mapping[cursor]).parent;
        cursor = typeof parent === "string" ? parent : undefined;
      }
      path.reverse();
      const messages: MovedMessage[] = [];
      let omittedParts = 0;
      for (const node of path) {
        const message = asRecord(asRecord(mapping[node]).message);
        if (!Object.keys(message).length) continue;
        const role = asString(asRecord(message.author).role), channel = asString(message.channel);
        const content = asRecord(message.content), parts = content.parts;
        const metadata = asRecord(message.metadata);
        if ((role !== "user" && role !== "assistant") || (channel && channel !== "final")
          || (message.recipient && message.recipient !== "all") || metadata.is_visually_hidden_from_conversation === true
          || (content.content_type !== "text" && content.content_type !== "multimodal_text") || !Array.isArray(parts)) {
          omittedParts++; continue;
        }
        // Strings in a multimodal message remain useful; references and image/audio objects do not become words.
        const words = parts.filter((part): part is string => typeof part === "string");
        omittedParts += parts.length - words.length;
        if (words.length) messages.push({ role, content: words.join("\n\n") });
      }
      const clean = tidyMessages(messages), refusal = chatRefusal(clean);
      const provenance = ChatProvenanceSchema.parse({ conversationId: id, leafId: leaf, nodePath: path,
        current: conversation.current_node === leaf, omittedParts });
      const title = clip(asString(conversation.title) || "A ChatGPT conversation", 100);
      const detail = refusal ?? `${clean.length} text messages; branch ${leaves.indexOf(leaf) + 1} of ${leaves.length}${provenance.current ? " (current)" : ""}; ${omittedParts} non-text or non-visible parts left out.`;
      const item = found("chatgpt", "chat", JSON.stringify(["conversations.json", id, leaf]), title, detail,
        refusal ? null : { kind: "chat", messages: clean, folder: "" });
      item.provenance = provenance;
      items.push(item);
    }
    // Disconnected cycles can have no leaf: ensure every original node belongs to an offered path.
    const covered = new Set(items.filter((item) => item.provenance?.conversationId === id)
      .flatMap((item) => item.provenance!.nodePath));
    if (ids.some((node) => !covered.has(node))) throw new Error("A ChatGPT conversation has disconnected mapping nodes");
  }
  return { items, keys: [], notes };
}
