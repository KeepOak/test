/**
 * UP-PLATFORM-003: after the computer wakes, each chat app gets one bounded look. An app whose socket went stale in the
 * sleep is started again; an app its service still reaches is left alone; the resume signal and the watchdog's late
 * beat are one wake, not two. Stand-in sockets only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, DiscordAdapter } from "../dist/index.js";
import { EnginePowerRecovery } from "../dist/desktop/engine-power.js";

async function until(check, label) {
  for (const end = Date.now() + 3000; Date.now() < end; await delay(5)) if (check()) return;
  assert.fail(`Timed out: ${label}`);
}

/** A stand-in gateway: `pong` decides whether the service still answers this socket's pings. */
function socketWorld() {
  const sockets = [];
  const connect = async (address, options) => {
    let close;
    const socket = { address, options, pings: 0, pong: true, sent: [], closed: new Promise((resolve) => { close = resolve; }),
      send(text) { socket.sent.push(text); }, close() { close(); },
      ping(onPong) { socket.pings++; if (socket.pong) setTimeout(onPong, 1); } };
    sockets.push(socket);
    return socket;
  };
  return { sockets, connect };
}

const discord = (id, world) => new DiscordAdapter({ id, token: "stand-in", gatewayUrl: "wss://gateway.test", connect: world.connect,
  keepaliveMs: 10, fetch: async () => new Response("{}") });

async function branchWith(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.wakeProbeMs = 300; app.channels.wakeRetryMs = 1;
  return app;
}

test("a simulated resume reconnects the app whose socket went stale and leaves the healthy one alone", async (t) => {
  const app = await branchWith(t);
  const healthy = socketWorld(), stale = socketWorld();
  for (const [id, world] of [["healthy", healthy], ["stale", stale]])
    await app.channels.attach(discord(id, world), { activation: "always", pairing: true, allowlist: [] });
  await until(() => healthy.sockets[0]?.pings > 0 && stale.sockets[0]?.pings > 0, "both sockets are pinging");
  stale.sockets[0].pong = false; // the sleep killed this one's connection, and nothing said so
  await delay(5); // a pong already on its way lands first
  const logged = [];
  const power = new EnginePowerRecovery({ checkpoint: () => {}, due: async () => {}, flush: () => app.channels.flush(),
    reconnect: () => app.channels.wake(), log: (line) => logged.push(line) });
  assert.equal(await power.resume(), true, "due work and delivery do not wait for the look");
  await app.channels.wake(); // the look already under way: the same one, not a second
  assert.equal(stale.sockets.length, 2, "the stale app was started again on a new socket");
  assert.equal(healthy.sockets.length, 1, "the app its service still answered was left alone");
  await until(() => stale.sockets[1].pings > 0, "the new socket is pinging");
  const cards = app.channels.summary().channels;
  assert.ok(cards.every((card) => card.health.state !== "needs attention"), JSON.stringify(cards.map((card) => card.health)));
  assert.deepEqual(logged, []);
});

test("the resume signal and the watchdog's late beat are one wake; a failing reconnect is retried with backoff, then shown", async (t) => {
  const app = await branchWith(t);
  app.channels.wakeProbeMs = 20;
  const starts = { flaky: 0, dead: 0 };
  // Fresh by the beats' own clock below (so the ordinary stall check leaves them), silent since before the real wake.
  const fake = (id, fails) => ({ id, kind: id, botName: () => "B", async start() {}, async stop() {}, async send() { return "1"; },
    lastContact: () => 999_999, async restart() { starts[id]++; if (starts[id] <= fails) throw new Error("offline"); } });
  await app.channels.attach(fake("flaky", 2), { activation: "always", pairing: true, allowlist: [] });
  await app.channels.attach(fake("dead", 99), { activation: "always", pairing: true, allowlist: [] });
  const first = app.channels.wake(), second = app.channels.wake();
  assert.equal(first, second, "a second signal while the first look runs joins it");
  await first;
  assert.deepEqual(starts, { flaky: 3, dead: 3 }, "each stale app is tried at most three times");
  const cards = Object.fromEntries(app.channels.summary().channels.map((card) => [card.id, card.health]));
  assert.notEqual(cards.flaky.state, "needs attention", "a reconnect that succeeded on a retry clears the card");
  assert.equal(cards.dead.state, "needs attention");
  assert.match(cards.dead.reason, /could not reconnect after this computer woke: offline/);
  await app.channels.watchTick(1_000_000); await app.channels.watchTick(1_000_000 + 10 * 60_000);
  assert.deepEqual(starts, { flaky: 3, dead: 3 }, "the late beat right after the resume is the same wake");
});
