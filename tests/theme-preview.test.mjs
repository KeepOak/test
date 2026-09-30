/* DG-039: the Appearance preview is the approved sample's (design/Branch-Grown-Up.html, its live `mirrorsHTML` inside
   `lookHTML`): two live mirrors of this window, Moonlight then Daylight, each with a small chip. On a page 980px or
   wider they stack beside the choices; narrower, a strip names the theme and opens them side by side; at 540px or less
   one shows at a time with a button that flips to the other. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs"; // the old window's helper, for the skipped bodies only
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

async function appearance(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-preview-"));
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
  await openSettings(page, "appearance");
  await page.mouse.move(0, 0); // nothing pointed at, so the preview shows the chosen theme
  await page.locator("#sg-mirrors").waitFor();
  return { page, errors };
}
const shown = (page) => page.$$eval(".sg-mirror", (figures) => figures.filter((figure) => figure.getBoundingClientRect().height > 0)
  .map((figure) => ({ mode: figure.dataset.mode, chip: figure.querySelector("figcaption").textContent, box: figure.getBoundingClientRect().toJSON() })));
const drawn = (page) => page.waitForFunction(() => [...document.querySelectorAll(".sg-mirror")]
  .filter((figure) => figure.getBoundingClientRect().height > 0)
  .every((figure) => figure.querySelector("iframe").contentDocument?.body?.children.length > 0));

/* Redesign: prototype.html's Appearance previews are its "Light or dark" mirrors (settings/pages/appearance.js mirror()):
   a light and a dark picture of this window beside "Match this computer", each drawn from the open conversation's own
   words (its title and last line), never made-up ones. They are pictures, not live copies in frames; the old strip, the
   side-by-side and the one-at-a-time flip are not in the design. */
test("DG-039 the Light and Dark mirrors show this window's own conversation, at every width", async (t) => {
  for (const width of [1440, 1100, 400]) {
    const root = await mkdtemp(join(tmpdir(), "branch-theme-preview-"));
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
    const run = app.store.createRun(app.runtime.owner, "Plan the allotment");
    app.store.message(run.sessionId, { role: "user", content: run.prompt });
    app.store.message(run.sessionId, { role: "assistant", content: "Beans by the fence, squash in the sun." });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
    await fetch(new URL("/api/onboarding", server.url), {
      method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
    });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    if (width <= 760) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
    await openChat(page, run.sessionId);
    await page.locator("#conversation").getByText("Beans by the fence, squash in the sun.", { exact: true }).waitFor();
    if (width <= 760) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="appearance"]').click();
    const mirrors = page.locator('.set-col .mirrors [data-act="themeset"]');
    await mirrors.first().waitFor();
    for (const mode of ["light", "dark"]) {
      const text = await page.locator(`.set-col .mirrors [data-act="themeset"][data-v="${mode}"]`).innerText();
      assert.match(text, /Plan the allotment/, `${width} ${mode}: the open conversation's title`);
      assert.match(text, /Beans by the fence, squash in the sun\./, `${width} ${mode}: and its last line`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), `${width}: nothing scrolls sideways`);
    assert.deepEqual(errors, []);
  }
});

// Redesign: replaced by the new window (prototype.html's mirrors are pictures beside "Match this computer", not framed live
// copies with chips, a strip or a flip; checked live above).
// Its French is Coming soon (sw:lang), checked at e5b8a610.
test.skip("DG-039 on a phone one mirror shows at a time, and a button flips to the other", async (t) => {
  const { page, errors } = await appearance(t, 400);
  await page.locator(".sg-strip").click();
  await drawn(page);
  assert.deepEqual((await shown(page)).map(({ mode }) => mode), ["dark"]);
  const flip = page.locator(".sg-mirror-flip");
  assert.equal(await flip.textContent(), "Show Daylight");
  assert.deepEqual(await flip.evaluate((node) => {
    const style = getComputedStyle(node), icon = node.querySelector("svg");
    return { height: node.getBoundingClientRect().height, size: style.fontSize, radius: style.borderRadius, padding: style.padding,
      icon: icon && icon.getAttribute("aria-hidden") === "true" ? icon.getBoundingClientRect().width : null };
  }), { height: 30, size: "12.5px", radius: "9px", padding: "0px 11px", icon: 15 }, "the sample's `btn sm` with its swap icon");
  await flip.click();
  await drawn(page);
  assert.deepEqual((await shown(page)).map(({ mode }) => mode), ["light"]);
  assert.equal(await flip.textContent(), "Show Moonlight");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.querySelector(".sg-mirror-flip span")?.textContent !== "Show Moonlight");
  assert.equal(await flip.locator("svg").count(), 1, "a language change re-words the button and keeps its icon");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), "nothing scrolls sideways");
  assert.deepEqual(errors, []);
});
