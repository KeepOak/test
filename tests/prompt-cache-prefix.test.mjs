/**
 * selfdev: a long task is cheap only when each round begins with exactly the bytes the round before it sent, so a
 * provider's prompt cache can serve the history. Branch's own rounds are append-only (tools, standing instructions
 * and every earlier message unchanged), and the Claude subscription relay marks the history that stays the same.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { cacheHistory } from "../dist/providers/claude-subscription-admission.js";
import { anthropicBody } from "../dist/providers.js";
import { discardTemp } from "./temp-dir.mjs";

test("every round of one task starts with the previous round's exact tools, instructions and messages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-cache-prefix-"));
  const requests = [];
  const step = (round) => round === 1
    ? { name: "checklist.write", arguments: { steps: [{ text: "Look around" }, { text: "Read the notes" }] } }
    : round % 2 ? { name: "files.list", arguments: { path: "." } } : { name: "files.read", arguments: { path: "notes.md" } };
  const provider = { name: "scripted", async complete(request) {
    requests.push(JSON.parse(JSON.stringify({ tools: request.tools, messages: request.messages, maxTokens: request.maxTokens })));
    const round = requests.length;
    if (round > 6) return { content: "Done.", toolCalls: [] };
    const { name, arguments: args } = step(round);
    return { content: "", toolCalls: [{ id: `c${round}`, name, arguments: JSON.stringify(args) }] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.coding.setMode("checklist", "on"); // a note that changes every round, the hardest case for a stable front
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "notes.md"), "# Notes\nkeep going\n");
  const run = await app.runtime.run({ prompt: "Look at the workspace and the notes a few times, then say done.",
    permissions: ["files.list", "files.read", "memory.read", "memory.write"] });
  assert.equal(run.status, "completed", run.output);
  assert.ok(requests.length >= 6, `rounds: ${requests.length}`);
  const note = (message) => message?.from === "branch" && /checklist/.test(message.content);
  assert.ok(requests.slice(1).every((request) => note(request.messages.at(-1))), "the checklist rides at the end of each round");
  for (let at = 1; at < requests.length; at++) {
    const before = requests[at - 1], now = requests[at];
    const lead = now.messages.findIndex((message) => message.role !== "system");
    assert.equal(now.messages.slice(lead).some((message) => message.role === "system"), false, "no instruction partway through");
    assert.deepEqual(now.tools, before.tools, `round ${at + 1} sends the same tools`);
    const kept = note(before.messages.at(-1)) ? before.messages.slice(0, -1) : before.messages;
    assert.deepEqual(now.messages.slice(0, kept.length), kept, `round ${at + 1} starts with round ${at}'s messages, byte for byte`);
    // On the wire to Claude: the tools, the instructions and the history up to the last answer are marked, and the
    // next round's body starts with every byte up to the round before's history mark.
    const wire = (request) => JSON.stringify(anthropicBody({ ...request, maxTokens: 1024 }, "claude"));
    const mark = '"cache_control":{"type":"ephemeral"}';
    const previous = wire(before), next = wire(now);
    const history = previous.lastIndexOf(mark);
    if (at > 1) {
      assert.equal((previous.match(/"cache_control"/g) ?? []).length, 3, "tools, instructions and history");
      const unmarked = (text) => text.replaceAll(mark, "").replaceAll(",}", "}");
      assert.equal(unmarked(next).startsWith(unmarked(previous.slice(0, history - 1))), true, `round ${at + 1}'s wire body keeps round ${at}'s cached front`);
    }
  }
});

test("the relay marks the history just before the newest user turn, and leaves anything else as it was", () => {
  const body = { model: "claude", system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [
    { role: "user", content: [{ type: "text", text: "do it" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok\n\n<system-reminder>moves every round</system-reminder>" }] },
    { role: "system", content: [{ type: "text", text: "date", cache_control: { type: "ephemeral", ttl: "1h" } }] },
  ] };
  const marked = JSON.parse(cacheHistory(Buffer.from(JSON.stringify(body))).toString("utf8"));
  assert.deepEqual(marked.messages[1].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual({ ...marked, messages: marked.messages.map((m, i) => i === 1 ? body.messages[1] : m) }, body, "nothing else changes");
  const four = { ...body, system: [...body.system, ...[1, 2].map(() => ({ type: "text", text: "x", cache_control: { type: "ephemeral" } }))] };
  const full = Buffer.from(JSON.stringify(four));
  assert.equal(cacheHistory(full), full, "never a fifth marker");
  const plain = Buffer.from("not json");
  assert.equal(cacheHistory(plain), plain);
  const first = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(cacheHistory(first), first, "a first round has no history to mark");
  const thinking = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] }, { role: "user", content: "again" }] }));
  assert.equal(cacheHistory(thinking), thinking, "never a mark on thinking, which Claude refuses");
  const empty = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "" }, { role: "user", content: "again" }] }));
  assert.equal(cacheHistory(empty), empty, "nor on empty text");
});
