/**
 * Commands from the owner's own Slack DM (src/channels/owner-commands.ts) on Slack's Block Kit buttons (CHAT-062): the
 * whole command is shown fenced before its Yes, and its Yes button runs it once; a command holding words Slack would
 * draw differently (< > & or a backtick: links, mentions, escapes, a broken fence) gets only No. Stand-in Slack only.
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
  return { adapter, calls, inbound };
}

test("an owner-DM command's code span is fenced inside the question's section", async () => {
  const { adapter, calls } = slack();
  const text = ["Run this?", "node -p 1+1"].join("\n");
  await adapter.sendButtons("D1", text, [{ label: "Yes", value: `y:${fingerprint}` }], undefined,
    { spans: [{ offset: 10, length: 11, kind: "block", language: "shell" }] });
  assert.equal(calls[0].body.blocks[0].text.text, ["Run this?", "```", "node -p 1+1", "```"].join("\n"));
  assert.equal(calls[0].body.blocks[1].elements[0].action_id, "branch_answer_0");
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
