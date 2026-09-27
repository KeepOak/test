/* trunk-rooms-live, the window's side (public/app/flows/roomwith.js): dragging one Trunk's row onto another offers
   "Open a room with both", which makes the room through the engine (or opens the one those two already share) and opens
   it; the menu key on a Trunk's row does the same from the keyboard; and in a room the toggle by the message box sets
   who answers (Everyone answers, Only who I tag, Work together), read back from the engine, with working together shown
   as the Trunks talking it through and one reply. Headless only. */
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

/** Answers as whichever Trunk is speaking, by what the room asks of it this turn. */
const model = { name: "scripted", async complete(request) {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const text = String(request.messages.at(-1)?.content ?? "");
  const who = /\nYou are ([^(\n]+) \(@/.exec(system)?.[1]?.trim() ?? "Branch";
  const say = (content) => ({ content, toolCalls: [] });
  if (!text.startsWith("[Room")) return say(`${who} here.`);
  if (/You lead this piece of work/.test(text)) return say(`@${who === "Kim" ? "lee" : "kim"} please add the numbers.`);
  if (/The lead gave you a part/.test(text)) return say("The numbers come to forty two.");
  if (/The parts are in/.test(text)) return say(`${who} sums it up: forty two in all.`);
  if (/Only you answer this message/.test(text)) return say(`${who} alone.`);
  return say(`${who} in the room.`);
} };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-rooms-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  for (const part of ["trunks", "rooms"]) await call("/api/trunks/switch", { part, mode: "on" });
  const kim = (await call("/api/trunks", { name: "Kim" })).trunk, lee = (await call("/api/trunks", { name: "Lee" })).trunk, max = (await call("/api/trunks", { name: "Max" })).trunk;
  await app.trunks.introduced();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  for (const tr of [kim, lee, max]) await page.locator(`#side .list [data-trunk="${tr.id}"]`).waitFor({ timeout: 15000 });
  return { app, call, page, errors, kim, lee, max };
}
const rooms = async (call) => (await call("/api/trunks")).rooms;
const openRow = (page) => page.evaluate(() => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);
const opened = (page, sessionId) => page.waitForFunction((id) => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id === id, sessionId, { timeout: 15000 });
/* The window has finished the last send (the room's answers followed, the typing dots gone) before the next. */
const send = async (page, text) => {
  await page.waitForFunction(() => !document.querySelector("#conversation .typing") && !document.querySelector("#send.stop"), null, { timeout: 15000 });
  await page.locator("#prompt").fill(text);
  await page.locator("#prompt").press("Enter");
};

test("dragging one Trunk onto another opens a room with both, made by the engine; again, it opens the same room", async (t) => {
  const { page, call, errors, kim, lee } = await fixture(t);
  await page.locator(`#side .list [data-trunk="${kim.id}"]`).dragTo(page.locator(`#side .list [data-trunk="${lee.id}"]`));
  const item = page.locator('.pop [data-act="room-both"]');
  await item.waitFor({ state: "visible" });
  assert.equal(await item.locator(".mi-t").innerText(), "Open a room with both");
  assert.equal(await item.locator(".av").count(), 2, "both Trunks' faces");
  await item.click();
  await page.waitForFunction(() => !document.querySelector(".pop"));
  let list = [];
  for (let i = 0; i < 50 && !list.length; i++) { list = await rooms(call); if (!list.length) await page.waitForTimeout(100); }
  assert.equal(list.length, 1, "one room, made through the engine");
  assert.deepEqual([...list[0].members].sort(), [kim.id, lee.id].sort());
  assert.equal(list[0].name, "Kim and Lee");
  await opened(page, list[0].sessionId);
  // Dropped the other way round: the room they share opens, and no second room is made.
  await page.locator(`#side .list [data-trunk="${lee.id}"]`).dragTo(page.locator(`#side .list [data-trunk="${kim.id}"]`));
  await page.locator('.pop [data-act="room-both"]').click();
  await opened(page, list[0].sessionId);
  assert.equal((await rooms(call)).length, 1);
  // A Trunk dropped on itself offers nothing.
  await page.locator(`#side .list [data-trunk="${kim.id}"]`).dragTo(page.locator(`#side .list [data-trunk="${kim.id}"]`));
  assert.equal(await page.locator('.pop [data-act="room-both"]').count(), 0);
  assert.deepEqual(errors, []);
});

test("from the keyboard: the menu key on a Trunk's row lists the others, each a room with this one", async (t) => {
  const { page, call, errors, kim, max } = await fixture(t);
  await page.locator(`#side .list [data-trunk="${kim.id}"]`).focus();
  await page.keyboard.press("Shift+F10");
  const items = page.locator('.pop [data-act="room-both"]');
  await items.first().waitFor({ state: "visible" });
  assert.deepEqual(await items.locator(".mi-t").allInnerTexts(), ["Open a room with Lee", "Open a room with Max"]);
  await page.locator(`.pop [data-act="room-both"][data-b="${max.id}"]`).focus();
  await page.keyboard.press("Enter");
  let list = [];
  for (let i = 0; i < 50 && !list.length; i++) { list = await rooms(call); if (!list.length) await page.waitForTimeout(100); }
  assert.deepEqual([...list[0].members].sort(), [kim.id, max.id].sort());
  await opened(page, list[0].sessionId);
  assert.deepEqual(errors, []);
});

test("the toggle in a room: Everyone answers, Only who I tag, Work together, each saved in the engine and answered that way", async (t) => {
  const { app, page, call, errors, kim, lee } = await fixture(t);
  const room = (await call("/api/trunks/rooms", { name: "Pair", members: [kim.id, lee.id] })).room;
  await page.locator(`#side .list [data-act="chat"][data-id="${room.sessionId}"]`).waitFor({ timeout: 15000 });
  await page.locator(`#side .list [data-act="chat"][data-id="${room.sessionId}"]`).click();
  await opened(page, room.sessionId);
  const seg = page.locator(".talk-tr .seg");
  await seg.waitFor({ state: "visible" });
  assert.deepEqual(await seg.locator("button").allInnerTexts(), ["Everyone answers", "Only who I tag", "Work together"]);
  assert.equal(await seg.locator('[aria-pressed="true"]').innerText(), "Everyone answers");
  // Everyone answers: talking freely, both answer.
  await send(page, "hello both");
  await app.trunks.rooms.settled(room.id);
  let events = (await call(`/api/trunks/rooms/${room.id}`)).events;
  assert.equal(events.filter((e) => e.kind === "member").length, 2);
  // Only who I tag: talking freely, one answers.
  await seg.locator('[data-v="tag"]').click();
  await page.waitForFunction(() => document.querySelector('.talk-tr [aria-pressed="true"]')?.dataset.v === "tag", null, { timeout: 15000 });
  assert.equal((await rooms(call))[0].rule, "tag", "saved in the engine");
  await send(page, "just one of you");
  for (let i = 0; i < 50 && (await call(`/api/trunks/rooms/${room.id}`)).events.filter((e) => e.kind === "user").length < 2; i++) await page.waitForTimeout(100);
  await app.trunks.rooms.settled(room.id);
  events = (await call(`/api/trunks/rooms/${room.id}`)).events;
  const second = events.filter((e) => e.kind === "user").at(-1).seq;
  assert.deepEqual(events.filter((e) => e.discussion === second && e.kind === "member").map((e) => e.text), ["Kim alone."]);
  // Work together: the talk folds into one card, and one reply stands in the thread.
  await seg.locator('[data-v="together"]').click();
  await page.waitForFunction(() => document.querySelector('.talk-tr [aria-pressed="true"]')?.dataset.v === "together", null, { timeout: 15000 });
  await send(page, "work it out together");
  for (let i = 0; i < 50 && (await call(`/api/trunks/rooms/${room.id}`)).events.filter((e) => e.kind === "user").length < 3; i++) await page.waitForTimeout(100);
  await app.trunks.rooms.settled(room.id);
  events = (await call(`/api/trunks/rooms/${room.id}`)).events;
  const third = events.filter((e) => e.kind === "user").at(-1).seq;
  const turns = events.filter((e) => e.discussion === third && e.kind === "member");
  assert.deepEqual(turns.map((e) => [e.text, !!e.final]), [["@lee please add the numbers.", false], ["The numbers come to forty two.", false], ["Kim sums it up: forty two in all.", true]]);
  await page.waitForFunction(() => /Kim sums it up/.test(document.getElementById("conversation")?.textContent ?? ""), null, { timeout: 15000 });
  const card = page.locator("#conversation details.a2a10").last();
  assert.match(await card.locator("summary").innerText(), /Kim and Lee talked it through/);
  assert.equal(await card.locator(".a2a-l").count(), 2, "the plan and the part, folded");
  assert.equal(await card.getByText("sums it up").count(), 0, "the reply is not inside the card");
  const replies = (await call(`/api/sessions/${room.sessionId}`)).messages.filter((m) => m.role === "assistant").map((m) => m.content);
  assert.deepEqual(replies.slice(-1), ["@kim: Kim sums it up: forty two in all."]);
  assert.ok(!replies.some((r) => /please add the numbers|come to forty two/.test(r)), "the plan and the part stay out of the room's conversation");
  assert.equal(await openRow(page), room.sessionId);
  assert.deepEqual(errors, []);
});
