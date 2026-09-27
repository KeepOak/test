/**
 * Q55 in the window: Settings > Updates & about names the installed build (its version and the
 * commit it was built from, or "not recorded"), shows the offered release's own notes, and after a
 * failed update says plainly what was kept. The updater is a stand-in: nothing is checked or installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettingFor } from "./places.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const offered = { available: true, latestVersion: "9.9.9", currentVersion: "0.19.3", channel: "stable", notes: "Faster start.\nFixed the Files view." };

async function openApp(t, status, before = async () => {}) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-update-identity-"));
  await before(join(root, "data"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((first) => {
    globalThis.__status = first;
    window.branchDesktop = {
      updateStatus: async () => globalThis.__status,
      checkForUpdates: async () => globalThis.__status,
      installUpdate: async () => {
        const stopped = globalThis.__status.stopsEngine === true;
        const message = stopped ? "The update could not be started: no shell." : "The download stopped.";
        globalThis.__status = { ...globalThis.__status, phase: "error", message, outcome: { kept: globalThis.__status.installed.version, backgroundStopped: stopped } };
        throw new Error(message);
      },
      modelSettings: async () => ({}), openExternal: async () => true,
    };
  }, status);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingFor(page, "#updates-card");
  await page.locator("#updates-card").waitFor({ state: "visible" });
  return { page, errors };
}
const text = (page, id) => page.locator(id).evaluate((node) => node.textContent);

// Redesign: replaced by the new window (the prototype's Updates & about shows only "Branch Agent <version>." under its
// title, re-pointed in tests/settings-about-dg192.test.mjs: no commit, release notes, outcome or hand-over lines), and French waits on sw:lang, Coming soon, checked at fc541c24.
test.skip("a failed update says what was kept, in English and in French", async (t) => {
  const { page, errors } = await openApp(t, { phase: "available", message: "Version 9.9.9 is ready to install.", progress: null,
    installed: { version: "0.19.3", commit: COMMIT }, outcome: null, release: offered });
  await page.locator("#updates-install").click();
  await page.waitForFunction(() => !document.querySelector("#updates-outcome")?.hidden);
  assert.equal(await text(page, "#updates-status"), "The download stopped.");
  assert.equal(await text(page, "#updates-outcome"), "Branch Agent 0.19.3 was kept: it is still installed, and your work is as it was.");

  // The language changes after the card was drawn, so the filled-in sentences must be redrawn, not left as templates.
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openPlace(page, "settings:about");
  await page.waitForFunction(() => document.querySelector("#updates-outcome")?.textContent.startsWith("Branch Agent 0.19.3 a été conservé"));
  assert.equal(await text(page, "#updates-outcome"), "Branch Agent 0.19.3 a été conservé : il est toujours installé, et votre travail est resté tel quel.");
  assert.equal(await text(page, "#updates-notes-title"), "Nouveautés de la version 9.9.9");
  assert.equal(await page.locator("#updates-build dt").first().textContent(), "Version installée");
  assert.equal(await text(page, "#updates-build-commit"), COMMIT.slice(0, 12));
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype's Updates & about shows only "Branch Agent <version>." under its
// title, re-pointed in tests/settings-about-dg192.test.mjs: no commit, release notes, outcome or hand-over lines), and French waits on sw:lang, Coming soon, checked at fc541c24.
test.skip("a failed update after the background engine was closed says so and how it starts again, in English and in French", async (t) => {
  const { page, errors } = await openApp(t, { phase: "available", message: "Version 9.9.9 is ready to install.", progress: null,
    installed: { version: "0.19.3", commit: COMMIT }, outcome: null, release: offered, stopsEngine: true });
  await page.locator("#updates-install").click();
  await page.waitForFunction(() => !document.querySelector("#updates-outcome")?.hidden);
  const english = await text(page, "#updates-outcome");
  assert.equal(english, "Branch Agent 0.19.3 was kept: it is still installed and none of its files were changed. For the update, Branch stopped working in the background; that starts again the next time you sign in to this computer.");
  assert.doesNotMatch(english, /your work is as it was/);
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openPlace(page, "settings:about");
  await page.waitForFunction(() => document.querySelector("#updates-outcome")?.textContent.includes("arrière-plan"));
  assert.equal(await text(page, "#updates-outcome"), "Branch Agent 0.19.3 a été conservé : il est toujours installé et aucun de ses fichiers n’a été modifié. Pour la mise à jour, Branch a cessé de travailler en arrière-plan ; ce travail reprendra la prochaine fois que vous vous connecterez à cet ordinateur.");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype's Updates & about shows only "Branch Agent <version>." under its
// title, re-pointed in tests/settings-about-dg192.test.mjs: no commit, release notes, outcome or hand-over lines), and French waits on sw:lang, Coming soon, checked at fc541c24.
test.skip("in French, a missing commit reads as not recorded", async (t) => {
  const { page } = await openApp(t, { phase: "idle", message: "", progress: null, installed: { version: "0.19.3", commit: null }, outcome: null, release: null });
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openPlace(page, "settings:about");
  await page.waitForFunction(() => document.querySelector("#updates-build-commit")?.textContent === "non enregistré");
});

