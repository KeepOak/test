/* setup-resume: setup keeps everything, picks up where it was left, and the Guide menu says how far it got; plus the
   "Show tips and pop-ups" switch. It starts its own fresh engine in this process (a scripted model that writes the file
   it is asked to, "Ask before changes" for writing files), so a real approval can wait; nothing reaches a provider and
   nothing outside a temporary folder is touched. Build first (npx tsc -p .), then:
     node design/redesign/tools/verify-setup-resume.cjs
   Proves, each through the engine's own GET routes:
     - a fresh engine lands straight in setup, and a reload while setup is due never shows the window first
     - pass 18c's three steps (Welcome, Models, Your first Trunk): how far setup got is saved as it goes, survives leaving
       halfway, a reload, clearing this browser's storage, and reopening from both Guide entries (Onboarding at the step
       left on, Set up Branch at Welcome)
     - the trust box, once ticked, stays ticked and Start works straight away
     - opening setup and passing every step without changing anything changes no saved setting (the settings table is
       compared whole, before and after)
     - the Guide hint is the engine's count of Overview's eight "Finish setting up" steps done, never Done while any is
       left, also once the wizard is finished
     - Show tips and pop-ups: off in the Guide menu is off in Settings too, keeps the New to Branch? card and setup away
       after a reload, achievements are still counted with nothing handed over to celebrate, and an approval still shows
   Screenshots go to %TEMP%/claude-session-files/setup-resume. */
const { pathToFileURL } = require("node:url");
const { resolve, join } = require("node:path");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");

const load = (name) => {
  return require(name); // the repo's own node_modules
};
const { chromium } = load("playwright");
const dist = (file) => import(pathToFileURL(resolve(__dirname, "../../../dist", file)).href);
const SHOTS = join(process.env.TEMP ?? tmpdir(), "claude-session-files", "setup-resume");
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
let BASE = "", TOKEN = "";
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const until = async (what, probe, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { const got = await probe(); if (got) return got; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 200)); }
};
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
const ob = (page) => page.locator(".ob9");
const at = async (page) => Number(await page.locator('.ob-rail li.now button').getAttribute("data-v"));
const ticks = (page) => page.$$eval(".ob-rail li.done button", (bs) => bs.map((b) => Number(b.dataset.v)));
const pressedIn = (page, sel) => page.locator(`.ob9 ${sel}`).getAttribute("aria-pressed");
const onboarding = () => api("onboarding");
const FINISH = ["where", "yours", "reach", "tools", "keep", "people", "more", "check"]; // Overview's Finish setting up
const go = async (page, i) => { await page.locator(`.ob-rail [data-act="ob-go"][data-v="${i}"]`).click(); await until(`step ${i}`, async () => (await at(page)) === i); };
const next = async (page) => { const was = await at(page); await page.locator('.ob9 [data-act="ob-next"]').click(); await until("the next step", async () => (await at(page)) !== was); };
const skip = async (page) => { await page.locator('.ob9 [data-act="ob-close"]').click(); await ob(page).waitFor({ state: "detached" }); await settle(page, 600); };
async function guide(page) {
  await page.locator('[data-act="guide"]').first().click();
  await page.locator('.pop [data-act="onboard-resume"]').waitFor();
}
const hintText = (page) => page.locator('.pop [data-act="onboard-resume"] .r').innerText().catch(() => "");
const closePop = async (page) => { if (await page.locator(".pop").count()) { await page.keyboard.press("Escape"); await settle(page, 200); } };

/* From the very start of a page, what is on screen after every change: whether the window (its sidebar, drawn and
   visible) was ever shown while setup was not, before setup appeared. */
const PROBE = () => {
  window.__probe = { shellBeforeSetup: false, sawSetup: false, shellSeen: false };
  const look = () => {
    const p = window.__probe, side = document.getElementById("side"), body = document.getElementById("body");
    if (document.querySelector(".ob9")) { p.sawSetup = true; return; }
    const shown = side && side.children.length > 0 && body && getComputedStyle(body).visibility !== "hidden";
    if (shown) { p.shellSeen = true; if (!p.sawSetup) p.shellBeforeSetup = true; }
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  const frame = () => { look(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
};
const probe = (page) => page.evaluate(() => window.__probe);

/* The whole settings table, but for the setup record itself and the achievements' own tally (written by any look at
   the achievements, which is bookkeeping, not a setting), plus the Trunks and what the engine says for each choice. */
async function snapshot(app) {
  const rows = app.store.list("settings", app.runtime.owner).filter((r) => !["onboarding", "delight-achievements"].includes(r.id))
    .map((r) => [r.id, JSON.stringify(r.data)]).sort(([a], [b]) => a.localeCompare(b));
  const [mode, gw, comfort, trunks] = await Promise.all([api("conversation-mode/settings"), api("never-break"), api("comfort"), api("trunks")]);
  return { rows: Object.fromEntries(rows), mode: mode.settings, gw: gw.mode, comfort: comfort.values, trunks: (trunks.trunks ?? []).map((t) => t.name).sort() };
}
function diff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.rows), ...Object.keys(b.rows)])) if (a.rows[k] !== b.rows[k]) out.push(`settings/${k}`);
  for (const k of ["mode", "gw", "comfort", "trunks"]) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  return out;
}

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}
async function reload(page) {
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "attached", timeout: 60000 });
  await settle(page, 1800);
}

/* 1. A fresh engine: setup is due, and the window lands in it with nothing of the window shown first. */
async function freshLanding(page) {
  await signIn(page);
  await ob(page).waitFor({ state: "visible", timeout: 30000 });
  const p = await probe(page);
  check("fresh engine: the window lands in setup, never showing the window first", p.sawSetup && !p.shellBeforeSetup, JSON.stringify(p));
  check("fresh engine: setup opens at Welcome with the box unticked", (await at(page)) === 0 && !(await page.locator("#ob-trust").isChecked()));
  const view = await onboarding();
  check("fresh engine: progress is 0 (GET /api/onboarding)", view.completed.length === 0 && !view.trust, JSON.stringify(view.completed));
  await shot(page, "01-fresh-welcome");
}

/* 2. The three steps: each is saved as it is passed; then setup is left halfway. */
async function makeChoices(page) {
  await page.locator(".ob9 .ob-agree").click();
  await until("the trust box saved", async () => (await onboarding()).trust === true);
  check("Welcome: ticking the box is saved with when (GET /api/onboarding trust, trustAt)", (await onboarding()).trustAt);
  await next(page); // Start
  check("Start goes to Models", (await at(page)) === 1);
  await next(page); // Your first Trunk
  // The owner's own path: the setup that opened by itself, a step in, and a plain reload (nothing cleared).
  await until("the step saved", async () => (await onboarding()).step === "trunks");
  await page.reload();
  await ob(page).waitFor({ state: "visible", timeout: 30000 });
  const p = await probe(page);
  check("a plain reload mid-setup goes straight back to setup, the window never shown first", p.sawSetup && !p.shellBeforeSetup, JSON.stringify(p));
  check("and resumes at the step it was on (Your first Trunk)", (await at(page)) === 2, String(await at(page)));
  await page.locator('.ob9 [data-act="ob-tpl"][data-i="0"]').click();
  const tplName = await page.locator('.ob9 [data-act="ob-tpl"][data-i="0"] b').innerText();
  await shot(page, "02-halfway-trunks");
  const before = await onboarding();
  await skip(page); // straight from the step, the pick not yet made
  const trunks = await until("the Trunk", async () => (await api("trunks")).trunks.some((t) => t.name === tplName));
  check("Trunks: a template picked and then Skip for now is still made (GET /api/trunks)", trunks, tplName);
  const after = await onboarding();
  check("leaving halfway keeps the step and the steps done (GET /api/onboarding)", after.step === "trunks" && ["welcome", "models", "trunks"].every((id) => after.completed.includes(id)), `${after.step} · ${after.completed}`);
  check("leaving halfway is noted as skipped, and changes nothing else", after.skipped === true && after.trust === true && !after.finishedAt && before.trust === true);
  return tplName;
}

/* 3. Reload, clear this browser's storage, reopen from both Guide entries: everything is as it was saved. */
async function reopen(page, tplName) {
  await reload(page);
  check("after skipping, a reload lands in the window (setup is not due)", (await ob(page).count()) === 0);
  await guide(page);
  const view = await onboarding(), n = FINISH.filter((id) => view.completed.includes(id)).length;
  const hint = await hintText(page);
  check("Guide: the Onboarding hint is the engine's count of the Finish setting up steps", hint === `${n} of 8 done`, hint);
  check("Guide: Set up Branch is still there", (await page.locator('.pop [data-act="onboard"]').count()) === 1);

  await shot(page, "03-guide-menu");
  await page.locator('.pop [data-act="onboard-resume"]').click();
  await ob(page).waitFor();
  check("Guide › Onboarding opens at the step left on (Your first Trunk)", (await at(page)) === 2, String(await at(page)));
  const ticked = await ticks(page);
  check("the rail ticks the steps done", [0, 1].every((j) => ticked.includes(j)), JSON.stringify(ticked));
  await go(page, 1);
  await go(page, 2);
  check("Trunks shows the Trunk made as made", (await pressedIn(page, '[data-act="ob-tpl"][data-i="0"]')) === "true", tplName);
  await shot(page, "04-reopened-trunks");
  // Setup was opened again and not left: a reload goes straight back to it, at the step it was on.
  check("opening setup again means it is no longer skipped (GET /api/onboarding)", (await onboarding()).skipped === false);
  await page.reload(); // this browser's storage as it is
  await ob(page).waitFor({ state: "visible", timeout: 30000 });
  let p = await probe(page);
  check("after reopening from the Guide, a plain reload goes straight into setup, the window never shown first", p.sawSetup && !p.shellBeforeSetup, JSON.stringify(p));
  check("at the saved step", (await at(page)) === 2, String(await at(page)));
  await page.evaluate(() => { try { localStorage.clear(); } catch (error) { return error.message; } return ""; });
  await page.reload();
  await ob(page).waitFor({ state: "visible", timeout: 30000 });
  p = await probe(page);
  check("with this browser's storage cleared, a reload still goes straight into setup", p.sawSetup && !p.shellBeforeSetup, JSON.stringify(p));
  check("and resumes at the saved step (the engine's)", (await at(page)) === 2, String(await at(page)));
  await shot(page, "05-reload-straight-to-setup");
  await skip(page);
  await guide(page);
  await page.locator('.pop [data-act="onboard"]').click();
  await ob(page).waitFor();
  check("Guide › Set up Branch opens at Welcome", (await at(page)) === 0);
  check("the trust box stays ticked, and Start works straight away", await page.locator("#ob-trust").isChecked());
  await page.locator(".ob9 .ob-agree").click(); // an untick is refused
  check("the trust box cannot be unticked once accepted", await page.locator("#ob-trust").isChecked() && (await onboarding()).trust === true);
  await next(page);
  check("Start goes on without asking again", (await at(page)) === 1);
  await skip(page);
}

/* 4. (Pass 18c: Keep it running and Make it yours are no longer setup steps; they wait on Overview's Finish setting up,
   which opens their Settings pages, so there is nothing of theirs to show in setup.)
   5. Opening setup and passing every step without changing anything changes no saved setting. */
async function passThrough(page, app) {
  const before = await snapshot(app);
  await guide(page);
  await page.locator('.pop [data-act="onboard"]').click();
  await ob(page).waitFor();
  for (let i = 0; i < 2; i++) await next(page);
  await shot(page, "07-passed-every-step");
  await skip(page);
  await settle(page, 800);
  const after = await snapshot(app);
  const changed = diff(before, after);
  check("passing every step without changes changes no saved setting (settings table, mode, gateway, comfort, Trunks)", changed.length === 0, changed.join(", ") || `${Object.keys(before.rows).length} settings compared`);
}

/* 6. Show tips and pop-ups. */
async function popups(page, app) {
  await reload(page);
  const card = page.locator(".welcome10");
  await card.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  check("control: with tips on, the New to Branch? card shows after setup was left", await card.isVisible());
  check("the card has Don't show again next to ×", (await card.locator('[data-act="welcome-never"]').count()) === 1);
  await card.locator('[data-act="welcome-x"]').click();
  await reload(page);
  await card.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  check("× only hides it for now: after a reload it is back", await card.isVisible());
  await guide(page);
  check("Guide: the Show tips and pop-ups switch is on", await page.locator("#guide-popups").isChecked());
  await page.locator("#guide-popups").click({ force: true });
  await until("popups off", async () => (await onboarding()).popups === false);
  check("Guide switch off is saved (GET /api/onboarding popups)", true);
  await shot(page, "08-guide-popups-off");
  await closePop(page);
  check("the card goes at once", (await card.count()) === 0);
  await page.evaluate(() => { try { localStorage.clear(); } catch (error) { return error.message; } return ""; });
  await api("onboarding", { skipped: false }); // setup would be due again, were pop-ups on
  await reload(page);
  await settle(page, 1500);
  check("pop-ups off: after a reload (storage cleared) neither setup nor the card shows", (await ob(page).count()) === 0 && (await card.count()) === 0);
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setpage"][data-v="notifications"]').first().click();
  await settle(page, 1000);
  check("Settings › Notifications shows the same switch, off", (await page.locator("#set-popups").count()) === 1 && !(await page.locator("#set-popups").isChecked()));
  await shot(page, "09-settings-popups-off");
  await page.locator("#set-popups").click({ force: true });
  await until("popups on", async () => (await onboarding()).popups === true);
  check("the Settings switch turns them back on (GET /api/onboarding popups)", true);
  await page.keyboard.press("Escape");
  await api("onboarding", { skipped: true });
  await reload(page);
  await card.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  await card.locator('[data-act="welcome-never"]').click();
  await until("welcomed", async () => (await onboarding()).welcomed === true);
  await reload(page);
  await settle(page, 1500);
  check("Don't show again is kept by the engine: no card after a reload", (await card.count()) === 0);
}

/* 7. Finishing: the wizard's last step ends setup; the Guide still counts what waits on Overview, and reopening lands
   on the last step. */
async function finish(page) {
  await guide(page);
  await page.locator('.pop [data-act="onboard-resume"]').click();
  await ob(page).waitFor();
  await go(page, 2);
  await page.locator('.ob9 [data-act="ob-done"]').click();
  await ob(page).waitFor({ state: "detached" });
  const view = await onboarding();
  check("finishing marks setup done (GET /api/onboarding done, finishedAt)", view.done && view.finishedAt);
  await settle(page, 1200);
  await page.locator('[data-act="tour-end"]').click().catch(() => undefined);
  await guide(page);
  const n = FINISH.filter((id) => view.completed.includes(id)).length;
  check("Guide: the Onboarding hint still counts the Finish setting up steps, not Done", (await hintText(page)) === `${n} of 8 done`, await hintText(page));
  await page.locator('.pop [data-act="onboard-resume"]').click();
  await ob(page).waitFor();
  check("reopening after finishing lands on the last step", (await at(page)) === 2);
  await shot(page, "10-finished-reopened");
  await skip(page);
}

/* 8. With pop-ups off, an approval still shows, and achievements are counted with none handed over to celebrate. */
async function approvalsStay(page) {
  await api("onboarding", { popups: false });
  const earnedBefore = (await api("delight/achievements")).earned;
  await reload(page);
  await page.evaluate(() => { window.__party = false; new MutationObserver(() => { if (document.querySelector(".ach-toast, .ach-big")) window.__party = true; }).observe(document.body, { childList: true, subtree: true }); });
  await page.locator("#prompt").fill("write kept.txt");
  await page.locator("#send").click();
  const ask = page.locator("#live-ask");
  await ask.waitFor({ state: "visible", timeout: 30000 });
  check("pop-ups off: the approval card still shows", await ask.isVisible());
  await shot(page, "11-approval-with-popups-off");
  await ask.getByRole("button", { name: "Allow once", exact: true }).click().catch(() => ask.locator("button").first().click());
  await settle(page, 2500);
  const view = await api("delight/achievements");
  check("pop-ups off: achievements still counted, none handed over to celebrate (GET /api/delight/achievements)", view.earned > earnedBefore && view.fresh.length === 0, `${earnedBefore} → ${view.earned}, fresh ${view.fresh.length}`);
  await settle(page, 12000);
  check("pop-ups off: no achievement pop-up appeared", !(await page.evaluate(() => window.__party)));
}

(async () => {
  const root = mkdtempSync(join(tmpdir(), "branch-verify-setup-resume-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  const { createBranch } = await dist("index.js");
  const { startServer } = await dist("server.js");
  const { readPolicy, savePolicy } = await dist("policy.js");
  const writer = { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { content: "Written.", toolCalls: [] };
    const asked = [...request.messages].reverse().find((m) => m.role === "user" && /^write \S+/.test(String(m.content)));
    if (last?.role === "user" && asked)
      return { content: "", toolCalls: [{ id: `w${Date.now()}`, name: "files.write", arguments: JSON.stringify({ path: String(asked.content).slice(6).trim(), content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace, dataDir, provider: writer });
  savePolicy(app.store, app.runtime.owner, { ...readPolicy(app.store, app.runtime.owner), rules: [{ tool: "files.write", decision: "ask" }] });
  const server = await startServer(app, { dataDir, port: Number(process.env.PORT ?? 0) });
  BASE = server.url.replace(/\/$/, ""); TOKEN = server.token;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(PROBE);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("delight/achievements"); // the first look finds the past quietly, as a person's first look does
    await freshLanding(page);
    const tplName = await makeChoices(page);
    await reopen(page, tplName);
    await passThrough(page, app);
    await popups(page, app);
    await finish(page);
    await approvalsStay(page);
  } catch (error) {
    check("the run finished", false, error.message);
    await shot(page, "zz-failure").catch(() => undefined);
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  await server.close();
  await app.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
