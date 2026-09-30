/**
 * R17-S-B: the knob cards open where docs/places.md says, every control is described by its own
 * sentence, a change saved on the screen reaches the server, and "Put back as shipped" undoes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readKnobs } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettingFor } from "./places.mjs";
import { settingsWindow, openSettingsPage, setLevel } from "./settings-window.mjs";

/* The new window: the prototype draws the step limit as Settings › Models › Budgets, "Most steps in one task", at
   Advanced. It must show what the engine keeps, and a change typed there must reach the engine. Auto and No limit are
   plain choices beside the box (the owner, 2026-09-29: a task on a ChatGPT plan should never stop for its budget). */
test("Models › Budgets' Most steps in one task shows the engine's value, and a change reaches the engine", async (t) => {
  const { app, page, errors } = await settingsWindow(t, { name: "knobs-ui" });
  const limits = () => readKnobs(app.store, "local", "limits");
  const until = async (check) => { for (let tries = 0; tries < 50 && !check(); tries++) await page.waitForTimeout(100); };
  assert.equal(limits().maxSteps, null, "as shipped: auto");
  await openSettingsPage(page, "models");
  await setLevel(page, "advanced");
  const steps = page.getByRole("textbox", { name: "Most steps in one task", exact: true });
  const stepChoices = page.getByRole("group", { name: "Most steps in one task", exact: true });
  await steps.waitFor();
  assert.equal(await steps.inputValue(), "", "no figure of the owner's own");
  assert.equal(await stepChoices.getByRole("button", { name: "Auto", exact: true }).getAttribute("aria-pressed"), "true");
  await steps.fill("25");
  await steps.press("Enter");
  await until(() => limits().maxSteps === 25);
  assert.equal(limits().maxSteps, 25, "the change reached the engine");
  await stepChoices.getByRole("button", { name: "No limit", exact: true }).click();
  await until(() => limits().maxSteps === "none");
  assert.equal(limits().maxSteps, "none", "No limit reached the engine");
  await page.waitForTimeout(300);
  assert.equal(await stepChoices.getByRole("button", { name: "No limit", exact: true }).getAttribute("aria-pressed"), "true", "and is shown pressed");
  assert.equal(await steps.inputValue(), "");

  const tokens = page.getByRole("group", { name: "Tokens per task", exact: true });
  await tokens.getByRole("button", { name: "No limit", exact: true }).click();
  await until(() => limits().maxTaskTokens === "none");
  assert.equal(limits().maxTaskTokens, "none", "Tokens per task has No limit too");
  await tokens.getByRole("button", { name: "Auto", exact: true }).click();
  await until(() => limits().maxTaskTokens === null);
  assert.equal(limits().maxTaskTokens, null, "and goes back to auto");
  assert.deepEqual(errors, []);
});

/* Whatever the window draws, a key is never handed to commands: the engine refuses it, and keeps nothing. */
test("a key-like name is never kept as something handed to commands", async (t) => {
  const { app, server } = await settingsWindow(t, { name: "knobs-ui" });
  const response = await fetch(new URL("/api/knobs", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ card: "commands", values: { passEnvironment: ["OPENAI_API_KEY"] } }) });
  assert.equal(response.status, 400, "refused");
  assert.match((await response.json()).error, /never handed to commands/);
  assert.deepEqual(readKnobs(app.store, "local", "commands").passEnvironment, []);
});

const homes = {
  "knobs-compaction-card": "#lx-models-defaults",
  "knobs-subtasks-card": "#lx-models-defaults",
  "knobs-reasoning-card": "#lx-models-defaults",
  "knobs-limits-card": "#lx-page-permissions",
  "knobs-leak-guard-card": "#lx-page-permissions",
  "knobs-retries-card": "#lx-page-advanced",
  "knobs-tools-card": "#lx-page-advanced",
  "knobs-commands-card": "#lx-page-computer",
  "knobs-launch-file-card": "#lx-page-computer",
  "knobs-show-reasoning-card": "#lx-page-appearance",
};

async function openApp(t, width = 1280) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-knobs-ui-"));
  const launchFile = join(root, "integrations.json");
  await writeFile(launchFile, JSON.stringify({ browser: { allowedOrigins: ["https://example.com"] } }));
  const before = process.env.BRANCH_INTEGRATIONS;
  process.env.BRANCH_INTEGRATIONS = launchFile;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
    if (before === undefined) delete process.env.BRANCH_INTEGRATIONS; else process.env.BRANCH_INTEGRATIONS = before;
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  const token = page.getByLabel("Session token", { exact: true });
  await token.waitFor({ state: "visible", timeout: 120000 });
  await token.fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).evaluate((button) => button.click());
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#knobs-launch-file-card").waitFor({ state: "attached" });
  return { app, page, launchFile };
}

/** Every visible control in the card, and whether the sentence it points at has words. */
const undescribed = (page, id) => page.evaluate((cardId) => {
  const card = document.getElementById(cardId);
  return [...card.querySelectorAll("input, select, textarea")].filter((control) => {
    const note = document.getElementById(control.getAttribute("aria-describedby") ?? "");
    return !note || !note.textContent.trim();
  }).map((control) => control.id);
}, id);

for (const width of [1440, 860, 400]) {
  // Redesign: replaced by the new window (the knob cards are gone; the prototype's Models, General and Advanced pages hold
  // their counterparts; the French half also waits on the Language select, Coming soon (sw:lang), checked at fc541c24).
  test.skip(`DG-008 knob Settings headings preserve hierarchy and descriptions at ${width}px`, async (t) => {
    const { page } = await openApp(t, width);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const language of ["en", "fr"]) {
      await page.evaluate(async (lang) => (await import("/i18n.js")).setLanguage(lang), language);
      await page.evaluate(() => globalThis.branchKnobs.refresh());
      for (const id of Object.keys(homes)) {
        await openSettingFor(page, `#${id}`);
        const card = page.locator(`#${id}`), heading = card.locator(":scope > [data-t]").first();
        assert.equal(await heading.evaluate((node) => node.tagName), "H3", id);
        const name = (await heading.textContent()).trim();
        assert.ok(name && !name.startsWith("knobs."), `${id} has translated copy`);
        assert.equal(await card.getByRole("heading", { level: 3, name, exact: true }).count(), 1);
        assert.equal(await card.evaluate((node) => node.closest(".lx-page").querySelectorAll(":scope > h2.lx-page-title").length), 1);
        assert.equal(await card.locator(":scope > h3.settings-card-title + p.subtle + .kit-scope.sr-only").count(), 1);
        assert.deepEqual(await undescribed(page, id), []);
        assert.deepEqual(await heading.evaluate((node) => {
          const css = getComputedStyle(node);
          return [css.fontSize, css.fontWeight, css.lineHeight, css.letterSpacing, css.margin];
        }), ["16px", "640", "20.8px", "normal", "0px 0px 6px"]);
      }
      await openSettingFor(page, "#knobs-reasoning-card");
      const subsection = page.locator('#knobs-reasoning-card > [data-t="knobs.field.effortByModel"]');
      assert.equal(await subsection.evaluate((node) => node.tagName), "H4");
      assert.equal(await page.locator("#knobs-reasoning-card").getByRole("heading", {
        level: 4, name: (await subsection.textContent()).trim(), exact: true,
      }).count(), 1);
      assert.equal(await page.locator("#knobs-memory-card > h2").count(), 1, "Library heading is unchanged");
    }
    assert.deepEqual(errors, []);
  });
}

