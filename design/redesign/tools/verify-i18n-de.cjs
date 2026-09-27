/* i18n-de: Branch Agent in German. Proves, in the real window against a FRESH engine (onboarding not done), that Deutsch is
   a language a person can choose and that the window then truly speaks it:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
       (with BRANCH_PROVIDER and BRANCH_MODEL_PRESETS unset)
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-i18n-de.cjs
   1 Setup: a new browser with nothing saved opens setup; its Language lists Deutsch (named in its own words); picking it turns
     Welcome German, names the dialog in German, and saves "de" to the engine (GET /api/look) and to this browser. After a
     reload setup is still German and its Language still shows Deutsch.
   2 The window: a stand-in model (an OpenAI-shaped stub this script serves on 127.0.0.1:1234, added with
     POST /api/connections/from-preset, as verify-no-demo.cjs does) answers one message, so a real conversation is on screen.
     The conversation, every place (Overview, Inbox, Automations, Library, Team, Customize) and each of its tabs, and every
     Settings page are opened; on each, the words checked show in German, and no raw key (any key of en.json), no unfilled
     {word} and no English left over (a line that is exactly an English word whose German differs) shows anywhere a person
     reads or hears (text, aria-label, placeholder, title, data-tip). Times and numbers follow German (14:05, 1.234,5).
   3 Kept: after a reload, and in a new browser with nothing saved, the window is still German and Settings › Appearance ›
     Language shows Deutsch.
   4 Fit: on each of those surfaces, at 1440 and at 400 px wide, no button's text runs past its button (scrollWidth over
     clientWidth, on the button and on each box inside it). The same surfaces are measured in English as well; a German
     overflow is a failure, and any English one is listed so the two can be told apart.
   Page errors must be zero. The engine's language is left at "auto" at the end. */
const http = require("node:http");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright"); }
const { chromium } = playwright;

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const REPLY = "Hallo vom Stellvertreter-Modell.";
const WIDTHS = [1440, 400];
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const note = (text) => console.log(`NOTE  ${text}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function words(lang) { return (await fetch(`${BASE}/locales/${lang}.json`)).json(); }
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(250); } }

/* An OpenAI-shaped model on this computer: lists one model, and answers every chat with the same words (streamed or not). */
function stub() {
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] })); return; }
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
      const body = JSON.parse(raw || "{}");
      const usage = { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: REPLY } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage }));
      }
      return;
    }
    res.writeHead(404); res.end();
  });
  /* The catalog's LM Studio line is reached on its own address only (src/local-connection-policy.ts). Another check may be
     holding that port for a moment, so it is asked for again for up to a minute before the script gives up. */
  const listen = () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(1234, "127.0.0.1", () => resolve(server)); });
  return (async () => { for (let i = 0; ; i++) { try { return await listen(); } catch (error) { if (error.code !== "EADDRINUSE" || i >= 30) throw error; await wait(2000); } } })();
}

/* lang null: nothing is put in the browser's storage; the window's own choice (and the engine's) decide. */
async function open(browser, lang, W) {
  const context = await browser.newContext({ viewport: { width: WIDTHS[0], height: 900 }, serviceWorkers: "block" });
  if (lang) await context.addInitScript((l) => { try { localStorage.setItem("branch-language", l); } catch { /* checked below */ } }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel(W ? W["field.session-token"] : "Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: W ? W["action.connect"] : "Connect", exact: true }).click();
  return { context, page, errors };
}
const htmlLang = (page) => page.evaluate(() => document.documentElement.lang);
const saved = (page) => page.evaluate(() => { try { return localStorage.getItem("branch-language"); } catch { return "unreadable"; } });

/* Everything a person can read or hear on the page: its text and the words carried in attributes, one line each. */
const readable = (page) => page.evaluate(() => {
  const attrs = [...document.querySelectorAll("[aria-label],[placeholder],[title],[data-tip]")]
    .flatMap((n) => ["aria-label", "placeholder", "title", "data-tip"].map((a) => n.getAttribute(a)).filter(Boolean));
  return [document.body.innerText, ...attrs].join("\n").split("\n").map((s) => s.trim()).filter(Boolean);
});

let E = {}, D = {}, englishOnly = new Map(), germanWords = new Set(), keys = new Set();
function learn(en, de) {
  E = en; D = de; keys = new Set(Object.keys(en));
  germanWords = new Set(Object.values(de).map((v) => v.trim()));
  // An English line counts as left over only when every key it belongs to has different German words.
  const byValue = new Map();
  for (const [key, value] of Object.entries(en)) { const v = value.trim(); if (!byValue.has(v)) byValue.set(v, []); byValue.get(v).push(key); }
  for (const [value, owners] of byValue) if (/[A-Za-z]{3}/.test(value) && owners.every((k) => de[k].trim() !== value)) englishOnly.set(value, owners[0]);
}

/* One surface in German: the words asked for show, and nothing raw, unfilled or left in English does. */
async function german(page, name, wanted = []) {
  const lines = await readable(page);
  const seen = lines.join("\n").toLocaleLowerCase("de");
  for (const key of wanted) check(`${name}: "${D[key]}" shows`, typeof D[key] === "string" && seen.includes(D[key].toLocaleLowerCase("de")), key);
  const raw = lines.filter((s) => keys.has(s) || /\bwindow\.[a-z0-9-]+\.[\w.-]+/.test(s));
  const unfilled = lines.filter((s) => /\{[A-Za-z]\w*\}/.test(s));
  const english = [...new Set(lines.filter((s) => englishOnly.has(s) && !germanWords.has(s)))];
  check(`${name}: no raw key`, raw.length === 0, raw.slice(0, 5).join(", "));
  check(`${name}: no unfilled {word}`, unfilled.length === 0, unfilled.slice(0, 3).join(" | "));
  check(`${name}: no English left over`, english.length === 0, english.slice(0, 6).map((s) => `${s} [${englishOnly.get(s)}]`).join(", "));
  if (english.length) for (const where of await whereIs(page, english.slice(0, 6))) note(`${name}: ${where}`);
}
/* Where a left-over line is drawn, so a failure names the part of the window to fix. */
const whereIs = (page, lines) => page.evaluate((want) => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    const attr = ["aria-label", "title", "placeholder", "data-tip"].find((a) => want.includes(el.getAttribute(a)));
    if (want.includes(own) || attr) out.push(`"${attr ? el.getAttribute(attr) : own}" in ${el.closest("[id],[class]")?.outerHTML.slice(0, 160) ?? el.tagName}`);
  }
  return out.slice(0, 8);
}, lines);

/* Buttons whose words run past them: the button, or a box inside it, holds more than it shows. */
/* A box that ends its words with "…" on purpose (a conversation's title, a file's name) is cut by design; it counts only when
   what it cuts is one of the window's own labels, which must fit whole. */
const overflowing = (page, labels) => page.evaluate((fixed) => {
  const own = new Set(fixed);
  const path = (el) => { const parts = []; for (let n = el; n && n !== document.body; n = n.parentElement) parts.unshift(`${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}:${[...(n.parentElement?.children ?? [])].indexOf(n)}`); return parts.join(">"); };
  const spills = (e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && e.innerText.trim()
    && (getComputedStyle(e).textOverflow !== "ellipsis" || own.has(e.innerText.trim()));
  const out = [];
  for (const b of document.querySelectorAll('button, [role="button"], [role="tab"], a.btn')) {
    const box = b.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(b).visibility === "hidden") continue;
    const text = b.innerText.trim().replace(/\s+/g, " ");
    if (!text) continue;
    const bad = [b, ...b.querySelectorAll("*")].find(spills);
    if (bad) out.push({ id: path(b), text: text.slice(0, 50), by: bad.scrollWidth - bad.clientWidth });
  }
  return out;
}, labels);
/* Measured at each width, then put back to the wide window the tour moves through. */
async function measure(page, name, fits, labels = Object.values(D)) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    for (const one of await overflowing(page, labels)) fits.push({ surface: name, width, ...one });
  }
  await page.setViewportSize({ width: WIDTHS[0], height: 900 });
  await page.waitForTimeout(150);
}

async function closeSetup(page) {
  const setup = page.locator(".ob9[role=dialog]");
  await setup.waitFor({ timeout: 15000 }).catch(() => null);
  if (await setup.isVisible().catch(() => false)) await page.locator('[data-act="ob-close"]').first().click();
  await page.locator("#prompt").waitFor({ timeout: 30000 });
}
async function dismissWelcome(page) {
  await page.evaluate(() => { try { localStorage.setItem("branch-welcomed", "1"); } catch { /* checked by the clicks that follow */ } });
  await page.waitForTimeout(1500);
  if (await page.locator('[data-act="welcome-x"]').isVisible().catch(() => false)) await page.locator('[data-act="welcome-x"]').click();
}
async function openSettings(page) {
  if (await page.locator(".settings").isVisible().catch(() => false)) return;
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor({ timeout: 10000 });
}
async function leaveSettings(page) {
  for (let i = 0; i < 3 && await page.locator(".settings").isVisible().catch(() => false); i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
}
const langShown = (page) => page.locator("#lang").evaluate((s) => ({ value: s.value, text: s.selectedOptions[0]?.textContent ?? "" }));

/* Every surface the tour opens, in the same order in either language: the conversation, each place and each of its tabs,
   and each Settings page. `each(name)` is called with the surface on screen. */
async function tour(page, sessionId, each) {
  await page.locator(`[data-act="chat"][data-id="${sessionId}"]`).first().click();
  await page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  await each("conversation");
  const places = await page.locator('#side [data-act="view"][data-v]').evaluateAll((bs) => [...new Set(bs.map((b) => b.dataset.v).filter((v) => v !== "settings"))]);
  for (const place of places) {
    await page.locator(`#side [data-act="view"][data-v="${place}"]`).first().click();
    await page.waitForTimeout(700);
    await each(`place ${place}`);
    const tabs = await page.locator(`[data-act="ptab"][data-place="${place}"]`).evaluateAll((bs) => [...new Set(bs.map((b) => b.dataset.v))]);
    for (const tab of tabs.slice(1)) {
      const button = page.locator(`.tabs [data-act="ptab"][data-place="${place}"][data-v="${tab}"]`).first();
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click();
      await page.waitForTimeout(700);
      await each(`place ${place} › ${tab}`);
    }
  }
  await openSettings(page);
  const pages = await page.locator('.settings [data-act="setpage"][data-v]').evaluateAll((bs) => [...new Set(bs.map((b) => b.dataset.v))]);
  for (const id of pages) {
    await openSettings(page);
    await page.locator(`.settings [data-act="setpage"][data-v="${id}"]`).first().click();
    await page.waitForTimeout(700);
    await each(`settings ${id}`);
  }
  await leaveSettings(page);
  return { places, pages };
}

/* 1: setup, on a fresh engine with nothing saved in the browser. */
async function setup(browser, fits) {
  const { context, page, errors } = await open(browser, null);
  const dialog = page.locator(".ob9[role=dialog]");
  await dialog.waitFor({ timeout: 30000 });
  check("1 the engine says onboarding is not done", (await api("state")).onboarding?.done !== true);
  const options = await page.locator("#ob-lang option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent, off: o.disabled })));
  check("1 setup's Language lists Deutsch, named in its own words", options.some((o) => o.v === "de" && o.t === "Deutsch" && !o.off), options.map((o) => o.t).join("|"));
  await page.locator("#ob-lang").selectOption("de");
  await page.waitForFunction(() => document.documentElement.lang === "de", null, { timeout: 15000 });
  await page.locator(".ob9 h2").filter({ hasText: D["window.flows.first.hi"] }).waitFor({ timeout: 10000 });
  check(`1 Welcome says "${D["window.flows.first.hi"]}"`, (await page.locator(".ob9 h2").first().textContent())?.trim() === D["window.flows.first.hi"]);
  check(`1 the dialog is named "${D["window.setup.label"]}"`, (await dialog.getAttribute("aria-label")) === D["window.setup.label"]);
  check("1 the engine keeps it (GET /api/look language = de)", (await api("look")).language === "de");
  check("1 this browser keeps it (localStorage)", (await saved(page)) === "de");
  await german(page, "1 setup", ["window.flows.setup.safe", "window.flows.setup.understand", "appearance.language"]);
  await measure(page, "setup", fits);

  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === "de", null, { timeout: 30000 });
  await dialog.waitFor({ timeout: 30000 });
  await page.locator(".ob9 h2").filter({ hasText: D["window.flows.first.hi"] }).waitFor({ timeout: 10000 });
  const again = await page.locator("#ob-lang").evaluate((s) => ({ value: s.value, text: s.selectedOptions[0]?.textContent ?? "" }));
  check("1 after a reload setup is still German, and its Language shows Deutsch", again.value === "de" && again.text === "Deutsch", JSON.stringify(again));
  check("1 setup: zero page errors", errors.length === 0, errors.join(" | "));
  await context.close();
}

/* 2 and 3: a real conversation, then every place and Settings page in German; then a reload and a new browser. */
async function window_(browser, fits) {
  const added = await api("connections/from-preset", { provider: "lm-studio", key: "stub-key", model: "stub-model", name: "Stellvertreter" });
  const { context, page, errors } = await open(browser, null);
  await page.waitForFunction(() => document.documentElement.lang === "de", null, { timeout: 30000 });
  await closeSetup(page);
  await dismissWelcome(page);
  if (await page.locator('[data-act="newconv"]').count()) await page.locator('[data-act="newconv"]').first().click();
  await page.locator("#prompt").fill("Hallo, sag etwas.");
  await page.locator("#send").click();
  const run = await until(async () => (await api("state")).runs.find((r) => r.prompt === "Hallo, sag etwas." && r.status !== "running" && r.status !== "queued"), 30000);
  check("2 the stand-in answered (GET /api/state runs: completed)", run?.status === "completed" && run.output.includes(REPLY), `${run?.status}`);
  check("2 the answer shows in the conversation", !!(await until(async () => (await page.locator("#conversation").innerText()).includes(REPLY), 8000)));

  const time = (await page.locator("#side time").first().textContent().catch(() => ""))?.trim();
  check("2 the conversation list's time is written the German way (14:05, no AM/PM)", /^\d{1,2}:\d{2}$/.test(time ?? ""), time);
  const number = await page.evaluate(async () => (await import("/i18n.js")).formatNumber(1234.5));
  check("2 numbers are written the German way (1.234,5)", number === "1.234,5", number);
  const nav = await page.locator('#side [data-act="view"][data-v="inbox"]').first().innerText();
  check("2 the side list names Inbox \"Posteingang\"", /Posteingang/.test(nav), nav.trim());

  const wanted = {
    conversation: ["window.chat.composer.message", "window.chat.head.find", "window.chat.composer.plus", "window.chat.head.more"],
    "place inbox": ["dashboard.needs.title", "place.inbox.finished", "place.inbox.history", "window.places.inbox.later"],
  };
  const seen = await tour(page, run?.sessionId, async (name) => {
    await german(page, `2 ${name}`, wanted[name] ?? []);
    await measure(page, name, fits.de);
  });
  check("2 the tour opened every place", ["inbox", "library"].every((p) => seen.places.includes(p)), seen.places.join(","));
  check("2 the tour opened the Settings pages", seen.pages.length >= 5 && seen.pages.includes("appearance"), `${seen.pages.length}: ${seen.pages.join(",")}`);
  await openSettings(page);
  await page.locator('.settings [data-act="setpage"][data-v="appearance"]').first().click();
  await page.locator("#lang").waitFor();
  let shown = await langShown(page);
  check("2 Settings › Appearance › Language shows Deutsch", shown.value === "de" && shown.text === "Deutsch", JSON.stringify(shown));
  await leaveSettings(page);

  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === "de", null, { timeout: 30000 });
  await page.locator("#prompt").waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await german(page, "3 after a reload", ["window.chat.composer.message"]);
  check("3 after a reload the side list is still German", /Posteingang/.test(await page.locator('#side [data-act="view"][data-v="inbox"]').first().innerText()));
  check("2-3 zero page errors", errors.length === 0, errors.join(" | "));
  await context.close();

  const fresh = await open(browser, null);
  await fresh.page.waitForFunction(() => document.documentElement.lang === "de", null, { timeout: 30000 }).catch(() => null);
  await fresh.page.locator("#prompt").waitFor({ timeout: 30000 });
  await openSettings(fresh.page);
  await fresh.page.locator('.settings [data-act="setpage"][data-v="appearance"]').first().click();
  await fresh.page.locator("#lang").waitFor();
  shown = await langShown(fresh.page);
  check("3 a new browser with nothing saved is German from the engine, and shows Deutsch", (await htmlLang(fresh.page)) === "de" && shown.value === "de" && shown.text === "Deutsch", JSON.stringify(shown));
  await german(fresh.page, "3 new browser › Appearance");
  check("3 new browser: zero page errors", fresh.errors.length === 0, fresh.errors.join(" | "));
  await fresh.context.close();
  return { presetId: added.id, sessionId: run?.sessionId };
}

/* 4 (English half): the same surfaces measured in English, so an overflow English already has can be told from a German one. */
async function english(browser, sessionId, fits) {
  await api("look", { language: "en" });
  const { context, page, errors } = await open(browser, null);
  await page.waitForFunction(() => document.documentElement.lang === "en", null, { timeout: 30000 });
  await page.locator("#prompt").waitFor({ timeout: 30000 });
  await dismissWelcome(page);
  await tour(page, sessionId, (name) => measure(page, name, fits, Object.values(E)));
  check("4 English pass: zero page errors", errors.length === 0, errors.join(" | "));
  await context.close();
}

function fitReport(fits) {
  const key = (f) => `${f.surface}|${f.width}|${f.id}`;
  const inEnglish = new Set(fits.en.map(key));
  for (const width of WIDTHS) {
    const de = fits.de.filter((f) => f.width === width), en = fits.en.filter((f) => f.width === width);
    const worse = de.filter((f) => !inEnglish.has(key(f)));
    check(`4 at ${width} px no German button's text overflows (${de.length} German, ${en.length} English)`, de.length === 0,
      de.slice(0, 40).map((f) => `${f.surface}: "${f.text}" +${f.by}px${inEnglish.has(key(f)) ? " (English too)" : ""}`).join(" | "));
    if (worse.length) note(`${worse.length} at ${width} px overflow in German only`);
    for (const f of en) note(`English overflow at ${width} px, ${f.surface}: "${f.text}" +${f.by}px`);
  }
  for (const f of fits.setup) check(`4 setup at ${f.width} px: "${f.text}" fits`, false, `+${f.by}px`);
  if (!fits.setup.length) check("4 setup: no button's text overflows at 1440 or 400 px", true);
}

(async () => {
  const [en, de] = await Promise.all([words("en"), words("de")]);
  learn(en, de);
  check("de.json answers exactly the keys of en.json, in order", JSON.stringify(Object.keys(de)) === JSON.stringify(Object.keys(en)), `${Object.keys(de).length} of ${Object.keys(en).length}`);
  await api("look", { language: "auto" });
  const server = await stub();
  const browser = await chromium.launch({ headless: true });
  const fits = { setup: [], de: [], en: [] };
  let presetId = null;
  try {
    await setup(browser, fits.setup);
    const made = await window_(browser, fits);
    presetId = made.presetId;
    await english(browser, made.sessionId, fits.en);
    fitReport(fits);
  } catch (error) {
    check("the run finished", false, error.stack?.split("\n").slice(0, 3).join(" / ") ?? String(error));
  } finally {
    await browser.close();
    server.close();
    await api("look", { language: "auto" }).catch(() => null);
    if (presetId) await api("connections/forget", { id: presetId }).catch(() => null);
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
