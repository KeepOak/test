import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplyStream, ReplyDeliveryUncertain } from "../dist/channels/reply-stream.js";
import { SlackAdapter } from "../dist/channels/slack.js";
import { installChannelFormatting } from "../dist/channels/formatting-settings.js";
import { createBranch } from "../dist/index.js";
import { setLockdown } from "../dist/lockdown.js";
import { discardTemp } from "./temp-dir.mjs";

function slackPreview(response) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
  const adapter = new SlackAdapter({ id: "stand-in", token: "stand-in", appToken: "stand-in", apiBase: "http://slack.test/api",
    fetch: async (url, init) => {
      const method = String(url).split("/").pop();
      calls.push({ method, signal: init.signal });
      if (method === "chat.startStream") { entered.resolve(init.signal); await released.promise; return new Response(JSON.stringify(response)); }
      return new Response(JSON.stringify({ ok: true, ts: "100.2" }));
    } });
  installChannelFormatting(adapter, () => "plain");
  return { adapter, entered, released, calls };
}

for (const revoke of ["cancel", "authority", "task"]) test(`deferred native refusal cannot fall back after ${revoke}`, { timeout: 10000 }, async () => {
  const f = slackPreview({ ok: false, error: "unknown_method" }), task = new AbortController();
  let allowed = true;
  const stream = new ReplyStream({ adapter: f.adapter, chatId: "D1", messageId: "100.1", allowed: () => allowed,
    signal: () => task.signal }, async text => ({ text, blocked: false }), 1);
  stream.text("Preview words ");
  const signal = await f.entered.promise;
  if (revoke === "cancel") stream.cancel();
  if (revoke === "authority") allowed = false;
  if (revoke === "task") task.abort(new Error("Stopped"));
  if (revoke !== "authority") assert.ok(signal.aborted, "the actual adapter request receives cancellation");
  f.released.resolve();
  assert.equal(await stream.finishError(), false, "uncertain or revoked delivery cannot authorize a fresh answer");
  assert.deepEqual(f.calls.map(c => c.method), ["chat.startStream"], "no fallback postMessage or cancelled finalization");
});

test("a valid native refusal forwards the gate through the formatted ordinary send", { timeout: 10000 }, async () => {
  const f = slackPreview({ ok: false, error: "unknown_method" });
  const stream = new ReplyStream({ adapter: f.adapter, chatId: "D1", messageId: "100.1" }, async text => ({ text, blocked: false }), 1);
  stream.text("Preview words "); await f.entered.promise; f.released.resolve();
  const result = await stream.finish("The final answer.");
  assert.equal(result.messageId, "100.2");
  assert.deepEqual(f.calls.map(c => c.method), ["chat.startStream", "chat.postMessage", "chat.update"]);
  assert.ok(f.calls.every(c => c.signal && !c.signal.aborted), "closing preview admission does not cancel a valid final reply");
});

test("cancellation during the awaited outbound guard admits no preview", { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
  const adapter = { async send() { calls.push("send"); return "1"; }, async edit() {} };
  const stream = new ReplyStream({ adapter, chatId: "dm", messageId: "in" }, async text => {
    entered.resolve(); await released.promise; return { text, blocked: false };
  }, 1);
  stream.text("Preview words "); await entered.promise; stream.cancel(); released.resolve();
  assert.equal(await stream.finishError(), false);
  assert.deepEqual(calls, []);
});

for (const pendingMethod of ["chat.appendStream", "chat.stopStream"]) test(`cancellation reaches deferred ${pendingMethod} and holds final delivery`, { timeout: 10000 }, async () => {
  const started = Promise.withResolvers(), entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
  const adapter = new SlackAdapter({ id: "stand-in", token: "stand-in", appToken: "stand-in", apiBase: "http://slack.test/api",
    fetch: async (url, init) => {
      const method = String(url).split("/").pop(); calls.push(method);
      if (method === "chat.startStream") started.resolve();
      if (method === pendingMethod) { entered.resolve(init.signal); await released.promise; }
      return new Response(JSON.stringify({ ok: true, ts: "100.2" }));
    } });
  const stream = new ReplyStream({ adapter, chatId: "D1", messageId: "100.1" }, async text => ({ text, blocked: false }), 1);
  stream.text("Preview words "); await started.promise;
  const finished = stream.finish("Preview words done.");
  const refused = assert.rejects(finished, ReplyDeliveryUncertain);
  const signal = await entered.promise; stream.cancel(false);
  assert.ok(signal.aborted, "the actual deferred edit/finalization request is aborted");
  released.resolve(); await refused;
  assert.equal(await stream.finishError(), false);
  assert.equal(calls.filter(method => method === "chat.startStream").length, 1);
  assert.ok(!calls.includes("chat.postMessage"), "no blind fresh-send fallback after cancellation");
});

for (const revoke of ["Stop", "AppLock", "profile", "Lockdown", "detach"]) test(`router ${revoke} reaches the in-flight native request and prevents a deferred fallback`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "branch-stream-gate-"));
  const done = Promise.withResolvers();
  const provider = { name: "stand-in", async complete(request) {
    request.onTextDelta?.("Preview words "); await done.promise;
    return { content: "Final answer.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { done.resolve(); await app.close(); await discardTemp(root); });
  const f = slackPreview({ ok: false, error: "unknown_method" });
  f.adapter.start = async () => {}; f.adapter.stop = async () => {};
  f.adapter.react = async () => {}; f.adapter.setStatus = async () => {};
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = { progressAfterMs: 5, editEveryMs: 1, typingEveryMs: 1000, reactEveryMs: 1000 };
  app.channels.setSwitches({ liveStatus: "on", steps: "off" });
  await app.channels.attach(f.adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  const handled = app.channels.handle({ channel: "stand-in", chatId: "D1", chatKind: "direct", senderId: "owner",
    text: "answer", addressed: true, messageId: "100.1" });
  const signal = await f.entered.promise;
  if (revoke === "Stop") {
    const run = app.store.runs(app.runtime.owner).find(r => r.status === "running");
    assert.ok(run, "the task is live before Stop");
    assert.equal(app.runtime.cancel(run.id), true);
  }
  if (revoke === "AppLock") app.sessionLock.lock();
  if (revoke === "profile") {
    const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
    app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  }
  if (revoke === "Lockdown") setLockdown(app.store, app.runtime.owner, { on: true });
  if (revoke === "detach") await app.channels.detach("stand-in");
  assert.ok(signal.aborted, "the real lifecycle boundary aborts the adapter request");
  f.released.resolve(); done.resolve(); await handled;
  assert.deepEqual(f.calls.filter(c => c.method.startsWith("chat.")).map(c => c.method), ["chat.startStream"]);
});
