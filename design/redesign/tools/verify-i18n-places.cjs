/* rw4-i18n-places: the words drawn by public/app/places, settings, shell, core and mac go through t() (or say() for a
   table's English, core/words.js), so French shows everywhere they draw. Proves it in the real window against your engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-i18n-places.cjs
   Two passes, English then French (the saved choice public/i18n.js reads, localStorage "branch-language"; the engine's own
   language is put back to "auto" first so it does not override it, and left at "auto" at the end). Each pass opens the side
   list, Overview, Inbox, Library, Automations, Customize and six Settings pages, and reads every word on screen: text,
   aria-label, placeholder, title and data-tip.
   English: each of the 25 strings below is on screen (so the French check below cannot pass by showing nothing).
   French: none of the 25 is on screen, each one's French from fr.json is, and <html lang> is fr.
   Both: no raw key (any key these folders look up, or "window.…"), and zero page errors. Before any window opens, every key
   the five folders look up has English and French in the locale files, and every translated toast's English is the
   prototype's own words (check-fakes' rule for a literal toast). */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

/* [key, where it shows]. The key is the one the window looks up (say() finds it by its English). */
const STRINGS = [
  ["window.shell.shell.search-chats-trunks-messages-and-past", "side list: search box label"],
  ["window.shell.shell.who-is-using-branch-look-lock", "side list: person button tip"],
  ["window.shell.shell.which-computer-youre-talking-to", "side list: computer button tip"],
  ["window.shell.shell.what-is-running-in-the-background", "status bar: tasks tip"],
  ["window.places.overview.whats-happening-across-your-trunks-at", "Overview: lede"],
  ["ov.now.none", "Overview: Now tile (an existing key, reused)"],
  ["window.places.overview.spend-this-week", "Overview: spend tile"],
  ["window.places.inbox.everything-a-trunk-is-waiting-on", "Inbox: lede"],
  ["window.places.library.what-your-trunks-remember-the-documents", "Library: lede"],
  ["window.places.library.trunks-suggest-what-to-remember-and", "Library › Memory"],
  ["window.places.automations.work-your-trunks-do-on-their", "Automations: lede"],
  ["window.places.automations.receipts-into-folders", "Automations › Ideas (a table read through say())"],
  ["window.places.automations.work-a-trunk-does-on-a", "Automations › Scheduled"],
  ["window.places.customize.who-your-trunks-are-what-they", "Customize: lede"],
  ["window.places.customize.use-this-job", "Customize › Trunks: job cards"],
  ["settings.page.instructions", "Settings: page list (NAV through say(), an existing key)"],
  ["window.settings.general.how-branch-starts-and-behaves-on", "Settings › General: lede"],
  ["window.settings.general.keep-working-when-the-window-closes", "Settings › General: switch"],
  ["window.settings.appearance.how-branch-looks-on-this-computer", "Settings › Appearance: lede"],
  ["onscreen.usage", "Settings › Appearance › What’s shown (say() finding an existing key)"],
  ["window.settings.permissions.what-trunks-may-do-without-asking", "Settings › Permissions: lede"],
  ["window.settings.permissions.read-files-in-documents-and-downloads", "Settings › Permissions: switch"],
  ["window.settings.notifications.when-branch-may-interrupt-you", "Settings › Notifications: lede"],
  ["window.settings.models.which-models-answer-and-where-they", "Settings › Models: lede"],
  ["window.settings.usage.what-each-connection-has-left-what", "Settings › Data & usage: lede"],
];
const SETTINGS_PAGES = ["general", "appearance", "permissions", "notifications", "models", "usage"];
const PLACES = ["overview", "inbox", "library", "automations", "customize"];

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const locale = async (lang) => (await fetch(`${BASE}/locales/${lang}.json`)).json();

/* Every key the five folders look up with t("…"). */
function keysUsed() {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
  for (const a of ["places", "settings", "shell", "core", "mac"]) walk(path.join("public/app", a));
  const keys = new Set(), toasts = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([\w.-]+)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/toast\(\(?(?:[^()]*\?\s*)?t\("([\w.-]+)"/g)) toasts.add(m[1]);
  }
  return { keys, toasts };
}

/* Everything a person can read or hear in the window right now. */
const screenWords = (page) => page.evaluate(() => {
  const parts = [document.body.innerText];
  for (const el of document.querySelectorAll("[aria-label],[placeholder],[title],[data-tip]")) {
    if (el.closest("[hidden]")) continue;
    for (const a of ["aria-label", "placeholder", "title", "data-tip"]) { const v = el.getAttribute(a); if (v) parts.push(v); }
  }
  return parts.join("\n");
});

async function open(browser, lang, fr) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript((l) => { try { localStorage.setItem("branch-language", l); } catch { /* the lang check below fails instead */ } }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  // The sign-in form is drawn in the saved language too.
  await page.getByLabel(lang === "fr" ? fr["field.session-token"] : "Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: lang === "fr" ? fr["action.connect"] : "Connect", exact: true }).click();
  const setup = page.locator(".ob9[role=dialog]");
  await setup.waitFor({ timeout: 30000 }).catch(() => null);
  if (await setup.isVisible().catch(() => false)) await page.locator('[data-act="ob-close"]').first().click();
  await page.locator("#side").waitFor({ timeout: 30000 });
  return { context, page, errors };
}

async function readAll(page) {
  let words = await screenWords(page); // the side list and status bar, with a conversation open
  for (const place of PLACES) {
    await page.locator(`#side [data-act="view"][data-v="${place}"]`).first().click();
    await page.waitForTimeout(600);
    words += "\n" + await screenWords(page);
  }
  // Library › Memory and Automations › Scheduled are the tabs these places open on; Customize › Trunks too.
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  words += "\n" + await screenWords(page);
  for (const id of SETTINGS_PAGES) {
    await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
    await page.waitForTimeout(600);
    words += "\n" + await screenWords(page);
  }
  return words;
}

function rawKeys(words, keys) {
  const found = new Set(words.match(/\bwindow\.[a-z0-9-]+\.[a-z0-9.-]+/g) ?? []);
  for (const k of keys) if (new RegExp(`(^|[^\\w.-])${k.replace(/[.]/g, "\\.")}($|[^\\w.-])`).test(words)) found.add(k);
  return [...found];
}

(async () => {
  const [en, fr] = await Promise.all([locale("en"), locale("fr")]);
  const { keys, toasts } = keysUsed();
  const noEnglish = [...keys].filter((k) => typeof en[k] !== "string");
  const noFrench = [...keys].filter((k) => typeof fr[k] !== "string");
  check(`all ${keys.size} keys the five folders look up have English`, noEnglish.length === 0, noEnglish.slice(0, 5).join(", "));
  check(`all ${keys.size} keys the five folders look up have French`, noFrench.length === 0, noFrench.slice(0, 5).join(", "));
  const proto = fs.readFileSync("design/redesign/prototype.html", "utf8").replaceAll("’", "'");
  const offProto = [...toasts].filter((k) => String(en[k] ?? "").replaceAll("’", "'").split(/\{[\w.-]+\}/).map((s) => s.trim()).filter((s) => s.length > 2).some((s) => !proto.includes(s)));
  // Two were templates before this change (their words were never literal toast text), and keep their words exactly.
  const known = new Set(["window.places.library17.forgot-value-facts-the-conversation-itself", "window.shell.usage.asked-one-running-task"]);
  check(`translated toasts (${toasts.size}) say the prototype's words`, offProto.every((k) => known.has(k)), offProto.filter((k) => !known.has(k)).join(", "));
  const missing = STRINGS.filter(([k]) => typeof en[k] !== "string" || typeof fr[k] !== "string" || fr[k] === en[k]);
  check("the 25 strings have English and a different French", STRINGS.length === 25 && missing.length === 0, missing.map(([k]) => k).join(", "));

  await api("look", { language: "auto" }); // the engine's choice would override the saved one
  const browser = await chromium.launch({ headless: true });
  try {
    for (const lang of ["en", "fr"]) {
      const { context, page, errors } = await open(browser, lang, fr);
      check(`${lang}: <html lang> is ${lang}`, (await page.evaluate(() => document.documentElement.lang)) === lang);
      const words = await readAll(page);
      for (const [k, where] of STRINGS) {
        if (lang === "en") check(`en: "${en[k]}" shows (${where})`, words.includes(en[k]));
        else check(`fr: "${en[k]}" is gone and "${fr[k]}" shows (${where})`, !words.includes(en[k]) && words.includes(fr[k]));
      }
      const raw = rawKeys(words, keys);
      check(`${lang}: no raw key on screen`, raw.length === 0, raw.slice(0, 5).join(", "));
      check(`${lang}: zero page errors`, errors.length === 0, errors.join(" | "));
      await context.close();
    }
  } finally {
    await browser.close();
    await api("look", { language: "auto" }).catch((error) => console.error(error.message));
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
