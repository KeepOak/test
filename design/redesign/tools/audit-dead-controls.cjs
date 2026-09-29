/* Counts the controls each page draws greyed with only the "Coming soon" hover (QA Q002), at the Technical level, on
   every Settings page (each of Models' five tabs), Overview, and every tab of Inbox, Team, Library, Automations and Customize.
   A control greyed with its exact reason (core/why.js: the reason is its tip and is shown under its row) is counted apart
   as "explained"; one whose reason is only the stand-in "isn't wired to the engine … yet" is counted as "vague".
   Exits 1 while any "Coming soon" or vague reason is left. Run against a throwaway engine only:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> [LIST=1] node design/redesign/tools/audit-dead-controls.cjs
   LIST=1 also prints each "Coming soon"-only or vague control's action or id and its text. WORDS=de (or es, fr) runs
   the window in that language, which catches a reason keyed by a translated title (it would fall back to "Coming soon"). */
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, LIST = process.env.LIST === "1", WORDS = process.env.WORDS || "en";
const LOCALE = require(`${__dirname}/../../../public/locales/${WORDS}.json`);
const SOON = LOCALE["window.places.automations.coming-soon"] ?? "Coming soon";
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const SETTINGS = ["general", "people", "appearance", "notifications", "instructions", "models", "accounts", "local", "voice", "chatapps",
  "permissions", "computer", "secrets", "usage", "gateway", "self", "updates", "achievements", "advanced", "developer"];
const MODEL_TABS = ["defaults", "local", "second", "media"];
const PLACES = [["overview", ["main"]], ["inbox", ["needs", "finished", "history", "later"]],
  ["team", ["live", "people", "groups", "shared", "agents", "activity", "usage", "rules", "signin"]], ["library", ["memory", "documents", "made"]],
  ["automations", ["scheduled", "procedures", "triggers", "checkins", "board"]],
  ["customize", ["trunks", "tools", "specialists", "channels", "everywhere"]]];

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json().catch(() => ({}));
}

/* What the page's main region holds that is greyed: "soon" = only the "Coming soon" hover (its tip), "why" = greyed with
   its reason as the tip and, for a row, shown under it (data-why-text). Each "soon" is listed with the key it could
   carry a reason under (data-why, id or action) and its words. */
const count = (page) => page.evaluate((SOON) => {
  const root = document.querySelector(".set-col") ?? document.querySelector("#main");
  const out = { soon: [], vague: [], why: 0, hidden: 0, hiddenList: [] };
  for (const el of root.querySelectorAll('[aria-disabled="true"], .soon')) {
    const row = el.matches(".pat15") ? el : el.closest(".ctl, .prow, .tile, .fld, .row, .cl-offer17d, .ko-banner, .comp7-card, .status, .empty18c") ?? el.closest(".acts, .chips8");
    const name = `${el.dataset.why || el.id || el.dataset.act || el.tagName.toLowerCase()} | ${(row?.querySelector("b")?.textContent || el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 70)}`;
    if (el.dataset.tip && /isn.t wired to the engine/.test(el.dataset.tip)) { out.vague.push(name); continue; }
    if (el.dataset.tip && el.dataset.tip !== SOON) { out.why += 1; if (!row?.dataset.whyText && !el.closest(".chk")) { out.hidden += 1; out.hiddenList.push(name); } continue; }
    out.soon.push(`${el.dataset.why || el.id || el.dataset.act || el.tagName.toLowerCase()} | ${(el.textContent || el.getAttribute("aria-label") || row?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70)}`);
  }
  return out;
}, SOON);

async function openSettings(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await page.waitForTimeout(1300);
}

async function openTab(page, place, tab) {
  await page.evaluate(([p, v]) => { const b = document.createElement("button"); b.dataset.act = "ptab"; b.dataset.place = p; b.dataset.v = v; document.body.append(b); b.click(); b.remove(); }, [place, tab]);
  await page.waitForTimeout(1500);
}

(async () => {
  await api("onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  if (WORDS !== "en") { await page.evaluate((w) => localStorage.setItem("branch-language", w), WORDS); await page.reload(); await page.locator("#main").waitFor(); }
  await page.waitForTimeout(1500);
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.waitForTimeout(500);
  const rows = [];
  for (const id of SETTINGS) {
    await openSettings(page, id); rows.push([`settings/${id}`, await count(page)]);
    if (id !== "models") continue;
    for (const tab of MODEL_TABS) {
      await page.locator(`[data-act="mtab"][data-v="${tab}"]`).first().click(); await page.waitForTimeout(1000);
      rows.push([`settings/models/${tab}`, await count(page)]);
    }
    await page.locator('[data-act="mtab"][data-v="connections"]').first().click();
  }
  await page.keyboard.press("Escape");
  for (const [place, tabs] of PLACES) for (const tab of tabs) { await openTab(page, place, tab); rows.push([`${place}/${tab}`, await count(page)]); }
  let total = 0, vague = 0;
  for (const [name, c] of rows) {
    total += c.soon.length; vague += c.vague.length;
    console.log(`${name.padEnd(26)} coming-soon-only ${String(c.soon.length).padStart(3)}   vague ${String(c.vague.length).padStart(3)}   explained ${c.why}${c.hidden ? ` (reason not shown in row: ${c.hidden})` : ""}`);
    if (LIST) for (const s of c.soon) console.log(`    soon  ${s}`);
    if (LIST) for (const s of c.vague) console.log(`    vague ${s}`);
    if (LIST) for (const s of c.hiddenList) console.log(`    tip-only ${s}`);
  }
  console.log(`TOTAL coming-soon-only ${total}; vague ${vague}; page errors ${errors.length}${errors.length ? ": " + errors.join(" | ") : ""}`);
  await browser.close();
  if (total || vague || errors.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
