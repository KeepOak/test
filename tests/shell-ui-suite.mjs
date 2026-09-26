import nodeTest from "node:test";
/* This file is split into parts so the build machines can run its minutes side by side: each
   tests/shell-ui-N.test.mjs runs every 3th test declared here, starting from its own. Nothing is
   skipped: the parts together declare every test, in the same order, with the same body. */
const part = globalThis.branchTestPart ?? { index: 0, of: 1 };
let declared = 0;
const test = (...args) => (declared++ % part.of === part.index ? nodeTest(...args) : undefined);
test.skip = (...args) => (declared++ % part.of === part.index ? nodeTest.skip(...args) : undefined);
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { signIn, openPlace, openSettings } from "./new-window-places.mjs";

/* Redesign (sweep-B): the shell of the new window (public/app/shell/**, design/redesign/prototype.html pass 17). The
   old window's shell (#rail-*, #trunk-strip, #settings-window, body.lx-ready, /appearance.js) is gone; waiting for its
   body.lx-ready is what made each of these tests sit out a 120 s timeout, and each part of this file run past 600 s.
   The places are in the side list, Settings behind the gear at its foot. */
const PLACES = [["overview", "Overview"], ["inbox", "Inbox"], ["automations", "Automations"], ["library", "Library"], ["team", "Team"], ["customize", "Customize"]];

const scripted = { name: "scripted", async complete() { return { content: "Hello from Branch.", toolCalls: [] }; } };
async function fixture(t, { width = 1440, height = 1000, onboarded = true, provider = scripted } = {}) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-shell-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    ...(provider ? { provider } : { presets: [] }), // no provider: no model set up at all
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (onboarded) await call("/api/onboarding", { done: true });
  const page = await (await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* A screen draws what it reads once the engine has answered, so it is read when nothing is in flight (the live event
     stream aside, which stays open). */
  const pending = new Set();
  const api = (request) => new URL(request.url()).pathname.startsWith("/api/") && !request.url().includes("/api/events/stream");
  page.on("request", (request) => { if (api(request)) pending.add(request); });
  for (const done of ["requestfinished", "requestfailed"]) page.on(done, (request) => pending.delete(request));
  page.settled = async () => {
    for (let quiet = 0; quiet < 3;) { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20)))); quiet = pending.size ? 0 : quiet + 1; }
  };
  await signIn(page, server);
  return { app, page, server, errors, call };
}
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const reload = async (page) => { await page.reload(); await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 }); };
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 700 },
  { width: 400, height: 800 },
];
/** True when two boxes share any pixel. */
const boxesHit = (page, one, two) =>
  page.evaluate(
    ([a, b]) => {
      const first = document.querySelector(a).getBoundingClientRect();
      const second = document.querySelector(b).getBoundingClientRect();
      return !(first.bottom <= second.top || second.bottom <= first.top);
    },
    [one, two],
  );
/** Leaves Settings the way a person does on any width: its own way back to the conversation. */
async function leaveSettings(page) {
  const back = page.locator('.settings [data-act="chat"]:visible');
  if (await back.count()) await back.first().click();
  else await page.locator('.settings [data-act="chat"]').first().evaluate((button) => button.click());
}

test("the sidebar starts with this real computer and keeps project switching available", async (t) => {
  const f = await fixture(t);
  const name = () => f.page.locator("#side .machine .mach14 b").textContent();
  assert.equal(await name(), "This computer");
  assert.match(await f.page.locator("#side .machine").ariaSnapshot(), /button "This computer/,
    "the visible computer name is part of the switcher's accessible name");
  assert.equal(await f.page.locator("#side .machine").count(), 1, "the identity is not repeated in the side list");
  const saved = await f.call("/api/reach/machine-name", { name: "studio-mac" });
  assert.equal(saved.status, 200);
  await reload(f.page);
  await f.page.locator("#side .machine .mach14 b").filter({ hasText: "studio-mac" }).waitFor();
  assert.match(await f.page.locator("#side .machine").ariaSnapshot(), /button "studio-mac/);
  await f.page.locator("#side .machine").click();
  await f.page.locator(".pop").waitFor();
  assert.equal(await f.page.locator(".pop").getByText("studio-mac").first().isVisible(), true, "switching computers still works");
  await f.page.keyboard.press("Escape");
  for (const width of [1440, 1024]) {
    await f.page.setViewportSize({ width, height: 900 });
    const fits = await f.page.locator("#side .machine").evaluate((button) => {
      const side = button.closest("#side").getBoundingClientRect();
      const identity = button.querySelector(".mach14 b").getBoundingClientRect();
      return identity.left >= side.left && identity.right <= side.right;
    });
    assert.equal(fits, true, `the computer name fits the side list at ${width}px`);
  }
  assert.deepEqual(f.errors, []);
});

test("every place opens from the sidebar in one click, and every Settings page from the gear", async (t) => {
  const f = await fixture(t);
  // The places are buttons in the side list, never a drop-down. A drop-down of places would list the places, so it is
  // their own names that are looked for, outside Settings (a drop-down inside Settings is not navigation).
  const placesInADropDown = () => f.page.locator("select:not(.settings select)")
    .filter({ hasText: PLACES[1][1] }).filter({ hasText: PLACES[2][1] }).count();
  assert.equal(await placesInADropDown(), 0, "places must not live in a drop-down");
  // And the check above can still go off: a drop-down of places in the shell is caught.
  await f.page.evaluate((places) => {
    const select = document.createElement("select");
    select.id = "places-drop-down-probe";
    for (const [id, name] of places) select.append(new Option(name, id));
    document.getElementById("side").append(select);
  }, PLACES);
  assert.equal(await placesInADropDown(), 1, "this check can no longer catch places moving into a drop-down");
  await f.page.evaluate(() => document.getElementById("places-drop-down-probe").remove());
  for (const [id, name] of PLACES) {
    await f.page.locator(`#side [data-act="view"][data-v="${id}"]`).click();
    // The prototype's Team place is headed "People" (design/redesign/dom/place-team.html).
    await f.page.locator("#main .place h1").filter({ hasText: id === "team" ? "People" : name }).first().waitFor();
    await f.page.locator(`#side [data-act="view"][data-v="${id}"][aria-current="true"]`).waitFor();
  }
  // As in the prototype, a conversation starts from the side list's New menu; there is no Conversation place.
  assert.equal(await f.page.locator('#side [data-act="view"][data-v="chat"]').count(), 0);
  await f.page.locator('#side [data-act="newmenu"]').click();
  await f.page.locator('.pop [data-act="newconv"]').click();
  await f.page.locator("#composer").waitFor({ state: "visible" });
  await f.page.getByRole("button", { name: "Settings", exact: true }).click();
  await f.page.locator(".settings").waitFor({ state: "visible" });
  const pages = f.page.locator('.settings button.nav[data-act="setpage"]');
  assert.equal(await pages.count(), 18, "Settings lists every page of the prototype's four groups");
  for (let index = 0; index < await pages.count(); index += 1) {
    const id = await pages.nth(index).getAttribute("data-v");
    await pages.nth(index).click();
    // A page is shown once its first read has come back (settings.js waitFirst), so its mark is waited for.
    await f.page.locator(`.settings button.nav[data-v="${id}"][aria-current="true"]`).waitFor();
    assert.equal(await f.page.locator('.settings button.nav[aria-current="true"]').count(), 1, "one page at a time");
    assert.equal(await f.page.locator(".set-col h1").count(), 1, "and one page title");
  }
  await leaveSettings(f.page);
  await f.page.locator(".settings").waitFor({ state: "detached" });
  assert.deepEqual(f.errors, []);
});

// Redesign: the prototype's side list has no Conversations / Trunks switch (#rail-view-*): a Trunk's own conversation is
// a row in the one list (public/app/shell/shell.js trunkFor), and a Trunk is made from the New menu (mktrunk.js).
test.skip("the rail switches between conversations and real Trunks without duplicating either", async () => {});

// Redesign: the prototype has no strip of Trunk faces (/strip.js, #trunk-strip); a conversation's Trunk is named in
// its own header (the test "an ordinary conversation assigned to a Trunk updates the shell target" below).
test.skip("the selected Trunk stays named when its visual strip is off", async () => {});

// Redesign: as above, no strip of Trunk faces to hide one from.
test.skip("a hidden active Trunk stays named in the rail", async () => {});

test("the Trunks rail stays owner-only", async (t) => {
  // Redesign: the new window starts again from nothing when the person changes (public/app/main.js watchPerson), so
  // what is checked is that a household person's window shows none of the owner's conversations or owner-only actions.
  const f = await fixture(t);
  await f.page.locator("#prompt").fill("Private owner words");
  await f.page.locator("#send").click();
  const row = f.page.locator("#side .list").getByText("Private owner words").first();
  await row.waitFor({ timeout: 30000 });
  await openSettings(f.page, "people");
  await f.page.locator('.set-col [data-act="p-invite"]').first().waitFor({ state: "attached" });
  await leaveSettings(f.page);
  const person = await (await f.call("/api/profiles", { name: "Sam", pin: "2468" })).json();
  const reloaded = f.page.waitForEvent("load", { timeout: 30000 });
  assert.equal((await f.call("/api/profiles/switch", { profileId: person.id, pin: "2468" })).status, 200);
  await reloaded;
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await f.page.locator("#side .owner-row").getByText("Sam").first().waitFor();
  assert.equal(await f.page.locator("#side .list").getByText("Private owner words").count(), 0, "the owner's conversation is not named");
  await openSettings(f.page, "people");
  await f.page.locator(".set-col h1").first().waitFor();
  await f.page.settled();
  assert.equal(await f.page.locator('.set-col [data-act="p-invite"]').count(), 0, "owner-only actions are not drawn");
  assert.deepEqual(f.errors, []);
});

test("an ordinary conversation assigned to a Trunk updates the shell target", async (t) => {
  // Redesign: the prototype's header names the Trunk that answers a conversation (public/app/shell/shell.js trunkFor).
  const f = await fixture(t);
  await f.call("/api/trunks/mode", { mode: "on" });
  const made = await f.call("/api/trunks", { name: "Ada", description: "Keeps the books." });
  assert.equal(made.status, 200, await made.clone().text());
  const { trunk } = await made.json();
  await reload(f.page);
  const row = f.page.locator(`#side .list [data-act="chat"][data-id="${trunk.chatSessionId}"]`);
  await row.waitFor({ timeout: 30000 });
  await row.click();
  // Redesign: the header's name is its accessible heading now (the owner took the visible name out of the title-bar row).
  await f.page.locator('.titlebar .head .who[role="heading"] > b').filter({ hasText: "Ada" }).first().waitFor({ state: "attached" });
  assert.deepEqual(f.errors, []);
});

// Redesign: the strip's profile events (branch-strip, branch-profile) are gone; a change of person reloads the window
// (public/app/main.js watchPerson), which the owner-only test above covers.
test.skip("the Trunks rail recovers after profile loading fails or the owner returns", async () => {});

// Redesign: the new window draws each Settings page from its own module (public/app/settings/pages/*.js); there is no
// data-home to move a card added later onto a page.
test.skip("a new screen that names its home with data-home is shown there, even when added later", async () => {});

test("the command palette jumps to a section and closes on Escape", async (t) => {
  const f = await fixture(t);
  await f.page.keyboard.press("ControlOrMeta+k");
  await f.page.locator("#pal-in").waitFor({ state: "visible" });
  await f.page.locator("#pal-in").fill("Automa");
  await f.page.locator('.palette [data-act="pal"]').filter({ hasText: "Automations" }).first().click();
  await f.page.locator("#main .place h1").filter({ hasText: "Automations" }).waitFor();
  await f.page.keyboard.press("ControlOrMeta+k");
  await f.page.locator("#pal-in").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#pal-in").waitFor({ state: "detached" });
  assert.deepEqual(f.errors, []);
});

test("every appearance control applies at once and survives a reload", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "appearance");
  const col = f.page.locator(".set-col");
  await col.locator('[data-act="themeset"][data-v="light"]').click();
  await f.page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await col.locator('[data-act="size"][data-v="large"]').click();
  await col.locator('[data-act="widthset"][data-v="full"]').click();
  const shown = () => f.page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
    size: document.documentElement.dataset.textSize ?? getComputedStyle(document.documentElement).getPropertyValue("--text-size").trim(),
    width: getComputedStyle(document.getElementById("app")).getPropertyValue("--thread-w").trim() }));
  await f.page.waitForFunction(() => getComputedStyle(document.getElementById("app")).getPropertyValue("--thread-w").trim() === "100%");
  const chosen = await shown();
  assert.equal(chosen.theme, "light", "Daylight shows at once");
  assert.equal(chosen.width, "100%", "the conversation's width shows at once");
  const kept = (await (await f.call("/api/state")).json()).preferences;
  assert.deepEqual([kept.appearance, kept.textSize, kept.conversationWidth], ["daylight", "large", "full"], "every choice is kept by the engine");
  await reload(f.page);
  await f.page.waitForFunction(() => getComputedStyle(document.getElementById("app")).getPropertyValue("--thread-w").trim() === "100%");
  assert.deepEqual(await shown(), chosen, "the same look comes back after a reload");
  assert.deepEqual(f.errors, []);
});

test("an unknown appearance value is refused and the saved look is unchanged", async (t) => {
  const f = await fixture(t);
  const send = (body) => f.call("/api/preferences", body);
  assert.equal((await send({ appearance: "midnight" })).ok, false);
  assert.equal((await send({ accent: "purple" })).ok, false);
  const kept = await (await send({ appearance: "daylight" })).json();
  assert.equal(kept.accent, "copper", "fields left out keep their defaults");
  assert.equal(kept.showAcorn, false, "the acorn starts off");
  assert.equal(kept.showEverything, false, "the calm window is the default");
});

test("the shell fits a 400 pixel window without sideways scrolling", async (t) => {
  const f = await fixture(t);
  await f.page.setViewportSize({ width: 400, height: 800 });
  assert.equal(await sideways(f.page), 0);
  /* On a narrow window the side list slides over the page, so it is opened first. */
  await openPlace(f.page, "library");
  await f.page.locator("#main .place h1").filter({ hasText: "Library" }).waitFor();
  assert.equal(await sideways(f.page), 0);
  assert.deepEqual(f.errors, []);
});

test("a rail folded away on a wide window still opens on a narrow one", async (t) => {
  const f = await fixture(t);
  await f.page.locator("#prompt").focus();
  await f.page.keyboard.press("ControlOrMeta+b"); // the prototype's "Show or hide the list"
  await f.page.waitForFunction(() => document.getElementById("app").classList.contains("side-hidden"));
  assert.equal(await f.page.locator("#side .machine").isVisible(), false, "folded away on the wide window");
  await f.page.setViewportSize({ width: 400, height: 800 });
  // Redesign: in the prototype a list folded away with Ctrl+B stays folded on every width until Ctrl+B brings it back
  // (its .app.side-hidden); the narrow window's "Show conversations" then slides it in.
  await f.page.locator("#prompt").focus();
  await f.page.keyboard.press("ControlOrMeta+b");
  await f.page.waitForFunction(() => !document.getElementById("app").classList.contains("side-hidden"));
  // Redesign: on a narrow window Ctrl+B slides the list in (shell/resize.js toggleSide), and "Show conversations" now
  // sits in the title-bar row above the slid-in list, so it stays pressable: it slides the list away and back in.
  await f.page.waitForFunction(() => document.getElementById("app").classList.contains("side-open"));
  const menu = f.page.locator('.titlebar [data-act="side"]:visible').first();
  await menu.click();
  await f.page.waitForFunction(() => !document.getElementById("app").classList.contains("side-open"));
  await menu.click();
  await f.page.waitForFunction(() => document.getElementById("app").classList.contains("side-open"));
  await f.page.locator("#side-q").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#side-q").isVisible(), true, "the list and its search open on the narrow one");
  assert.deepEqual(f.errors, []);
});

test("this computer's reduce-motion setting is honoured before anyone opens Appearance", async (t) => {
  const f = await fixture(t);
  // The level switch in Settings slides between its choices (.settings .set-level .seg::before, transition .28s).
  await openSettings(f.page);
  const speed = () => f.page.locator(".settings .set-level .seg").first()
    .evaluate((node) => Number.parseFloat(getComputedStyle(node, "::before").transitionDuration));
  assert.ok((await speed()) > 0.1, "normally things move");
  await f.page.emulateMedia({ reducedMotion: "reduce" });
  // The browser takes the new setting on its next style pass, so the page is asked once it reports it.
  await f.page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const still = await f.page.waitForFunction(() => {
    const node = document.querySelector(".settings .set-level .seg");
    return node && Number.parseFloat(getComputedStyle(node, "::before").transitionDuration) < 0.01;
  }, null, { timeout: 5000 }).then(() => true, () => false);
  assert.equal(still, true, "this computer's setting switches it off");
  assert.deepEqual(f.errors, []);
});

test("the composer never comes to rest on top of the greeting or the welcome card", async (t) => {
  // Redesign: the prototype's first run is a screen of its own over the whole window (public/app/flows/first.js), not a
  // card above the composer, so the greeting of an empty conversation is what must stay clear of the message box.
  const f = await fixture(t);
  for (const size of SIZES) {
    await f.page.setViewportSize(size);
    await f.page.locator("#main .empty-chat h1").waitFor({ state: "visible" });
    await f.page.evaluate(() => { const column = document.getElementById("scroll"); column?.scrollTo(0, column.scrollHeight); });
    assert.equal(await boxesHit(f.page, "#main .empty-chat h1", "#composer"), false,
      `the greeting clears the composer at ${size.width}×${size.height}`);
    assert.equal(await sideways(f.page), 0, `no sideways scrolling at ${size.width}`);
  }
  assert.deepEqual(f.errors, []);
});

test("Send is the round button at every size and the helper note sits under the composer", async (t) => {
  // Redesign: the prototype's composer has no helper line under it; Send is still its round button, named Send.
  const f = await fixture(t);
  for (const size of SIZES) {
    await f.page.setViewportSize(size);
    const send = await f.page.evaluate(() => {
      const button = document.getElementById("send"), box = button.getBoundingClientRect(), style = getComputedStyle(button);
      return { round: Math.abs(box.width - box.height) < 1 && Number.parseFloat(style.borderRadius) >= box.width / 2 - 0.5,
        name: button.getAttribute("aria-label") || button.textContent.trim(), inside: Boolean(button.closest("#composer")) };
    });
    assert.equal(send.round, true, `Send is round at ${size.width}`);
    assert.equal(send.inside, true, `Send is in the message box at ${size.width}`);
    assert.match(send.name, /Send/);
  }
  assert.deepEqual(f.errors, []);
});

test("a Recents row lights up under the pointer in Daylight", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "appearance");
  await f.page.locator('.set-col [data-act="themeset"][data-v="light"]').click();
  await f.page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await leaveSettings(f.page);
  await f.page.locator("#prompt").fill("Say hello");
  await f.page.locator("#send").click();
  await f.page.locator("#conversation").getByText("Hello from Branch.").first().waitFor({ timeout: 30000 });
  // A new conversation, so the one just had is a Recents row that is not the open one.
  await f.page.locator('#side [data-act="newmenu"]').click();
  await f.page.locator('.pop [data-act="newconv"]').click();
  const row = f.page.locator('#side .list [data-act="chat"]:not([aria-current="true"])').first();
  await row.waitFor({ timeout: 30000 });
  await f.page.mouse.move(0, 0);
  const colour = () => row.evaluate((node) => getComputedStyle(node).backgroundColor);
  const resting = await colour();
  await row.hover();
  /* The wash arrives through a CSS transition, so the colour is waited for inside the page, not a stopwatch. */
  const hovered = await f.page.waitForFunction((was) => {
    const node = document.querySelector('#side .list [data-act="chat"]:not([aria-current="true"])');
    const now = node && getComputedStyle(node).backgroundColor;
    return now && now !== was ? now : null;
  }, resting, { timeout: 5000 }).then((handle) => handle.jsonValue(), () => resting);
  assert.notEqual(hovered, resting, "the row takes a background under the pointer");
  assert.deepEqual(f.errors, []);
});

test("Ctrl+Shift+K opens the side panel and folds it away again", async (t) => {
  const f = await fixture(t);
  const open = () => f.page.evaluate(() => !document.getElementById("pane").hidden);
  // The side panel is a conversation's, so one is had first.
  await f.page.locator("#prompt").fill("Say hello");
  await f.page.locator("#send").click();
  await f.page.locator("#conversation").getByText("Hello from Branch.").first().waitFor({ timeout: 30000 });
  assert.equal(await open(), false, "closed until asked for");
  await f.page.locator("#prompt").focus();
  await f.page.keyboard.press("ControlOrMeta+Shift+K");
  await f.page.waitForFunction(() => !document.getElementById("pane").hidden);
  await f.page.keyboard.press("ControlOrMeta+Shift+K");
  await f.page.waitForFunction(() => document.getElementById("pane").hidden);
  assert.equal(await f.page.locator("#pal-in").count(), 0, "the palette stays shut");
  assert.deepEqual(f.errors, []);
});

/** Walks Tab and reports where the focus landed each time. */
async function tabStops(page, count) {
  const stops = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => {
      const node = document.activeElement;
      return node?.id || [node?.dataset?.act, node?.dataset?.v].filter(Boolean).join(":") || node?.tagName;
    }));
  }
  return stops;
}

test("Tab walks the title bar first, then the side list, the messages and the composer", async (t) => {
  // Redesign: the prototype's markup puts the title bar first (.titlebar, then #side, then #main), so Tab walks the
  // title bar, then the side list, then the conversation and its message box.
  const f = await fixture(t);
  await reload(f.page);
  const walk = await tabStops(f.page, 60);
  const at = (stop) => walk.indexOf(stop);
  assert.ok(at("pane") > -1, "the title bar is reachable");
  assert.ok(at("machines") > at("pane"), "the side list after the title bar");
  assert.equal(at("side-q"), at("machines") + 1, "the search right after the computer");
  assert.equal(at("view:settings"), at("owner") + 1, "the gear right after the person, at the foot of the list");
  assert.ok(at("prompt") > at("view:settings"), "the message box after the side list");
  assert.deepEqual(f.errors, []);
});

test("Escape leaves the message box without throwing away what was typed", async (t) => {
  // Redesign: the prototype's Escape closes a popover, a dialog or Focus mode and leaves the caret where it is; what was
  // typed is never thrown away.
  const f = await fixture(t);
  await f.page.locator("#prompt").fill("half a thought");
  await f.page.keyboard.press("Escape");
  assert.equal(await f.page.locator("#prompt").inputValue(), "half a thought");
  assert.deepEqual(f.errors, []);
});

test("a folded Places group stays folded, remembered for this workspace", async (t) => {
  // Redesign: the prototype remembers its folded Places group (S.placesShut, kept by public/app/core/state.js), which
  // folds the places into one row of icons whose names become their labels, hiding nothing; its Projects group opens
  // fresh each time.
  const f = await fixture(t);
  const head = f.page.locator('#side [data-act="places14"]');
  const inbox = f.page.locator('#side [data-act="view"][data-v="inbox"]');
  const folded = () => f.page.evaluate(() => {
    const nav = document.querySelector("#side .side-nav"), boxes = [...nav.querySelectorAll(":scope > .nav")].map((b) => b.getBoundingClientRect());
    return { shut: nav.classList.contains("shut14"), oneRow: new Set(boxes.map((b) => Math.round(b.top))).size === 1 };
  });
  assert.deepEqual(await folded(), { shut: false, oneRow: false });
  await head.click();
  assert.equal(await head.getAttribute("aria-expanded"), "false");
  assert.deepEqual(await folded(), { shut: true, oneRow: true }, "the places fold into one row");
  assert.equal(await inbox.isVisible(), true, "nothing is hidden");
  assert.equal(await inbox.getAttribute("aria-label"), "Inbox", "each keeps its name");
  await reload(f.page);
  assert.equal(await head.getAttribute("aria-expanded"), "false", "it is still folded after a reload");
  assert.deepEqual(await folded(), { shut: true, oneRow: true });
  await head.click();
  assert.equal(await head.getAttribute("aria-expanded"), "true");
  assert.equal(await inbox.getAttribute("aria-label"), null);
  assert.deepEqual(f.errors, []);
});

test("with nothing connected the context pane offers one thing to do", async (t) => {
  // Redesign: with no model connected, the prototype's message box says so and offers one way on (public/app/chat/nomodel.js).
  const f = await fixture(t, { provider: null });
  const offers = f.page.locator('.dock .dockrow15[role="status"]');
  await offers.first().waitFor({ state: "visible" });
  assert.equal(await offers.count(), 1, "one thing to do");
  const said = (await (await f.call("/api/state")).json()).modelNeeded;
  assert.ok(said, "the engine says no model is set up");
  assert.equal((await offers.locator(".hint").innerText()).trim(), said, "in the engine's own words");
  await offers.locator('[data-act="setgo"][data-v="models"]').click();
  await f.page.locator('.settings button.nav[data-v="models"][aria-current="true"]').waitFor();
  assert.deepEqual(f.errors, []);
});

/* ==================== Wave 8: the design QA pass ====================
   Q3 nothing is wider than a 400 px window; Q4 the words on the screens are the words in the
   glossary; Q5 focus can be seen, Escape closes what it opened, and stillness is honoured.
   Redesign: every screen of the new window: each place and each of its tabs, and each Settings page. */
const PLACE_TABS = { inbox: ["needs", "finished", "history"], automations: ["scheduled", "procedures", "triggers"], library: ["memory", "documents", "made"],
  customize: ["trunks", "tools", "specialists", "channels", "everywhere"], team: [], overview: [] };

/** Every screen, opened the way a person opens it; `look(name)` is called on each with its holder's selector. */
async function everyScreen(page, look) {
  for (const [place, tabs] of Object.entries(PLACE_TABS)) {
    for (const tab of tabs.length ? tabs : [null]) {
      await openPlace(page, place, tab ?? undefined);
      await page.locator("#main .place h1").first().waitFor();
      await page.evaluate(() => document.getElementById("app").classList.remove("side-open"));
      await page.settled();
      await look(tab ? `${place}:${tab}` : place, "#main .place");
    }
  }
  await openSettings(page, "general");
  const pages = await page.locator('.settings button.nav[data-act="setpage"]').evaluateAll((all) => all.map((one) => one.dataset.v));
  for (const id of pages) {
    await page.locator(`.settings button.nav[data-act="setpage"][data-v="${id}"]`).click();
    await page.locator(".set-col h1").first().waitFor();
    await page.settled();
    await look(`settings:${id}`, ".set-col");
  }
  await leaveSettings(page);
}

test("Q3 at 400 px nothing on any screen is wider than the window", async (t) => {
  const f = await fixture(t, { width: 400, height: 800 });
  await everyScreen(f.page, async (view, holder) => {
    const tooWide = await f.page.evaluate((selector) => {
      /* Only a scroller inside the screen excuses a wide box (a table or a row of tabs may keep its own sideways scroll). */
      const root = document.querySelector(selector);
      const scrolls = (node) => {
        for (let p = node; p && p !== root.parentElement; p = p.parentElement) {
          const x = getComputedStyle(p).overflowX;
          if ((x === "auto" || x === "scroll" || x === "hidden") && p !== root) return true;
        }
        return false;
      };
      const out = [];
      for (const node of root.querySelectorAll("*")) {
        if (node.offsetParent === null) continue;
        const box = node.getBoundingClientRect();
        if (box.width > window.innerWidth + 1 && !scrolls(node))
          out.push(`${node.tagName.toLowerCase()}.${node.className.toString().slice(0, 30)} = ${Math.round(box.width)}px`);
      }
      return out;
    }, holder);
    assert.deepEqual(tooWide, [], `${view} has something wider than a 400 px window`);
    const across = await sideways(f.page);
    assert.ok(across <= 1, `${view} makes the page scroll sideways by ${across}px`);
  });
  assert.deepEqual(f.errors, []);
});

test("Q4 every control that can be seen can also be named", async (t) => {
  const f = await fixture(t);
  await everyScreen(f.page, async (view, holder) => {
    const nameless = await f.page.evaluate((selector) => {
      const out = [];
      for (const node of document.querySelector(selector).querySelectorAll("button, input, select, textarea")) {
        if (node.offsetParent === null) continue;
        const name = node.labels?.[0]?.textContent?.trim() || node.labels?.[0]?.getAttribute("aria-label") || node.getAttribute("aria-label") ||
          document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ||
          node.title || node.textContent.trim() || node.getAttribute("placeholder");
        if (!name) out.push(`${node.tagName.toLowerCase()}#${node.id || "(no id)"}.${node.dataset.act ?? ""}`);
      }
      return out;
    }, holder);
    assert.deepEqual(nameless, [], `${view} has a control nothing can read out`);
  });
  assert.deepEqual(f.errors, []);
});

test("Q4 a tick box sits beside its words, in the reading face", async (t) => {
  // Redesign: the prototype's switches are tick boxes drawn as switches (.sw) in a row (.ctl) with their words (<b>).
  const f = await fixture(t);
  const wrong = [];
  await everyScreen(f.page, async (view, holder) => {
    if (!view.startsWith("settings:")) return;
    wrong.push(...await f.page.evaluate(({ selector, name }) => {
      const out = [];
      for (const box of document.querySelector(selector).querySelectorAll('input[type="checkbox"].sw')) {
        if (box.offsetParent === null) continue;
        // A settings row (.ctl) leads with its words (<b>); a switch in a list row (a file, a Trunk) is beside that row's words.
        let words = box.closest(".ctl")?.querySelector(":scope > b");
        for (let up = box.parentElement, n = 0; !words && up && n < 3; up = up.parentElement, n++) if (up.textContent.trim()) words = up;
        if (!words?.textContent.trim()) out.push(`${name} ${box.id || box.dataset.sw}: no words beside it`);
        else {
          const w = words.getBoundingClientRect(), b = box.getBoundingClientRect(), row = box.closest(".ctl")?.getBoundingClientRect() ?? w;
          if (b.top + b.height / 2 < row.top - 1 || b.top + b.height / 2 > row.bottom + 1) out.push(`${name} ${box.id || box.dataset.sw}: not beside its words`);
          else if (b.width > 60) out.push(`${name} ${box.id || box.dataset.sw}: the tick box is stretched`);
        }
        if (words && getComputedStyle(words).fontFamily.includes("Mono")) out.push(`${name} ${box.id}: its words are not in the reading face`);
      }
      return out;
    }, { selector: holder, name: view }));
  });
  assert.deepEqual(wrong, []);
  assert.deepEqual(f.errors, []);
});

test("Q4 every screen calls the same thing by the same name", async (t) => {
  const f = await fixture(t);
  /* One name per idea. Each pattern is a word the owner should never have to meet on its own;
     the second half of each pair is what to say instead. See docs/design.md, "The glossary". */
  // Redesign: the prototype names a skill's file itself ("Step-by-step know-how, as SKILL.md"), so SKILL.md is its word now.
  const banned = [
    [/\bAPI base URL\b/, "web address of the service"],
    [/\bendpoint\b/i, "web address"],
    [/\bpayload\b/i, "what is sent"],
    [/\bSSE\b/, "live updates"],
  ];
  await everyScreen(f.page, async (view, holder) => {
    const words = await f.page.evaluate((selector) => document.querySelector(selector).innerText, holder);
    for (const [pattern, instead] of banned)
      assert.equal(pattern.test(words), false, `${view} still says ${pattern} where it should say "${instead}"`);
  });
  assert.deepEqual(f.errors, []);
});

test("Q4 every section says what it is for, and every card carries a title", async (t) => {
  // Redesign: every place and Settings page opens on its title (h1) and the line that says what it is for (.lede), as
  // the prototype's placeHead and set-col do; every section (.sec) of a Settings page carries its heading.
  const f = await fixture(t);
  await everyScreen(f.page, async (view, holder) => {
    const said = await f.page.evaluate((selector) => {
      const root = document.querySelector(selector), title = root.querySelector("h1");
      return { title: title?.textContent.trim() ?? "", lede: Boolean(root.querySelector(".lede")?.textContent.trim()) };
    }, holder);
    assert.ok(said.title, `${view} has no title`);
    assert.ok(said.lede, `${view} never says what it is for`);
    if (!view.startsWith("settings:")) return; // a place may lay out a row of cards with no heading, as the prototype's do
    const untitled = await f.page.evaluate((selector) => [...document.querySelector(selector).querySelectorAll(".sec")]
      .filter((section) => section.offsetParent !== null && !section.querySelector(":scope > h2, :scope > h3, :scope > summary")?.textContent.trim())
      .map((section) => section.className), holder);
    assert.deepEqual(untitled, [], `${view} has a section with no title`);
  });
  assert.deepEqual(f.errors, []);
});

test("Q5 Escape closes every popover this pass touched", async (t) => {
  const f = await fixture(t);
  await f.page.keyboard.press("ControlOrMeta+k");
  await f.page.locator("#pal-in").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#pal-in").waitFor({ state: "detached" });

  await f.page.locator('#side [data-act="owner"]').click();
  await f.page.locator(".pop").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator(".pop").waitFor({ state: "detached" });

  await f.page.locator('#side [data-act="newmenu"]').click();
  await f.page.locator(".pop").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator(".pop").waitFor({ state: "detached" });
  assert.deepEqual(f.errors, []);
});

// Redesign: the prototype's composer has no helper line and no running cost beneath it; a conversation's cost is in
// its side panel's Timeline (public/app/chat/timeline.js).
test.skip("Q5 the helper line and the conversation's cost share one row, clear of the message box (DG-101)", async () => {});

test("Q5 focus can be seen, and stillness is honoured", async (t) => {
  const f = await fixture(t);
  /* The message box shows its focus as the prototype's pass 17 does: a darker edge and a 4 px ring round the whole box. */
  const rest = await f.page.evaluate(() => getComputedStyle(document.getElementById("composer")).borderTopColor);
  await f.page.locator("#prompt").focus();
  await f.page.waitForFunction((was) => {
    const box = getComputedStyle(document.getElementById("composer"));
    return box.borderTopColor !== was && / 0px 0px 0px 4px\b/.test(` ${box.boxShadow}`);
  }, rest, { timeout: 3000 }).then(() => true, () => assert.fail("a focused message box shows no edge or ring"));
  /* Keyboard focus on a control can be seen. */
  await f.page.keyboard.press("Tab"); // Shift+Tab in the message box changes how much it may do (the prototype's mode chip)
  const ring = await f.page.evaluate(() => {
    const node = document.activeElement, style = getComputedStyle(node);
    return { seen: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0 || style.boxShadow !== "none",
      which: `${node.tagName}.${node.className}[${node.dataset.act ?? ""}] outline ${style.outlineStyle} ${style.outlineWidth}` };
  });
  assert.equal(ring.seen, true, `a focused control shows where the keyboard is (${ring.which})`);
  /* This computer's "reduce motion" makes every move instant. */
  await f.page.emulateMedia({ reducedMotion: "reduce" });
  await f.page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const still = await f.page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.getElementById("send")).transitionDuration) < 0.01,
    null, { timeout: 5000 }).then(() => "0s", () => f.page.evaluate(() => getComputedStyle(document.getElementById("send")).transitionDuration));
  assert.ok(Number.parseFloat(still) < 0.01, `movement is still ${still} long when the computer asked for stillness`);
  assert.deepEqual(f.errors, []);
});
