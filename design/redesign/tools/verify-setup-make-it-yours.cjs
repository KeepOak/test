// Verifies setup's "Make it yours" (branch claude/setup-make-it-yours) against a real engine, in a browser, with setup
// open: a theme, a painted scene and a pet picked there are applied at once behind setup and read back after a reload
// (the theme from GET /api/look, the pet from GET /api/delight, the scene from this window's storage with the engine's
// background switch from GET /api/delight, as Settings › Appearance keeps them), then Auto under "How much it asks": the
// engine's confirm is shown and nothing is saved before it, "Yes, make it less careful" saves it (GET
// /api/conversation-mode/settings), and under Lockdown the engine refuses it in its own words. Also: with reduced motion
// the pets stay stills on hover. Records every page error.
//   PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-setup-make-it-yours.cjs
// against a FRESH engine (setup not yet done), so setup opens by itself.
"use strict";

const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const PORT = process.env.PORT || "3647";
const TOKEN = process.env.TOKEN || "";
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = "C:/Users/bishi/AppData/Local/Temp/claude-session-files/setup-make-it-yours";
const LOCKDOWN = "Lockdown is on, so settings cannot be changed from here. Turn it off first.";

async function call(method, route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const get = (route) => call("GET", route);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const newStart = async () => (await get("conversation-mode/settings")).settings.newConversation;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator(".ob9").waitFor({ timeout: 20000 });
}
/* Welcome's box, then the rail's "Make it yours" (the fourth step). */
async function toStep4(page) {
  await page.locator(".ob-agree").click();
  await page.locator('.ob-rail [data-act="ob-go"][data-v="3"]').click();
  await page.locator(".ob-themes15").waitFor({ timeout: 15000 });
  await sleep(400);
}
const pressedV = (page, sel) => page.locator(`${sel}[aria-pressed="true"]`).first().getAttribute("data-v");

async function pickTheme(page) {
  const card = page.locator('.ob-themes15 [data-act="ob15-skin"][aria-pressed="false"]').first();
  const id = await card.getAttribute("data-v");
  const bgBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  await card.click();
  await page.waitForFunction((want) => document.documentElement.dataset.palette === want, id, { timeout: 10000 });
  const bgAfter = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  const look = await get("look");
  check("theme: applied at once behind setup (the window's colours change)", bgAfter && bgAfter !== bgBefore, `${id}: --bg ${bgBefore} -> ${bgAfter}`);
  check("theme: saved to the engine (GET /api/look)", look.theme === id, `theme=${look.theme}`);
  check("theme: the card is drawn picked from what was saved", (await pressedV(page, ".ob-themes15 [data-act=\"ob15-skin\"]")) === id);
  return id;
}
const paintUrl = (page) => page.evaluate(() => document.querySelector("#bgLayer .paint11")?.style.backgroundImage ?? "");
async function pickScene(page) {
  const card = page.locator('.ob-scenes15 [data-act="ob15-scene"][aria-pressed="false"]').first();
  const id = await card.getAttribute("data-v");
  const file = await card.evaluate((b) => getComputedStyle(b.querySelector(".sc-img12")).backgroundImage.match(/\/art\/[^"')]+/)?.[0] ?? "");
  await card.click();
  await page.waitForFunction((f) => (document.querySelector("#bgLayer .paint11")?.style.backgroundImage ?? "").includes(f), file, { timeout: 10000 });
  const delight = await get("delight");
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("branch-scene") || "null"));
  const shows = await page.evaluate(() => { const ob = getComputedStyle(document.querySelector(".ob9")); return document.getElementById("app").classList.contains("has-bg") && ob.backgroundColor !== "rgba(0, 0, 0, 0)" && !/, 1\)$|^rgb\(/.test(ob.backgroundColor); });
  check("scene: drawn at once behind setup (#bgLayer shows its picture)", (await paintUrl(page)).includes(file), `${id} ${file}`);
  check("scene: setup is glass while a background is on, so the scene shows through", shows);
  check("scene: kept as Appearance keeps it (this window's branch-scene, engine background.on)", kept?.scene === id && kept?.bg === "painted" && delight.settings.background.on === true, JSON.stringify({ kept, on: delight.settings.background.on }));
  check("scene: the card is drawn picked", (await pressedV(page, ".ob-scenes15 [data-act=\"ob15-scene\"]")) === id);
  return { id, file };
}
async function pickPet(page) {
  const card = page.locator('.ob-pets15 [data-act="ob15-pet"][aria-pressed="false"]:not([data-v="none"])').first();
  const id = await card.getAttribute("data-v");
  await card.click();
  await page.waitForFunction((want) => document.querySelector(`.ob-pets15 [data-v="${want}"]`)?.getAttribute("aria-pressed") === "true", id, { timeout: 10000 });
  const pets = (await get("delight")).settings.pets;
  check("pet: saved to the engine (GET /api/delight pets)", pets.on === true && pets.kind === id, JSON.stringify(pets));
  return id;
}

async function readBack(page, theme, scene, pet) {
  await page.reload();
  await page.locator(".ob9").waitFor({ timeout: 20000 });
  await toStep4(page);
  await page.waitForFunction((want) => document.documentElement.dataset.palette === want, theme, { timeout: 10000 }).catch(() => {});
  check("after a reload: the theme is still worn (GET /api/look and the window)", (await get("look")).theme === theme && (await page.evaluate(() => document.documentElement.dataset.palette)) === theme);
  check("after a reload: the theme card is drawn picked", (await pressedV(page, ".ob-themes15 [data-act=\"ob15-skin\"]")) === theme);
  await page.waitForFunction((f) => (document.querySelector("#bgLayer .paint11")?.style.backgroundImage ?? "").includes(f), scene.file, { timeout: 10000 }).catch(() => {});
  check("after a reload: the scene is still behind the glass", (await paintUrl(page)).includes(scene.file) && (await get("delight")).settings.background.on === true);
  check("after a reload: the scene card is drawn picked", (await pressedV(page, ".ob-scenes15 [data-act=\"ob15-scene\"]")) === scene.id);
  check("after a reload: the pet card is drawn picked", (await pressedV(page, ".ob-pets15 [data-act=\"ob15-pet\"]")) === pet);
}

async function auto(page) {
  const autoRow = page.locator('[data-act="ob15-auto"]');
  check("Auto: drawn live, not greyed", (await autoRow.getAttribute("aria-disabled")) !== "true");
  const before = await newStart();
  await autoRow.click();
  const dlg = page.locator(".dlg");
  await dlg.waitFor({ timeout: 10000 });
  const words = (await dlg.locator(".dlg-b").innerText()).trim();
  await page.screenshot({ path: `${SHOTS}/auto-confirm.png` });
  check("Auto: a confirm shows the engine's own words", /^This makes Branch less careful: new conversations would start on Auto instead of Ask first\./.test(words), words);
  check("Auto: nothing is saved before the yes", (await newStart()) === before, `still ${before}`);
  await dlg.locator('[data-act="dlg-close"]').last().click();
  await sleep(500);
  check("Auto: Cancel saves nothing", (await newStart()) === before);
  await autoRow.click();
  await dlg.waitFor({ timeout: 10000 });
  await dlg.locator('[data-act="ob15-loosen"]').click();
  await page.waitForFunction(() => document.querySelector('[data-act="ob15-auto"]')?.getAttribute("aria-pressed") === "true", null, { timeout: 10000 });
  check("Auto: saved after the yes (GET /api/conversation-mode/settings)", (await newStart()) === "auto");
  await page.locator('[data-act="ob15"][data-k="asks"][data-v="ask"]').click();
  await page.waitForFunction(() => document.querySelector('[data-act="ob15"][data-v="ask"]')?.getAttribute("aria-pressed") === "true", null, { timeout: 10000 });
  check("Ask first: going back to the more careful choice needs no yes", (await newStart()) === "ask" && !(await page.locator(".dlg").count()));
  await call("POST", "lockdown", { on: true });
  await sleep(800);
  await autoRow.click();
  const toast = page.locator(".toast").filter({ hasText: LOCKDOWN });
  const refused = await toast.waitFor({ timeout: 10000 }).then(() => true, () => false);
  await page.screenshot({ path: `${SHOTS}/auto-lockdown.png` });
  check("Auto under Lockdown: refused in the engine's own words, no confirm", refused && !(await page.locator(".dlg").count()));
  check("Auto under Lockdown: nothing saved", (await newStart()) === "ask");
  await call("POST", "lockdown", { on: false });
}

async function stills(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await toStep4(page);
  const card = page.locator(".ob-pets15 .pet-c12 img[data-hov]").first();
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  await sleep(700);
  check("reduced motion: a pet stays a still on hover, and no row plays a loop", !(await page.locator(".ob-strip15 video").count()));
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  const wide = await page.evaluate(() => document.querySelector(".ob-body").scrollWidth <= document.querySelector(".ob-body").clientWidth + 1);
  await page.screenshot({ path: `${SHOTS}/phone-width.png` });
  check("phone width: the rows scroll sideways inside the step, the page does not", wide);
  await context.close();
  return errors;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await signIn(page);
    await toStep4(page);
    await page.screenshot({ path: `${SHOTS}/step4-before.png` });
    const theme = await pickTheme(page);
    const scene = await pickScene(page);
    const pet = await pickPet(page);
    await page.screenshot({ path: `${SHOTS}/step4-picked.png` });
    await readBack(page, theme, scene, pet);
    await page.screenshot({ path: `${SHOTS}/step4-after-reload.png` });
    await auto(page);
    errors.push(...await stills(browser));
  } catch (error) {
    check("run finished", false, error.message);
    await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
    await call("POST", "lockdown", { on: false }).catch(() => {});
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
