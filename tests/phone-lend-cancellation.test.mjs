import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serveLending } from "../apps/mobile/web/phone-node.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const events = {}, answers = [], streams = [];
  let finish, acquire, hidden;
  const env = { platform: "android", now: Date.now,
    media: { getUserMedia: async () => {
      const stream = { stopped: 0, getTracks: () => [{ stop() { stream.stopped++; } }] };
      streams.push(stream);
      return acquire ? acquire(stream) : stream;
    } },
    record: () => new Promise((resolve) => { finish = resolve; }),
    frame: () => new Promise((resolve) => { finish = resolve; }),
    onHidden: (fn) => { hidden = fn; return () => { hidden = null; }; },
  };
  const bridge = { deviceStatus: async () => ({ paired: true, never: [] }),
    addListener: async (name, fn) => { events[name] = fn; return { remove: async () => delete events[name] }; },
    lendStart: async () => {}, lendStop: async () => {}, lendResult: async (answer) => { answers.push(answer); },
  };
  const ask = (id = "a", capability = "listen", deadline = Date.now() + 10_000) => events.lendInvoke({
    id: id.repeat(32), capability, deadline, args: { seconds: 30 },
  });
  return { env, bridge, events, streams, answers, ask, finish: () => finish?.({ data: new Uint8Array([1]), mime: "audio/webm" }),
    delayPermission: (fn) => { acquire = fn; }, hide: () => hidden?.() };
}

for (const reason of ["disconnect", "stop", "switch off", "hidden", "deadline"]) {
  test(`an active capture stops immediately on ${reason} and never returns late media`, async (t) => {
    const f = fixture(), stop = await serveLending(f.env, f.bridge);
    t.after(async () => { f.finish(); await stop(); });
    f.events.lendState({ connected: true, enabled: ["listen", "camera"] });
    const pending = f.ask("a", "listen", Date.now() + (reason === "deadline" ? 30 : 10_000));
    await tick();
    if (reason === "disconnect") f.events.lendState({ connected: false, enabled: [] });
    if (reason === "switch off") f.events.lendState({ connected: true, enabled: ["camera"] });
    if (reason === "hidden") f.hide();
    if (reason === "stop") await stop();
    if (reason === "deadline") await pending;
    else await tick();
    assert.ok(f.streams[0].stopped > 0);
    await pending; // The browser recording promise is still unresolved: cancellation must settle this itself.
    f.finish(); await tick();
    assert.equal(f.answers.length, 0);
    await stop();
  });
}

test("a late permission result closes its stream after stopping", async () => {
  const f = fixture(); let grant;
  f.delayPermission((stream) => new Promise((resolve) => { grant = () => resolve(stream); }));
  const stop = await serveLending(f.env, f.bridge);
  f.events.lendState({ connected: true, enabled: ["camera"] });
  const pending = f.ask("a", "camera"); await tick(); await stop(); await pending;
  grant(); await tick();
  assert.ok(f.streams[0].stopped > 0);
  assert.equal(f.answers.length, 0);
});

test("parallel requests refuse a second capture and a later request can run", async (t) => {
  const f = fixture(), stop = await serveLending(f.env, f.bridge);
  t.after(stop);
  f.events.lendState({ connected: true, enabled: ["listen", "camera"] });
  const first = f.ask(); await tick();
  const second = f.ask("b", "camera"); await tick();
  assert.equal(f.streams.length, 1);
  await second; assert.equal(f.answers[0].ok, false);
  f.events.lendState({ connected: false, enabled: [] }); await first;
  f.events.lendState({ connected: true, enabled: ["listen"] });
  const next = f.ask("c"); await tick(); f.finish(); await next;
  assert.equal(f.answers.at(-1).ok, true);
  assert.equal(f.streams.length, 2); await stop();
});

test("Stop lending forgets locally and navigates before a failed remote revoke", async () => {
  const source = readFileSync(new URL("../apps/mobile/web/ph-settings.js", import.meta.url), "utf8");
  const body = source.match(/async function stopLending\(\) \{([\s\S]*?)\n\}\nexport function initSettings/)[1];
  const run = new Function("attempt", "S", "phone", "post", "plugin", "go", `return (async () => {${body}\n})();`);
  const calls = [];
  await run(async (fn) => { try { await fn(); } catch { calls.push("offline reported"); } },
    { lend: { nodeId: "a".repeat(16), origin: "http://100.64.1.2" } },
    { session: { origin: "http://100.64.1.2" } }, async () => { calls.push("revoke"); throw new Error("offline"); },
    { deviceForget: async () => { calls.push("forget"); } }, () => calls.push("navigate"));
  assert.deepEqual(calls, ["forget", "navigate", "revoke", "offline reported"]);
});
