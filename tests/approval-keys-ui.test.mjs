/* UP-UI-017: a focused approval card is answered from the keyboard, Enter for yes and Escape for no, bound to that
   exact request; the keys do nothing while the card is not focused. A headless window on a temporary Branch whose model
   asks to write a file under "ask before changes". Mutation: drop initApprovalKeys from chat/chat.js: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { newWindow } from "./new-window-places.mjs";
import { savePolicy } from "../dist/policy.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1);
  if (last?.role === "user" && /^write /.test(String(last.content)))
    return { content: "", toolCalls: [{ id: `w${Date.now()}`, name: "files.write", arguments: JSON.stringify({ path: String(last.content).slice(6).trim(), content: "hello" }) }] };
  return { content: "Done.", toolCalls: [] };
} };

test("UP-UI-017: Enter allows and Escape refuses the focused approval card, and only then", { timeout: 180000 }, async (t) => {
  const { page, app, errors } = await newWindow(t, { provider: writer, seed: (branch) => {
    savePolicy(branch.store, branch.runtime.owner, { preset: "ask-before-changes" });
    saveConversationModeSettings(branch.store, branch.runtime.owner, { newConversation: "follow" });
  } });
  const ask = async (file) => {
    await page.locator("#prompt").fill(`write ${file}`);
    await page.locator("#send").click();
    const card = page.locator("#live-ask");
    await card.waitFor({ state: "visible", timeout: 30000 });
    return card;
  };
  const written = (file) => existsSync(join(app.runtime.workspace, file));

  const first = await ask("yes.txt");
  await page.locator("#prompt").focus();
  await page.keyboard.press("Escape");
  assert.equal(await first.isVisible(), true, "Escape in the message box does not answer the card");
  await first.focus();
  await page.keyboard.press("Enter");
  await first.waitFor({ state: "detached", timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector("#conversation .typing"), null, { timeout: 30000 });
  assert.equal(written("yes.txt"), true, "Enter allowed it");

  const second = await ask("no.txt");
  await second.focus();
  await page.keyboard.press("Escape");
  await second.waitFor({ state: "detached", timeout: 30000 });
  assert.equal(written("no.txt"), false, "Escape refused it");
  assert.deepEqual(errors, []);
});
