/* UI-071: Settings › Appearance offers Pixel or 3D for the pet and Trunk faces, saved in the engine (look.style), and a
   pixel pet is drawn as a 3D block model when 3D is chosen. Headless window. */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow, openSettings } from "./new-window-places.mjs";

assert.equal(typeof chromium.launch, "function");

test("choosing 3D in Appearance is kept by the engine and a pixel pet becomes a 3D model", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/delight/settings", { pets: { on: true, kind: "squirrel" } });
  await openSettings(page, "appearance");
  const choice = page.locator('[data-act="visual-style"][data-v="3d"]');
  await choice.waitFor({ timeout: 20000 });
  await choice.click();
  await page.locator('[data-act="visual-style"][data-v="3d"][aria-pressed="true"]').waitFor({ timeout: 15000 });
  assert.equal((await call("/api/delight")).settings.look.style, "3d");
  await page.locator(".pets12 .voxel-pet").first().waitFor({ state: "attached", timeout: 15000 });
  await page.locator('[data-act="visual-style"][data-v="pixel"]').click();
  await page.locator('[data-act="visual-style"][data-v="pixel"][aria-pressed="true"]').waitFor({ timeout: 15000 });
  assert.equal((await call("/api/delight")).settings.look.style, "pixel");
  assert.deepEqual(errors, []);
});
