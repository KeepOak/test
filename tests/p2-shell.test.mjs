/* Redesign phase 2, shell (server side): a Trunk's look, the strip and 3D faces switches, and lending
   this computer to another Branch from the window — two real Branch servers on this computer's
   loopback address, the owner's yes on one, the other joined and connected, then leaving. Nothing is
   captured or run: every ability of the joined computer stays switched off. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { exportTrunk } from "../dist/trunks/share.js";

const scripted = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };

async function branch(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-p2-shell-${name}-`));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, token = server.token) => {
    const response = await fetch(new URL(path, server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, server, call, root };
}
async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await wait(100); }
  assert.fail(`timed out waiting for ${what}`);
}

test("the strip ships on and 3D faces ship off; only the owner at the window changes them", async (t) => {
  const b = await branch(t, "look");
  assert.deepEqual((await b.call("/api/shell-look")).body, { strip: "on", faces3d: "off" });
  assert.deepEqual((await b.call("/api/shell-look", { faces3d: "on" })).body, { strip: "on", faces3d: "on" });
  assert.equal((await b.call("/api/shell-look", { strip: "sometimes" })).status, 400, "only off or on");
  assert.equal((await b.call("/api/shell-look", { extra: true })).status, 400, "nothing else is kept");
  const key = b.app.sessionTokens.create(b.app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.ok([401, 403].includes((await b.call("/api/shell-look", { strip: "off" }, key)).status), "a short-lived key cannot change it");
  const person = (await b.call("/api/profiles", { name: "Amara", pin: "4321" })).body;
  assert.equal((await b.call("/api/profiles/switch", { profileId: person.id, pin: "4321" })).status, 200);
  // Q261: reading fails closed for a household person at the window, and the window never reads the shell look.
  assert.equal((await b.call("/api/shell-look")).status, 400, "a read not in householdReads");
  assert.equal((await b.call("/api/shell-look", { strip: "off" })).status, 400, "but not change it");
  await b.call("/api/profiles/switch", { profileId: null });
  assert.deepEqual((await b.call("/api/shell-look")).body, { strip: "on", faces3d: "on" });
});

test("a Trunk keeps its look: colour tokens only, a real emoji, and it travels in its file", async (t) => {
  const b = await branch(t, "trunk-look");
  await b.call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = (await b.call("/api/trunks", { name: "Ledger", title: "Keeps receipts", description: "" })).body;
  assert.equal(trunk.look, undefined, "a Trunk nobody restyled has no look and draws as before");
  const look = { face: "emoji", emoji: "📒", colour: 7, shape: "shield", motion: "pulse", depth: "3d" };
  const saved = (await b.call(`/api/trunks/${trunk.id}`, { look })).body.trunk;
  assert.deepEqual(saved.look, { ...look, letters: "", shuffle: 0 });
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { look: { colour: "#ff0000" } })).status, 400, "a colour is a token, never a value");
  /* DG-105: a colour picked as a value is the Trunk's own chosenColour, beside the look, never inside it. */
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { chosenColour: "#FF0000" })).body.trunk.chosenColour, "#ff0000");
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { look: { face: "emoji", emoji: "<b>" } })).status, 400, "an emoji, not markup");
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { look: { shape: "star" } })).status, 400);
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { look: { colour: "theme", face: "letters", letters: "LG" } })).body.trunk.look.colour, "theme");
  assert.equal(exportTrunk(b.app.trunks.records.get(trunk.id)).trunk.look.letters, "LG", "the look goes with the Trunk's file");
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { order: 30, pinned: true })).body.trunk.order, 30, "the strip's order and pin are the Trunk's own");
});

test("another computer joins from its window: the owner's yes, connected, then it leaves", async (t) => {
  const host = await branch(t, "host");
  const guest = await branch(t, "guest");
  await host.call("/api/devices/mode", { mode: "when-needed" });
  const invite = (await host.call("/api/devices/invite", {})).body;
  assert.match(invite.link, /^http:\/\/127\.0\.0\.1:\d+\/devices\/pair\?offer=[a-f0-9]{32}$/);
  assert.equal((await guest.call("/api/devices/join")).body.state, "off", "nothing is lent until the owner joins");
  const started = await guest.call("/api/devices/join", { link: invite.link, code: invite.code, name: "Kitchen laptop" });
  assert.equal(started.status, 200);
  assert.equal(started.body.state, "waiting");
  const request = await until(async () => (await host.call("/api/devices")).body.requests.find((entry) => entry.name === "Kitchen laptop"), "the join request");
  // mac7/residuals (integration): the route, not only the window's tick, wants the owner's word that the codes match.
  const unsaid = await host.call(`/api/devices/requests/${request.id}`, { approve: true });
  assert.equal(unsaid.status, 400);
  assert.match(JSON.stringify(unsaid.body), /Compare the check code first/);
  assert.equal((await host.call("/api/devices")).body.requests.some((entry) => entry.id === request.id), true, "and the request still waits");
  assert.equal((await host.call(`/api/devices/requests/${request.id}`, { approve: true, codeMatches: true })).status, 200);
  const joined = await until(async () => { const now = (await guest.call("/api/devices/join")).body; return now.connected ? now : null; }, "the guest to connect");
  assert.equal(joined.state, "joined");
  assert.equal(joined.hub, new URL(host.server.url).origin);
  const device = await until(async () => (await host.call("/api/devices")).body.devices.find((entry) => entry.name === "Kitchen laptop" && entry.connected), "the host to see it connected");
  assert.deepEqual(device.enabled, [], "everything it could do starts off");
  assert.ok((await stat(join(guest.root, "data", "node", "identity.json"))).isFile(), "its key is kept in its own data folder");
  assert.equal((await host.call(`/api/devices/${device.id}/rename`, { name: "Kitchen" })).body.device.name, "Kitchen", "renaming a computer");
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: invite.code })).status, 409, "one Branch at a time");
  assert.equal((await guest.call("/api/devices/join/leave", {})).body.state, "off");
  await until(async () => !(await host.call("/api/devices")).body.devices.find((entry) => entry.id === device.id).connected, "the host to see it go");
  await assert.rejects(stat(join(guest.root, "data", "node", "identity.json")), "leaving forgets the key");
});

test("joining is the owner's alone, refused under Lockdown, and a wrong number says so plainly", async (t) => {
  const host = await branch(t, "host2");
  const guest = await branch(t, "guest2");
  await host.call("/api/devices/mode", { mode: "when-needed" });
  const invite = (await host.call("/api/devices/invite", {})).body;
  const wrong = invite.code === "000000" ? "111111" : "000000";
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: wrong })).body.state, "waiting");
  const failed = await until(async () => { const now = (await guest.call("/api/devices/join")).body; return now.state === "failed" ? now : null; }, "the refusal");
  assert.match(failed.message, /did not accept that invitation|could not be reached/);
  assert.equal((await guest.call("/api/devices/join", { link: "https://example.com/elsewhere", code: invite.code })).status, 400, "only a pairing link");
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: "12" })).status, 400);
  const key = guest.app.sessionTokens.create(guest.app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: invite.code }, key)).status, 401, "a short-lived key cannot lend this computer");
  const person = (await guest.call("/api/profiles", { name: "Sam", pin: "1234" })).body;
  await guest.call("/api/profiles/switch", { profileId: person.id, pin: "1234" });
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: invite.code })).status, 400, "nor may a household person");
  assert.equal((await guest.call("/api/devices/join")).status, 400);
  await guest.call("/api/profiles/switch", { profileId: null });
  await guest.call("/api/lockdown", { on: true });
  const locked = await guest.call("/api/devices/join", { link: invite.link, code: invite.code });
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /Lockdown/);
});

/* ---------------------------------------------------------------- integration review: attacks on joining */

const identityFile = (b) => join(b.root, "data", "node", "identity.json");
async function hostAndInvite(t, tag) {
  const host = await branch(t, `host-${tag}`);
  await host.call("/api/devices/mode", { mode: "when-needed" });
  return { host, invite: (await host.call("/api/devices/invite", {})).body };
}

test("integration review: both screens show the same check code, an invitation works once, and a yes after Stop connects nothing", async (t) => {
  const { host, invite } = await hostAndInvite(t, "check");
  const guest = await branch(t, "guest-check");
  const thief = await branch(t, "thief-check");
  const waiting = (await guest.call("/api/devices/join", { link: invite.link, code: invite.code, name: "Kitchen laptop" })).body;
  assert.match(waiting.check, /^[0-9A-F]{4} [0-9A-F]{4}$/, "the joining computer shows a check code while it waits");
  const request = await until(async () => (await host.call("/api/devices")).body.requests.find((entry) => entry.name === "Kitchen laptop"), "the request");
  assert.equal(request.check, waiting.check, "the owner sees the same code beside the request");
  assert.equal(request.publicKey, undefined, "never the key itself");
  // Somebody who saw the invitation and the number cannot use them again: the first answer burned them.
  assert.equal((await thief.call("/api/devices/join", { link: invite.link, code: invite.code, name: "Kitchen laptop" })).body.state, "waiting");
  const refused = await until(async () => { const now = (await thief.call("/api/devices/join")).body; return now.state === "failed" ? now : null; }, "the replay to be refused");
  assert.match(refused.message, /did not accept that invitation/);
  assert.equal((await host.call("/api/devices")).body.requests.length, 1, "a replayed invitation leaves no second request");
  // Stop before the yes: a yes that comes later must not connect this computer.
  assert.equal((await guest.call("/api/devices/join/leave", {})).body.state, "off");
  assert.equal((await host.call(`/api/devices/requests/${request.id}`, { approve: true, codeMatches: true })).status, 200);
  await wait(4500); // longer than one of the joining computer's three-second asks
  const after = (await guest.call("/api/devices/join")).body;
  assert.equal(after.state, "off");
  assert.equal(after.connected, false);
  assert.equal((await host.call("/api/devices")).body.devices.some((device) => device.connected), false, "nothing connected to the owner's Branch");
  await assert.rejects(stat(identityFile(guest)), "and no key is kept for it");
});

test("integration review: only https or a private line, never from another web page, and no key in any answer", async (t) => {
  const { host, invite } = await hostAndInvite(t, "lines");
  const guest = await branch(t, "guest-lines");
  const offer = new URL(invite.link).searchParams.get("offer");
  for (const link of [`http://example.com/devices/pair?offer=${offer}`, `http://192.168.1.20:4000/devices/pair?offer=${offer}`, `ftp://127.0.0.1/devices/pair?offer=${offer}`]) {
    const answer = await guest.call("/api/devices/join", { link, code: invite.code });
    assert.equal(answer.status, 400, `refused: ${link}`);
    assert.match(answer.body.error, /https|pairing link/);
  }
  const post = (headers) => fetch(new URL("/api/devices/join", guest.server.url), { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ link: invite.link, code: invite.code }) });
  assert.equal((await post({ authorization: `Bearer ${guest.server.token}`, origin: "https://evil.example" })).status, 403, "a page on another site cannot start a join");
  assert.equal((await post({ authorization: `Bearer ${guest.server.token}`, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({})).status, 401, "nor can anything without the window's key");
  assert.equal((await guest.call("/api/devices/join")).body.state, "off", "none of those started anything");
  await guest.call("/api/devices/join", { link: invite.link, code: invite.code, name: "Den" });
  await until(async () => (await host.call("/api/devices")).body.requests.length, "the request");
  const { publicKey, privateKey } = JSON.parse(await readFile(identityFile(guest), "utf8"));
  for (const answer of [(await guest.call("/api/devices/join")).body, (await host.call("/api/devices")).body]) {
    const text = JSON.stringify(answer);
    assert.ok(!text.includes(publicKey) && !text.includes(privateKey.split("\n")[1]) && !/PRIVATE KEY/.test(text), "no key in what either window reads");
  }
  await guest.call("/api/devices/join/leave", {});
});

test("integration review: Lockdown here cuts a joined computer off, and being taken off the list forgets the key at once", async (t) => {
  const { host, invite } = await hostAndInvite(t, "revoke");
  const guest = await branch(t, "guest-revoke");
  await guest.call("/api/devices/join", { link: invite.link, code: invite.code, name: "Attic" });
  const request = await until(async () => (await host.call("/api/devices")).body.requests.find((entry) => entry.name === "Attic"), "the request");
  await host.call(`/api/devices/requests/${request.id}`, { approve: true, codeMatches: true });
  const device = await until(async () => (await host.call("/api/devices")).body.devices.find((entry) => entry.connected), "connected");
  await guest.call("/api/lockdown", { on: true });
  await until(async () => !(await host.call("/api/devices")).body.devices.find((entry) => entry.id === device.id).connected, "Lockdown to close the line");
  assert.match((await guest.call("/api/devices/join")).body.message, /Lockdown/);
  await guest.call("/api/lockdown", { on: false });
  await until(async () => (await host.call("/api/devices")).body.devices.find((entry) => entry.id === device.id)?.connected, "it to come back after Lockdown");
  assert.equal((await host.call(`/api/devices/${device.id}/revoke`, {})).status, 200);
  const off = await until(async () => { const now = (await guest.call("/api/devices/join")).body; return now.state === "off" ? now : null; }, "the joined computer to hear it was removed");
  assert.match(off.message, /took this computer off/);
  await until(async () => stat(identityFile(guest)).then(() => false, () => true), "its key to be forgotten");
});

test("integration review: a household person cannot restyle, hide or remove the owner's Trunks, and a picture is never SVG", async (t) => {
  const b = await branch(t, "trunk-guard");
  await b.call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = (await b.call("/api/trunks", { name: "Ledger", title: "Keeps receipts", description: "" })).body;
  const svg = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>").toString("base64")}`;
  assert.equal((await b.call(`/api/trunks/${trunk.id}/avatar`, { kind: "image", dataUrl: svg })).status, 400, "an SVG is refused");
  assert.equal((await b.call(`/api/trunks/${trunk.id}/avatar`, { kind: "image", dataUrl: `data:image/png;base64,${"A".repeat(400_001)}` })).status, 400, "and so is a picture that is too large");
  const person = (await b.call("/api/profiles", { name: "Kid", pin: "2468" })).body;
  await b.call("/api/profiles/switch", { profileId: person.id, pin: "2468" });
  for (const [path, body] of [[`/api/trunks/${trunk.id}`, { look: { colour: 3 } }], [`/api/trunks/${trunk.id}`, { hidden: true }], [`/api/trunks/${trunk.id}`, { order: 5 }],
    [`/api/trunks/${trunk.id}/avatar`, { kind: "face", locked: true }], [`/api/trunks/${trunk.id}/remove`, {}]])
    assert.equal((await b.call(path, body)).status, 400, `refused to a household person: ${path} ${JSON.stringify(body)}`);
  await b.call("/api/profiles/switch", { profileId: null });
  const kept = b.app.trunks.records.get(trunk.id);
  assert.equal(kept.look, undefined);
  assert.equal(kept.hidden, false);
  assert.equal(kept.avatar.kind, "face");
});
