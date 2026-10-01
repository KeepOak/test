// CHAT-157: /pair from the owner's own approved direct chat only asks; the local window shows the request for two minutes
// and makes the invitation there. A sender who is not allowed, a bad argument, a repeat or a burst asks nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { DevicePairProposals } from "../dist/channels/device-pair-proposals.js";
import { lookup } from "../dist/commands/catalog.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { devicesApi } from "../dist/devices/api.js";
import { discardTemp } from "./temp-dir.mjs";
import { newWindow } from "./new-window-places.mjs";

const from = { channel: "telegram", chatId: "c1", senderId: "owner-1", senderName: "Owner", messageId: "m1" };

test("an allowed owner DM leaves a two-minute request in the window, and nothing else", () => {
  let now = Date.parse("2026-09-30T10:00:00Z");
  const allowed = new Set(["owner-1"]);
  const proposals = new DevicePairProposals((p) => allowed.has(p.senderId), () => now);
  assert.match(proposals.request(from, "phone Pixel 9"), /^Pairing requested/);
  const [waiting] = proposals.list();
  assert.deepEqual([waiting.kind, waiting.label, waiting.senderId], ["phone", "Pixel 9", "owner-1"]);
  assert.doesNotMatch(JSON.stringify(waiting), /code|token|key/i, "no code or key is made from chat");
  assert.match(proposals.request(from, "phone"), /already waiting/, "the same message asks once");
  assert.match(proposals.request({ ...from, messageId: "m2" }, "computer"), /Wait a minute/, "one request a minute per sender");
  assert.throws(() => proposals.consume(waiting.id, "computer"), /expired|no longer/, "the window's kind must match");
  now += 121_000;
  assert.deepEqual(proposals.list(), [], "it expires after two minutes");
});

test("a sender who is not allowed, or a bad argument, asks nothing; a sender who loses approval loses the request", () => {
  const allowed = new Set(["owner-1"]);
  const proposals = new DevicePairProposals((p) => allowed.has(p.senderId));
  assert.match(proposals.request({ ...from, senderId: "stranger" }, "phone"), /need your own approved direct chat/);
  assert.match(proposals.request(from, "toaster"), /^Use \/pair phone/);
  assert.equal(proposals.list().length, 0);
  proposals.request(from, "computer");
  allowed.clear();
  assert.deepEqual(proposals.list(), [], "rechecked every time it is read");
});

test("/pair is a chat command", () => {
  assert.equal(lookup("pair")?.name, "pair");
});

/* Review 5914163325 P1: the owner asked for an invitation, but a household switch while the body arrived means the
   request is not consumed and no invitation (with its code) is made for whoever is at the window now. */
test("an invitation asked for by the owner is refused when the window switches profile while the body arrives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-pair-invite-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.devices.setMode({ mode: "on" });
  const person = app.store.profiles.create({ name: "Household fixture", pin: "1234" });
  let consumed = 0, invited = 0;
  const invite = app.devices.book.invite.bind(app.devices.book);
  app.devices.book.invite = (options) => { invited++; return invite(options); };
  const chatPairing = { list: () => [], consume: () => { consumed++; } };
  const ask = (readBody) => devicesApi({ devices: app.devices, store: app.store, owner: app.runtime.owner, method: "POST", readBody,
    baseUrl: "http://127.0.0.1:1", viaDoor: false, keyHere: true, chatPairing }, "/api/devices/invite");
  const body = { phone: false, proposalId: "a".repeat(32) };
  await assert.rejects(ask(async () => { app.store.profiles.switch({ profileId: person.id, pin: "1234" }); return body; }),
    (error) => error.status === 403 && /owner/.test(error.message));
  assert.deepEqual([consumed, invited], [0, 0], "nothing consumed, no invitation made");
  app.store.profiles.switch({ profileId: null });
  await assert.rejects(ask(async () => {
    app.store.profiles.switch({ profileId: person.id, pin: "1234" });
    app.store.profiles.switch({ profileId: null });
    return body;
  }), (error) => error.status === 403, "a switch away and back during the wait still refuses");
  const lockers = new Set();
  await assert.rejects(devicesApi({ devices: app.devices, store: app.store, owner: app.runtime.owner, method: "POST", baseUrl: "http://127.0.0.1:1",
    viaDoor: false, keyHere: true, chatPairing, onLocked: (listener) => { lockers.add(listener); return () => lockers.delete(listener); },
    readBody: async () => { for (const listener of lockers) listener(); return body; } }, "/api/devices/invite"),
  (error) => error.status === 403, "an App lock during the wait refuses, even if unlocked again before the body arrives");
  assert.equal(lockers.size, 0, "the lock listener is let go");
  assert.deepEqual([consumed, invited], [0, 0]);
  const offer = await ask(async () => body);
  assert.ok(offer.code && offer.link, "the owner, still at the window, gets the invitation");
  assert.deepEqual([consumed, invited], [1, 1]);
});

/* Review 5914163325 P2: a pairing request read just before App lock is not shown as a consent dialog on the locked window. */
test("a pairing request answered after the window locked opens no consent dialog", async (t) => {
  const f = await newWindow(t);
  const proposal = (id) => ({ id, channel: "telegram", chatId: "c1", senderId: "owner-1", senderName: "Owner", messageId: id,
    kind: "phone", label: "", expiresAt: new Date(Date.now() + 120_000).toISOString() });
  let holdNext = null, answer = proposal("1".repeat(32));
  await f.page.route("**/api/devices/chat-pairing", async (route) => {
    if (holdNext) { const { gate, held } = holdNext; holdNext = null; held(); await gate; }
    await route.fulfill({ json: { proposals: [answer] } });
  });
  const ask = () => f.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const consent = f.page.locator(".dlg", { hasText: "Pairing request from your chat" });
  await ask();
  await consent.waitFor({ timeout: 20000 }); // the stand-in request reaches the window when nothing has changed
  await f.page.locator('.dlg [data-act="chat-pair-dismiss"]').click();
  await consent.waitFor({ state: "detached" });
  const lockedDuring = async (id, during) => {
    answer = proposal(id);
    let release, held;
    const gate = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { held = resolve; });
    holdNext = { gate, held };
    const read = f.page.waitForResponse((response) => new URL(response.url()).pathname === "/api/devices/chat-pairing");
    await ask();
    await reached;
    await f.page.evaluate(during);
    release();
    await read;
    await f.page.waitForTimeout(1000);
  };
  // Locked and unlocked again while the list was read: the authority captured before the read is revoked for good.
  await lockedDuring("2".repeat(32), () => { const app = document.getElementById("app"); app.classList.add("locked-b17"); app.classList.remove("locked-b17"); });
  assert.equal(await consent.count(), 0, "a lock roundtrip during the read still refuses consent");
  // Locked and still locked when the answer comes.
  await lockedDuring("3".repeat(32), () => document.getElementById("app").classList.add("locked-b17"));
  assert.equal(await consent.count(), 0, "no consent on a locked window");
  assert.deepEqual(f.errors, []);
});
