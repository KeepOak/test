/* MODEL-076: Settings › Models › Connections › "Retired connections and recent failures" opens a real readout: a
   connection whose service ended its route, and a connection whose latest recorded failure is recent. Headless window. */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow, openSettings } from "./new-window-places.mjs";
import { setLevel } from "./settings-window.mjs";

assert.equal(typeof chromium.launch, "function");
const provider = (extra = {}) => ({ name: "stand-in", async complete() { return { content: "ok", toolCalls: [] }; }, ...extra });

test("the retired connections row lists a retired connection and a recent failure from the engine", async (t) => {
  const seed = (app) => {
    app.runtime.models.register({ id: "old-route", name: "Old Route", provider: provider({ retired: true }), model: "m1" });
    app.runtime.models.register({ id: "flaky-route", name: "Flaky Route", provider: provider(), model: "m2" });
    app.runtime.models.register({ id: "calm-route", name: "Calm Route", provider: provider(), model: "m3" });
    app.runtime.models.health.recordFailure("flaky-route", Object.assign(new Error("The service said no"), { status: 503 }));
  };
  const { page, errors } = await newWindow(t, { seed });
  await openSettings(page, "models");
  await setLevel(page, "technical");
  await page.locator('[data-act="mtab"][data-v="connections"]').click();
  await page.locator('[data-act="demob17"][data-k="retired"]').click();
  const dialog = page.locator(".dlg .demo-b17");
  await dialog.waitFor({ timeout: 20000 });
  const text = await dialog.innerText();
  assert.match(text, /Old Route[\s\S]*Retired/);
  assert.match(text, /Flaky Route[\s\S]*Last failed/);
  assert.doesNotMatch(text, /Calm Route/, "a connection with nothing to report is not listed");
  assert.deepEqual(errors, []);
});
