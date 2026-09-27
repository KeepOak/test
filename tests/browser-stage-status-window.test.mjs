import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newWindow } from "./new-window-places.mjs";

const TEMP = process.platform === "win32" ? "C:/Users/bishi/AppData/Local/Temp/Codex-session-files" : tmpdir();
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

async function stage(t) {
  let run;
  const root = await mkdtemp(join(TEMP, "browser-stage-status-"));
  const w = await newWindow(t, { root, seed(app) {
    run = app.store.createRun(app.runtime.owner, "Browser view");
    app.store.message(run.sessionId, { role: "user", content: run.prompt });
    app.store.message(run.sessionId, { role: "assistant", content: "Ready." });
    app.store.finish(run.id, "completed", "Ready.");
  } });
  let browser = null, readError = false, outcome = { status: "failed", error: "This site is not allowed. Add it in Settings > Browser." };
  await w.page.route("**/api/panels/live?*", route => route.fulfill(readError
    ? { status: 503, json: { error: "Browser connection interrupted. Reconnect Branch." } }
    : { json: { runId: null, status: null, doing: null, browser } }));
  await w.page.route("**/api/panels/browse", async route => route.fulfill({ json: await outcome }));
  await w.page.locator(`[data-act="chat"][data-id="${run.sessionId}"]`).first().click();
  await w.page.locator("#conversation .b").first().waitFor();
  await w.page.locator('.head [data-act="stage"][data-v="browser"]').first().click();
  const view = (extra = {}) => ({ live: true, runId: run.id, url: "https://example.org/", title: "Example page",
    tabs: [{ url: "https://example.org/", title: "Example page", active: true }], frame: null, at: new Date().toISOString(), ...extra });
  return { ...w, view, setBrowser(value) { browser = value; }, setOutcome(value) { outcome = value; }, setReadError(value) { readError = value; } };
}

test("an open page without a preview keeps its address and tabs, explains the unavailable preview, and recovers", async t => {
  const w = await stage(t), { page } = w;
  w.setBrowser(w.view());
  await page.locator("#stage7 .dk-url").filter({ hasText: "https://example.org/" }).waitFor({ timeout: 10000 });
  assert.match(await page.locator("#stage7 .dk-tabs").innerText(), /Example page/);
  assert.match(await page.locator("#stage7 [role=status]").innerText(), /Preview unavailable/);
  assert.doesNotMatch(await page.locator("#stage7").innerText(), /Nothing open|hasn’t opened a page/);
  w.setBrowser(w.view({ frame: JPEG }));
  await page.locator("#stage7 .live7-img[src^='data:image/jpeg']").waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#stage7 [role=status]").count(), 0);
  assert.deepEqual(w.errors, []);
});

test("a rejected address keeps its text and a persistent actionable reason; the next successful opening clears it", async t => {
  const w = await stage(t), { page } = w;
  const input = page.locator("#st-addr");
  await input.fill("example.org");
  await input.press("Enter");
  await page.locator("#stage7 [role=status]").filter({ hasText: "This site is not allowed." }).waitFor({ timeout: 10000 });
  assert.equal(await input.inputValue(), "example.org");
  w.setOutcome({ status: "done" });
  w.setBrowser(w.view({ frame: JPEG }));
  await input.press("Enter");
  await page.locator("#stage7 .live7-img[src^='data:image/jpeg']").waitFor({ timeout: 10000 });
  assert.doesNotMatch(await page.locator("#stage7").innerText(), /This site is not allowed/);
  assert.equal(await input.inputValue(), "");
  assert.deepEqual(w.errors, []);
});

test("a borrowed browser stays unpictured and a live-read error remains visible until recovery", async t => {
  const w = await stage(t), { page } = w;
  w.setBrowser(w.view({ preview: "borrowed" }));
  await page.locator("#stage7 [role=status]").filter({ hasText: "your own browser" }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#stage7 .live7-img").count(), 0);
  assert.match(await page.locator("#stage7 .dk-url").innerText(), /example.org/);
  w.setReadError(true);
  await page.locator("#stage7 [role=status]").filter({ hasText: "Reconnect Branch." }).waitFor({ timeout: 10000 });
  assert.doesNotMatch(await page.locator("#stage7").innerText(), /Nothing open/);
  w.setReadError(false);
  w.setBrowser(w.view({ preview: "ready", frame: JPEG }));
  await page.locator("#stage7 .live7-img[src^='data:image/jpeg']").waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#stage7 [role=status]").count(), 0);
  assert.deepEqual(w.errors, []);
});

test("an address opening shows progress and prevents duplicate submissions until its answer arrives", async t => {
  const w = await stage(t), { page } = w;
  let answer;
  w.setOutcome(new Promise(resolve => { answer = resolve; }));
  const input = page.locator("#st-addr");
  await input.fill("example.org");
  await input.press("Enter");
  await page.locator("#stage7 [role=status]").filter({ hasText: "Opening page…" }).waitFor();
  assert.equal(await input.isDisabled(), true);
  assert.equal(await input.inputValue(), "example.org");
  answer({ status: "refused", reason: "Allow this site in Settings > Browser before opening it." });
  await page.locator("#stage7 [role=status]").filter({ hasText: "Allow this site" }).waitFor();
  assert.equal(await input.isDisabled(), false);
  assert.doesNotMatch(await page.locator("#stage7").innerText(), /Nothing open/);
  assert.deepEqual(w.errors, []);
});
