/* selfdev: Settings › Branch itself, what Branch may do about itself. The rows that were greyed now show the rule in
   force and change it (src/self-rules.ts); a less careful choice waits for the owner's yes in a dialog with the
   engine's words; working on its own code says why it waits until Git work may go to GitHub; Reload without dropping
   work is live. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readPolicy } from "../dist/policy.js";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-self-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="self"]').click();
  await page.locator('[data-act="setpage"][data-v="self"][aria-current="true"]').waitFor();
  await page.waitForTimeout(1200);
  return { app, page, errors };
}

test("the rows about Branch itself are live, show the rule in force, and a looser choice waits for a yes", async (t) => {
  const { app, page, errors } = await signedIn(t);
  const row = (act, v) => page.locator(`.set-col [data-act="${act}"][data-v="${v}"]`);
  for (const act of ["self-own", "self-timings", "self-restart", "self-loosen"])
    assert.equal(await page.locator(`.set-col [data-act="${act}"]`).first().getAttribute("aria-disabled"), null, `${act} is live`);
  assert.equal(await row("self-own", "ask").getAttribute("aria-pressed"), "true");
  assert.equal(await row("self-loosen", "ask").getAttribute("aria-pressed"), "true", "loosening always asks, and says so");
  assert.equal(await page.locator('.set-col [data-act="self-reload"]').getAttribute("aria-disabled"), null, "reload is live");
  // Never: a refusal for settings.change, at once.
  await row("self-own", "never").click();
  await page.locator('.set-col [data-act="self-own"][data-v="never"][aria-pressed="true"]').waitFor({ timeout: 15000 });
  assert.ok(readPolicy(app.store, app.runtime.owner).rules.some((rule) => rule.tool === "settings.change" && rule.decision === "deny"));
  // Back to Ask me first loosens it: the engine's words, and nothing changes until the yes.
  await row("self-own", "ask").click();
  await page.locator('[data-act="self-rule-yes"]').waitFor({ timeout: 15000 });
  assert.match(await page.locator(".dlg, dialog, [role=dialog]").first().innerText(), /less careful/);
  assert.ok(readPolicy(app.store, app.runtime.owner).rules.some((rule) => rule.tool === "settings.change" && rule.decision === "deny"));
  await page.locator('[data-act="self-rule-yes"]').click();
  await page.locator('.set-col [data-act="self-own"][data-v="ask"][aria-pressed="true"]').waitFor({ timeout: 15000 });
  assert.ok(!readPolicy(app.store, app.runtime.owner).rules.some((rule) => rule.tool === "settings.change"));
  // Working on its own code waits for Git work to go to GitHub, and says so in place.
  const box = page.locator("#self-dev-remote");
  assert.equal(await box.isDisabled(), true);
  assert.match(await box.getAttribute("data-tip") ?? "", /GitHub/);
  assert.deepEqual(errors, []);
});
