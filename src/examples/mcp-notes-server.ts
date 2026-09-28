/**
 * Bucket 12 (family "examples", A1282): a small AI tool server (MCP) that ships with Branch, so the
 * owner can see a tool server work end to end before writing or connecting their own.
 *
 * It keeps a short list of notes in memory while it runs and forgets them when it stops. It reads
 * no files, opens no network connection and needs no key. Connect it with the snippet from
 * `exampleMcpConfig()` (src/prompt-examples.ts), then use the saved prompt "Try a tool server".
 *
 * Run by hand: `node dist/examples/mcp-notes-server.js` (it speaks MCP on standard input and output).
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { exampleServerName, exampleServerVersion } from "./mcp-notes-info.js";
export { exampleServerName, exampleServerVersion, exampleTools } from "./mcp-notes-info.js";
const maxNotes = 50, maxLength = 500;

const tools = [
  {
    name: "add_note", description: "Keeps one short note until the example server stops.",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength } }, required: ["text"], additionalProperties: false },
  },
  {
    name: "list_notes", description: "Lists the notes kept so far, oldest first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** What one call does; kept apart from the transport so it can be read on its own. */
export function answerCall(notes: string[], name: string, args: Record<string, unknown> | undefined) {
  const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError } : {}) });
  if (name === "list_notes") return reply(JSON.stringify({ notes }));
  if (name !== "add_note") return reply(`No tool called ${name}.`, true);
  const text = typeof args?.text === "string" ? args.text.trim() : "";
  if (!text || text.length > maxLength) return reply(`A note is 1 to ${maxLength} characters.`, true);
  if (notes.length >= maxNotes) return reply(`The example keeps at most ${maxNotes} notes.`, true);
  notes.push(text);
  return reply(JSON.stringify({ kept: text, count: notes.length }));
}

export async function startExampleServer(): Promise<void> {
  const notes: string[] = [];
  const server = new Server({ name: exampleServerName, version: exampleServerVersion }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    answerCall(notes, request.params.name, request.params.arguments as Record<string, unknown> | undefined));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startExampleServer();
}
