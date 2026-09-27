/**
 * A paired phone holds a key of its own, never the window's (src/remote/gateway-auth.ts, src/remote/window-key.ts).
 *
 *   1. no pairing answer (Pair a phone, the Tailscale invitation, collecting again) carries the window's key; removing
 *      a phone makes its own key refused on every route, on this computer's listener and on the paired door;
 *   2. a phone that still belongs keeps working;
 *   3. the owner's window keeps working without typing the key again: removing a phone leaves the window's key alone,
 *      and removing a phone paired before phones had keys (which holds the window's key) replaces it, handing the new
 *      key to the browser window that asks and to the desktop app through the data folder;
 *   4. neither key is handed over as plain HTTP from beyond this computer that is not Tailscale;
 *   5. a phone may switch Lockdown on and never off, whichever way it asks;
 *   6. a phone makes nothing that outlasts its removal (a short-lived key, a phone invitation), never widens where
 *      Branch listens or switches the phone door, and is never handed the window's key, even arriving from this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { pairingRefused, phoneSessionText } from "../dist/devices/book.js";
import { phoneInviteHereOnly } from "../dist/devices/api.js";
import { windowKeyReader } from "../dist/desktop/signed-headers.js";
import { hereOnly, keyMayTravel, lockdownOffHereOnly } from "../dist/remote/window-key.js";
import { ROUTES, SAMPLE_ID, entry } from "./short-lived-key-routes.mjs";

function phoneKey() {
  const pair = generateKeyPairSync("ed25519");
  return { publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (text) => sign(null, Buffer.from(text), pair.privateKey).toString("base64") };
}

/** An engine on loopback, plus its paired door on a spare loopback port (as tests/phone-pairing.test.mjs does). */
async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-key-rotate-"));
  const dataDir = join(root, "data");
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  // Hundreds of refused keys from one place in a row; the wait they would earn is tested elsewhere.
  const server = await startServer(app, { dataDir, port: 0, authLimits: { attempts: 1_000_000 } });
  const host = new URL(server.url).host;
  const door = createServer((request, response) => { request.headers.host = host; server.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  t.after(async () => {
    door.closeAllConnections?.();
    await new Promise((done) => door.close(done));
    await server.close(); await app.close(); await discardTemp(root);
  });
  const doorBase = `http://127.0.0.1:${door.address().port}`;
  const call = (method, path, body, key = server.token, base = server.url, extra = {}) => fetch(base + path, {
    method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(method === "GET" ? {} : { "content-type": "application/json" }), ...extra },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => { const text = await response.text(); let body = {}; try { body = JSON.parse(text); } catch { /* not JSON */ } return { status: response.status, body, text }; });
  assert.equal((await call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);
  return { app, server, call, doorBase, dataDir };
}

/** A phone paired from the window's "Pair a phone" code, let in, holding its session. */
async function pairedPhone(call, name, extra = {}) {
  const invite = (await call("POST", "/api/devices/invite", { phone: true })).body;
  const key = phoneKey();
  const { requestId } = (await call("POST", "/api/devices/pair",
    { offer: invite.id, code: invite.code, name, platform: "android", publicKey: key.publicKey, offers: [] }, null)).body;
  const deviceId = (await call("POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true })).body.request.deviceId;
  const collected = await call("POST", "/api/devices/pair/session", { requestId, signature: key.sign(phoneSessionText(requestId)) }, null, undefined, extra);
  return { deviceId, requestId, key, collected, session: collected.body,
    headers: { "x-branch-device": collected.body.deviceId, "x-branch-device-key": collected.body.deviceKey } };
}

/** Makes a phone look paired before phones had keys of their own: it holds the window's key, and its record has no key. */
function asBefore(app, server, phone) {
  const saved = app.store.get("settings", app.runtime.owner, "remote-devices").data;
  app.store.save("settings", app.runtime.owner, "remote-devices",
    { devices: saved.devices.map(({ keyFingerprint, ...each }) => (each.id === phone.session.deviceId ? each : { ...each, keyFingerprint })) });
  phone.session.token = server.token;
}

/** Every address in the route table a key is asked for, made concrete, with the method that reaches it. */
function keyedRoutes() {
  return Object.entries(ROUTES).map(([path, value]) => ({ path, ...entry(value) }))
    .filter(({ kind, path }) => kind !== "prefix" && kind !== "pre-auth" && !/[[\]{}()\\|?*+^$]/.test(path))
    .map(({ path, methods }) => ({ path: path.replaceAll(":id", SAMPLE_ID), method: methods[0] ?? "GET" }));
}
async function refusedEverywhere(call, key, headers, bases) {
  const letThrough = [];
  for (const { path, method } of keyedRoutes())
    for (const base of bases) {
      const answer = await call(method, path, method === "GET" ? undefined : {}, key, base, headers);
      if (answer.status !== 401) letThrough.push(`${method} ${path} on ${base}: ${answer.status}`);
    }
  return letThrough;
}

test("no pairing answer carries the window's key, and a removed phone's own key is refused on every route", async (t) => {
  const { server, call, doorBase } = await served(t);
  const window = server.token;
  const removed = await pairedPhone(call, "Removed phone");
  assert.equal(removed.collected.status, 200);
  const offer = server.remote.pairing.create();
  const tailscale = await call("POST", "/api/pair", { id: offer.id, code: offer.code, name: "Tailscale phone" }, null, doorBase);
  assert.equal(tailscale.status, 200, tailscale.text);
  const renewed = await call("POST", "/api/pair/renew", {}, null, doorBase, removed.headers);
  assert.equal(renewed.status, 200, renewed.text);
  for (const [why, answer] of [["Pair a phone", removed.collected], ["the Tailscale invitation", tailscale], ["collecting again", renewed]]) {
    assert.equal(answer.text.includes(window), false, `${why} never carries the window's key`);
    assert.match(answer.body.token, /^[a-f0-9]{64}$/, why);
  }
  const own = renewed.body.token;
  assert.equal((await call("GET", "/api/state", undefined, own, doorBase, removed.headers)).status, 200, "the phone's own key works");
  assert.equal((await call("GET", "/api/state", undefined, removed.session.token)).status, 401, "collecting again replaced the one before");
  assert.equal((await call("POST", `/api/devices/${removed.deviceId}/revoke`, {})).status, 200);
  const routes = keyedRoutes();
  assert.ok(routes.length > 300, `every route: ${routes.length}`);
  assert.deepEqual(await refusedEverywhere(call, own, removed.headers, [server.url, doorBase]), [], "the removed phone's key opens nothing");
  assert.equal(server.token, window, "the window's key was never handed over, so it stays");
  assert.equal((await call("GET", "/api/state")).status, 200);
});

test("a phone that still belongs keeps working when another is removed", async (t) => {
  const { call, doorBase, server } = await served(t);
  const staying = await pairedPhone(call, "Staying phone");
  const removed = await pairedPhone(call, "Removed phone");
  assert.equal((await call("POST", `/api/devices/${removed.deviceId}/revoke`, {})).status, 200);
  assert.equal((await call("GET", "/api/state", undefined, staying.session.token, doorBase, staying.headers)).status, 200, "on its paired door");
  assert.equal((await call("GET", "/api/state", undefined, staying.session.token)).status, 200, "on this computer's listener");
  assert.equal((await call("GET", "/api/state", undefined, removed.session.token, doorBase, removed.headers)).status, 401);
  for (const [why, headers] of [["the removed phone", removed.headers], ["no secret", {}],
    ["a wrong secret", { ...staying.headers, "x-branch-device-key": "0".repeat(48) }]]) {
    const refused = await call("POST", "/api/pair/renew", {}, null, doorBase, headers);
    assert.equal(refused.status, 401, `${why}: ${refused.status}`);
    assert.equal(refused.body.token, undefined, why);
  }
  const plain = await call("POST", "/api/pair/renew", {}, null, undefined, { ...staying.headers, "x-branch-tunnel": "1" });
  assert.equal(plain.status, 401, "never as plain HTTP from beyond this computer");
  assert.notEqual(staying.session.token, server.token);
});

test("the owner's window keeps working, also when a phone paired before phones had keys is removed", async (t) => {
  const { app, server, call, doorBase, dataDir } = await served(t);
  const first = server.token;
  const desktop = windowKeyReader(dataDir, first);
  const phone = await pairedPhone(call, "Phone with its own key");
  const plain = await call("POST", `/api/devices/${phone.deviceId}/revoke`, { keepKey: true });
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.body.key, undefined, "nothing to hand over: the window's key never left");
  assert.equal(server.token, first);

  const before = await pairedPhone(call, "Phone paired before");
  const staying = await pairedPhone(call, "Staying phone paired before");
  asBefore(app, server, before);
  asBefore(app, server, staying);
  const answer = await call("POST", `/api/devices/${before.deviceId}/revoke`, { keepKey: true });
  assert.equal(answer.status, 200, answer.text);
  assert.notEqual(server.token, first, "the window's key it held was replaced");
  assert.equal(answer.body.key, server.token, "the browser window that asked is handed the new key");
  assert.equal((await call("GET", "/api/state", undefined, answer.body.key)).status, 200);
  assert.deepEqual(await refusedEverywhere(call, first, before.headers, [server.url, doorBase]), [], "the old window key opens nothing");
  assert.equal((await readFile(join(dataDir, "session-token"), "utf8")).trim(), server.token, "saved where the first one was");
  assert.equal((await readdir(dataDir)).some((name) => name.includes("session-token.")), false, "no half-written copy is left");
  assert.equal(desktop(), server.token, "the desktop app reads the new key again");
  assert.equal((await call("GET", "/api/state", undefined, desktop())).status, 200);

  // The phone paired before that still belongs moves to a key of its own; the removed one cannot.
  const moved = await call("POST", "/api/pair/renew", {}, null, doorBase, staying.headers);
  assert.equal(moved.status, 200, moved.text);
  assert.notEqual(moved.body.token, server.token);
  assert.equal((await call("GET", "/api/state", undefined, moved.body.token, doorBase, staying.headers)).status, 200);
  assert.equal((await call("POST", "/api/pair/renew", {}, null, doorBase, before.headers)).status, 401);

  const unasked = await pairedPhone(call, "Unasked");
  asBefore(app, server, unasked);
  const quiet = await call("POST", `/api/devices/${unasked.deviceId}/revoke`, {});
  assert.equal(quiet.body.key, undefined, "a window that did not ask (the desktop app holds none) is not handed it");
  assert.equal(desktop(), server.token);
  const third = await pairedPhone(call, "Third");
  asBefore(app, server, third);
  const fromDoor = await call("POST", `/api/devices/${third.deviceId}/revoke`, { keepKey: true }, moved.body.token, doorBase, staying.headers);
  assert.equal(fromDoor.status, 200, fromDoor.text);
  assert.equal(fromDoor.body.key, undefined, "only this computer's own window is handed the key in the answer");
});

test("a phone's session is never collected as plain HTTP from beyond this computer", async (t) => {
  const { call, server } = await served(t);
  const lan = await pairedPhone(call, "Phone on the home network", { "x-branch-tunnel": "1" });
  assert.equal(lan.collected.status, 403, lan.collected.text);
  assert.equal(lan.collected.body.error, pairingRefused);
  assert.equal(lan.collected.body.token, undefined);
  const again = await call("POST", "/api/devices/pair/session", { requestId: lan.requestId, signature: lan.key.sign(phoneSessionText(lan.requestId)) }, null);
  assert.equal(again.status, 200, "the same phone on this computer's own address still can");
  assert.notEqual(again.body.token, server.token);

  const socket = (localAddress, remoteAddress) => ({ socket: { localAddress, remoteAddress }, headers: {} });
  assert.equal(keyMayTravel(socket("192.168.1.20", "192.168.1.30"), false), false, "a home network");
  assert.equal(keyMayTravel(socket("::ffff:10.0.0.2", "::ffff:10.0.0.9"), false), false);
  assert.equal(keyMayTravel(socket("192.168.1.20", "100.100.1.2"), false), false, "a Tailscale-looking caller at a home address");
  assert.equal(keyMayTravel(socket("100.100.1.1", "100.100.1.2"), false), true, "Tailscale to this computer's Tailscale address");
  assert.equal(keyMayTravel(socket("::ffff:100.100.1.1", "::ffff:100.100.1.2"), false), true);
  assert.equal(keyMayTravel(socket("127.0.0.1", "127.0.0.1"), false), true, "this computer");
  assert.equal(keyMayTravel({ socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" }, headers: { "x-branch-tunnel": "1" } }, false), false, "the webhook door");
  assert.equal(keyMayTravel(socket("192.168.1.20", "192.168.1.30"), true), true, "the paired door");
});

test("a phone may switch Lockdown on and never off, through its door or with its own key", async (t) => {
  const { call, doorBase } = await served(t);
  const phone = await pairedPhone(call, "Phone");
  const own = phone.session.token;
  const on = await call("POST", "/api/lockdown", { on: true }, own, doorBase, phone.headers);
  assert.equal(on.status, 200, `on from the door: ${on.text}`);
  for (const [why, base] of [["through the paired door", doorBase], ["with its own key on this computer's listener", undefined]]) {
    const off = await call("POST", "/api/lockdown", { on: false }, own, base, phone.headers);
    assert.equal(off.status, 403, `${why}: ${off.text}`);
    assert.equal(off.body.error, lockdownOffHereOnly, why);
  }
  const elsewhere = await call("POST", "/api/lockdown", { on: false }, undefined, undefined, { "x-branch-tunnel": "1" });
  assert.equal(elsewhere.status, 403, `the window's key from beyond this computer: ${elsewhere.text}`);
  assert.equal((await call("GET", "/api/lockdown")).body.on, true, "still on");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200, "the window on this computer switches it off");
  assert.equal((await call("POST", "/api/commands/settings", { mode: "on" })).status, 200);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const command = await call("POST", "/api/commands/run", { surface: "phone", line: "/lockdown off" }, own, doorBase, phone.headers);
  assert.equal((await call("GET", "/api/lockdown")).body.on, true, `a /lockdown off command from the phone changes nothing: ${command.text}`);
});

test("a phone makes nothing that outlasts its removal, and is never handed the window's key", async (t) => {
  const { app, server, call, doorBase } = await served(t);
  const phone = await pairedPhone(call, "Phone");
  const own = phone.session.token;
  const asks = [["POST", "/api/tokens", { scope: "run", minutes: 60 }], ["POST", "/api/deployment/remote/invite", {}],
    ["POST", "/api/listen", { where: "private-network" }], ["POST", "/api/deployment/remote", { enabled: false }]];
  for (const [why, base, headers] of [["through the paired door", doorBase, phone.headers], ["with its own key on this computer's listener", undefined, phone.headers],
    ["the window's key from beyond this computer", undefined, { "x-branch-tunnel": "1" }]])
    for (const [method, path, body] of asks) {
      const answer = await call(method, path, body, why.startsWith("the window") ? server.token : own, base, headers);
      assert.equal(answer.status, 403, `${method} ${path} ${why}: ${answer.status} ${answer.text}`);
      assert.equal(answer.body.token, undefined);
      if (path !== "/api/deployment/remote") assert.equal(answer.body.error, hereOnly, `${path} ${why}`);
    }
  const invite = await call("POST", "/api/devices/invite", { phone: true }, own, undefined, phone.headers);
  assert.equal(invite.status, 403, `a phone invitation with its own key from this computer: ${invite.text}`);
  assert.equal(invite.body.error, phoneInviteHereOnly);
  assert.equal((await call("GET", "/api/tokens")).body.tokens.length, 0, "no key was made");
  assert.equal((await call("POST", "/api/tokens", { scope: "run", minutes: 5 })).status, 200, "the window on this computer still makes keys");

  const window = server.token;
  const before = await pairedPhone(call, "Phone paired before");
  asBefore(app, server, before);
  const revoked = await call("POST", `/api/devices/${before.deviceId}/revoke`, { keepKey: true }, own);
  assert.equal(revoked.status, 200, revoked.text);
  assert.notEqual(server.token, window, "the window's key was replaced");
  assert.equal(revoked.body.key, undefined, "a phone's own key is never handed the new window key, even from this computer");
  assert.equal(revoked.text.includes(server.token), false);
});

test("the phone app calls no native look neither platform has, and a failed switch save says why", async () => {
  const web = new URL("../apps/mobile/web/", import.meta.url);
  for (const name of await readdir(web)) {
    if (!name.endsWith(".js")) continue;
    assert.equal((await readFile(new URL(name, web), "utf8")).includes("setLook"), false, `${name} calls no setLook`);
  }
  const switches = await readFile(new URL("ph-switches.js", web), "utf8");
  assert.match(switches, /\.catch\(async \(error\) => \{\s*(\/\/[^\n]*\n\s*)*toast\(String\(error\?\.message \?\? error\)\);/, "the engine's words are shown");
});

test("a phone that holds the window's key is removed only once a new key is saved", async (t) => {
  const { app, server, call, dataDir } = await served(t);
  const window = server.token;
  const phone = await pairedPhone(call, "Phone paired before");
  asBefore(app, server, phone);
  // The new key cannot be saved: the file's place is taken by a folder.
  await rm(join(dataDir, "session-token"));
  await mkdir(join(dataDir, "session-token"));
  const failed = await call("POST", `/api/devices/${phone.deviceId}/revoke`, { keepKey: true });
  assert.notEqual(failed.status, 200, failed.text);
  assert.equal(server.token, window, "the old key stays in use while no new one is saved");
  assert.ok((await call("GET", "/api/devices")).body.devices.some((each) => each.id === phone.deviceId), "the phone is still listed");
  await rm(join(dataDir, "session-token"), { recursive: true });
  await writeFile(join(dataDir, "session-token"), window);
  const again = await call("POST", `/api/devices/${phone.deviceId}/revoke`, { keepKey: true });
  assert.equal(again.status, 200, again.text);
  assert.notEqual(server.token, window, "removing it again replaces the key");
  assert.equal(again.body.key, server.token);
  assert.equal((await call("GET", "/api/state", undefined, window)).status, 401);
});

test("a phone paired before phones had keys still takes the window's key with it after moving to its own", async (t) => {
  const { app, server, call, doorBase } = await served(t);
  const window = server.token;
  const phone = await pairedPhone(call, "Phone paired before");
  asBefore(app, server, phone);
  const moved = await call("POST", "/api/pair/renew", {}, null, doorBase, phone.headers);
  assert.equal(moved.status, 200, moved.text);
  assert.equal(server.token, window, "moving to a key of its own changes nothing else");
  const removed = await call("POST", `/api/devices/${phone.deviceId}/revoke`, {});
  assert.equal(removed.status, 200, removed.text);
  assert.notEqual(server.token, window, "the window's key it was handed once is replaced");
  assert.equal((await call("GET", "/api/state", undefined, window)).status, 401);
  assert.equal((await call("GET", "/api/state", undefined, moved.body.token, doorBase, phone.headers)).status, 401);
});

test("the phone app collects a key of its own when the one it holds is refused", async () => {
  const read = (path) => readFile(new URL(`../apps/mobile/${path}`, import.meta.url), "utf8");
  const java = "android/app/src/main/java/com/keepoak/branchagent/";
  const client = await read(`${java}BranchClient.java`);
  const renew = client.slice(client.indexOf("private static synchronized JSONObject renew("), client.indexOf("/** The pairing request"));
  assert.ok(renew.length > 0, "one renewal at a time on Android");
  assert.match(renew, /"\/api\/pair\/renew"/);
  assert.match(renew, /x-branch-device-key/);
  assert.equal(renew.includes("Authorization"), false, "renewing sends the phone's own secret, never a key");
  assert.match(renew, /vault\.save\(next\)/, "the new key is kept");
  assert.match(client, /if \(answer\.status != 401 \|\| !session\.has\("deviceId"\) \|\| !session\.has\("deviceKey"\)\) return answer;/);
  for (const file of ["BranchPhonePlugin.java", "BranchNotify.java"]) {
    const text = await read(`${java}${file}`);
    assert.match(text, /BranchClient\.sendKept\(vault, session,/, file);
    assert.equal(text.includes("BranchClient.send("), false, `${file} asks through the renewing call only`);
  }
  const swift = await read("ios/App/App/BranchShared.swift");
  const collect = swift.slice(swift.indexOf("static func collectKey("), swift.indexOf("private static func sendOnce("));
  assert.match(collect, /"\/api\/pair\/renew"/);
  assert.equal(collect.includes("Authorization"), false, "renewing sends the phone's own secret, never a key");
  assert.match(collect, /try BranchKeychain\.save\(next\)/, "the new key is kept");
  assert.match(swift, /guard answer\.status == 401, session\.deviceId != nil, session\.deviceKey != nil,\s+let renewed = await BranchRenewal\.shared\.renew\(refused: session\)/);
  assert.match(swift, /actor BranchRenewal \{[\s\S]*if let running \{ return await running\.value \}/, "one renewal at a time on iOS");
});

test("a phone makes no webhook, trigger, chat app setup or person's sign-in code; the window on this computer still does", async (t) => {
  const { server, call, doorBase } = await served(t);
  const phone = await pairedPhone(call, "Phone");
  const own = phone.session.token;
  const someone = "00000000-0000-4000-8000-000000000001";
  const asks = [["/api/webhooks", {}], ["/api/triggers", {}], [`/api/triggers/${someone}/rotate-secret`, {}], ["/api/channel-setup", { mode: "on" }],
    ["/api/channel-setup/telegram", {}], ["/api/channels/pairings/approve", { code: "ABCDEF" }], ["/api/people/settings", {}], [`/api/people/${someone}/reset-code`, {}],
    ["/api/people/links/confirm", {}], ["/api/profiles", { name: "Sam", pin: "2468" }]];
  for (const [why, base, key, headers] of [["through the paired door", doorBase, own, phone.headers], ["with its own key on this computer's listener", undefined, own, phone.headers],
    ["the window's key from beyond this computer", undefined, server.token, { "x-branch-tunnel": "1" }]])
    for (const [path, body] of asks) {
      const answer = await call("POST", path, body, key, base, headers);
      assert.equal(answer.status, 403, `${path} ${why}: ${answer.status} ${answer.text}`);
      assert.equal(answer.body.error, hereOnly, `${path} ${why}`);
    }
  for (const [path, body] of asks) {
    const here = await call("POST", path, body);
    assert.notEqual(here.body.error, hereOnly, `the window on this computer is not refused ${path}: ${here.text}`);
  }
  assert.equal((await call("GET", "/api/webhooks", undefined, own, doorBase, phone.headers)).status, 200, "looking stays open");
});

/** A phone let in by a Tailscale invitation (POST /api/pair), as one was before phones had keys when `before` is set. */
async function doorPhone(app, server, call, doorBase, name, before = false) {
  const offer = server.remote.pairing.create();
  const paired = await call("POST", "/api/pair", { id: offer.id, code: offer.code, name }, null, doorBase);
  assert.equal(paired.status, 200, paired.text);
  if (before) {
    const saved = app.store.get("settings", app.runtime.owner, "remote-devices").data;
    app.store.save("settings", app.runtime.owner, "remote-devices",
      { devices: saved.devices.map(({ keyFingerprint, ...each }) => (each.id === paired.body.deviceId ? each : { ...each, keyFingerprint })) });
  }
  return { id: paired.body.deviceId, token: before ? server.token : paired.body.token,
    headers: { "x-branch-device": paired.body.deviceId, "x-branch-device-key": paired.body.deviceKey } };
}

test("a phone a Tailscale invitation let in is listed and removed from this computer's window, taking the window's key if it held it", async (t) => {
  const { app, server, call, doorBase } = await served(t);
  const window = server.token;
  const old = await doorPhone(app, server, call, doorBase, "Old phone", true);
  const keyed = await doorPhone(app, server, call, doorBase, "Keyed phone");
  const other = await pairedPhone(call, "Pair a phone");
  const listed = (await call("GET", "/api/devices")).body;
  assert.deepEqual(listed.doorPhones.map((phone) => phone.name).sort(), ["Keyed phone", "Old phone"], "both are listed, the one Pair a phone let in is not");
  assert.equal(listed.devices.some((device) => device.id === old.id), false, "they are not devices another list could pick");

  const fromDoor = await call("POST", `/api/devices/${old.id}/revoke`, { keepKey: true }, other.session.token, doorBase, other.headers);
  assert.equal(fromDoor.status, 403, fromDoor.text);
  assert.equal(fromDoor.body.error, hereOnly);
  assert.equal(server.token, window, "a door removes nothing");
  assert.ok((await call("GET", "/api/devices")).body.doorPhones.some((phone) => phone.id === old.id), "and it is still listed");

  const removed = await call("POST", `/api/devices/${old.id}/revoke`, { keepKey: true });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.body.removed, true);
  assert.notEqual(server.token, window, "the window's key it held was replaced");
  assert.equal(removed.body.key, server.token, "the window that asked is handed the new key");
  assert.equal((await call("GET", "/api/state", undefined, window)).status, 401, "the old key opens nothing");
  assert.equal((await call("GET", "/api/state", undefined, window, doorBase, old.headers)).status, 401, "nor on the paired door");
  assert.equal((await call("GET", "/api/devices")).body.doorPhones.some((phone) => phone.id === old.id), false, "it is forgotten");

  const now = server.token;
  assert.equal((await call("GET", "/api/state", undefined, keyed.token, doorBase, keyed.headers)).status, 200, "the keyed phone works until removed");
  const plain = await call("POST", `/api/devices/${keyed.id}/revoke`, { keepKey: true });
  assert.equal(plain.status, 200, plain.text);
  assert.equal(server.token, now, "a phone with a key of its own leaves the window's key alone");
  assert.equal(plain.body.key, undefined);
  assert.equal((await call("GET", "/api/state", undefined, keyed.token, doorBase, keyed.headers)).status, 401, "its own key opens nothing");
  assert.deepEqual((await call("GET", "/api/devices")).body.doorPhones, []);
});

test("a phone reads no chat service's secret address, no trigger's or webhook's secret, and switches none back on", async (t) => {
  const { server, call, doorBase } = await served(t);
  const phone = await pairedPhone(call, "Phone");
  const trigger = await call("POST", "/api/triggers", { name: "Build done", prompt: "Say the build is done." });
  assert.equal(trigger.status, 200, trigger.text);
  const webhook = await call("POST", "/api/webhooks", { name: "Out", url: "https://example.com/hook", secret: "signing-word-1234", events: ["run.completed"] });
  assert.equal(webhook.status, 200, webhook.text);
  const doors = [["through the paired door", doorBase, phone.session.token, phone.headers],
    ["with its own key on this computer's listener", undefined, phone.session.token, phone.headers],
    ["the window's key from beyond this computer", undefined, server.token, { "x-branch-tunnel": "1" }]];
  for (const [why, base, key, headers] of doors) {
    for (const [method, path, body] of [["GET", "/api/channels/addresses"], ["GET", "/api/channels/addresses/"],
      ["POST", "/api/channels/addresses/rotate", { channel: "telegram" }], ["POST", "/api/channels/addresses/settings", { acceptOldAddresses: true }],
      ["POST", `/api/webhooks/${webhook.body.id}/enable`, {}], ["POST", `/api/triggers/${trigger.body.id}/enabled`, { enabled: true }]]) {
      const answer = await call(method, path, body, key, base, headers);
      assert.equal(answer.status, 403, `${method} ${path} ${why}: ${answer.status} ${answer.text}`);
      assert.equal(answer.body.error, hereOnly, `${path} ${why}`);
    }
    for (const path of ["/api/triggers", `/api/triggers/${trigger.body.id}`, "/api/webhooks", `/api/webhooks/${webhook.body.id}`, "/api/state"]) {
      const answer = await call("GET", path, undefined, key, base, headers);
      assert.equal(answer.status, 200, `${path} ${why}: ${answer.text}`);
      assert.ok(!answer.text.includes(trigger.body.secret) && !answer.text.includes("signing-word-1234"), `${path} ${why} carries no secret: ${answer.text}`);
    }
    const off = await call("POST", `/api/triggers/${trigger.body.id}/enabled`, { enabled: false }, key, base, headers);
    assert.equal(off.status, 200, `switching one off stays open ${why}: ${off.text}`);
    assert.ok(!off.text.includes(trigger.body.secret), "and its answer carries no secret");
  }
  assert.equal((await call("GET", "/api/channels/addresses")).status, 200, "the window on this computer still reads the addresses");
  assert.equal((await call("GET", `/api/triggers/${trigger.body.id}`)).body.secret, trigger.body.secret, "and a trigger's secret");
  assert.equal((await call("GET", "/api/state")).body.triggers[0].secret, trigger.body.secret, "also in its state");
  assert.equal((await call("POST", `/api/triggers/${trigger.body.id}/enabled`, { enabled: true })).status, 200, "and switches it back on");
});
