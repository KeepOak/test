/* Bugfix 4 (the security reviewer's shell test port, PR #322): proves each fix in the real window against a FRESH
   engine, reading every change back through the engine's own GET route. Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-4.cjs
   Test data it makes through the engine: a "Jan" key connection (POST /api/connections/from-preset) checked against a
   stand-in Jan server this script runs on 127.0.0.1:1337 (it only answers the list of models; the key is a placeholder,
   as the catalogue says any key works for Jan), the cli-claude-code program connection (POST /api/providers/cli-agents,
   which installs and signs in to nothing), two Trunks, the palette keys, the achievements switch and the dashboard
   switch. Port 1337 must be free. */
const http = require("node:http");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC = join(__dirname, "..", "..", "..", "public");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }
const settle = (page, ms = 700) => page.waitForTimeout(ms);

/* A stand-in for Jan's local server: GET /v1/models only. */
function janStandIn() {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "local-model" }] })); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(1337, "127.0.0.1", () => resolve(server)); });
}

async function signIn(context) {
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  const page = await context.newPage();
  const errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.url().includes("/api/")) asked.push({ at: Date.now(), method: r.method(), path: new URL(r.url()).pathname, body: r.postData() }); });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  return { page, errors, asked };
}
async function reload(page) { await page.reload(); await page.locator("#main").waitFor(); await settle(page, 1500); }
async function openSettings(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setpage"][data-v="${id === "general" ? "people" : "general"}"]`).first().click();
  await settle(page, 300);
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1200);
}
async function backToChat(page) { if (await page.locator(".set-nav .set-back").count()) await page.locator(".set-nav .set-back").click(); await settle(page, 500); }

/* 1 (accounts A2): a key connection's Trunk chips are live and the pick is saved on the Trunk; a sign-in connection's
   chips stay greyed and nothing is saved. */
async function accounts(page, trunk) {
  const jan = await api("connections/from-preset", { provider: "jan", key: "placeholder-key-for-jan" });
  await api("providers/cli-agents", { id: "claude-code" });
  const listed = await api("accounts");
  check("1 the Jan connection is an API-key pool, cli-claude-code a sign-in pool", listed.pools.find((p) => p.pool === jan.id)?.kind === "api-key" && listed.pools.find((p) => p.pool === "cli-claude-code")?.kind === "cli", listed.pools.map((p) => `${p.pool}:${p.kind}`).join(", "));
  await reload(page);
  await openSettings(page, "accounts");
  await page.locator(`[data-act="addacct"][data-v="${jan.id}"]`).first().click();
  await page.getByLabel("Key", { exact: true }).fill("placeholder-key-two");
  await page.locator('.dlg [data-act="aa-key"]').click();
  const chip = page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"]`);
  await chip.waitFor();
  check("1 API-key pool: the Trunk chip is live", !(await chip.isDisabled()) && (await chip.getAttribute("aria-disabled")) !== "true");
  await chip.click();
  await page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"][aria-pressed="true"]`).waitFor();
  check("1 API-key pool: the chip is pressed", true);
  await page.locator('.dlg [data-act="aa-done"]').click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 30000 });
  const pool = (await api("accounts")).pools.find((p) => p.pool === jan.id);
  const added = pool?.accounts[pool.accounts.length - 1];
  const saved = (await api(`trunks/${trunk.id}`)).trunk?.keys?.accounts ?? {};
  check("1 GET /api/trunks/<id>: keys.accounts names the new key account", added && saved[jan.id] === added.id, `${jan.id} -> ${saved[jan.id]}, added ${added?.id}`);
  check("1 the key is never on the page", !(await page.content()).includes("placeholder-key-two"));

  await page.locator('[data-act="addacct"][data-v="cli-claude-code"]').first().click();
  const signChip = page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"]`);
  await signChip.waitFor();
  check("1 sign-in pool: the Trunk chip is greyed (disabled)", (await signChip.isDisabled()) && (await signChip.getAttribute("aria-disabled")) === "true");
  await page.locator('.dlg [data-act="aa-done"]').click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 30000 });
  const after = (await api(`trunks/${trunk.id}`)).trunk?.keys?.accounts ?? {};
  check("1 sign-in pool: GET /api/trunks/<id> never names cli-claude-code", after["cli-claude-code"] === undefined && after[jan.id] === added?.id, JSON.stringify(after));
  await backToChat(page);
}

/* 2 (header-popovers Q34): Escape and an outside click close a popover and give the keyboard back to its opener. */
async function popovers(page, trunk) {
  await page.locator(`#side .row[data-id="${trunk.chatSessionId}"]`).click();
  await settle(page, 800);
  for (const act of ["chatmenu", "newmenu", "owner"]) {
    const opener = page.locator(`[data-act="${act}"]`).filter({ visible: true }).first();
    await opener.click();
    await page.locator(".pop").waitFor({ state: "visible" });
    const inside = await page.evaluate(() => document.querySelector(".pop").contains(document.activeElement));
    await page.keyboard.press("Escape");
    await page.locator(".pop").waitFor({ state: "detached" });
    const back = await page.evaluate(() => document.activeElement?.dataset?.act ?? document.activeElement?.tagName);
    check(`2 ${act}: the keyboard is in the menu, and Escape hands it back to the opener`, inside && back === act, `focus after Escape: ${back}`);
    check(`2 ${act}: closed, its button says so`, (await opener.getAttribute("aria-expanded")) === "false");
    await opener.click();
    await page.locator(".pop").waitFor({ state: "visible" });
    const box = await page.locator("#main").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
    await page.locator(".pop").waitFor({ state: "detached" });
    const after = await page.evaluate(() => document.activeElement?.dataset?.act ?? document.activeElement?.tagName);
    check(`2 ${act}: an outside click closes it`, (await opener.getAttribute("aria-expanded")) === "false", `focus after the click: ${after}`);
  }
}

/* 3 (topbar-search): the search box's aria-keyshortcuts is the owner's own palette keys, and nothing when there are none. */
async function searchKeys(page) {
  const defaults = (await api("comfort")).shortcutDefaults ?? {};
  await api("comfort", { card: "keys", values: { palette: "Ctrl+Shift+F" } });
  await reload(page);
  await page.locator("#side .sq9 kbd").waitFor();
  const shown = await page.locator("#side .sq9 kbd").textContent(), heard = await page.locator("#side-q").getAttribute("aria-keyshortcuts");
  check("3 with Ctrl+Shift+F: the hint shows it and a screen reader hears the same keys", shown === "Ctrl Shift F" && heard === "Control+Shift+F", `shown "${shown}", heard "${heard}"`);
  await api("comfort", { card: "keys", values: { palette: "" } });
  await reload(page);
  check("3 with no palette keys: no hint and no aria-keyshortcuts", !(await page.locator("#side .sq9 kbd").count()) && (await page.locator("#side-q").getAttribute("aria-keyshortcuts")) === null);
  await api("comfort", { card: "keys", values: { palette: defaults.palette ?? "Ctrl+K" } });
  check("3 GET /api/comfort: the palette keys are back to the default", (await api("comfort")).values?.keys?.palette === (defaults.palette ?? "Ctrl+K"));
  await reload(page);
  check("3 default keys: heard as Control+K", (await page.locator("#side-q").getAttribute("aria-keyshortcuts")) === "Control+K");
}
async function macKeys(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const { page, errors } = await signIn(ctx);
  const heard = await page.locator("#side-q").getAttribute("aria-keyshortcuts"), shown = await page.locator("#side .sq9 kbd").textContent();
  check("3 on a Mac: shown Cmd K, heard Meta+K", shown === "Cmd K" && heard === "Meta+K", `shown "${shown}", heard "${heard}"`);
  check("3 on a Mac: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* 4 (trunks-rail-parity): Up and Down move between the list's rows; a Trunk's row menu is named for its Trunk. */
async function arrows(page, trunks) {
  const order = await page.locator("#side .row[data-id]").evaluateAll((nodes) => nodes.map((n) => n.dataset.id));
  await page.locator(`#side .row[data-id="${order[0]}"]`).focus();
  await page.keyboard.press("ArrowDown");
  const down = await page.evaluate(() => document.activeElement?.dataset.id);
  await page.keyboard.press("ArrowUp");
  const up = await page.evaluate(() => document.activeElement?.dataset.id);
  check("4 ArrowDown moves to the next row, ArrowUp back", order.length >= 2 && down === order[1] && up === order[0], `${order.length} rows`);
  for (const t of trunks) {
    await page.locator(`#side .row[data-id="${t.chatSessionId}"]`).click({ button: "right" });
    await page.locator(".pop[role=menu]").waitFor();
    check(`4 ${t.name}'s row menu is named for it`, (await page.locator(".pop[role=menu]").getAttribute("aria-label")) === t.name);
    await page.keyboard.press("Escape");
    await page.locator(".pop").waitFor({ state: "detached" });
  }
}

/* 5 (delight): achievements switched on after the window opened; following the computer is told once. The pet at
   phone width sits inside the folded list. */
async function delight(page, asked) {
  await api("delight/settings", { achievements: { on: true }, pets: { on: true } });
  const from = Date.now();
  await openSettings(page, "appearance");
  for (const v of ["system", "dark", "system"]) { await page.locator(`.set-col .mirrors [data-act="themeset"][data-v="${v}"]`).click(); await settle(page, 500); }
  await settle(page, 800);
  const told = asked.filter((r) => r.at >= from && r.path === "/api/delight/noticed" && (r.body ?? "").includes("follow-system"));
  check("5 following the computer is told to delight/noticed exactly once", told.length === 1, `${told.length} requests`);
  check("5 GET /api/state: the engine keeps followSystem", (await api("state")).preferences?.followSystem === true);
  const view = await api("delight/achievements");
  check("5 GET /api/delight/achievements: 'noticed:flag:follow-system:1' is earned", !!view.list?.find((a) => a.id === "noticed:flag:follow-system:1")?.got);
  await backToChat(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await reload(page);
  await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await page.locator("#pet-cv").waitFor();
  await settle(page, 600);
  const pet = await page.locator("#pet-cv").boundingBox(), side = await page.locator("#side").boundingBox();
  check("5 at 390 px the pet is inside the folded list", pet.x >= side.x && pet.x + pet.width <= side.x + side.width + 0.5, `pet ${Math.round(pet.x)}..${Math.round(pet.x + pet.width)}, list ${Math.round(side.x)}..${Math.round(side.x + side.width)}`);
  check("5 at 390 px nothing scrolls sideways", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1280, height: 860 });
  await api("delight/settings", { achievements: { on: false }, pets: { on: false } });
}

/* 6 (dashboard): every file it loads is served, the old window's card is gone, no colour is written outside tokens.css,
   and the page itself loads with no errors. */
async function dashboard(browser) {
  await api("dashboard/settings", { mode: "on" });
  check("6 GET /api/dashboard/settings: on", (await api("dashboard/settings")).mode === "on");
  const dir = join(PUBLIC, "dashboard");
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const referenced = new Set([...html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]).filter((p) => p !== "/"));
  for (const name of readdirSync(dir)) {
    referenced.add(name === "index.html" ? "/dashboard" : `/dashboard/${name}`);
    if (name.endsWith(".js")) for (const m of readFileSync(join(dir, name), "utf8").matchAll(/^import\s+[^"']*["'](\/[a-z0-9/-]+\.js)["']/gm)) referenced.add(m[1]);
  }
  const missing = [];
  for (const p of referenced) { const s = (await fetch(BASE + p)).status; if (s !== 200) missing.push(`${p} -> ${s}`); }
  check("6 every file the dashboard loads is served", missing.length === 0, missing.join(", ") || `${referenced.size} files`);
  check("6 the old window's /dashboard-card.js is not served", (await fetch(BASE + "/dashboard-card.js")).status !== 200);
  const colours = [];
  for (const name of readdirSync(dir)) readFileSync(join(dir, name), "utf8").split("\n").forEach((line, i) => {
    const rule = line.replace(/\/\*.*?\*\//g, "").split("/*")[0].replace(/\/\/.*$/, "");
    if (/#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\s*\(\s*\d|\bhsla?\s*\(\s*\d/.test(rule) && !/href=|#open=|#task=/.test(rule)) colours.push(`${name}:${i + 1}`);
  });
  check("6 no colour is written down in public/dashboard (all from public/tokens.css)", colours.length === 0, colours.join(", "));
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/dashboard");
  await settle(page, 2500);
  const tokens = await page.evaluate(() => ["--ground", "--text", "--copper", "--ok"].map((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()));
  check("6 the dashboard page reads the oak's four colours from tokens", tokens.every(Boolean), tokens.join(" "));
  check("6 the dashboard page loads with no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
  await api("dashboard/settings", { mode: "off" });
}

(async () => {
  const jan = await janStandIn().catch((e) => { console.error(`Port 1337 is not free: ${e.message}`); process.exit(2); });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors, asked } = await signIn(context);
  try {
    await api("trunks/switch", { part: "trunks", mode: "on" });
    const trunks = [];
    for (const name of ["Scout", "Ledger"]) trunks.push((await api("trunks", { name: `${name} ${Date.now() % 100000}`, description: "Checks the list" })).trunk);
    await reload(page);
    await accounts(page, trunks[0]);
    await popovers(page, trunks[0]);
    await arrows(page, trunks);
    await searchKeys(page);
    await macKeys(browser);
    await delight(page, asked);
    await dashboard(browser);
  } catch (e) { check("script finished", false, e.stack); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  jan.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
