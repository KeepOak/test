/* UP-UI-009 / UI-262: Ctrl+J shows and hides the side panel, beside its own Ctrl+Shift+K, and the Shortcuts list shows
   both. A key the owner gives another action wins over the extra one. A headless window on a temporary Branch.
   Mutation: empty ALIASES in shell/keys.js: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

const paneOpen = (page) => page.evaluate(() => { const pane = document.getElementById("pane"); return !!pane && !pane.hidden; });
async function press(page, keys, open) {
  await page.keyboard.press(keys);
  await page.waitForFunction((want) => { const pane = document.getElementById("pane"); return (!!pane && !pane.hidden) === want; }, open);
}

test("UP-UI-009: Ctrl+J and Ctrl+Shift+K both show and hide the side panel", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  await page.locator("#prompt").waitFor();
  await page.locator("#conversation").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  const start = await paneOpen(page);
  await press(page, "ControlOrMeta+j", !start);
  await press(page, "ControlOrMeta+j", start);
  await press(page, "ControlOrMeta+Shift+k", !start);
  await press(page, "ControlOrMeta+Shift+k", start);
  const shown = await page.evaluate(() => import("/app/shell/keys.js").then((m) => m.bindings("sidePane")));
  assert.deepEqual(shown, ["Ctrl+Shift+K", "Ctrl+J"]);
  assert.deepEqual(errors, []);
});

test("UP-UI-009: a key the owner gives to another action is not also the side panel's", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  await page.locator("#prompt").waitFor();
  const [before, after, own] = await page.evaluate(async () => {
    const keys = await import("/app/shell/keys.js");
    const before = keys.bindings("sidePane");
    keys.K.keys = { ...(keys.K.keys ?? {}), focusPrompt: "Ctrl+J" };
    return [before, keys.bindings("sidePane"), keys.usedBy("Ctrl+J", "sidePane")];
  });
  assert.ok(before.includes("Ctrl+J"));
  assert.deepEqual(after, ["Ctrl+Shift+K"], "the extra key gives way");
  assert.equal(own, "focusPrompt");
  assert.deepEqual(errors, []);
});
