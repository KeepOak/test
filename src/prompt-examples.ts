import { fileURLToPath } from "node:url";
import type { Store } from "./store.js";
import { listPrompts, savePrompt, commandProblem, type PromptInput } from "./prompt-library.js";
import { exampleServerVersion, exampleTools } from "./examples/mcp-notes-info.js";

/**
 * Bucket 12 (family "examples"): starter prompts that ship with Branch. Nothing is added until the
 * owner presses "Add the examples"; after that they are ordinary saved prompts to change or remove.
 * One of them works with the small tool server in src/examples/mcp-notes-server.ts, so the whole
 * path — a connected AI tool server, a saved command, a task that uses the server's tools — can be
 * tried on a fresh install without writing anything first.
 */
export const exampleGroup = "Examples";
export const exampleServerId = "example-notes";

export const EXAMPLES: readonly (PromptInput & { command: string })[] = [
  {
    title: "Try a tool server", group: exampleGroup, command: "notes-example",
    description: "Uses the example tool server that ships with Branch; connect it first (see the snippet on this card).",
    body: "Using only the tools from the connected example notes server (example-notes), keep this note: {{input}}\n"
      + "Then list every note it keeps and tell me which tools you used and what each one answered.",
  },
  {
    title: "Summarise a page", group: exampleGroup, command: "summarise",
    description: "Five points that matter from one web page.",
    body: "Read {{address}} and give me the five points that matter most, one line each, then one line on what I should do about it.",
  },
  {
    title: "Weekly review", group: exampleGroup, command: "weekly",
    description: "What finished this week and what is still waiting.",
    body: "Look at the tasks that finished since last {{day}} and the ones still waiting for me. "
      + "Give me three short lists: done, waiting for my yes, and worth doing next. Today is {{today}}.",
  },
  {
    title: "Explain it to a colleague", group: exampleGroup, command: "explain",
    description: "A plain explanation for someone who was not in the room.",
    body: "Explain the following to a colleague who knows the field but was not part of this work. "
      + "Keep it under 200 words, no jargon they would not use themselves:\n\n{{input}}",
  },
];

/**
 * The lines to add under "mcp" in the integrations file (docs/configuration.md, MCP tools) to
 * connect the example server: this Node, this copy's example file, and exactly its two tools.
 */
export function exampleMcpConfig(nodePath = process.execPath) {
  return {
    id: exampleServerId, transport: "stdio" as const, command: nodePath,
    args: [fileURLToPath(new URL("./examples/mcp-notes-server.js", import.meta.url))],
    envKeys: [] as string[], tools: [...exampleTools], expectedVersion: exampleServerVersion,
  };
}

/** Adds the examples that are not here yet (by title); a command already in use is left off the example. */
export function addExamples(store: Pick<Store, "get" | "save">, owner: string, taken: (name: string) => boolean) {
  const added: string[] = [];
  for (const example of EXAMPLES) {
    const current = listPrompts(store, owner);
    if (current.some((prompt) => prompt.title === example.title)) continue;
    const command = commandProblem(example.command, current, undefined, taken) ? "" : example.command;
    savePrompt(store, owner, { ...example, command }, taken);
    added.push(example.title);
  }
  return { added, mcp: { mcp: [exampleMcpConfig()] } };
}
