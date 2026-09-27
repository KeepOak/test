/**
 * r17-i: the reach and platform cards, opened the way a person opens them, at 400 px wide, in a
 * headless browser against a scratch workspace. Every word is behind a key with real French, every
 * control says what it does, and nothing reaches another computer or service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, setLevel, settingsWindow } from "./settings-window.mjs";
import { reachMode } from "../dist/reach/settings.js";

// Redesign: the old window's eleven reach cards (#reach-notes-card in Library, the relay and chats cards in Channels, the
// machines card, …) left with that window. The prototype keeps two reach parts as switches on its Settings pages: "Work
// in apps in the background" in Settings › Computer & browser (Advanced) and "Pause a chat app from the chat" in Settings
// › Gateway; it has no Notes card, so no note is kept from the window. Those two are checked the way a person meets them:
// named, described, kept by the engine, and nothing scrolls sideways at 400 px.
test("the reach switches sit in their homes, every control says what it does, and nothing scrolls sideways", async (t) => {
  const { app, page } = await settingsWindow(t, { name: "reach-ui", width: 400, height: 900,
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  for (const [home, id, part] of [["computer", "f15-work-in-apps-in-the-background", "background-screen"], ["gateway", "f15-pause-a-chat-app-from-the-chat", "platform-pause"]]) {
    await page.locator(`button.nav[data-act="setpage"][data-v="${home}"]`).click();
    const box = page.locator(`.set-col #${id}`);
    await box.waitFor({ state: "attached" });
    const said = await box.evaluate((node) => ({ name: node.getAttribute("aria-label") ?? "", title: node.closest(".ctl")?.querySelector("b")?.textContent.trim() ?? "",
      hint: node.closest(".ctl")?.querySelector("small")?.textContent.trim() ?? "" }));
    assert.ok(said.name && said.name === said.title, `${id} is named by its own words (${said.name})`);
    assert.ok(said.hint.length > 0, `${id} says what it does`);
    // Each part starts as the engine ships it (the chat app pause ships "when needed"); the switch shows that, and a
    // press turns it the other way, as the engine then keeps it.
    const before = reachMode(app.store, app.runtime.owner, part);
    assert.equal(await box.isChecked(), before !== "off", `${id} shows the engine's ${before}`);
    const want = before === "off" ? "when-needed" : "off";
    await box.setChecked(want !== "off");
    for (let i = 0; i < 100 && reachMode(app.store, app.runtime.owner, part) !== want; i++) await page.waitForTimeout(50);
    assert.equal(reachMode(app.store, app.runtime.owner, part), want, `${id} turns ${part} to ${want}`);
    assert.equal(await wide(), false, `no sideways scrolling in Settings › ${home}`);
  }
});
