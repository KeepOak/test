/**
 * R17-A: the Trunks screens, opened the way a person opens them, at 400 px wide, in a headless
 * browser against a scratch workspace.
 * Redesign: pointed at the new window (public/app, design/redesign/prototype.html pass 17). The Trunks card of
 * Customize › Specialists is now Customize › Trunks; the three-field create is the prototype's one-click "A new Trunk"
 * ("Trunk N for now") followed by its editor; rooms are the prototype's "New group chat"; the roster is the
 * sidebar's conversation list, where a Trunk's conversation is a row with its face.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { brain } from "./trunks-helpers.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PROTOTYPE = new URL("../design/redesign/prototype.html", import.meta.url);

async function fixture(t, rules = [], { width = 400, height = 900 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunks-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain(rules) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  // Onboarding is marked done through the engine, and the update question answered, so neither covers the window.
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(server.url + "/");
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side .nav[data-v="customize"]').waitFor({ state: "attached", timeout: 120000 });
  };
  return { app, server, call, page, errors, open };
}

/* At this width the sidebar is folded away, so it is slid open first, as a person would (the head's menu button). */
async function sidebar(page, selector) {
  const control = page.locator(selector).first();
  await control.waitFor({ state: "attached" });
  const folded = () => page.evaluate(() => matchMedia("(max-width: 760px)").matches && !document.getElementById("app").classList.contains("side-open"));
  if (await folded()) await page.locator('button[data-act="side"]:visible').first().click();
  // It slides in: wait until it has arrived.
  await page.waitForFunction(() => Math.abs(document.getElementById("side").getBoundingClientRect().left) < 1);
  await control.waitFor({ state: "visible" });
  return control;
}
async function place(page, name, tab) {
  await (await sidebar(page, `#side .nav[data-v="${name}"]`)).click();
  await page.locator("#main .place h1").first().waitFor();
  if (tab) {
    await page.locator(`.tab[data-act="ptab"][data-place="${name}"][data-v="${tab}"]`).click();
    await page.waitForFunction(({ name, tab }) => document.querySelector(`.tab[data-place="${name}"][data-v="${tab}"]`)?.getAttribute("aria-selected") === "true", { name, tab });
  }
}
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const greyed = async (locator) => ({
  disabled: await locator.getAttribute("aria-disabled"),
  soon: await locator.evaluate((node) => node.classList.contains("soon")),
  tip: await locator.getAttribute("data-tip"),
});
const GREY = { disabled: "true", soon: true, tip: "Coming soon" };
/* The words as written (textContent): a heading styled in capitals is still the prototype's own words. */
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
/* Words the locale files keep the same in French (a name such as "Trunks"): those may read the same in both. */
async function sameInFrench() {
  const read = async (code) => JSON.parse(await readFile(new URL(`../public/locales/${code}.json`, import.meta.url), "utf8"));
  const [en, fr] = [await read("en"), await read("fr")];
  return new Set(Object.keys(en).filter((key) => typeof en[key] === "string" && en[key] === fr[key]).map((key) => en[key]));
}

test("every word on the Trunks screens is the prototype's, in English and then in French", async (t) => {
  const f = await fixture(t);
  const { trunk } = await f.call("/api/trunks", { name: "Ada", title: "Planner", description: "" });
  await f.open();
  const prototype = await readFile(PROTOTYPE, "utf8");
  const english = await trunkWords(f.page, trunk);
  assert.ok(english.length > 20, `${english.length} words`);
  const missing = [...new Set(english)].filter((word) => !prototype.includes(word));
  assert.deepEqual(missing, [], "no word on the Trunks screens that the prototype does not have");
  assert.deepEqual(f.errors, []);
  /* French: Settings › Appearance › Language (the prototype's, with Français), and the design says every screen switches
     with it (BRANCH-DESIGN-INTENT.md, stand-in notes: "translate every screen"). */
  await (await sidebar(f.page, '#side [data-act="view"][data-v="settings"]')).click();
  await f.page.locator('.set-nav [data-act="setpage"][data-v="appearance"]').click();
  await f.page.locator("#lang").selectOption("fr");
  await f.page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.equal((await f.call("/api/look")).language, "fr", "the engine keeps the choice");
  await f.page.locator(".set-back").click();
  const french = await trunkWords(f.page, trunk);
  assert.equal(french.length, english.length, "the same screens, the same places");
  assert.deepEqual(f.errors, []);
  const same = await sameInFrench();
  const unchanged = english.filter((word, i) => word === french[i] && !same.has(word));
  assert.deepEqual(unchanged, [], "window bug: the Trunk screens (Customize › Trunks, the Trunk editor, New group chat) stay in English after choosing Français");
});

/* Every word the Trunks screens draw, in order: the Trunks tab, the Trunk editor's two tabs, and New group chat. Found by
   what each control does, never by its words, so the same list can be read again in another language. */
async function trunkWords(page, trunk) {
  const words = [];
  await place(page, "customize", "trunks");
  const card = page.locator("#main .place");
  words.push(...await card.locator(".tabs .tab").evaluateAll((tabs) => tabs.map((tab) => tab.firstChild.textContent.trim())));
  for (const control of ['[data-act="chat"][data-id="new"]', '[data-act="grp-new"]', ".sec h2", '[data-act="tmpl"]', `[data-act="edit"][data-id="${trunk.id}"]`, `[data-act="pausetrunk"][data-id="${trunk.id}"]`])
    words.push(...await texts(card.locator(control).first()));
  await card.locator(`[data-act="edit"][data-id="${trunk.id}"]`).click();
  const editor = page.locator(".dlg");
  await editor.locator('[data-act="st-tab"][data-v="may"]').waitFor();
  words.push(...await texts(editor.locator('[role="tab"]')), ...await texts(editor.locator("label")), ...await texts(editor.locator(".dlg-f .btn")));
  await editor.locator('[data-act="st-tab"][data-v="may"]').click();
  await editor.locator("#tm-read").waitFor();
  words.push(...await texts(editor.locator(".ctl > b")), ...await texts(editor.locator(".ctl small")));
  await editor.locator('.dlg-f [data-act="dlg-close"]').click();
  await place(page, "customize", "trunks");
  await page.locator('[data-act="grp-new"]').click();
  const group = page.locator(".dlg");
  await group.locator("#grp-name").waitFor();
  words.push(...await texts(group.locator(".dlg-h h2")), ...await texts(group.locator(".fld > span:first-child")), ...await texts(group.locator(".ctl > b")), ...await texts(group.locator(".dlg-f .btn")));
  await group.locator('.dlg-f [data-act="dlg-close"]').click();
  return words.filter(Boolean);
}

test("renaming the active Trunk updates the shell target immediately", async (t) => {
  const f = await fixture(t);
  const { trunk } = await f.call("/api/trunks", { name: "Ada", title: "", description: "" });
  await f.app.trunks.introduced();
  await f.open();
  await (await sidebar(f.page, `#side .row[data-id="${trunk.chatSessionId}"]`)).click();
  await f.page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", trunk.chatSessionId);
  await f.page.locator('[data-act="chatmenu"]:visible').first().click();
  await f.page.locator(".pop").getByRole("menuitem", { name: "Edit Trunk…" }).click();
  const editor = f.page.locator(".dlg");
  await editor.getByRole("heading", { name: "Edit Ada" }).waitFor();
  await editor.locator("#st-name").fill("Ada Bloom");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal(f.app.trunks.records.list()[0].name, "Ada Bloom");
  // The conversation's own menu is Ada Bloom's at once, without a reload.
  await f.page.locator('[data-act="chatmenu"]:visible').first().click();
  await f.page.locator(".pop").getByRole("menuitem", { name: "Edit Trunk…" }).click();
  await f.page.locator(".dlg").getByRole("heading", { name: "Edit Ada Bloom" }).waitFor();
  await f.page.locator(".dlg").getByRole("button", { name: "Cancel" }).click();
  assert.deepEqual(f.errors, []);
  /* Redesign: the owner took the face and the name out of the title-bar row; the header keeps the conversation's name as
     its accessible heading (and the list's row shows it). That heading still names the Trunk, renamed at once. */
  const header = f.page.locator('.titlebar .head .who[role="heading"] > b').first();
  await f.page.waitForFunction(() => [...document.querySelectorAll('.titlebar .head .who[role="heading"] > b')].some((b) => b.textContent === "Ada Bloom"), undefined, { timeout: 5000 }).catch(() => undefined);
  assert.equal(await header.textContent(), "Ada Bloom", "window bug: a Trunk's conversation header names its first message, not the Trunk");
});

const rules = [({ last, system }) => {
  const text = last?.content ?? "";
  if (text.startsWith("[Room") && /\nYou are Ada \(@ada\)/.test(system)) return "I can do it. @you which day?";
  if (text.startsWith("[Room")) return "(pass)";
  return null;
}];

test("the card, the three-field create, Edit Trunk, a room, the roster and @ in the message box, with nothing scrolling sideways", async (t) => {
  const f = await fixture(t, rules);
  const { page, app } = f;
  await f.open();
  const until = async (check) => { for (let i = 0; i < 200 && !(await check()); i++) await page.waitForTimeout(50); };

  // The card: Customize › Trunks, empty until a Trunk is made.
  await place(page, "customize", "trunks");
  const card = page.locator("#main .place");
  assert.equal(await card.locator("h1").innerText(), "Customize");
  assert.equal(await card.locator('.tab[data-v="trunks"]').getAttribute("aria-selected"), "true");
  assert.equal(await card.locator('.prow [data-act="edit"]').count(), 0, "no Trunk yet");
  assert.equal(await wide(page), false, "no sideways scrolling in Customize");

  // The create: "A new Trunk" makes "Trunk 1" and opens its conversation; its name and what it is for come from its editor.
  await card.getByRole("button", { name: "A new Trunk" }).click();
  await until(async () => app.trunks.records.list().length === 1);
  const made = app.trunks.records.list()[0];
  assert.equal(made.name, "Trunk 1");
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", made.chatSessionId);
  await app.trunks.introduced();

  // Edit Trunk opens its fields.
  // Redesign: the prototype's editor (editTrunk) has Look (name, what it's for, colour, shape, photo, movement, eyes), What
  // it may do, and pass 17's Its computers (itsComputers): no model, reasoning, instructions, skills or channels fields,
  // which the old editor had.
  await place(page, "customize", "trunks");
  await card.locator(`[data-act="edit"][data-id="${made.id}"]`).click();
  const editor = page.locator(".dlg");
  await editor.getByRole("heading", { name: "Edit Trunk 1" }).waitFor();
  const editorTabs = await texts(editor.locator('[role="tab"]'));
  for (const id of ["st-name", "st-role"]) assert.equal(await editor.locator(`#${id}`).count(), 1, id);
  // Trunk look: the photo is a button that uploads through POST /api/trunks/{id}/avatar, not a bare file field.
  assert.equal(await editor.locator('[data-act="st-photo"]').count(), 1, "st-photo");
  assert.equal(await editor.locator('[data-act="st-colour"]').count(), 8, "the prototype's eight colours");
  assert.equal(await editor.locator('[data-act="st-shape"]').count(), 5, "its five shapes");
  await editor.locator("#st-name").fill("Ada");
  await editor.locator("#st-role").fill("Planner");
  // Redesign: what a Trunk may do stays greyed in the window: loosening a Trunk is held for separate security review.
  await editor.getByRole("tab", { name: "What it may do" }).click();
  assert.deepEqual(await greyed(editor.locator("#tm-read")), GREY);
  assert.equal(await editor.locator("#tm-read").isDisabled(), true);
  assert.deepEqual(await greyed(editor.getByRole("button", { name: "Ask first" })), GREY);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await until(async () => app.trunks.records.list()[0].name === "Ada");
  const ada = app.trunks.records.list()[0];
  assert.deepEqual([ada.name, ada.title, ada.handle], ["Ada", "Planner", "ada"]);
  await card.locator(".prow").filter({ hasText: "Ada" }).first().waitFor();
  assert.equal(await wide(page), false, "no sideways scrolling in the editor");

  // The roster: Ada's conversation is a row in the sidebar's list, with her face.
  // Redesign: the prototype has no separate Trunks roster above Recents, no Trunks tab in the sidebar and no unread count
  // badge on a Trunk; a Trunk's conversation is a row in the one list (rowHtml), with a dot while unread.
  const row = await sidebar(page, `#side .row[data-id="${ada.chatSessionId}"]`);
  assert.equal(await row.locator(".avw .av").count(), 1, "the row has her face");
  await page.keyboard.press("Escape");

  // A room: two Trunks, one @you.
  const { trunk: bo } = await f.call("/api/trunks", { name: "Bo", title: "", description: "" });
  await app.trunks.introduced();
  await place(page, "customize", "trunks");
  await card.getByRole("button", { name: "A new room" }).click();
  const group = page.locator(".dlg");
  await group.getByRole("heading", { name: "New group chat" }).waitFor();
  await group.locator("#grp-name").fill("Trip");
  await group.locator('[data-act="grp-pick"]').filter({ hasText: "Ada" }).click();
  await group.locator('[data-act="grp-pick"]').filter({ hasText: "Bo" }).click();
  assert.equal(await group.locator("#grp-name").inputValue(), "Trip", "the name is kept while picking");
  await group.getByRole("button", { name: "Start the group chat" }).click();
  await group.waitFor({ state: "detached" });
  await until(async () => app.trunks.rooms.list().length === 1);
  const room = app.trunks.rooms.list()[0];
  assert.deepEqual([...room.members].sort(), [ada.id, bo.id].sort());
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", room.sessionId);
  // A message goes to the room once the window knows this conversation is one (GET /api/trunks/conversations/<id>).
  const roomKnown = () => page.evaluate(async () => (await import("/app/chat/plus.js")).whoHere()?.kind === "room");
  await until(roomKnown);
  assert.equal(await roomKnown(), true, "the window knows it is a room");
  await page.locator("#prompt").fill("Where shall we go?");
  await page.locator("#prompt").press("Enter");
  await until(async () => app.store.messages(room.sessionId).some((m) => m.content === "Where shall we go?"));
  await app.trunks.rooms.settled(room.id);
  const reply = page.locator("#main .b").filter({ hasText: "I can do it. @you which day?" }).first();
  await reply.waitFor({ timeout: 30000 });
  assert.equal(await reply.locator(".from").innerText(), "Ada", "the reply is signed with who wrote it");
  assert.equal(await reply.locator(".txt").innerText(), "I can do it. @you which day?", "without its @handle prefix");
  assert.equal(await wide(page), false, "no sideways scrolling with a room open");
  // Redesign: the prototype has no "Reply to @ada" button on a room's reply and no Inbox card "Rooms that need you"; a
  // conversation waiting for you is marked in its own row (rowHtml: p.attn, statusLine "Waiting for you"), checked below.

  // "@" in the message box offers the Trunks; "@Ada …" goes to Ada.
  await (await sidebar(page, '#side [data-act="newmenu"]')).click();
  await page.locator(".pop").getByRole("menuitem", { name: "New conversation" }).click();
  await page.locator("#prompt").click();
  await page.locator("#prompt").pressSequentially("@ad");
  await page.locator('.pop [data-act="mention-pick"][data-v="Ada"]').waitFor();
  assert.equal(await page.locator(".pop .ph").first().textContent(), "Call a Trunk", "the list is headed as the prototype's");
  await page.locator("#prompt").press("Enter");
  assert.equal(await page.locator("#prompt").inputValue(), "@Ada ", "the prototype's mention-pick puts in the name");
  await page.locator("#prompt").pressSequentially("hello there");
  await page.locator("#prompt").press("Enter");
  await until(async () => app.store.messages(ada.chatSessionId).some((m) => m.content === "hello there"));
  assert.ok(app.store.messages(ada.chatSessionId).some((m) => m.content === "hello there"), "the message went to Ada's own conversation");
  assert.equal(await wide(page), false, "no sideways scrolling in the conversation");
  assert.deepEqual(f.errors, []);

  // "Needs you": the room's @you. The prototype marks a waiting conversation's line in its row (rowHtml, p.attn).
  assert.equal(app.trunks.rooms.list()[0].needsYou, true, "the engine says the room needs you");
  const roomRow = await sidebar(page, `#side .row[data-id="${room.sessionId}"]`);
  const seen = { roomMarked: await roomRow.locator("p.attn").count(), editorTabs };
  assert.deepEqual(seen, { roomMarked: 1, editorTabs: ["Look", "What it may do", "Its computers"] },
    "window bug: a room that needs you (GET /api/trunks rooms[].needsYou) is not marked in its row; the Trunk editor has no Its computers tab (prototype itsComputers, pass 17)");
});
