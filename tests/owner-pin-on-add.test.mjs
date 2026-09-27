/**
 * QA Q001: adding somebody to this computer asks the owner for their own PIN right there, so a child cannot simply
 * switch back to the owner. Skipping it is allowed only with the plain line that anyone at this computer can then switch
 * back. Once a PIN is set the engine asks for it on every switch back, and a household already here with no owner PIN
 * gets one notice in the person menu with the way to set one. Headless browser only; a scripted provider stands in for
 * every model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, signIn } from "./new-window-places.mjs";

const SKIP_LINE = /Anyone at this computer can switch back to you/;

async function fixture(t, { onboarded = true, seed } = {}) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-owner-pin-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello from Branch.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  if (onboarded) await call("/api/onboarding", { done: true });
  if (seed) seed(app);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  return { app, page, errors, call };
}

const personMenu = async (page) => { await page.locator('#side [data-act="owner"]').click(); return page.locator(".pop"); };
async function until(check, what) {
  for (let i = 0; i < 100; i += 1) { if (check()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(what);
}

async function fillInvite(page, { name, pin, own }) {
  const dlg = page.getByRole("dialog", { name: "Invite someone" });
  await dlg.waitFor();
  await dlg.locator("#inv-n").fill(name);
  await dlg.locator('[data-act="p-inv-role"][data-v="child"]').click();
  await dlg.locator("#inv-pin").fill(pin);
  if (own !== undefined) await dlg.locator("#inv-own").fill(own);
  await dlg.locator('[data-act="p-inv-go"]').click();
  return dlg;
}

test("adding a child asks for the owner's PIN right there; with it set, switching back asks for it", async (t) => {
  const f = await fixture(t);
  await (await personMenu(f.page)).locator('[data-act="invite"]').click();
  const dlg = f.page.getByRole("dialog", { name: "Invite someone" });
  await dlg.locator("#inv-own").waitFor();
  assert.match(await dlg.locator("#inv-own-note").innerText(), SKIP_LINE, "skipping it says what that means");
  assert.equal(await dlg.locator("#inv-own").getAttribute("aria-disabled"), null, "the owner's PIN box is live");
  await fillInvite(f.page, { name: "Sam", pin: "4821", own: "9753" });
  await until(() => f.app.store.profiles.ownerPinOn(), "the owner's PIN was set with the invite");
  assert.equal(f.app.store.profiles.list().length, 1);
  // "Ask for my PIN when switching back to me" shows on, from the engine.
  await f.page.locator('#main .place [data-act="ptab"][data-v="signin"]').click();
  await f.page.locator("#si-owner:checked").waitFor();
  // Switch to Sam, then back: the owner's PIN is asked for, and nothing switches without it.
  await (await personMenu(f.page)).locator('[data-act="switchto"]').filter({ hasText: "Sam" }).click();
  await f.page.locator("#pin-try").fill("4821");
  // The window starts again as Sam (main.js watchPerson reloads it), so the way back is tried after that reload.
  const reloaded = f.page.waitForEvent("load", { timeout: 30000 });
  await f.page.locator('[data-act="pin-ok"]').click();
  await until(() => !f.app.store.profiles.isOwner(), "switched to Sam");
  await reloaded;
  await f.page.locator('#side [data-act="owner"] .who14 b').filter({ hasText: "Sam" }).waitFor({ timeout: 30000 });
  await (await personMenu(f.page)).locator('[data-act="switchto"][data-v=""]').click();
  await f.page.getByRole("dialog", { name: "The owner’s PIN" }).locator("#pin-try").waitFor();
  assert.equal(f.app.store.profiles.isOwner(), false, "no switch back without the PIN");
  assert.deepEqual(f.errors, []);
});

test("the owner's PIN may be skipped but not be the child's own; with a PIN already set it is not asked again", async (t) => {
  const f = await fixture(t);
  await (await personMenu(f.page)).locator('[data-act="invite"]').click();
  const dlg = await fillInvite(f.page, { name: "Sam", pin: "4821", own: "4821" });
  await dlg.locator('#inv-own[aria-invalid="true"]').waitFor();
  assert.match(await dlg.locator("#inv-own-note").innerText(), /a PIN of your own/, "it says why");
  assert.equal(f.app.store.profiles.list().length, 0, "nobody is added with the owner's PIN the same as theirs");
  assert.equal(f.app.store.profiles.ownerPinOn(), false);
  await fillInvite(f.page, { name: "Sam", pin: "4821", own: "" });
  await until(() => f.app.store.profiles.list().length === 1, "added with the owner's PIN left empty");
  assert.equal(f.app.store.profiles.ownerPinOn(), false, "skipped: nothing is set behind the owner's back");
  f.app.store.profiles.setOwnerPin({ pin: "9753" });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor();
  await (await personMenu(f.page)).locator('[data-act="invite"]').click();
  await f.page.getByRole("dialog", { name: "Invite someone" }).locator("#inv-pin").waitFor();
  assert.equal(await f.page.locator("#inv-own").count(), 0, "a PIN already set is not asked for again");
  assert.deepEqual(f.errors, []);
});

test("Overview, where setup's People step now waits, adds somebody on this computer through the same dialog", async (t) => {
  const f = await fixture(t);
  const invite = (await openPlace(f.page, "overview")).locator('[data-act="invite"]').first();
  await invite.waitFor();
  assert.equal(await invite.getAttribute("aria-disabled"), null, "adding somebody on this computer is live");
  await invite.click();
  await fillInvite(f.page, { name: "Sam", pin: "4821", own: "9753" });
  await until(() => f.app.store.profiles.ownerPinOn() && f.app.store.profiles.list().length === 1, "added from Overview, with the owner's PIN");
  assert.deepEqual(f.errors, []);
});

test("a household already here with no owner PIN gets one notice with Set a PIN; Not now puts it away", async (t) => {
  const f = await fixture(t, { seed: (app) => app.store.profiles.create({ name: "Sam", pin: "4821" }) });
  let menu = await personMenu(f.page);
  const notice = menu.locator(".pin-notice");
  await notice.waitFor();
  assert.match(await notice.innerText(), SKIP_LINE);
  await notice.locator('[data-act="owner-pin-ask"]').click();
  const dlg = f.page.getByRole("dialog", { name: "The owner’s PIN" });
  await dlg.locator("#owner-pin-new").fill("9753");
  await dlg.locator('[data-act="owner-pin-set"]').click();
  await until(() => f.app.store.profiles.ownerPinOn(), "Set a PIN sets the owner's PIN");
  await dlg.waitFor({ state: "detached" });
  menu = await personMenu(f.page);
  await menu.locator('[data-act="invite"]').waitFor();
  assert.equal(await menu.locator(".pin-notice").count(), 0, "gone once a PIN is set");
  await f.page.keyboard.press("Escape");
  // Not now: put away, and still away after the window opens again.
  f.app.store.profiles.setOwnerPin({ pin: null });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor();
  menu = await personMenu(f.page);
  await menu.locator(".pin-notice").waitFor();
  await menu.locator('[data-act="owner-pin-later"]').click();
  await f.page.reload();
  await f.page.locator("#app #side").waitFor();
  menu = await personMenu(f.page);
  await menu.locator('[data-act="invite"]').waitFor();
  assert.equal(await menu.locator(".pin-notice").count(), 0, "Not now is remembered");
  assert.deepEqual(f.errors, []);
});
