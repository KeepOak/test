/* Bugfix 10: proves each fix in the real window, reading every change back through the engine's own GET routes. Page
   errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-10.cjs
   On the fresh engine at PORT:
   2 a popover whose button a redraw replaced (the + in the message box, New, the model chip) says it is open, and closes
     when that button is pressed again, as the prototype's popovers do;
   4 Export conversation saves the engine's Markdown copy to Library › Documents (GET /api/documents) and downloads
     nothing; with the desktop's preload stood in for, the engine's JSON archive goes to window.branchDesktop.exportConversation;
   5 French: the five words given real French say it through t(), and the Tools list and Appearance show it.
   On a second, in-process engine with a scripted model (its own temp folder, a free port):
   1 Carry it on is refused while an answer is pending: the engine makes no copy (POST /api/sessions/search), and the
     answer lands in the conversation it was asked in, which stays the open one once the search is cleared;
   3 the model picker changes the model (GET /api/state, GET /api/sessions/<id>/model) and never the conversation shown,
     and a menu closed while the choice is saved stays closed;
   2 again for a reply's More, whose buttons differ only by their message: the menu stays with its own reply's button.
   Test data: one imported conversation "Juniper verify source" on the fresh engine; on the scripted engine a seeded
   conversation "Juniper lifecycle source" and the presets "Default connection" and "Alternate connection".
   Playwright is the worktree's own (npm ci), not the installed app's. Nothing launches a desktop window. */
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(join(__dirname, "../../../node_modules/playwright"));

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }

function client(base, token) {
  return async (p, body) => {
    const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
}
const BASE = `http://127.0.0.1:${PORT}`;
const api = client(BASE, TOKEN);

async function signIn(context, base, token, call, init) {
  await call("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  if (init) await page.addInitScript(init);
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);
  return { page, errors };
}
const openRow = async (page, sid) => {
  await page.locator(`#side .row[data-id="${sid}"]`).click();
  await until(() => page.evaluate((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", sid));
};
const current = (page) => page.evaluate(() => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);

/* A redraw of the region the button is in, as the window's own draws do (the main area is drawn anew when it changed). */
const redraw = (page, selector) => page.evaluate(async (sel) => {
  const before = document.querySelector(sel);
  const main = document.querySelector("#main");
  main.replaceChild(main.firstElementChild.cloneNode(true), main.firstElementChild);
  const { renderNow } = await import("/app/core/dom.js");
  renderNow();
  return before !== document.querySelector(sel);
}, selector);

/* 2 */
async function popovers(page) {
  for (const [label, trigger] of [["the + in the message box", '#composer [data-act="plusmenu"]'], ["New", '#side [data-act="newmenu"]'], ["the model chip", '#composer [data-act="modelmenu2"]']]) {
    const button = page.locator(trigger);
    await button.click();
    await page.locator("#app > .pop").waitFor({ state: "visible", timeout: 5000 });
    const replaced = await redraw(page, trigger);
    check(`2 ${label}: a redraw replaced its button while its popover was open`, replaced);
    check(`2 ${label}: the button drawn in its place says it is open`, (await button.getAttribute("aria-expanded")) === "true");
    await button.click();
    await wait(300);
    check(`2 ${label}: pressing that button again closes the popover`, (await page.locator("#app > .pop").count()) === 0 && (await button.getAttribute("aria-expanded")) === "false");
  }
}

/* 4 */
async function exports(browser) {
  const archive = { format: "branch-agent-conversation", version: 1, exportedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "Juniper verify source" }, { role: "assistant", content: "Saved response for Juniper verify source" }] };
  const { sessionId } = await api("sessions/import", archive);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const { page, errors } = await signIn(context, BASE, TOKEN, api);
  let downloads = 0;
  page.on("download", () => downloads++);
  const exportIt = async (p) => {
    await openRow(p, sessionId);
    await p.locator('[data-act="chatmenu"]').first().click();
    await p.locator('#app > .pop [data-act="export-conv"]').click();
    await p.locator(".toast").filter({ hasText: "Saved as Markdown to Library › Documents." }).waitFor({ timeout: 30000 });
  };
  const before = (await api("documents")).documents?.length ?? 0;
  await exportIt(page);
  const docs = (await api("documents")).documents ?? [];
  const name = `conversation-${sessionId.slice(0, 8)}.md`;
  check("4 Export conversation: the Markdown copy is in Library › Documents (GET /api/documents)", docs.length === before + 1 && docs.some((d) => d.name === name), name);
  await wait(500);
  check("4 the browser downloads nothing (the prototype saves to Library › Documents)", downloads === 0, String(downloads));
  await popovers(page);
  check("no page errors (fresh engine, browser)", errors.length === 0, errors.join(" | "));
  await context.close();

  /* The desktop's preload, stood in for: records what the window hands the guarded export (branch:export-conversation). */
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const stood = await signIn(desk, BASE, TOKEN, api, () => {
    window.__handed = [];
    window.branchDesktop = Object.freeze({ exportConversation: async (text) => { window.__handed.push(text); return { saved: true }; } });
  });
  await exportIt(stood.page);
  await stood.page.waitForFunction(() => window.__handed.length === 1, null, { timeout: 15000 });
  const handed = JSON.parse(await stood.page.evaluate(() => window.__handed[0]));
  const engine = await api(`sessions/${sessionId}/export`);
  check("4 desktop stand-in: the engine's JSON archive (GET /api/sessions/<id>/export) goes to window.branchDesktop.exportConversation",
    handed.format === "branch-agent-conversation" && JSON.stringify(handed.messages) === JSON.stringify(engine.messages), handed.format);
  check("no page errors (fresh engine, desktop stand-in)", stood.errors.length === 0, stood.errors.join(" | "));
  await desk.close();
}

/* 5 */
const FRENCH = { "window.chat.tools.plugin": "Extension", "window.shell.themes.accent": "Couleur d'accent",
  "window.settings.appearance.accent-value": "Couleur d'accent {value}", "window.settings.appearance.english": "Anglais.",
  "window.settings.developer.minimal": "Minimale" };
async function french(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors } = await signIn(context, BASE, TOKEN, api);
  const settings = async () => {
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="appearance"]').click();
    await page.locator("#lang").waitFor();
  };
  await settings();
  await page.locator("#lang").selectOption("fr");
  await until(() => page.evaluate(async () => (await import("/i18n.js")).language() === "fr"));
  const said = await page.evaluate(async (keys) => { const { t } = await import("/i18n.js"); return Object.fromEntries(keys.map((k) => [k, t(k)])); }, Object.keys(FRENCH));
  for (const [key, words] of Object.entries(FRENCH)) check(`5 French: ${key} says “${words}” through t()`, said[key] === words, said[key]);
  const swatches = await page.locator('[data-act="acc-set"]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
  const accent = swatches.find((l) => /^Couleur d'accent #/i.test(l ?? ""));
  check("5 French: Appearance names each colour swatch “Couleur d'accent …”", Boolean(accent), accent ?? swatches.join(" | "));
  await page.locator(".set-nav .set-back").click();
  await page.locator('#composer [data-act="tools9"]').click();
  const add = await page.locator('#app > .pop [data-act="tool-add"][data-v="plugins"]').innerText();
  check("5 French: the Tools list offers “Extension”", add.trim() === "Extension", add.trim());
  await page.keyboard.press("Escape");
  await settings();
  await page.locator("#lang").selectOption("en");
  await page.locator(".toast").filter({ hasText: "English." }).waitFor({ timeout: 10000 });
  check("5 back in English, the window says “English.” as the prototype does", true);
  check("no page errors (French)", errors.length === 0, errors.join(" | "));
  await context.close();
}

/* 1 and 3, on an engine whose model waits until it is told to answer, with two connections. */
async function scripted(browser) {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-bugfix-10-"));
  let release = () => {}, started = () => {};
  let hold = false;
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (hold && last?.role === "user" && last.content === "Keep working") {
      started();
      await new Promise((done) => { release = done; });
      return { content: "finished", toolCalls: [] };
    }
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "default", name: "Default connection", provider, model: "configured" }, { id: "alternate", name: "Alternate connection", provider, model: "other-model" }] });
  const run = app.store.createRun("local", "Juniper lifecycle source");
  app.store.message(run.sessionId, { role: "user", content: "Juniper lifecycle source" });
  app.store.message(run.sessionId, { role: "assistant", content: "Saved response for Juniper lifecycle source" });
  app.store.finish(run.id, "completed", "Saved response");
  const source = run.sessionId;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const base = server.url.replace(/\/$/, "");
  const call = client(base, server.token);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors } = await signIn(context, base, server.token, call);
  try {
    /* 3: on the empty screen, then in a conversation. */
    const chip = page.locator('#composer [data-act="modelmenu2"]');
    const menu = page.locator("#app > .pop");
    await chip.click();
    await menu.locator('[data-act="pick-model"][data-v="alternate"]').click();
    await until(async () => (await call("state")).activeModel?.presetId === "alternate");
    await page.keyboard.press("Escape");
    check("3 empty screen: the pick is the engine's model (GET /api/state activeModel)", (await call("state")).activeModel?.presetId === "alternate");
    check("3 empty screen: the picker opens no conversation, the empty screen stays", (await page.locator(".empty-chat").isVisible()) && (await current(page)) === null);
    await openRow(page, source);
    await chip.click();
    await page.route("**/api/sessions/*/model", async (route) => { if (route.request().method() === "POST") await wait(1200); await route.continue(); });
    await menu.locator('[data-act="pick-model"][data-v="default"]').click();
    await page.keyboard.press("Escape"); // closed while the choice is being saved
    await until(async () => (await call(`sessions/${source}/model`)).preset === "default", 10000);
    await wait(1500);
    check("3 in a conversation: the pick is this conversation's model (GET /api/sessions/<id>/model)", (await call(`sessions/${source}/model`)).preset === "default");
    check("3 a menu closed while the choice was saved stays closed", (await menu.count()) === 0);
    check("3 the picker left the conversation open", (await current(page)) === source && (await page.locator("#conversation").isVisible()));
    await page.unroute("**/api/sessions/*/model");

    /* 1 */
    hold = true;
    const began = new Promise((done) => { started = done; });
    await page.locator("#prompt").fill("Keep working");
    await page.locator("#send").click();
    await began;
    await page.locator("#side-q").fill("Juniper");
    await page.locator(`#side [data-act="sr-sess"][data-v="${source}"]`).click({ timeout: 10000 });
    await page.getByRole("button", { name: "Carry it on", exact: true }).click();
    await page.locator(".toast").filter({ hasText: "Wait for this conversation's active task" }).waitFor({ timeout: 10000 });
    check("1 Carry it on while the answer is pending: the engine's refusal is shown", true);
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.locator('#side [data-act="sq-clear"]').click();
    check("1 once the search is cleared, the conversation asked in is still the open one", (await current(page)) === source);
    release();
    await page.locator("#conversation").getByText("finished", { exact: true }).waitFor({ timeout: 30000 });
    const copies = (await call("sessions/search", { query: "Juniper lifecycle" })).sessions ?? [];
    check("1 the engine made no copy (POST /api/sessions/search)", copies.length === 1 && copies[0].sessionId === source, String(copies.length));
    const said = (await call(`sessions/${source}`)).messages.slice(-2).map((m) => m.content);
    check("1 the answer landed in the conversation it was asked in (GET /api/sessions/<id>)", said[0] === "Keep working" && said[1] === "finished", said.join(" | "));
    check("1 and that conversation is the open one", (await current(page)) === source);

    /* 2 again, for buttons told apart only by their message: each reply's More (data-act="more17c", data-mid). */
    const mores = page.locator('#conversation [data-act="more17c"]');
    check("2 the conversation has two replies with a More button", (await mores.count()) >= 2, String(await mores.count()));
    const mid = await mores.last().getAttribute("data-mid");
    const mine = `#conversation [data-act="more17c"][data-mid="${mid}"]`;
    /* The reply's buttons show on hover or on focus (.msg-acts:focus-within): reached from the keyboard. */
    await page.locator(mine).focus();
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "visible", timeout: 5000 });
    check("2 a reply's More: a redraw replaced its button while its menu was open", await redraw(page, mine));
    const expanded = await mores.evaluateAll((nodes) => nodes.filter((n) => n.getAttribute("aria-expanded") === "true").map((n) => n.dataset.mid));
    check("2 a reply's More: only that reply's new button says it is open", expanded.length === 1 && expanded[0] === mid, expanded.join(","));
    await page.locator(mine).focus();
    await page.keyboard.press("Enter");
    await wait(300);
    check("2 a reply's More: pressing that reply's button again closes its menu", (await menu.count()) === 0);
  } catch (e) { release(); check("scripted engine checks finished", false, e.stack); }
  check("no page errors (scripted engine)", errors.length === 0, errors.join(" | "));
  await context.close();
  await server.close().catch(() => {});
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await exports(browser);
    await french(browser);
    await scripted(browser);
  } catch (e) { check("verify finished", false, e.stack); }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
