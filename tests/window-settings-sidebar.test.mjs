import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openSettings } from "./new-window-places.mjs";

test("Settings controls stay inside the resized desktop sidebar", async (t) => {
  const { page, errors } = await newWindow(t, { width: 1440, height: 1100 });
  await openSettings(page, "updates");
  await page.locator('[data-act="setlevel"][data-v="technical"]').click();
  for (const viewport of [900, 1100, 1440]) {
    await page.setViewportSize({ width: viewport, height: 1100 });
    for (const width of [232, 270, 336]) {
    await page.evaluate((width) => {
      document.getElementById("body").style.setProperty("--side-w", `${width}px`);
    }, width);
    const measured = await page.evaluate(() => {
      const nav = document.querySelector(".set-nav"), bounds = nav.getBoundingClientRect();
      return { width: bounds.width, overflow: nav.scrollWidth - nav.clientWidth,
        controls: [...nav.querySelectorAll(".set-search,.nav,.set-back,.set-level,.seg")].map((el) => {
          const box = el.getBoundingClientRect();
          return { name: el.className, left: box.left - bounds.left, right: box.right - bounds.right };
        }) };
    });
    assert.equal(measured.width, width);
    assert.ok(measured.overflow <= 1, `no horizontal overflow at ${width}px: ${JSON.stringify(measured)}`);
    for (const control of measured.controls)
      assert.ok(control.left >= 0 && control.right <= -4, `control fits at ${width}px: ${JSON.stringify(control)}`);
    }
  }
  await page.getByLabel("Search settings", { exact: true }).fill("Updates");
  await page.locator('[data-act="setpage"][data-v="updates"]').click();
  assert.equal(await page.locator('[data-act="setpage"][data-v="updates"]').getAttribute("aria-current"), "true");
  assert.deepEqual(errors, []);
});
