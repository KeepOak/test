/**
 * Wave mac5: the one-click block inside Settings → Models → On this computer, opened the way a
 * person opens it. It ships when needed, its switch saves as it moves, it fits 400 px, and every word has a
 * key and real French. A headless browser only; the graphics card and free memory are stand-ins,
 * and nothing is set up, so nothing is started or downloaded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readGraphicsCard, useGraphicsReader } from "../dist/local-hardware.js";
import { useMemoryReaders } from "../dist/local-fit.js";
import { localModelsMode } from "../dist/local-jobs.js";
import { localKitFor } from "../dist/local-kit.js";
import { openPlace, openSettingFor, pressUntil } from "./places.mjs";

async function fixture(t, width = 1440) {
  useGraphicsReader(async () => ({ name: "Stand-in", memoryBytes: null, sharedMemory: true }));
  useMemoryReaders({ platform: "win32", free: () => 12 * 1024 ** 3, run: async () => { throw new Error("no programs in tests"); } });
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-local-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  // The sizes are only listed once a program that runs models is found. Say Ollama is there, so the
  // block looks the same on a clean build machine as on a computer that has one (nothing is started).
  localKitFor(app.store).launcher.installed = async () => ({ ollama: "/stand-in/ollama", "lm-studio": null, "llama-cpp": null, mlx: null });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
    useGraphicsReader(() => readGraphicsCard()); useMemoryReaders(null);
  });
  const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app };
}

/* Redesign: the one-click block and its off / when-needed switches are replaced by the prototype's Settings › On this
   computer page (public/app/settings/pages/local.js): each model with its sizes and one Install button. Looking at it
   starts nothing, downloads nothing and switches nothing on; it fits 400 px. */
test("Settings › On this computer lists each model's sizes, looking changes nothing, and it fits 400 px", async (t) => {
  for (const width of [1440, 400]) {
    const { page, errors, app } = await fixture(t, width);
    /* A narrow window slides the list in with its menu button, pressed as a thumb presses it. The button was found in one
       step and clicked in another, and a redraw in between left the click on a button already off the page, which reached
       nothing (6x CPU: 3 in 36, the gear then "outside of the viewport"). Then it waits for the list to be open. */
    if (width <= 760) {
      await pressUntil(page.locator('[data-act="side"]:visible').first(), () => page.waitForFunction(() => document.getElementById("app").classList.contains("side-open"),
        undefined, { timeout: 10000 }).then(() => true, () => false), "the list to slide in");
    }
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="local"]').click();
    await page.locator('#main [data-act="lm-get"]').first().waitFor({ state: "visible", timeout: 15000 });
    assert.ok(await page.locator('#main [data-act="lm-v"]').count() > 0, `${width}: each size is offered`);
    assert.match(await page.locator('#main [data-act="lm-get"]').first().innerText(), /^Install \d/, `${width}: Install says how much`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, `${width}: nothing sideways`);
    assert.equal(localModelsMode(app.store, app.runtime.owner), "when-needed", "looking leaves the switch as it ships (ship-on rule), not on");
    assert.equal(app.store.get("settings", app.runtime.owner, "local-models"), undefined, "looking saves no switch");
    assert.equal(app.store.get("settings", app.runtime.owner, "local-runner-install"), undefined, "nothing was saved by looking");
    assert.deepEqual(errors, []);
  }
});

// Redesign: replaced by the new window (the page fits 400 px, checked above); its French is Coming soon (sw:lang, the Language select in Settings › Appearance), checked at fc541c24.
test.skip("U2 at 400 px nothing scrolls sideways, and every word has a key and French", async (t) => {
  const { page, errors } = await fixture(t, 400);
  await openSettingFor(page, "#local-oneclick");
  await page.locator("#local-models-mode").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#local-models-mode").selectOption("when-needed");
  await page.locator("#local-models-runtime").waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  // Measured inside the page in one step: the block redraws itself, and a box asked for in two steps
  // (find the element, then measure it) can land on one that was just replaced (null on Linux CI).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#local-models-runtime")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the program choice fits inside 400 px");
  const raw = await page.evaluate(() => document.querySelector("#local-oneclick").innerText.match(/\{[a-z]+\}/g));
  assert.equal(raw, null, "no {placeholder} is ever shown");
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#local-oneclick p, #local-oneclick label, #local-oneclick option, #local-oneclick button, #local-oneclick a, #local-oneclick span")]
    .filter((node) => node.textContent.trim() && !node.dataset.t && !node.dataset.tKey && !node.closest(".item > p:nth-of-type(1)")).map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed.filter((text) => !/^[A-Z0-9_]+$/.test(text)), [], "only model summaries (in both languages) and size names are data");
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#local-oneclick");
  await page.waitForFunction(() => document.querySelector("label[for=local-models-mode]")?.textContent === "Modèles sur cet ordinateur");
  assert.deepEqual(errors, []);
});

/* mac7/one-click (issue #107): the "Set one up for me" block. Nothing is installed: the fixture's
   launcher says Ollama is already there, so the plan is never even worked out. */
// Redesign: replaced by the new window (the prototype's page has no install switch or "Show me what this would do"); its French is Coming soon (sw:lang), checked at fc541c24.
test.skip("U3 the install switch ships off, every control says what it does, and it fits 400 px in French", async (t) => {
  const { page, errors, app } = await fixture(t, 400);
  await openSettingFor(page, "#local-oneclick");
  await page.locator("#local-models-mode").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#local-models-mode").selectOption("when-needed");
  await page.locator("#local-install-mode").waitFor();
  assert.equal(await page.locator("#local-install-mode").inputValue(), "off", "installing ships off on its own");
  assert.ok(await page.locator("#local-install-mode").getAttribute("title"), "the switch says what it does");
  const show = page.getByRole("button", { name: "Show me what this would do" });
  assert.ok(await show.getAttribute("title"), "the button says what it does");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false, "no sideways scrolling at 400 px");
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#local-install-mode")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the install switch fits inside 400 px");
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#local-oneclick");
  await page.waitForFunction(() => document.querySelector("label[for=local-install-mode]")?.textContent
    === "Installer un programme qui fait tourner les modèles");
  assert.equal(await page.locator("#local-install-mode").inputValue(), "off", "reading it never turns it on");
  assert.deepEqual(errors, []);
  assert.equal(app.store.get("settings", app.runtime.owner, "local-runner-install"), undefined, "nothing was saved by looking");
});
