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
  if (text.startsWith("[Room") && text.includes("Branch followup")) return { content: `${who} answers the branch.`, toolCalls: [] };
  if (last?.role === "tool") return { content: "Written.", toolCalls: [] };
  if (text.startsWith("[Room") && who === "Ledger")
    return { content: "", toolCalls: [{ id: `w${Math.random().toString(36).slice(2, 7)}`, name: "files.write", arguments: JSON.stringify({ path: "totals.csv", content: "x" }) }] };
  if (text.startsWith("[Room")) return { content: `${who} here, in the room.`, toolCalls: [] };
  return { content: who ? `${who} here.` : "Your assistant here.", toolCalls: [] };
} };

async function fixture(t, parts, { width = 1440, height = 950, off = [] } = {}) {
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
  for (const part of off) await call("/api/trunks/switch", { part, mode: "off" });
  const scout = (await call("/api/trunks", { name: "Scout", title: "Finds things" })).trunk;
  const ledger = (await call("/api/trunks", { name: "Ledger", title: "Keeps the books" })).trunk;
  await app.trunks.introduced();
  const page = await (await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  return { app, call, callRaw, page, errors, scout, ledger, home: app.trunks.ownerDefault() };
}
const send = async (page, text) => { await page.locator("#prompt").fill(text); await page.locator("#prompt").press("Enter"); };

test("room branching retains a rejected name, then opens a real room whose two seats answer", async (t) => {
  const f = await fixture(t, ["rooms"]);
  const room = (await f.call("/api/trunks/rooms", { name: "QA path", members: [f.scout.id, f.ledger.id] })).room;
  f.app.store.message(room.sessionId, { role: "user", content: "QA branch checkpoint" });
  f.app.store.message(room.sessionId, { role: "assistant", content: "@scout: QA branch reply" });
  const before = JSON.stringify(f.app.store.sessionView(f.app.runtime.owner, room.sessionId));
  const paths = await f.call(`/api/sessions/${room.sessionId}/paths`);
  await f.call("/api/trunks/rooms", { name: "QA fork", members: [f.scout.id, f.ledger.id] });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible" });
  await openRow(f.page, room.sessionId);
  const reply = f.page.locator("#conversation .b").filter({ hasText: "QA branch reply" }).first();
  await reply.hover();
  await reply.getByRole("button", { name: "Branch from here", exact: true }).click();
  const dlg = f.page.locator(".dlg");
  await dlg.locator("#br-name17c").fill("QA fork");
  await dlg.locator('[data-act="brmake17c"]').click();
  await dlg.getByRole("alert").waitFor({ state: "visible", timeout: 3000 });
  assert.match(await dlg.getByRole("alert").innerText(), /room already has that name/i);
  assert.equal(await dlg.locator("#br-name17c").inputValue(), "QA fork");
  assert.deepEqual(await f.call(`/api/sessions/${room.sessionId}/paths`), paths);
  await dlg.locator("#br-name17c").fill("QA fork 2");
  await dlg.locator('[data-act="brmake17c"]').click();
  await dlg.waitFor({ state: "hidden" });
  const made = f.app.trunks.rooms.list().find((r) => r.name === "QA fork 2");
  assert.ok(made);
  // The dialog closes before paths refresh and X.reopen finish; wait for the actual selected conversation.
  await f.page.waitForFunction((sessionId) =>
    document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id === sessionId, made.sessionId);
  assert.equal(await openChat(f.page), made.sessionId);
  await send(f.page, "Branch followup");
  await f.app.trunks.rooms.settled(made.id);
  await f.page.waitForFunction(() => document.querySelector("#conversation")?.textContent.includes("Ledger answers the branch."));
  assert.match(await f.page.locator("#conversation").innerText(), /Scout answers the branch/);
  assert.equal(JSON.stringify(f.app.store.sessionView(f.app.runtime.owner, room.sessionId)), before);
  assert.deepEqual(f.errors, []);
});
/* The reply is on screen before the window has finished that send (it reloads the conversation, then the state): the
   typing dots show until then. */
const readyToSend = (page) => page.waitForFunction(() => !document.querySelector("#conversation .typing"));
const lastReply = (page) => page.locator("#conversation .b").last();
/** The conversation open in the side list. */
const openChat = (page) => page.evaluate(() => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);
/* A Trunk's face beside a reply: not the neutral tile of a conversation with no Trunk (.none18c), nor older marks
   of Branch (.brand, or the "branch" character whose art is /art/branch-*). */
const TRUNK_FACE = '.gut .av:not(.brand):not(.none18c):not(:has([data-m17^="/art/branch-"]))';
/* A reply is signed by a Trunk when its face (not Branch's own mark) stands beside it. Its words stream in before its
   author is read (GET /api/trunks/conversations/<id>), so the face is waited for. */
const signedSoon = (reply) => reply.locator(TRUNK_FACE).first().waitFor({ state: "attached", timeout: 15000 }).then(() => true, () => false);
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
  // Choosing a Trunk for a conversation ships when needed (the ship-on rule); the owner switches it off here.
  const f = await fixture(t, [], { off: ["conversations"] });
  await send(f.page, "hello");
  await f.page.locator("#conversation").getByText(`${f.home.name} here.`, { exact: true }).waitFor({ timeout: 15000 });
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
  await f.page.locator("#conversation").getByText(`${f.home.name} here.`, { exact: true }).waitFor({ timeout: 15000 });
  await readyToSend(f.page);
  const pop = await whoMenu(f.page);
  assert.match(await pop.innerText(), /Who answers in this conversation[\s\S]*Branch[\s\S]*Ledger[\s\S]*Scout/i);
  await pop.locator(`[data-act="who"][data-v="${f.scout.id}"]`).click();
  await send(f.page, "Has the price moved?");
  await f.page.waitForFunction(() => /Scout here\./.test([...document.querySelectorAll("#conversation .b")].at(-1)?.textContent ?? ""), null, { timeout: 15000 });
  // WINDOW BUG: public/app/chat/chat.js bot() draws Branch's own mark beside every reply; the engine names each reply's
  // Trunk (GET /api/trunks/conversations/<id> authors) and the window never reads it.
  assert.equal(await signedSoon(lastReply(f.page)), true, "Scout's reply carries Scout's face");
  await readyToSend(f.page);
  // Back to your assistant: the next reply is not Scout's, and Scout's reply keeps its name.
  await (await whoMenu(f.page)).locator('[data-act="who"][data-v=""]').click();
  await send(f.page, "And you?");
  await f.page.waitForFunction((words) => [...document.querySelectorAll("#conversation .b")].at(-1)?.textContent.includes(words), `${f.home.name} here.`, { timeout: 15000 });
  await readyToSend(f.page);
  const scoutReply = f.page.locator("#conversation .b").filter({ hasText: "Scout here." });
  assert.equal(await scoutReply.locator(TRUNK_FACE).count(), 1, "Scout's earlier reply keeps its own face after the handback");
  assert.equal(await scoutReply.locator(`[data-rk="t:${f.home.id}"]`).count(), 0, "the earlier Scout reply is never relabeled as the default");
  assert.equal(await lastReply(f.page).locator(`[data-rk="t:${f.home.id}"]`).count(), 1, "the handback reply carries the default assistant's own face");
  assert.deepEqual(f.errors, []);
});

test("@ in the message box: the list offers the Trunks, Enter picks one, and sending makes it answer here", async (t) => {
  const f = await fixture(t, ["conversations"]);
  await send(f.page, "hello");
  await f.page.waitForFunction((words) => document.getElementById("conversation").textContent.includes(words), `${f.home.name} here.`);
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

test("a room send waits for its identity instead of becoming an ordinary task", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const room = (await f.call("/api/trunks/rooms", { name: "Loading room", members: [f.scout.id, f.ledger.id] })).room;
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "attached" });
  let release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const loading = new Promise((resolve) => { reached = resolve; });
  await f.page.route(`**/api/trunks/conversations/${room.sessionId}`, async (route) => {
    reached();
    await gate;
    await route.continue();
  });
  const posts = [];
  f.page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/run" || /\/send$|\/say$/.test(path))) posts.push(path);
  });
  await openRow(f.page, room.sessionId);
  await loading;
  try {
    await send(f.page, "@scout what is the price?");
    await f.page.locator("#prompt").press("Enter"); // repeated Enter cannot duplicate a held send
    // Leave the exact identity read pending while the Enter handler gets its turn.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(posts, [], "no task is sent before the room identity is known");
  } finally { release(); }
  await f.page.waitForFunction(() => /Scout here, in the room\./.test(document.getElementById("conversation").textContent));
  assert.deepEqual(posts, [`/api/trunks/rooms/${room.id}/send`]);
  const messages = f.app.store.sessionView(f.app.runtime.owner, room.sessionId).messages;
  assert.equal(messages.filter((m) => m.role === "user" && m.content === "@scout what is the price?").length, 1);
  assert.ok(messages.some((m) => m.role === "assistant" && m.content === "@scout: Scout here, in the room."));
  assert.deepEqual(f.errors, []);
});

test("a failed room identity read keeps the draft and retry sends to that room", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const room = (await f.call("/api/trunks/rooms", { name: "Retry room", members: [f.scout.id, f.ledger.id] })).room;
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "attached" });
  let fail = true;
  await f.page.route(`**/api/trunks/conversations/${room.sessionId}`, (route) => fail
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Test identity unavailable" }) })
    : route.continue());
  const posts = [];
  f.page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/run" || /\/send$|\/say$/.test(path))) posts.push(path);
  });
  await openRow(f.page, room.sessionId);
  await send(f.page, "@scout what is the price?");
  await f.page.getByText("Couldn't load this conversation. Your message was not sent. Try sending again.", { exact: true }).waitFor({ timeout: 5000 });
  assert.deepEqual(posts, []);
  assert.equal(await f.page.locator("#prompt").inputValue(), "@scout what is the price?");
  assert.equal(await openChat(f.page), room.sessionId);
  fail = false;
  await f.page.locator("#prompt").press("Enter");
  await f.page.waitForFunction(() => /Scout here, in the room\./.test(document.getElementById("conversation").textContent));
  assert.deepEqual(posts, [`/api/trunks/rooms/${room.id}/send`]);
  assert.deepEqual(f.errors, []);
});

test("a room identity timeout ends the wait and leaves the draft for a real retry", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const room = (await f.call("/api/trunks/rooms", { name: "Timeout room", members: [f.scout.id, f.ledger.id] })).room;
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "attached" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const path = `**/api/trunks/conversations/${room.sessionId}`;
  await f.page.route(path, async (route) => { await gate; await route.continue().catch(() => {}); });
  const posts = [];
  f.page.on("request", (request) => {
    const url = new URL(request.url()).pathname;
    if (request.method() === "POST" && (url === "/api/run" || /\/send$|\/say$/.test(url))) posts.push(url);
  });
  try {
    await openRow(f.page, room.sessionId);
    await send(f.page, "@scout what is the price?");
    await f.page.getByText("Couldn't load this conversation. Your message was not sent. Try sending again.", { exact: true }).waitFor({ timeout: 20_000 });
    assert.deepEqual(posts, []);
    assert.equal(await f.page.locator("#prompt").inputValue(), "@scout what is the price?");
  } finally { release(); }
  await f.page.unroute(path);
  await f.page.locator("#prompt").press("Enter");
  await f.page.waitForFunction(() => /Scout here, in the room\./.test(document.getElementById("conversation").textContent));
  assert.deepEqual(posts, [`/api/trunks/rooms/${room.id}/send`]);
  assert.deepEqual(f.errors, []);
});

test("switching rooms while identity loads never sends the old draft into the new room", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const first = (await f.call("/api/trunks/rooms", { name: "First room", members: [f.scout.id, f.ledger.id] })).room;
  const next = (await f.call("/api/trunks/rooms", { name: "Next room", members: [f.scout.id, f.ledger.id] })).room;
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "attached" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await f.page.route(`**/api/trunks/conversations/${first.sessionId}`, async (route) => { await gate; await route.continue(); });
  const posts = [];
  f.page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/run" || /\/send$|\/say$/.test(path))) posts.push(path);
  });
  try {
    await openRow(f.page, first.sessionId);
    await send(f.page, "@scout what is the price?");
    await openRow(f.page, next.sessionId);
  } finally { release(); }
  await f.page.getByText("The conversation changed. Your message was not sent.", { exact: true }).waitFor();
  assert.deepEqual(posts, []);
  assert.equal(await openChat(f.page), next.sessionId);
  assert.equal(await f.page.locator("#prompt").inputValue(), "");
  await openRow(f.page, first.sessionId);
  assert.equal(await f.page.locator("#prompt").inputValue(), "@scout what is the price?");
  await f.page.locator("#prompt").press("Enter");
  await f.page.waitForFunction(() => /Scout here, in the room\./.test(document.getElementById("conversation").textContent));
  assert.deepEqual(posts, [`/api/trunks/rooms/${first.id}/send`]);
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
  assert.equal(await signedSoon(lastReply(f.page)), true, "Scout's reply in the room carries Scout's face");
  // Ledger is not mentioned yet: mentioning it in the room asks it, and under Ask first it waits for a yes. Sent once the
  // window has finished the first send: sent sooner, it joins that send's waiting line instead.
  await readyToSend(f.page);
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

  /* The window starts again by itself when the person changes (public/app/main.js watchPerson); a reload of our own
     raced that one and was aborted, so the window's own restart is what is waited for. */
  const restarted = f.page.waitForEvent("framenavigated", { predicate: (frame) => frame === f.page.mainFrame(), timeout: 30000 });
  await f.call("/api/profiles/switch", { profileId: sam.id, pin: "1234" });
  const refused = await f.callRaw(`/api/trunks/conversations/${room.sessionId}`);
  assert.ok([400, 403].includes(refused.status), `the room is refused to Sam once access is revoked (${refused.status})`);
  assert.doesNotMatch(JSON.stringify(refused.body), /Private bench/);
  assert.equal(((await f.call("/api/trunks")).rooms ?? []).some((one) => one.id === room.id), false, "and it is not among Sam's rooms");
  await restarted;
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
  // The window starts again by itself when the person changes (public/app/main.js watchPerson): that restart is waited for.
  const restarted = f.page.waitForEvent("framenavigated", { predicate: (frame) => frame === f.page.mainFrame(), timeout: 30000 });
  await f.call("/api/profiles/switch", { profileId: sam.id, pin: "1234" });
  await restarted;
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

test("UI-032: on a new conversation the + menu picks a Trunk before the first message, and that Trunk answers it", async (t) => {
  const f = await fixture(t, ["conversations"]);
  await f.page.locator("#prompt").fill("Kept draft");
  const pop = await whoMenu(f.page);
  await pop.locator(`[data-act="who"][data-v="${f.scout.id}"]`).click();
  await f.page.waitForFunction(() => document.querySelector('#side .list [data-act="chat"][aria-current="true"]'), null, { timeout: 15000 });
  assert.equal(await f.page.locator("#prompt").inputValue(), "Kept draft", "the draft moves into the new conversation");
  await send(f.page, "Has the price moved?");
  await f.page.waitForFunction(() => /Scout here\./.test([...document.querySelectorAll("#conversation .b")].at(-1)?.textContent ?? ""), null, { timeout: 15000 });
  assert.deepEqual(f.errors, []);
});
