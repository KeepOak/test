import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** Inventory only: this process has no Branch runtime, tools, credentials or executable callbacks. */
const tools: unknown = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const lines = createInterface({ input: process.stdin });
lines.on("line", (line: string) => {
  if (Buffer.byteLength(line) > 8 * 1024 * 1024) { process.exitCode = 1; lines.close(); return; }
  let row: { id?: unknown; method?: string };
  try { row = JSON.parse(line); } catch { return; }
  if (row.id === undefined) return;
  const result = row.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "branch-inert-inventory", version: "1" } }
    : row.method === "tools/list" ? { tools }
    : row.method === "tools/call" ? { isError: true, content: [{ type: "text", text: "Denied: only Branch executes these tools through its approval flow." }] }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\n");
});
