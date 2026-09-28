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

test("Discord and Slack: a ping answered or a message received is contact; a silent socket goes stale; restart reconnects", async () => {
  for (const make of [
    (world) => new DiscordAdapter({ id: "discord", token: "stand-in", gatewayUrl: "wss://gateway.test", connect: world.connect, keepaliveMs: 10,
      fetch: async () => new Response("{}") }),
    (world) => new SlackAdapter({ id: "slack", token: "stand-in", appToken: "stand-in", socketUrl: "wss://slack.test", connect: world.connect, keepaliveMs: 10,
      apiBase: "http://slack.test/api", fetch: async () => new Response('{"ok":true,"user_id":"B1"}') }),
  ]) {
    const world = socketWorld(), adapter = make(world);
    assert.equal(typeof adapter.restart, "function");
    await adapter.start(async () => {});
    await delay(40);
    const fresh = adapter.lastContact();
    assert.ok(Date.now() - fresh < 30, `${adapter.kind}: an answered ping is contact`);
    world.sockets[0].pong = false;
    await delay(60);
    assert.ok(Date.now() - adapter.lastContact() >= 40, `${adapter.kind}: a socket nobody answers on goes stale`);
    await adapter.restart(async () => {});
    await delay(20);
    assert.equal(world.sockets.length, 2, `${adapter.kind}: started again on a new socket`);
    assert.ok(Date.now() - adapter.lastContact() < 30);
    await adapter.stop();
  }
});

test("Matrix: each answered sync, even an empty one, is contact; restart carries on from where it got to", async () => {
  const asked = [];
  const matrix = new MatrixAdapter({ id: "matrix", homeserver: "https://matrix.test", accessToken: "t", userId: "@b:matrix.test", syncTimeoutMs: 5,
    fetch: async (url) => { asked.push(new URL(url).searchParams.get("since")); await delay(5); return new Response(JSON.stringify({ next_batch: `b${asked.length}` })); } });
  await matrix.start(async () => {});
  await delay(40);
  assert.ok(Date.now() - matrix.lastContact() < 30);
  await matrix.restart(async () => {});
  await delay(20);
  await matrix.stop();
  const afterRestart = asked.slice(asked.indexOf(null) + 1);
  assert.ok(afterRestart.every((since) => since !== null), "the restart resumed from its place, not from the start");
});

test("a watchdog beat that comes far too late restarts every app at once; an ordinary beat does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-watch-all-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const restarted = [];
  for (const id of ["a", "b"])
    await app.channels.attach({ id, kind: "fake", botName: () => "B", async start() {}, async stop() {}, async send() { return "1"; },
      lastContact: () => Date.now(), async restart() { restarted.push(id); if (id === "b") throw new Error("still offline"); } },
    { activation: "always", pairing: true, allowlist: [] });
  await app.channels.watchTick(1_000_000);
  await app.channels.watchTick(1_015_000);
  assert.deepEqual(restarted, [], "fifteen seconds later is an ordinary beat");
  await app.channels.watchTick(1_015_000 + 10 * 60_000);
  assert.deepEqual(restarted.sort(), ["a", "b"], "after a sleep every app starts again, one failing stops no other");
  const b = app.channels.summary().channels.find((one) => one.id === "b");
  assert.equal(b.health.state, "needs attention");
  assert.match(b.health.reason, /could not reconnect after this computer woke/);
});
