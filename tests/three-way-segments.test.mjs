/* DG-169: a three-way that a module builds as a plain select is drawn as the approved sample's segmented control
   (design/Branch-Grown-Up.html, `invControlHTML`: three buttons, Off · When needed · On). The select stays underneath
   as the control's source, so pressing a segment saves the real setting through the module's own code, and what
   was saved comes back pressed after a reload. It fits the window at 1440, 860 and 400 wide. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

async function signedIn(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-three-way-segments-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  return { page, errors };
}

/* The new window: the prototype's three-way (Off · When needed · On) is a segmented group of three buttons. Settings ›
   Gateway became one on/off switch (the owner's decision, tests/grown-up-controls.test.mjs), so the live three-way read
   here is Team › Signing in, "Let people sign in from their own device" (public/app/places/team.js signinTab, GET/POST
   /api/people/settings): pressing a segment saves the real setting, it comes back pressed after a reload, and it fits its
   row at 1440, 860 and 400 wide. A three-way that is Coming soon is dimmed and a press on it changes nothing. */
const SIGN_IN = "Let people sign in from their own device";
const signInGroup = (page) => page.locator("#main .place").getByRole("group", { name: SIGN_IN, exact: true });
const signInMode = async (call) => (await call("/api/people/settings")).settings?.mode;
async function signInAgainIfAsked(page, server) {
  const box = page.getByLabel("Session token", { exact: true });
  await Promise.race([box.waitFor({ state: "visible" }), page.locator("#app #side").waitFor({ state: "visible" })]);
  if (await box.isVisible()) {
    await box.fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
}

test("DG-169 pressing a segment saves the real setting, and it comes back pressed after a reload (new window)", async (t) => {
  const { settingsWindow } = await import("./settings-window.mjs");
  const { openPlace } = await import("./new-window-places.mjs");
  const { page, errors, call, server } = await settingsWindow(t, { name: "three-way" });
  await openPlace(page, "team", "signin");
  await signInGroup(page).waitFor();
  assert.equal(await signInGroup(page).locator('[aria-pressed="true"]').count(), 1, "one position pressed");
  await signInGroup(page).getByRole("button", { name: "When needed", exact: true }).click();
  for (let tries = 0; tries < 50 && await signInMode(call) !== "when-needed"; tries++) await page.waitForTimeout(100);
  assert.equal(await signInMode(call), "when-needed", "saved");
  await page.reload();
  await signInAgainIfAsked(page, server);
  await openPlace(page, "team", "signin");
  await signInGroup(page).getByRole("button", { name: "When needed", exact: true, pressed: true }).waitFor({ timeout: 10000 });
  assert.equal(await signInGroup(page).locator('[aria-pressed="true"]').count(), 1);
  assert.deepEqual(errors, []);
});

for (const width of [1440, 860, 400]) {
  test(`DG-169 at ${width} px the sign-in three-way fits its row and answers a press (new window)`, async (t) => {
    const { settingsWindow } = await import("./settings-window.mjs");
    const { openPlace } = await import("./new-window-places.mjs");
    const { page, errors, call } = await settingsWindow(t, { name: "three-way", width, height: 900 });
    await openPlace(page, "team", "signin");
    await signInGroup(page).waitFor();
    const fits = await signInGroup(page).evaluate((group) => {
      const box = group.getBoundingClientRect(), row = group.closest(".ctl").getBoundingClientRect();
      return { inside: box.left >= row.left - 0.5 && box.right <= row.right + 0.5, words: group.querySelectorAll("button").length };
    });
    assert.deepEqual(fits, { inside: true, words: 3 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), "nothing scrolls sideways");
    await signInGroup(page).getByRole("button", { name: "When needed", exact: true }).click();
    for (let tries = 0; tries < 50 && await signInMode(call) !== "when-needed"; tries++) await page.waitForTimeout(100);
    assert.equal(await signInMode(call), "when-needed");
    await signInGroup(page).getByRole("button", { name: "When needed", exact: true, pressed: true }).waitFor();
    assert.deepEqual(errors, []);
  });
}

test("DG-169 a three-way that is Coming soon is dimmed, and a press on it changes nothing (new window)", async (t) => {
  const { settingsWindow, openSettingsPage, setLevel, isSoon } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "three-way" });
  await openSettingsPage(page, "permissions");
  // "When tools are loaded" is words now (tests/not-a-setting-plain-text.test.mjs); Isolation's container per Trunk is
  // still a Coming soon three-way.
  await setLevel(page, "technical");
  const group = page.locator(".set-col").getByRole("group", { name: "A container per Trunk", exact: true });
  const option = group.getByRole("button", { name: "For code", exact: true });
  await option.waitFor();
  assert.equal(await isSoon(option), true, "greyed out, Coming soon");
  assert.equal(await option.evaluate((node) => getComputedStyle(node).opacity), "0.45");
  const posts = [];
  page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  await option.click({ force: true });
  await page.waitForTimeout(500);
  assert.equal(await group.locator('[aria-pressed="true"]').count(), 0, "nothing was pressed");
  assert.deepEqual(posts, [], "nothing was sent");
  assert.deepEqual(errors, []);
});

const segment = (page, id, value) => page.locator(`.segmented-control:has(> #${id}) .segmented-option[data-v="${value}"]`);
const state = (page, id) => page.evaluate((one) => {
  const source = document.getElementById(one), group = source.closest(".segmented-control");
  return { value: source.value, pressed: [...group.querySelectorAll(".segmented-option[aria-pressed=true]")].map((node) => node.dataset.v) };
}, id);
const saved = (page) => page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/api/"));

for (const width of [1440, 860, 400]) {
  // Redesign: replaced by the new window (no dressed selects; the security check's switches are gone; re-pointed above).
  test.skip(`DG-169 at ${width} px the dressed three-ways fit their card and answer a press`, async (t) => {
    const { page, errors } = await signedIn(t, width);
    await openSettings(page, "permissions");
    const fits = await page.evaluate(() => [...document.querySelectorAll(".segmented-control[data-dressed]")].filter((group) => group.checkVisibility())
      .map((group) => {
        const box = group.getBoundingClientRect(), card = group.closest("section, .card, [id$='-card']").getBoundingClientRect();
        return { id: group.querySelector(".segmented-source").id, inside: box.left >= card.left - 0.5 && box.right <= card.right + 0.5, words: group.querySelectorAll(".segmented-option").length };
      }));
    assert.ok(fits.length >= 2, `the security check's switches show (${fits.map((one) => one.id).join(", ")})`);
    for (const one of fits) assert.deepEqual(one, { id: one.id, inside: true, words: 3 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), "nothing scrolls sideways");
    const answer = saved(page);
    await segment(page, "security-malware-mode", "on").click();
    assert.equal((await answer).ok(), true);
    assert.deepEqual(await state(page, "security-malware-mode"), { value: "on", pressed: ["on"] });
    assert.deepEqual(errors, []);
  });
}

// Redesign: replaced by the new window (no select source; a Coming soon three-way is re-pointed above).
test.skip("DG-169 a switched-off source dims its segments, and a press on one changes nothing", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await openSettings(page, "permissions");
  await page.evaluate(() => { document.getElementById("security-malware-mode").disabled = true; });
  const before = await state(page, "security-malware-mode");
  const look = await segment(page, "security-malware-mode", "on").evaluate((node) => ({ opacity: getComputedStyle(node).opacity, cursor: getComputedStyle(node).cursor }));
  assert.deepEqual(look, { opacity: "0.45", cursor: "not-allowed" });
  await segment(page, "security-malware-mode", before.value === "on" ? "off" : "on").click();
  assert.deepEqual(await state(page, "security-malware-mode"), before);
  assert.deepEqual(errors, []);
});
