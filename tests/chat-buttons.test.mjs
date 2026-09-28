/**
 * Approval answers outside Telegram (CHAT-062, 063, 066): /approve and /deny typed on any app, Slack Block Kit buttons
 * read back from Socket Mode, and Matrix reactions as buttons. Every chat service here is a fake; nothing leaves this
 * computer, and every rule for a chat's yes (the owner's switch, the exact question shown) still decides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { typedApproval, nothingToApprove, approvalFallbackNote } from "../dist/channels/router.js";
import { SlackAdapter } from "../dist/channels/slack.js";
import { MatrixAdapter } from "../dist/channels/matrix.js";
import { recipeFor } from "../dist/channel-setup/recipes.js";

const callsTool = (name) => (turn, request) =>
  request.messages.at(-1)?.role === "tool" ? { content: "Done.", toolCalls: [] }
    : { content: "", toolCalls: [{ id: `t${turn}`, name, arguments: "{}" }] };

async function fixture(t, adapter) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-buttons-"));
  const calls = [];
  const provider = { name: "scripted", complete: async (request) => { calls.push(request); return callsTool("demo.invented")(calls.length, request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.registry.register({ name: "demo.invented", permission: "invented.power", description: "stand-in", group: "core",
    parameters: z.object({}).strict(), execute: async () => ({ ran: true }) });
  app.channels.mergeWindowMs = 0;
  // The owner lets this chat account answer yes for the stand-in tool (mac7/chat-approvals).
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: adapter.id, sender: "owner", allow: ["invented.power"], approvals: true, note: "my phone" }] });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "demo.invented", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  return { app };
}
let next = 1;
const message = (channel, text, extra = {}) => ({ channel, chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: `m${next++}`, ...extra });
const lastRun = (app) => app.store.runs(app.runtime.owner).at(-1);
/** A chat app with no buttons: it only takes words. */
const wordsOnly = (id = "plain") => { const sent = []; return { sent, adapter: { id, kind: "fake", botName: () => "bot", async start() {}, async stop() {}, async send(_c, text) { sent.push(text); return String(sent.length); } } }; };

test("/approve and /deny read as yes and no, and nothing else does", () => {
  assert.equal(typedApproval("/approve"), "y");
  assert.equal(typedApproval(" /Approve@juniper_bot "), "y");
  assert.equal(typedApproval("/yes"), "y");
  assert.equal(typedApproval("/deny"), "n");
  assert.equal(typedApproval("/no"), "n");
  assert.equal(typedApproval("/approve everything forever"), null, "a longer line is an ordinary message");
  assert.equal(typedApproval("approve"), null);
  assert.match(approvalFallbackNote, /\/approve or \/deny/);
});

test("on an app with no buttons, /approve answers the question it was shown, and /deny says no", async (t) => {
  const chat = wordsOnly();
  const { app } = await fixture(t, chat.adapter);
  assert.equal(await app.channels.handle(message("plain", "use the new thing")), "replied");
  assert.equal(lastRun(app).status, "needs_input");
  assert.match(chat.sent.at(-1), /\/approve or \/deny/, "the question says how to answer by typing");
  const runs = app.store.runs(app.runtime.owner).length;
  assert.equal(await app.channels.handle(message("plain", "/approve")), "replied");
  assert.match(chat.sent.at(-1), /Noted/);
  assert.equal(app.store.runs(app.runtime.owner).length, runs, "/approve was an answer, not a new task");
  assert.equal(await app.channels.handle(message("plain", "/deny")), "replied");
  assert.equal(chat.sent.at(-1), nothingToApprove, "with nothing waiting it says so rather than starting a task");
});

test("Slack: a question goes out with Block Kit buttons, and a press comes back as that answer from that person", async (t) => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: String(url).split("/").pop(), body });
    return Response.json({ ok: true, ts: "1700.000100", user_id: "UBOT", user: "juniper" });
  };
  const adapter = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", fetch, socketUrl: "wss://slack.invalid" });
  const got = [];
  adapter.user = { id: "UBOT", name: "juniper" };
  const ts = await adapter.sendButtons("D1", "Branch wants to use the new thing.", [{ label: "Yes", value: "y:abc123" }, { label: "No", value: "n:abc123" }], "1699.1");
  assert.equal(ts, "1700.000100");
  const posted = calls.find((call) => call.method === "chat.postMessage").body;
  assert.equal(posted.thread_ts, "1699.1");
  const actions = posted.blocks.find((block) => block.type === "actions").elements;
  assert.deepEqual(actions.map((button) => [button.action_id, button.value, button.style]), [["branch_answer_0", "y:abc123", "primary"], ["branch_answer_1", "n:abc123", "danger"]]);

  // Socket Mode hands the press over as an `interactive` envelope; it is acknowledged, read, and the buttons come off.
  const acks = [];
  adapter.socket = { send: (text) => acks.push(JSON.parse(text)), close() {} };
  const press = (actionId, value, user = "U1") => adapter.receive(JSON.stringify({ type: "interactive", envelope_id: `e-${value}`, payload: {
    type: "block_actions", user: { id: user, username: "sam" }, channel: { id: "D1" },
    message: { ts: "1700.000100", thread_ts: "1699.1", text: "Branch wants to use the new thing." },
    actions: [{ action_id: actionId, value }] } }), async (message) => { got.push(message); });
  press("branch_answer_0", "y:abc123");
  press("someone_elses_button", "y:abc123");
  press("branch_answer_1", "n:abc123", "UBOT");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(acks.map((ack) => ack.envelope_id), ["e-y:abc123", "e-y:abc123", "e-n:abc123"], "every envelope is acknowledged");
  assert.equal(got.length, 1, "another app's button, or the bot itself, is never an answer");
  assert.deepEqual({ ...got[0] }, { channel: "slack", chatId: "D1", chatKind: "direct", senderId: "U1", senderName: "sam", text: "y:abc123", addressed: true, messageId: "1699.1" });
  const update = calls.find((call) => call.method === "chat.update").body;
  assert.equal(update.ts, "1700.000100");
  assert.ok(!update.blocks.some((block) => block.type === "actions"), "the answered question has no buttons left");
  assert.match(JSON.stringify(update.blocks), /<@U1> chose Yes/);
  assert.deepEqual(recipeFor("slack").manifest.settings.interactivity, { is_enabled: true }, "the wizard's Slack app has interactivity on");
});

test("Slack buttons through the router: the press answers the waiting question", async (t) => {
  const posts = [];
  const fetch = async (url, init) => { posts.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) }); return Response.json({ ok: true, ts: `17${posts.length}.0`, user_id: "UBOT", user: "juniper" }); };
  const adapter = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", fetch, connect: async () => { let done; const closed = new Promise((resolve) => { done = resolve; }); return { send() {}, close() { done(); }, closed }; }, socketUrl: "wss://slack.invalid" });
  const { app } = await fixture(t, adapter);
  assert.equal(await app.channels.handle(message("slack", "use the new thing", { chatId: "D1" })), "replied");
  const question = posts.find((post) => post.method === "chat.postMessage" && post.body.blocks);
  assert.ok(question, "the question went out with buttons");
  const yes = question.body.blocks.find((block) => block.type === "actions").elements[0].value;
  assert.equal(await app.channels.handle(message("slack", yes, { chatId: "D1" })), "replied");
  assert.match(posts.filter((post) => post.method === "chat.postMessage").at(-1).body.text, /Noted/);
});

test("Matrix: a question carries 👍 and 👎 to tap, and a reaction by the person answers it; the bot's own does not", async () => {
  const puts = [];
  const fetch = async (url, init) => { puts.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({ event_id: `$e${puts.length}` }); };
  const adapter = new MatrixAdapter({ id: "matrix", homeserver: "https://m.example.org", userId: "@juniper:m.example.org", accessToken: "x", fetch });
  await adapter.sendButtons("!room:m", "Juniper wants to use the new thing.", [{ label: "Yes", value: "y:abc" }, { label: "No", value: "n:abc" }]);
  assert.match(puts[0].body.body, /React 👍 Yes   👎 No/);
  assert.deepEqual(puts.slice(1).map((put) => [put.url.includes("/send/m.reaction/"), put.body["m.relates_to"].key, put.body["m.relates_to"].event_id]), [[true, "👍", "$e1"], [true, "👎", "$e1"]]);
  const react = (sender, key, on = "$e1") => adapter.inbound("!room:m", { type: "m.reaction", event_id: `$r${Math.random()}`, sender, content: { "m.relates_to": { rel_type: "m.annotation", event_id: on, key } } });
  assert.equal(react("@alice:m", "👍").text, "y:abc");
  assert.equal(react("@alice:m", "👎️").text, "n:abc", "the emoji variation selector is ignored");
  assert.equal(react("@juniper:m.example.org", "👍"), null, "its own tap targets are not answers");
  assert.equal(react("@alice:m", "🎉"), null);
  assert.equal(react("@alice:m", "👍", "$other"), null, "a reaction on anything but a question is not an answer");
});
