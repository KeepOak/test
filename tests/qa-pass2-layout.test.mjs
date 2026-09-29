/* QA pass 2, two layout findings at 1400 x 900:
   - the pet's pixel tree (the list's scenery, shell/procbg.js drawScenery) was drawn behind the Settings gear. The scene is
     now its own size in the list's bottom right, so the tree (from x 78 of its 146) starts right of the gear;
   - Settings › Models › Second opinion › "Who checks" wrapped onto two lines as a row of buttons, one per connection. It
     is a glass list now, one line whatever the number of connections.
   Mutation: put .side>.scenery back to width:100% in public/app.css and the first check goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("the tree stands clear of the Settings gear, and Who checks is one line", async (t) => {
  const { page, errors } = await newWindow(t, { width: 1400, height: 900 });
  await page.locator("#scenery").waitFor({ state: "attached" });
  const where = await page.evaluate(() => {
    const scene = document.querySelector("#scenery").getBoundingClientRect(), gear = document.querySelector('.owner-row [data-v="settings"]').getBoundingClientRect();
    return { treeLeft: scene.left + (78 / 146) * scene.width, gearRight: gear.right };
  });
  assert.ok(where.treeLeft >= where.gearRight, `the tree starts at ${Math.round(where.treeLeft)}, right of the gear's ${Math.round(where.gearRight)}`);

  await page.locator('.owner-row [data-v="settings"]').click();
  await page.locator('[data-act="setlevel"][data-v="advanced"]').click();
  await page.locator('[data-act="setpage"][data-v="models"]').first().click();
  await page.locator('[data-act="mtab"][data-v="second"]').click();
  const who = page.locator("#m-second-by");
  await who.waitFor();
  assert.equal(await who.getAttribute("aria-haspopup"), "menu", "a glass list");
  assert.equal(await page.locator('[data-act="m-second-by"]').count(), 0, "no row of buttons to wrap");
  assert.deepEqual(errors, []);
});
