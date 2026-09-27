// Verifies Settings › Updates & about › Remove Branch, in plain steps, against a real engine in a browser: the two
// choices (keep first, delete second), the exact lines the engine names (GET /api/deployment `uninstall`) with the
// real path, Copy putting exactly that line on the clipboard, --delete-data only in the second choice, and, with a
// scripted stand-in for the desktop's window.branchDesktop, Open Add or remove programs asking for exactly the page the
// engine named. Nothing here runs the uninstaller. Screenshots light and dark, wide and 390 px.
//   PORT=<port> TOKEN=<hex> [SHOTS=<folder>] node design/redesign/tools/verify-remove-branch.cjs
// against an engine started with BRANCH_INSTALL_ROOT pointing at a folder that holds a stand-in
// "Uninstall Branch Agent.cmd" (Windows), so the engine has a line to name. Records every page error.
"use strict";

const { chromium } = require("playwright");
const { join } = require("node:path");

const PORT = process.env.PORT || "3772";
const TOKEN = process.env.TOKEN || "";
const SHOTS = process.env.SHOTS || "";
const BASE = `http://127.0.0.1:${PORT}`;

async function call(method, route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status}`);
  return r.json();
}
const get = (route) => call("GET", route);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* The desktop's bridge and the clipboard, as stand-ins that only write down what they were asked. */
function stand(desktop) {
  globalThis.__copied = [];
  globalThis.__opened = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { globalThis.__copied.push(text); } } });
  if (desktop) globalThis.branchDesktop = { openExternal: async (url) => { globalThis.__opened.push(url); return true; } };
}

async function openRemove(browser, { width, scheme, desktop }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: scheme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(stand, desktop);
  await page.goto(BASE + (desktop ? "/?desktop" : "/"));
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#main", { timeout: 20000 });
  await page.locator('[data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="updates"]').first().click();
  await page.locator(".danger8 .rm-choice").first().waitFor({ timeout: 20000 });
  // A phone-wide window folds the side bar away, so the page is reached wide and then narrowed.
  if (width !== 1280) await page.setViewportSize({ width, height: 1000 });
  await sleep(400);
  return { page, errors };
}

async function shot(page, name, scheme) {
  if (!SHOTS) return;
  // The window keeps its own light or dark choice; the picture is taken in the one asked for, without passing toasts.
  await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; document.querySelectorAll(".toast").forEach((el) => el.remove()); }, scheme);
  await sleep(300);
  await page.locator(".danger8").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.locator(".danger8").screenshot({ path: join(SHOTS, `${name}-section.png`) });
}

async function choices(page, lines) {
  const cards = page.locator(".danger8 .rm-choice");
  check("two choices, the safe one first", (await cards.count()) === 2
    && (await cards.nth(0).locator("b").first().textContent()) === "Keep my conversations and settings"
    && (await cards.nth(1).locator("b").first().textContent()) === "Also delete my conversations and files");
  check("the second is in the warning style and says it can't be undone", await cards.nth(1).evaluate((el) => el.classList.contains("rm-danger"))
    && (await cards.nth(1).innerText()).includes("This can’t be undone."));
  const keepCode = await cards.nth(0).locator(".rm-cmd code").textContent();
  const dropCode = await cards.nth(1).locator(".rm-cmd code").textContent();
  check("each choice shows the engine's exact line, with the real path", keepCode === lines.keep && dropCode === lines.deleteData, keepCode);
  const all = await page.locator(".danger8").innerText();
  check("--delete-data appears once, in the second choice only", all.split("--delete-data").length === 2
    && !(await cards.nth(0).innerText()).includes("--delete-data"));
  check("no backticks in the words", !all.includes("`"));
  await cards.nth(0).locator('[data-act="rmcopy"]').click();
  await cards.nth(1).locator('[data-act="rmcopy"]').click();
  await sleep(200);
  const copied = await page.evaluate(() => globalThis.__copied);
  check("Copy puts exactly the line on the clipboard, each choice its own", copied.length === 2 && copied[0] === lines.keep && copied[1] === lines.deleteData, JSON.stringify(copied));
  check("Copy says so", (await page.locator(".toast").last().textContent()).includes("Copied."));
}

async function main() {
  await call("POST", "onboarding", { done: true });
  const deployment = await get("deployment");
  const lines = deployment.uninstall;
  check("the engine names the lines for this computer", Boolean(lines?.keep && lines?.deleteData), JSON.stringify(lines));
  if (!lines) return finish([]);
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    for (const scheme of ["light", "dark"]) {
      const wide = await openRemove(browser, { width: 1280, scheme, desktop: true });
      if (scheme === "light") {
        await choices(wide.page, lines);
        if (deployment.platform === "win32") {
          await wide.page.locator('.danger8 [data-act="rmapps"]').click();
          await sleep(200);
          const opened = await wide.page.evaluate(() => globalThis.__opened);
          check("desktop: Open Add or remove programs asks for exactly Windows' own page", opened.length === 1 && opened[0] === lines.settingsLink && opened[0] === "ms-settings:appsfeatures", JSON.stringify(opened));
        }
      }
      await shot(wide.page, `desktop-${scheme}`, scheme);
      errors.push(...wide.errors);
      await wide.page.close();
      const narrow = await openRemove(browser, { width: 390, scheme, desktop: false });
      if (scheme === "light") {
        check("browser: no Open button, the words instead", (await narrow.page.locator('.danger8 [data-act="rmapps"]').count()) === 0
          && (deployment.platform !== "win32" || (await narrow.page.locator(".danger8").innerText()).includes("type Add or remove programs")));
        check("390 px: no sideways scroll", !(await narrow.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
        const fits = await narrow.page.evaluate(() => [...document.querySelectorAll(".danger8 .rm-cmd")].every((el) => el.getBoundingClientRect().right <= 390
          && el.querySelector(".btn").getBoundingClientRect().right <= el.getBoundingClientRect().right));
        check("390 px: each line and its Copy fit", fits);
        await choices(narrow.page, lines);
      }
      await shot(narrow.page, `390-${scheme}`, scheme);
      errors.push(...narrow.errors);
      await narrow.page.close();
    }
  } finally {
    await browser.close();
  }
  finish(errors);
}

function finish(errors) {
  check("no page errors", errors.length === 0, errors.join(" | "));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
