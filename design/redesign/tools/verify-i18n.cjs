/* rw4-i18n: the window's words that went through no translation now go through t() (public/i18n.js, public/locales).
   Proves it in the real window against a FRESH engine (onboarding not done), once in French and once in English:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-i18n.cjs
   The language is the saved choice public/i18n.js reads (localStorage "branch-language"); the engine's own language
   (GET /api/look) is put back to "auto" first so it does not override that. Each pass: the setup dialog's name, Find's
   "No matches", Inbox › History › Verify (its answer read back from POST /api/safety-extras/activity/verify, the route
   the window calls), and a bad theme code's message. The English pass also checks no raw key ("window.…") is on screen.
   (Find searches a conversation a model really answered: since #349 an empty new conversation draws starting points.
   The demo model left in #359, so this script serves a stand-in OpenAI-shaped model on 127.0.0.1:1234 and adds it with
   POST /api/connections/from-preset, as verify-i18n-de.cjs does; the answer is read back from GET /api/state runs
   before any pass opens the conversation; that first answer ends setup, so setup is put back to not done through
   POST /api/onboarding; the connection is forgotten at the end.)
   rw4-language: the locale files are cached (an ETag, 304 when unchanged, no-cache so a new build comes fresh), and
   Settings › Appearance › Language is live: picking Français saves it to the engine (GET /api/look says fr) and to this
   browser, and the window redraws in French; after a reload, and in a new browser with nothing saved, it is still
   French and the select shows Français; only the languages with words on file are offered (a code with none, "xx", cannot be picked); English again says "English." (the prototype's toast).
   rw4-i18n-chat: the conversation and the flows (public/app/chat, public/app/flows) speak through t(). With a conversation
   the stand-in model answered (POST /api/run), each pass opens it, the + menu, the model and mode menus, Find, the
   side panel, the Add an account wizard and the tour, and checks 20 of those words (visible text, aria-label, placeholder,
   title, data-tip): in French each shows in French and its English is nowhere on the page; in English each shows in
   English. On every surface no raw key (any key of en.json, or "window.chat…" / "window.flows…") and no unfilled {word}
   shows. Setup's Language (the owner's addition): a new browser with nothing saved on an engine with no saved language
   opens setup with the Language control first, listing only the languages with words on file; picking Français turns
   Welcome French and saves it to the engine and this browser; after a reload it is still French; Settings › Appearance
   then shows Français.
   Page errors must be zero. The engine's language is left at "auto" at the end. */
const http = require("node:http");
/* The repository's own Playwright first, so the check never needs anything from an installed copy of Branch. */
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright"); }
const { chromium } = playwright;

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const REPLY = "Hello from the stand-in model.";

/* An OpenAI-shaped model on this computer (as verify-i18n-de.cjs serves it): lists one model, and answers every chat with
   the same words, streamed or not. */
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
/* The stand-in's answer to one message, read back from the engine (GET /api/state runs) once the run has finished. */
async function answered(prompt) {
  const { sessionId } = await api("run", { prompt });
  for (const end = Date.now() + 30000; Date.now() < end; await wait(250)) {
    const run = (await api("state")).runs.find((r) => r.sessionId === sessionId && r.prompt === prompt);
    if (run && run.status !== "running" && run.status !== "queued") return { sessionId, run };
  }
  return { sessionId, run: null };
}

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function words(lang) { return (await fetch(`${BASE}/locales/${lang}.json`)).json(); }

/* lang null: nothing is put in the browser's storage; the window's own choice (and the engine's) decide. */
async function open(browser, lang) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  if (lang) await context.addInitScript((l) => { try { localStorage.setItem("branch-language", l); } catch { /* checked below */ } }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  // rw4-i18n-places: the sign-in form is drawn in the saved language too.
  const W = lang === "fr" ? await words("fr") : null;
  await page.getByLabel(W ? W["field.session-token"] : "Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: W ? W["action.connect"] : "Connect", exact: true }).click();
  return { context, page, errors };
}

/* Closing setup brings the "New to Branch?" card a moment later (flows/first.js); dismiss it so it covers nothing. */
async function dismissWelcome(page) {
  await page.evaluate(() => { try { localStorage.setItem("branch-welcomed", "1"); } catch { /* checked by the clicks that follow */ } });
  await page.waitForTimeout(1500);
  if (await page.locator('[data-act="welcome-x"]').isVisible().catch(() => false)) await page.locator('[data-act="welcome-x"]').click();
}
/* A conversation the engine's demo model answered: an empty new conversation draws its starting points instead of a thread. */
async function openConversation(page, sessionId) {
  await page.locator(`[data-act="chat"][data-id="${sessionId}"]`).first().click();
  await page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
}

async function pass(browser, lang, W, sessionId) {
  const { context, page, errors } = await open(browser, lang);
  check(`${lang}: <html lang> is ${lang}`, (await page.evaluate(() => document.documentElement.lang)) === lang);

  // Setup opens on a fresh engine (GET /api/state onboarding.done is false); its dialog is named in the language.
  const state = await api("state");
  const setup = page.locator(".ob9[role=dialog]");
  await setup.waitFor({ timeout: 30000 });
  check(`${lang}: engine says onboarding is not done`, state.onboarding?.done !== true);
  check(`${lang}: setup dialog is named "${W["window.setup.label"]}"`, (await setup.getAttribute("aria-label")) === W["window.setup.label"]);
  await page.locator('[data-act="ob-close"]').first().click();
  await page.locator("#prompt").waitFor({ timeout: 30000 });
  await dismissWelcome(page);
  await openConversation(page, sessionId);

  // Find in this conversation: words that are nowhere give "No matches".
  await page.locator('[data-act="find-open"]').first().click();
  await page.locator("#find9-q").fill("zqxjvkwq");
  await page.waitForTimeout(400);
  const none = (await page.locator("#find9-n").textContent())?.trim();
  check(`${lang}: Find shows "${W["window.find.none"]}"`, none === W["window.find.none"], none);
  await page.locator("#find9-q").press("Escape");

  // Inbox › History › Verify: the window's answer matches the engine's own verify result.
  await page.locator('#side [data-act="view"][data-v="inbox"]').first().click();
  await page.locator('[data-act="ptab"][data-place="inbox"][data-v="history"]').first().click();
  await page.locator('[data-act="verify15"]').first().click();
  const engine = (await api("safety-extras/activity/verify", {})).check;
  const want = engine.ok ? W["window.inbox.intact"] : engine.reason;
  await page.locator("#ver-t15").filter({ hasText: /\S/ }).waitFor({ timeout: 10000 });
  const said = (await page.locator("#ver-t15").textContent())?.trim();
  check(`${lang}: Verify says "${want}" (engine check.ok=${engine.ok})`, said === want, said);
  await page.locator('.dlg [data-act="dlg-close"], [data-act="dlg-close"]').first().click();
  if (engine.ok) {
    const chip = (await page.locator('[data-act="verify15"] span').first().textContent())?.trim();
    check(`${lang}: History's Verify button reads "${want}" after the check`, chip === want, chip);
  }

  // Settings › Appearance › Browse themes › Paste a theme code: a code that is not one is refused in the language.
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setpage"][data-v="appearance"]').first().click();
  await page.locator('[data-act="skins"]').first().click();
  await page.locator('[data-act="my-paste"]').first().click();
  await page.locator("#paste6").fill("not a theme code");
  await page.locator('[data-act="my-paste-go"]').click();
  const why = (await page.locator("#paste6-why").textContent())?.trim();
  check(`${lang}: a bad theme code says "${W["window.themes.not-a-code"]}"`, why === W["window.themes.not-a-code"], why);

  if (lang === "en") {
    const raw = await page.evaluate(() => {
      const labels = [...document.querySelectorAll("[aria-label]")].map((n) => n.getAttribute("aria-label")).join("\n");
      return (document.body.innerText + "\n" + labels).match(/\bwindow\.[a-z]+\.[a-z-]+/g) || [];
    });
    check("en: no raw key (window.…) on screen", raw.length === 0, raw.join(", "));
  }
  check(`${lang}: zero page errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

/* rw4-language: the words are kept by the browser and asked about again: an unchanged file answers 304 with no body. */
async function caching() {
  const first = await fetch(`${BASE}/locales/en.json`);
  const etag = first.headers.get("etag"), cc = first.headers.get("cache-control");
  await first.arrayBuffer();
  check("en.json answers 200 with an ETag", first.status === 200 && /^"[\w-]+"$/.test(etag ?? ""), etag);
  check("en.json may be kept but is checked each time (no-cache, not no-store)", cc === "no-cache", cc);
  const again = await fetch(`${BASE}/locales/en.json`, { headers: { "if-none-match": etag } });
  const body = await again.arrayBuffer();
  check("asked again with that ETag: 304 and no body", again.status === 304 && body.byteLength === 0, `${again.status}, ${body.byteLength} bytes`);
  const stale = await fetch(`${BASE}/locales/en.json`, { headers: { "if-none-match": '"not-this-build"' } });
  check("another build's ETag gets the words again (200)", stale.status === 200 && (await stale.arrayBuffer()).byteLength > 0, String(stale.status));
  const fr = await fetch(`${BASE}/locales/fr.json`);
  await fr.arrayBuffer();
  check("fr.json has its own ETag", fr.headers.get("etag") && fr.headers.get("etag") !== etag);
  const other = await fetch(`${BASE}/app/main.js`);
  await other.arrayBuffer();
  check("other files are still no-store", other.headers.get("cache-control") === "no-store", other.headers.get("cache-control"));
}

const lang = (page) => page.evaluate(() => document.documentElement.lang);
/* Every language i18n.js LANGUAGES lists, named in its own words the way the pickers name it (Intl.DisplayNames). */
const ownNames = (page) => page.evaluate(async () => (await import("/i18n.js")).LANGUAGES.map(({ id }) => {
  const name = new Intl.DisplayNames([id], { type: "language" }).of(id) ?? id;
  return name.charAt(0).toLocaleUpperCase(id) + name.slice(1);
}));
const saved = (page) => page.evaluate(() => { try { return localStorage.getItem("branch-language"); } catch { return "unreadable"; } });
const shown = (page) => page.locator("#lang").evaluate((s) => ({ value: s.value, text: s.selectedOptions[0]?.textContent ?? "", disabled: s.disabled }));
async function closeSetup(page) {
  const setup = page.locator(".ob9[role=dialog]");
  await setup.waitFor({ timeout: 30000 }).catch(() => null);
  if (await setup.isVisible()) await page.locator('[data-act="ob-close"]').first().click();
  await page.locator("#prompt").waitFor({ timeout: 30000 });
}
async function openAppearance(page) {
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setpage"][data-v="appearance"]').first().click();
  await page.locator("#lang").waitFor();
}

async function languageSelect(browser, W, E) {
  const { context, page, errors } = await open(browser, null);
  await closeSetup(page);
  await openAppearance(page);
  const before = await shown(page);
  check("select: shows the language in force (English), live", before.value === "en" && before.text === "English" && !before.disabled, JSON.stringify(before));
  const options = await page.locator("#lang option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent, off: o.disabled, tip: o.dataset.tip ?? "" })));
  // Only the languages with words on file are offered (public/i18n.js LANGUAGES); nothing is listed greyed.
  const names = await ownNames(page);
  check("select: only the languages with words on file, in their own names", options.map((o) => o.t).join("|") === names.join("|") && names.includes("Français"), options.map((o) => o.t).join("|"));
  check("select: every option can be picked", options.every((o) => !o.off && !o.tip), JSON.stringify(options));

  await page.locator("#lang").selectOption("fr");
  await page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 15000 });
  check("Français: the engine keeps it (GET /api/look language = fr)", (await api("look")).language === "fr");
  check("Français: this browser keeps it (localStorage)", (await saved(page)) === "fr");
  let now = await shown(page);
  check("Français: the select, drawn again, shows Français", now.value === "fr" && now.text === "Français", JSON.stringify(now));
  await page.locator('[data-act="skins"]').first().click();
  await page.locator('[data-act="my-paste"]').first().click();
  await page.locator("#paste6").fill("not a theme code");
  await page.locator('[data-act="my-paste-go"]').click();
  const why = (await page.locator("#paste6-why").textContent())?.trim();
  check("Français: words drawn after the change are French (a bad theme code)", why === W["window.themes.not-a-code"], why);
  await page.keyboard.press("Escape");
  await page.locator("#paste6").waitFor({ state: "detached", timeout: 5000 }).catch(() => null);

  let refused = false;
  try { await page.locator("#lang").selectOption("xx", { timeout: 2000 }); } catch { refused = true; }
  now = await shown(page);
  check("a language with no words on file (xx): not offered, so it cannot be picked", refused && now.value === "fr", `refused=${refused}, value=${now.value}`);
  check("xx: the engine still says fr", (await api("look")).language === "fr");
  // A script can still set a value that is not offered; the window's own guard refuses it and draws the choice in force again.
  await page.locator("#lang").evaluate((s) => { s.value = "xx"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction(() => document.getElementById("lang")?.value === "fr", null, { timeout: 5000 }).catch(() => null);
  now = await shown(page);
  check("xx set by script: refused, the engine still says fr and the select shows Français", (await api("look")).language === "fr" && now.value === "fr" && now.text === "Français", JSON.stringify(now));

  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 30000 });
  await closeSetup(page);
  await openAppearance(page);
  now = await shown(page);
  check("after a reload: still French, the select shows Français", (await lang(page)) === "fr" && now.value === "fr" && now.text === "Français", JSON.stringify(now));
  check("zero page errors (first browser)", errors.length === 0, errors.join(" | "));
  await context.close();

  // A new browser: nothing saved in it, so the first words are English until the engine's choice is read.
  const fresh = await open(browser, null);
  await fresh.page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 30000 }).catch(() => null);
  await closeSetup(fresh.page);
  await openAppearance(fresh.page);
  now = await shown(fresh.page);
  check("new browser: French from the engine, the select shows Français", (await lang(fresh.page)) === "fr" && now.value === "fr" && now.text === "Français", JSON.stringify(now));

  await fresh.page.locator("#lang").selectOption("en");
  await fresh.page.waitForFunction(() => document.documentElement.lang === "en", null, { timeout: 15000 });
  const said = (await fresh.page.locator(".toast").first().textContent().catch(() => ""))?.trim();
  check('English again: the prototype\'s toast "English."', said === "English.", said);
  check("English again: the engine says en", (await api("look")).language === "en");
  now = await shown(fresh.page);
  check("English again: the select shows English", now.value === "en" && now.text === "English", JSON.stringify(now));
  check("English again: a word drawn by t() is English", (await fresh.page.evaluate(async () => (await import("/i18n.js")).t("window.find.none"))) === E["window.find.none"]);
  check("zero page errors (new browser)", fresh.errors.length === 0, fresh.errors.join(" | "));
  await fresh.context.close();
}

/* ---------- rw4-i18n-chat: the conversation and the flows ---------- */

/* Twenty of the words chat/ and flows/ draw, by the surface that shows them. Each is a key the code looks up. */
const SURFACES = {
  conversation: ["window.chat.composer.message", "window.chat.head.find", "window.chat.composer.plus", "window.chat.composer.voice", "window.chat.more.label", "window.chat.branches.from-here", "window.chat.head.more"],
  plus: ["window.chat.plus.attach", "window.chat.plus.temporary", "window.chat.plus.goal"],
  model: ["window.chat.mode.which-model"],
  mode: ["window.chat.mode.everywhere"],
  find: ["window.chat.find.close"],
  pane: ["window.chat.pane.timeline", "pane.close"],
  account: ["window.flows.acct.search"],
  tour: ["window.flows.tour.contacts", "window.flows.tour.skip"],
  setup: ["window.flows.setup.safe", "window.flows.setup.understand"],
};

/* Everything a person can read or hear on the page: its text and the words carried in attributes. */
const onPage = (page) => page.evaluate(() => {
  const attrs = [...document.querySelectorAll("[aria-label],[placeholder],[title],[data-tip]")]
    .flatMap((n) => ["aria-label", "placeholder", "title", "data-tip"].map((a) => n.getAttribute(a)).filter(Boolean));
  return [document.body.innerText, ...attrs].join("\n");
});

/* One surface: each of its words is in the language (and, in French, its English is nowhere), and no raw key or
   unfilled {word} shows anywhere on the page. */
async function surface(page, name, lang, W, E) {
  const text = await onPage(page);
  /* Compared without case: a menu heading is drawn in capitals (text-transform), and innerText reads it so. */
  const seen = text.toLocaleLowerCase();
  for (const key of SURFACES[name]) {
    const want = W[key], english = E[key];
    check(`${lang} · ${name}: "${want}" shows`, typeof want === "string" && seen.includes(want.toLocaleLowerCase()));
    if (lang === "fr") check(`fr · ${name}: English "${english}" is not on the page`, !seen.includes(english.toLocaleLowerCase()));
  }
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const keys = new Set(Object.keys(E));
  const raw = lines.filter((s) => keys.has(s) || /\bwindow\.(chat|flows)\.[\w.-]+/.test(s));
  check(`${lang} · ${name}: no raw key on the page`, raw.length === 0, raw.slice(0, 5).join(", "));
  const unfilled = lines.filter((s) => /\{[a-z]\w*\}/.test(s));
  check(`${lang} · ${name}: no unfilled {word} on the page`, unfilled.length === 0, unfilled.slice(0, 3).join(" | "));
}

/* A control the window already handles, put on the page and pressed, as tests/redesign-approvals-exact-ui.test.mjs does:
   the window draws #main again shortly after sign-in, which can drop it, so it is added again and retried. */
async function press(page, act) {
  for (let tries = 0; tries < 5; tries++) {
    await page.evaluate((a) => {
      if (document.querySelector("#i18n-press")) return;
      const b = Object.assign(document.createElement("button"), { type: "button", id: "i18n-press", textContent: "·" });
      b.dataset.act = a;
      document.querySelector("#main").append(b);
    }, act);
    if (await page.locator("#i18n-press").click({ timeout: 3000 }).then(() => true, () => false)) break;
  }
  await page.evaluate(() => document.querySelector("#i18n-press")?.remove());
}

async function chatAndFlows(browser, lang, W, E, sessionId) {
  const { context, page, errors } = await open(browser, lang);
  await closeSetup(page);
  await dismissWelcome(page);
  await openConversation(page, sessionId);
  await surface(page, "conversation", lang, W, E);

  const menu = async (act, name) => {
    await page.locator(`[data-act="${act}"]`).first().click();
    await page.locator(".pop").waitFor({ timeout: 10000 });
    await surface(page, name, lang, W, E);
    await page.keyboard.press("Escape");
    await page.locator(".pop").waitFor({ state: "detached", timeout: 5000 }).catch(() => null);
  };
  await menu("plusmenu", "plus");
  await menu("modelmenu2", "model");
  await menu("modemenu2", "mode");

  await page.locator('[data-act="find-open"]').first().click();
  await page.locator("#find9-q").waitFor({ timeout: 10000 });
  await surface(page, "find", lang, W, E);
  await page.locator("#find9-q").press("Escape");

  await page.locator('[data-act="pane"][data-p="activity"]').first().click();
  await page.locator("#pane .ptabs").waitFor({ timeout: 10000 });
  await surface(page, "pane", lang, W, E);
  await page.locator('#pane [data-act="pane"][data-p="close"]').click();

  await press(page, "addacct");
  await page.locator("#aa-q").waitFor({ timeout: 15000 });
  await surface(page, "account", lang, W, E);
  await page.locator('.dlg [data-act="dlg-close"]').first().click();

  await press(page, "tour");
  await page.locator(".tour-card b").waitFor({ timeout: 15000 });
  await surface(page, "tour", lang, W, E);
  await page.locator('[data-act="tour-end"]').click();

  check(`${lang} · chat and flows: zero page errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

/* The owner's addition: the first thing setup asks is the language. */
async function setupLanguage(browser, fr, en) {
  await api("look", { language: "auto" });
  const { context, page, errors } = await open(browser, null);
  const setup = page.locator(".ob9[role=dialog]");
  await setup.waitFor({ timeout: 30000 });
  const first = await page.evaluate(() => {
    const body = document.querySelector(".ob9 .ob-body");
    const el = body?.firstElementChild;
    const select = document.querySelector("#ob-lang");
    return { firstIsLanguage: !!el?.classList.contains("ob-lang") && el.contains(select), options: [...(select?.options ?? [])].map((o) => ({ v: o.value, t: o.textContent, off: o.disabled })), value: select?.value, label: el?.querySelector("b")?.textContent };
  });
  const listed = await page.evaluate(async () => (await import("/i18n.js")).LANGUAGES.map((l) => l.id));
  check("setup: the Language control comes first, before the greeting", first.firstIsLanguage, JSON.stringify(first));
  check(`setup: it is labelled "${en["appearance.language"]}"`, first.label === en["appearance.language"], first.label);
  check("setup: it lists only the languages with words on file (i18n.js LANGUAGES), none greyed", JSON.stringify(first.options.map((o) => o.v)) === JSON.stringify(listed) && first.options.every((o) => !o.off), JSON.stringify(first.options));
  const names = await ownNames(page);
  check(`setup: each language is named in its own words (${names.join(", ")})`, first.options.map((o) => o.t).join("|") === names.join("|") && names.slice(0, 2).join("|") === "English|Français", first.options.map((o) => o.t).join("|"));
  check("setup: with nothing saved it shows the language in force (English)", first.value === "en" && (await lang(page)) === "en");
  await surface(page, "setup", "en", en, en);

  await page.locator("#ob-lang").selectOption("fr");
  await page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 15000 });
  await page.locator(".ob9 h2").filter({ hasText: fr["window.flows.first.hi"] }).waitFor({ timeout: 10000 });
  check(`setup: after Français, Welcome says "${fr["window.flows.first.hi"]}"`, (await page.locator(".ob9 h2").first().textContent())?.trim() === fr["window.flows.first.hi"]);
  check(`setup: the dialog is named "${fr["window.setup.label"]}"`, (await setup.getAttribute("aria-label")) === fr["window.setup.label"]);
  await surface(page, "setup", "fr", fr, en);
  check("setup: the engine keeps it (GET /api/look language = fr)", (await api("look")).language === "fr");
  check("setup: this browser keeps it (localStorage)", (await saved(page)) === "fr");

  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 30000 });
  await setup.waitFor({ timeout: 30000 });
  await page.locator(".ob9 h2").filter({ hasText: fr["window.flows.first.hi"] }).waitFor({ timeout: 10000 });
  check("setup: after a reload it is still French, and its Language shows Français", (await page.locator("#ob-lang").inputValue()) === "fr" && (await page.locator(".ob9 h2").first().textContent())?.trim() === fr["window.flows.first.hi"]);
  await closeSetup(page);
  await openAppearance(page);
  const now = await shown(page);
  check("setup: Settings › Appearance then shows Français", now.value === "fr" && now.text === "Français", JSON.stringify(now));
  check("setup: zero page errors", errors.length === 0, errors.join(" | "));
  await context.close();
  await api("look", { language: "auto" });
}

(async () => {
  const [fr, en] = await Promise.all([words("fr"), words("en")]);
  check("French words differ from English for the keys checked", ["window.setup.label", "window.find.none", "window.inbox.intact", "window.themes.not-a-code"].every((k) => fr[k] && fr[k] !== en[k]));
  await api("look", { language: "auto" }); // the engine's choice would override the passes' saved one
  await caching();
  const server = await stub();
  const browser = await chromium.launch({ headless: true });
  let presetId = null;
  try {
    /* The passes open a conversation the stand-in model answered (an empty new one has no thread to search). */
    presetId = (await api("connections/from-preset", { provider: "lm-studio", key: "stub-key", model: "stub-model", name: "Stand-in" })).id;
    check("the stand-in model is added", !!presetId, presetId);
    const { sessionId, run } = await answered("Say hello for the language check.");
    check("the stand-in answered (GET /api/state runs: completed)", run?.status === "completed" && String(run.output ?? "").includes(REPLY), run?.status ?? "no run");
    /* A real model's first answer ends setup (src/onboarding.ts). The passes check setup as a fresh engine shows it, so it is
       put back to not done through the engine's own route (POST /api/onboarding); the engine ends it once only. */
    await api("onboarding", { done: false });
    check("setup is not done again before the passes (GET /api/state)", (await api("state")).onboarding?.done !== true);
    await pass(browser, "fr", fr, sessionId);
    await pass(browser, "en", en, sessionId);
    await languageSelect(browser, fr, en);
    await api("look", { language: "auto" });
    const keys = Object.values(SURFACES).flat();
    check("rw4-i18n-chat: the 20 words are in English and in French, and the French differs", keys.length === 20 && keys.every((k) => typeof en[k] === "string" && typeof fr[k] === "string" && fr[k] !== en[k]), keys.filter((k) => !(fr[k] && fr[k] !== en[k])).join(", "));
    await chatAndFlows(browser, "fr", fr, en, sessionId);
    await chatAndFlows(browser, "en", en, en, sessionId);
    await setupLanguage(browser, fr, en);
  } finally {
    await browser.close();
    server.close();
    await api("look", { language: "auto" }).catch((error) => console.error(error.message));
    if (presetId) await api("connections/forget", { id: presetId }).catch((error) => console.error(error.message));
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
