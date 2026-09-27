import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { settingsKitApi } from "../dist/settings-kit/api.js";
import { setLockdown } from "../dist/lockdown.js";
import { openPlace, openSettingFor } from "./places.mjs";

/* Q48/Q49 in the window, at phone width: the recent changes card lists a preset's change, refuses an
   undo that loosens without its own yes, undoes it with that yes, and says why a setting is set. */

// Redesign: replaced by the new window (no recent-changes card), and French waits on the Language select, Coming soon
// (sw:lang), checked at fc541c24.
test.skip("Q48/Q49 in French: the why answer names the preset in French, not by its English name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-history-fr-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const deps = { store: app.store, owner: app.runtime.owner, workspace: join(root, "workspace"), appVersion: "test" };
  const ask = (path, body) => settingsKitApi(deps, "POST", path, async () => body);
  const plan = { source: "preset", preset: "careful" };
  const { changes } = await ask("/api/settings-kit/preview", plan);
  // Q201: the Careful preset's move of the approval preset is weighed as less careful (web lookups stop asking), so
  // applying it needs the separate yes; this test is about the record and its undo, not about that move.
  await ask("/api/settings-kit/apply", { plan, accept: changes.map((change) => change.id), confirmLoosening: true });
  // Q48 review: Lockdown's own changes are listed, in French, with no undo of their own.
  setLockdown(app.store, app.runtime.owner, { on: true });
  setLockdown(app.store, app.runtime.owner, { on: false });

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#settings-kit-history").waitFor({ state: "attached", timeout: 60000 });
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#settings-kit-history");

  const card = page.locator("#settings-kit-history");
  await card.locator("#kit-why").selectOption("loop_guard.mode");
  await card.getByRole("button", { name: "Pourquoi est-il réglé ainsi ?" }).click();
  const answer = card.locator("p[role=status]", { hasText: "un préréglage" }).first();
  await answer.waitFor();
  const words = await answer.innerText();
  assert.match(words, /un préréglage \(Prudent\)/);
  assert.doesNotMatch(words, /Careful/);
  const locked = card.locator(".kit-record", { hasText: "le verrouillage" });
  assert.equal(await locked.count(), 2, "turning Lockdown on and off is listed as two changes");
  for (const row of await locked.all()) {
    assert.match(await row.innerText(), /Ce changement se défait en désactivant ou en activant le verrouillage[.]/);
    assert.equal(await row.getByRole("button", { name: "Annuler cette modification" }).count(), 0, "a Lockdown change offers an undo");
  }
  assert.deepEqual(errors, []);
});
