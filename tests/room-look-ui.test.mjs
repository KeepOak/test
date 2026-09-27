/* chatlook: a room drawn as the prototype's group conversation (public/app/chat/roomlook.js), in the real window.
   The room's record (its events) is written as the engine keeps it, so each shape the window must handle is exact:
   - no reply ever vanishes: a later round that no card can hold (fewer than two Trunks named) stays in the thread;
   - the room keeps only its newest events, and what the conversation holds from before them is still drawn;
   - replies folded into a "talked it through" card keep their message tools;
   - the open room's refresh reads the conversation too, so a new reply comes with its tools without opening it again. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { signIn } from "./new-window-places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-room-look-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  for (const part of ["trunks", "rooms"]) await call("/api/trunks/switch", { part, mode: "on" });
  const scout = (await call("/api/trunks", { name: "Scout" })).trunk;
  const ledger = (await call("/api/trunks", { name: "Ledger" })).trunk;
  await app.trunks.introduced();
  const { room } = await call("/api/trunks/rooms", { name: "Month-end", members: [scout.id, ledger.id] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  const at = new Date().toISOString();
  /* The room's record, as the engine keeps it: events in order, and the conversation's own messages beside them. */
  const record = (events) => {
    const kept = app.trunks.rooms.get(room.id);
    const seq0 = kept.seq;
    const numbered = events.map((e, i) => ({ at, ...e, seq: seq0 + i + 1 }));
    app.store.save("governance", app.runtime.owner, `trunk-room:${room.id}`, { ...kept, events: [...kept.events, ...numbered], seq: seq0 + events.length });
  };
  const said = (content, extra = {}) => app.store.message(room.sessionId, { role: "user", content, ...extra });
  const reply = (trunk, text) => app.store.message(room.sessionId, { role: "assistant", content: `@${trunk.handle}: ${text}` });
  const open = async () => {
    await page.goto(new URL(`/#open=${room.sessionId}`, server.url).href);
    await page.locator("#conversation").waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
  };
  return { app, page, errors, room, scout, ledger, record, said, reply, open, thread: page.locator("#conversation") };
}

test("a later round no card can hold stays in the thread: no reply vanishes", async (t) => {
  const f = await fixture(t);
  f.said("@ledger total please");
  f.reply(f.ledger, "Adding it up now.");
  f.reply(f.ledger, "The total is in the sheet.");
  f.record([{ kind: "user", text: "@ledger total please" },
    { kind: "member", memberId: f.ledger.id, text: "Adding it up now.", round: 0, discussion: 1, seen: 1 },
    { kind: "member", memberId: f.ledger.id, text: "The total is in the sheet.", round: 1, discussion: 1, seen: 2 }]);
  await f.open();
  await f.thread.getByText("Adding it up now.").waitFor({ timeout: 10000 });
  assert.equal(await f.thread.getByText("The total is in the sheet.").count(), 1, "the later round is drawn");
  assert.equal(await f.thread.locator(".a2a10").count(), 0, "one Trunk alone is no talking it through");
  assert.deepEqual(f.errors, []);
});

test("what the conversation holds from before the room's kept events is still drawn, with who said it", async (t) => {
  const f = await fixture(t);
  const sam = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  // Older than anything the room's record still keeps (it keeps only its newest events).
  f.said("Earliest words of the owner");
  f.said("Earliest words of Sam", { person: { id: sam.id, name: "Sam" } });
  f.reply(f.scout, "Earliest reply of Scout");
  // What the record still keeps.
  f.said("Newest words");
  f.reply(f.ledger, "Newest reply");
  f.record([{ kind: "user", text: "Newest words" },
    { kind: "member", memberId: f.ledger.id, text: "Newest reply", round: 0, discussion: 1, seen: 1 }]);
  await f.open();
  await f.thread.getByText("Newest reply").waitFor({ timeout: 10000 });
  assert.equal(await f.thread.locator(".u").filter({ hasText: "Earliest words of the owner" }).count(), 1);
  const person = f.thread.locator(".msg10").filter({ hasText: "Earliest words of Sam" });
  assert.equal(await person.count(), 1, "a person's older message is drawn as theirs");
  assert.equal(await person.locator("b").innerText(), "Sam");
  const scoutSaid = f.thread.locator(".b").filter({ hasText: "Earliest reply of Scout" });
  assert.equal(await scoutSaid.count(), 1);
  assert.equal(await scoutSaid.locator(".from").innerText(), "Scout", "an older reply is still signed by its Trunk");
  const order = await f.thread.innerText();
  assert.ok(order.indexOf("Earliest words of the owner") < order.indexOf("Newest words"), "in the order it was said");
  assert.equal(await f.thread.getByText("Newest words").count(), 1, "nothing is drawn twice");
  assert.deepEqual(f.errors, []);
});

test("the room's engine keeps a person's mark on their message in the room's conversation", async (t) => {
  const f = await fixture(t);
  const sam = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.trunks.rooms.edit(f.room.id, { people: [sam.id] });
  f.app.trunks.rooms.send(f.room.id, { text: "(pass) words from Sam" }, { id: sam.id, name: "Sam" });
  const last = f.app.store.messages(f.room.sessionId).filter((m) => m.role === "user").at(-1);
  assert.deepEqual(last.person, { id: sam.id, name: "Sam" });
  f.app.trunks.rooms.send(f.room.id, { text: "owner words" });
  assert.equal(f.app.store.messages(f.room.sessionId).filter((m) => m.role === "user").at(-1).person, undefined, "the owner's carry none");
  await f.app.trunks.rooms.settled(f.room.id);
});

test("replies folded into the card keep their message tools", async (t) => {
  const f = await fixture(t);
  f.said("close the month");
  f.reply(f.scout, "@ledger can you check the totals?");
  f.reply(f.ledger, "Checked, they match.");
  f.record([{ kind: "user", text: "close the month" },
    { kind: "member", memberId: f.scout.id, text: "@ledger can you check the totals?", round: 0, discussion: 1, seen: 1 },
    { kind: "member", memberId: f.ledger.id, text: "Checked, they match.", round: 1, discussion: 1, seen: 2 }]);
  await f.open();
  await f.thread.locator(".a2a10").waitFor({ timeout: 10000 });
  assert.equal(await f.thread.locator(".a2a10 .a2a-l").count(), 2);
  assert.equal(await f.thread.locator(".a2a10 .a2a-l .msg-acts").count(), 2, "each folded reply has its tools");
  await f.thread.locator(".a2a10 .a2a-l").nth(1).hover();
  assert.ok(await f.thread.locator(".a2a10 .a2a-l").nth(1).locator('.msg-acts [data-act="copy15"]').isVisible(), "shown on hover");
  assert.deepEqual(f.errors, []);
});

test("the open room's refresh reads the conversation too: a new reply comes with its tools", async (t) => {
  const f = await fixture(t);
  f.said("first");
  f.record([{ kind: "user", text: "first" }]);
  await f.open();
  await f.thread.locator(".u").filter({ hasText: "first" }).waitFor({ timeout: 10000 });
  // A reply arrives while the room is open (as a member's turn writes it: the conversation, then the record).
  f.reply(f.ledger, "A reply that came later.");
  f.record([{ kind: "member", memberId: f.ledger.id, text: "A reply that came later.", round: 0, discussion: 1, seen: 1 }]);
  const row = f.thread.locator(".b").filter({ hasText: "A reply that came later." });
  await row.waitFor({ timeout: 10000 });
  await row.locator('.msg-acts [data-act="copy15"]').waitFor({ state: "attached", timeout: 10000 });
  assert.equal(await row.locator(".msg-acts").count(), 1);
  assert.deepEqual(f.errors, []);
});
