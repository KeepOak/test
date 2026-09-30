import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag) + 1];
const mode = process.env.BRANCH_NATIVE_FIXTURE_MODE ?? "normal";
const settings = JSON.parse(readFileSync(value("--settings"), "utf8"));
assert.equal(settings.disableAllHooks, true, "native hooks must be explicitly disabled");
const generation = JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY);
const frames = [], emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
if (mode === "grandchild") {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  writeFileSync(process.env.BRANCH_NATIVE_FIXTURE_PIDS, JSON.stringify({ parent: process.pid, child: child.pid }));
}
if (mode === "inert") {
  const server = JSON.parse(value("--mcp-config")).mcpServers.branch;
  const child = spawn(server.command, server.args, { windowsHide: true, env: { ...process.env, ...server.env } });
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: generation.tools[0]?.name, arguments: { path: "native-should-never-write.txt" } } }) + "\n");
  let answer = ""; for await (const part of child.stdout) answer += part;
  writeFileSync(process.env.BRANCH_NATIVE_FIXTURE_INERT, answer);
}
const lines = createInterface({ input: process.stdin });
let work = Promise.resolve(), ending = false;
lines.on("line", (line) => { work = work.then(async () => {
  if (ending) return; // "exit-soon": ended after its one result, though its input was still open
  const frame = JSON.parse(line); frames.push(frame);
  if (frame.shouldQuery === false) { emit({ type: "result", num_turns: mode === "bad-ack" ? 1 : 0, is_error: false }); return; }
  if (frame.type !== "user") return;
  if (mode === "signed-out") {
    emit({ type: "assistant", error: "authentication_failed" });
    emit({ type: "result", num_turns: 1, subtype: "error_during_execution", is_error: true }); process.exitCode = 1; return;
  }
  const payload = { model: value("--model"), stream: true, ...generation,
    system: [{ type: "text", text: readFileSync(value("--system-prompt-file"), "utf8") }], messages: frames.map((item) => item.message) };
  // A native request that lost this turn's transport marker (another turn's request) is sent as plain words.
  if (mode === "no-marker") payload.messages = payload.messages.map((message) => ({ ...message,
    content: [{ type: "text", text: JSON.stringify(message.content).replace(/BRANCH_TRANSPORT_TURN_[0-9a-f]+/g, "") }] }));
  const url = process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true";
  const request = () => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-native-account", "anthropic-version": "2023-06-01",
    ...(process.env.BRANCH_NATIVE_FIXTURE_RELAY ? { "x-branch-fixture-relay": process.env.BRANCH_NATIVE_FIXTURE_RELAY } : {}) }, body: JSON.stringify(payload) });
  const response = await request(); await response.arrayBuffer();
  if (mode === "grandchild") await new Promise(() => {});
  if (mode === "retry") { const denied = await request(); await denied.arrayBuffer(); }
  if (process.env.BRANCH_NATIVE_FIXTURE_RATES) {
    for (const line of JSON.parse(readFileSync(process.env.BRANCH_NATIVE_FIXTURE_RATES, "utf8"))) emit(JSON.parse(line));
  } else emit({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 0.25, resetsAt: 2000000000 } });
  emit({ type: "result", num_turns: 1, subtype: mode === "retry" ? "error_during_execution" : "success", is_error: mode === "retry" });
  process.exitCode = mode === "retry" ? 1 : 0;
  // An older Claude Code ends after its one result instead of waiting for the next turn.
  if (mode === "once") { lines.close(); process.stdin.destroy(); }
  if (mode === "exit-soon") { ending = true; setTimeout(() => process.exit(0), 300); }
}).catch(() => { emit({ type: "result", num_turns: 1, subtype: "error_during_execution", is_error: true }); process.exitCode = 1; }); });
