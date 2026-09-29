/* Settings › Data & usage › "Show usage in the tray" is live: it shows the engine's glance setting (on as shipped) and
   switching it is kept (GET /api/usage/glance settings.tray), which the desktop app's tray reads (src/desktop/tray-ring.ts).
   Mutation: drop "u-tray" from WIRES in public/app/settings/pages/usage.js and the switch is greyed again: this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";

test("Show usage in the tray reads and keeps the engine's tray setting", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "usage-tray" });
  await openSettingsPage(page, "usage");
  const tray = page.locator("#u-tray");
  await tray.waitFor();
  assert.equal(await tray.getAttribute("aria-disabled"), null, "live, not greyed");
  await page.waitForFunction(() => document.querySelector("#u-tray")?.checked === true, null, { timeout: 10000 }); // ships on
  await tray.click();
  const kept = async () => (await call("/api/usage/glance")).settings?.tray;
  for (let i = 0; i < 50 && await kept() !== "hidden"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await kept(), "hidden");
  assert.deepEqual(errors, []);
});
