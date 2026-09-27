/* rw4/people-card: the person card's Trunks row and the owner-only People actions, against a fresh engine.
   It starts its OWN engine (a new temp data folder, on PORT), then stops it and removes the folder:
     npx tsc -p . && PORT=<free port> node design/redesign/tools/verify-people-card.cjs
   1. Trunks: the row lists the Trunks in the rooms a person was let into, read back through GET /api/trunks
      (rooms[].people and members as the owner, rooms[].roster as the person), "—" when there are none. Kim is let into a
      room while the window is open, so the row is proved to follow the engine, not the list read at sign-in.
   2. Owner-only actions (invite, role, one-time code, sign out, remove, owner PIN, Signing in): drawn for the owner, and
      not drawn at all (count 0, not greyed) once a household person is at the window, both right after the switch
      (before the window starts again) and after it has. Switching to somebody else stays theirs.
   PINs are made up here and never printed. */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { randomInt } = require("node:crypto");
const { join } = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.PORT || 3791);
const BASE = `http://127.0.0.1:${PORT}`;
const pin = () => String(randomInt(100000, 999999)) + String(randomInt(10, 99));
const KIM_PIN = pin(), SAM_PIN = pin();
let TOKEN = "";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const count = (page, sel) => page.locator(sel).count();

/* The Trunks the engine lets this person reach through rooms, in seating order: what the card must say. */
async function engineTrunks(id) {
  const answer = await api("trunks");
  const named = new Map((answer.trunks ?? []).map((t) => [t.id, t.name]));
  const names = [];
  for (const room of answer.rooms ?? []) {
    if (!(room.people ?? []).includes(id)) continue;
    for (const t of room.roster ?? room.members.map((m) => ({ name: named.get(m) }))) if (t.name && !names.includes(t.name)) names.push(t.name);
  }
  return names.length ? names.join(", ") : "—";
}

async function openPeople(page) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator('[data-act="setpage"][data-v="general"]').first().click();
  await settle(page, 400);
  await page.locator('[data-act="setpage"][data-v="people"]').first().click();
  await settle(page, 1200);
}
async function cardOf(page, id) {
  await page.locator(`[data-act="p-sel"][data-v="${id}"]`).first().click();
  await settle(page, 300);
  return page.locator(".pcard10");
}
const trunksRow = (card) => card.locator("dl.kv").evaluate((list) => [...list.querySelectorAll("dt")].find((d) => d.textContent === "Trunks")?.nextElementSibling.textContent ?? null);
async function openTeam(page, tab) {
  await page.locator('#side [data-act="view"][data-v="team"]').first().click();
  await settle(page, 500);
  const button = page.locator(`#main .place [data-act="ptab"][data-v="${tab}"]`).first();
  if (await button.count()) { await button.click(); await settle(page, 900); }
  return button;
}
async function personMenuInvite(page) {
  await page.locator('[data-act="owner"]').first().click();
  await settle(page, 300);
  const n = await count(page, '.pop [data-act="invite"]');
  await page.keyboard.press("Escape");
  await settle(page, 200);
  return n;
}
async function overviewInvite(page) {
  await page.locator('#side [data-act="view"][data-v="overview"]').first().click();
  await settle(page, 700);
  return count(page, '#main [data-act="invite"]');
}
const OWNER_ONLY = '[data-act="p-invite"], [data-act="p-role"], [data-act="p-code"], [data-act="p-signout"], [data-act="p-remove"], [data-act^="si-"], [data-act="owner-pin-set"], [data-act="p-open-team"][data-v="signin"]';

async function asOwner(page, kim, sam) {
  await openPeople(page);
  let card = await cardOf(page, kim.id);
  check("Trunks: Kim in no room reads \"—\", as GET /api/trunks has it", (await trunksRow(card)) === "—" && (await engineTrunks(kim.id)) === "—");
  const t = {};
  for (const name of ["Scout", "Quill", "Ledger", "Pip"]) t[name] = (await api("trunks", { name })).trunk.id;
  await api("trunks/rooms", { name: "Homework", members: [t.Scout, t.Quill], people: [kim.id] });
  await api("trunks/rooms", { name: "Owner only", members: [t.Ledger, t.Pip], people: [] });
  await openPeople(page);
  card = await cardOf(page, kim.id);
  const shown = await trunksRow(card), expected = await engineTrunks(kim.id);
  check("Trunks: let into a room while the window is open, Kim's card names that room's Trunks (GET /api/trunks rooms)", shown === expected && expected === "Scout, Quill", `${shown} / ${expected}`);
  card = await cardOf(page, sam.id);
  check("Trunks: Sam, in no room, still reads \"—\"", (await trunksRow(card)) === "—" && (await engineTrunks(sam.id)) === "—");
  check("owner: Invite someone, Adult / Child, one-time code, sign out, remove are drawn", await count(page, '[data-act="p-invite"]') === 1 && await count(page, '.pcard10 [data-act="p-role"]') === 2
    && await count(page, '.pcard10 [data-act="p-code"]') === 1 && await count(page, '.pcard10 [data-act="p-signout"]') === 1 && await count(page, '.pcard10 [data-act="p-remove"]') === 1);
  check("owner: Signing in from other devices is drawn", await count(page, '[data-act="p-open-team"][data-v="signin"]') === 1);
  check("owner: the person menu's Add and Overview's Invite someone are drawn", await personMenuInvite(page) === 1 && await overviewInvite(page) === 1);
  await openTeam(page, "signin");
  check("owner: Team › Signing in draws who may sign in and the owner's PIN", await count(page, '[data-act="si-mode"]') === 3 && await count(page, "#si-owner") === 1);
}

/* Switches to Kim from the person menu while Team › Signing in is on screen, and looks before the window starts again. */
async function switchToKim(page, kim) {
  await page.evaluate(() => { window.__beforeSwitch = true; });
  await page.locator('[data-act="owner"]').first().click();
  await page.locator(`.pop [data-act="switchto"][data-v="${kim.id}"]`).click();
  await page.locator("#pin-try").fill(KIM_PIN);
  await page.locator('[data-act="pin-ok"]').click();
  const seen = await page.waitForFunction((sel) => {
    if (!window.__beforeSwitch) return { reloaded: true };
    if (!document.querySelector(".toast")?.textContent.includes("Switched to")) return false;
    return document.querySelector('[data-act="ptab"][data-v="signin"]') ? false : { reloaded: false, left: document.querySelectorAll(sel).length };
  }, OWNER_ONLY, { timeout: 5000, polling: "raf" }).then((h) => h.jsonValue()).catch(() => ({ timedOut: true }));
  check("switch: right after the engine switched (no reload yet), Signing in and every owner-only control are gone", seen.reloaded === false && seen.left === 0, JSON.stringify(seen));
  await page.waitForEvent("load", { timeout: 8000 }).catch(() => null);
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  check("switch: GET /api/profiles says Kim is at the window, and not the owner", (await api("profiles")).active?.id === kim.id && (await api("profiles")).isOwner === false);
}

async function asKim(page, kim, sam) {
  await openPeople(page);
  check("household: Invite someone is not drawn (count 0, not greyed)", await count(page, '[data-act="p-invite"]') === 0);
  check("household: Signing in from other devices is not drawn", await count(page, '[data-act="p-open-team"][data-v="signin"]') === 0);
  let card = await cardOf(page, kim.id);
  const shown = await trunksRow(card), expected = await engineTrunks(kim.id);
  check("household: Kim's own card names the Trunks of the rooms she was let into (GET /api/trunks rooms[].roster)", shown === expected && expected === "Scout, Quill", `${shown} / ${expected}`);
  check("household: Kim's own card has no role, code, sign out, remove, nor a switch to herself", await count(page, ".pcard10 button") === 0);
  card = await cardOf(page, sam.id);
  check("household: Sam's card offers only Switch to Sam", await count(page, '.pcard10 [data-act="p-switch"]') === 1 && await count(page, ".pcard10 button") === 1);
  await cardOf(page, "owner");
  check("household: the owner's card does not say \"You're the owner\"", !(await page.locator(".pcard10").innerText()).includes("You’re the owner"));
  check("household: no owner-only People control anywhere on the page", await count(page, OWNER_ONLY) === 0);
  check("household: the person menu's Add and Overview's Invite someone are not drawn", await personMenuInvite(page) === 0 && await overviewInvite(page) === 0);
  const tab = await openTeam(page, "signin");
  check("household: Team has no Signing in tab", await tab.count() === 0);
  await openTeam(page, "people");
  check("household: Team › People has no owner-only control either", await count(page, OWNER_ONLY) === 0 && await count(page, '[data-act="p-sel"]') === 3);
}

async function backToOwner(page) {
  await api("profiles/switch", { profileId: null });
  await page.waitForEvent("load", { timeout: 8000 }).catch(() => null);
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  await openPeople(page);
  check("owner again: Invite someone is drawn again", (await api("profiles")).isOwner === true && await count(page, '[data-act="p-invite"]') === 1);
}

function startEngine(dir) {
  const engine = spawn(process.execPath, ["dist/cli.js", "start"], { env: { ...process.env, BRANCH_DATA_DIR: join(dir, "data"), BRANCH_PORT: String(PORT) } });
  const token = new Promise((resolve, reject) => {
    engine.stdout.on("data", (d) => { const m = /paste into browser\): ([a-f0-9]+)/.exec(String(d)); if (m) resolve(m[1]); });
    engine.on("exit", (code) => reject(new Error(`the engine stopped (${code})`)));
  });
  return { engine, token };
}

(async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "verify-people-card-"));
  const errors = [];
  const { engine, token } = startEngine(dir);
  let browser;
  try {
    TOKEN = await token;
    await api("onboarding", { done: true });
    for (const part of ["trunks", "rooms"]) await api("trunks/switch", { part, mode: "on" });
    const kim = await api("profiles", { name: "Kim", pin: KIM_PIN });
    const sam = await api("profiles", { name: "Sam", pin: SAM_PIN });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE + "/");
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await settle(page, 1500);
    await asOwner(page, kim, sam);
    await switchToKim(page, kim);
    await asKim(page, kim, sam);
    await backToOwner(page);
  } catch (error) { check("the run finished", false, error.message); }
  finally {
    await browser?.close();
    engine.kill();
    await new Promise((r) => setTimeout(r, 800));
    try { rmSync(dir, { recursive: true, force: true }); } catch (error) { console.log(`left ${dir}: ${error.message}`); }
  }
  check("zero page errors", errors.length === 0, errors.join(" | "));
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
