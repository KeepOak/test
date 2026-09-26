// A tiny MCP server over stdio (newline-delimited JSON-RPC) that is slow to start, for tests of a start that is
// overtaken while it is still under way. No package is fetched and nothing leaves this computer.
// --delay <ms>: how long it waits before answering `initialize`. --pidfile <path>: a file its process id is added to.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const delay = Number(option("delay", "0"));
const pidfile = option("pidfile", "");
if (pidfile) appendFileSync(pidfile, `${process.pid}\n`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = ["echo", "ping"].map((name) => ({ name, description: `Slow server ${name}`, inputSchema: { type: "object", properties: {} } }));

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return; // a notification needs no answer
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    const answer = () => reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "slow-server", version: "1.0.0" } });
    if (delay > 0) setTimeout(answer, delay); else answer();
    return;
  }
  if (message.method === "tools/list") return reply({ tools });
  if (message.method === "tools/call") return reply({ content: [{ type: "text", text: `called ${message.params?.name}` }] });
  if (message.method === "ping") return reply({});
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
});
// Branch closing the connection closes this program's input: it ends then, even in the middle of its delay.
lines.on("close", () => process.exit(0));
