/* i18n-es: Branch Agent in Spanish, proved in the real window against a FRESH engine (onboarding not done):
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-i18n-es.cjs
   A new browser with nothing saved opens setup; its Language control lists Español (i18n.js LANGUAGES, named by the
   browser in its own words). Picking it turns Welcome Spanish, and the engine keeps it (GET /api/look language = es, the
   route's enum now takes es) as does this browser (localStorage "branch-language"). Then a new conversation, Inbox (Needs
   you, Finished, History), Library (Memory, Documents, Made for you) and four Settings pages (Appearance, Models,
   Permissions, General) are each checked: named words show in Spanish, no English sentence from en.json that es.json
   words differently is on screen, no raw key and no unfilled {word} shows. Dates and numbers follow Spanish
   (i18n.js formatDate/formatNumber, which the schedule card and the rest of the window use). After a reload it is
   still Spanish: <html lang>, the conversation's words and Settings › Appearance › Language showing Español.
   i18n-es-achievements: what the engine names in English is drawn in Spanish too. Overview's health tile names each check
   (GET /api/health) and the owner's role (GET /api/profiles) in Spanish; Settings › On this computer describes every model
   offered in Spanish (GET /api/local-models summary.es) with a Spanish fit verdict; and Settings › Achievements shows all
   505 as the engine words them when asked in Spanish (GET /api/delight/achievements?lang=es, the same ids and tiers as in
   English), with Spanish kinds and tiers and no English name or sentence on the page.
   Page errors must be zero. The engine's language is put back to "auto" at the end. Nothing else is changed. */
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function words(lang) { return (await fetch(`${BASE}/locales/${lang}.json`)).json(); }

/* Words each surface draws (keys the code looks up); each must show in Spanish. */
const SURFACES = {
  setup: ["window.flows.first.hi", "window.flows.setup.safe", "window.flows.setup.safe-asks", "window.flows.setup.understand"],
  conversation: ["window.chat.empty.title", "window.chat.empty.downloads", "window.chat.empty.pdfs", "window.chat.empty.week"],
  inbox: ["place.inbox", "place.inbox.needs", "place.inbox.finished", "place.inbox.history"],
  library: ["place.library", "place.library.memory", "place.library.documents", "place.library.made"],
  appearance: ["settings.page.appearance", "window.settings.appearance.light-or-dark", "appearance.language", "window.settings.appearance.dates-and-numbers-follow-it-too"],
  models: ["settings.page.models"],
  permissions: ["settings.page.permissions"],
  general: ["window.settings.general.how-branch-starts-and-behaves-on", "window.settings.general.starting-up"],
  achievements: ["delight.ach.title", "window.settings.achievements.keep-achievements-quiet"],
};

/* Everything a person can read or hear on the page: its text and the words carried in attributes. */
const onPage = (page) => page.evaluate(() => {
  const attrs = [...document.querySelectorAll("[aria-label],[placeholder],[title],[data-tip]")]
    .flatMap((n) => ["aria-label", "placeholder", "title", "data-tip"].map((a) => n.getAttribute(a)).filter(Boolean));
  return [document.body.innerText, ...attrs].join("\n");
});

/* English sentences that Spanish words differently: long enough (three words or more) that finding one on the page
   means a word went untranslated, not that a name or a code happens to match. */
function englishOnly(E, S) {
  return Object.keys(E).filter((k) => typeof S[k] === "string" && S[k] !== E[k] && !/\{/.test(E[k]) && E[k].trim().split(/\s+/).length >= 3).map((k) => [k, E[k]]);
}

async function surface(page, name, S, E, leaks) {
  const text = await onPage(page);
  const seen = text.toLocaleLowerCase("es");
  for (const key of SURFACES[name]) {
    const want = S[key];
    check(`es · ${name}: "${want}" shows`, typeof want === "string" && seen.includes(want.toLocaleLowerCase("es")), key);
  }
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  /* A short phrase counts only as a whole line, label or tip of its own; a long sentence counts anywhere. So the engine's
     own sentences (a refusal such as dictation's "…Turn it on in Settings, Voice.", which the window shows in the engine's
     words in every language) do not pass for an untranslated button that happens to read "Turn it on". */
  const whole = new Set(lines.map((s) => s.toLocaleLowerCase("en")));
  const english = leaks.filter(([, words]) => {
    const w = words.toLocaleLowerCase("en");
    return whole.has(w) || (w.split(/\s+/).length >= 6 && seen.includes(w));
  })
    .map(([k, words]) => `${k} in "${(lines.find((s) => s.toLocaleLowerCase("en").includes(words.toLocaleLowerCase("en"))) ?? "").slice(0, 90)}"`);
  check(`es · ${name}: no English sentence from en.json that Spanish words differently`, english.length === 0, english.slice(0, 6).join(", "));
  const keys = new Set(Object.keys(E));
  const raw = lines.filter((s) => keys.has(s) || /\b(window|place|settings|appearance)\.[a-z][\w-]*\.[\w.-]+/.test(s));
  check(`es · ${name}: no raw key on the page`, raw.length === 0, raw.slice(0, 5).join(", "));
  const unfilled = lines.filter((s) => /\{[A-Za-z]\w*\}/.test(s));
  check(`es · ${name}: no unfilled {word} on the page`, unfilled.length === 0, unfilled.slice(0, 3).join(" | "));
}

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}
async function closeSetup(page) {
  const setup = page.locator(".ob9[role=dialog]");
  await setup.waitFor({ timeout: 30000 }).catch(() => null);
  if (await setup.isVisible()) await page.locator('[data-act="ob-close"]').first().click();
  await page.locator("#prompt").waitFor({ timeout: 30000 });
}
/* Closing setup brings the "New to Branch?" card a moment later (flows/first.js); dismiss it so it covers nothing. */
async function dismissWelcome(page) {
  await page.evaluate(() => { try { localStorage.setItem("branch-welcomed", "1"); } catch { /* checked by the clicks that follow */ } });
  await page.waitForTimeout(1500);
  if (await page.locator('[data-act="welcome-x"]').isVisible().catch(() => false)) await page.locator('[data-act="welcome-x"]').click();
}
async function place(page, view, tabs, name, S, E, leaks) {
  await page.locator(`#side [data-act="view"][data-v="${view}"]`).first().click();
  await page.locator(`[data-act="ptab"][data-place="${view}"]`).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await surface(page, name, S, E, leaks);
  for (const tab of tabs) {
    await page.locator(`[data-act="ptab"][data-place="${view}"][data-v="${tab}"]`).first().click();
    await page.waitForTimeout(600);
    await surface(page, name, S, E, leaks);
  }
}
async function settingsPage(page, v, name, S, E, leaks) {
  await page.locator(`[data-act="setpage"][data-v="${v}"]`).first().click();
  await page.waitForTimeout(700);
  await surface(page, name, S, E, leaks);
}
const shown = (page) => page.locator("#lang").evaluate((s) => ({ value: s.value, text: s.selectedOptions[0]?.textContent ?? "" }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(250); } }
/* The Spanish for an English line the engine gives, as the window finds it (public/i18n.js fromEnglish: the first key
   whose English is exactly those words). */
const spanishOf = (E, S) => { const by = new Map(); for (const [k, v] of Object.entries(E)) if (!by.has(v)) by.set(v, S[k]); return (english) => by.get(english); };
const lines = async (page) => (await onPage(page)).split("\n").map((s) => s.trim()).filter(Boolean);

/* i18n-es-achievements: labels the engine names in English, drawn in Spanish. Overview's health tile (GET /api/health item
   names) and the owner's role name (GET /api/profiles roleLabels, household.role.*). */
async function overviewWords(page, S, E) {
  const health = (await api("health")).items ?? [], es = spanishOf(E, S);
  await page.locator('#side [data-act="view"][data-v="overview"]').first().click();
  const got = await until(async () => { const l = await lines(page); return health.every((i) => l.includes(es(i.name))) ? l : null; });
  const seen = got ?? await lines(page);
  for (const item of health) {
    const want = es(item.name);
    check(`es · overview health: "${item.name}" (GET /api/health) shows as "${want}"`, !!want && want !== item.name && seen.includes(want), want ?? "no Spanish");
    check(`es · overview health: "${item.name}" is not drawn in English`, !seen.includes(item.name));
  }
  const owner = (await api("profiles")).roleLabels?.owner?.label;
  check(`es · overview: the owner's role (GET /api/profiles "${owner}") shows as "${S["household.role.owner"]}"`, seen.includes(S["household.role.owner"]) && !seen.includes(owner));
}

/* Settings › On this computer: each model offered (GET /api/local-models oneClick.offers) describes itself in Spanish, and its
   fit verdict (the engine's note, "Fits well: …") is the Spanish word. */
async function localModels(page, S) {
  const offers = (await api("local-models")).oneClick?.offers ?? [];
  await page.locator('[data-act="setpage"][data-v="local"]').first().click();
  await page.locator(".lm12").first().waitFor({ timeout: 15000 }).catch(() => null);
  const said = await page.locator(".lm12 > p").allTextContents();
  const spanish = new Set(offers.map((o) => o.summary?.es)), english = new Set(offers.map((o) => o.summary?.en));
  check(`es · local: every model offered (${offers.length}) describes itself in Spanish (summary.es)`, offers.length > 0 && said.length === offers.length && said.every((s) => spanish.has(s.trim()) && !english.has(s.trim())), said.slice(0, 2).join(" | "));
  const verdicts = (await page.locator(".lm12 .lm-h12 .pill:not(.done)").allTextContents()).map((s) => s.trim());
  const words = new Set([S["local.fit.well"], S["local.fit.tight"], S["local.fit.no"]]);
  check("es · local: every fit verdict is the Spanish word (Cabe bien, Justo, No cabe)", verdicts.length === offers.length && verdicts.every((v) => words.has(v)), [...new Set(verdicts)].join(", "));
}

/* Settings › Achievements: the engine words all 505 in Spanish when asked in Spanish (GET /api/delight/achievements?lang=es),
   the same ones in the same order as in English, and the page shows those words, never the English ones. */
async function achievementsPage(page, S, E, leaks) {
  const [es, en] = await Promise.all([api("delight/achievements?lang=es"), api("delight/achievements?lang=en")]);
  const same = es.list?.length === en.list?.length && es.list.every((a, i) => a.id === en.list[i].id && a.tier === en.list[i].tier);
  check(`engine: the achievements in Spanish are the same ${es.total} as in English, in the same order`, same && es.total === 505, `${es.list?.length} vs ${en.list?.length}`);
  const worded = es.list.filter((a) => a.desc && a.desc !== "???");
  check("engine: every sentence the window may show is Spanish", worded.length > 0 && worded.every((a) => a.desc !== en.list.find((b) => b.id === a.id).desc), `${worded.length} shown`);
  const englishNames = new Set(en.list.filter((a, i) => a.name && a.name !== es.list[i].name).map((a) => a.name));
  const englishDescs = new Set(en.list.filter((a, i) => a.desc && a.desc !== es.list[i].desc).map((a) => a.desc));
  const englishKinds = new Set(en.list.filter((a, i) => a.kind !== es.list[i].kind).map((a) => a.kind));
  await page.locator('[data-act="setpage"][data-v="achievements"]').first().click();
  await page.locator(".achs .ach").first().waitFor({ timeout: 15000 });
  const names = (await page.locator(".achs .ach b").allTextContents()).map((s) => s.trim());
  const descs = (await page.locator(".achs .ach small").allTextContents()).map((s) => s.trim());
  const tabs = (await page.locator('[data-act="achcat"]').allTextContents()).map((s) => s.trim());
  const spanishNames = new Set(es.list.map((a) => a.name));
  check(`es · achievements: all ${es.list.length} cards are drawn, each named in the engine's Spanish`, names.length === es.list.length && names.every((n) => spanishNames.has(n)), names.slice(0, 4).join(" | "));
  check("es · achievements: the first cards read as the engine words them", names.slice(0, 3).join("|") === es.list.slice(0, 3).map((a) => a.name).join("|"), names.slice(0, 3).join(" | "));
  const leftNames = names.filter((n) => englishNames.has(n)), leftDescs = descs.filter((d) => englishDescs.has(d));
  check("es · achievements: no English name or sentence on the page", leftNames.length === 0 && leftDescs.length === 0, [...leftNames, ...leftDescs].slice(0, 4).join(" | "));
  check(`es · achievements: the kinds are Spanish ("Primeros pasos", "Herramientas"…), none English`, tabs.includes("Primeros pasos") && tabs.includes("Herramientas") && !tabs.some((k) => englishKinds.has(k)), tabs.join(", "));
  check(`es · achievements: the tier chips are Spanish ("${S["delight.ach.tier.t-bronze"]}")`, (await onPage(page)).includes(S["delight.ach.tier.t-bronze"]));
  await surface(page, "achievements", S, E, leaks);
}

(async () => {
  const [S, E] = await Promise.all([words("es"), words("en")]);
  const sk = Object.keys(S), ek = Object.keys(E);
  check("es.json answers every key en.json does, in the same order", sk.length === ek.length && sk.every((k, i) => k === ek[i]), `${sk.length} vs ${ek.length}`);
  const keys = Object.values(SURFACES).flat();
  check("the words checked differ from English", keys.every((k) => typeof S[k] === "string" && S[k] !== E[k]), keys.filter((k) => !(S[k] && S[k] !== E[k])).join(", "));
  const leaks = englishOnly(E, S);
  await api("look", { language: "auto" }); // a fresh engine; nothing chosen yet
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page);

    // Setup: the Language control is first and lists Español among the languages with words on file.
    const setup = page.locator(".ob9[role=dialog]");
    await setup.waitFor({ timeout: 30000 });
    check("setup opens on a fresh engine (onboarding not done)", (await api("state")).onboarding?.done !== true);
    const offered = await page.locator("#ob-lang option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent, off: o.disabled })));
    const listed = await page.evaluate(async () => (await import("/i18n.js")).LANGUAGES.map((l) => l.id));
    check("setup: Language lists exactly i18n.js LANGUAGES, Spanish among them", JSON.stringify(offered.map((o) => o.v)) === JSON.stringify(listed) && listed.includes("es"), JSON.stringify(offered));
    check('setup: Spanish is named "Español" and can be picked', offered.some((o) => o.v === "es" && o.t === "Español" && !o.off), JSON.stringify(offered.find((o) => o.v === "es")));
    check("setup: English is in force before anything is picked", (await page.evaluate(() => document.documentElement.lang)) === "en");

    await page.locator("#ob-lang").selectOption("es");
    await page.waitForFunction(() => document.documentElement.lang === "es", null, { timeout: 15000 });
    await page.locator(".ob9 h2").filter({ hasText: S["window.flows.first.hi"] }).waitFor({ timeout: 10000 });
    check(`setup: Welcome says "${S["window.flows.first.hi"]}"`, (await page.locator(".ob9 h2").first().textContent())?.trim() === S["window.flows.first.hi"]);
    check(`setup: the dialog is named "${S["window.setup.label"]}"`, (await setup.getAttribute("aria-label")) === S["window.setup.label"]);
    check(`setup: its Language control is labelled "${S["appearance.language"]}"`, (await page.locator(".ob-lang b").first().textContent())?.trim() === S["appearance.language"]);
    await surface(page, "setup", S, E, leaks);
    check("setup: the engine keeps Spanish (GET /api/look language = es)", (await api("look")).language === "es");
    check("setup: this browser keeps Spanish (localStorage)", (await page.evaluate(() => localStorage.getItem("branch-language"))) === "es");

    // Dates and numbers follow the language (i18n.js, which the window's formatting goes through).
    const fmt = await page.evaluate(async () => {
      const i18n = await import("/i18n.js");
      const d = new Date(2026, 0, 15, 9, 5);
      return { date: i18n.formatDate(d, { dateStyle: "long" }), number: i18n.formatNumber(1234567.5), weekday: d.toLocaleDateString(i18n.language(), { weekday: "long" }) };
    });
    check("dates follow Spanish (formatDate: 15 de enero de 2026)", fmt.date === new Intl.DateTimeFormat("es", { dateStyle: "long" }).format(new Date(2026, 0, 15, 9, 5)) && /enero/.test(fmt.date), fmt.date);
    check("numbers follow Spanish (formatNumber)", fmt.number === new Intl.NumberFormat("es").format(1234567.5), fmt.number);
    check("weekday names follow Spanish (the schedule card's day names)", fmt.weekday === "jueves", fmt.weekday);

    // A new conversation.
    await closeSetup(page);
    await dismissWelcome(page);
    await page.locator(".empty-chat h1").waitFor({ timeout: 15000 });
    await surface(page, "conversation", S, E, leaks);
    const placeholder = await page.locator("#prompt").getAttribute("placeholder").catch(() => null);
    check("conversation: the message box speaks Spanish", !!placeholder && placeholder !== E["window.chat.composer.message"] && Object.values(S).includes(placeholder), placeholder ?? "");

    // Inbox and Library, every tab.
    await place(page, "inbox", ["needs", "finished", "history"], "inbox", S, E, leaks);
    await place(page, "library", ["memory", "documents", "made"], "library", S, E, leaks);
    await overviewWords(page, S, E);

    // Settings pages.
    await page.keyboard.press("Control+,");
    await page.locator(".settings").waitFor({ timeout: 15000 });
    await settingsPage(page, "appearance", "appearance", S, E, leaks);
    const lang = await shown(page);
    check("Settings › Appearance › Language shows Español", lang.value === "es" && lang.text === "Español", JSON.stringify(lang));
    await settingsPage(page, "models", "models", S, E, leaks);
    await settingsPage(page, "permissions", "permissions", S, E, leaks);
    await settingsPage(page, "general", "general", S, E, leaks);
    await localModels(page, S);
    await achievementsPage(page, S, E, leaks);
    check("zero page errors before the reload", errors.length === 0, errors.join(" | "));

    // A reload keeps Spanish.
    await page.reload();
    await page.waitForFunction(() => document.documentElement.lang === "es", null, { timeout: 30000 });
    check("after a reload: <html lang> is es", (await page.evaluate(() => document.documentElement.lang)) === "es");
    await closeSetup(page);
    await dismissWelcome(page);
    await page.locator(".empty-chat h1").waitFor({ timeout: 15000 });
    await surface(page, "conversation", S, E, leaks);
    await page.keyboard.press("Control+,");
    await page.locator(".settings").waitFor({ timeout: 15000 });
    await settingsPage(page, "appearance", "appearance", S, E, leaks);
    const again = await shown(page);
    check("after a reload: Settings › Appearance › Language still shows Español", again.value === "es" && again.text === "Español", JSON.stringify(again));
    check("after a reload: the engine still says es", (await api("look")).language === "es");
    check("zero page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  } finally {
    await browser.close();
    await api("look", { language: "auto" }).catch((error) => console.error(error.message));
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
