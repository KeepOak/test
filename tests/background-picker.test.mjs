import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { openSettingFor } from "./places.mjs"; // the old window's helper, for the skipped body only

/* Redesign: Settings › Appearance › Background (settings/pages/appearance.js, shell/ownbg.js), 1:1 with prototype.html:
   "Your own" shows the prototype's file field ("Choose a background file"), the chosen file is kept in this window's
   storage only, drawn behind the glass (#bgLayer .bg-media), and Remove asks first. The old themed "Choose a file…"
   button and its looks are replaced by that field. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-background-picker-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir,
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ done: true }) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openOwnBackground(page);
  return { page, errors };
}
/** Settings › Appearance, then Background › "Your own". */
async function openOwnBackground(page) {
  if (await page.evaluate(() => innerWidth <= 760)) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="appearance"]').click();
  const own = page.locator('[data-act="bgset"][data-v="own"]');
  if (await own.getAttribute("aria-pressed") !== "true") await own.click();
  await page.locator("#bg-file6").waitFor({ state: "attached" });
}
const png = { name: "a-long-real-background-name.png", mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMAAAAwGAQFm2g5eAAAAAElFTkSuQmCC", "base64") };
const savedName = (page) => page.locator(".set-col .ctl b", { hasText: png.name });

test("background picker is the prototype's named file field, in view and reachable by keyboard at desktop, tablet and phone widths", async (t) => {
  const { page, errors } = await fixture(t);
  const choose = page.getByLabel("Choose a background file", { exact: true });
  assert.equal(await choose.count(), 1, "one named field chooses the file");
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForTimeout(100); // the page redraws on a new size, replacing the field
      // Measured in one step inside the page: a redraw can replace the field between two steps.
      const seen = await page.evaluate(() => {
        const field = document.getElementById("bg-file6");
        field.scrollIntoView({ block: "center" });
        field.focus();
        const box = field.getBoundingClientRect();
        return { focused: document.activeElement === field, inside: box.left >= 0 && box.right <= innerWidth, enabled: !field.disabled && field.getAttribute("aria-disabled") !== "true" };
      });
      assert.ok(seen.focused, "the keyboard reaches it");
      assert.ok(seen.inside, `the complete field fits the viewport at ${width} px`);
      assert.ok(seen.enabled, "it is live, not Coming soon");
    }
  }
  assert.deepEqual(errors, [], "startup and settings must stay error-free");
});

test("background picker opens by mouse, Enter and Space; keeps filenames, errors and repeat selection functional", async (t) => {
  const { page, errors } = await fixture(t);
  for (const activation of ["click", "Enter", "Space"]) {
    const choose = page.locator("#bg-file6");
    const opened = page.waitForEvent("filechooser");
    if (activation === "click") await choose.click();
    else { await choose.focus(); await choose.press(activation); }
    await (await opened).setFiles(png);
    await savedName(page).waitFor();
    await page.locator("#bgLayer .bg-media").waitFor({ state: "attached" });
    // The pick ends with its own note; a wrong file chosen before that note would have its refusal replaced by it.
    await page.getByRole("status").filter({ hasText: "Kept on this computer." }).waitFor();
    await page.locator("#bg-file6").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") });
    await page.getByRole("status").filter({ hasText: /can’t go behind the glass/ }).waitFor();
    assert.equal(await savedName(page).count(), 1, "rejection retains the saved picture");
  }
  await page.locator("#bg-file6").setInputFiles([]);
  assert.equal(await savedName(page).count(), 1, "cancelling does not forget the saved file");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openOwnBackground(page);
  await savedName(page).waitFor();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("dialog", { name: "Remove your background?" }).getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Removed. Nothing is kept." }).waitFor();
  await page.locator('[data-act="bgset"][data-v="own"]').click();
  await page.getByLabel("Choose a background file", { exact: true }).waitFor();
  assert.equal(await savedName(page).count(), 0, "the file is gone");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:lang), checked at e5b8a610.
test.skip("background picker keeps its accessible name when the language changes", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  const choose = page.getByRole("button", { name: "Choisir un fichier…", exact: true });
  assert.equal(await choose.count(), 1);
  const opened = page.waitForEvent("filechooser");
  await choose.press("Enter");
  assert.equal((await opened).isMultiple(), false);
  assert.deepEqual(errors, []);
});
