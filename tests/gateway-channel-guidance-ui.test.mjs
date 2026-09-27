import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow, openSettings } from "./new-window-places.mjs";

test("gateway status describes this engine and its saved preference separately", async (t) => {
  assert.equal(typeof chromium.launch, "function");
  const { page, call, errors } = await newWindow(t);
  const view = await call("/api/never-break", { mode: "on" });
  assert.equal(view.underGateway, false);
  await openSettings(page, "gateway");
  await page.getByText("The gateway is off", { exact: true }).waitFor();
  await page.getByText("Saved preference: On.", { exact: true }).waitFor();
  await page.getByText("The saved preference takes effect", { exact: false }).waitFor();
  assert.equal(await page.locator("#gw-mode").isChecked(), true);
  await page.locator('[data-act="gwpop"]').getByText("Gateway off", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test("Windows iMessage wizard explains Mac prerequisites and refuses Continue", { skip: process.platform === "darwin" }, async (t) => {
  const { page, errors } = await newWindow(t);
  await page.evaluate(async () => { const { openChatWizard } = await import("/app/flows/chat.js"); await openChatWizard("imessage"); });
  await page.getByText("iMessage requires Branch running on a Mac", { exact: false }).waitFor();
  assert.equal(await page.locator('[data-act="chw-next"]').isDisabled(), true);
  assert.equal(await page.getByText("Paste secrets", { exact: false }).count(), 0);
  assert.deepEqual(errors, []);
});
