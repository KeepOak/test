/* The "New to Branch?" card belongs to the conversation, where it keeps clear of the message box. Over Settings or a
   place it sat on their own controls (a verify run found it covering Settings › Appearance › Language, whose glass list
   could not be pressed). It waits unseen there and comes back in the conversation.
   Mutation: in public/app/flows/first.js placeWelcome drop `card.hidden = S.view !== "chat"` and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { openSettingsPage } from "./settings-window.mjs";

test("the New to Branch card shows in the conversation only, never over Settings or a place", async (t) => {
  const { page, call, errors } = await newWindow(t, { width: 1280, height: 800 });
  await call("/api/onboarding", { done: false, skipped: true }); // setup was left with Skip: the card offers it again
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const card = page.locator(".welcome10");
  await card.waitFor({ state: "visible", timeout: 10000 });
  await openSettingsPage(page, "appearance");
  await page.locator("#lang").waitFor();
  assert.equal(await card.isVisible(), false, "not over Settings");
  await page.locator("#lang").click({ trial: true }); // nothing covers the language picker
  await page.locator(".set-back").click();
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  await page.locator("#main .place").waitFor();
  assert.equal(await card.isVisible(), false, "not over a place");
  await page.locator('#side [data-act="newconv"], #side [data-act="newmenu"]').first().click();
  await page.locator('.pop [data-act="newconv"]').click().catch(() => {});
  await card.waitFor({ state: "visible", timeout: 10000 });
  assert.deepEqual(errors, []);
});
