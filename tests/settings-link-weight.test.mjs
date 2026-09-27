/* DG-173: the Settings page links are the approved sample's (design/Branch-Grown-Up.html, `.set-pages .nav`, rendered
   the same at every width and in both lights): 13.5px on a 1.55 line with 6px 10px around it, weight 400, and 600 for
   the page on show. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function settings(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-link-weight-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.locator("body.sg-ready").waitFor();
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  await page.locator('.lx-settings-link[data-page="general"]').click();
  return { page, errors };
}

/** The sample's measurements, the same for the page on show (but its weight) and every other. */
const SAMPLE = { size: "13.5px", line: "20.925px", padding: "6px 10px", height: 32.9 };
const look = (node) => {
  const style = getComputedStyle(node);
  return { size: style.fontSize, line: style.lineHeight, padding: style.padding, height: Math.round(node.getBoundingClientRect().height * 10) / 10, weight: style.fontWeight };
};

for (const width of [1440, 860, 390]) {
  // Redesign: replaced by the new window (the page links are the prototype's .set-nav .nav, with its own size, spacing and
  // weight; /appearance.js is gone with the old window).
  test.skip(`DG-173 at ${width} px the page links are the sample's weight, line and padding, in both lights`, async (t) => {
    const { page, errors } = await settings(t, width);
    for (const appearance of ["forest", "daylight"]) {
      await page.evaluate(async (value) => {
        const { applyAppearance, currentAppearance } = await import("/appearance.js");
        applyAppearance({ ...currentAppearance(), appearance: value });
      }, appearance);
      const seen = await page.evaluate((measure) => {
        const read = new Function(`return (${measure})`)();
        const current = document.querySelector('.lx-settings-link[data-page="general"]');
        const other = document.querySelector('.lx-settings-link[data-page="assistant"]');
        return { current: read(current), other: read(other) };
      }, look.toString());
      const where = `${width} px, ${appearance}`;
      assert.deepEqual(seen.current, { ...SAMPLE, weight: "600" }, `${where}: the page on show`);
      assert.deepEqual(seen.other, { ...SAMPLE, weight: "400" }, `${where}: another page`);
    }
    assert.deepEqual(errors, []);
  });
}
