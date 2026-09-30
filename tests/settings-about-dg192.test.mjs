/* DG-192: Settings › Updates & about has the approved sample's sections, in its order, at every width and level:
   Updates · Updating by itself · The keeper. Reporting a problem and removing Branch have no place in the sample yet,
   so they wait for Advanced and never add a head or an "N more" line at Regular. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, { width = 1440, height = 950, preferences } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-about-dg192-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  if (preferences) app.store.save("settings", app.runtime.owner, "preferences", preferences);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  return { page, errors, app };
}
async function openAbout(page) {
  const cog = page.locator(".lx-foot-line > .sg-gear:visible");
  if (!(await cog.count())) await page.locator("#rail-toggle").click();
  await cog.click();
  await page.locator('.lx-settings-link[data-page="about"]').click();
  await page.locator("#about-keeper").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
}
/* The new window: Settings › Updates & about is the same at every width and level: its title, Updating and Remove Branch;
   Branch Agent and its version under the title; Updating by itself saves as it is switched,
   with no Save button. (Remove Branch is never pressed here.) */
test("DG-192 Updates & about has the prototype's sections at every width and level, with Branch Agent and its version", async (t) => {
  const { settingsWindow, openSettingsPage, setLevel, assertHeadings } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "about-dg192" });
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const one of ["regular", "advanced", "technical"]) {
      await openSettingsPage(page, "updates");
      await setLevel(page, one);
      // The page's title is on the screen before its sections are read: a slow runner once read them between draws (the
      // Checks on daf53cc3 saw none at all). If the page never draws, the failure says what the window shows instead.
      await page.locator(".set-col h1").first().waitFor({ state: "visible", timeout: 10000 }).catch(async (error) => {
        const shown = await page.evaluate(async () => { const { S } = await import("/app/core/state.js"); return { view: S.view, setPage: S.setPage, cols: document.querySelectorAll(".set-col").length }; });
        throw new Error(`${width} px, ${one}: no Updates & about title (${JSON.stringify(shown)}): ${error.message}`);
      });
      // Pass 17 adds "Help and updates, more" from Advanced up (whereB17("updates", 1, ...)).
      // #455's page: the status card, then Updating; the channel ("Update channel", public/app/settings/updates-channel.js),
      // which the prototype does not show, is folded under the quieter More.
      const want = ["Updates & about", "Updating", "Remove Branch", ...(one === "regular" ? [] : ["Help and updates, more"])];
      // A redraw between the title and its sections read them as none; wait (in the page) for the sections, then check.
      await assertHeadings(page, want, `${width} px, ${one}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "no sideways scroll");
    }
  }
  assert.match(await page.locator(".set-col .lede").first().textContent(), /^Branch Agent \d/);
  // More opens on the channel.
  await page.locator("#u-more > summary").click();
  await page.locator(".set-col #u-more h2", { hasText: "Update channel" }).waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

test("DG-192 Updating by itself saves as it is switched, with no Save button", async (t) => {
  const { settingsWindow, openSettingsPage } = await import("./settings-window.mjs");
  const { page, errors, call } = await settingsWindow(t, { name: "about-dg192" });
  await openSettingsPage(page, "updates");
  const col = page.locator(".set-col");
  assert.equal(await col.getByRole("button", { name: /^Save/ }).count(), 0, "no Save button");
  const auto = col.getByRole("checkbox", { name: "Keep Branch up to date by itself", exact: true });
  const engineOn = (await call("/api/comfort")).values?.notify?.autoUpdate !== "off";
  for (let tries = 0; tries < 50 && (await auto.isChecked()) !== engineOn; tries++) await page.waitForTimeout(100);
  assert.equal(await auto.isChecked(), engineOn, "the switch says what the engine keeps");
  const was = await auto.isChecked();
  await auto.setChecked(!was);
  const wanted = was ? "off" : "install";
  for (let tries = 0; tries < 50 && (await call("/api/comfort")).values?.notify?.autoUpdate !== wanted; tries++) await page.waitForTimeout(100);
  assert.equal((await call("/api/comfort")).values?.notify?.autoUpdate, wanted, "saved the moment it was switched");
  assert.deepEqual(errors, []);
});

/** The headings and "N more" lines a person sees on the page, in order. */
const seen = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-about :is(h2, h3, h4, h5, .sg-more)")]
  .filter((node) => node.checkVisibility() && node.getBoundingClientRect().width > 1).map((node) => node.textContent.trim()));

for (const [width, height] of [[1440, 950], [860, 900], [400, 844]]) {
  for (const everything of [false, true]) {
    // Redesign: replaced by the new window (the prototype's sections, re-pointed above; it has no Show everything and no
    // keeper).
    test.skip(`DG-192 at ${width} px, Show everything ${everything ? "on" : "off"}: the sample's sections in its order`, async (t) => {
      const preferences = everything ? { showEverything: true, settingsLevel: "advanced" } : undefined;
      const { page, errors } = await fixture(t, { width, height, preferences });
      await openAbout(page);
      const heads = await seen(page);
      const sample = ["Updates & about", "Updates", "Updating by itself", "The keeper"];
      if (!everything) assert.deepEqual(heads, sample);
      else {
        assert.deepEqual(heads.slice(0, 4), sample, "the sample's sections come first, in its order");
        assert.deepEqual(heads.slice(4), ["Help and problems", "Report a problem", "Send future problems automatically",
          "Removing Branch", "Remove Branch from this computer"], "nothing that worked is lost");
      }
      assert.equal(heads.some((words) => /more with/.test(words)), false, "no N more line");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "no sideways scroll");
      assert.deepEqual(errors, []);
    });
  }
}

// Redesign: Coming soon (sw:lang), checked at fc541c24.
test.skip("DG-192 the page speaks French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await openAbout(page);
  const heads = await seen(page);
  assert.deepEqual(heads.slice(1), ["Mises à jour", "Se mettre à jour tout seul", "Le gardien"]);
  assert.equal(await page.locator("#about-acorn").getAttribute("aria-label"), "Le gland. Faites-le glisser ou utilisez les flèches pour le tourner.");
  assert.deepEqual(errors, []);
});
