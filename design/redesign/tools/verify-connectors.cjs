/* eng-connectors: proves each control made live against a FRESH engine, reading every change back through the engine's
   own GET route. Page errors must be zero.
     1. engine stopped:  BRANCH_DATA_DIR=<fresh> BRANCH_WORKSPACE=<fresh> node design/redesign/tools/seed-connectors.mjs
     2. start:           BRANCH_DATA_DIR=<fresh> BRANCH_WORKSPACE=<fresh> BRANCH_PORT=<port> node dist/cli.js start
     3.                  PORT=<port> TOKEN=<hex> SESSION=<id from step 1> node design/redesign/tools/verify-connectors.cjs
   Test data it makes through the window: one server of your own that runs the example notes server shipped with Branch
   (node dist/examples/mcp-notes-server.js; it reads no files and opens no network connection), one allowed command-line
   tool, and one flagged reply. It removes the server and the tool again. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { resolve } = require("node:path");

const { PORT, TOKEN, SESSION } = process.env;
if (!PORT || !TOKEN || !SESSION) { console.error("Set PORT, TOKEN and SESSION."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const live = async (loc) => (await loc.count()) > 0 && (await loc.first().getAttribute("aria-disabled")) !== "true" && !(await loc.first().isDisabled());
const lastToast = async (page, part) => until(async () => (await page.locator(".toast").allTextContents()).find((t) => t.includes(part)));

async function signIn(context) {
  await api("onboarding", { done: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  return { page, errors };
}
async function openTools(page, kind) {
  await page.evaluate(() => document.querySelector('[data-act="view"][data-v="customize"]')?.click());
  await settle(page, 600);
  await page.locator('[data-act="ptab"][data-place="customize"][data-v="tools"]').first().click();
  await settle(page, 1200);
  await page.locator(`[data-act="t9-kind"][data-v="${kind}"]`).click();
  await settle(page, 600);
}

/* mcp-cat, mcp-add: the catalogue is the engine's, filtered by category; a connector fills the form from the catalogue. */
async function catalogue(page) {
  const engine = await api("mcp/catalogue");
  await openTools(page, "mcp");
  await page.locator('.t9-addbtn[data-act="tool-add"][data-v="mcp"]').click();
  await page.locator(".dlg .aa-list12").waitFor();
  const shown = await page.locator('.dlg [data-act="mcp-add"]').count();
  check("mcp catalogue: every connector the engine lists is drawn", shown === engine.count, `${shown} of ${engine.count}`);
  check("mcp-cat: live", await live(page.locator('.dlg [data-act="mcp-cat"]')));
  await page.locator('.dlg [data-act="mcp-cat"][data-v="Developer"]').click();
  await settle(page, 300);
  const dev = engine.categories.find((g) => g.category === "Developer").connectors.length;
  check("mcp-cat: one category shows only its connectors", (await page.locator('.dlg [data-act="mcp-add"]').count()) === dev, String(dev));
  const playwright = engine.categories.flatMap((g) => g.connectors).find((c) => c.id === "playwright");
  await page.locator('.dlg [data-act="mcp-add"][data-v="playwright"]').click();
  await page.locator("#mcp-cmd").waitFor();
  check("mcp-add: the form is filled from the engine's catalogue", (await page.inputValue("#mcp-name")) === playwright.name && (await page.inputValue("#mcp-cmd")) === playwright.command.join(" "));
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

/* t9-own, mcp-how, mcp-save, the Tools row's switch (through the approval gate) and Remove. */
async function ownServer(page) {
  await page.locator('.t9-addbtn[data-act="tool-add"][data-v="mcp"]').click();
  await page.locator('.dlg [data-act="t9-own"]').click();
  await page.locator("#mcp-name").waitFor();
  check("mcp-test: stays greyed (trying starts the program without the gate)", !(await live(page.locator('.dlg [data-act="mcp-test"]'))));
  await page.locator('.dlg [data-act="mcp-how"][data-v="cmd"]').click();
  await page.fill("#mcp-name", "Notes");
  await page.fill("#mcp-cmd", `"${process.execPath}" "${resolve("dist/examples/mcp-notes-server.js")}"`);
  await page.locator('.dlg [data-act="mcp-save"]').click();
  await lastToast(page, "Notes is added");
  const saved = (await api("mcp/servers")).servers.find((s) => s.name === "Notes");
  check("mcp-save: the engine keeps the server, switched off", saved && saved.on === false && saved.transport === "stdio");
  const sw = page.locator('input[data-sw="tool9g"]');
  check("Tools row: your own server's switch is live", await live(sw));
  await sw.check();
  const said = await lastToast(page, "Before I go ahead");
  check("switching on asks first, in the engine's words", Boolean(said), said ?? "no toast");
  const question = await until(async () => (await api("policy")).waiting.find((q) => q.tool === "mcp.start"));
  check("the question waits in the approval gate", Boolean(question));
  await page.evaluate(() => document.querySelector('[data-act="view"][data-v="inbox"]')?.click());
  await settle(page, 1500);
  await page.locator(`[data-act="ask"][data-sid="${question.sessionId}"]`).click();
  const on = await until(async () => (await api("mcp/servers")).servers.find((s) => s.id === saved.id && s.running));
  check("Allow in the Inbox starts it (GET /api/mcp/servers running)", Boolean(on));
  await openTools(page, "mcp");
  await page.locator(`[data-act="t9-sel"][data-v="${saved.id}"]`).click();
  await settle(page, 400);
  await page.locator(`[data-act="tool-rm"][data-k="mcp"][data-id="${saved.id}"]`).click();
  const gone = await until(async () => !(await api("mcp/servers")).servers.some((s) => s.id === saved.id));
  check("tool-rm: your own server is removed", gone);
}

/* cli-add (and the path box), and Remove for your own tool. */
async function clis(page) {
  const engine = await api("clis");
  await openTools(page, "clis");
  await page.locator('.t9-addbtn[data-act="tool-add"][data-v="clis"]').click();
  await page.locator(".dlg #cli-path").waitFor();
  const rows = await page.locator(".dlg .prow").count();
  check("cli dialog: every tool the engine found is listed", rows === engine.found.length, `${rows} of ${engine.found.length}`);
  check("cli path box: live", await live(page.locator("#cli-path")));
  const pick = engine.found.find((c) => !c.allowed);
  if (!pick) { check("cli-add: a tool to allow was found on this computer", false, "none found"); return; }
  await page.locator(`.dlg [data-act="cli-add"][data-v="${pick.name}"]`).click();
  const said = await lastToast(page, `${pick.name} is allowed`);
  check("cli-add: the engine's words", Boolean(said), said ?? "no toast");
  check("cli-add: GET /api/clis lists it", (await api("clis")).programs.some((p) => p.name === pick.name));
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await settle(page, 400);
  await page.locator(`[data-act="t9-sel"][data-v="${pick.name}"]`).click();
  await settle(page, 400);
  await page.locator(`[data-act="tool-rm"][data-k="clis"][data-id="${pick.name}"]`).click();
  check("tool-rm: your own tool is removed", await until(async () => !(await api("clis")).programs.some((p) => p.name === pick.name)));
}

/* whatsnew13, new13-go, and Settings › Updates › What's new. */
async function whatsNew(page) {
  const engine = await api("release-notes");
  await page.locator('[data-act="guide"]').first().click();
  await page.locator('.pop [data-act="whatsnew13"]').click();
  await page.locator(".dlg .new13").waitFor();
  const rows = await page.locator(".dlg .new-row13").count();
  check("whatsnew13: one row per note the engine ships", rows === engine.items.length && rows > 0, `${rows} of ${engine.items.length}`);
  const titles = await page.locator(".dlg .new-row13 b").allTextContents();
  check("whatsnew13: the engine's words", titles.every((t, i) => t === engine.items[i].title));
  const inbox = engine.items.findIndex((n) => n.act === "view" && n.data.v === "inbox");
  await page.locator(".dlg .new-row13").nth(inbox).click();
  await settle(page, 800);
  check("new13-go: a row opens where it lives", (await page.locator(".dlg").count()) === 0 && (await page.locator("#main h1").first().textContent()) === "Inbox");
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setpage"][data-v="updates"]').first().click();
  await settle(page, 800);
  check("Updates › What's new: live", await live(page.locator('.settings [data-act="whatsnew13"]')));
  await page.locator('.settings [data-act="whatsnew13"]').click();
  await page.locator(".dlg .new13").waitFor();
  check("Updates › What's new opens the same notes", (await page.locator(".dlg .new-row13").count()) === engine.items.length);
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await settle(page, 400);
}

/* flag, flr17c, flsave17c, flrm17c: the reply is flagged with its reasons and note, kept by the engine, shown under the
   reply, and removed again. Sending to the Branch team stays greyed. */
async function flag(page) {
  await page.evaluate((id) => document.querySelector(`[data-act="chat"][data-id="${id}"]`)?.click(), SESSION);
  await settle(page, 1500);
  const row = page.locator(".b[data-i15]").first();
  const button = row.locator('.msg-acts [data-act="flag"]');
  check("flag: live on a reply", await live(button));
  await row.hover();
  await button.click();
  await page.locator("#fl-note17c").waitFor();
  check("flag: sending to the Branch team stays greyed", !(await live(page.locator("#fl-send17c"))) && !(await live(page.locator('.dlg [data-act="flgo17c"]'))));
  await page.locator('.dlg [data-act="flsave17c"]').click();
  check("flsave17c: no reason picked asks for one", Boolean(await lastToast(page, "Pick at least one reason.")));
  await page.locator('.dlg [data-act="flr17c"][data-v="unsafe"]').click();
  await page.locator('.dlg [data-act="flr17c"][data-v="wrong"]').click();
  await page.fill("#fl-note17c", "It is 42.");
  await page.locator('.dlg [data-act="flsave17c"]').click();
  const said = await lastToast(page, "Flagged. Kept on this computer only.");
  check("flsave17c: the engine's words", Boolean(said), said ?? "no toast");
  const kept = (await api("reply-flags/export", {})).flags[0];
  check("flsave17c: the owner's export (POST /api/reply-flags/export) has the reasons, the note and only that reply", kept && kept.reasons.join() === "wrong,unsafe" && kept.note === "It is 42." && kept.reply === "Six times seven is 41.");
  await settle(page, 800);
  check("the flag shows under the reply, its button pressed", (await page.locator(".flb17c").count()) === 1 && (await button.getAttribute("aria-pressed")) === "true");
  await page.locator('.flb17c [data-act="flrm17c"]').click();
  check("flrm17c: removed (GET /api/reply-flags empty)", await until(async () => (await api("reply-flags")).flags.length === 0));
  check("flrm17c: the engine's words", Boolean(await lastToast(page, "Flag removed.")));
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await signIn(context);
  for (const step of [catalogue, ownServer, clis, whatsNew, flag]) {
    try { await step(page); } catch (error) { check(`${step.name} ran to the end`, false, error.message); }
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
