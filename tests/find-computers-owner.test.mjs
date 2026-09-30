/**
 * find-computers, the owner's own nodes only:
 *   - the Tailscale "who are you" door is never open by default; it opens only while the owner looks or this computer
 *     waits to be found, and shuts by the same stop, idle and Lockdown rules;
 *   - it answers only this computer and nodes Tailscale lists as the same Tailscale user's, never a device someone
 *     else shared in, a tagged node or an address Tailscale does not list, and says only the name;
 *   - an offer shows who made it (name and address), may be refused before any number is typed, a second offer
 *     replaces nothing, and the number answers the offer that was shown and no other;
 *   - the desktop app hands in the same network parts as `branch start`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { makeSameUser, readPeers, sameTailnetUser } from "../dist/remote/tailscale.js";
import { NodeDoor, makeProbeHello, makeSendOffer, helloPath, offerPath } from "../dist/devices/hello.js";
import { Findable } from "../dist/devices/findable.js";
import { findAndPair } from "../dist/devices/node/find-cli.js";
import { setLockdown } from "../dist/lockdown.js";

const offerId = "ab".repeat(16);
const status = ({ self = ["100.64.0.1"], peers = {}, userId = 1, backend = "Running" } = {}) =>
  JSON.stringify({ BackendState: backend, Self: { HostName: "here", ...(userId === null ? {} : { UserID: userId }), TailscaleIPs: self }, Peer: peers });
const peer = (ip, extra = {}) => ({ HostName: "p", TailscaleIPs: [ip], Online: true, UserID: 1, ...extra });

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function network() {
  const open = new Set();
  const socketAt = (address) => async () => {
    const listeners = [];
    const socket = { address, listeners, send(data) { for (const o of [...open]) if (o !== socket) for (const l of o.listeners) l(data, address); },
      onMessage(l) { listeners.push(l); }, close() { open.delete(socket); } };
    open.add(socket);
    return socket;
  };
  return { socketAt, open };
}
const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
async function branch(t, findComputers) {
  const root = await mkdtemp(join(tmpdir(), "branch-find-owner-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, findComputers });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await server.close(); await app.close(); };
  t.after(async () => { await close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${server.token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call, close };
}
const probe = makeProbeHello({ timeoutMs: 800 });
async function until(check, what) {
  for (let i = 0; i < 60; i++) { if (await check()) return; await sleep(25); }
  assert.fail(what);
}
const post = (port, body) => fetch(`http://127.0.0.1:${port}${offerPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("same Tailscale user: this computer and the owner's nodes only; shared-in, tagged, other users and unlisted are not", () => {
  const peers = { a: peer("100.100.1.2"), b: peer("100.100.1.3", { UserID: 2 }), c: peer("100.100.1.4", { ShareeNode: true }),
    d: peer("100.100.1.5", { Tags: ["tag:server"] }) };
  const json = status({ peers });
  assert.equal(sameTailnetUser(json, "100.64.0.1"), true, "this computer itself");
  assert.equal(sameTailnetUser(json, "100.100.1.2"), true, "the owner's own node");
  for (const other of ["100.100.1.3", "100.100.1.4", "100.100.1.5", "100.100.1.99", "127.0.0.1"])
    assert.equal(sameTailnetUser(json, other), false, other);
  assert.equal(sameTailnetUser(status({ peers, userId: null }), "100.100.1.2"), false, "no UserID for this computer: nobody");
  assert.equal(sameTailnetUser(status({ peers, backend: "NeedsLogin" }), "100.100.1.2"), false, "signed out: nobody");
  assert.equal(sameTailnetUser("not json", "100.100.1.2"), false);
  assert.deepEqual(readPeers(json).map((p) => p.address), ["100.100.1.2"], "only the owner's own nodes are asked hello");
});

test("same Tailscale user: one status read is shared for a few seconds, and no answer is nobody", async () => {
  let reads = 0;
  let clock = 0;
  const same = makeSameUser(async () => { reads++; return status({ peers: { a: peer("100.100.1.2") } }); }, 1000, () => clock);
  assert.equal(await same("100.100.1.2"), true);
  assert.equal(await same("::ffff:100.100.1.2"), true);
  assert.equal(await same("100.100.1.3"), false);
  assert.equal(reads, 1);
  clock = 1000;
  await same("100.100.1.2");
  assert.equal(reads, 2, "read again once it is old");
  assert.equal(await makeSameUser(async () => null)("100.100.1.2"), false);
  assert.equal(await makeSameUser(async () => { throw new Error("no"); })("100.100.1.2"), false);
});

test("a Tailscale door answers hello and offers only to the same Tailscale user; anyone else hears 404", async (t) => {
  const cases = [
    ["this computer", status({ self: ["100.64.0.1", "127.0.0.1"] }), true],
    ["the owner's node", status({ peers: { a: peer("127.0.0.1") } }), true],
    ["another user's node", status({ peers: { a: peer("127.0.0.1", { UserID: 2 }) } }), false],
    ["a device shared in", status({ peers: { a: peer("127.0.0.1", { ShareeNode: true }) } }), false],
    ["a tagged node", status({ peers: { a: peer("127.0.0.1", { Tags: ["tag:x"] }) } }), false],
    ["an address Tailscale does not list", status({ peers: { a: peer("100.100.1.2") } }), false],
    ["no Tailscale answer", null, false],
  ];
  for (const [who, json, answers] of cases) {
    const taken = [];
    const door = new NodeDoor({ hello: () => ({ branch: "hello", name: "Desk" }), offer: () => (body) => { taken.push(body); return { held: true }; },
      sameUser: makeSameUser(async () => json) });
    const port = await door.open("127.0.0.1", 0, true);
    const hello = await probe("127.0.0.1", port);
    const offered = await post(port, { link: `http://100.100.1.2:3210/devices/pair?offer=${offerId}`, name: "A" });
    await door.close();
    assert.deepEqual(hello, answers ? { branch: "hello", name: "Desk" } : null, `${who}: hello`);
    assert.equal(offered.status, answers ? 200 : 404, `${who}: offer`);
    assert.equal(taken.length, answers ? 1 : 0, `${who}: nothing reaches the offer handler`);
  }
  const bare = new NodeDoor({ hello: () => ({ branch: "hello", name: "Desk" }) });
  t.after(() => bare.close());
  const port = await bare.open("127.0.0.1", 0, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}${helloPath}`)).status, 404, "a Tailscale door with no way to check answers nobody");
});

test("the Tailscale door follows looking and waiting to be found: shut by default, by stop, idle, leave, Lockdown and close", async (t) => {
  const lan = network();
  const port = await freePort();
  let reads = 0;
  const b = await branch(t, { status: async () => { reads++; return status({ self: ["100.64.0.1", "127.0.0.1"] }); }, probe: async () => null,
    send: makeSendOffer(), openMdns: lan.socketAt("192.168.1.10"), port, addresses: () => [], presence: true, idleMs: 150,
    listenHost: () => "127.0.0.1" });
  const open = async () => (await probe("127.0.0.1", port)) !== null;
  await sleep(100);
  assert.equal(await open(), false, "not open while Branch merely runs");
  assert.equal(reads, 0, "and Tailscale was not even asked");

  await b.call("POST", "/api/devices/find", { on: true });
  await until(open, "open while looking");
  assert.deepEqual(await probe("127.0.0.1", port), { branch: "hello", name: b.app.devices.hello().name }, "the name, nothing more");
  await b.call("POST", "/api/devices/find", { on: false });
  await until(async () => !(await open()), "shut when looking stops");

  await b.call("POST", "/api/devices/find", { on: true });
  await until(open, "open while looking again");
  await sleep(400); // nobody reads the list
  assert.equal(await open(), false, "shut when the looking went idle");

  assert.equal((await b.call("POST", "/api/devices/join/find", {})).body.state, "finding");
  await until(open, "open while waiting to be found");
  await b.call("POST", "/api/devices/join/leave", {});
  await until(async () => !(await open()), "shut on leave");

  await b.call("POST", "/api/devices/join/find", {});
  await until(open, "open while waiting again");
  setLockdown(b.app.store, b.app.runtime.owner, { on: true });
  await until(async () => !(await open()), "shut by Lockdown");
  setLockdown(b.app.store, b.app.runtime.owner, { on: false });
  await sleep(150);
  assert.equal(await open(), false, "Lockdown off opens nothing by itself");

  await b.call("POST", "/api/devices/find", { on: true });
  await until(open, "open once more");
  await b.close();
  assert.equal(await open(), false, "nothing left listening after Branch closes");
});

test("an offer on the Tailscale door from someone else's node is not heard, and holds nothing", async (t) => {
  const lan = network();
  for (const [who, peers, heard] of [["another user", { a: peer("127.0.0.1", { UserID: 2 }) }, false], ["the owner", { a: peer("127.0.0.1") }, true]]) {
    const port = await freePort();
    const b = await branch(t, { status: async () => status({ peers }), probe: async () => null, send: makeSendOffer(),
      openMdns: lan.socketAt("192.168.1.30"), port, addresses: () => [], presence: true, listenHost: () => "127.0.0.1" });
    await b.call("POST", "/api/devices/join/find", {});
    await until(async () => b.app.devices.presence.status().open, `${who}: the door opened`);
    const answer = await post(port, { link: `http://100.100.1.2:3210/devices/pair?offer=${offerId}`, name: "Desk" });
    assert.equal(answer.status, heard ? 200 : 404, who);
    const shown = (await b.call("GET", "/api/devices/join")).body.offer;
    assert.equal(shown === null ? null : shown.from, heard ? "127.0.0.1" : null, `${who}: what is shown`);
    await b.call("POST", "/api/devices/join/leave", {});
    await b.close();
  }
});

test("an offer shows who made it, can be refused, a second one replaces nothing, and the number answers only the one shown", async (t) => {
  const lan = network();
  const port = await freePort();
  const b = await branch(t, { status: async () => null, probe: async () => null, send: makeSendOffer(),
    openMdns: lan.socketAt("192.168.1.20"), port, addresses: () => ["127.0.0.1"] });
  assert.equal((await b.call("POST", "/api/devices/join/find", {})).body.state, "finding");
  const link = (n) => `http://127.0.0.1:${3000 + n}/devices/pair?offer=${offerId}`;
  assert.equal((await post(port, { link: link(1), name: "Desk PC" })).status, 200);
  const first = (await b.call("GET", "/api/devices/join")).body.offer;
  assert.deepEqual({ name: first.name, from: first.from, hub: first.hub }, { name: "Desk PC", from: "127.0.0.1", hub: "http://127.0.0.1:3001" });
  assert.match(first.id, /^[a-f0-9]{16}$/);

  const second = await post(port, { link: link(2), name: "Rogue" });
  assert.equal(second.status, 409, "a second offer while one is shown is refused");
  assert.match((await second.json()).error, /already has an invitation/);
  assert.deepEqual((await b.call("GET", "/api/devices/join")).body.offer, first, "and it replaced nothing");

  const unshown = await b.call("POST", "/api/devices/join", { code: "123456" });
  assert.equal(unshown.status, 409, "a number without the offer it answers is refused");
  const stale = await b.call("POST", "/api/devices/join", { code: "123456", offer: "cd".repeat(8) });
  assert.equal(stale.status, 409, "a number for another offer is refused");
  assert.deepEqual((await b.call("GET", "/api/devices/join")).body.offer, first, "and the offer shown stays");

  assert.equal((await b.call("POST", "/api/devices/join/find/refuse", { offer: "cd".repeat(8) })).status, 409, "refusing names the offer shown");
  const refused = await b.call("POST", "/api/devices/join/find/refuse", { offer: first.id });
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(refused.body.state, "finding", "still waiting to be found");
  assert.equal(refused.body.offer, null, "the refused offer is gone");

  assert.equal((await post(port, { link: link(3), name: "Laptop" })).status, 200, "another offer may come after a refusal");
  const third = (await b.call("GET", "/api/devices/join")).body.offer;
  assert.equal(third.name, "Laptop");
  assert.notEqual(third.id, first.id);
  const late = await b.call("POST", "/api/devices/join", { code: "123456", offer: first.id });
  assert.equal(late.status, 409, "the refused offer's id no longer answers anything");
  await b.call("POST", "/api/devices/join/leave", {});
});

test("an offer must be sent as JSON, so a web page on the network cannot post one", async (t) => {
  const taken = [];
  const door = new NodeDoor({ hello: () => ({ branch: "hello", name: "Desk" }), offer: () => (body) => { taken.push(body); return { held: true }; } });
  t.after(() => door.close());
  const port = await door.open("127.0.0.1", 0);
  const body = JSON.stringify({ link: `http://100.100.1.2:3210/devices/pair?offer=${offerId}`, name: "A" });
  for (const type of ["text/plain", "application/x-www-form-urlencoded", null]) {
    const answer = await fetch(`http://127.0.0.1:${port}${offerPath}`, { method: "POST", ...(type ? { headers: { "content-type": type } } : {}), body });
    assert.equal(answer.status, 415, String(type));
  }
  assert.equal(taken.length, 0);
  assert.equal((await post(port, JSON.parse(body))).status, 200);
});

test("branch node pair: its Tailscale door hears only the same user, the offer shows its address, and Enter refuses it", async () => {
  const lan = network();
  for (const [who, json, heard] of [["another user", status({ peers: { a: peer("127.0.0.1", { UserID: 2 }) } }), false],
    ["this computer", status({ self: ["100.64.0.1", "127.0.0.1"] }), true]]) {
    const port = await freePort();
    const lines = [];
    const typed = [];
    const dir = await mkdtemp(join(tmpdir(), "branch-find-owner-cli-"));
    const stop = new AbortController();
    try {
      const running = findAndPair({ dir, platform: "linux", env: {}, offers: [], name: "Desk", print: (line) => lines.push(line), signal: stop.signal,
        parts: { status: async () => json, openMdns: lan.socketAt("192.168.1.40"), addresses: () => [], listenHost: () => "127.0.0.1", port, timeoutMs: 5000,
          readLine: async (prompt) => { typed.push(prompt); if (typed.length === 1) return ""; stop.abort(); return ""; } } });
      await until(async () => lines.some((l) => l.startsWith("Waiting to be found")), `${who}: waiting`);
      assert.equal((await probe("127.0.0.1", port)) !== null, heard, `${who}: hello`);
      const answer = await post(port, { link: `http://100.100.1.2:3210/devices/pair?offer=${offerId}`, name: "Owner PC" });
      assert.equal(answer.status, heard ? 200 : 404, `${who}: offer`);
      if (heard) {
        await until(() => lines.some((l) => l.includes("Refused")), "Enter refused the offer");
        assert.ok(lines.some((l) => l.includes('"Owner PC"') && l.includes("from 127.0.0.1")), "the name and the address it came from are shown");
        assert.equal((await post(port, { link: `http://100.100.1.2:3210/devices/pair?offer=${offerId}`, name: "Again" })).status, 200, "still waiting after a refusal");
      }
      if (!heard) stop.abort();
      assert.equal(await running, null);
    } finally { stop.abort(); await discardTemp(dir); }
  }
});

test("the desktop app hands in the same network parts as branch start", async () => {
  // The desktop app's engine runs in a process of its own (src/desktop/engine-process.ts), which main.ts starts.
  const main = await readFile(new URL("../src/desktop/engine-process.ts", import.meta.url), "utf8");
  const call = main.slice(main.indexOf("const branch = await createBranch({"));
  assert.match(call.slice(0, call.indexOf("});")), /^\s*findComputers: realDeviceNetwork\(\),/m, "the desktop's own engine gets the network parts");
  assert.match(main, /import \{ realDeviceNetwork \} from "\.\.\/devices\/network\.js";/);
  const cli = await readFile(new URL("../src/cli-program.ts", import.meta.url), "utf8");
  assert.match(cli, /command === "start" \? \{ findComputers: realDeviceNetwork\(\) \}/, "and branch start, which the background engine runs");
});
