/**
 * Q73: The build provenance sentence must be visible persistently in the update card,
 * even after the phase moves on to "unpacking" and beyond.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openSettingFor, closeSettings } from "./places.mjs";

const PROVENANCE_NONE = "No build provenance record is published for this download. The update relies on the published checksum alone, which it passed.";

async function openApp(t) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-update-status-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Stub window.branchDesktop before app.js loads, like Electron preload does.
  await page.addInitScript(() => {
    globalThis.window.branchDesktop = {
      updateStatus: async () => {
        const phase = globalThis.__updatePhase || "idle";
        const isInstalling = ["downloading", "verifying", "unpacking", "ready", "applying"].includes(phase);
        const message = phase === "verifying" ? "Making sure the download is exactly what was published" : phase === "unpacking" ? "Unpacking…" : "";
        return {
          phase,
          message,
          progress: null,
          release: { latestVersion: "0.19.4" },
          ...(isInstalling && globalThis.__provenanceStatus ? { provenance: globalThis.__provenanceStatus } : {}),
        };
      },
      checkForUpdates: async () => ({ phase: "checking", message: "", progress: null, release: null }),
      modelSettings: async () => ({}),
    };
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

// Redesign: replaced by the new window (the prototype's Updates & about has no update card or provenance sentence), and French waits on sw:lang, Coming soon, checked at fc541c24.
test.skip("Q73: provenance displays correctly in French", async (t) => {
  const { page, errors } = await openApp(t);

  // Read the French locales to verify translation is used.
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const expectedFrenchNone = french["updates.provenance.none"];

  // Set up provenance status for "none" outcome and navigate to updates card.
  await page.evaluate(({ message }) => {
    globalThis.__provenanceStatus = { outcome: "none", message };
    globalThis.__updatePhase = "verifying";
  }, { message: PROVENANCE_NONE });

  // Switch language to French the way the app does it (via i18n.js).
  await page.evaluate(async () => {
    const { setLanguage } = await import("/i18n.js");
    await setLanguage("fr");
  });

  // Navigate to updates card in the new language.
  await openSettingFor(page, "#updates-card");

  // Wait for provenance to be visible.
  await page.waitForFunction(() =>
    document.getElementById("updates-provenance") &&
    !document.getElementById("updates-provenance").hidden
  );

  const provenanceText = await page.locator("#updates-provenance").textContent();
  assert.equal(provenanceText, expectedFrenchNone, "provenance message is displayed in French");
  await closeSettings(page);
  assert.deepEqual(errors, []);
});

