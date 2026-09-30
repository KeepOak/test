/* A Trunk editor tab pressed once no editor is open (its dialog closed, or a household person pressed Edit on the
   owner's Trunk, which opens none) is let be: it threw "Cannot set properties of null (setting 'tab')" as a page error
   (verify-stress-fixes.cjs B008 found it).
   Mutation: in public/app/flows/trunk.js drop `if (!ed) return;` from the st-tab handler and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("a Trunk editor tab pressed with no editor open does nothing and throws nothing", async (t) => {
  const { page, errors } = await newWindow(t, { width: 1280, height: 800 });
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.act = "st-tab";
    b.dataset.v = "accounts";
    b.id = "stray-st-tab";
    document.body.append(b);
  });
  await page.locator("#stray-st-tab").dispatchEvent("click"); // unseen (no words), pressed as a click would
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".dlg .editor").count(), 0, "no editor was drawn");
  assert.deepEqual(errors, []);
});
