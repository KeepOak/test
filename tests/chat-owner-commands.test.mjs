import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { commandShown, ownerCommandsHere } from "../dist/channels/owner-commands.js";
import { discardTemp } from "./temp-dir.mjs";

let serial = 0;
const message = (text, extra = {}) => ({ channel: "chat", chatId: "dm", chatKind: "direct", senderId: "owner",
  senderName: "Owner", addressed: true, messageId: `m${++serial}`, text, ...extra });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-owner-commands-"));
  const input = options.input ?? { executable: "node", args: ["-p", "1+1"] };
  const provider = { name: "scripted", async complete(request) {
    return request.messages.at(-1)?.role === "tool" ? { content: "Done.", toolCalls: [] }
      : { content: "", toolCalls: [{ id: `c${++serial}`, name: "shell.execute", arguments: JSON.stringify(input) }] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  let executed = 0;
  app.registry.register({ name: "shell.execute", permission: "shell.execute", parameters: z.object({ executable: z.string(),
    args: z.array(z.string()) }).strict(), description: "Stand-in command; no processes are started", group: "core",
    execute: async () => ({ executed: ++executed }) });
  const sent = [];
  const adapter = { id: "chat", kind: options.kind ?? "telegram", botName: () => "Branch", async start() {}, async stop() {},
    ...(options.maxTextLength ? { maxTextLength: options.maxTextLength } : {}),
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); },
    async sendButtons(chatId, text, buttons, reply, format) { sent.push({ chatId, text, buttons, format }); return String(sent.length); } };
  app.channels.mergeWindowMs = 0;
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner", "other"] });
  if (options.paired !== false) app.store.save("settings", app.runtime.owner, "channel-pair:chat:owner",
    { status: "approved", code: "123456", name: "Owner", requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  app.channels.setOwnerCommandSettings({ on: options.on !== false, accounts: [{ channel: "chat", sender: "owner" }] });
  return { app, sent, root, executed: () => executed };
}
const lastRun = (app) => app.store.runs(app.runtime.owner)[0];
const waiting = (app) => app.runtime.waitingApprovals(lastRun(app).sessionId)[0];

test("the paired owner's DM shows exact bytes before its fingerprint Yes; source remains channel", async (t) => {
  const { app, sent, executed } = await fixture(t);
  await app.channels.handle(message("run the calculation"));
  const question = waiting(app);
  assert.equal(executed(), 0);
  assert.ok(question?.fingerprint, JSON.stringify(app.store.events(lastRun(app).id).filter((one) => ["tool.failed", "run.failed", "tool.refused", "run.started"].includes(one.kind))));
  const prompt = sent.find((one) => one.buttons?.some((button) => button.value.startsWith("y:")));
  assert.match(prompt.text, /node -p 1\+1/);
  assert.equal(prompt.format.spans[0].kind, "block");
  assert.equal(prompt.buttons.length, 2);
  const run = lastRun(app);
  assert.equal(app.store.events(run.id).find((event) => event.kind === "run.started").data.source, "channel");
  const answer = prompt.buttons.find((button) => button.value.startsWith("y:")).value;
  assert.ok(answer.length <= 64, "Telegram callback fits its byte limit");
  await app.channels.handle(message(answer));
  assert.equal(executed(), 1, "button approval continues the task without another owner message");
  assert.equal(app.runtime.waitingApprovals(run.sessionId).length, 0);
  await app.channels.handle(message("run it again"));
  assert.equal(executed(), 1, "the previous approval is consumed and cannot run the same command again");
  assert.ok(waiting(app)?.fingerprint, "even identical commands ask afresh");
  await app.channels.handle(message(answer));
  assert.equal(executed(), 1, "an old button cannot approve a new occurrence of identical command bytes");
  assert.ok(waiting(app)?.fingerprint);
});

for (const [label, options, extra] of [
  ["off", { on: false }, {}], ["unpaired", { paired: false }, {}], ["spoofable transport", { kind: "email" }, {}],
  ["other sender", {}, { senderId: "other" }], ["group", {}, { chatKind: "group" }], ["catch-up", {}, { caughtUp: true }],
]) test(`commands never granted to ${label}`, async (t) => {
  const { app, executed } = await fixture(t, options);
  await app.channels.handle(message("run the calculation", extra));
  assert.equal(executed(), 0);
  assert.equal(app.runtime.waitingApprovals(lastRun(app).sessionId).length, 0);
  const permissions = app.store.events(lastRun(app).id).find((event) => event.kind === "run.started").data.permissions;
  assert.ok(!permissions.includes("shell.execute"));
});

for (const [label, change, answer] of [
  ["plain yes", () => {}, "y"], ["other sender", () => {}, null],
  ["App lock", (app) => app.sessionLock.lock(), null],
  ["Lockdown", (app) => app.store.save("settings", app.runtime.owner, "lockdown", { on: true }), null],
  ["unpaired after prompt", (app) => app.channels.remove(app.runtime.owner, { channel: "chat", senderId: "owner" }), null],
  ["switched off after prompt", (app) => app.channels.setOwnerCommandSettings({ on: false, accounts: [] }), null],
]) test(`the exact command Yes refuses ${label}`, async (t) => {
  const { app, sent, executed } = await fixture(t);
  await app.channels.handle(message("run"));
  const question = waiting(app);
  change(app);
  const from = message("", label === "other sender" ? { senderId: "other" } : {});
  const button = sent.find((one) => one.buttons?.some((button) => button.value.startsWith("y:"))).buttons.find((button) => button.value.startsWith("y:")).value;
  const response = await app.channels.answerApproval("chat", "dm", answer ?? button, from);
  assert.equal(response.decision, "in-window");
  assert.equal(executed(), 0);
  assert.equal(app.runtime.waitingApprovals(lastRun(app).sessionId).length, 1);
});

test("redacted command cannot acquire a Yes by supplying its fingerprint manually", async (t) => {
  const { app, sent } = await fixture(t);
  app.channels.outboundGuard = async (text) => ({ text: text.replace("1+1", "[hidden]"), blocked: false });
  await app.channels.handle(message("run"));
  const question = waiting(app);
  assert.ok(!sent.some((one) => one.buttons?.some((button) => button.value.startsWith("y:"))));
  assert.equal((await app.channels.answerApproval("chat", "dm", `y:${question.fingerprint}`, message(""))).decision, "in-window");
});
test("command arguments pass the secret scrub before anything is sent", async (t) => {
  const { app, sent } = await fixture(t);
  app.channels.hideLeaks = (text) => text.replaceAll("1+1", "[hidden]");
  await app.channels.handle(message("run"));
  assert.ok(sent.every((one) => !one.text.includes("1+1")));
  assert.ok(!sent.some((one) => one.buttons?.some((button) => button.value.startsWith("y:"))));
});
test("bytes the runtime scrubbed before asking cannot acquire a Yes, even with a manual fingerprint", async (t) => {
  const { app, sent, executed } = await fixture(t);
  // The runtime hides key-shaped values and private details in a question's bytes; what runs is still the original.
  const deepHide = (value) => typeof value === "string" ? value.replaceAll("1+1", "[hidden]") : value;
  app.runtime.hideSecrets = deepHide;
  await app.channels.handle(message("run"));
  const question = waiting(app);
  assert.match(question.bytes, /\[hidden\]/);
  assert.ok(!sent.some((one) => one.buttons?.some((button) => button.value.startsWith("y:"))), "no Yes for bytes that differ from what runs");
  assert.equal((await app.channels.answerApproval("chat", "dm", `y:${question.fingerprint}`, message(""))).decision, "in-window");
  assert.equal(executed(), 0);
});
test("a truncated command cannot acquire a Yes", async (t) => {
  const { app, sent } = await fixture(t, { maxTextLength: 50 });
  await app.channels.handle(message("run"));
  const question = waiting(app);
  assert.ok(!sent.some((one) => one.buttons?.some((button) => button.value.startsWith("y:"))));
  assert.equal((await app.channels.answerApproval("chat", "dm", `y:${question.fingerprint}`, message(""))).decision, "in-window");
});

test("continued tasks recheck command grants at execution; the owner's window remains unchanged", async (t) => {
  const { app, executed } = await fixture(t);
  await app.channels.handle(message("run"));
  const original = lastRun(app), continuation = app.store.createRun(app.runtime.owner, "continued");
  app.store.event(continuation.id, "run.started", { source: "owner", resumedFrom: original.id });
  app.channels.setOwnerCommandSettings({ on: false, accounts: [] });
  const context = app.runtime.context({ runId: continuation.id, permissions: ["shell.execute"] });
  await assert.rejects(app.registry.execute("shell.execute", { executable: "node", args: [] }, context), /no longer allowed/);
  assert.equal(executed(), 0);
  const own = app.store.createRun(app.runtime.owner, "owner");
  app.store.event(own.id, "run.started", { source: "owner" });
  await app.registry.execute("shell.execute", { executable: "node", args: [] }, app.runtime.context({ runId: own.id, permissions: ["shell.execute"] }));
  assert.equal(executed(), 1);
});

test("settings endpoint requires the current PIN even in an unlocked window", async (t) => {
  const { app, root } = await fixture(t);
  app.sessionLock.setPin({ pin: "1234" });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  t.after(() => server.close());
  const call = (body) => fetch(`${server.url}/api/channels/owner-commands`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url }, body: JSON.stringify(body) });
  const change = { on: false, accounts: [] };
  assert.equal((await call(change)).status, 400);
  assert.equal((await call({ ...change, pin: "9999" })).status, 403);
  assert.equal((await call({ ...change, pin: "1234" })).status, 200);
  assert.equal(app.channels.summary().ownerCommands.on, false);
});

test("command display rejects invisible/oversize input and names execution options", () => {
  assert.equal(commandShown(JSON.stringify({ executable: "node", args: ["\u202eread"] })), null);
  assert.equal(commandShown(JSON.stringify({ executable: "node", args: ["a".repeat(1600)] })), null);
  assert.match(commandShown(JSON.stringify({ executable: "node", cwd: "project", secrets: ["TOKEN"], timeoutMs: 1000, netless: false })), /TOKEN[\s\S]*1000 ms[\s\S]*no/);
  assert.equal(ownerCommandsHere({ on: true, accounts: [{ channel: "tg", sender: "1" }] },
    { kind: "telegram", channel: "tg", senderId: "1", chatKind: "direct" }, true), false);
});
