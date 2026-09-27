/**
 * mac3/security-check: the card on Settings → Permissions, opened the way a person opens it.
 * A headless browser only; the check runs against a Branch in a temporary folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";
import { settingsWindow, openSettingsPage, setLevel, isSoon } from "./settings-window.mjs";

/* The new window has no Security check card (the prototype has none). What still holds: both checks ship off, and the
   one the prototype draws, "Check install requests for malware" on Settings › Advanced, is drawn off with them and never
   claims more than the engine does. */
test("both checks ship when needed, and the new window's malware switch waits, greyed, until it is wired", async (t) => {
  const { app, page, errors } = await settingsWindow(t, { name: "security-ui" });
  // The ship-on rule (src/security-audit/settings.ts): both ship "when needed", and neither runs by itself.
  assert.deepEqual(app.security.settings(), { audit: "when-needed", malware: "when-needed" });
  assert.equal(app.security.state().report, null, "a fresh install checks nothing by itself");
  // The window's switch is not wired yet (it loosens safety when turned off, so it stays greyed for separate review).
  app.security.configure({ malware: "off" });
  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await openSettingsPage(page, "advanced");
  const malware = page.getByRole("checkbox", { name: "Check install requests for malware", exact: true });
  await malware.waitFor();
  assert.equal(await malware.isChecked(), false, "the switch says off, as the engine does");
  assert.equal(await isSoon(malware), true, "it waits, greyed out, until it is wired");
  assert.deepEqual(errors, []);
});

async function fixture(t, viewport = { width: 1440, height: 1000 }) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-security-ui-"));
  const dataDir = join(root, "data");
  const provider = { name: "security-ui-fixture", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider, home: root });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app, dataDir };
}

// Redesign: Coming soon (sw:f15-check-install-requests-for-malware), checked at fc541c24. The prototype has no audit
// switch and no "Run the check"; the ships-off defaults are checked above.
test.skip("both switches start off, a change is saved, and the check reports what it found", async (t) => {
  const { page, errors, app, dataDir } = await fixture(t);
  await openSettings(page, "permissions");
  const card = page.locator("#security-check");
  await card.waitFor();
  assert.equal(await card.locator("#security-audit-mode").inputValue(), "off");
  assert.equal(await card.locator("#security-malware-mode").inputValue(), "off");
  assert.match(await card.locator("#security-summary").innerText(), /Not checked yet/);

  await card.locator("#security-malware-mode").selectOption("when-needed");
  await card.getByText("Saved.").waitFor();
  assert.deepEqual(app.security.settings(), { audit: "off", malware: "when-needed" });

  if (process.platform !== "win32") await chmod(join(dataDir, "branch.sqlite"), 0o644).then(() => chmod(dataDir, 0o755));
  await card.getByRole("button", { name: "Run the check", exact: true }).click();
  await card.locator("#security-summary").filter({ hasText: /checks/ }).waitFor();
  if (process.platform !== "win32") {
    await card.locator('[data-check="files.database-readable"]').waitFor();
    await card.getByRole("button", { name: "Fix what Branch can", exact: true }).click();
    await card.getByText(/Now only you can reach it/).first().waitFor();
    assert.equal(await card.locator('[data-check="files.database-readable"]').count(), 0, "the repaired finding is gone");
  }
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (no Security check card); its French half also waits on the Language select,
// Coming soon (sw:lang), checked at fc541c24.
test.skip("the card holds its shape at 400 px and speaks French", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  await openSettings(page, "permissions");
  const card = page.locator("#security-check");
  await card.waitFor();
  await card.getByRole("button", { name: "Run the check", exact: true }).click();
  await card.locator("#security-summary").filter({ hasText: /checks/ }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow} px`);
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#security-check")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the card fits the window");
  // Waited for, not read once: the check redraws the card, so a label can still be empty this instant.
  for (const control of ["#security-audit-mode", "#security-malware-mode"]) {
    const named = await card.locator(`label[for="${control.slice(1)}"]`).filter({ hasText: /\S/ })
      .waitFor({ timeout: 5000 }).then(() => true, () => false);
    assert.ok(named, `${control} has a name`);
  }

  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.locator("#security-check h3.settings-card-title").filter({ hasText: "Contrôle de sécurité" }).waitFor();
  // isVisible() asks whether it is on the page this instant and never waits; waitFor() asks the
  // same question and gives the card time to finish being drawn again in French.
  const french = await page.locator("#security-check").getByRole("button", { name: "Lancer le contrôle" })
    .waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
  assert.ok(french, "the French card offers Lancer le contrôle");
  assert.deepEqual(errors, []);
});
