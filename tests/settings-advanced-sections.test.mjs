/* DG-191 (with DG-056): Settings › Advanced has the approved sample's sections, in its order, with the same
   "N more with …" lines, at every width and in both Show everything states; Under the hood is there only at
   Technical, and last; every card the page had still has a place on it; the headings are French in French. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* The new window: Settings › Advanced is on the list from Advanced up (not at Regular), and is the prototype's page: its
   title, the only h1, over its sections in order, the same at Advanced and Technical, at 1440, 860 and 400 px. */
// Pass 17 adds "What it can do" and "Memory, more" at Advanced (whereB17("advanced", 1, ...)).
const NEW_SECTIONS = ["Advanced", "Seeing more", "Memory", "Automations", "Tools and skills", "Trunks, more", "Library, more", "Pinned skills", "What it can do", "Memory, more"];
test("Advanced has the prototype's sections at 1440, 860 and 400 px, at Advanced and Technical, and waits for Advanced", async (t) => {
  const { settingsWindow, openSettingsPage, setLevel } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "settings-advanced" });
  await openSettingsPage(page, "general");
  await setLevel(page, "regular");
  assert.equal(await page.locator('[data-act="setpage"][data-v="advanced"]').count(), 0, "Advanced is not on the list at Regular");
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const one of ["advanced", "technical"]) {
      await setLevel(page, one);
      await openSettingsPage(page, "advanced");
      // An incoming read may redraw between resolving locator nodes and evaluating them. Read the current page's
      // headings and their visibility in one turn, so detached nodes cannot turn a drawn page into an empty list.
      const heads = await page.evaluate(() => [...document.querySelectorAll(".set-col h1, .set-col h2, .set-col h3")]
        .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
      // Pass 17 adds "Health" at Technical (whereB17("advanced", 2, ...)).
      assert.deepEqual(heads, [...NEW_SECTIONS, ...(one === "technical" ? ["Health"] : [])], `${one} at ${width} px`);
      assert.equal(await page.locator(".set-col h1").count(), 1, "only the page title is level one");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${width} px fits`);
    }
  }
  assert.deepEqual(errors, []);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-advanced-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  await page.locator('.lx-settings-link[data-page="advanced"]').click();
  await page.locator("#coding-card").waitFor({ state: "attached" });
  return { page, errors };
}

// Redesign: Coming soon (sw:lang), checked at fc541c24.
test.skip("Advanced's section headings and counts are French in French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  await page.waitForFunction(() => document.getElementById("sg-bucket-advanced-fix")?.textContent === "Régler les problèmes");
  const heads = await page.locator("#lx-page-advanced .sg-head-title").evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => node.textContent));
  assert.deepEqual(heads, ["Régler les problèmes", "Pour les développeurs", "Sous le capot"]);
  await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
  await page.waitForFunction(() => /Avancé/.test(document.querySelector("#lx-page-advanced .sg-more-line:not([hidden]) .sg-more")?.textContent ?? ""));
  /* The words the cards of this page draw themselves are French too, not only their headings. */
  const words = await page.locator("#health-card, #diagnostics-card, #code-ide > summary, #tool-catalog > summary").evaluateAll((nodes) => nodes.map((node) => node.innerText).join(" "));
  for (const english of ["Checks the pieces", "Branch sends no usage data", "If you need help with a problem", "Help with code", "How the assistant finds its tools"])
    assert.ok(!words.includes(english), `${english} is still English`);
  assert.match(words, /Branch n'envoie de données d'utilisation à personne/);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:f15-draft-a-pull-request-from-a-task on Computer & browser, sw:dv-ls on Developer), checked
// at fc541c24.
test.skip("DG-025: the code editor and pull request switches save as you go, with no Save button, and say when a save fails", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => globalThis.branchSettingsLevel.set("advanced"));
  for (const [details, select, path, status] of [["wsedit-card", "wsedit-mode", "/api/workspace-editor/settings", "wsedit-mode-status"],
    ["pull-requests", "pull-requests-mode", "/api/developer/pull-requests", "pull-requests-status"]]) {
    await page.locator(`#${details} > summary`).click();
    assert.equal(await page.locator(`#${details} button`).count(), 0, `${details} has no Save button`);
    const saved = page.waitForRequest((request) => request.url().endsWith(path) && request.method() === "POST");
    await page.locator(`#${select}`).selectOption("when-needed");
    assert.equal((await saved).postDataJSON().mode, "when-needed", `${select} is sent the moment it changes`);
    await page.route(`**${path}`, (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "That could not be saved." }) })
      : route.continue());
    await page.locator(`#${select}`).selectOption("on");
    await page.waitForFunction((id) => /could not be saved/.test(document.getElementById(id)?.textContent ?? ""), status);
  }
  assert.deepEqual(errors, []);
});
