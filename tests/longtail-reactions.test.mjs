// CHAT-175: Revolt and KOOK show the status reaction on the person's message and take the previous one away, through
// each app's own reaction routes; nobody else's reactions are touched. Stand-in services only.
import test from "node:test";
import assert from "node:assert/strict";
import { httpService } from "./channels-parity-kit.mjs";
import { RevoltChannel } from "../dist/channels/revolt.js";
import { KookChannel } from "../dist/channels/kook.js";
import { LiveStatus } from "../dist/channels/live-status.js";

test("Revolt: the new status reaction is put and the bot's previous one removed", async (t) => {
  const api = await httpService(t, () => ({ status: 204, body: "" , type: "text/plain" }));
  const revolt = new RevoltChannel({ id: "revolt", token: "revolt-test-token", apiBase: api.base });
  await revolt.react("CH1", "M1", "👀", "✅");
  assert.deepEqual(api.calls.map((c) => [c.method, decodeURIComponent(c.path)]), [
    ["DELETE", "/channels/CH1/messages/M1/reactions/✅"], ["PUT", "/channels/CH1/messages/M1/reactions/👀"]]);
});

test("KOOK: a channel reaction uses KOOK's emoji code, a DM uses the direct-message route", async (t) => {
  const api = await httpService(t, () => ({ body: { code: 0, message: "", data: {} } }));
  const kook = new KookChannel({ id: "kook", token: "kook-test-token", apiBase: `${api.base}/api/v3`, retryBaseMs: 20 });
  await kook.react("c:123", "msg-1", "👀");
  await kook.react("u:456", "msg-2", "✅", "👀");
  assert.deepEqual(api.calls.map((c) => [c.path, c.json?.emoji]), [
    ["/api/v3/message/add-reaction", "[#128064;]"],
    ["/api/v3/direct-message/delete-reaction", "[#128064;]"], ["/api/v3/direct-message/add-reaction", "[#9989;]"]]);
  await assert.rejects(kook.react("x:1", "msg", "👀"), /Invalid KOOK/);
});

// Review 5914165404: a reaction replacement is two calls to the app. Authority ending between them (Lockdown, quiet hours,
// the chat app disconnected) or the live status being cancelled stops the second call; the gate is checked per call.
function gateOf() {
  const controller = new AbortController();
  const gate = { allowed: true, signal: controller.signal, abort: () => controller.abort(),
    check: () => { controller.signal.throwIfAborted(); if (!gate.allowed) throw new Error("no longer allowed"); } };
  return gate;
}

test("Revolt and KOOK: authority ending during the removal stops the new reaction", async (t) => {
  let gate = gateOf();
  const revoltApi = await httpService(t, (call) => { if (call.method === "DELETE") gate.allowed = false; return { status: 204, body: "", type: "text/plain" }; });
  const revolt = new RevoltChannel({ id: "revolt", token: "revolt-test-token", apiBase: revoltApi.base });
  await assert.rejects(revolt.react("CH1", "M1", "👀", "✅", gate), /no longer allowed/);
  assert.deepEqual(revoltApi.calls.map((c) => c.method), ["DELETE"]);
  gate = gateOf();
  const kookApi = await httpService(t, (call) => { if (call.path.endsWith("/delete-reaction")) gate.allowed = false; return { body: { code: 0, message: "", data: {} } }; });
  const kook = new KookChannel({ id: "kook", token: "kook-test-token", apiBase: `${kookApi.base}/api/v3`, retryBaseMs: 20 });
  await assert.rejects(kook.react("c:123", "msg-1", "✅", "👀", gate), /no longer allowed/);
  assert.deepEqual(kookApi.calls.map((c) => c.path), ["/api/v3/message/delete-reaction"]);
});

test("Revolt and KOOK: the gate's signal cancels a removal still on its way, and nothing is put after it", async (t) => {
  for (const make of [
    async (route) => { const api = await httpService(t, route); return { api, react: (g) => new RevoltChannel({ id: "revolt", token: "revolt-test-token", apiBase: api.base }).react("CH1", "M1", "👀", "✅", g) }; },
    async (route) => { const api = await httpService(t, route); return { api, react: (g) => new KookChannel({ id: "kook", token: "kook-test-token", apiBase: `${api.base}/api/v3`, retryBaseMs: 20 }).react("c:1", "m-1", "✅", "👀", g) }; },
  ]) {
    const gate = gateOf();
    let release, arrived;
    const reached = new Promise((resolve) => { arrived = resolve; });
    const { api, react } = await make(() => { arrived(); return { hold: new Promise((resolve) => { release = resolve; }), status: 204, body: "", type: "text/plain" }; });
    const pending = react(gate);
    await reached;
    gate.abort();
    const outcome = await Promise.race([pending.then(() => "resolved", (error) => error),
      new Promise((resolve) => { setTimeout(resolve, 5000, "still waiting").unref(); })]);
    assert.equal(outcome?.name, "AbortError", "the removal was cancelled, not left to time out");
    release();
    assert.equal(api.calls.length, 1, "only the removal reached the app");
  }
});

test("LiveStatus hands each reaction a gate that rechecks its authority and is aborted by cancel", async () => {
  let allowed = true, gate;
  const adapter = { id: "fake", kind: "fake", async start() {}, async stop() {}, async send() { return "1"; },
    async react(_chatId, _messageId, _emoji, _previous, given) { gate = given; } };
  const live = new LiveStatus({ adapter, chatId: "c1", messageId: "m1", allowed: () => allowed },
    async (text) => ({ text, blocked: false }), { progressAfterMs: 60000, editEveryMs: 10, typingEveryMs: 60000, reactEveryMs: 5 });
  live.start();
  for (let i = 0; i < 200 && !gate; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(gate, "the reaction was handed a gate");
  gate.check();
  allowed = false;
  assert.throws(() => gate.check(), /no longer allowed/);
  allowed = true;
  live.cancel();
  assert.equal(gate.signal.aborted, true);
  assert.throws(() => gate.check());
});
