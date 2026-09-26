/**
 * phase2/settings: Settings grown up — groups by task, Regular / Advanced / Technical, every setting
 * reachable and findable, the cog after the account row, keeping your place, nothing overflowing.
 *
 * Redesign (sweep-B): the new window's Settings (public/app/settings/**, design/redesign/prototype.html pass 17). Its
 * pages are the prototype's eighteen in four groups; its search finds a page by its name (settings.js searchText), and
 * the level is the prototype's Regular / Advanced / Technical switch at the foot of the page list. The old window's index
 * of every setting (public/settings-index.js, public/settings-buckets.js), its "N more" lines, directory pages, mirrors
 * and theme strip are gone; the tests about them are skipped one by one below, each saying what the prototype has
 * instead. The security checks (a household person, Regular keeping the prototype's Regular safety controls in sight, the page's own
 * Content Security Policy) are ported and kept strict.
 */
import nodeTest from "node:test";
/* This file is split into parts so the build machines can run its minutes side by side: each
   tests/settings-grown-N.test.mjs runs every 3th test declared here, starting from its own. Nothing is
   skipped: the parts together declare every test, in the same order, with the same body. */
const part = globalThis.branchTestPart ?? { index: 0, of: 1 };
let declared = 0;
const test = (...args) => (declared++ % part.of === part.index ? nodeTest(...args) : undefined);
test.skip = (...args) => (declared++ % part.of === part.index ? nodeTest.skip(...args) : undefined);
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { offLimitsToHousehold } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openSettingsPage, setLevel, settingsWindow } from "./settings-window.mjs";

test("every Settings page introduction has English and French words", async () => {
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  for (const page of ["trunks", "channels", "connections", "skills", "memory", "automations"]) {
    const key = `settings.window.${page}.intro`;
    assert.ok(en[key], `${key} has English words`);
    assert.ok(fr[key] && fr[key] !== en[key], `${key} has real French words`);
  }
});

/** A signed-in new window whose Content Security Policy refusals are written down from the first request. */
async function fixture(t, { width = 1440, height = 950, preferences } = {}) {
  const refused = [];
  const f = await settingsWindow(t, { name: "settings-grown", width, height,
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } },
    before: (app) => {
      saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
      if (preferences) app.store.save("settings", app.runtime.owner, "preferences", preferences);
    },
    route: async (page) => {
      page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) refused.push(message.text()); });
      await page.addInitScript(() => {
        globalThis.__refused = [];
        document.addEventListener("securitypolicyviolation", (event) => globalThis.__refused.push(`${event.violatedDirective} ${event.sourceFile}:${event.lineNumber}`));
      });
    } });
  const headers = { authorization: `Bearer ${f.server.token}`, "content-type": "application/json" };
  return { ...f, refused, url: f.server.url, headers };
}
/** The page list's own button (a page may also link to another with the same data-act). */
const navButton = (page, id) => page.locator(`.settings button.nav[data-act="setpage"][data-v="${id}"]`);
const allPages = (page) => page.locator('.settings button.nav[data-act="setpage"]').evaluateAll((all) => all.map((one) => one.dataset.v));
/** The headings on the open page, in order. */
const headings = (page) => page.locator(".set-col").locator("h1, h2, h3").evaluateAll((all) =>
  all.filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));

test("the desktop Settings level and version stay at the bottom of the rail", async (t) => {
  // Redesign: the prototype's page list ends with its level switch (.set-level); the version is in the status bar.
  const f = await fixture(t, { width: 1440, height: 1800 });
  await openSettingsPage(f.page, "general");
  const layout = await f.page.evaluate(() => {
    const nav = document.querySelector(".set-nav").getBoundingClientRect();
    const level = document.querySelector(".set-nav .set-level").getBoundingClientRect();
    const pages = [...document.querySelectorAll(".set-nav button.nav")].map((b) => b.getBoundingClientRect().bottom);
    return { navTop: nav.top, navBottom: nav.bottom, levelTop: level.top, levelBottom: level.bottom, lastPage: Math.max(...pages) };
  });
  assert.ok(layout.levelTop >= layout.lastPage, `the level switch comes after every page: ${JSON.stringify(layout)}`);
  assert.ok(layout.levelBottom <= layout.navBottom + 1, `the level switch stays inside the page list: ${JSON.stringify(layout)}`);
  assert.deepEqual(f.errors, []);
});

// Redesign: the new window keeps no index of every setting and its home (public/settings-index.js is gone); each page
// draws the prototype's own rows, and search finds pages by name. The audit's inventory has nothing to be held against.
test.skip("S1 every setting in the audit is in the index, at the home the audit gives it", () => {});
// Redesign: as S1; the prototype draws a row only for what it shows, not a control for every engine setting.
test.skip("S2 every setting has a real control, where the audit says it lives", async () => {});
// Redesign: as S1; with no control per audited setting there is no default to read off each one.
test.skip("S3 on a fresh install every setting starts at its real default", async () => {});
// Redesign: the prototype's search filters the page list by name (settings.js), it does not list settings.
test.skip("S4 Settings search finds every one of the 530 settings, at any level", async () => {});
// Redesign: with no search results for single settings there is no "Go there" to press.
test.skip("S5 Go there opens the place and shows the card, even above the level", async () => {});

test("S6 Regular shows the essentials; each level shows more; the choice is kept after a reload", async (t) => {
  // Redesign: the prototype's level is this window's own choice (kept by public/app/core/state.js), not the engine's
  // Show everything; each level adds the prototype's sections to a page.
  const f = await fixture(t);
  await openSettingsPage(f.page, "models");
  await setLevel(f.page, "regular");
  const regular = await headings(f.page);
  await setLevel(f.page, "advanced");
  const advanced = await headings(f.page);
  await setLevel(f.page, "technical");
  const technical = await headings(f.page);
  assert.ok(advanced.length > regular.length && technical.length > advanced.length, `each level shows more (${regular.length}, ${advanced.length}, ${technical.length})`);
  assert.ok(regular.every((one) => advanced.includes(one)) && advanced.every((one) => technical.includes(one)), "and keeps what the level below shows");
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingsPage(f.page, "models");
  await f.page.locator('[data-act="setlevel"][data-v="technical"][aria-pressed="true"]').waitFor();
  assert.deepEqual(await headings(f.page), technical, "the choice is kept");
  assert.deepEqual(f.errors, []);
});

// Redesign: the engine's Show everything no longer picks the level, and search finds pages, not single settings.
test.skip("S7 someone who already had Show everything on starts on Advanced, and search ignores the level", async () => {});

test("S8 somebody else's profile is not drawn the owner's controls, search never names the owner's settings, and the engine refuses their look and level", async (t) => {
  // Redesign: the new window starts again from nothing when the person changes (public/app/main.js watchPerson). The
  // owner's settings stay the owner's at the engine, and the owner-only controls are not drawn for somebody else.
  const f = await fixture(t);
  const sam = await fetch(new URL("/api/profiles", f.url), { method: "POST", headers: f.headers, body: JSON.stringify({ name: "Sam", pin: "2468" }) }).then((r) => r.json());
  const reloaded = f.page.waitForEvent("load", { timeout: 30000 });
  const switched = await fetch(new URL("/api/profiles/switch", f.url), { method: "POST", headers: f.headers, body: JSON.stringify({ profileId: sam.id, pin: "2468" }) });
  assert.equal(switched.status, 200);
  await reloaded;
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingsPage(f.page, "people");
  await f.page.locator(".set-col h1").first().waitFor();
  assert.equal(await f.page.locator('.set-col [data-act="p-invite"], .set-col [data-act="p-role"], .set-col [data-act="p-remove"]').count(), 0,
    "no owner-only control is drawn for somebody else");
  /* Search names pages only, never a setting of the owner's. */
  await f.page.locator("#set-q").fill("Key name in Secrets");
  assert.equal(await f.page.locator(".set-col").getByText("Key name in Secrets").count(), 0);
  /* The server keeps the look and the level the owner's. */
  assert.notEqual(offLimitsToHousehold("POST", "/api/preferences"), null);
  const refused = await fetch(new URL("/api/preferences", f.url), { method: "POST", headers: f.headers, body: JSON.stringify({ settingsLevel: "technical", showEverything: true }) });
  assert.notEqual(refused.status, 200, "somebody else cannot save the owner's look or level");
  assert.deepEqual(f.errors, []);
});

test("a household profile switched in while Instructions was open starts again on General, marked in the phone page strip", async (t) => {
  // Redesign: when the person changes, the new window starts again from nothing, so Settings opens on General again,
  // not on the owner's Instructions, with General's button marked in the phone's page strip.
  const f = await fixture(t, { width: 390, height: 844 });
  await openSettingsPage(f.page, "instructions");
  const sam = await fetch(new URL("/api/profiles", f.url), { method: "POST", headers: f.headers, body: JSON.stringify({ name: "Sam", pin: "2468" }) }).then((r) => r.json());
  const reloaded = f.page.waitForEvent("load", { timeout: 30000 });
  const switched = await fetch(new URL("/api/profiles/switch", f.url), { method: "POST", headers: f.headers, body: JSON.stringify({ profileId: sam.id, pin: "2468" }) });
  assert.equal(switched.status, 200);
  await reloaded;
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await f.page.keyboard.press("ControlOrMeta+Comma");
  await f.page.locator(".settings").waitFor();
  await navButton(f.page, "general").and(f.page.locator('[aria-current="true"]')).waitFor();
  // The prototype's phone strip does not scroll to the page on show, so only which page is marked is checked.
  assert.equal(await navButton(f.page, "instructions").getAttribute("aria-current"), "false", "Instructions has left the strip's mark");
  assert.equal(await f.page.locator('.set-nav button.nav[aria-current="true"]').count(), 1);
  assert.deepEqual(f.errors, []);
});

// Redesign: the prototype groups the page list (tests/settings-nav-groups.test.mjs) and draws each page's own sections;
// there are no buckets and no "More on this page" to hold a card added later.
test.skip("S9 every page is grouped, and a card no group names still shows under More on this page", async () => {});

for (const [width, height] of [[1440, 950], [390, 844]]) {
  // Redesign: the prototype's Settings has no directory pages (Connections, Skills & plugins, Memory & library,
  // Automations & inbox); those places are in the side list itself.
  test.skip(`S9 directories at ${width}x${height} open their real Branch places`, async () => {});
}

test("S10 Settings is a gear at the right end of the account row, and opens every page", async (t) => {
  // Redesign: the prototype's gear is at the right end of the account row at the foot of the side list.
  const f = await fixture(t);
  const placed = await f.page.evaluate(() => {
    const row = document.querySelector("#side .owner-row"), gear = row?.querySelector('[data-act="view"][data-v="settings"]');
    const owner = row?.querySelector('[data-act="owner"]');
    const a = owner?.getBoundingClientRect(), b = gear?.getBoundingClientRect(), r = row?.getBoundingClientRect();
    return { owner: Boolean(owner?.checkVisibility()), gear: Boolean(gear?.checkVisibility()), after: b ? b.left >= a.right - 1 : false,
      end: b ? Math.abs(b.right - r.right) < 16 : false, row: b ? Math.abs((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2) < 8 : false };
  });
  assert.deepEqual(placed, { owner: true, gear: true, after: true, end: true, row: true });
  await f.page.locator('#side .owner-row [data-act="view"][data-v="settings"]').click();
  await f.page.locator(".settings").waitFor({ state: "visible" });
  assert.ok((await allPages(f.page)).length >= 18, "every page is there");
  assert.deepEqual(f.errors, []);
});

test("S11 closing and opening Settings, pressing the same page, or changing the level keeps your place", async (t) => {
  const f = await fixture(t, { width: 1024, height: 700 });
  await openSettingsPage(f.page, "permissions");
  await setLevel(f.page, "technical");
  const scroller = () => f.page.evaluate(() => {
    for (let node = document.querySelector(".set-col"); node; node = node.parentElement)
      if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node.scrollTop;
    return null;
  });
  const scrollTo = (y) => f.page.evaluate((top) => {
    for (let node = document.querySelector(".set-col"); node; node = node.parentElement)
      if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) { node.scrollTop = top; return; }
  }, y);
  await scrollTo(600);
  const at = await scroller();
  assert.ok(at > 300, `the page is long enough to scroll (${at})`);
  // Redesign: pressing the page on show draws it again from its top, as the prototype's setpage does; the page itself is kept.
  await navButton(f.page, "permissions").click();
  assert.equal(await navButton(f.page, "permissions").getAttribute("aria-current"), "true");
  await f.page.locator('[data-act="setlevel"][data-v="advanced"]').click();
  await f.page.locator('[data-act="setlevel"][data-v="advanced"][aria-pressed="true"]').waitFor();
  assert.equal(await navButton(f.page, "permissions").getAttribute("aria-current"), "true", "changing the level kept the page");
  await f.page.locator('.settings [data-act="chat"]').first().click();
  await f.page.keyboard.press("ControlOrMeta+Comma");
  await navButton(f.page, "permissions").and(f.page.locator('[aria-current="true"]')).waitFor();
  /* Another page starts at its top. */
  await navButton(f.page, "voice").click();
  await navButton(f.page, "voice").and(f.page.locator('[aria-current="true"]')).waitFor();
  assert.equal(await scroller() ?? 0, 0);
  assert.deepEqual(f.errors, []);
});

for (const [width, height] of [[1440, 950], [1024, 700], [390, 844]]) {
  test(`S12 at ${width}×${height} no Settings page overflows sideways and no chip leaves its card`, async (t) => {
    const f = await fixture(t, { width, height });
    await openSettingsPage(f.page, "general");
    await setLevel(f.page, "technical");
    const problems = [];
    for (const id of await allPages(f.page)) {
      await navButton(f.page, id).click();
      await f.page.locator(".set-col h1").first().waitFor();
      const tabs = id === "models" ? await f.page.locator('.set-col [data-act="mtab"]').count() : 1;
      for (let tab = 0; tab < tabs; tab++) {
        if (id === "models") await f.page.locator('.set-col [data-act="mtab"]').nth(tab).click();
        problems.push(...(await f.page.evaluate(sweep)).map((line) => `${id}${tabs > 1 ? "#" + tab : ""}: ${line}`));
      }
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(f.errors, []);
  });
}
/** Runs in the page: sideways overflow of the window or the page, and chips, pills and badges outside their section. */
function sweep() {
  const out = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`the window scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);
  const col = document.querySelector(".set-col");
  if (col.scrollWidth > col.clientWidth + 1) out.push(`the page scrolls sideways by ${col.scrollWidth - col.clientWidth}px`);
  for (const chip of col.querySelectorAll(":is(.chip, .pill, .badge, [class*='chip'], [class*='pill'], [class*='badge'])")) {
    if (!chip.checkVisibility() || chip.classList.contains("sr-only")) continue;
    const card = chip.closest(".sec, .ctl, .prow") ?? col;
    const a = chip.getBoundingClientRect(), b = card.getBoundingClientRect();
    if (a.width === 0) continue;
    if (a.right > b.right + 1 || a.left < b.left - 1) out.push(`${chip.className || chip.tagName} "${chip.textContent.trim().slice(0, 30)}" leaves ${card.className}`);
  }
  return out;
}

test("S13 Appearance: light and dark pictures of the window, each wearing its look when pressed", async (t) => {
  // Redesign: the prototype's "Light or dark" draws two small pictures of the window, light and dark, and a third for
  // following the computer; pressing one wears it. The theme gallery previews in its own dialog.
  const f = await fixture(t);
  await openSettingsPage(f.page, "appearance");
  const mirrors = f.page.locator('.set-col .mirrors [data-act="themeset"]');
  assert.deepEqual(await mirrors.evaluateAll((all) => all.map((one) => one.dataset.v)), ["light", "dark", "system"]);
  for (const mode of ["light", "dark"]) {
    await f.page.locator(`.set-col .mirrors [data-act="themeset"][data-v="${mode}"]`).click();
    await f.page.waitForFunction((value) => document.documentElement.dataset.theme === value, mode);
    await f.page.locator(`.set-col .mirrors [data-act="themeset"][data-v="${mode}"][aria-pressed="true"]`).waitFor();
    // The engine names the two looks by their themes: Daylight, and Forest for the dark one.
    assert.equal((await f.call("/api/state")).preferences.appearance, mode === "light" ? "daylight" : "forest", "the engine keeps the choice");
  }
  assert.equal(await f.page.locator(".set-col .mirrors #prompt, .set-col .mirrors iframe").count(), 0, "the pictures are drawings, not copies of the window");
  assert.deepEqual(f.errors, []);
});

// Redesign: with no index of settings there is nothing for a declared setting to be found in (public/settings-index.js
// is gone); docs/configuration.md is held to the declared settings by scripts/check-docs.mjs.
test.skip("S14 every setting Branch declares has a Settings search entry, or a stated reason on the list above", () => {});

/* ---------- S15: Regular never hides a safety control ---------- */
/* Redesign: the prototype's Regular level shows, on Settings › Permissions, Lockdown and the switches for what Branch may
   do without asking; on Computer & browser, seeing the screen and using the computer; on Updates & about, update by
   itself. (Its "second look before approvals" and "work in apps in the background" are Advanced rows in the prototype.) */
const SAFETY = {
  permissions: ['[data-act="perm-lock"]', "#p-read", "#p-browse", "#p-send"],
  computer: ["#c-screen", "#c-ask"],
  updates: ["#u-auto"],
};
for (const [width, height] of [[1440, 950], [390, 844]]) {
  test(`S15 at ${width}×${height} Regular, with nothing peeked, shows Lockdown, what Branch may do, seeing the screen and update by itself`, async (t) => {
    const f = await fixture(t, { width, height });
    await openSettingsPage(f.page, "general");
    await setLevel(f.page, "regular");
    for (const [page, controls] of Object.entries(SAFETY)) {
      await navButton(f.page, page).click();
      await f.page.locator(".set-col h1").first().waitFor();
      for (const css of controls) {
        const control = f.page.locator(`.set-col ${css}`).first();
        await control.waitFor({ state: "attached", timeout: 20000 });
        // A switch is drawn over its tick box, so it is judged by whether it is on show, not by Playwright's own box.
        const shown = await control.evaluate((node) => { node.scrollIntoView({ block: "center" });
          return node.checkVisibility({ visibilityProperty: true }) && !node.closest("[hidden], details:not([open])"); });
        assert.equal(shown, true, `${page}: ${css} is hidden on Regular`);
      }
    }
    assert.deepEqual(f.errors, []);
  });
}

/* ---------- S16: the page's own rules are kept ---------- */
test("S16 the window loads and opens Settings with no Content Security Policy refusal, and the scope chips are dressed", async (t) => {
  // Redesign: every Settings page is opened; the prototype shows no scope chips, so the page's own stylesheet is what is
  // checked to have loaded (a section heading is styled).
  const f = await fixture(t);
  await openSettingsPage(f.page, "general");
  await setLevel(f.page, "technical");
  for (const id of await allPages(f.page)) {
    await navButton(f.page, id).click();
    await f.page.locator(".set-col h1").first().waitFor();
  }
  assert.deepEqual(f.refused, [], "the console reported a Content Security Policy refusal");
  assert.deepEqual(await f.page.evaluate(() => globalThis.__refused), [], "the page saw a Content Security Policy violation");
  await navButton(f.page, "general").click();
  const size = await f.page.locator(".set-col h1").first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  assert.ok(size > 16, `the page title is ${size}px: app.css did not load`);
  assert.deepEqual(f.errors, []);
});

// Redesign: the prototype's Models › Second opinion is one switch (greyed until the engine can hold it,
// public/app/settings/pages/models.js); its limits have no fields to load or save.
test.skip("S17 the second-opinion limits load when Settings opens from the cog, and saving them untouched keeps them", async () => {});

for (const [width, height] of [[1440, 950], [1024, 700], [390, 844]]) {
  // Redesign: the prototype's themes are chosen in a gallery dialog with its own Daylight and Moonlight previews
  // (public/app/shell/themes.js); there is no strip riding over a scrolling Appearance page.
  test.skip(`S18 at ${width}×${height} the preview stays in sight while you scroll down the themes and point at one`, async () => {});
}

test("S19 in French, search finds a Settings page by its French name", async (t) => {
  // Redesign: search finds pages by name; in French, the French name finds the page.
  const f = await fixture(t);
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  await f.page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await f.page.waitForFunction(() => document.documentElement.lang === "fr");
  await openSettingsPage(f.page, "general");
  const words = (await navButton(f.page, "secrets").innerText()).trim();
  assert.notEqual(words, "Saved sign-ins", "the page's name was not translated");
  await f.page.locator("#set-q").fill(words);
  await navButton(f.page, "secrets").waitFor();
  assert.deepEqual(await allPages(f.page), ["secrets"], "the French name finds its page, and only it");
  assert.ok(Object.values(fr).includes(words), "in the French words");
  assert.deepEqual(f.errors, []);
});

// Redesign: the prototype's light and dark pictures are drawn from the look's colours in the page itself, with no copy of
// the window in a frame to redraw or to ask the server for anything.
test.skip("S20 the mirrors redraw without a single request of their own, pictures included", async () => {});
