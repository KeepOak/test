/**
 * #485 review: Ctrl K finds archived conversations (GET /api/sessions/put-away?kind=archived). What one opening read is
 * never shown by the next: closing forgets it, and the next opening reads again once typing starts, so a conversation
 * deleted since (or another household profile's) is not listed from an earlier read while the new one is on its way.
 * Mutation, turns it red: public/app/shell/palette.js closePalette: drop `P.archived = []`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("an opening of Ctrl K never lists archived conversations an earlier opening read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-palette-archived-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(`/api/${path}`, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  await call("onboarding", { done: true });
  const seed = (words) => {
    const run = app.store.createRun(app.runtime.owner, words);
    app.store.message(run.sessionId, { role: "user", content: words });
    app.store.finish(run.id, "completed", "Done.");
    return run.sessionId;
  };
  const owl = seed("the owl archive"), elk = seed("the elk archive");
  await call(`sessions/${owl}/archive`, { archived: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const list = () => page.locator("#pal-list").innerText();

  const firstRead = page.waitForResponse((response) => response.url().includes("/api/sessions/put-away?kind=archived") && response.ok());
  await page.keyboard.press("Control+k");
  await page.locator("#pal-in").fill("archive");
  await firstRead;
  await page.waitForFunction(() => {
    const text = document.querySelector("#pal-list")?.textContent ?? "";
    return /the owl archive/.test(text) && /Archived/.test(text);
  }, null, { timeout: 10000 });
  await page.keyboard.press("Escape");

  // The owl conversation is deleted and the elk one archived; the next opening's read is held until checked.
  await call(`sessions/${owl}/delete`, {});
  await call(`sessions/${elk}/archive`, { archived: true });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let initiated;
  const routed = new Promise((resolve) => { initiated = resolve; });
  let asked = 0;
  await page.route("**/api/sessions/put-away?kind=archived*", async (route) => { asked++; initiated(); await held; await route.continue().catch(() => undefined); });
  await page.keyboard.press("Control+k");
  const requested = page.waitForRequest((request) => request.url().includes("/api/sessions/put-away?kind=archived"));
  try {
    // Reproduce a sidebar refresh between deleting the old archive and archiving
    // the new one: its cached count is zero when typing starts, the engine's is not.
    await page.evaluate(async () => {
      const { E } = await import("/app/core/state.js");
      E.putAway.archived = 0;
      const input = document.querySelector("#pal-in");
      input.value = "owl archive";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await requested;
    await routed;
    assert.equal(asked, 1, "typing reads the archived list again even with a stale zero count");
    assert.doesNotMatch(await list(), /the owl archive/, "the earlier opening's read is not listed");
  } finally { release(); }
  await page.locator("#pal-in").fill("elk archive");
  await page.waitForFunction(() => /the elk archive/.test(document.querySelector("#pal-list")?.textContent ?? ""), null, { timeout: 10000 });
  await page.locator("#pal-in").fill("owl archive");
  assert.doesNotMatch(await list(), /Archived/, "and the fresh read has only what is archived now");
  assert.equal(asked, 1, "read once for the opening, not on every key");
  assert.deepEqual(errors, []);
});
