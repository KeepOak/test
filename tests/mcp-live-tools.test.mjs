/**
 * UP-RESEARCH-007: a server that says its tools changed is listened to. After the change, a call is checked against the
 * tool as the server now describes it, not as it was first listed; and the server is told only the one workspace folder.
 * The server is a stand-in written here and started on this computer; nothing leaves it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { openMcp } from "../dist/integrations/mcp.js";

const server = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let strict = false, asked;
const tools = () => [
  { name: "echo", description: "echo", inputSchema: strict
    ? { type: "object", properties: { text: { type: "string" } }, required: ["text"] } : { type: "object", properties: {} } },
  { name: "flip", description: "flip", inputSchema: { type: "object", properties: {} } },
  { name: "roots", description: "roots", inputSchema: { type: "object", properties: {} } },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === "roots-1") { asked(JSON.stringify(m.result?.roots ?? m.error)); return; }
  if (m.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const text = (t) => reply({ content: [{ type: "text", text: t }] });
  if (m.method === "initialize") return reply({ protocolVersion: m.params.protocolVersion,
    capabilities: { tools: { listChanged: true } }, serverInfo: { name: "live", version: "1.0.0" } });
  if (m.method === "tools/list") return reply({ tools: tools() });
  if (m.method !== "tools/call") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "none" } });
  const name = m.params.name;
  if (name === "flip") { strict = true; text("flipped"); return send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }
  if (name === "roots") { asked = text; return send({ jsonrpc: "2.0", id: "roots-1", method: "roots/list" }); }
  text("echoed");
});
`;

const context = () => ({ signal: new AbortController().signal });
const textOf = (result) => result.content[0].text;

test("UP-RESEARCH-007: a changed tool list is re-read, calls are checked against it, and only the workspace is shared", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-mcplive-"));
  const script = join(root, "server.mjs");
  await writeFile(script, server);
  const workspace = join(root, "workspace");
  const written = [];
  const cache = { read: () => undefined, write: (_id, tools) => written.push(tools) };
  const config = { id: "live", transport: "stdio", command: process.execPath, args: [script],
    tools: ["echo", "flip", "roots"], expectedVersion: "1.0.0" };
  const live = await openMcp(config, process.env, undefined, cache, 5000, () => workspace);
  t.after(async () => { await live.close(); await discardTemp(root); });

  assert.deepEqual(JSON.parse(textOf(await live.call("roots", {}, context()))),
    [{ uri: pathToFileURL(workspace).href, name: "workspace" }], "the server sees the workspace folder and nothing else");
  assert.equal(textOf(await live.call("echo", {}, context())), "echoed");

  assert.equal(textOf(await live.call("flip", {}, context())), "flipped");
  const strictEcho = () => written.at(-1)?.find((tool) => tool.name === "echo")?.inputSchema.required?.[0] === "text";
  const end = Date.now() + 5000;
  while (!strictEcho() && Date.now() < end) await sleep(20);
  assert.ok(strictEcho(), "the new list was read and remembered");
  await assert.rejects(live.call("echo", {}, context()), /do not match the current tool schema/,
    "a call that fits the old shape but not the new one is refused");
  assert.equal(textOf(await live.call("echo", { text: "hi" }, context())), "echoed");
});
