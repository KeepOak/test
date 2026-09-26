/**
 * find-computers: Pair another computer finds the owner's other Branch computers by itself, on the tailnet and on the
 * local network, and finding grants nothing. Everything here runs on stand-ins: `tailscale status` is a string handed
 * in, the local network is an in-memory bus of fake sockets, and the only listeners are on 127.0.0.1. Nothing is ever
 * sent on this computer's real network or tailnet.
 *
 *   1. the tailnet: online peers from an injected `tailscale status --json`, each asked hello; only Branch is listed;
 *   2. the node door: hello answers on loopback/Tailscale only, binds one named address (never 0.0.0.0), takes offers
 *      only while waiting to be found;
 *   3. DNS-SD: the codec refuses malformed packets; browse and advertise over a fake socket; goodbye on stop;
 *   4. waiting to be found stops after pairing or after the time runs out, and Lockdown stops everything;
 *   5. the routes are the owner's: a short-lived key and a household person are refused;
 *   6. picking a found computer hands it the link only: its number is typed there, the request still waits, and the
 *      owner's yes still needs the check codes to match.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { householdRefusalFor } from "../dist/household-routes.js";
import { codeNotConfirmed } from "../dist/devices/api.js";
import { readPeers, peerLimit } from "../dist/remote/tailscale.js";
import { decodePacket, encodePacket, MdnsAdvertiser, MdnsBrowser, serviceType } from "../dist/devices/dns-sd.js";
import { NodeDoor, makeProbeHello, makeSendOffer, helloAnswersOn, assertDoorHost, offerPath } from "../dist/devices/hello.js";
import { Findable, readOffer } from "../dist/devices/findable.js";
import { findLockdownWords } from "../dist/devices/find.js";
import { NodePresence } from "../dist/devices/presence.js";
import { setLockdown } from "../dist/lockdown.js";
import { findAndPair } from "../dist/devices/node/find-cli.js";

const hello = (name = "Desk") => ({ branch: "hello", name, platform: "linux", version: "1.2.3" });
const offerId = "ab".repeat(16);

/** An in-memory local network: whatever one fake socket sends, every other open one hears, with the sender's address. */
function network() {
  const open = new Set();
  const sent = [];
  const socketAt = (address) => async () => {
    const listeners = [];
    const socket = {
      closed: false, address,
      send(data) { sent.push({ from: address, packet: decodePacket(data) }); for (const other of [...open]) if (other !== socket) for (const l of other.listeners) l(data, address); },
      onMessage(listener) { listeners.push(listener); },
      close() { socket.closed = true; open.delete(socket); },
      listeners,
    };
    open.add(socket);
    return socket;
  };
  return { socketAt, sent, open };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const status = (peers, backend = "Running") => JSON.stringify({ BackendState: backend, Self: { HostName: "here", TailscaleIPs: ["100.64.0.1"] }, Peer: peers });

test("the tailnet: only online peers with a Tailscale address are asked, and a large tailnet is capped", () => {
  const peers = {
    a: { HostName: "desk", OS: "linux", TailscaleIPs: ["100.100.1.2", "fd7a:115c:a1e0::2"], Online: true },
    b: { HostName: "asleep", OS: "windows", TailscaleIPs: ["100.100.1.3"], Online: false },
    c: { HostName: "odd", OS: "macOS", TailscaleIPs: ["192.168.1.9"], Online: true },
    d: { DNSName: "laptop.tail1234.ts.net.", OS: "macOS", TailscaleIPs: ["100.100.1.4"], Online: true },
  };
  assert.deepEqual(readPeers(status(peers)), [
    { hostName: "desk", os: "linux", address: "100.100.1.2" },
    { hostName: "laptop", os: "macOS", address: "100.100.1.4" },
  ]);
  assert.deepEqual(readPeers(status(peers, "NeedsLogin")), [], "signed out lists nobody");
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, { HostName: `p${i}`, TailscaleIPs: [`100.100.2.${i + 1}`], Online: true }]));
  assert.equal(readPeers(status(many)).length, peerLimit);
});

test("the node door: hello on loopback only, one named address, offers only while waiting, small bodies", async (t) => {
  assert.throws(() => assertDoorHost("0.0.0.0"), /never every address/);
  assert.throws(() => assertDoorHost("8.8.8.8"), /never every address/);
  assert.equal(helloAnswersOn("127.0.0.1"), true);
  assert.equal(helloAnswersOn("100.100.1.2"), true);
  assert.equal(helloAnswersOn("192.168.1.20"), false, "hello never answers on the local network");
  let taking = null;
  const door = new NodeDoor({ hello: () => hello(), offer: () => taking });
  t.after(() => door.close());
  const port = await door.open("127.0.0.1", 0);
  const probe = makeProbeHello();
  assert.deepEqual(await probe("127.0.0.1", port), hello());
  const post = (body) => fetch(`http://127.0.0.1:${port}${offerPath}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await post("{}")).status, 404, "no offers while not waiting");
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/devices`)).status, 404, "nothing else answers");
  taking = (body) => ({ got: body.name });
  assert.deepEqual(await (await post(JSON.stringify({ link: "x".repeat(20), name: "A" }))).json(), { got: "A" });
  assert.equal((await post(JSON.stringify({ link: "x".repeat(5000), name: "A" })).catch(() => ({ status: 409 }))).status, 409, "a large body is refused");
});

test("hello from something that is not Branch lists nothing", async (t) => {
  const answers = [JSON.stringify({ branch: "hello", name: "x", platform: "linux", version: "1", extra: 1 }), "not json", "x".repeat(10000)];
  const server = createHttpServer((_request, response) => { response.end(answers.shift()); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const probe = makeProbeHello();
  for (let i = 0; i < 3; i++) assert.equal(await probe("127.0.0.1", server.address().port), null);
  assert.equal(await probe("127.0.0.1", await freePort()), null, "nobody listening is nothing, quickly");
});

test("DNS-SD: a packet round-trips, and malformed or hostile packets are refused", () => {
  const records = [{ type: "PTR", name: serviceType, ttl: 120, target: `branch-1.${serviceType}` },
    { type: "SRV", name: `branch-1.${serviceType}`, ttl: 120, port: 3216, target: "branch-2.local" },
    { type: "TXT", name: `branch-1.${serviceType}`, ttl: 120, text: ["name=Desk"] }];
  const back = decodePacket(encodePacket({ response: true, questions: [], records }));
  assert.deepEqual(back, { response: true, questions: [], records });
  const header = (qd, an) => Buffer.from([0, 0, 0x84, 0, 0, qd, 0, an, 0, 0, 0, 0]);
  const hostile = [
    Buffer.concat([header(1, 0), Buffer.from([0xc0, 12, 0, 12, 0, 1])]), // a name pointing at itself
    Buffer.concat([header(1, 0), Buffer.from([0xc0, 40, 0, 12, 0, 1])]), // a pointer forwards
    Buffer.concat([header(1, 0), Buffer.from([64]), Buffer.alloc(64, 97), Buffer.from([0, 0, 12, 0, 1])]), // a 64-byte label
    Buffer.concat([header(0, 1), encodePacket({ response: true, questions: [], records: records.slice(0, 1) }).subarray(12, 30)]), // cut short
    Buffer.concat([header(0, 200)]), // too many entries
    Buffer.alloc(10000), // too big
  ];
  for (const packet of hostile) assert.throws(() => decodePacket(packet));
});

test("DNS-SD over a fake socket: the browser finds a computer waiting to pair; a goodbye takes it off; outsiders are ignored", async () => {
  const lan = network();
  const browser = new MdnsBrowser(lan.socketAt("192.168.1.10"));
  const advertiser = new MdnsAdvertiser(lan.socketAt("192.168.1.20"), "Kitchen Mac", 3216);
  await advertiser.start();
  await browser.start();
  assert.deepEqual(browser.found().map(({ name, address, port }) => ({ name, address, port })), [{ name: "Kitchen Mac", address: "192.168.1.20", port: 3216 }]);
  const said = lan.sent.filter((s) => s.from === "192.168.1.20").flatMap((s) => s.packet.records);
  assert.deepEqual([...new Set(said.map((r) => r.type))].sort(), ["PTR", "SRV", "TXT"], "only a name, a port and the service");
  assert.deepEqual(said.find((r) => r.type === "TXT").text, ["name=Kitchen Mac"]);
  advertiser.stop();
  assert.ok(lan.sent.at(-1).packet.records.every((r) => r.ttl === 0), "the last word is a goodbye");
  assert.deepEqual(browser.found(), []);
  const stranger = new MdnsAdvertiser(lan.socketAt("8.8.8.8"), "Stranger", 3216);
  await stranger.start();
  assert.deepEqual(browser.found(), [], "an answer from outside the private ranges is not listed");
  stranger.stop();
  browser.stop();
  assert.equal(lan.open.size, 0, "every socket closed");
});

test("waiting to be found: one offer held, only a Tailscale or loopback link, and it stops after the number is typed", async (t) => {
  const lan = network();
  const findable = new Findable({ hello: () => hello("Kitchen Mac"), name: "Kitchen Mac", port: 0, openMdns: lan.socketAt("192.168.1.20"), addresses: () => [] });
  t.after(() => findable.stop());
  assert.throws(() => findable.take({ link: "x", name: "A" }, "127.0.0.1"), /not waiting/);
  assert.deepEqual(await findable.start(), []);
  assert.equal(findable.advertising, true);
  for (const link of [`https://example.org/devices/pair?offer=${offerId}`, `http://192.168.1.5:3210/devices/pair?offer=${offerId}`])
    assert.throws(() => readOffer({ link, name: "A" }, "192.168.1.5"), /Tailscale/);
  const link = `http://100.100.1.2:4000/devices/pair?offer=${offerId}`;
  assert.deepEqual(findable.take({ link, name: "Desk" }, "100.100.1.2"), { held: true });
  assert.throws(() => findable.take({ link, name: "Rogue" }, "100.100.1.9"), /already has an invitation/);
  assert.equal(findable.offer().hub, "http://100.100.1.2:4000");
  const used = await findable.use();
  assert.equal(used.link, link);
  assert.equal(findable.waiting, false);
  assert.equal(findable.advertising, false);
  assert.ok(lan.sent.at(-1).packet.records.every((r) => r.ttl === 0), "goodbye once the number is typed");
});

test("waiting to be found stops by itself when the time runs out", async () => {
  const lan = network();
  let ended = null;
  const findable = new Findable({ hello: () => hello(), name: "Desk", port: 0, openMdns: lan.socketAt("192.168.1.20"), addresses: () => [],
    timeoutMs: 60, onEnd: (why) => { ended = why; } });
  await findable.start();
  await sleep(200);
  assert.equal(ended, "timeout");
  assert.equal(findable.waiting, false);
  assert.equal(lan.open.size, 0);
  assert.ok(lan.sent.at(-1).packet.records.every((r) => r.ttl === 0));
});

test("branch node pair with no link: waits, shows the offer, and gives up with a goodbye when nobody picks it", async () => {
  const lan = network();
  const lines = [];
  const dir = await mkdtemp(join(tmpdir(), "branch-find-cli-"));
  try {
    const answer = await findAndPair({ dir, platform: "linux", env: {}, offers: [], name: "Desk", print: (line) => lines.push(line),
      parts: { status: async () => null, openMdns: lan.socketAt("192.168.1.20"), addresses: () => [], port: 0, timeoutMs: 80, readLine: async () => "000000" } });
    assert.equal(answer, null);
    assert.match(lines.join("\n"), /Nobody picked this computer in time/);
    assert.equal(lan.open.size, 0);
  } finally { await discardTemp(dir); }
});

/** A Branch in this process with stand-in network parts; `lan` is the fake local network, `peers` the fake tailnet. */
async function branch(t, parts = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-find-computers-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, findComputers: {
    status: async () => null, probe: async () => null, send: makeSendOffer(), port: 0, version: "1.2.3", addresses: () => [], ...parts } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call };
}

test("Found nearby lists Branch peers from the tailnet and computers waiting on the local network, with opaque ids", async (t) => {
  const lan = network();
  const asked = [];
  const peers = { a: { HostName: "desk", TailscaleIPs: ["100.100.1.2"], Online: true }, b: { HostName: "nas", TailscaleIPs: ["100.100.1.3"], Online: true } };
  const { call } = await branch(t, { status: async () => status(peers), openMdns: lan.socketAt("192.168.1.10"),
    probe: async (address, port) => { asked.push(`${address}:${port}`); return address === "100.100.1.2" ? hello("Desk PC") : null; } });
  const waiting = new MdnsAdvertiser(lan.socketAt("192.168.1.20"), "Kitchen Mac", 3216);
  await waiting.start();
  t.after(() => waiting.stop());
  const started = await call("POST", "/api/devices/find", { on: true });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const found = started.body.found;
  assert.deepEqual(found.map(({ name, platform, version, via }) => ({ name, platform, version, via })), [
    { name: "Desk PC", platform: "linux", version: "1.2.3", via: "tailnet" },
    { name: "Kitchen Mac", platform: null, version: null, via: "network" },
  ]);
  assert.ok(found.every((f) => /^[a-f0-9]{16}$/.test(f.id) && !("address" in f) && !("port" in f)), "the window never sees an address");
  assert.deepEqual(asked, ["100.100.1.2:0", "100.100.1.3:0"]);
  const stopped = await call("POST", "/api/devices/find", { on: false });
  assert.deepEqual(stopped.body, { looking: false, found: [], tailnet: null, network: null });
  assert.equal([...lan.open].filter((s) => s.address === "192.168.1.10").length, 0, "stopped looking: the socket is closed");
});

test("Lockdown refuses looking, stops looking already going, and closes the node door", async (t) => {
  const lan = network();
  const { app, call } = await branch(t, { openMdns: lan.socketAt("192.168.1.10") });
  assert.equal((await call("POST", "/api/devices/find", { on: true })).body.looking, true);
  setLockdown(app.store, app.runtime.owner, { on: true });
  assert.equal([...lan.open].length, 0, "Lockdown closed the local-network socket");
  assert.equal((await call("GET", "/api/devices/find")).body.looking, false);
  const refused = await call("POST", "/api/devices/find", { on: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, findLockdownWords);
  const join = await call("POST", "/api/devices/join/find", {});
  assert.equal(join.status, 409, "and being found is refused too");
  setLockdown(app.store, app.runtime.owner, { on: false });
});

test("the node door on the tailnet: open while Branch runs, closed by Lockdown, open again after", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-find-presence-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: { name: "s", async complete() { return { content: "", toolCalls: [] }; } } });
  const port = await freePort();
  const presence = new NodePresence({ store: app.store, owner: app.runtime.owner, port, status: async () => status({}),
    hello: () => hello("Desk PC"), offer: () => null, listenHost: () => "127.0.0.1" });
  t.after(async () => { await presence.close(); await app.close(); await discardTemp(root); });
  await presence.start();
  assert.deepEqual(presence.status(), { open: true, address: "100.64.0.1", message: null });
  const probe = makeProbeHello();
  assert.deepEqual(await probe("127.0.0.1", port), hello("Desk PC"));
  setLockdown(app.store, app.runtime.owner, { on: true });
  await sleep(50);
  assert.equal(await probe("127.0.0.1", port), null, "Lockdown closed the door");
  setLockdown(app.store, app.runtime.owner, { on: false });
  await sleep(100);
  assert.deepEqual(await probe("127.0.0.1", port), hello("Desk PC"));
  const signedOut = new NodePresence({ store: app.store, owner: app.runtime.owner, port, status: async () => null, hello: () => hello(), offer: () => null });
  await signedOut.start();
  assert.equal(signedOut.status().open, false, "no Tailscale address, no door");
});

test("finding is the owner's: a short-lived key and a household person are refused", async (t) => {
  const { app, call } = await branch(t);
  const routes = [["GET", "/api/devices/find"], ["POST", "/api/devices/find", { on: true }], ["POST", "/api/devices/find/offer", { id: "a".repeat(16) }],
    ["POST", "/api/devices/join/find", {}]];
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: `find-${scope}`, scope, minutes: 5 }).token;
    for (const [method, path, body] of routes) {
      const answer = await call(method, path, body, key);
      assert.equal(answer.status, 401, `${scope} key: ${method} ${path}`);
    }
  }
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  for (const [method, path, body] of routes) {
    const answer = await call(method, path, body);
    assert.equal(answer.status, 400, `household: ${method} ${path}`);
    assert.equal(answer.body.error, householdRefusalFor(path));
  }
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
});

test("picking a found computer hands it only the link; its number is typed there, and the owner's yes still needs the check codes", async (t) => {
  const lan = network();
  // B: the other computer, waiting to be found (its node door on loopback, advertising on the fake network).
  const bPort = await freePort();
  const b = await branch(t, { openMdns: lan.socketAt("192.168.1.20"), port: bPort, addresses: () => ["127.0.0.1"] });
  // A: the owner's computer, looking.
  const offers = [];
  const send = makeSendOffer();
  const a = await branch(t, { openMdns: lan.socketAt("192.168.1.10"), send: async (address, port, body) => {
    // The fake network says B is 192.168.1.20; its door really listens on loopback, so that is where it goes.
    assert.equal(address, "192.168.1.20");
    offers.push(body);
    return send("127.0.0.1", port, body);
  } });
  assert.equal((await b.call("POST", "/api/devices/join/find", {})).body.state, "finding");
  const found = (await a.call("POST", "/api/devices/find", { on: true })).body.found;
  assert.equal(found.length, 1);
  const noInvite = await a.call("POST", "/api/devices/find/offer", { id: found[0].id });
  assert.equal(noInvite.status, 409, "nothing to hand over without an invitation");
  assert.equal((await a.call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);
  const invite = (await a.call("POST", "/api/devices/invite", {})).body;
  const offered = await a.call("POST", "/api/devices/find/offer", { id: found[0].id });
  assert.equal(offered.status, 200, JSON.stringify(offered.body));
  assert.deepEqual(Object.keys(offers[0]).sort(), ["link", "name"], "only the link and a name went over");
  assert.ok(offers[0].link.includes(invite.id) && !JSON.stringify(offers[0]).includes(invite.code), "never the number");
  const waiting = (await b.call("GET", "/api/devices/join")).body;
  assert.equal(waiting.state, "finding");
  assert.equal(waiting.offer.hub, new URL(a.server.url).origin);
  assert.equal(a.app.devices.book.requests().length, 0, "an offer alone asks for nothing");
  // A wrong number there makes no request; the right one makes a request that still waits.
  const joined = await b.call("POST", "/api/devices/join", { code: invite.code });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.state, "waiting");
  assert.equal([...lan.open].some((s) => s.address === "192.168.1.20"), false, "B stopped advertising once its number was typed");
  let request;
  for (let i = 0; i < 50 && !request; i++) { request = a.app.devices.book.requests().find((r) => r.status === "waiting"); if (!request) await sleep(20); }
  assert.ok(request, "a request waits on the owner's computer");
  assert.equal(a.app.devices.book.devices().length, 0, "nobody let in yet");
  const noCheck = await a.call("POST", `/api/devices/requests/${request.id}`, { approve: true });
  assert.equal(noCheck.status, 400);
  assert.equal(noCheck.body.error, codeNotConfirmed);
  assert.equal(a.app.devices.book.devices().length, 0, "still nobody let in without the check code");
  await b.call("POST", "/api/devices/join/leave", {});
});
