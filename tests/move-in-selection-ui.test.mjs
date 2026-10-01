/* Real Move In handlers and greyOut, with only local fake preview/import responses. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { waitInPage } from "./wait-in-page.mjs";

const publicRoot = fileURLToPath(new URL("../public", import.meta.url));
const items = [
  { key: "first", title: "First", detail: "Eligible" },
  { key: "second", title: "Second", detail: "Eligible" },
  { key: "blocked", title: "Blocked", detail: "Refused", blocked: "not allowed" },
  { key: "moved", title: "Moved", detail: "Already imported", alreadyMoved: true },
];
const preview = { name: "Fixture assistant", from: "local fixture", groups: [{ name: "History", items }] };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function staticPage(t) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") { response.end('<div id="app"><button data-act="moveinb17">Move In</button><input id="unfinished-control"></div>'); return; }
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
  const { page, url } = await staticPage(t), previews = [], imports = [], gate = deferred(), started = deferred(), errors = [];
  t.after(() => gate.resolve());
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON();
    let result;
    if (path === "/api/move-in") result = { mode: "when-needed", sources: [{ source: "claude-code", name: "Fixture", found: true }] };
    else if (path === "/api/move-in/preview") { previews.push(body); result = preview; }
    else if (path === "/api/move-in/import") {
      imports.push(body); started.resolve(); await gate.promise;
      result = { name: "Fixture", brought: [{ key: "first" }], skipped: [] };
    } else throw new Error(`Unexpected fixture API: ${path}`);
    await route.fulfill({ json: result });
  });
  await page.goto(url);
  await page.evaluate(async () => {
    const { E, S } = await import("/app/core/state.js");
    E.profiles = { active: { id: "owner" }, isOwner: true }; S.signedIn = true;
    (await import("/app/core/api.js")).token.set("fixture-session");
    (await import("/app/settings/p17-usage.js")).init17();
    (await import("/app/core/actions.js")).listen();
    (await import("/app/core/features.js")).greyOut(document);
  });
  return { page, previews, imports, started: started.promise, release: gate.resolve, errors };
}

async function openPreview(f, archive) {
  const { page } = f;
  await page.locator('[data-act="moveinb17"]').click();
  await page.locator('[data-act="moveinpickb17"]').waitFor();
  if (archive) {
    const chosen = page.waitForEvent("filechooser");
    await page.locator('[data-act="moveinfileb17"]').click();
    await (await chosen).setFiles({ name: "history.zip", mimeType: "application/zip", buffer: Buffer.from("fixture archive") });
  } else await page.locator('[data-act="moveinpickb17"]').click();
  await page.locator('[data-move-item="first"]').waitFor();
}

for (const archive of [false, true]) test(`Move In ${archive ? "export file" : "local source"} enables eligible selection and imports only checked keys`, async t => {
  const f = await fixture(t); await openPreview(f, archive);
  const { page } = f, first = page.locator('[data-move-item="first"]'), second = page.locator('[data-move-item="second"]');
  const bring = page.locator('[data-act="moveingob17"]');
  assert.equal(await first.isDisabled(), false, "eligible checkbox survives the real dialog greyOut");
  assert.equal(await second.isDisabled(), false);
  assert.equal(await first.isChecked(), false, "nothing is selected without consent");
  assert.equal(await bring.isDisabled(), true);
  for (const key of ["blocked", "moved"]) assert.equal(await page.locator(`[data-move-item="${key}"]`).isDisabled(), true);
  assert.equal(await page.locator("#unfinished-control").isDisabled(), true, "unregistered controls stay gated");
  await first.check(); await second.check(); await second.uncheck(); await first.uncheck();
  assert.equal(await bring.isDisabled(), true, "deselecting every item disables Bring");
  await first.check(); assert.equal(await bring.isDisabled(), false);
  await bring.click(); await f.started; await waitInPage(page, () => document.querySelector('[role="status"]') !== null);
  assert.equal(f.imports.length, 1); assert.deepEqual(f.imports[0].items, ["first"]);
  for (const key of ["first", "second", "blocked", "moved"]) assert.equal(await page.locator(`[data-move-item="${key}"]`).isDisabled(), true, "busy disables every item");
  assert.equal(await bring.isDisabled(), true);
  if (archive) {
    assert.deepEqual(f.previews[0].archive, { name: "history.zip", data: Buffer.from("fixture archive").toString("base64") });
    assert.deepEqual(f.imports[0].archive, f.previews[0].archive);
  } else assert.equal(f.imports[0].source, "claude-code");
  f.release(); await waitInPage(page, () => document.querySelectorAll("[data-move-item]").length === 0);
  assert.deepEqual(f.errors, []);
});

test("Move In selection cannot import after the active owner changes", async t => {
  const f = await fixture(t); await openPreview(f, false);
  await f.page.locator('[data-move-item="first"]').check();
  await f.page.evaluate(async () => { (await import("/app/core/state.js")).E.profiles = { active: { id: "guest" }, isOwner: false }; });
  await f.page.locator('[data-act="moveingob17"]').click();
  assert.equal(f.imports.length, 0);
  assert.equal(await f.page.locator('[role="dialog"]').count(), 0);
  assert.deepEqual(f.errors, []);
});
