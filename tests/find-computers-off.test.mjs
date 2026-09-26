/**
 * find-computers: looking for the owner's other computers is off unless pairing is open, and it stops when pairing
 * closes. Everything runs on stand-ins: `tailscale status` is a string handed in, the local network is an in-memory bus
 * of fake sockets, and the only listeners are on 127.0.0.1.
 *
 *   1. by default nothing looks: no local-network socket, no hello asked of any peer, no offer sent; only the one
 *      Tailscale status read that answering on the tailnet needs;
 *   2. a restart on the same data starts nothing, even after looking and waiting to be found before it;
 *   3. a window that stops reading (closed or crashed) stops looking, and stops waiting to be found;
 *   4. a stop, Lockdown or close that lands while a start is still opening leaves nothing open or asking;
 *   5. without network parts looking is refused, not shown empty;
 *   6. Lockdown leaves the list readable (and empty) and refuses looking, offering and being found;
 *   7. a paired computer holds nothing that opens these routes;
 *   8. a loopback invitation is taken only from this computer itself.
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
import { decodePacket, MdnsAdvertiser, MdnsBrowser } from "../dist/devices/dns-sd.js";
import { NodeDoor, makeProbeHello, makeSendOffer, HelloSchema } from "../dist/devices/hello.js";
import { Findable, readOffer } from "../dist/devices/findable.js";
import { findLockdownWords, findNowhereWords } from "../dist/devices/find.js";
import { NodePresence } from "../dist/devices/presence.js";
import { setLockdown } from "../dist/lockdown.js";

const hello = (name = "Desk") => ({ branch: "hello", name, platform: "linux", version: "1.2.3" });
const status = (peers = {}) => JSON.stringify({ BackendState: "Running", Self: { HostName: "here", TailscaleIPs: ["100.64.0.1"] }, Peer: peers });
const peers = { a: { HostName: "desk", TailscaleIPs: ["100.100.1.2"], Online: true } };

/** An in-memory local network: whatever one fake socket sends, every other open one hears, with the sender's address. */
function network() {
  const open = new Set();
  const sent = [];
  let opened = 0;
  const socketAt = (address) => async () => {
    opened++;
    const listeners = [];
    const socket = {
      address, listeners,
      send(data) { sent.push({ from: address, packet: decodePacket(data) }); for (const other of [...open]) if (other !== socket) for (const l of other.listeners) l(data, address); },
      onMessage(listener) { listeners.push(listener); },
      close() { open.delete(socket); },
    };
    open.add(socket);
    return socket;
  };
  return { socketAt, sent, open, opened: () => opened };
}
/** A promise released by hand, so a test decides exactly when an opening socket or a Tailscale answer lands. */
function gate() { let release; const wait = new Promise((resolve) => { release = resolve; }); return { wait, release }; }

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Stand-in network parts that count every use. */
function counted(lan, address, extra = {}) {
  const used = { status: 0, probe: 0, send: 0 };
  const parts = {
    status: async () => { used.status++; return status(peers); },
    probe: async () => { used.probe++; return hello("Desk PC"); },
    send: async () => { used.send++; },
    openMdns: lan.socketAt(address), port: 0, version: "1.2.3", addresses: () => [], ...extra,
  };
  return { used, parts };
}

const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
async function branchAt(root, findComputers) {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...(findComputers ? { findComputers } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call, close: async () => { await server.close(); await app.close(); } };
}
async function branch(t, findComputers) {
  const root = await mkdtemp(join(tmpdir(), "branch-find-off-"));
  const b = await branchAt(root, findComputers);
  t.after(async () => { await b.close(); await discardTemp(root); });
  return { ...b, root };
}

test("by default nothing looks: no local-network socket, no peer asked, no offer sent, only presence's one status read", async (t) => {
  const lan = network();
  const port = await freePort();
  const { used, parts } = counted(lan, "192.168.1.10", { presence: true, port, listenHost: () => "127.0.0.1" });
  const { app, call } = await branch(t, parts);
  await sleep(150);
  assert.equal(app.devices.presence.status().open, true, "the tailnet door answers hello while Branch runs");
  const read = await call("GET", "/api/devices/find");
  assert.deepEqual(read.body, { looking: false, found: [], tailnet: null, network: null }, "reading the list starts nothing");
  assert.equal((await call("GET", "/api/devices/join")).body.state, "off");
  await sleep(100);
  assert.equal(lan.opened(), 0, "no local-network socket was ever opened");
  assert.deepEqual(used, { status: 1, probe: 0, send: 0 }, "Tailscale's own status once, and nothing else on any network");
});

test("a restart on the same data starts nothing, after looking and waiting to be found before it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-find-restart-"));
  const lan = network();
  const first = counted(lan, "192.168.1.10");
  const before = await branchAt(root, first.parts);
  assert.equal((await before.call("POST", "/api/devices/find", { on: true })).body.looking, true);
  assert.equal((await before.call("POST", "/api/devices/join/find", {})).body.state, "finding");
  assert.equal(lan.open.size, 2, "looking and being found each hold a socket");
  await before.close();
  assert.equal(lan.open.size, 0, "closing Branch closed both");
  const again = counted(lan, "192.168.1.10");
  const after = await branchAt(root, again.parts);
  t.after(async () => { await after.close(); await discardTemp(root); });
  await sleep(100);
  assert.equal((await after.call("GET", "/api/devices/find")).body.looking, false);
  assert.equal((await after.call("GET", "/api/devices/join")).body.state, "off");
  assert.equal(lan.open.size, 0);
  assert.equal(lan.opened(), 2, "no socket opened since the restart");
  assert.deepEqual(again.used, { status: 0, probe: 0, send: 0 });
});

test("a window that stops reading stops looking, and stops waiting to be found", async (t) => {
  const lan = network();
  const { parts } = counted(lan, "192.168.1.10", { idleMs: 120 });
  const { call } = await branch(t, parts);
  assert.equal((await call("POST", "/api/devices/find", { on: true })).body.looking, true);
  for (let i = 0; i < 4; i++) { await sleep(60); assert.equal((await call("GET", "/api/devices/find")).body.looking, true, "reads keep it going"); }
  await sleep(250);
  assert.equal([...lan.open].length, 0, "no reads: the local-network socket closed");
  assert.equal((await call("GET", "/api/devices/find")).body.looking, false);
  const asks = lan.sent.length;
  await sleep(100);
  assert.equal(lan.sent.length, asks, "and nothing more is asked");

  assert.equal((await call("POST", "/api/devices/join/find", {})).body.state, "finding");
  for (let i = 0; i < 4; i++) { await sleep(60); assert.equal((await call("GET", "/api/devices/join")).body.state, "finding"); }
  await sleep(250);
  assert.equal(lan.open.size, 0, "no reads: advertising stopped");
  assert.ok(lan.sent.at(-1).packet.records.every((r) => r.ttl === 0), "with a goodbye");
  const ended = (await call("GET", "/api/devices/join")).body;
  assert.equal(ended.state, "off");
  assert.match(ended.message, /Nobody picked this computer in time/);
});

test("a stop, Lockdown or close that lands while looking starts leaves no socket and asks nothing", async (t) => {
  for (const how of ["stop", "lockdown", "close"]) {
    const lan = network();
    const opening = gate();
    const { parts } = counted(lan, "192.168.1.10");
    const root = await mkdtemp(join(tmpdir(), "branch-find-race-"));
    const b = await branchAt(root, { ...parts, openMdns: async () => { await opening.wait; return lan.socketAt("192.168.1.10")(); } });
    const starting = b.app.devices.finder.start();
    if (how === "stop") b.app.devices.finder.stop();
    if (how === "lockdown") setLockdown(b.app.store, b.app.runtime.owner, { on: true });
    if (how === "close") b.app.devices.finder.close();
    opening.release();
    await starting.catch(() => null);
    await sleep(50);
    assert.equal(lan.open.size, 0, `${how}: the socket that landed late was closed`);
    assert.equal(lan.sent.length, 0, `${how}: nothing was asked on it`);
    assert.equal(b.app.devices.finder.stop().looking, false);
    if (how === "lockdown") setLockdown(b.app.store, b.app.runtime.owner, { on: false });
    await b.close();
    await discardTemp(root);
  }
});

test("a stop while waiting to be found is still opening leaves nothing advertised and no door open", async (t) => {
  const lan = network();
  const opening = gate();
  const port = await freePort();
  const findable = new Findable({ hello: () => hello(), name: "Desk", port, addresses: () => ["127.0.0.1"],
    openMdns: async () => { await opening.wait; return lan.socketAt("192.168.1.20")(); } });
  t.after(() => findable.stop());
  const starting = findable.start();
  await sleep(50); // the door is open; the socket is still opening
  await findable.stop();
  opening.release();
  await starting;
  await sleep(20);
  assert.equal(findable.advertising, false);
  assert.equal(lan.open.size, 0, "the socket that landed late was closed");
  assert.equal(lan.sent.length, 0, "and nothing was ever announced");
  assert.equal(await makeProbeHello()("127.0.0.1", port), null, "the door is shut");

  // A door closed before it finished opening does not stay open.
  const door = new NodeDoor({ hello: () => hello() });
  const doorPort = await freePort();
  const opened = door.open("127.0.0.1", doorPort);
  await door.close();
  await opened;
  assert.equal(door.listening, false);
  assert.equal(await makeProbeHello()("127.0.0.1", doorPort), null, "a close during the open shuts it");
});

test("the tailnet door: a close or Lockdown while Tailscale is still asked opens nothing; Lockdown off opens it again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-find-presence-race-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const port = await freePort();
  const probe = makeProbeHello();
  const make = (asked) => new NodePresence({ store: app.store, owner: app.runtime.owner, port, status: async () => { await asked.wait; return status(); },
    hello: () => hello("Desk PC"), offer: () => null, listenHost: () => "127.0.0.1" });

  const closing = gate();
  const closed = make(closing);
  const opening = closed.start();
  await closed.close();
  closing.release();
  await opening;
  assert.equal(closed.status().open, false);
  assert.equal(await probe("127.0.0.1", port), null, "closed while Tailscale answered: no door");

  const locking = gate();
  const locked = make(locking);
  t.after(() => locked.close());
  const started = locked.start();
  setLockdown(app.store, app.runtime.owner, { on: true });
  locking.release();
  await started;
  assert.equal(await probe("127.0.0.1", port), null, "Lockdown while Tailscale answered: no door");
  setLockdown(app.store, app.runtime.owner, { on: false });
  await sleep(100);
  assert.deepEqual(await probe("127.0.0.1", port), hello("Desk PC"), "Lockdown off: it opens again");
});

test("without network parts looking is refused in words, and nothing is shown as found", async (t) => {
  const { call } = await branch(t, null);
  const refused = await call("POST", "/api/devices/find", { on: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, findNowhereWords);
  assert.deepEqual((await call("GET", "/api/devices/find")).body, { looking: false, found: [], tailnet: null, network: null });
});

test("Lockdown: the list stays readable and empty; looking, offering and being found are refused", async (t) => {
  const lan = network();
  const { used, parts } = counted(lan, "192.168.1.10");
  const { app, call } = await branch(t, parts);
  assert.equal((await call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);
  const found = (await call("POST", "/api/devices/find", { on: true })).body.found;
  assert.equal(found.length, 1);
  assert.equal((await call("POST", "/api/devices/invite", {})).status, 200);
  setLockdown(app.store, app.runtime.owner, { on: true });
  const read = await call("GET", "/api/devices/find");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { looking: false, found: [], tailnet: null, network: null });
  for (const [path, body] of [["/api/devices/find", { on: true }], ["/api/devices/find/offer", { id: found[0].id }], ["/api/devices/join/find", {}]]) {
    const refused = await call("POST", path, body);
    assert.equal(refused.status, 409, path);
  }
  assert.equal((await call("POST", "/api/devices/find/offer", { id: found[0].id })).body.error, findLockdownWords);
  assert.equal(used.send, 0, "no offer went out");
  assert.equal(lan.open.size, 0);
  setLockdown(app.store, app.runtime.owner, { on: false });
});

test("a paired computer holds nothing that opens these routes", async (t) => {
  const lan = network();
  const bPort = await freePort();
  const b = await branch(t, { ...counted(lan, "192.168.1.20").parts, send: makeSendOffer(), port: bPort, addresses: () => ["127.0.0.1"] });
  const a = await branch(t, { ...counted(lan, "192.168.1.10").parts, status: async () => null,
    send: async (_address, port, body) => makeSendOffer()("127.0.0.1", port, body) });
  assert.equal((await b.call("POST", "/api/devices/join/find", {})).body.state, "finding");
  const found = (await a.call("POST", "/api/devices/find", { on: true })).body.found;
  assert.equal((await a.call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);
  const invite = (await a.call("POST", "/api/devices/invite", {})).body;
  assert.equal((await a.call("POST", "/api/devices/find/offer", { id: found[0].id })).status, 200);
  assert.equal((await b.call("POST", "/api/devices/join", { code: invite.code })).body.state, "waiting");
  let request;
  for (let i = 0; i < 50 && !request; i++) { request = a.app.devices.book.requests().find((r) => r.status === "waiting"); if (!request) await sleep(20); }
  assert.equal((await a.call("POST", `/api/devices/requests/${request.id}`, { approve: true, codeMatches: true })).status, 200);
  assert.equal(a.app.devices.book.devices().length, 1, "paired");
  const identity = JSON.parse(await readFile(join(b.root, "data", "node", "identity.json"), "utf8"));
  assert.ok(Object.keys(identity).length > 0, "the paired computer's saved identity");
  const keys = [null, ...Object.values(identity).filter((v) => typeof v === "string" && !/\s/.test(v)), b.server.token];
  for (const key of keys) {
    for (const [method, path, body] of [["GET", "/api/devices/find"], ["POST", "/api/devices/find", { on: true }],
      ["POST", "/api/devices/find/offer", { id: found[0].id }], ["POST", "/api/devices/join/find", {}]]) {
      // 401, or 429 once the wrong-key limiter has seen enough of them: refused either way.
      const refused = (await a.call(method, path, body, key)).status;
      assert.ok(refused === 401 || refused === 429, `${method} ${path} with ${key === null ? "no key" : "the paired computer's own"}: ${refused}`);
    }
  }
  await b.call("POST", "/api/devices/join/leave", {});
});

test("a loopback invitation is taken only from this computer itself", () => {
  const link = `http://127.0.0.1:3210/devices/pair?offer=${"ab".repeat(16)}`;
  assert.throws(() => readOffer({ link, name: "Desk" }, "100.100.1.9"), /Tailscale/);
  assert.throws(() => readOffer({ link, name: "Desk" }, "192.168.1.9"), /Tailscale/);
  assert.equal(readOffer({ link, name: "Desk" }, "127.0.0.1").link, link);
  assert.equal(readOffer({ link: `http://100.100.1.2:4000/devices/pair?offer=${"ab".repeat(16)}`, name: "Desk" }, "100.100.1.2").hub, "http://100.100.1.2:4000");
});

test("an advertiser stopped while its socket opens says nothing at all", async () => {
  const lan = network();
  const opening = gate();
  const advertiser = new MdnsAdvertiser(async () => { await opening.wait; return lan.socketAt("192.168.1.20")(); }, "Desk", 3216);
  const starting = advertiser.start();
  advertiser.stop();
  opening.release();
  await starting;
  assert.equal(advertiser.advertising, false);
  assert.equal(lan.open.size, 0);
  assert.equal(lan.sent.length, 0);
});

test("a name with control characters or direction overrides is not taken, from hello, an offer or the local network", async () => {
  const names = ["Desk\u001b[2J", "Desk\u0007", "Desk\u009b31m", "\u202eksed"];
  for (const name of names) {
    assert.equal(HelloSchema.safeParse({ branch: "hello", name, platform: "linux", version: "1" }).success, false, JSON.stringify(name));
    assert.throws(() => readOffer({ link: `http://100.100.1.2:4000/devices/pair?offer=${"ab".repeat(16)}`, name }, "100.100.1.2"), JSON.stringify(name));
    const lan = network();
    const browser = new MdnsBrowser(lan.socketAt("192.168.1.10"));
    const advertiser = new MdnsAdvertiser(lan.socketAt("192.168.1.20"), name, 3216);
    await advertiser.start();
    await browser.start();
    assert.deepEqual(browser.found(), [], JSON.stringify(name));
    advertiser.stop();
    browser.stop();
  }
  assert.equal(HelloSchema.safeParse(hello("Kitchen Mac")).success, true, "a plain name is still taken");
});
