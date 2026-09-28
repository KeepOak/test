/* A draw is held back while a press is on (core/dom.js pressIn), but the lists behind it are read again meanwhile. A
   remove button that named its line by its place removed whatever sat at that place in the newer list: a check-in line
   added above it by another window moved every line down one, and Remove took the line above the one pressed. Remove
   now names its line by its words and takes nothing when that line is gone (places/automations.js removeLine).
   Mutation: in automations.js put back `lines.splice(+el.dataset.i, 1)` on the newest heartbeat (with data-i on the
   button), and the first case goes red.
   Who is at the window, and whether Branch has locked, is heard only from GET /api/profiles (the event stream does not end
   when Branch locks). One refused answer (401, 429) used to stop that asking for good, and a lock afterwards never
   showed. It now asks again ever more slowly and never stops (main.js watchPerson).
   Mutation: make a 401 stop the asking (`stopped = true; return;`), and the lock case goes red; drop the slowing
   (ignore `refused` in wait()), and its gap goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { watchSettled } from "./page-settled.mjs";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-held-press-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = async (method, path, body) => {
    const response = await fetch(new URL(path, server.url), { method,
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: response.status, body: json };
  };
  await call("POST", "/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible", timeout: 120000 });
  return { page, call, errors };
}

async function setChecklist(call, lines) {
  const settings = (await call("GET", "/api/heartbeat")).body.heartbeat.settings;
  assert.equal((await call("POST", "/api/heartbeat", { ...settings, checklist: lines.join("\n") })).status, 200);
}
const checklist = async (call) => (await call("GET", "/api/heartbeat")).body.heartbeat.settings.checklist.split("\n").filter(Boolean);

/* Opens Automations on Check-ins with the checklist drawn, then holds a real press on the Remove of `line` while the
   engine's list changes to `meanwhile` and the page reads it again; lets go and waits until the page has settled. */
async function removeUnderPress(page, call, line, meanwhile) {
  const settled = watchSettled(page);
  await page.evaluate(async () => {
    const [{ S }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    S.view = "automations";
    S.tabs.automations = "checkins";
    renderNow();
  });
  /* The Remove of `line`, by the words it names. The list is drawn again when a re-read lands, so the pointer is put on
     it with hover(), which waits until the button is visible and still and tries again if a draw replaced it, rather
     than measuring a node a draw may already have taken away (its box was null on a busy build machine). */
  const button = page.locator(`#main [data-act="hb-rm"][data-v="${line}"]`);
  await button.hover({ timeout: 30000 });
  await page.mouse.down();
  await setChecklist(call, meanwhile);
  await page.evaluate(async () => (await import("/app/places/automations.js")).after());
  await page.mouse.up();
  /* Remove reads the list again and then saves it (automations.js removeLine): wait until every request the press
     started has been answered. Waiting for the first GET and 500 ms more left the save still in flight on a busy runner. */
  await settled();
}

test("Remove on a check-in line held across a re-read takes away that line, and nothing when it is gone", async (t) => {
  const { page, call, errors } = await signedIn(t);
  await setChecklist(call, ["alpha", "beta", "gamma"]);
  await removeUnderPress(page, call, "beta", ["added elsewhere", "alpha", "beta", "gamma"]);
  assert.deepEqual(await checklist(call), ["added elsewhere", "alpha", "gamma"]);

  await setChecklist(call, ["one", "two", "three"]);
  await removeUnderPress(page, call, "two", ["one", "three"]);
  assert.deepEqual(await checklist(call), ["one", "three"]);
  assert.deepEqual(errors, []);
});

/* Settings › Permissions: a rule's Remove is sent only when the rule at its place is still the one drawn on the button.
   It used to compare with the list as last read, which a re-read under a held press had already moved on, so a rule
   added in front meanwhile made Remove take the rule above the one pressed (a Never rule lost is a looser list).
   Mutation: compare with `P.rules.find((r) => r.index === at)?.rule` again, and this goes red. */
test("Remove on a rule held across a re-read never takes a rule other than the one pressed", async (t) => {
  const { page, call, errors } = await signedIn(t);
  const rule = (pattern) => ({ tool: "files.write", decision: "deny", resource: { kind: "path", pattern } });
  const patterns = async () => (await call("GET", "/api/rules")).body.rules.map((r) => r.rule.resource.pattern);
  for (const pattern of ["zq-first", "zq-second"]) assert.equal((await call("POST", "/api/rules/add", rule(pattern))).status, 200);
  assert.deepEqual(await patterns(), ["zq-second", "zq-first"]);
  await page.evaluate(async () => {
    const [{ S }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    S.level = "advanced";
    S.view = "settings";
    S.setPage = "permissions";
    renderNow();
  });
  const button = page.locator(`#main [data-act="rule-rm8"]`).nth(1);
  // The page draws again as its own reads arrive, which replaces the button for a moment: it is brought into view and
  // measured once it is back (a replaced button is looked up again; any other failure fails the test).
  let box = null;
  for (let tries = 0; tries < 50 && !box; tries++) {
    await button.waitFor({ state: "visible", timeout: 30000 });
    try { await button.scrollIntoViewIfNeeded({ timeout: 5000 }); box = await button.boundingBox(); } catch (error) {
      if (!/not attached to the DOM/.test(error.message)) throw error;
    }
  }
  assert.ok(box, "the second rule's Remove is on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  assert.equal((await call("POST", "/api/rules/add", rule("zq-added-elsewhere"))).status, 200);
  await page.evaluate(async () => (await import("/app/settings/pages/permissions.js")).load());
  const reread = page.waitForResponse((r) => r.url().endsWith("/api/rules") && r.request().method() === "GET", { timeout: 10000 });
  await page.mouse.up();
  await reread;
  await page.waitForTimeout(500);
  assert.deepEqual(await patterns(), ["zq-added-elsewhere", "zq-second", "zq-first"], "nothing is removed when the place holds another rule");
  assert.deepEqual(errors, []);
});

test("a refused answer to GET /api/profiles slows the asking but never stops it, so a lock still shows", async (t) => {
  const { page, call, errors } = await signedIn(t);
  let refuse = true;
  const asked = [];
  await page.route("**/api/profiles", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    asked.push({ at: Date.now(), refused: refuse });
    return refuse ? route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "refused" }) }) : route.continue();
  });
  const start = Date.now();
  while (!asked.length && Date.now() - start < 10000) await page.waitForTimeout(100);
  assert.ok(asked.length, "the window asked GET /api/profiles");
  while (asked.length < 2 && Date.now() - start < 20000) await page.waitForTimeout(100);
  assert.equal(asked.length >= 2, true, "a refused answer is asked again");
  const gap = asked[1].at - asked[0].at;
  assert.ok(gap >= 3500, `and more slowly than every two seconds (asked again after ${gap} ms)`);

  refuse = false;
  assert.equal((await call("POST", "/api/lock/pin", { pin: "1357" })).status, 200);
  assert.equal((await call("POST", "/api/lock", {})).status, 200);
  await page.locator(".lockscreen").waitFor({ state: "visible", timeout: 30000 });
  assert.deepEqual(errors, []);
});
