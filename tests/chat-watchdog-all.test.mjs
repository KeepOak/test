/**
 * Staying connected for every app that can (CHAT-134, 136): Discord, Slack and Matrix say when they last heard from
 * their service (a ping answered, an envelope, a sync) and can be started again, so the watchdog covers them as it
 * covers Telegram; and a watchdog beat that comes far too late (this computer slept) starts every app again at once.
 * Stand-in services only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, DiscordAdapter, SlackAdapter, MatrixAdapter } from "../dist/index.js";

/** Waits for `check` to hold, for up to two seconds: a loaded runner delays timers, so no check counts milliseconds. */
async function until(check, label) {
  for (const end = Date.now() + 2000; Date.now() < end; await delay(5)) if (check()) return;
  assert.fail(`Timed out: ${label}`);
}

/** A stand-in socket: `pong` decides whether the service answers pings. */
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

test("Discord and Slack: a ping answered or a message received is contact; a silent socket goes stale; restart reconnects", async (t) => {
  for (const make of [
    (world) => new DiscordAdapter({ id: "discord", token: "stand-in", gatewayUrl: "wss://gateway.test", connect: world.connect, keepaliveMs: 10,
      fetch: async () => new Response("{}") }),
    (world) => new SlackAdapter({ id: "slack", token: "stand-in", appToken: "stand-in", socketUrl: "wss://slack.test", connect: world.connect, keepaliveMs: 10,
      apiBase: "http://slack.test/api", fetch: async () => new Response('{"ok":true,"user_id":"B1"}') }),
  ]) {
    const world = socketWorld(), adapter = make(world);
    t.after(() => adapter.stop().catch(() => undefined)); // a failed check never leaves a socket's keepalive running
    assert.equal(typeof adapter.restart, "function");
    await adapter.start(async () => {});
    const connected = adapter.lastContact(); // connecting is contact; an answered ping after it must move it on
    await until(() => adapter.lastContact() > connected, `${adapter.kind}: an answered ping is contact`);
    world.sockets[0].pong = false;
    await delay(5); // a pong already on its way lands first
    const last = adapter.lastContact(), pings = world.sockets[0].pings;
    await until(() => world.sockets[0].pings >= pings + 3, `${adapter.kind}: it keeps pinging`);
    assert.equal(adapter.lastContact(), last, `${adapter.kind}: a socket nobody answers on goes stale`);
    await adapter.restart(async () => {});
    await until(() => world.sockets.length === 2, `${adapter.kind}: started again on a new socket`);
    const reconnected = adapter.lastContact();
    await until(() => world.sockets[1].pings > 0 && adapter.lastContact() > reconnected, `${adapter.kind}: the new socket's answered ping is contact`);
    await adapter.stop();
  }
});

test("Matrix: each answered sync, even an empty one, is contact; restart carries on from where it got to", async (t) => {
  const asked = [];
  const matrix = new MatrixAdapter({ id: "matrix", homeserver: "https://matrix.test", accessToken: "t", userId: "@b:matrix.test", syncTimeoutMs: 5,
    fetch: async (url) => { asked.push(new URL(url).searchParams.get("since")); await delay(5); return new Response(JSON.stringify({ next_batch: `b${asked.length}` })); } });
  t.after(() => matrix.stop().catch(() => undefined)); // a failed check never leaves the sync loop running
  await matrix.start(async () => {});
  await until(() => asked.length > 0, "it syncs");
  const first = matrix.lastContact();
  await until(() => matrix.lastContact() > first, "each answered sync, even an empty one, is contact");
  await matrix.restart(async () => {});
  await delay(20);
  await matrix.stop();
  const afterRestart = asked.slice(asked.indexOf(null) + 1);
  assert.ok(afterRestart.every((since) => since !== null), "the restart resumed from its place, not from the start");
});

test("a watchdog beat that comes far too late looks at every app at once and restarts the silent ones; an ordinary beat does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-watch-all-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.wakeProbeMs = 50; app.channels.wakeRetryMs = 1;
  const restarted = [];
  // Fresh by the beats' own clock, but last heard from long before the wake itself: each is started again then.
  for (const id of ["a", "b"])
    await app.channels.attach({ id, kind: "fake", botName: () => "B", async start() {}, async stop() {}, async send() { return "1"; },
      lastContact: () => 1_014_000, async restart() { restarted.push(id); if (id === "b") throw new Error("still offline"); } },
    { activation: "always", pairing: true, allowlist: [] });
  await app.channels.watchTick(1_000_000);
  await app.channels.watchTick(1_015_000);
  assert.deepEqual(restarted, [], "fifteen seconds later is an ordinary beat");
  await app.channels.watchTick(1_015_000 + 10 * 60_000);
  assert.deepEqual(restarted.sort(), ["a", "b", "b", "b"], "after a sleep each silent app starts again; one failing is retried and stops no other");
  const b = app.channels.summary().channels.find((one) => one.id === "b");
  assert.equal(b.health.state, "needs attention");
  assert.match(b.health.reason, /could not reconnect after this computer woke/);
});
