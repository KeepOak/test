/**
 * Slack approval buttons (Block Kit): a question goes out with Yes / No buttons whose values are the router's exact
 * answers, and a press that arrives on the app's own Socket Mode connection comes back as that answer from the person
 * who pressed, once. Through the router, a Slack DM answers a waiting question by button, and a command from the
 * owner's own Slack DM is shown whole before its Yes, except words Slack would draw differently. Stand-in Slack only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, SlackAdapter } from "../dist/index.js";

const fingerprint = "b".repeat(32);
function slack() {
  const calls = [], inbound = [];
  const adapter = new SlackAdapter({ id: "slack", token: "stand-in-bot", appToken: "stand-in-app", apiBase: "http://slack.test/api",
    fetch: async (url, init) => { calls.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, ts: "111.222" })); } });
  const receive = (payload, envelope = "e1") => adapter.receive(JSON.stringify({ type: "interactive", envelope_id: envelope, payload }),
    async (message) => { inbound.push(message); });
  return { adapter, calls, inbound, receive };
}
const press = (extra = {}) => ({ type: "block_actions", trigger_id: "t1", user: { id: "U1", username: "owner" },
  channel: { id: "D1", name: "directmessage" }, container: { message_ts: "111.222" },
  actions: [{ action_id: "branch-answer-0", value: `y:${fingerprint}` }], ...extra });

test("a question goes out as a section and Yes / No buttons carrying the exact answers", async () => {
  const { adapter, calls } = slack();
  assert.equal(await adapter.sendButtons("D1", "Read notes.md?", [{ label: "Yes", value: `y:${fingerprint}` }, { label: "No", value: `n:${fingerprint}` }], "100.1"), "111.222");
  const body = calls[0].body;
  assert.equal(calls[0].method, "chat.postMessage");
  assert.equal(body.thread_ts, "100.1");
  assert.equal(body.blocks[0].text.text, "Read notes.md?");
  assert.deepEqual(body.blocks[1].elements.map((one) => [one.action_id, one.value, one.style]),
    [["branch-answer-0", `y:${fingerprint}`, "primary"], ["branch-answer-1", `n:${fingerprint}`, "danger"]]);
});

test("a press comes back once, from the person who pressed, direct in an IM and a group elsewhere", async () => {
  const { inbound, receive } = slack();
  receive(press());
  receive(press(), "e2");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(inbound.length, 1, "the same press twice is taken once");
  assert.deepEqual([inbound[0].senderId, inbound[0].chatKind, inbound[0].chatId, inbound[0].text, inbound[0].messageId],
    ["U1", "direct", "D1", `y:${fingerprint}`, "111.222"]);
  receive(press({ trigger_id: "t2", channel: { id: "C9" }, container: { message_ts: "5.5", thread_ts: "4.4" } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([inbound[1].chatKind, inbound[1].messageId], ["group", "4.4"], "in a channel it answers in the thread");
});

test("anything but Branch's own answer buttons starts nothing", async () => {
  const { inbound, receive } = slack();
  receive(press({ trigger_id: "a", actions: [{ action_id: "someone-else", value: `y:${fingerprint}` }] }));
  receive(press({ trigger_id: "b", actions: [{ action_id: "branch-answer-0", value: "run everything" }] }));
  receive(press({ trigger_id: "c", type: "view_submission" }));
  receive(press({ trigger_id: "d", actions: [] }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(inbound, []);
});

// ---- through the router -------------------------------------------------------------------------------------------

let serial = 0;
async function world(t, input) {
  const root = await mkdtemp(join(tmpdir(), "branch-slack-buttons-"));
  const provider = { name: "scripted", async complete(request) {
    return request.messages.at(-1)?.role === "tool" ? { content: "Done.", toolCalls: [] }
      : { content: "", toolCalls: [{ id: `c${++serial}`, name: "shell.execute", arguments: JSON.stringify(input) }] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  let executed = 0;
  app.registry.register({ name: "shell.execute", permission: "shell.execute", parameters: z.object({ executable: z.string(), args: z.array(z.string()) }).strict(),
    description: "Stand-in command; no processes are started", group: "core", execute: async () => ({ executed: ++executed }) });
  const { adapter, calls } = slack();
  app.channels.mergeWindowMs = 0;
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["U1"] });
  app.store.save("settings", app.runtime.owner, "channel-pair:slack:U1",
    { status: "approved", code: "123456", name: "Owner", requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  app.channels.setOwnerCommandSettings({ on: true, accounts: [{ channel: "slack", sender: "U1" }] });
  const say = (text) => app.channels.handle({ channel: "slack", chatId: "D1", chatKind: "direct", senderId: "U1", senderName: "owner",
    addressed: true, messageId: `m${++serial}`, text });
  return { app, calls, say, executed: () => executed };
}
const buttonsOf = (calls) => calls.filter((call) => call.body.blocks?.[1]?.type === "actions");

test("the owner's own Slack DM: the whole command in a fence, then its Yes button runs it once", async (t) => {
  const { calls, say, executed } = await world(t, { executable: "node", args: ["-p", "1+1"] });
  await say("run the sum");
  const [question] = buttonsOf(calls);
  assert.match(question.body.blocks[0].text.text, /```\nnode -p 1\+1\n```/);
  const yes = question.body.blocks[1].elements.find((one) => one.value.startsWith("y:")).value;
  await say(yes);
  assert.equal(executed(), 1);
});

test("a command Slack would draw differently (< > & or a backtick) gets only No, and its Yes belongs in the window", async (t) => {
  const { calls, say, executed } = await world(t, { executable: "node", args: ["-p", "'<!channel>'"] });
  await say("run it");
  const [question] = buttonsOf(calls);
  assert.deepEqual(question.body.blocks[1].elements.map((one) => one.value[0]), ["n"]);
  assert.equal(executed(), 0);
});
