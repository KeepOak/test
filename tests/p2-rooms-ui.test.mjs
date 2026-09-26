/* Redesign phase 2 "rooms": the window's side. The faces at the top of a conversation, choosing a
   Trunk, "@" in the message box, and a room drawn as a conversation with its questions answered in
   place. Headless only; nothing here opens a microphone.
   Redesign: the new window (public/app/**). Who answers is chosen in the message box's + menu ("Who answers in this
   conversation", data-act="who"); "@" opens "Call a Trunk" (data-act="mention-pick"); a room is a row in the side list
   (data-act="chat") that opens as a conversation. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
/** Whether a file was written: in the shared project, or in a Trunk's own folder under .branch-agents (isolated-agents). */
const written = (app, path) => existsSync(join(app.runtime.workspace, path))
  || (existsSync(join(app.runtime.workspace, ".branch-agents")) && readdirSync(join(app.runtime.workspace, ".branch-agents"))
    .some((id) => existsSync(join(app.runtime.workspace, ".branch-agents", id, path))));
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { signIn } from "./new-window-places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Answers as whichever Trunk is speaking; Ledger asks to write a file when it is its turn in a room. */
const model = { name: "scripted", async complete(request) {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const last = request.messages.at(-1), text = String(last?.content ?? "");
  const who = /\nYou are ([^(\n]+) \(@/.exec(system)?.[1]?.trim();
  if (last?.role === "tool") return { content: "Written.", toolCalls: [] };
  if (text.startsWith("[Room") && who === "Ledger")
    return { content: "", toolCalls: [{ id: `w${Math.random().toString(36).slice(2, 7)}`, name: "files.write", arguments: JSON.stringify({ path: "totals.csv", content: "x" }) }] };
  if (text.startsWith("[Room")) return { content: `${who} here, in the room.`, toolCalls: [] };
  return { content: who ? `${who} here.` : "Your assistant here.", toolCalls: [] };
} };

async function fixture(t, parts, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-p2-rooms-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  const callRaw = (path) => fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${server.token}` } })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  await call("/api/onboarding", { done: true });
  await call("/api/conversation-mode/settings", { newConversation: "follow", confirmLoosening: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  for (const part of ["trunks", ...parts]) await call("/api/trunks/switch", { part, mode: "on" });
  const scout = (await call("/api/trunks", { name: "Scout", title: "Finds things" })).trunk;
  const ledger = (await call("/api/trunks", { name: "Ledger", title: "Keeps the books" })).trunk;
  await app.trunks.introduced();
  const page = await (await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  return { app, call, callRaw, page, errors, scout, ledger };
}
const send = async (page, text) => { await page.locator("#prompt").fill(text); await page.locator("#prompt").press("Enter"); };
/* The reply is on screen before the window has finished that send (it reloads the conversation, then the state): the
   typing dots show until then. */
const readyToSend = (page) => page.waitForFunction(() => !document.querySelector("#conversation .typing"));
const lastReply = (page) => page.locator("#conversation .b").last();
/** The conversation open in the side list. */
const openChat = (page) => page.evaluate(() => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);
/** A reply is signed by a Trunk when its face (not Branch's own mark) stands beside it. */
const signed = (reply) => reply.locator(".gut .av:not(.brand)").count().then((n) => n > 0);
/** Opens a conversation (a room's too) from its row in the side list. */
async function openRow(page, sessionId) {
  await page.waitForFunction((id) => document.querySelector(`#side .list [data-act="chat"][data-id="${id}"]`), sessionId, { timeout: 15000 });
  await page.locator(`#side .list [data-act="chat"][data-id="${sessionId}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`#side .list [data-act="chat"][aria-current="true"]`)?.dataset.id === id, sessionId);
}
/** The + menu's "Who answers in this conversation" choices. */
async function whoMenu(page) {
  await page.locator('[data-act="plusmenu"]').click();
  const pop = page.locator(".pop");
  await pop.waitFor({ state: "visible" });
  return pop;
}

test("with choosing a Trunk switched off, nothing new shows and @name goes to the Trunk's own chat as before", async (t) => {
  const f = await fixture(t, []);
  await send(f.page, "hello");
  await f.page.locator("#conversation").getByText("Your assistant here.").waitFor({ timeout: 15000 });
  await readyToSend(f.page);
  // WINDOW BUG: public/app/chat/plus.js:28 whoRows() offers every Trunk under "Who answers in this conversation" even
  // with the engine's "conversations" part off, where choosing one is refused (src/trunks/api.ts:56).
  const pop = await whoMenu(f.page);
  assert.equal(await pop.locator('[data-act="who"][data-v]:not([data-v=""])').count(), 0, "no Trunk to choose while choosing is off");
  await f.page.keyboard.press("Escape");
  // WINDOW BUG: public/app/chat/chat.js send() posts "@Scout …" to POST /api/run as it is, so the Trunk's own chat never gets it.
  await send(f.page, "@Scout hello there");
  await f.page.waitForFunction((id) => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id === id, f.scout.chatSessionId, { timeout: 15000 });
  assert.deepEqual(f.errors, []);
});

test("choosing who answers: Talking to on an empty conversation, then every reply signed by that Trunk", async (t) => {
  const f = await fixture(t, ["conversations"]);
  await send(f.page, "hello");
  await f.page.locator("#conversation").getByText("Your assistant here.").waitFor({ timeout: 15000 });
  await readyToSend(f.page);
  const pop = await whoMenu(f.page);
  assert.match(await pop.innerText(), /Who answers in this conversation[\s\S]*Branch[\s\S]*Ledger[\s\S]*Scout/i);
  await pop.locator(`[data-act="who"][data-v="${f.scout.id}"]`).click();
  await send(f.page, "Has the price moved?");
  await f.page.waitForFunction(() => /Scout here\./.test([...document.querySelectorAll("#conversation .b")].at(-1)?.textContent ?? ""), null, { timeout: 15000 });
  // WINDOW BUG: public/app/chat/chat.js bot() draws Branch's own mark beside every reply; the engine names each reply's
  // Trunk (GET /api/trunks/conversations/<id> authors) and the window never reads it.
  assert.equal(await signed(lastReply(f.page)), true, "Scout's reply carries Scout's face");
  await readyToSend(f.page);
  // Back to your assistant: the next reply is not Scout's, and Scout's reply keeps its name.
  await (await whoMenu(f.page)).locator('[data-act="who"][data-v=""]').click();
  await send(f.page, "And you?");
  await f.page.waitForFunction(() => /Your assistant here\./.test([...document.querySelectorAll("#conversation .b")].at(-1)?.textContent ?? ""), null, { timeout: 15000 });
  await readyToSend(f.page);
  const signs = await f.page.$$eval("#conversation .b", (nodes) => nodes.map((node) => Boolean(node.querySelector(".gut .av:not(.brand)"))));
  assert.equal(signs.filter(Boolean).length, 1, "only Scout's reply carries Scout's face");
  assert.deepEqual(f.errors, []);
});

test("@ in the message box: the list offers the Trunks, Enter picks one, and sending makes it answer here", async (t) => {
  const f = await fixture(t, ["conversations"]);
  await send(f.page, "hello");
  await f.page.waitForFunction(() => /Your assistant here\./.test(document.getElementById("conversation").textContent));
  await readyToSend(f.page);
  await f.page.locator("#prompt").fill("");
  await f.page.locator("#prompt").pressSequentially("@");
  const list = f.page.locator('.pop:has([data-act="mention-pick"])');
  await list.waitFor({ state: "visible" });
  assert.match(await list.innerText(), /Call a Trunk[\s\S]*Ledger[\s\S]*Keeps the books[\s\S]*Scout[\s\S]*Finds things/i);
  const first = await list.locator('[data-act="mention-pick"]').first().getAttribute("data-v");
  await f.page.locator("#prompt").press("Enter");
  assert.equal(await f.page.locator("#prompt").inputValue(), `@${first} `, "Enter picks, it does not send");
  await f.page.locator("#prompt").pressSequentially("what now?");
  await f.page.locator("#prompt").press("Enter");
  // WINDOW BUG: public/app/chat/chat.js send() posts the "@Name" message to POST /api/run as it is; nothing makes the Trunk answer.
  await f.page.waitForFunction((name) => document.getElementById("conversation").textContent.includes(`${name} here.`), first, { timeout: 15000 });
  const info = await f.call(`/api/trunks/conversations/${await openChat(f.page)}`);
  assert.equal(info.kind, "trunk");
  assert.equal(info.trunk.name, first);
  assert.deepEqual(f.errors, []);
});

test("a room opens as a conversation: signed replies, a question answered in place, and the mode it follows", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"], { width: 390, height: 844 });
  const room = (await f.call("/api/trunks/rooms", { name: "Price check", members: [f.scout.id, f.ledger.id] })).room;
  await f.call("/api/conversation-mode", { sessionId: room.sessionId, mode: "ask" });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "attached", timeout: 120000 });
  await f.page.locator('[data-act="side"]').first().click();
  await openRow(f.page, room.sessionId);
  // WINDOW BUG: public/app/chat/chat.js send() sends a room's message through POST /api/run like any conversation, so
  // the room's Trunks never answer (the engine's room route is POST /api/trunks/rooms/<id>/send, unused by public/app).
  await send(f.page, "@scout what is the price?");
  await f.page.waitForFunction(() => /Scout here, in the room\./.test(document.getElementById("conversation").textContent), null, { timeout: 15000 });
  assert.equal(await signed(lastReply(f.page)), true, "Scout's reply in the room carries Scout's face");
  // Ledger is not mentioned yet: mentioning it in the room asks it, and under Ask first it waits for a yes.
  await send(f.page, "@ledger write the totals");
  const ask = f.page.locator("#live-ask");
  await ask.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(written(f.app, "totals.csv"), false, "nothing written before the yes");
  await ask.locator(".btn.pri").click();
  await f.page.waitForFunction(() => /Written\./.test(document.getElementById("conversation").textContent), null, { timeout: 15000 });
  assert.equal(written(f.app, "totals.csv"), true);
  const width = await f.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(width, 0, "nothing overflows sideways at 390");
  assert.deepEqual(f.errors, []);
});

test.skip("bringing a second Trunk into a Trunk's conversation makes a room and opens it", async (t) => {
  // Redesign: replaced by the new window (a room is made from New room, data-act="grp-new", in Customize › Trunks and the + New menu; the prototype has no "Bring another Trunk in").
  const f = await fixture(t, ["conversations", "rooms"]);
  const started = await f.call("/api/trunks/conversations", { trunkId: f.scout.id });
  await f.page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, started.sessionId);
  await f.page.waitForFunction(() => document.getElementById("who-button")?.getAttribute("aria-label")?.includes("Scout"));
  await f.page.locator("#who-button").click();
  const pop = f.page.locator("#who-pop");
  assert.match(await pop.innerText(), /Bring another Trunk in[\s\S]*This makes a room with both of them/);
  await pop.getByRole("button", { name: /Ledger/ }).click();
  await f.page.waitForFunction(() => document.getElementById("conversation").dataset.room);
  assert.match(await f.page.locator("#who-button").getAttribute("aria-label"), /Scout, Ledger/);
  assert.equal(await f.page.locator("#thread-name").innerText(), "Scout and Ledger");
  assert.deepEqual(f.errors, []);
});

test.skip("a private room shows its people and shared artifacts in the conversation", async (t) => {
  // Redesign: replaced by the new window (the prototype draws a room as a plain conversation; it has no people-and-artifacts card).
  const f = await fixture(t, ["conversations", "rooms"]);
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  const room = (await f.call("/api/trunks/rooms", {
    name: "Private bench", members: [f.scout.id, f.ledger.id], people: [sam.id],
  })).room;
  await f.call(`/api/trunks/rooms/${room.id}/artifacts`, { name: "brief.txt", content: "private oak plan" });
  await f.page.evaluate(async () => globalThis.branchRooms.refresh());
  assert.equal(await f.page.evaluate((id) => globalThis.branchOpenRoom(id), room.id), true);
  const card = f.page.locator(".rooms-artifacts");
  await card.waitFor({ state: "visible" });
  assert.match(await card.innerText(), /People here: Sam[\s\S]*brief\.txt[\s\S]*Shared by Owner[\s\S]*private oak plan/);
  await card.locator(".rooms-artifact-name").fill("notes.txt");
  await card.locator(".rooms-artifact-content").fill("only this room");
  await card.getByRole("button", { name: "Share", exact: true }).click();
  await f.page.waitForFunction(() => document.querySelector(".rooms-artifacts")?.textContent?.includes("only this room"));
  assert.equal(await card.locator(".rooms-artifact-name").inputValue(), "", "sharing clears the artifact name");
  assert.equal(await card.locator(".rooms-artifact-content").inputValue(), "", "sharing clears the artifact content");
  assert.deepEqual(f.errors, []);
});

test.skip("an idle open room refreshes when another participant shares an artifact", async (t) => {
  // Redesign: replaced by the new window (the prototype draws a room as a plain conversation; it has no artifacts card to keep a draft in).
  const f = await fixture(t, ["conversations", "rooms"]);
  const room = (await f.call("/api/trunks/rooms", { name: "Live bench", members: [f.scout.id, f.ledger.id] })).room;
  await f.page.evaluate(async () => globalThis.branchRooms.refresh());
  assert.equal(await f.page.evaluate((id) => globalThis.branchOpenRoom(id), room.id), true);
  await f.page.waitForFunction(() => document.getElementById("conversation")?.dataset.room);
  const name = f.page.locator(".rooms-artifact-name"), content = f.page.locator(".rooms-artifact-content");
  await name.fill("unfinished.txt");
  await content.fill("still writing this");
  await content.focus();
  await f.call(`/api/trunks/rooms/${room.id}/artifacts`, { name: "from-sam.txt", content: "shared while idle" });
  await f.page.waitForFunction(() => document.querySelector(".rooms-artifacts")?.textContent?.includes("shared while idle"), null, { timeout: 5000 });
  assert.equal(await name.inputValue(), "unfinished.txt", "a live update keeps the local artifact name draft");
  assert.equal(await content.inputValue(), "still writing this", "a live update keeps the local artifact content draft");
  assert.equal(await content.evaluate((node) => document.activeElement === node), true, "a live update keeps the typing focus");
  assert.deepEqual(f.errors, []);
});

test("the owner can revoke a person's access to an existing room", async (t) => {
  // Redesign: replaced by the new window (the prototype sets a room's people once, in New room; it has no "Change who may
  // enter" row), so the owner's change goes through the engine's room route (POST /api/trunks/rooms/<id> {people}); what
  // Sam may reach afterwards is checked from Sam's side, in the engine and in the window.
  const f = await fixture(t, ["conversations", "rooms"]);
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  const room = (await f.call("/api/trunks/rooms", {
    name: "Private bench", members: [f.scout.id, f.ledger.id], people: [sam.id],
  })).room;
  assert.deepEqual((await f.call(`/api/trunks/rooms/${room.id}`)).people.map((one) => one.id ?? one), [sam.id]);
  await f.call(`/api/trunks/rooms/${room.id}`, { people: [] });
  assert.deepEqual((await f.call(`/api/trunks/rooms/${room.id}`)).people, []);

  await f.call("/api/profiles/switch", { profileId: sam.id, pin: "1234" });
  const refused = await f.callRaw(`/api/trunks/conversations/${room.sessionId}`);
  assert.ok([400, 403].includes(refused.status), `the room is refused to Sam once access is revoked (${refused.status})`);
  assert.doesNotMatch(JSON.stringify(refused.body), /Private bench/);
  assert.equal(((await f.call("/api/trunks")).rooms ?? []).some((one) => one.id === room.id), false, "and it is not among Sam's rooms");
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  assert.equal(await f.page.locator(`#side .list [data-act="chat"][data-id="${room.sessionId}"]`).count(), 0, "nor in Sam's side list");
  assert.doesNotMatch(await f.page.locator("#side").innerText(), /Private bench/);
  await f.call("/api/profiles/switch", { profileId: null });
  assert.deepEqual(f.errors, []);
});

test("a named household member can open only a room they belong to in the real window", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  const room = (await f.call("/api/trunks/rooms", {
    name: "Sam's room", members: [f.scout.id, f.ledger.id], people: [sam.id],
  })).room;
  await f.call(`/api/trunks/rooms/${room.id}/artifacts`, { name: "brief.txt", content: "members only" });
  const owners = (await f.call("/api/trunks/rooms", { name: "Owner's room", members: [f.scout.id, f.ledger.id] })).room;
  await f.call("/api/profiles/switch", { profileId: sam.id, pin: "1234" });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  // WINDOW BUG: public/app/shell/shell.js list() draws rows from GET /api/sessions only; for a household person that is
  // empty, and the rooms they belong to (GET /api/trunks rooms) never get a row, so Sam cannot open their room.
  await openRow(f.page, room.sessionId);
  assert.equal(await f.page.locator(`#side .list [data-act="chat"][data-id="${owners.sessionId}"]`).count(), 0, "a room Sam is not in is not listed");
  // Redesign: replaced by the new window (the prototype has no room people-and-artifacts card, and signs no one's own
  // messages), so "People here: Sam … members only" and the "Sam" under the message are not looked for.
  // WINDOW BUG: public/app/chat/chat.js send() sends a room's message through POST /api/run, so the room never answers.
  await send(f.page, "@scout hello from Sam");
  await f.page.waitForFunction(() => /Scout here, in the room\./.test(document.getElementById("conversation").textContent), null, { timeout: 15000 });
  assert.deepEqual(f.errors, []);
});
