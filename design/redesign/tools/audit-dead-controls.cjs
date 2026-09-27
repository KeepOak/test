/* Counts the controls each page draws greyed with only the "Coming soon" hover (QA Q002), at the Technical level, on
   every Settings page plus Team › Rules and Customize › Everywhere. A control greyed with its reason (core/why.js: the
   reason is its tip and is shown under its row) is counted apart as "explained". Exits 1 while any "Coming soon" is left. Run against a throwaway engine only:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> [LIST=1] node design/redesign/tools/audit-dead-controls.cjs
   LIST=1 also prints each "Coming soon"-only control's action or id and its text. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, LIST = process.env.LIST === "1";
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const SETTINGS = ["general", "people", "appearance", "notifications", "instructions", "models", "accounts", "local", "voice", "chatapps",
  "permissions", "computer", "secrets", "usage", "gateway", "self", "updates", "achievements", "advanced", "developer"];

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json().catch(() => ({}));
}

/* What the page's main region holds that is greyed: "soon" = only the "Coming soon" hover (its tip), "why" = greyed with
   its reason as the tip and, for a row, shown under it (data-why-text). Each "soon" is listed with the key it could
   carry a reason under (data-why, id or action) and its words. */
const count = (page) => page.evaluate(() => {
  const root = document.querySelector(".set-col") ?? document.querySelector("#main");
  const out = { soon: [], why: 0, hidden: 0 };
  for (const el of root.querySelectorAll('[aria-disabled="true"], .soon')) {
    const row = el.closest(".ctl, .prow, .tile, .fld");
    if (el.dataset.tip && el.dataset.tip !== "Coming soon") { out.why += 1; if (row && !row.dataset.whyText && !el.closest(".chk")) out.hidden += 1; continue; }
    out.soon.push(`${el.dataset.why || el.id || el.dataset.act || el.tagName.toLowerCase()} | ${(el.textContent || el.getAttribute("aria-label") || row?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70)}`);
  }
  return out;
});

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
  await page.waitForTimeout(1500);
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.waitForTimeout(500);
  const rows = [];
  for (const id of SETTINGS) { await openSettings(page, id); rows.push([`settings/${id}`, await count(page)]); }
  await openTab(page, "team", "rules"); rows.push(["team/rules", await count(page)]);
  await openTab(page, "customize", "everywhere"); rows.push(["customize/everywhere", await count(page)]);
  let total = 0;
  for (const [name, c] of rows) {
    total += c.soon.length;
    console.log(`${name.padEnd(24)} coming-soon-only ${String(c.soon.length).padStart(3)}   explained ${c.why}${c.hidden ? ` (reason not shown in row: ${c.hidden})` : ""}`);
    if (LIST) for (const s of c.soon) console.log(`    ${s}`);
  }
  console.log(`TOTAL coming-soon-only ${total}; page errors ${errors.length}${errors.length ? ": " + errors.join(" | ") : ""}`);
  await browser.close();
  if (total || errors.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
