import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { helperParent } from "../helper-control.js";
import { memoryFileName, memoryTypes, type TrunkFiles } from "./files.js";
import type { TrunkRecords } from "./record.js";

/**
 * The lead's workbench (SELF-311): the memory a Trunk keeps for itself, read at the start of every turn and edited by the
 * Trunk as it works, like Claude Code's MEMORY.md and its memory folder. MEMORY.md and the list of memory files (name,
 * type, one-line description) reach every turn through the Trunk's own files (src/trunks/files.ts instructions); these
 * tools read a file's body, write one, and delete one. They reach only the Trunk whose turn this is (its helpers work for
 * it, so they reach it too), and only MEMORY.md and the memory files: never its SOUL.md, AGENTS.md or anything that
 * shapes who it is or what it may do. A turn that is no Trunk's has no memory files to keep.
 * They sit in the "memory-extra" box (src/catalog.ts), so opening the everyday boxes stays inside its budget.
 */
const trunkOfRun = (store: Store, runId: string): string | null => {
  const seen = new Set<string>();
  for (let id: string | null = runId; id && !seen.has(id) && seen.size < 20; id = helperParent(store, id)) {
    seen.add(id);
    const turn = store.events(id).find((event) => event.kind === "trunk.turn")?.data.trunkId;
    if (typeof turn === "string") return turn;
  }
  return null;
};

export function registerTrunkMemoryFiles(registry: ToolRegistry, store: Store, trunks: { records: TrunkRecords; files: TrunkFiles }): void {
  const trunkFor = (context: ToolContext): string => {
    const id = context.trunk ?? (context.runId ? trunkOfRun(store, context.runId) : null);
    if (!id) throw new Error("Memory files belong to a Trunk, and this conversation is not one's. Use memory.keep to remember something.");
    if (!trunks.records.find(id)) throw new Error("This Trunk's memory files are kept in its own person's window.");
    return id;
  };
  const actor = (id: string) => `trunk:${id}`;
  registry.register({
    name: "memory.files", permission: "memory.read", group: "memory-extra",
    description: "Your MEMORY.md and the list of your memory files (name, type, one-line description). Both are also given to you at the start of every turn.",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => {
      const id = trunkFor(context);
      const index = trunks.files.view(id).files.find((file) => file.name === "MEMORY.md")?.text ?? "";
      return { "MEMORY.md": index, files: Object.entries(trunks.files.memories(id)).map(([name, file]) => ({ name, type: file.type, description: file.description, updatedAt: file.updatedAt })) };
    },
  });
  registry.register({
    name: "memory.read_file", permission: "memory.read", group: "memory-extra",
    description: "Read one of your memory files (or MEMORY.md) in full: its description and type, then its body.",
    parameters: z.object({ name: z.string().trim().min(1).max(64) }).strict(),
    execute: async (input, context) => {
      const id = trunkFor(context);
      if (input.name === "MEMORY.md") return { name: "MEMORY.md", body: trunks.files.view(id).files.find((file) => file.name === "MEMORY.md")?.text ?? "" };
      const file = trunks.files.memories(id)[input.name.replace(/\.md$/, "")];
      if (!file) throw new Error(`There is no memory file named "${input.name}". memory.files lists them.`);
      return { name: input.name.replace(/\.md$/, ""), ...file };
    },
  });
  registry.register({
    name: "memory.write_file", permission: "memory.write", group: "memory-extra",
    description: "Write one of your memory files, or MEMORY.md itself (the index you read every turn: one line per memory file, and anything you always want in front of you). "
      + "A memory file holds one fact, rule or pointer, with a one-line description and a type: user (who the person is), feedback (how they want you to work), "
      + "project (what is going on and why) or reference (where things live). Writing a name again replaces it. Keep them short and true; they never grant permissions.",
    parameters: z.object({
      name: z.string().trim().min(1).max(64).describe("MEMORY.md, or a memory file's name: small letters, digits, - or _ (such as feedback_merge_rule)."),
      body: z.string().max(8000),
      description: z.string().trim().min(1).max(200).optional(),
      type: z.enum(memoryTypes).optional(),
    }).strict(),
    execute: async (input, context) => {
      const id = trunkFor(context);
      const name = input.name === "MEMORY.md" ? input.name : memoryFileName.parse(input.name.replace(/\.md$/, ""));
      trunks.files.writeMemory(id, actor(id), { name, body: input.body, description: input.description, type: input.type });
      return { saved: name };
    },
  });
  registry.register({
    name: "memory.delete_file", permission: "memory.write", group: "memory-extra",
    description: "Delete one of your memory files that is wrong or no longer needed (MEMORY.md itself is edited, never deleted).",
    parameters: z.object({ name: z.string().trim().min(1).max(64) }).strict(),
    execute: async (input, context) => {
      const id = trunkFor(context);
      const name = input.name.replace(/\.md$/, "");
      if (!trunks.files.deleteMemory(id, actor(id), name)) throw new Error(`There is no memory file named "${input.name}".`);
      return { deleted: name };
    },
  });
}
