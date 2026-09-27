/**
 * R17-S-C in the window: the comfort cards open where docs/places.md says, every control has its
 * own sentence, and each setting does what it says — rebound shortcuts, vim keys, the status line,
 * message times, the sound and "banner only", push-to-talk and updating by itself. No sound is
 * played, no notification shown, no microphone opened and nothing installed: those go through fakes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readComfort, saveComfort } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openPlace, openSettingFor, closeSettings } from "./places.mjs";

const homes = {
  "comfort-keys-card": "#lx-page-general",
  "comfort-files-card": "#lx-page-general",
  "comfort-display-card": "#lx-page-appearance",
  "comfort-notify-card": "#lx-page-notifications",
  "comfort-updates-card": "#lx-page-about",
  "comfort-voice-card": "#lx-page-voice",
  "comfort-browser-card": "#lx-page-computer",
  "comfort-network-card": "#lx-page-computer",
};

async function openApp(t, width = 1280, { mac = false, windows = false } = {}) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A Mac, where Command is the main key and Control is a key of its own.
  if (mac) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  // A Windows computer, where the Windows key belongs to the system and never to us.
  if (windows) await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  });
  // Nothing may be heard, shown by the computer, or recorded.
  await page.addInitScript(() => {
    globalThis.__sounds = [];
    globalThis.__notified = [];
    globalThis.Notification = class { constructor(title) { globalThis.__notified.push(title); } static permission = "granted"; static requestPermission() { return Promise.resolve("granted"); } };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error("no microphone in tests"));
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#comfort-network-card").waitFor({ state: "attached" });
  await page.evaluate(() => { globalThis.branchComfort.player = (kind) => globalThis.__sounds.push(kind); });
  return { app, page, errors };
}
const refresh = (page) => page.evaluate(() => globalThis.branchComfort.refresh());

const undescribed = (page, id) => page.evaluate((cardId) => {
  const card = document.getElementById(cardId);
  return [...card.querySelectorAll("input, select, textarea")].filter((control) => {
    const note = document.getElementById(control.getAttribute("aria-describedby") ?? "");
    return !note || !note.textContent.trim();
  }).map((control) => control.id);
}, id);

/* DG-184 (Notifications' one section) and DG-186 (Voice) draw these cards as rows under their section's heading, as the
   sample does, with no title of their own on screen; that section heading is the card's level three in the outline. */
const foldedIntoSection = (card) => card.evaluate((node) =>
  node.matches('#lx-page-voice > .card, [data-sg-bucket="notifications:attention"]'));
async function assertSectionHeading(page, id, home) {
  const section = page.locator(`${home} > .sg-head[data-cards~="${id}"] h3.sg-head-title`);
  assert.equal(await section.count(), 1, `${id} has its section heading`);
  assert.equal(await section.isVisible(), true, `${id}'s section heading is drawn`);
  const name = (await section.textContent()).trim();
  assert.ok(name && !name.startsWith("settingsGrown."), `${id}'s section heading is translated`);
  assert.equal(await page.locator(home).getByRole("heading", { level: 3, name, exact: true }).count(), 1);
  assert.ok(await section.evaluate((node, cardId) =>
    Boolean(node.compareDocumentPosition(document.getElementById(cardId)) & Node.DOCUMENT_POSITION_FOLLOWING), id),
  `${id} comes after its section heading`);
}

for (const width of [1440, 860, 400]) {
  // Redesign: replaced by the new window (the comfort cards and their headings are gone; the prototype's Settings pages draw their own sections).
  test.skip(`DG-008 comfort Settings headings remain native and described at ${width}px`, async (t) => {
    const { page, errors } = await openApp(t, width);
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const language of ["en", "fr"]) {
      await page.evaluate(async (lang) => (await import("/i18n.js")).setLanguage(lang), language);
      await refresh(page); // Rebuilt cards must retain their native hierarchy and scope order.
      for (const [id, home] of Object.entries(homes)) {
        await openSettingFor(page, `#${id}`);
        const card = page.locator(`#${id}`);
        const heading = card.locator(":scope > [data-t]").first();
        assert.equal(await heading.evaluate((node) => node.tagName), "H3", id);
        const name = (await heading.textContent()).trim();
        assert.ok(name, `${id} has a translated title`);
        assert.equal(await page.locator(`${home} > h2.lx-page-title`).count(), 1, "page title stays level two");
        assert.equal(await card.locator(":scope > h3 + p.subtle + .kit-scope.sr-only").count(), 1,
          "scope remains after the heading and purpose, not before the title");
        assert.deepEqual(await undescribed(page, id), []);
        if (await foldedIntoSection(card)) {
          await assertSectionHeading(page, id, home);
          continue;
        }
        assert.equal(await card.getByRole("heading", { level: 3, name, exact: true }).count(), 1);
        const style = await heading.evaluate((node) => {
          const css = getComputedStyle(node);
          return [css.fontSize, css.fontWeight, css.lineHeight, css.letterSpacing, css.margin];
        });
        assert.deepEqual(style, ["16px", "640", "20.8px", "normal", "0px 0px 6px"]);
      }
      assert.equal(await page.locator('[data-t="comfort.field.caCertificates"]').first().evaluate((node) => node.tagName), "H4",
        "certificate subsection is below its card title");
      assert.equal(await page.locator("#comfort-mcp-card > h2").count(), 1, "non-Settings card is unchanged");
    }
    assert.deepEqual(errors, []);
  });
}

/* ---------- the new window (public/app/**, design/redesign/prototype.html) ---------- */
/* Redesign: the comfort cards are replaced by the prototype's pages. Shortcuts are changed in "Keyboard shortcuts"
   (data-act="shortcuts", in the menu of the person at the foot of the side list): click one (key15), press the keys; the engine keeps them in
   its "keys" card (public/app/shell/keys.js). Sound, banner and updates are Settings › Notifications. */
async function newApp(t, { width = 1280, mac = false, windows = false, keys = null } = {}) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  if (keys) saveComfort(app.store, "local", "keys", keys);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (mac) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  if (windows) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" }));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForTimeout(500); // the engine's keys have been read
  return { app, page, errors };
}
const hidden = (page) => page.evaluate(() => document.getElementById("app").classList.contains("side-hidden"));
/** Presses keys away from any field, and says whether the side list changed. */
async function folds(page, keys) {
  await page.evaluate(() => document.activeElement?.blur());
  const before = await hidden(page);
  await page.keyboard.press(keys);
  await page.waitForTimeout(150);
  const after = await hidden(page);
  if (after !== before) { await page.keyboard.press(keys); await page.waitForTimeout(150); } // and back
  return after !== before;
}
/** Keyboard shortcuts, from the menu of the person at the foot of the side list. */
async function openShortcuts(page) {
  await page.locator('#side [data-act="owner"]').click();
  await page.locator('.pop [data-act="shortcuts"]').click();
  await page.locator(".dlg .keys15").waitFor();
}
/** Keyboard shortcuts, one action listening for its keys. */
async function listenFor(page, action) {
  if (!(await page.locator(".dlg .keys15").count())) await openShortcuts(page);
  await page.locator(`.dlg [data-act="key15"][data-v="${action}"]`).click();
  await page.locator(`.dlg .listen15[data-v="${action}"]`).waitFor();
}

test("R17-S15 (new window): a rebound shortcut works, and the old keys stop", async (t) => {
  const { page, errors } = await newApp(t, { keys: { sideList: "Ctrl+J" } });
  assert.equal(await folds(page, "Control+b"), false, "Ctrl+B no longer folds the side list");
  assert.equal(await folds(page, "Control+j"), true, "Ctrl+J does");
  assert.deepEqual(errors, []);
});

test("R17-S15 (new window): keys pressed into Keyboard shortcuts are kept by the engine and work", async (t) => {
  const { app, page, errors } = await newApp(t);
  assert.equal(await folds(page, "Control+b"), true, "as shipped, Ctrl+B folds the side list");
  await listenFor(page, "sideList");
  const before = await hidden(page);
  await page.keyboard.press("Alt+b");
  await page.waitForFunction(() => !document.querySelector(".dlg .listen15"));
  assert.equal(await hidden(page), before, "a press being set does not fold the side list");
  await page.waitForFunction(() => document.querySelector('.dlg [data-act="key15"][data-v="sideList"]')?.textContent.includes("Alt"));
  assert.equal(readComfort(app.store, "local", "keys").sideList, "Alt+B");
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  assert.equal(await folds(page, "Control+b"), false, "Ctrl+B no longer folds the side list");
  assert.equal(await folds(page, "Alt+b"), true, "Alt+B does");
  await openShortcuts(page);
  await page.locator('.dlg [data-act="keyreset15"][data-v="sideList"]').click();
  await page.waitForFunction(() => !document.querySelector('.dlg [data-act="keyreset15"][data-v="sideList"]'));
  assert.equal(readComfort(app.store, "local", "keys").sideList, "Ctrl+B", "put back as shipped");
  assert.deepEqual(errors, []);
});

test("R17-S15 on a Mac (new window): Cmd+B folds the side list as shipped, and Control+B is a different key the owner can choose", async (t) => {
  const { app, page, errors } = await newApp(t, { mac: true });
  assert.equal(await folds(page, "Control+b"), false, "Control+B moves the cursor on a Mac; it does not fold the list");
  assert.equal(await folds(page, "Meta+b"), true, "Cmd+B does");
  await listenFor(page, "sideList");
  await page.keyboard.press("Control+b");
  await page.waitForFunction(() => !document.querySelector(".dlg .listen15"));
  await page.waitForFunction(() => document.querySelector('.dlg [data-act="key15"][data-v="sideList"]')?.textContent.includes("Control"));
  assert.equal(readComfort(app.store, "local", "keys").sideList, "Control+B", "kept apart from Cmd+B");
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  assert.equal(await folds(page, "Meta+b"), false, "Cmd+B no longer folds it");
  assert.equal(await folds(page, "Control+b"), true, "the owner's Control+B does");
  assert.deepEqual(errors, []);
});

test("R17-S15 on Windows (new window): the Windows key belongs to the system and cannot be given away", async (t) => {
  const { app, page, errors } = await newApp(t, { windows: true });
  await listenFor(page, "newConversation");
  await page.keyboard.press("Meta+r");
  await page.waitForFunction(() => !document.querySelector(".dlg .listen15"));
  await listenFor(page, "newConversation");
  await page.keyboard.press("Meta+Shift+e");
  await page.waitForFunction(() => !document.querySelector(".dlg .listen15"));
  assert.equal(readComfort(app.store, "local", "keys").newConversation, "Ctrl+N", "the Windows key never reached the settings");
  await listenFor(page, "newConversation");
  await page.keyboard.press("Control+r");
  await page.waitForFunction(() => document.querySelector('.dlg [data-act="key15"][data-v="newConversation"]')?.textContent.includes("R"));
  assert.equal(readComfort(app.store, "local", "keys").newConversation, "Ctrl+R", "Ctrl still sets a shortcut here");
  assert.deepEqual(errors, []);
});

for (const mac of [false, true]) {
  test(`R17-S15${mac ? " on a Mac" : ""} (new window): the side list folds with the keys it has always had, and not with the other modifier`, async (t) => {
    const { page, errors } = await newApp(t, { mac, windows: !mac });
    assert.equal(await folds(page, mac ? "Meta+b" : "Control+b"), true, mac ? "Cmd+B folds it" : "Ctrl+B folds it");
    assert.equal(await folds(page, mac ? "Control+b" : "Meta+b"), false, "the other modifier does not");
    assert.equal(await folds(page, mac ? "Meta+Shift+b" : "Control+Shift+b"), false, "nor Shift as well");
    assert.deepEqual(errors, []);
  });
}

test("R17-S17 (new window): the sound, the banner and the release channel are kept by the engine", async (t) => {
  const { app, page, errors } = await newApp(t);
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="notifications"]').click();
  const press = async (act, v) => {
    await page.locator(`#main [data-act="${act}"][data-v="${v}"]`).click();
    await page.waitForFunction(([a, value]) => document.querySelector(`#main [data-act="${a}"][data-v="${value}"]`)?.getAttribute("aria-pressed") === "true", [act, v]);
  };
  await press("n-method", "window");
  await press("n-sound", "knock");
  assert.deepEqual([readComfort(app.store, "local", "notify").method, readComfort(app.store, "local", "notify").sound], ["window", "knock"]);
  await press("n-channel", "beta");
  assert.equal(readComfort(app.store, "local", "notify").releaseChannel, "beta");
  await press("n-channel", "stable");
  assert.equal(readComfort(app.store, "local", "notify").releaseChannel, "stable");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the comfort cards are gone; shortcuts, sound and updates are checked above in the prototype's places).
test.skip("each comfort card is in its home, says what it is for, and every control has its own sentence", async (t) => {
  const { app, page, errors } = await openApp(t);
  for (const [id, host] of Object.entries(homes)) {
    await page.waitForFunction(([card, slot]) => document.getElementById(card)?.closest(slot), [id, host]);
    await openSettingFor(page, `#${id}`);
    assert.ok(await page.locator(`#${id}`).isVisible(), `${id} can be seen on its page`);
    assert.equal(await page.locator(`#${id} > h3.settings-card-title + p.subtle`).count(), 1, `${id} says what it is for`);
    assert.deepEqual(await undescribed(page, id), [], `${id} has a control without a sentence`);
  }
  await closeSettings(page);
  await openPlace(page, "customize:connections");
  await page.waitForFunction(() => document.getElementById("comfort-mcp-card")?.offsetParent);
  assert.deepEqual(await undescribed(page, "comfort-mcp-card"), []);

  await openSettingFor(page, "#comfort-keys-card");
  await page.locator("#comfort-vim").selectOption("on");
  await page.locator("#comfort-keys-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#comfort-keys-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.equal(readComfort(app.store, "local", "keys").vim, true);
  await page.locator("#comfort-keys-card").getByRole("button", { name: "Put back as shipped" }).click();
  await page.locator("#comfort-keys-card [role=status]").filter({ hasText: "Put back" }).waitFor();
  assert.equal(readComfort(app.store, "local", "keys").vim, false);

  await openSettingFor(page, "#comfort-network-card");
  await page.locator("#comfort-proxy").fill("http://sam:pw@proxy.example.com:8080");
  await page.locator("#comfort-network-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#comfort-network-card [role=status]").filter({ hasText: "user name or password" }).waitFor();
  assert.equal(readComfort(app.store, "local", "network").proxy, null);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:f15-vim-keys-in-the-message-box, Settings › General), checked at fc541c24; the rebound shortcut is checked above.
test.skip("R17-S15: a rebound shortcut works, the old keys stop, and vim keys move and edit in the message box", async (t) => {
  const { app, page } = await openApp(t);
  saveComfort(app.store, "local", "keys", { newConversation: "Ctrl+J", vim: true });
  await refresh(page);
  await page.evaluate(() => { globalThis.__newClicks = 0; document.getElementById("rail-new").addEventListener("click", () => { globalThis.__newClicks += 1; }); });
  await page.keyboard.press("ControlOrMeta+n");
  assert.equal(await page.evaluate(() => globalThis.__newClicks), 0, "Ctrl+N no longer starts a conversation");
  await page.keyboard.press("ControlOrMeta+j");
  assert.equal(await page.evaluate(() => globalThis.__newClicks), 1, "Ctrl+J does");

  const box = page.locator("#prompt");
  await box.click();
  await box.pressSequentially("hello world");
  await page.keyboard.press("Escape");
  assert.equal(await box.getAttribute("data-vim-mode"), "normal");
  assert.equal(await page.locator("#comfort-vim-mode").textContent(), "Moving (vim)");
  for (const key of ["0", "x", "w", "x"]) await page.keyboard.press(key);
  assert.equal(await box.inputValue(), "ello orld", "0 goes to the start, x deletes, w goes to the next word");
  await page.keyboard.press("i");
  await page.keyboard.type("W");
  assert.equal(await box.inputValue(), "ello World", "i goes back to typing");
  await page.keyboard.press("Escape");
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  assert.equal(await box.inputValue(), "", "dd removes the line");
  const moved = await page.evaluate(() => {
    const { vimMotion } = globalThis.branchComfort;
    return [vimMotion("ab\ncd", 4, "k"), vimMotion("ab\ncd", 1, "j"), vimMotion("ab cd", 4, "b"), vimMotion("ab cd", 0, "$")];
  });
  assert.deepEqual(moved, [1, 4, 3, 4]);
});

// Redesign: replaced by the new window (Keyboard shortcuts, checked above; the prototype's list holds five changeable actions, not focusPrompt, newTrunk, searchHistory, stopTask or lookInside).
test.skip("R17-S15: keys pressed into Settings set every window action, and the side list keeps Ctrl+B until given others", async (t) => {
  const { app, page, errors } = await openApp(t);
  const clicks = (id) => page.evaluate((target) => {
    globalThis.__clicks ??= {};
    globalThis.__clicks[target] = 0;
    document.getElementById(target)?.addEventListener("click", () => { globalThis.__clicks[target] += 1; });
  }, id);
  const clicked = (id) => page.evaluate((target) => globalThis.__clicks[target], id);
  await clicks("rail-toggle");
  await page.keyboard.press("ControlOrMeta+b");
  assert.equal(await clicked("rail-toggle"), 1, "as shipped, Ctrl+B folds the side list");

  // Press-to-set: the keys pressed in the box are written into it, and do nothing else while there.
  await openSettingFor(page, "#comfort-keys-card");
  const raw = await page.locator("#comfort-keys-card").evaluate((card) => [...card.querySelectorAll("label, p")].map((node) => node.textContent.trim()).filter((text) => text.startsWith("comfort.")));
  assert.deepEqual(raw, [], "every action on the card has its own words");
  // The cards are drawn again once the window has signed in; a box focused just before that is gone,
  // so the press is made again on the box that is there until it holds the keys.
  const shownMain = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? "Cmd" : "Ctrl";
  for (let tries = 0; tries < 5 && await page.locator("#comfort-focusPrompt").inputValue() !== `${shownMain}+Shift+P`; tries++) {
    await page.locator("#comfort-focusPrompt").focus();
    await page.keyboard.press("ControlOrMeta+Shift+p");
  }
  assert.equal(await page.locator("#comfort-focusPrompt").inputValue(), `${shownMain}+Shift+P`);
  await page.locator("#comfort-sideList").focus();
  // Opening Settings may move the side list itself, so each check counts from just before its press.
  let folds = await clicked("rail-toggle");
  await page.keyboard.press("ControlOrMeta+b");
  assert.equal(await clicked("rail-toggle"), folds, "a press being set does not fold the side list");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Alt+b");
  await page.locator("#comfort-keys-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#comfort-keys-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  const saved = readComfort(app.store, "local", "keys");
  assert.equal(saved.focusPrompt, "Ctrl+Shift+P");
  assert.equal(saved.sideList, "Alt+B");
  await closeSettings(page);

  await page.locator("#prompt").blur();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "prompt", "the new keys focus the message box");
  await page.locator("#prompt").blur();
  folds = await clicked("rail-toggle");
  await page.keyboard.press("ControlOrMeta+b");
  assert.equal(await clicked("rail-toggle"), folds, "Ctrl+B no longer folds the side list");
  await page.keyboard.press("Alt+b");
  assert.equal(await clicked("rail-toggle"), folds + 1, "Alt+B does");
  await page.keyboard.press("Alt+b"); // and back, so the rest of the window is where it was

  saveComfort(app.store, "local", "keys", { newTrunk: "Alt+T", searchHistory: "Alt+H", stopTask: "Alt+S", lookInside: "Alt+L" });
  await refresh(page);
  await clicks("rail-new-trunk");
  // A slow runner, made certain: the panel's module arrives a moment after the press.
  await page.route("**/studio.js", async (route) => { await new Promise((resolve) => setTimeout(resolve, 1500)); await route.continue(); });
  await page.keyboard.press("Alt+t");
  assert.equal(await clicked("rail-new-trunk"), 1, "new Trunk");
  // New Trunk loads its panel's module first, so on a slow runner Escape used to land before the panel was open, and
  // the panel then opened and took the focus from the history search (trunk Windows run after R19).
  await page.locator("#studio").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator("#studio").waitFor({ state: "hidden" });
  await page.unroute("**/studio.js"); // NAS's LOW: the delay is for this step only
  await page.keyboard.press("Alt+h");
  await page.waitForFunction(() => document.activeElement?.id === "history-query");
  assert.ok(await page.locator("#history-query").isVisible(), "the history search is open, ready to type in");
  // Stop presses the live task's own Stop button, which cancels the task.
  await page.evaluate(() => { const stop = document.createElement("button"); stop.id = "live-stop"; stop.hidden = true; document.body.append(stop); });
  await clicks("live-stop");
  await page.keyboard.press("Alt+s");
  assert.equal(await clicked("live-stop"), 1, "stop the task");
  // Look inside opens the newest task of the conversation on screen.
  const run = await app.runtime.run({ prompt: "hello" });
  await page.evaluate((id) => { document.getElementById("conversation").dataset.sessionId = id; }, run.sessionId);
  await page.keyboard.press("Alt+l");
  await page.locator("#inspect-panel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (Keyboard shortcuts, checked above).
test.skip("R17-S15 on a Mac: Cmd+B folds the side list as shipped, and Control+B is a different key the owner can choose", async (t) => {
  const { app, page, errors } = await openApp(t, 1280, { mac: true });
  await page.evaluate(() => {
    globalThis.__folds = 0;
    document.getElementById("rail-toggle").addEventListener("click", () => { globalThis.__folds += 1; });
  });
  const folds = () => page.evaluate(() => globalThis.__folds);
  let before = await folds();
  await page.keyboard.press("Control+b");
  assert.equal(await folds(), before, "Control+B moves the cursor on a Mac; it does not fold the list");
  await page.keyboard.press("Meta+b");
  assert.equal(await folds(), before + 1, "Cmd+B does");

  await openSettingFor(page, "#comfort-keys-card");
  assert.equal(await page.locator("#comfort-sideList").inputValue(), "Cmd+B", "shown as the key it is");
  for (let tries = 0; tries < 5 && await page.locator("#comfort-sideList").inputValue() !== "Control+B"; tries++) {
    await page.locator("#comfort-sideList").focus();
    await page.keyboard.press("Control+b");
  }
  assert.equal(await page.locator("#comfort-sideList").inputValue(), "Control+B");
  await page.locator("#comfort-keys-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#comfort-keys-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.equal(readComfort(app.store, "local", "keys").sideList, "Control+B", "kept apart from Cmd+B");
  await closeSettings(page);
  await page.locator("#prompt").blur();
  before = await folds();
  await page.keyboard.press("Meta+b");
  assert.equal(await folds(), before, "Cmd+B no longer folds it");
  await page.keyboard.press("Control+b");
  assert.equal(await folds(), before + 1, "the owner's Control+B does");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (Keyboard shortcuts take keys from real key events, checked above; the prototype's list has no focusPrompt, newTrunk, searchHistory or lookInside).
test.skip("R17-S15 on a Mac: Option shortcuts are set and work from what a Mac keyboard really sends, and ordinary keys keep their characters", async (t) => {
  const { app, page, errors } = await openApp(t, 1280, { mac: true });
  await openSettingFor(page, "#comfort-keys-card");
  /* The events a Mac keyboard really sends. Playwright's own Alt+B sends a plain "b", which is why the
     earlier tests never saw this: Option makes B into "∫", and Option+Shift+K into a dead key. */
  const send = (id, init) => page.locator(id).evaluate((box, i) => {
    box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i }));
    return box.value;
  }, init);
  // The cards are drawn again once the window has signed in, so a press is repeated on the box that is there.
  const into = async (id, init, want) => {
    let got = "";
    for (let tries = 0; tries < 5 && got !== want; tries++) got = await send(id, init);
    return got;
  };
  assert.equal(await into("#comfort-sideList", { key: "∫", code: "KeyB", altKey: true }, "Alt+B"), "Alt+B", "Option+B is B, not ∫");
  assert.equal(await into("#comfort-focusPrompt", { key: "Dead", code: "KeyK", altKey: true, shiftKey: true }, "Alt+Shift+K"), "Alt+Shift+K",
    "Option+Shift+K is K, not nothing");
  assert.equal(await into("#comfort-newTrunk", { key: "t", code: "KeyT", metaKey: true }, "Cmd+T"), "Cmd+T");
  assert.equal(await into("#comfort-newTrunk", { key: "t", code: "KeyT", ctrlKey: true }, "Control+T"), "Control+T", "Command and Control stay two keys");
  // An ordinary character keeps its name wherever the layout puts it: on a French keyboard A sits where Q
  // is on an English one, and the comma where M is.
  assert.equal(await into("#comfort-searchHistory", { key: "a", code: "KeyQ", metaKey: true }, "Cmd+A"), "Cmd+A");
  assert.equal(await into("#comfort-lookInside", { key: ",", code: "KeyM", metaKey: true }, "Cmd+,"), "Cmd+,", "a comma stays a comma");
  await send("#comfort-lookInside", { key: "Backspace", code: "Backspace" });
  await page.locator("#comfort-keys-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#comfort-keys-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  const saved = readComfort(app.store, "local", "keys");
  assert.deepEqual([saved.sideList, saved.focusPrompt, saved.newTrunk, saved.searchHistory], ["Alt+B", "Alt+Shift+K", "Control+T", "Ctrl+A"]);
  await closeSettings(page);

  // And they work from the same real presses.
  await page.locator("#prompt").blur();
  const folds = await page.evaluate(() => {
    globalThis.__optionFolds = 0;
    document.getElementById("rail-toggle").addEventListener("click", () => { globalThis.__optionFolds += 1; });
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "∫", code: "KeyB", altKey: true }));
    return globalThis.__optionFolds;
  });
  assert.equal(folds, 1, "a real Option+B folds the side list");
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Dead", code: "KeyK", altKey: true, shiftKey: true })));
  assert.equal(await page.evaluate(() => document.activeElement?.id), "prompt", "a real Option+Shift+K focuses the message box");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype's changeable shortcuts have no owner-only action (no new Trunk or history search key)).
test.skip("R17-S15: keys kept from the owner do nothing owner-only while the window is a household member's", async (t) => {
  const { app, page, errors } = await openApp(t);
  saveComfort(app.store, "local", "keys", { newTrunk: "Alt+T", searchHistory: "Alt+H" });
  await refresh(page);
  await page.evaluate(() => {
    globalThis.__trunks = 0;
    document.getElementById("rail-new-trunk").addEventListener("click", () => { globalThis.__trunks += 1; });
  });
  // A real household window: the server switches to Sam, so a later refresh of the window's state agrees
  // instead of setting it back to the owner (which made this test fail about one run in two on a Mac).
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  await page.evaluate(async (id) => {
    const response = await fetch("/api/profiles/switch", { method: "POST", body: JSON.stringify({ profileId: id, pin: "2468" }),
      headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token"), "content-type": "application/json" } });
    if (!response.ok) throw new Error(`switch: ${response.status} ${await response.text()}`);
    (await import("/app.js")).noteWindowProfile(false);
  }, sam.id);
  await page.waitForFunction(() => document.documentElement.dataset.household === "on");
  await page.keyboard.press("Alt+t");
  assert.equal(await page.evaluate(() => globalThis.__trunks), 0, "no new Trunk from a household window");
  await page.keyboard.press("Alt+h");
  await page.waitForTimeout(200);
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), "history-query", "and no owner history search");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype has no picked status line or per-message times).
test.skip("R17-S16: the status line shows the pieces picked, and each message shows its time", async (t) => {
  const { app, page } = await openApp(t);
  assert.equal(await page.locator("#comfort-status").isVisible().catch(() => false), false, "as shipped there is no extra line");
  saveComfort(app.store, "local", "display", { statusLine: ["model", "context", "cost"], timestamps: true });
  await refresh(page);
  await page.locator("#prompt").fill("Hello there");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator("#conversation .message.assistant").first().waitFor({ timeout: 30000 });
  await page.evaluate(() => globalThis.branchComfort.refreshStatus());
  await page.waitForFunction(() => document.querySelectorAll("#conversation .message .message-time").length >= 2);
  const line = await page.locator("#comfort-status").textContent();
  assert.match(line, /^Test fixture · \d+% of the room used · /);
  const times = await page.locator("#conversation .message-time").evaluateAll((nodes) => nodes.map((node) => node.dateTime));
  assert.ok(times.every((value) => !Number.isNaN(Date.parse(value))), JSON.stringify(times));
  saveComfort(app.store, "local", "display", { statusLine: null, timestamps: false });
  await refresh(page);
  await page.waitForFunction(() => document.getElementById("comfort-status").hidden && !document.querySelector(".message-time"));
});

// Redesign: replaced by the new window (Settings › Notifications keeps the sound and banner choice, checked above; push-to-talk and Talk are Coming soon (voice)).
test.skip("R17-S17/S18: the owner's sound and banner-only choice, push-to-talk, and the longest recording", async (t) => {
  const { app, page } = await openApp(t);
  assert.equal(await page.evaluate(() => globalThis.branchComfort.attention({ runId: "a" })), "default", "as shipped, the computer is told and nothing is heard");
  assert.deepEqual(await page.evaluate(() => globalThis.__sounds), []);
  saveComfort(app.store, "local", "notify", { method: "window", sound: "knock" });
  saveComfort(app.store, "local", "voice", { pushToTalkKey: "F8", maxRecordingSeconds: 30 });
  await refresh(page);
  assert.equal(await page.evaluate(() => globalThis.branchComfort.attention({ runId: "b" })), "handled");
  assert.deepEqual(await page.evaluate(() => globalThis.__sounds), ["knock"]);
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /branchComfort\?\.attention\(item\) === "handled"\) continue;\s*if \(typeof Notification/, "the window asks before telling the computer");
  assert.equal(await page.evaluate(() => globalThis.branchComfort.maxRecordingSeconds()), 30);

  await page.evaluate(() => {
    globalThis.__talk = [];
    for (const kind of ["pointerdown", "pointerup"])
      document.getElementById("voice-talk").addEventListener(kind, () => globalThis.__talk.push(kind));
  });
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.down("F8");
  await page.keyboard.down("F8");
  await page.keyboard.up("F8");
  assert.deepEqual(await page.evaluate(() => globalThis.__talk), ["pointerdown", "pointerup"], "holding the key presses Talk once, letting go lets it go");

  await openSettingFor(page, "#comfort-notify-card");
  await page.locator("#comfort-notify-card").getByRole("button", { name: "Try the sound" }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.__sounds), ["knock", "knock"]);
});

// Redesign: replaced by the new window (public/comfort.js's autoUpdate is gone; Settings › Notifications keeps the choice, checked above).
test.skip("R17-S17: updating by itself looks once, and installs only through the Update button's own path", async (t) => {
  const { app, page } = await openApp(t);
  await page.evaluate(() => {
    globalThis.__desktop = [];
    /* Only what the automatic update asks counts here. The Updates card also reads the updater's
       status whenever the page redraws, which can come at any moment and is not a look for an
       update, so a status read counts only when it comes from autoUpdate itself. */
    const fromAutoUpdate = () => /\bautoUpdate\b/.test(new Error().stack ?? "");
    window.branchDesktop = {
      updateStatus: async () => { if (fromAutoUpdate()) globalThis.__desktop.push("status"); return { phase: globalThis.__phase ?? "idle", message: "" }; },
      checkForUpdates: async () => { globalThis.__desktop.push("check"); return { phase: "current", message: "" }; },
      installUpdate: async () => { globalThis.__desktop.push("install"); return { phase: "ready", message: "" }; },
      modelSettings: async () => ({}), openExternal: async () => true,
    };
  });
  /* The check's own settling point: its settings have been read. Asserting that nothing was
     looked for is only meaningful once the answer to "did the owner want this?" is in. */
  await refresh(page);
  await page.evaluate(() => globalThis.branchComfort.autoUpdate());
  assert.deepEqual(await page.evaluate(() => globalThis.__desktop), [], "off: nothing is looked for");
  saveComfort(app.store, "local", "notify", { autoUpdate: "check" });
  await refresh(page);
  await page.waitForFunction(() => globalThis.__desktop.includes("check"));
  /* The automatic look is still finishing after its check starts, and a second look never overlaps
     one in flight, so wait until a look of our own is actually made before asserting what it did. */
  await page.evaluate(async () => {
    for (let tries = 0; tries < 200; tries++) {
      globalThis.__desktop = [];
      await globalThis.branchComfort.autoUpdate();
      if (globalThis.__desktop.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
  assert.deepEqual(await page.evaluate(() => globalThis.__desktop), ["status"], "looked for less than a day ago");
  saveComfort(app.store, "local", "notify", { autoUpdate: "install" });
  await page.evaluate(() => { globalThis.__desktop = []; globalThis.__phase = "available"; });
  await refresh(page);
  await page.waitForFunction(() => globalThis.__desktop.includes("install"));
  assert.deepEqual(await page.evaluate(() => globalThis.__desktop.filter((step) => step !== "status")), ["install"]);
  await page.evaluate(() => { globalThis.__desktop = []; globalThis.__phase = undefined; window.branchDesktop = undefined; });
});

// Redesign: replaced by the new window (Settings › Notifications' Release channel, checked above, keeps the choice; the prototype's control does not check for updates at once).
test.skip("the owner can choose beta in Updates and return to stable", async (t) => {
  const { app, page, errors } = await openApp(t);
  await page.evaluate(() => {
    globalThis.__channelChecks = 0;
    window.branchDesktop = {
      updateStatus: async () => ({ phase: "idle", message: "Not checked", progress: null }),
      checkForUpdates: async () => { globalThis.__channelChecks++; return { phase: "current", message: "Current", progress: null }; },
    };
  });
  await openSettingFor(page, "#updates-card");
  await page.locator('#updates-channel input[value="beta"]').check();
  await page.waitForFunction(() => globalThis.__channelChecks === 1);
  assert.equal(readComfort(app.store, "local", "notify").releaseChannel, "beta");
  await page.locator('#updates-channel input[value="stable"]').check();
  await page.waitForFunction(() => globalThis.__channelChecks === 2);
  assert.equal(readComfort(app.store, "local", "notify").releaseChannel, "stable");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (public/comfort.js's update schedule is gone).
test.skip("automatic checks schedule after settling and install retries stay brief", async (t) => {
  const { app, page, errors } = await openApp(t);
  await page.evaluate(() => {
    const schedule = window.setTimeout.bind(window);
    globalThis.__updateIntervals = [];
    window.setTimeout = (fn, ms, ...args) => {
      if ([300_000, 3_600_000, 30_000].includes(ms)) globalThis.__updateIntervals.push(ms);
      return schedule(fn, ms, ...args);
    };
    window.branchDesktop = { updateStatus: async () => ({ phase: "current" }), checkForUpdates: async () => ({ phase: "current" }) };
  });
  for (const [releaseChannel, autoUpdate, interval] of [["beta", "check", 300_000], ["stable", "check", 3_600_000], ["beta", "install", 30_000]]) {
    saveComfort(app.store, "local", "notify", { releaseChannel, autoUpdate });
    await page.evaluate(() => { globalThis.__updateIntervals = []; });
    await refresh(page);
    await page.waitForFunction(() => globalThis.__updateIntervals.length > 0);
    assert.equal(await page.evaluate(() => globalThis.__updateIntervals.at(-1)), interval);
  }
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the comfort cards are gone).
test.skip("at 400 px the comfort cards fit without sideways scrolling", async (t) => {
  const { page } = await openApp(t, 400);
  for (const id of ["comfort-keys-card", "comfort-display-card", "comfort-network-card"]) {
    await openSettingFor(page, `#${id}`);
    const box = await page.locator(`#${id}`).evaluate((card) => ({ scroll: card.scrollWidth, client: card.clientWidth }));
    assert.ok(box.scroll <= box.client + 1, `${id} is wider than its card (${box.scroll} > ${box.client})`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${id} scrolls the page sideways`);
  }
});

/*
 * public/comfort.js refuses a press that holds the Windows key, because Win+R, Win+E and Win+L are the
 * system's and a shortcut written with one could never fire. Nothing held that refusal before: removing
 * the line left every test green.
 */
// Redesign: replaced by the new window (Keyboard shortcuts, checked above).
test.skip("R17-S15 on Windows: the Windows key belongs to the system and cannot be given away", async (t) => {
  const { app, page, errors } = await openApp(t, 1280, { windows: true });
  await openSettingFor(page, "#comfort-keys-card");
  const send = (id, init) => page.locator(id).evaluate((box, i) => {
    box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i }));
    return box.value;
  }, init);
  // The cards are drawn again once the window has signed in, so a press is repeated on the box that is there.
  const into = async (id, init, want) => {
    let got = "";
    for (let tries = 0; tries < 5 && got !== want; tries++) got = await send(id, init);
    return got;
  };
  assert.equal(await into("#comfort-newTrunk", { key: "r", code: "KeyR", ctrlKey: true }, "Ctrl+R"), "Ctrl+R", "Ctrl still sets a shortcut here");
  assert.equal(await send("#comfort-newTrunk", { key: "r", code: "KeyR", metaKey: true }), "Ctrl+R", "Win+R is the system's; it must not replace what is there");
  assert.equal(await send("#comfort-newTrunk", { key: "e", code: "KeyE", metaKey: true, shiftKey: true }), "Ctrl+R", "Win+Shift+E is the system's too");
  await page.locator("#comfort-keys-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#comfort-keys-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.equal(readComfort(app.store, "local", "keys").newTrunk, "Ctrl+R", "the Windows key never reached the settings");
  assert.deepEqual(errors, []);
});

for (const mac of [false, true]) {
  // Redesign: replaced by the new window (public/comfort.js is gone; the keys the window always had are checked above).
  test.skip(`R17-S15${mac ? " on a Mac" : ""}: a window without the owner's keys still folds the side list with the keys it has always had`, async (t) => {
    // Not a Mac is said outright: the computer running the tests may be one.
    const { page, errors } = await openApp(t, 1280, { mac, windows: !mac });
    await page.evaluate(() => {
      // As a window where public/comfort.js has not loaded: public/shell.js falls back to its own keys.
      globalThis.branchComfort = undefined;
      globalThis.__folds = 0;
      document.getElementById("rail-toggle").addEventListener("click", () => { globalThis.__folds += 1; });
    });
    const folds = () => page.evaluate(() => globalThis.__folds);
    await page.keyboard.press(mac ? "Meta+b" : "Control+b");
    assert.equal(await folds(), 1, mac ? "Cmd+B folds it" : "Ctrl+B folds it");
    await page.keyboard.press(mac ? "Control+b" : "Meta+b");
    await page.keyboard.press(mac ? "Meta+Shift+b" : "Control+Shift+b");
    assert.equal(await folds(), 1, "the other modifier, or Shift as well, does not");
    await page.keyboard.press(mac ? "Meta+b" : "Control+b"); // and back
    assert.deepEqual(errors, []);
  });
}
