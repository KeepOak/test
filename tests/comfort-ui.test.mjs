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
import { openSettingFor } from "./places.mjs";

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
