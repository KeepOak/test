/* Redesign: Edit Trunk › Look shows only what the chosen face is drawn with (core/ui.js av). The classic pebble takes
   Colour, Shape, How it moves and Eyes; a character takes only Colour (the glow behind it) and says it moves by itself;
   an emoji face and a photo take Colour, Shape and How it moves, with no eyes. Name, What it's for and the photo control
   are always there. What is hidden keeps its value: switching back to the classic pebble shows it again, Shuffle leaves
   it alone, and Save keeps it. Each control shown is proved to change that face's preview. Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const ALL = ["colour", "shape", "moves", "eyes"];
const KINDS = { pebble: ALL, character: ["colour"], emoji: ["colour", "shape", "moves"], photo: ["colour", "shape", "moves"] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-look-kinds-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await call("/api/trunks", { name: "Kinds", title: "Test", description: "" });
  await app.trunks.introduced();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const saved = async () => (await call("/api/trunks")).trunks.find((x) => x.id === trunk.id);
  return { page, errors, trunk, saved };
}

async function openEditor(page, id) {
  await page.locator('#side [data-act="view"][data-v="customize"]').first().click();
  await page.locator(`.prow [data-act="edit"][data-id="${id}"]`).click();
  await page.waitForSelector(".dlg .editor");
}
/* Which of the face's controls the Look tab shows, and whether the always-there ones and the hint are there. */
const shown = (page) => page.evaluate(() => {
  const has = (sel) => document.querySelectorAll(`.dlg ${sel}`).length > 0;
  return { colour: has('[data-act="st-colour"]'), shape: has('[data-act="st-shape"]'), moves: has('[data-act="st-anim"]'), eyes: has('[data-act="st-eyes"]'),
    always: has("#st-name") && has("#st-role") && has('[data-act="st-photo"]') && has('[data-act="emo15"]') && has('[data-act="look-set"]'),
    hint: /never pick an animation/.test(document.querySelector(".dlg .looks-tl")?.previousElementSibling?.textContent ?? "") };
});
async function expectKind(page, kind) {
  const got = await shown(page);
  const want = Object.fromEntries(ALL.map((k) => [k, KINDS[kind].includes(k)]));
  assert.deepEqual({ colour: got.colour, shape: got.shape, moves: got.moves, eyes: got.eyes }, want, `${kind}: exactly its controls`);
  assert.ok(got.always, `${kind}: Name, What it's for, the photo, the emoji and the characters are always there`);
  assert.equal(got.hint, kind === "character", `${kind}: "You never pick an animation" only for a character`);
}
const pressed = (page, act) => page.evaluate((a) => document.querySelector(`.dlg [data-act="${a}"][aria-pressed="true"]`)?.dataset.v ?? null, act);
/* A choice saved at once (a character, an emoji, a photo) redraws the editor; wait for the face it gives. */
const pick = async (page, v, face) => {
  await page.locator(`.dlg .look-c12[data-v="${v}"]`).click();
  await page.waitForSelector(`.dlg .look-c12[data-v="${v}"][aria-pressed="true"]`);
  await page.waitForSelector(`.dlg .editor .big ${face}`);
};
const big = (page, fn) => page.$eval(".dlg .editor .big .av", fn);

test("Edit Trunk › Look: each face shows exactly the controls it is drawn with, and hidden ones keep their values", async (t) => {
  const { page, errors, trunk, saved } = await fixture(t);
  await openEditor(page, trunk.id);

  /* The classic pebble: every control, no "you never pick an animation". A draft over it. */
  await expectKind(page, "pebble");
  const colour = await page.locator('.dlg [data-act="st-colour"]').nth(3).getAttribute("data-v");
  await page.locator(`.dlg [data-act="st-colour"][data-v="${colour}"]`).click();
  await page.locator('.dlg [data-act="st-shape"][data-v="2"]').click();
  await page.locator('.dlg [data-act="st-anim"][data-v="sway"]').click();
  await page.locator('.dlg [data-act="st-eyes"][data-v="wide"]').click();

  /* A character: Colour only (it tints the glow behind the character), and the moves-by-itself sentence. */
  await pick(page, "kite", ".av.look12");
  await expectKind(page, "character");
  const glow = await big(page, (el) => getComputedStyle(el).backgroundImage);
  await page.locator('.dlg [data-act="st-colour"]').nth(0).click();
  assert.notEqual(await big(page, (el) => getComputedStyle(el).backgroundImage), glow, "character: Colour changes the glow behind it");
  await page.locator(`.dlg [data-act="st-colour"][data-v="${colour}"]`).click();

  /* Back to the classic pebble: the draft is all there again, nothing reset. */
  await pick(page, "classic", ".av.pbl");
  await expectKind(page, "pebble");
  assert.deepEqual([await pressed(page, "st-colour"), await pressed(page, "st-shape"), await pressed(page, "st-anim"), await pressed(page, "st-eyes")], [colour, "2", "sway", "wide"], "the pebble's draft comes back");
  await page.locator('.dlg [data-act="st-save"]').click();
  await page.waitForSelector(".dlg", { state: "detached" });
  let now = await saved();
  assert.deepEqual([now.look.shape, now.look.motion, now.eyes], ["leaf", "sway", "wide"], "the pebble's look saves");

  /* A character again: Shuffle and Save leave the hidden shape, eyes and motion as they were. */
  await openEditor(page, trunk.id);
  await pick(page, "kite", ".av.look12");
  for (let i = 0; i < 6; i++) await page.locator('.dlg [data-act="st-shuffle"]').click();
  await page.locator('.dlg [data-act="st-save"]').click();
  await page.waitForSelector(".dlg", { state: "detached" });
  now = await saved();
  assert.deepEqual([now.character, now.look.shape, now.look.motion, now.eyes], ["kite", "leaf", "sway", "wide"], "hidden controls keep their saved values");

  /* An emoji face: Colour, Shape and How it moves, which each change it; it has no eyes. */
  await openEditor(page, trunk.id);
  await pick(page, "classic", ".av.pbl");
  await page.locator('.dlg [data-act="emo15"][data-v="🦊"]').click();
  await page.waitForSelector(".dlg .editor .big .av.emoji15");
  await expectKind(page, "emoji");
  assert.equal(await page.locator(".dlg .editor .big .av.emoji15 .eye").count(), 0, "emoji: no eyes are drawn");
  const shapeOf = () => big(page, (el) => getComputedStyle(el.querySelector(".peb")).borderRadius);
  await page.locator('.dlg [data-act="st-shape"][data-v="0"]').click();
  const round = await shapeOf();
  await page.locator('.dlg [data-act="st-shape"][data-v="4"]').click();
  assert.notEqual(await shapeOf(), round, "emoji: Shape changes its outline");
  await page.locator('.dlg [data-act="st-anim"][data-v="none"]').click();
  assert.equal(await big(page, (el) => getComputedStyle(el).animationName), "none");
  await page.locator('.dlg [data-act="st-anim"][data-v="sway"]').click();
  assert.equal(await big(page, (el) => getComputedStyle(el).animationName), "bobav", "emoji: How it moves moves it");

  /* A character over the emoji, then the classic pebble: the face is the emoji again, and so are the controls. */
  await pick(page, "kite", ".av.look12");
  await expectKind(page, "character");
  await pick(page, "classic", ".av.emoji15");
  await expectKind(page, "emoji");

  /* A photo: Colour, Shape and How it moves (it sits on the pebble's colour and shape), no eyes; Remove gives the emoji back. */
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator('.dlg [data-act="st-photo"]').click()]);
  await chooser.setFiles({ name: "face.png", mimeType: "image/png", buffer: PNG });
  await page.waitForSelector(".dlg .editor .big .av.photo-tl");
  await expectKind(page, "photo");
  assert.equal(await page.locator('.dlg [data-act="st-photo-x"]').count(), 1, "photo: Remove is there");
  await page.locator('.dlg [data-act="st-shape"][data-v="0"]').click();
  const photoRound = await shapeOf();
  await page.locator('.dlg [data-act="st-shape"][data-v="3"]').click();
  assert.notEqual(await shapeOf(), photoRound, "photo: Shape changes its outline");
  await page.locator('.dlg [data-act="st-photo-x"]').click();
  await page.waitForSelector(".dlg .editor .big .av.emoji15");
  await expectKind(page, "emoji");
  assert.deepEqual(errors, []);
});
