/**
 * Slack's assistant status ("Branch is thinking…") as the live status line, as Hermes Agent and OpenClaw show it:
 * thinking, then the step in a direct chat ("is reading notes.md…"), only the kind of work in a group, cleared when
 * the task ends; scrubbed like every word that goes out, sent only when it changes, and left alone after Slack refuses
 * twice (no scope or not an assistant thread). Stand-in Slack only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { SlackAdapter } from "../dist/index.js";
import { LiveStatus } from "../dist/channels/live-status.js";

const fast = { progressAfterMs: 10_000, editEveryMs: 10, typingEveryMs: 10_000, reactEveryMs: 5 };
function live({ group = false, refuse = false, guard = async (text) => ({ text, blocked: false }) } = {}) {
  const shown = [];
  const adapter = { id: "slack", kind: "slack", async send() { return "1"; },
    async setStatus(chatId, threadId, words) { if (refuse) throw new Error("not_allowed"); shown.push([chatId, threadId, words]); } };
  const status = new LiveStatus({ adapter, chatId: "D1", messageId: "100.1", kindsOnly: group }, guard, fast);
  return { status, shown };
}

test("thinking, then the step, then thinking again, cleared at the end; the same words are not sent twice", async () => {
  const { status, shown } = live();
  status.start(); status.thinking();
  status.event("tool.started", { id: "a", name: "files.read", label: "Reading notes.md" });
  status.event("tool.completed", { id: "a", name: "files.read" });
  status.event("model.started", {});
  status.event("model.started", {});
  await status.finish("done");
  await delay(20);
  assert.deepEqual(shown.map(([, , words]) => words), ["is thinking…", "is reading notes.md…", "is thinking…", ""]);
  assert.ok(shown.every(([chat, thread]) => chat === "D1" && thread === "100.1"), "under the person's own message");
});

test("a group's status names no file; scrubbed words go out scrubbed; held words do not go out", async () => {
  const group = live({ group: true });
  group.status.start();
  group.status.event("tool.started", { id: "a", name: "files.read", label: "Reading secret-plan.md" });
  await delay(20);
  assert.ok(group.shown.every(([, , words]) => !words.includes("secret-plan")), JSON.stringify(group.shown));
  assert.equal(group.shown.at(-1)[2], "is working…");
  const scrubbed = live({ guard: async (text) => ({ text: text.replace("sk-live-123", "[hidden]"), blocked: false }) });
  scrubbed.status.start();
  scrubbed.status.event("tool.started", { id: "b", name: "web.fetch", label: "Reading sk-live-123" });
  const held = live({ guard: async (text) => ({ text, blocked: /reading/.test(text) }) });
  held.status.start();
  held.status.event("tool.started", { id: "c", name: "files.read", label: "Reading x" });
  await delay(20);
  assert.equal(scrubbed.shown.at(-1)[2], "is reading [hidden]…");
  assert.deepEqual(held.shown.map(([, , words]) => words), ["is thinking…"]);
});

test("after Slack refuses twice the status is left alone", async () => {
  let calls = 0;
  const adapter = { id: "slack", kind: "slack", async send() { return "1"; }, async setStatus() { calls++; throw new Error("missing_scope"); } };
  const status = new LiveStatus({ adapter, chatId: "D1", messageId: "1" }, async (text) => ({ text, blocked: false }), fast);
  status.start();
  for (const [index, label] of ["Reading a", "Reading b", "Reading c", "Reading d"].entries()) {
    status.event("tool.started", { id: String(index), name: "files.read", label });
    await delay(10);
  }
  await status.finish("done");
  assert.equal(calls, 2);
});

test("the Slack adapter asks assistant.threads.setStatus for the thread", async () => {
  const calls = [];
  const slack = new SlackAdapter({ id: "slack", token: "stand-in", appToken: "stand-in", apiBase: "http://slack.test/api",
    fetch: async (url, init) => { calls.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) }); return new Response('{"ok":true}'); } });
  await slack.setStatus("D1", "100.1", "is thinking…");
  assert.deepEqual(calls, [{ method: "assistant.threads.setStatus", body: { channel_id: "D1", thread_ts: "100.1", status: "is thinking…" } }]);
});
