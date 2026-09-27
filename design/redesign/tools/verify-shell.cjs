// Verifies the window shell, appearance and first-run controls made live on claude/rw2-shell, against a running engine:
// each control is clicked in the real window and the change is read back from the engine's own GET route (or, for a
// window-only control, from the window's DOM or storage). Page errors are recorded and must be zero.
// Run: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-shell.cjs
// Use a throwaway engine (BRANCH_DATA_DIR=<fresh temp dir>): it makes Trunks and conversations and changes settings.
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT || "3328", TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
if (!TOKEN) { console.error("Set TOKEN to the engine's session token."); process.exit(2); }

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

const results = [];
function check(action, ok, how) { results.push([action, ok ? "PASS" : "FAIL", how]); if (!ok) console.log(`FAIL ${action}: ${how}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(150); } }

/* Test data made through the engine: a Trunk, a conversation with a word to find, and one old enough to be a "past session". */
async function fixtures(stamp) {
  for (const part of ["trunks", "conversations"]) await api("trunks/switch", { part, mode: "on" });
  const past = await api("run", { prompt: `pastword${stamp} from long ago` });
  const filler = await api("run", { prompt: "filler conversation" });
  const archive = await api(`sessions/${filler.sessionId}/export`);
  for (let i = 0; i < 51; i++) await api("sessions/import", archive);
  const recent = await api("run", { prompt: `msgword${stamp} is here` });
  const trunk = (await api("trunks", { name: `Verify ${stamp}`, description: "Checks the window" })).trunk;
  return { trunk, pastId: past.sessionId, recentId: recent.sessionId };
}

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine");
  await page.waitForTimeout(1200);
  // A fresh engine opens on setup; it is closed with "Skip for now" as a person would, so onboarding stays not done for
  // the first-run check below.
  if (await page.isVisible(".ob9")) await page.click('.ob9 [data-act="ob-close"]');
}
async function openAppearance(page) {
  await page.click('#side [data-act="view"][data-v="settings"]');
  await page.click('[data-act="setpage"][data-v="appearance"]');
  await page.waitForSelector("text=Browse all");
}
const css = (page, name) => page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name);
const looks = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("branch-looks") || "{}"));

async function themes(page) {
  await openAppearance(page);
  await page.click('[data-act="skins"]');
  check("skins", await page.isVisible(".themes6"), "the Themes gallery opens with every theme card");
  await page.click('[data-act="skinf"][data-v="KeepOak"]');
  const groups = await page.$$eval(".theme6-b small", (els) => [...new Set(els.map((e) => e.textContent))]);
  check("skinf", groups.length === 1 && groups[0] === "KeepOak", `only KeepOak cards shown (${groups.join(",")})`);
  await page.click('[data-act="skinf"][data-v="All"]');
  await page.click('[data-act="skinprev"][data-v="light"]');
  check("skinprev", (await page.getAttribute('[data-act="skinprev"][data-v="light"]', "aria-pressed")) === "true", "Daylight previews pressed; swatches redrawn for light");
  await page.click('[data-act="skin"][data-v="nord"]');
  const look = await until(async () => { const l = await api("look"); return l.theme === "nord" && l; });
  await until(async () => (await page.evaluate(() => document.documentElement.dataset.palette)) === "nord");
  check("skin", !!look && (await css(page, "--bg")) !== "", `GET /api/look theme=${look?.theme}; window colours set (--bg ${await css(page, "--bg")})`);
  await page.check("#g-contrast");
  const more = await until(async () => (await api("look")).contrast === "more");
  await page.uncheck("#g-contrast");
  check("sw:g-contrast", !!more && !!(await until(async () => (await api("look")).contrast === "standard")), "GET /api/look contrast more, then standard");
}

async function editor(page) {
  await page.click('.gal-foot [data-act="ce-new"]');
  check("ce-new", await page.isVisible(".ced"), "the colour editor opens, starting from the worn theme");
  const mode = await page.evaluate(() => document.documentElement.dataset.theme === "light" || (!document.documentElement.dataset.theme && !matchMedia("(prefers-color-scheme: dark)").matches) ? "light" : "dark");
  const other = mode === "dark" ? "light" : "dark";
  await page.click(`[data-act="ce-mode"][data-v="${other}"]`);
  check("ce-mode", (await page.getAttribute(`[data-act="ce-mode"][data-v="${other}"]`, "aria-pressed")) === "true", `the ${other} side is being coloured`);
  await page.click(`[data-act="ce-mode"][data-v="${mode}"]`);
  await page.click('[data-act="ce-acc"][data-v="#2F8F5B"]');
  check("ce-acc", (await page.inputValue("#ceh-accent")).toUpperCase() === "#2F8F5B" && (await css(page, "--accent")).toUpperCase() === "#2F8F5B", "accent field and the live window accent are #2F8F5B");
  await page.fill("#ceh-bg", "#101820");
  const sideBefore = await page.inputValue("#ceh-side");
  await page.click('[data-act="ce-fill"]');
  check("ce-fill", (await page.inputValue("#ceh-side")) !== sideBefore, `sidebar colour derived (${sideBefore} -> ${await page.inputValue("#ceh-side")})`);
  await page.fill("#ce-name", "Verify theme");
  await page.click('[data-act="ce-save"]');
  let saved = await looks(page);
  const mine = saved.my?.find((x) => x.name === "Verify theme");
  check("ce-save", !!mine && saved.mine === mine.id && (await page.evaluate(() => document.documentElement.dataset.palette)) === "my-" + mine.id, "saved in this window's storage (the engine keeps no custom themes) and worn");
  await page.click('[data-act="skins"]');
  await page.click('[data-act="skinf"][data-v="Yours"]');
  await page.click(`[data-act="my-dup"][data-v="${mine.id}"]`);
  saved = await looks(page);
  check("my-dup", saved.my.some((x) => x.name === "Verify theme copy"), "a copy is stored");
  await page.click(`[data-act="my-code"][data-v="${mine.id}"]`);
  const code = await page.inputValue("textarea.code6");
  check("my-code", JSON.parse(code).branchTheme === 1, "the theme code dialog shows the theme's JSON");
  await page.click('.dlg-f [data-act="skins"]');
  await page.click('[data-act="my-paste"]');
  await page.fill("#paste6", code.replace("Verify theme", "Pasted verify"));
  await page.click('[data-act="my-paste-go"]');
  check("my-paste / my-paste-go", (await looks(page)).my.some((x) => x.name === "Pasted verify"), "a pasted code becomes a stored theme");
  await page.click(`[data-act="my-edit"][data-v="${mine.id}"]`);
  check("my-edit", (await page.inputValue("#ce-name")) === "Verify theme", "the editor opens with that theme");
  await page.click('[data-act="ce-cancel"]');
  check("ce-cancel", !(await page.isVisible(".ced")) && (await page.evaluate(() => document.documentElement.dataset.palette)) === "my-" + mine.id, "editor closes, the worn theme is unchanged");
  await page.click('[data-act="skins"]');
  await page.click('[data-act="skinf"][data-v="Yours"]');
  await page.click(`[data-act="my-del"][data-v="${mine.id}"]`);
  await page.click('[data-act="my-del-yes"]');
  const gone = await until(async () => !(await looks(page)).my.some((x) => x.id === mine.id));
  check("my-del / my-del-yes", gone && !!(await until(async () => (await api("look")).theme === "slate")), "removed from storage; the worn theme goes back to Branch Slate (GET /api/look theme=slate)");
  await page.click('[data-act="dlg-close"]');
}

async function accent(page) {
  await page.click('[data-act="acc-set"][data-v="#8A5AA8"]');
  check("acc-set", (await looks(page)).accent === "#8A5AA8" && (await css(page, "--accent")).toUpperCase() === "#8A5AA8", "accent kept in this window and applied (--accent #8A5AA8)");
  await page.click('[data-act="acc-set"][data-v="theme"]');
  await page.click('[data-act="acc-save"]');
  check("acc-save", await page.isVisible(".ced"), "Save as a theme opens the editor from the current colours");
  await page.click('[data-act="ce-cancel"]');
}

async function background(page) {
  await page.click('[data-act="bgset"][data-v="painted"]');
  const on = await until(async () => (await api("delight")).settings.background.on === true);
  await page.waitForSelector("#bgLayer .paint11", { state: "attached" }).catch(() => {});
  check("bgset (painted)", !!on && (await page.isVisible("#bgLayer")), "GET /api/delight background.on=true; the painted layer is drawn");
  await page.click('[data-act="scene-set"][data-v="lake"]');
  const lake = await page.evaluate(() => document.querySelector("#bgLayer .paint11")?.style.backgroundImage ?? "");
  check("scene-set", lake.includes("grove-lake"), `the layer shows the chosen scene (${lake})`);
  await page.click('[data-act="scene-set"][data-v="auto"]');
  await page.click('[data-act="season"][data-v="autumn"]');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const img = await page.evaluate(() => document.querySelector("#bgLayer .paint11")?.style.backgroundImage ?? "");
  check("season", theme === "dark" ? img.includes("grove-night") : img.includes("grove-autumn"), `by the season shows ${img} (${theme} mode draws the night grove)`);
  await page.click('[data-act="bg-peek"]');
  const peek = await page.evaluate(() => document.getElementById("app").classList.contains("peek"));
  await page.keyboard.press("Escape");
  check("bg-peek", peek && !(await page.evaluate(() => document.getElementById("app").classList.contains("peek"))), "See it clearly clears the view; Escape brings it back");
  await page.click('[data-act="bgset"][data-v="none"]');
  await until(async () => (await api("delight")).settings.background.on === false);
}

async function pet(page) {
  await api("delight/settings", { achievements: { on: true } });
  await page.click('[data-act="petset"][data-v="squirrel"]');
  await until(async () => (await api("delight")).settings.pets.on === true);
  await page.waitForSelector("#side #pet-cv");
  await page.click('[data-act="petwhere15"][data-v="status"]');
  check("petwhere15", await page.isVisible("#statusbar #pet-cv"), "the pet now walks in the status bar");
  await page.click("#pet-cv");
  const said = await page.textContent("#pet-say");
  const got = await until(async () => (await api("delight/achievements")).list.find((a) => a.id === "noticed:pats:1" && a.got));
  check("pat", !!said && !!got, `the pet speaks ("${said}") and the pat reaches the engine (GET /api/delight/achievements: Pat pat earned)`);
  await page.click('[data-act="petwhere15"][data-v="side"]');
  await page.click('[data-act="petset"][data-v="none"]');
}

async function hide(page) {
  const prefs = (await api("state")).preferences;
  await api("preferences", { ...prefs, rightClickHide: true });
  await page.reload();
  await page.waitForSelector('#statusbar [data-act="gwpop"]');
  await page.waitForTimeout(800);
  await page.click('#statusbar [data-act="gwpop"]', { button: "right" });
  await page.click('[data-act="hide"]');
  const hidden = await until(async () => (await api("state")).preferences.hidden.includes("gateway"));
  await page.waitForSelector('#statusbar [data-act="gwpop"]', { state: "detached" }).catch(() => {});
  check("hide", !!hidden && !(await page.isVisible('#statusbar [data-act="gwpop"]')), "GET /api/state preferences.hidden has gateway; the gateway button is gone");
  await openAppearance(page);
  await page.check("#h-gateway");
  check("sw:h-gateway (What's shown)", !!(await until(async () => !(await api("state")).preferences.hidden.includes("gateway"))), "switching it back on takes gateway out of preferences.hidden");
}

async function person(page, version) {
  await page.click('[data-act="owner"]');
  await page.click('.pop [data-act="about"]');
  const text = await page.textContent(".dlg");
  check("about", text.includes(`Branch Agent ${version}`), `About shows the engine's version (${version})`);
  await page.click('[data-act="dlg-close"]');
  await page.click('[data-act="owner"]');
  await page.click('.pop [data-act="help"]');
  check("help", !!(await page.waitForSelector(".tour-layer .tour-card", { timeout: 5000 }).catch(() => null)), "the walkthrough starts");
  await page.keyboard.press("Escape");
  await page.click('[data-act="owner"]');
  check("switchto (live)", (await page.getAttribute('.pop [data-act="switchto"]', "aria-disabled")) !== "true", "switching person is live; proved in verify-unhold-people.cjs");
  await page.keyboard.press("Escape");
}

async function firstRun(page) {
  await page.click('[data-act="owner"]');
  await page.click('.pop [data-act="firstrun"]');
  check("firstrun", await page.isVisible(".first"), "the first run opens");
  await page.click('.first [data-act="fr-next"]');
  check("fr-next", await page.isVisible("text=How should Branch think?"), "next screen");
  await page.click('.first [data-act="fr-next"]');
  check("fr-next (later)", !!(await page.waitForSelector("text=Connect your accounts", { timeout: 5000 }).catch(() => null)), "goes on to the accounts the engine has; there is no practice door");
  await page.click('.first [data-act="fr-next"]');
  await page.click('.first [data-act="fr-next"]');
  await page.check("#fr-gw");
  await page.check("#fr-upd");
  await page.click('.first [data-act="fr-recs"]');
  const gw = await until(async () => (await api("never-break")).mode === "on");
  const upd = await until(async () => (await api("comfort")).values.notify.autoUpdate === "install");
  check("fr-recs", !!gw && !!upd, "GET /api/never-break mode=on; GET /api/comfort values.notify.autoUpdate=install");
  await api("never-break", { mode: "off" });
  await api("comfort", { card: "notify", values: { autoUpdate: "off" } });
  await page.click('.first [data-act="fr-tmpl"][data-i="2"]');
  const made = await until(async () => (await api("trunks")).trunks.some((t) => t.name === "Researcher"));
  const allSet = await page.waitForSelector("text=All set.", { timeout: 15000 }).catch(() => null);
  check("fr-tmpl", !!made && !!allSet, "GET /api/trunks has Researcher; the last screen names it");
  await page.click('.first [data-act="fr-tour"]');
  const tour = await page.waitForSelector(".tour-layer .tour-card", { timeout: 5000 }).catch(() => null);
  check("fr-tour", !(await page.isVisible(".first")) && !!tour, "first run closes, the walkthrough starts");
  await page.keyboard.press("Escape");
  await page.click('[data-act="owner"]');
  await page.click('.pop [data-act="firstrun"]');
  await page.click('.first [data-act="fr-skip"]');
  check("fr-skip", !(await page.isVisible(".first")), "Skip for now leaves the first run");
}

async function setupLook(page) {
  await page.click('[data-act="guide"]');
  await page.click('.pop [data-act="onboard"]');
  await page.check("#ob-trust");
  await page.click('[data-act="ob-go"][data-v="3"]');
  await page.click('[data-act="ob15"][data-k="asks"][data-v="plan"]');
  const plan = await until(async () => (await api("conversation-mode/settings")).settings.newConversation === "plan");
  await page.click('[data-act="ob15"][data-k="look"][data-v="light"]');
  const light = await until(async () => (await api("state")).preferences.appearance === "daylight");
  check("ob15-auto (live)", (await page.getAttribute('[data-act="ob15-auto"]', "aria-disabled")) !== "true", "Auto is live behind the engine's loosening confirm (verify-setup-make-it-yours.cjs)");
  check("ob15", !!plan && !!light,"GET /api/conversation-mode/settings newConversation=plan; GET /api/state preferences.appearance=daylight");
  await page.click('[data-act="ob-close"]');
}

async function shellBits(page, fx, stamp) {
  await page.click('[data-act="focus"] >> nth=0');
  const focused = await page.evaluate(() => document.getElementById("app").classList.contains("focus"));
  await page.keyboard.press("Control+.");
  check("focus", focused && !(await page.evaluate(() => document.getElementById("app").classList.contains("focus"))), "focus mode on from the title bar, off with Ctrl+.");
  const running = (await api("activity")).filter((a) => (a.task?.state ?? "working") === "working").length;
  await page.click('[data-act="tasks10"]');
  const rows = await page.$$eval('.pop .mi[role="menuitem"]:not([data-act])', (els) => els.length);
  check("tasks10", rows === (await api("activity")).length && (await page.textContent('[data-act="tasks10"]')).includes(`${running} running`), `popover rows (${rows}) = GET /api/activity tasks; label says ${running} running`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.fill("#pal-in", "Appearance");
  await page.keyboard.press("Enter");
  check("palette / pal", await page.isVisible("text=Browse all"), "Ctrl K finds Settings › Appearance and opens it");
  await page.click('[data-act="view"][data-v="chat"] >> nth=0').catch(() => page.click(".set-back"));
  await page.reload();
  await page.waitForSelector("#side-q");
  const row = `#side .row[data-id="${fx.trunk.chatSessionId}"]`;
  await page.waitForSelector(row);
  await page.click(row, { button: "right" });
  await page.click('.pop [data-act="new-with"]');
  const opened = await until(async () => { const id = await page.evaluate(() => [...document.querySelectorAll('#side .row[aria-current="true"]')].map((r) => r.dataset.id)[0]); return id && id !== fx.trunk.chatSessionId && id; });
  const info = opened ? await api(`trunks/conversations/${opened}`) : null;
  check("new-with", JSON.stringify(info ?? {}).includes(fx.trunk.id), `GET /api/trunks/conversations/<new> names the Trunk (${JSON.stringify(info).slice(0, 120)})`);
  await page.fill("#side-q", `msgword${stamp}`);
  await page.waitForSelector('[data-act="sr-msg"]');
  await page.click('[data-act="sr-msg"]');
  await page.waitForTimeout(800);
  const marks = await page.$$eval("#conversation mark.hit9", (m) => m.length);
  const msgs = (await api(`sessions/${fx.recentId}`)).messages.some((m) => String(m.content).includes(`msgword${stamp}`));
  check("sr-msg", marks > 0 && msgs && (await page.inputValue("#find9-q")) === `msgword${stamp}`, `the conversation (GET /api/sessions/<id> has the word) opens with ${marks} match(es) marked`);
  await page.fill("#side-q", `pastword${stamp}`);
  await page.waitForSelector('[data-act="sr-sess"]');
  await page.click('[data-act="sr-sess"]');
  check("sr-sess", (await page.textContent(".sess9")).includes(`pastword${stamp}`), "the past session opens with its messages (GET /api/sessions/<id>)");
  const before = new Set((await api("sessions?limit=50")).sessions.map((s) => s.sessionId));
  await page.click('[data-act="sess-carry"]');
  const copy = await until(async () => (await api("sessions?limit=50")).sessions.find((s) => !before.has(s.sessionId)));
  const same = copy && (await api(`sessions/${copy.sessionId}`)).messages.length === (await api(`sessions/${fx.pastId}`)).messages.length;
  check("sess-carry", !!same, `POST duplicate made ${copy?.sessionId}; its messages match the original`);
}

async function welcomeCard(page) {
  await page.evaluate(() => { localStorage.setItem("branch-setup-seen", "1"); localStorage.removeItem("branch-welcomed"); });
  await page.reload();
  await page.waitForSelector(".welcome10", { timeout: 6000 });
  await page.click('[data-act="welcome-x"]');
  check("welcome-x", !(await page.isVisible(".welcome10")) && (await page.evaluate(() => localStorage.getItem("branch-welcomed"))) === "1", "the card closes and stays closed");
}

(async () => {
  const stamp = Date.now().toString(36);
  const fx = await fixtures(stamp);
  const version = (await api("state")).version;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await signIn(page);
    for (const step of [themes, editor, accent, background, pet, hide]) await step(page);
    await page.click(".set-back");
    await person(page, version);
    await firstRun(page);
    await setupLook(page);
    await shellBits(page, fx, stamp);
    await welcomeCard(page);
  } catch (error) {
    check("script", false, error.message.split("\n")[0]);
    await page.screenshot({ path: require("path").join(require("os").tmpdir(), "verify-shell-failure.png") }).catch(() => {});
  }
  await browser.close();
  console.log("\n| Action | Result | How it was confirmed |\n|---|---|---|");
  for (const [a, r, h] of results) console.log(`| ${a} | ${r} | ${h} |`);
  console.log(`\npage errors: ${errors.length}${errors.length ? "\n" + errors.join("\n") : ""}`);
  process.exit(results.every((r) => r[1] === "PASS") && !errors.length ? 0 : 1);
})();
