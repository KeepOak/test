import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-directory-headings-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors };
}

const directories = ["connections", "skills", "memory", "automations"];
for (const width of [1440, 860, 400]) {
  // Redesign: replaced by the new window (the prototype's Settings has no Connections, Skills, Memory or Automations
  // directory pages; they are places, not Settings pages), and French waits on sw:lang, Coming soon, checked at fc541c24.
  test.skip(`DG-008 directory headings sit below the Settings page title at ${width}px`, async (t) => {
    const { page, errors } = await fixture(t, width);
    for (const language of ["en", "fr"]) {
      await page.evaluate(async (lang) => (await import("/i18n.js")).setLanguage(lang), language);
      for (const directory of directories) {
        await openPlace(page, `settings:${directory}`);
        const host = page.locator(`#lx-page-${directory}`);
        assert.equal(await host.getByRole("heading", { level: 2 }).count(), 1, "only the page title is level two");
        const cards = host.locator(".settings-directory-card");
        assert.ok(await cards.count(), "real directory cards loaded");
        for (const card of await cards.all()) {
          const title = card.locator(".settings-directory-title");
          const name = (await title.textContent()).trim();
          assert.equal(await title.evaluate((node) => node.tagName), "H3", "native heading, not an ARIA override");
          assert.equal(await card.getByRole("heading", { name, exact: true, level: 3 }).count(), 1);
          const open = card.getByRole("button");
          assert.equal(await open.getAttribute("aria-label"), `${language === "en" ? "Open" : "Ouvrir"} ${name}`);
          const style = await title.evaluate((node) => {
            const css = getComputedStyle(node);
            return { size: css.fontSize, weight: css.fontWeight, line: css.lineHeight, tracking: css.letterSpacing };
          });
          assert.deepEqual(style, { size: "16px", weight: "640", line: "20.8px", tracking: "normal" });
        }
      }
    }
    assert.equal(await page.locator(".settings-directory-title").count(), 12, "every existing directory is checked");
    assert.deepEqual(errors, []);
  });
}
