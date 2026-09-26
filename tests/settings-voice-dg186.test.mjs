/* DG-186 and DG-047: Settings › Voice has the approved sample's sections, in its order, with its "N more" counts:
   Voice · Listening right now · Talking and listening · 18 more with Advanced · The voices it speaks with · 11 more
   with Advanced. Every card the page had keeps a place, and "Listening right now" says what the listeners really
   report: your word, dictation, nothing, or a computer that cannot listen. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { settingsWindow, openSettingsPage, setLevel } from "./settings-window.mjs";

const CARDS = ["voice-settings-form", "dictation-form", "wake-word-form", "comfort-voice-card", "system-voice-card", "personal-voice-card", "speech-engines-card"];

/* The new window: Settings › Voice is the prototype's page: "Talking" and "Speaking back" at Regular, "Live
   conversations" from Advanced, at 1440 and 400 px, fitting the window; a choice is kept as it is pressed. */
for (const width of [1440, 400]) {
  test(`DG-186 at ${width} px the Voice page shows the prototype's headings at each level, and fits`, async (t) => {
    const { page, errors } = await settingsWindow(t, { name: "voice-dg186", width, height: 950 });
    await openSettingsPage(page, "voice");
    const heads = () => page.locator(".set-col").locator("h1, h2, h3, h4").evaluateAll((all) =>
      all.filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
    await setLevel(page, "regular");
    assert.deepEqual(await heads(), ["Voice", "Talking", "Speaking back"]);
    await setLevel(page, "advanced");
    // The prototype's Advanced adds "Listening, more" (FINE15 voice, level 1) and then "Talking, more" (whereB17('voice', 1));
    // it has no "Live conversations" (the lead, 2026-09-26). Pass 17 part D adds "Calls and meetings" after them
    // (addSettings15('voice', 1, ...)).
    assert.deepEqual(await heads(), ["Voice", "Talking", "Speaking back", "Listening, more", "Talking, more", "Calls and meetings"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "the page fits the window");
    assert.deepEqual(errors, []);
  });
}

/* The prototype's "Answer aloud" (Never / When I talk / Always, in "Listening, more" at Advanced) is the engine's
   read-aloud setting (the lead, 2026-09-26): Always reads every reply aloud, Never none; kept as it is pressed. */
test("DG-025 Answer aloud is kept as it is pressed, with no Save button", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "voice-dg186" });
  await openSettingsPage(page, "voice");
  await setLevel(page, "advanced");
  const col = page.locator(".set-col");
  assert.equal(await col.getByRole("button", { name: /^Save/ }).count(), 0, "no Save button");
  const group = col.getByRole("group", { name: "Answer aloud", exact: true });
  await group.getByRole("button", { name: "Never", exact: true, pressed: true }).waitFor();
  await group.getByRole("button", { name: "Always", exact: true }).click();
  for (let tries = 0; tries < 50 && (await call("/api/voice/settings")).autoReadAloud !== true; tries++) await page.waitForTimeout(100);
  assert.equal((await call("/api/voice/settings")).autoReadAloud, true);
  await group.getByRole("button", { name: "Always", exact: true, pressed: true }).waitFor();
  await group.getByRole("button", { name: "Never", exact: true }).click();
  for (let tries = 0; tries < 50 && (await call("/api/voice/settings")).autoReadAloud !== false; tries++) await page.waitForTimeout(100);
  assert.equal((await call("/api/voice/settings")).autoReadAloud, false);
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (public/settings-buckets.js is gone; the prototype's sections are checked above).
test.skip("DG-186 Voice's sections are the sample's, in its order, and no card lost its place", async () => {
  const { BUCKETS } = await import("../public/settings-buckets.js");
  const voice = BUCKETS.voice;
  assert.deepEqual(voice.map((bucket) => bucket[2]), ["Listening right now", "Talking and listening", "The voices it speaks with"]);
  assert.deepEqual(voice[1][4].map(([id]) => id), ["voice-settings-form", "dictation-form", "comfort-voice-card", "wake-word-form"]);
  assert.deepEqual(voice[2][4].map(([id]) => id), ["system-voice-card", "personal-voice-card", "speech-engines-card"]);
  const placed = voice.flatMap((bucket) => bucket[4].map(([id]) => id));
  assert.deepEqual(CARDS.filter((id) => !placed.includes(id)), [], "every card the page had is still on it");
});

test("DG-047 the words for Listening right now are in English and in real French", async () => {
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const keys = ["settingsGrown.bucket.voice.listening", "settingsGrown.bucket.voice.listening.line", "settings.voice-listening.title",
    "settings.voice-listening.word", "settings.voice-listening.dictation", "settings.voice-listening.none",
    "settings.voice-listening.unavailable", "settings.voice-listening.unknown"];
  for (const key of keys) {
    assert.ok(en[key], `${key} in English`);
    assert.ok(fr[key] && fr[key] !== en[key], `${key} in French`);
  }
});

async function settings(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-voice-dg186-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  return { page, errors, server };
}
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value));
/** The headings and "N more" lines of the Voice page a person can see, in order. */
const outline = (page) => page.evaluate(() => {
  const host = document.getElementById("lx-page-voice");
  const seen = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  return [...host.querySelectorAll("h1, h2, h3, h4, h5, .sg-more")].filter(seen).map((node) => node.textContent.trim());
});

for (const width of [1440, 400]) {
  // Redesign: replaced by the new window (the prototype's headings, re-pointed above; no "N more" lines, no Show everything).
  test.skip(`DG-186 at ${width} px the Voice page shows the sample's headings and counts, with Show everything off and on`, async (t) => {
    const { page, errors } = await settings(t, width);
    await level(page, "regular");
    await page.evaluate(() => globalThis.branchLayout.go("settings:voice"));
    await page.waitForFunction(() => [...document.querySelectorAll("#lx-page-voice .sg-more")].some((more) => more.textContent === "18 more with Advanced"));
    assert.deepEqual(await outline(page), ["Voice", "Listening right now", "Talking and listening", "18 more with Advanced",
      "The voices it speaks with", "11 more with Advanced"]);
    await level(page, "advanced");
    await page.waitForTimeout(300);
    const everything = await outline(page);
    assert.deepEqual(everything.filter((words) => !/ more with /.test(words)), ["Voice", "Listening right now", "Talking and listening", "The voices it speaks with"],
      "a card's own title is never a heading beside its section's");
    const fits = await page.evaluate(() => [...document.querySelectorAll("#lx-page-voice > .card")]
      .filter((card) => card.getClientRects().length).every((card) => card.getBoundingClientRect().right <= innerWidth));
    assert.ok(fits, "every card fits the window");
    assert.deepEqual(errors, []);
  });
}

// Redesign: replaced by the new window (the prototype's Voice page has no "Listening right now" line; /voice-listening.js is
// gone with the old window).
test.skip("DG-047 Listening right now says what the listeners report, never what a switch says", async (t) => {
  const { page, errors } = await settings(t, 1440);
  await page.evaluate(() => globalThis.branchLayout.go("settings:voice"));
  await page.locator("#voice-listening-now").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("voice-listening-now").textContent.length > 0);
  const words = await page.evaluate(async () => {
    const { listeningWords } = await import("/voice-listening.js");
    return {
      word: listeningWords({ listening: true, canListen: true, settings: { mode: "off", word: "Hey Branch" } }, { open: false }),
      dictation: listeningWords({ listening: false, canListen: true, settings: { mode: "on" } }, { open: true }),
      none: listeningWords({ listening: false, canListen: true, settings: { mode: "on", word: "x" } }, { open: false, canDictate: true }),
      unavailable: listeningWords({ listening: false, canListen: false }, { open: false, canDictate: false }),
      unknown: listeningWords(null, null),
    };
  });
  assert.deepEqual(words, {
    word: "Listening for your word right now: \"Hey Branch\".",
    dictation: "The microphone is open for dictation right now.",
    none: "Not listening right now.",
    unavailable: "This computer cannot listen: it has nothing that can hear a word or write out what you say.",
    unknown: "Branch could not tell whether anything is listening. It will look again in a moment.",
  });
  /* The line on the page is one of those, read from this computer's listeners, and nothing is listening in a test. */
  const shown = await page.locator("#voice-listening-now").innerText();
  assert.ok([words.none, words.unavailable].includes(shown), shown);
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype's Voice page has no wake word or dictation settings; kept-as-pressed
// is re-pointed above on Read replies aloud).
test.skip("DG-025 the word that starts a turn and dictation are kept as you go, with no Save button", async (t) => {
  const { page, errors, server } = await settings(t, 1440);
  await level(page, "technical");
  await page.evaluate(() => globalThis.branchLayout.go("settings:voice"));
  for (const form of ["#wake-word-form", "#dictation-form"]) assert.equal(await page.locator(`${form} button`).count(), 0, `${form} has no Save button`);
  const read = (path) => fetch(new URL(`/api/${path}`, server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((answer) => answer.json());
  await page.locator("#dictation-silence").fill("7");
  await page.locator("#dictation-silence").press("Tab");
  await page.locator("#dictation-state", { hasText: "Saved" }).waitFor();
  assert.equal((await read("voice/dictation")).settings.silenceSeconds, 7);
  await page.locator("#wake-word-sureness").fill("90");
  await page.locator("#wake-word-sureness").press("Tab");
  await page.locator("#wake-word-state", { hasText: "Saved" }).waitFor();
  assert.equal((await read("voice/wake")).settings.sureness, 90);
  assert.deepEqual(errors, []);
});
