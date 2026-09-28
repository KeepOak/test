/**
 * A short chat answer through an installed program (the owner's Telegram DM took 39 s to say "Hi"). Nearly all of it
 * was Claude Code starting: the owner's hooks, MCP servers, plugins and tools, loaded for a call that may use none of
 * them, and seconds of waiting for the program to exit after its answer. These check each cut on stand-ins: a chat's
 * call runs lean and with no tools of its own, the question goes in as stream-json so a copy started ahead of time can
 * take it, the answer is taken from the result line, words stream as written, and the engine's own part of a trivial
 * chat turn stays inside a budget. No real program or model is run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, registerCliAgent } from "../dist/index.js";
import { closeSpareAgents, leanClaudeArgs, runCliAgent, streamJsonQuestion, streamJsonWords } from "../dist/providers/cli-agent.js";

async function until(check, label, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(5); } // poll tick only
  assert.fail(`Timed out: ${label}`);
}
async function engine(t, spawn) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-latency-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" });
  return { app, root };
}
const answered = (text) => ({ code: 0, stderr: "",
  stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text })}\n` });

test("a chat's call to Claude Code runs lean and with no tools of its own; the owner's own call keeps its arguments", async (t) => {
  const calls = [];
  const { app } = await engine(t, async (row, prompt) => { calls.push(row.args); return answered("Hi!"); });
  const chat = { id: "telegram", kind: "telegram", botName: () => "TK", async start() {}, async stop() {}, async send() { return "1"; } };
  app.channels.mergeWindowMs = 0;
  await app.channels.attach(chat, { activation: "always", pairing: true, allowlist: ["owner"] });
  assert.equal(await app.channels.handle({ channel: "telegram", chatId: "c", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text: "Hi", addressed: true, messageId: "1" }), "replied");
  const chatArgs = calls.at(-1);
  for (const flag of leanClaudeArgs) assert.ok(chatArgs.includes(flag), `${flag} is passed for a chat's call`);
  assert.deepEqual(chatArgs.slice(-2), ["--tools", ""], "a chat app's task gets none of Claude Code's own tools");
  const own = await app.runtime.run({ prompt: "hello" });
  assert.equal(own.output, "Hi!");
  assert.ok(!calls.at(-1).includes("--tools") && !calls.at(-1).includes("--strict-mcp-config"), "the owner's own call is unchanged");
});

test("streamed words reach the reply as written, and the answer is still the result", async (t) => {
  const deltas = [];
  const lines = [
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi! " } }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "helper" } }, parent_tool_use_id: "toolu_1" },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "How can I help?" } }, parent_tool_use_id: null },
  ].map((line) => JSON.stringify(line));
  const thought = [];
  for (const line of [...lines, "not json", JSON.stringify({ type: "assistant" })]) streamJsonWords(line, (text) => deltas.push(text), (text) => thought.push(text));
  assert.deepEqual(deltas, ["Hi! ", "How can I help?"], "a helper's words are not the answer");
  assert.deepEqual(thought, ["hmm"]);
  const { app } = await engine(t, async (row, prompt, signal, limits, home, onLine) => {
    for (const line of lines) onLine?.(line);
    return answered("Hi! How can I help?");
  });
  const seen = [];
  const run = await app.runtime.run({ prompt: "hi", source: "channel", permissions: ["files.read"], onTextDelta: (text) => seen.push(text) });
  assert.equal(run.output, "Hi! How can I help?");
  assert.deepEqual(seen, ["Hi! ", "How can I help?"], "the words arrived as written, and not a second time at the end");
});

/** A stand-in for the program: reads one stream-json question, prints its result line, then lingers before exiting. */
async function standInProgram(root) {
  const file = join(root, "program.mjs");
  await writeFile(file, `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(join(root, "booted-"))} + process.pid, ""); // this copy is up and waiting
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const question = JSON.parse(input.trim());
      const words = question.message.content[0].text;
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "echo " + words, pid: process.pid }) + "\\n");
      setTimeout(() => process.exit(0), 20000); // a program that takes its time to exit after answering
    });
  `);
  return { id: "claude-code", name: "stand-in", command: process.execPath,
    args: [file, "--output-format", "stream-json", "--input-format", "stream-json"], jsonField: "result", note: "" };
}
const limits = { timeoutMs: 30_000, maxOutputChars: 100_000 };

test("the answer is taken from the result line, and the next question finds a copy already started", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-cli-spare-"));
  t.after(async () => { closeSpareAgents(); await discardTemp(root); });
  const row = await standInProgram(root);
  const signal = new AbortController().signal;
  const began = Date.now();
  const first = await runCliAgent(row, "user: hello", signal, limits);
  assert.equal(first.code, 0);
  assert.ok(Date.now() - began < 15_000, "not held until the program exits 20 s later");
  const one = JSON.parse(first.stdout.trim());
  assert.equal(one.result, "echo user: hello", "the question went in as one stream-json message");
  // A copy other than the one that answered starts by itself and waits for the next question.
  const waiting = await until(async () => (await readdir(root)).map((name) => /^booted-(\d+)$/.exec(name)?.[1])
    .find((pid) => pid && Number(pid) !== one.pid), "a copy started ahead of the next question");
  const second = JSON.parse((await runCliAgent(row, "user: again", signal, limits)).stdout.trim());
  assert.equal(second.result, "echo user: again");
  assert.equal(second.pid, Number(waiting), "the second question went to the copy already waiting");
  assert.equal(streamJsonQuestion("x"), `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] } })}\n`);
});

test("latency budget: the engine's own part of a trivial chat turn stays small", async (t) => {
  const { app } = await engine(t, async () => answered("Hi!"));
  let sentAt = 0;
  const chat = { id: "telegram", kind: "telegram", botName: () => "TK", async start() {}, async stop() {},
    async send() { sentAt = performance.now(); return "1"; } };
  app.channels.mergeWindowMs = 0;
  await app.channels.attach(chat, { activation: "always", pairing: true, allowlist: ["owner"] });
  const turn = async (id) => {
    const began = performance.now();
    assert.equal(await app.channels.handle({ channel: "telegram", chatId: "c", chatKind: "direct", senderId: "owner", senderName: "Sam",
      text: "Hi", addressed: true, messageId: id }), "replied");
    return sentAt - began;
  };
  await turn("warm-up"); // the first turn of a new engine loads its modules
  const times = [await turn("a"), await turn("b"), await turn("c")].sort((x, y) => x - y);
  // Measured 50–60 ms per turn on the owner's PC with every core busy; the budget leaves a slow CI runner ample room.
  assert.ok(times[1] < 1500, `receive, route, prompt, catalog and send took ${Math.round(times[1])} ms (median)`);
});
