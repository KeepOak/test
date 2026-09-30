import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("Windows iMessage wizard explains Mac prerequisites and refuses Continue", { skip: process.platform === "darwin" }, async (t) => {
  const { page, errors } = await newWindow(t);
  await page.evaluate(async () => { const { openChatWizard } = await import("/app/flows/chat.js"); await openChatWizard("imessage"); });
  await page.getByText("iMessage requires Branch running on a Mac", { exact: false }).waitFor();
  assert.equal(await page.locator('[data-act="chw-next"]').isDisabled(), true);
  assert.equal(await page.getByText("Paste secrets", { exact: false }).count(), 0);
  assert.deepEqual(errors, []);
});

test("the chat app catalog promises no fixed setup time and says iMessage needs a Mac", { skip: process.platform === "darwin" }, async (t) => {
  const { page, errors } = await newWindow(t);
  await openPlace(page, "customize", "channels");
  const imessage = page.locator('[data-act="ch-open"][data-v="imessage"]');
  await imessage.getByText("Needs a Mac", { exact: true }).waitFor();
  assert.equal(await page.getByText("Two minutes to set up", { exact: false }).count(), 0);
  assert.deepEqual(errors, []);
});
