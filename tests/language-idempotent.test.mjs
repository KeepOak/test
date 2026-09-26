import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/*
 * Choosing the language that is already in force must do nothing.
 *
 * `applyLanguage` skips text and attributes that already say the right thing, so reading it suggests
 * this was already true. It was not: `setLanguage` announced the change regardless, and the listeners
 * that answer that announcement rebuild whole cards. Measured before the fix, on a page where nothing
 * had changed: **2504 mutations** for choosing French while French was already showing.
 *
 * It matters because those listeners throw away and rebuild controls the person may be using -- the
 * kind-of-tool dropdowns, an open explanation, a focused field -- so a no-op change was not a no-op.
 */
async function openApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-lang-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  /* The app's service worker answers its own locale files, where a test's held response cannot reach —
     the same reason tests/settings-info.test.mjs blocks it. */
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return page;
}

/**
 * What choosing `language` costs the page: mutations, and how many times a change was announced.
 *
 * Deliberately no `new Function` here — the page forbids evaluating strings (`script-src 'self'`), and
 * a harness that trips over that fails identically to the bug being measured. It cost me one wrong
 * "red for the right reason" before I read the error.
 */
const costOf = (page, language) => page.evaluate(async (chosen) => {
  /* `chosen` of null measures the page on its own: it has clocks and pollers, so "no mutations at all"
     is not a thing that can be asserted here. The question is whether choosing the language already in
     force costs more than standing still does. */
  const i18n = await import("/i18n.js");
  let writes = 0, announced = 0;
  const heard = () => { announced += 1; };
  document.addEventListener("branch-language", heard);
  const watch = new MutationObserver((records) => { writes += records.length; });
  watch.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  if (chosen) await i18n.setLanguage(chosen);
  await new Promise((resolve) => setTimeout(resolve, 150));
  watch.disconnect();
  document.removeEventListener("branch-language", heard);
  return { writes, announced };
}, language);

test("choosing the language already in force changes nothing and tells nobody", async (t) => {
  const page = await openApp(t);
  // A real change is expected to cost something: that is the control for the measurement below.
  const real = await costOf(page, "fr");
  assert.ok(real.writes > 0, "changing the language really does rewrite the page");
  assert.equal(real.announced, 1, "and says so exactly once");

  const idle = await costOf(page, null);
  const again = await costOf(page, "fr");
  assert.equal(again.announced, 0, "choosing French while French is showing announced a change anyway");
  assert.ok(again.writes <= idle.writes + 2,
    `choosing French while French is showing cost ${again.writes} mutations against ${idle.writes} for standing still`);
  assert.ok(real.writes > idle.writes * 4,
    `a real change (${real.writes}) must be plainly more than the page's own churn (${idle.writes})`);

  // And going back is still a real change, so the guard has not simply frozen the page.
  const back = await costOf(page, "en");
  assert.ok(back.writes > 0, "going back to English still works");
  assert.equal(back.announced, 1);
});

test("the first application still happens, even though it changes nothing visible", async (t) => {
  const page = await openApp(t);
  /* The trap in the obvious fix: initLanguage calls setLanguage("en") at startup while `current` is
     already "en", so a guard that only compares languages would skip the very first application and
     leave every marked node showing whatever the HTML shipped with. */
  /* Redesign: the new window writes its words with t() as it draws, so the page carries almost no marked nodes of its
     own (public/index.html has one). The marked strings i18n.js still writes are planted here: real keys, the way
     markup shipped with them would carry them. */
  const applied = await page.evaluate(async () => {
    const i18n = await import("/i18n.js");
    const keys = ["rail.new", "nav.documents", "place.library", "settings.search", "comfort.keys.title", "more.label",
      "window.shell.celebrate.nice", "window.chat.msg.room-left", "accounts.switch.on", "accounts.switch.off", "studio.newName"];
    const box = document.createElement("div");
    box.hidden = true;
    box.innerHTML = keys.map((key) => `<span data-t="${key}"></span>`).join("");
    document.body.append(box);
    document.querySelectorAll("[data-t]").forEach((node) => { node.textContent = "not applied"; });
    await i18n.initLanguage();
    const marked = [...document.querySelectorAll("[data-t]")];
    return { total: marked.length, stillUnapplied: marked.filter((n) => n.textContent === "not applied").length };
  });
  assert.ok(applied.total > 10, "there are marked nodes to apply");
  assert.equal(applied.stillUnapplied, 0, "startup left marked text unapplied");
});

/*
 * A language whose words never arrived is not a language that has been applied.
 *
 * The "already in force" guard above would otherwise remember a failed attempt as a success: one bad
 * response for `fr.json` and every later attempt returns immediately on an empty dictionary, leaving a
 * French speaker on English words with no way to retry short of a reload. The guard therefore only
 * remembers a language whose words actually came.
 */
test("a language whose words failed to load is tried again, not remembered as done", async (t) => {
  const page = await openApp(t);
  let refusals = 0;
  await page.route("**/locales/fr.json", async (route) => {
    if (refusals === 0) { refusals += 1; await route.fulfill({ status: 503, body: "no" }); return; }
    await route.continue();
  });

  const first = await page.evaluate(async () => {
    const i18n = await import("/i18n.js");
    // Redesign: the new window has no rail.new marked node of its own, so one is planted, carrying its English.
    const marked = document.createElement("span");
    marked.hidden = true;
    marked.dataset.t = "rail.new";
    marked.textContent = i18n.t("rail.new");
    document.body.append(marked);
    await i18n.setLanguage("fr");
    return { language: i18n.language(), sample: document.querySelector('[data-t="rail.new"]')?.textContent };
  });
  assert.equal(refusals, 1, "the first attempt really was refused");
  assert.equal(first.language, "fr", "it believes it is French");
  assert.match(first.sample ?? "", /New conversation/, "but the words are still English, because none arrived");

  const second = await page.evaluate(async () => {
    const i18n = await import("/i18n.js");
    await i18n.setLanguage("fr");
    return document.querySelector('[data-t="rail.new"]')?.textContent;
  });
  assert.match(second ?? "", /Nouvelle conversation/, "asking again gave up instead of fetching the words");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
});
