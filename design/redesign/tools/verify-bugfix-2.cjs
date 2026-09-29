// Proves each fix of the places-and-people bug round (the test port's findings) against a real engine, through the
// engine's own GET routes, and records every page error. On a FRESH, seeded engine:
//   1. engine stopped:  BRANCH_DATA_DIR=<data> BRANCH_WORKSPACE=<ws> node design/redesign/tools/seed-bugfix-2.mjs
//   2. start:           BRANCH_DATA_DIR=<data> BRANCH_WORKSPACE=<ws> BRANCH_PORT=<port> node dist/cli.js start
//   3.                  PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-2.cjs
// It must run before anything marks onboarding done: the first check is that setup opens under automation.
"use strict";
const { chromium } = require("playwright");

const { PORT, TOKEN } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN"); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
async function api(route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`${route}: ${r.status} ${data.error ?? ""}`); e.status = r.status; throw e; }
  return data;
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, ms = 15000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await pause(250)) { const v = await test(); if (v) return v; }
  throw new Error("timed out: " + what);
}
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };
const errors = [];

async function signIn(page) {
  await page.goto(BASE);
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}
const openChat = async (page, sid) => { await page.locator(`#side [data-act="chat"][data-id="${sid}"]`).first().click(); await page.locator("#conversation").waitFor(); };
const openPlace = async (page, view, tab) => {
  await page.locator(`#side [data-act="view"][data-v="${view}"]`).first().click();
  if (tab) await page.locator(`#main .place [data-act="ptab"][data-v="${tab}"]`).first().click();
};

/* 17 and 16: setup opens under automation while onboarding is not done; the recommendation bar follows first run. */
async function firstRun(page) {
  check((await api("state")).onboarding?.done === false, "17 fresh engine: GET /api/state onboarding.done is false");
  await signIn(page);
  const opened = await page.locator(".ob9").waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false);
  check(opened && await page.evaluate(() => navigator.webdriver) === true, "17 setup opens with navigator.webdriver set");
  check((await api("deployment/suggestion")).bar === null && await page.locator(".recbar").count() === 0, "16 before first run: no bar (GET /api/deployment/suggestion bar null)");
  await page.keyboard.press("Escape"); // setup has no close button now: Escape leaves any step (Skip shows only after Welcome)
  await page.locator(".ob9").waitFor({ state: "hidden", timeout: 10000 });
  // The updates bar is offered only while "update by itself" is off (src/suggestions.ts); it ships on (install), so it
  // is switched off here, as an owner who turned it off would have it.
  await api("comfort", { card: "notify", values: { autoUpdate: "off" } });
  await api("onboarding", { done: true });
  const bar = (await api("deployment/suggestion")).bar;
  await api("run", { prompt: "hello" }); // any engine event makes the window read its state again
  // The bar lives in Inbox and Overview now (places/inbox.js, overview.js recBar), not above the message box.
  await page.locator('#side [data-act="view"][data-v="inbox"]').first().click();
  const shown = await page.locator(".recbar").first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
  check(bar === "updates" && shown && /up to date/.test(await page.locator(".recbar").first().innerText()), `16 after first run the bar follows in Inbox without a reload (engine bar: ${bar})`);
}

/* 13: the chart card, Open larger, and Save to Library kept beside the task and listed in Made for you. */
async function chart(page, seed) {
  await openChat(page, seed.chartSession);
  const card = page.locator("#conversation .card.art").first();
  await card.waitFor({ timeout: 10000 });
  check(await card.locator("svg rect").count() === 3 && /Cups by day/.test(await card.locator(".card-h b").innerText()), "13 a ```chart block is the chart card: three bars and its title");
  // Copy code is live: it puts the block's own code on the clipboard (chat/chart.js copyCode).
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await card.locator('[data-act="art-copy"]').click();
  const copied = await until("the code copied", async () => { const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => ""); return /"title":"Cups by day"/.test(text) ? text : null; });
  check(!!copied, "13 Copy code puts the chart's own code on the clipboard");
  await card.locator('[data-act="artbig"]').click();
  check(await page.locator(".dlg svg.chart rect").count() === 3, "13 Open larger redraws it in a dialog");
  await page.locator('.dlg [data-act="dlg-close"]').click();
  const save = card.getByRole("button", { name: "Save to Library", exact: true });
  check(await save.getAttribute("data-run") === seed.chartRun, "13 Save to Library names the task that wrote the reply (GET /api/state runs)");
  await save.click();
  const kept = await until("the chart kept", async () => (await api("artifacts")).artifacts.find((a) => a.name === "artifact-cups-by-day.svg" && a.runId === seed.chartRun));
  // The listing guesses a type from the name; the file itself is read back from the engine's folder on this computer.
  const svg = require("node:fs").readFileSync(kept.path, "utf8");
  check(/^<svg /.test(svg) && (svg.match(/<rect /g) ?? []).length === 3 && !svg.includes("var(--"), `13 GET /api/artifacts lists ${kept.name} under the task; the file is the chart with its colours written in`);
  await openPlace(page, "library", "made");
  const listed = await page.locator("#main .place .prow", { hasText: "artifact-cups-by-day.svg" }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
  check(listed, "13 Library › Made for you lists it");
}

/* 14: each fact shows where it came from. */
async function facts(page) {
  const fact = (await api("state")).memory[0];
  await openPlace(page, "library", "memory");
  const row = page.locator("#main .place .prow", { hasText: fact.data.text }).first();
  await row.waitFor({ timeout: 10000 });
  check((await row.locator("small").innerText()).includes(fact.data.source), `14 the fact shows its source (GET /api/state memory[].data.source: "${fact.data.source}")`);
}

/* 15: the task waiting for an answer is in the background popover; the count stays working tasks only. */
async function waiting(page, seed) {
  const listed = await api("activity?waiting=1");
  const ask = listed.find((a) => a.runId === seed.waitingRun);
  check(ask?.task?.state === "waiting-owner", "15 GET /api/activity?waiting=1 lists the waiting task");
  await page.locator('[data-act="tasks10"]').first().click();
  const row = page.locator(".pop .mi", { hasText: "Write the notes file." }).first();
  const shown = await row.waitFor({ timeout: 8000 }).then(() => true, () => false);
  check(shown && await row.locator(".ico svg").count() > 0, "15 the popover shows the waiting task");
  check(/^0 running/.test((await page.locator('[data-act="tasks10"]').first().innerText()).trim()), "15 the count still counts working tasks only");
  await page.keyboard.press("Escape");
}

/* 10: with the "conversations" part off, Who answers offers only the default Trunk (chat/plus.js whoRows: another Trunk
   is left out, not drawn greyed); on, the other Trunks are offered too. A Trunk of its own is made, so it is never the
   default one (#726). */
async function whoAnswers(page, seed) {
  const before = (await api("trunks")).modes;
  await api("trunks/switch", { part: "trunks", mode: "on" });
  await api("trunks/switch", { part: "conversations", mode: "off" }); // it ships on now; switched off to see the refusal
  const trunk = (await api("trunks", { name: "Verify" })).trunk;
  const refused = await api(`trunks/conversations/${seed.chartSession}`, { trunkId: trunk.id }).then(() => false, () => true);
  check((await api("trunks")).modes.conversations === "off" && refused, "10 with conversations off the engine refuses a Trunk (POST /api/trunks/conversations/<id>)");
  const row = async () => {
    await page.reload(); await page.locator("#app #side").waitFor({ timeout: 60000 });
    await openChat(page, seed.chartSession);
    await page.waitForTimeout(500);
    await page.locator('[data-act="plusmenu"]').click();
    const home = page.locator('.pop [data-act="who"][data-v=""]');
    await home.waitFor({ timeout: 8000 });
    const r = page.locator(`.pop [data-act="who"][data-v="${trunk.id}"]`);
    const out = { offered: (await r.count()) > 0 && !(await r.isDisabled()), home: !(await home.isDisabled()) };
    await page.keyboard.press("Escape");
    return out;
  };
  const off = await row();
  check(!off.offered && off.home, "10 while conversations is off only the default Trunk is offered");
  await api("trunks/switch", { part: "conversations", mode: "on" });
  const on = await row();
  check(on.offered && on.home, "10 with conversations on the other Trunk is offered too");
  await api("trunks/switch", { part: "conversations", mode: before.conversations });
  await api("trunks/switch", { part: "trunks", mode: before.trunks });
}

/* 2 and 3: Settings › People and Team › People list everyone; Team › Signing in draws the engine's sign-in card, greyed. */
async function people(page, person) {
  const profiles = await api("profiles");
  await page.reload(); await page.locator("#app #side").waitFor({ timeout: 60000 });
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="people"]').first().click();
  const item = page.locator('.set-page [data-act="p-sel"]', { hasText: person.name });
  await item.waitFor({ timeout: 10000 });
  check(await page.locator('.set-page [data-act="p-sel"]').count() === profiles.profiles.length + 1, `2 Settings › People lists the owner and each of GET /api/profiles' ${profiles.profiles.length} profile(s)`);
  await page.locator('[data-act="p-open-team"][data-v="signin"]').click();
  const seg = page.locator('#main .place [role="group"][aria-label="Let people sign in from their own device"]');
  await seg.waitFor({ timeout: 10000 });
  const card = await api("people/settings");
  check(await seg.locator(`[data-v="${card.settings.mode}"]`).getAttribute("aria-pressed") === "true", `3 Signing in shows the engine's mode (GET /api/people/settings mode: ${card.settings.mode})`);
  check(await page.locator('#main .place [aria-label="How they prove it’s them"] [data-v="pin"]').getAttribute("aria-pressed") === String(card.settings.chain.includes("pin")), "3 Signing in shows the engine's sign-in chain");
  // unhold/people: the sign-in controls are live (proved in verify-unhold-people.cjs); "Lock a profile after five wrong
  // PINs" is what the engine always does, so it is words with no control.
  const states = await page.evaluate(() => [...document.querySelectorAll('#main .place [data-act^="si-"], #main .place input[id^="si-"]')].map((el) => [el.id || el.dataset.act, el.getAttribute("aria-disabled") === "true"]));
  check(states.length > 0 && states.every(([, grey]) => !grey), "3 every sign-in control is live", JSON.stringify(states.filter(([, grey]) => grey)));
  check((await page.locator('#main .place [data-fact="si-lock"]').count()) === 1 && (await page.locator("#si-lock").count()) === 0, "3 the fixed PIN lockout is said in words, with no switch");
  await page.locator('#main .place [data-act="ptab"][data-v="people"]').click();
  const row = page.locator('#main .place [data-act="p-sel"]', { hasText: person.name });
  await row.waitFor({ timeout: 10000 });
  check(await page.locator('#main .place [data-act="p-sel"]').count() === profiles.profiles.length + 1, "3 Team › People lists everyone, not only the person here");
  await row.click();
  const device = (card.people.find((p) => p.id === person.id)?.signedIn ?? [])[0]?.device;
  const signedOn = await page.locator("#main .place .pcard10 dl").innerText();
  check(device ? signedOn.includes(device) : !/Signed in on/.test(signedOn), `3 the card's "Signed in on" follows GET /api/people/settings signedIn (${device ?? "none"})`);
}

/* 4: the /people page starts and a person signs in with their PIN. */
async function peoplePage(browser, person) {
  check((await fetch(`${BASE}/i18n.js`)).status === 200 && (await fetch(`${BASE}/people`)).status === 200, "4 /i18n.js and /people are served while signing in is on");
  const phone = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const seen = [];
  phone.on("pageerror", (e) => seen.push(e.message));
  await phone.goto(`${BASE}/people`);
  await phone.getByLabel("Your name").first().fill(person.name);
  await phone.getByRole("button", { name: "Next" }).click();
  await phone.getByLabel("Your PIN").fill(person.pin);
  await phone.getByRole("button", { name: "Check my PIN" }).click();
  const hello = await phone.getByText(`Hello, ${person.name}`).waitFor({ timeout: 10000 }).then(() => true, () => false);
  const keys = (await api("people/settings")).people.find((p) => p.id === person.id)?.signedIn ?? [];
  check(hello && keys.length === 1 && seen.length === 0, `4 the /people page signs ${person.name} in (GET /api/people/settings signedIn: ${keys.length}), no page errors`);
  errors.push(...seen);
  await phone.close();
}

(async () => {
  const seed = { chartSession: "", chartRun: "", waitingRun: "" };
  const runs = (await api("state")).runs;
  const chartRun = runs.find((r) => String(r.output).includes("```chart"));
  Object.assign(seed, { chartRun: chartRun?.id, chartSession: chartRun?.sessionId, waitingRun: runs.find((r) => r.status === "needs_input")?.id });
  if (!seed.chartRun || !seed.waitingRun) { console.error("Seed the engine first (seed-bugfix-2.mjs)"); process.exit(2); }
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 }, serviceWorkers: "block" })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const settingsBefore = (await api("people/settings")).settings.mode;
  try {
    await firstRun(page);
    await chart(page, seed);
    await facts(page);
    await waiting(page, seed);
    await whoAnswers(page, seed);
    const person = { name: `Verify ${Date.now().toString(36)}`, pin: "4826" };
    person.id = (await api("profiles", person)).id;
    await api("people/settings", { mode: "on" });
    await peoplePage(browser, person);
    await people(page, person);
  } catch (error) { check(false, error.message); }
  await api("people/settings", { mode: settingsBefore }).catch((e) => console.log("restore sign-in switch:", e.message));
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await browser.close();
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
})();
