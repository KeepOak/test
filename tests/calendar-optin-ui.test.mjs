/* The real Accounts card, handlers and feature gate; no provider or OAuth traffic. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { waitInPage } from "./wait-in-page.mjs";

const publicRoot = fileURLToPath(new URL("../public", import.meta.url));
async function staticPage(t) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") { response.end('<div id="app"><div id="cards"></div><input id="unfinished-control"></div>'); return; }
    const path = resolve(publicRoot, "." + pathname);
    if (!path.startsWith(publicRoot + sep)) { response.writeHead(404).end(); return; }
    try {
      response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : "application/json");
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: "block" });
  page.setDefaultTimeout(5000);
  return { page, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t) {
  const { page, url } = await staticPage(t), writes = [], errors = [];
  const settings = Object.fromEntries(["google", "microsoft", "spotify"].map(id => [id, { clientId: `fixture-${id}`, calendarWrite: false }]));
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON();
    const id = /^\/api\/personal\/signin\/(google|microsoft|spotify)$/.exec(path)?.[1];
    let result;
    if (id) {
      if (body) { writes.push({ path, body }); Object.assign(settings[id], body); }
      result = { settings: settings[id], status: { signedIn: false } };
    } else if (path === "/api/personal/home" || path === "/api/personal/mail") result = { settings: {} };
    else if (path === "/api/connectors/accounts") result = { accounts: [] };
    else if (path === "/api/mcp/servers") result = { servers: [] };
    else throw new Error(`Unexpected fixture API: ${path}`);
    await route.fulfill({ json: result });
  });
  await page.goto(url);
  await page.evaluate(async () => {
    const { E, S } = await import("/app/core/state.js");
    E.profiles = { active: { id: "owner" }, isOwner: true }; E.state = { lock: { locked: false } };
    Object.assign(S, { signedIn: true, view: "settings", setPage: "accounts", project: "default" });
    const accounts = await import("/app/settings/more18.js"), dom = await import("/app/core/dom.js");
    const { greyOut } = await import("/app/core/features.js");
    accounts.initMore(); (await import("/app/core/actions.js")).listen();
    dom.onRender(() => { dom.paint(document.getElementById("cards"), accounts.moreSections()); greyOut(document); });
    await accounts.loadMore();
  });
  return { page, writes, errors };
}

for (const id of ["google", "microsoft"]) test(`Accounts ${id} calendar opt-in is enabled, explicit and saves both directions`, async t => {
  const { page, writes, errors } = await fixture(t), checkbox = page.locator(`#more18-${id}-calendar`);
  assert.equal(await checkbox.isDisabled(), false, "implemented opt-in survives the real feature gate");
  assert.equal(await checkbox.isChecked(), false, "write consent starts off");
  assert.equal(await checkbox.getAttribute("aria-disabled"), null);
  assert.equal(await page.locator("#unfinished-control").isDisabled(), true, "unregistered fields stay gated");
  assert.equal(await page.locator("#more18-spotify-calendar").count(), 0, "only calendar providers get the control");
  const other = id === "google" ? "microsoft" : "google";
  const save = page.locator(`[data-act="more18-save"][data-v="${id}"]`);
  await checkbox.check(); assert.equal(writes.length, 0, "ticking alone starts no request");
  await page.evaluate(service => { window.fixtureSavedControl = document.getElementById(`more18-${service}-calendar`); }, id);
  const firstRead = page.waitForResponse(response => response.url().endsWith(`/api/personal/signin/${id}`) && response.request().method() === "GET");
  await save.click(); await firstRead;
  await waitInPage(page, service => document.getElementById(`more18-${service}-calendar`) !== window.fixtureSavedControl
    && document.getElementById(`more18-${service}-calendar`)?.checked === true, id);
  assert.deepEqual(writes, [{ path: `/api/personal/signin/${id}`, body: { clientId: `fixture-${id}`, calendarWrite: true } }]);
  assert.equal(await page.locator(`#more18-${other}-calendar`).isChecked(), false);
  await checkbox.uncheck();
  await page.evaluate(service => { window.fixtureSavedControl = document.getElementById(`more18-${service}-calendar`); }, id);
  const secondRead = page.waitForResponse(response => response.url().endsWith(`/api/personal/signin/${id}`) && response.request().method() === "GET");
  await save.click(); await secondRead;
  await waitInPage(page, service => document.getElementById(`more18-${service}-calendar`) !== window.fixtureSavedControl
    && document.getElementById(`more18-${service}-calendar`)?.checked === false, id);
  assert.deepEqual(writes[1], { path: `/api/personal/signin/${id}`, body: { clientId: `fixture-${id}`, calendarWrite: false } });
  assert.equal(writes.length, 2, "save never starts sign-in or a calendar mutation");
  assert.deepEqual(errors, []);
});

test("Accounts calendar save refuses a card after the owner locks the window", async t => {
  const { page, writes, errors } = await fixture(t);
  await page.locator("#more18-google-calendar").check();
  await page.evaluate(() => document.getElementById("app").classList.add("locked-b17"));
  await page.locator('[data-act="more18-save"][data-v="google"]').click();
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
});
