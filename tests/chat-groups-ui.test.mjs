/**
 * Settings › Chat apps › Group chats: each group the assistant has talked in, with "Only when mentioned" or "Every
 * message", saved through the engine and read back from it. A headless window on this computer; no chat service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openSettings } from "./new-window-places.mjs";

test("a group's choice is saved and shown pressed from the engine's own answer", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await openSettings(page, "chatapps");
  await page.getByText("No group has talked to the assistant yet").waitFor();
  // A group the owner chose for earlier (as /activation in the group does), shown with its choice.
  await call("/api/channels/groups", { channel: "discord", chatId: "C1", activation: "mention", title: "general" });
  await page.reload();
  await page.locator("#side").waitFor();
  await openSettings(page, "chatapps");
  const always = page.locator('[data-act="ca-group"][data-ch="discord"][data-id="C1"][data-v="always"]');
  await always.waitFor();
  assert.equal(await page.locator('[data-act="ca-group"][data-ch="discord"][data-id="C1"][data-v="mention"]').getAttribute("aria-pressed"), "true");
  await always.click();
  await page.locator('[data-act="ca-group"][data-ch="discord"][data-id="C1"][data-v="always"][aria-pressed="true"]').waitFor();
  assert.deepEqual((await call("/api/channels")).groups, [{ channel: "discord", chatId: "C1", title: "general", activation: "always", own: true }]);
  assert.deepEqual(errors, []);
});
