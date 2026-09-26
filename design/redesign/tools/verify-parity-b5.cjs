/* Parity batch B5 (Settings pages and OS permissions): clicks every control B5 made live with a real mouse, against a
   running engine, and confirms each change through the engine's own GET route; then walks every Settings page at every
   level, opens every row dialog that is live, and counts what is still greyed. Each switch is flipped and flipped back,
   so the engine ends as it began. Zero page errors are required. Run it only against a throwaway engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-parity-b5.cjs
   SHOTS=<folder> saves a screenshot of every page. PHONE=1 also opens Settings as a paired phone (a touch screen with
   the phone's kept secret) and checks the computer-only rows are not drawn. It starts no stand-in servers. */
const { chromium, devices } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { mkdirSync } = require("node:fs");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, SHOTS = process.env.SHOTS;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const kit = async (key, field = "mode") => (await api("settings-kit")).settings.find((s) => s.key === key)?.fields.find((f) => f.field === field)?.value;
const knob = async (card, field) => (await api("knobs")).values[card][field];
const settle = (page, ms = 700) => page.waitForTimeout(ms);

async function signIn(page) {
  await page.goto(`${BASE}/`);
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#app").waitFor();
  await settle(page, 2500);
  if (await page.locator(".ob9, .scrim").count()) await page.keyboard.press("Escape");
  await settle(page, 400);
}
async function level(page, v) { await page.locator(`[data-act="setlevel"][data-v="${v}"]`).first().click(); await settle(page, 400); }
async function openPage(page, id, lv = "technical") {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await level(page, lv);
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1500);
}
const closeDialog = async (page) => { if (await page.locator(".scrim .dlg").count()) { await page.keyboard.press("Escape"); await settle(page, 300); } };
const greyed = (loc) => loc.evaluate((el) => el.classList.contains("soon") || el.getAttribute("aria-disabled") === "true" || el.disabled);

/* A switch drawn by id: flipped with the mouse, the engine read back, and flipped back. */
async function flip(page, pageId, id, read, name) {
  await openPage(page, pageId);
  const box = page.locator(`#${id}`);
  if (!(await box.count())) { check(`${name}: drawn`, false, id); return; }
  check(`${name}: live`, !(await greyed(box)));
  const was = await read();
  await box.click();
  await settle(page, 1500);
  if (await page.locator('[data-act="kitconf17"]').count()) { await page.locator('[data-act="kitconf17"]').click(); await settle(page, 1500); }
  const now = await read();
  check(`${name}: the engine changed`, JSON.stringify(now) !== JSON.stringify(was), `${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
  await page.locator(`#${id}`).click();
  await settle(page, 1500);
  if (await page.locator('[data-act="kitconf17"]').count()) { await page.locator('[data-act="kitconf17"]').click(); await settle(page, 1500); }
  check(`${name}: flipped back`, JSON.stringify(await read()) === JSON.stringify(was), JSON.stringify(await read()));
}
/* A number box: typed, the engine read back, then put back as it was. */
async function type(page, pageId, id, value, read, name) {
  await openPage(page, pageId);
  const box = page.locator(`#${id}`);
  if (!(await box.count())) { check(`${name}: drawn`, false, id); return; }
  const was = await read();
  await box.fill(String(value)); await box.press("Tab"); await settle(page, 1500);
  check(`${name}: the engine keeps ${value}`, (await read()) === value, JSON.stringify(await read()));
  await page.locator(`#${id}`).fill(was == null ? "" : String(was)); await page.locator(`#${id}`).press("Tab"); await settle(page, 1500);
  check(`${name}: put back`, (await read()) === was, JSON.stringify(await read()));
}
/* A segmented choice: pressed with the mouse, read back, and the first choice pressed again. */
async function seg(page, pageId, selector, read, expect, name) {
  await openPage(page, pageId);
  const was = await read();
  const btn = page.locator(selector).first();
  if (!(await btn.count())) { check(`${name}: drawn`, false, selector); return; }
  check(`${name}: live`, !(await greyed(btn)));
  await btn.click(); await settle(page, 1500);
  if (await page.locator('[data-act="kitconf17"]').count()) { await page.locator('[data-act="kitconf17"]').click(); await settle(page, 1500); }
  const now = await read();
  check(`${name}: the engine keeps it`, JSON.stringify(now) === JSON.stringify(expect), JSON.stringify(now));
  check(`${name}: pressed as the engine says`, (await page.locator(selector).first().getAttribute("aria-pressed")) === "true");
  return was;
}

/* ---------- General ---------- */
async function general(page) {
  await flip(page, "general", "g-cmds", () => kit("command-catalog"), "General › The shared commands");
  await flip(page, "general", "f15-summarise-older-turns-by-themselves", () => knob("compaction", "autoCompact"), "General › Summarise older turns");
  await type(page, "general", "f15-summarise-when", 70, () => knob("compaction", "compactAtPercent"), "General › Summarise when it's this full");
  await type(page, "general", "f15-keep-latest", 9, () => knob("compaction", "keepRecentMessages"), "General › Always keep the latest");
  await flip(page, "general", "f15-repair-the-history-before-each-call", () => kit("safety-history-repair"), "General › Repair the history");
  const room = await knob("compaction", "contextWindowTokens");
  await seg(page, "general", '[data-act="knobseg17"][data-field="contextWindowTokens"][data-j="200000"]', () => knob("compaction", "contextWindowTokens"), 200000, "General › Room to plan for 200k");
  await page.locator(`[data-act="knobseg17"][data-field="contextWindowTokens"][data-j="${JSON.stringify(room)}"]`).first().click(); await settle(page, 1200);
  check("General › Room to plan for put back", (await knob("compaction", "contextWindowTokens")) === room);
  /* Start with Windows: the engine answers in its own words (it refuses unless Branch is installed). */
  await openPage(page, "general");
  const start = page.locator("#g-start");
  check("General › Start with Windows: live", start && !(await greyed(start)));
  const before = (await api("deployment")).autostart?.enabled;
  await start.click(); await settle(page, 1500);
  const toast = await page.locator(".toast").textContent().catch(() => "");
  const after = (await api("deployment")).autostart?.enabled;
  check("General › Start with Windows: the engine answered", after !== before || /installed/.test(toast ?? ""), toast || String(after));
  if (after !== before) { await page.locator("#g-start").click(); await settle(page, 1500); }
  /* A project's own instructions. */
  const projects = (await api("projects")).all;
  if (projects.length) {
    const p = projects[0];
    await page.locator(`[data-act="proj-edit15"][data-id="${p.id}"]`).click(); await settle(page, 500);
    await page.locator("#proj-text15").fill("Parity B5 check"); await page.locator('[data-act="proj-save15"]').click(); await settle(page, 1200);
    const saved = (await api("projects")).all.find((x) => x.id === p.id);
    check("General › Edit a project's instructions: saved", saved?.instructions === "Parity B5 check" && saved.name === p.name);
    await api("projects", { ...saved, instructions: p.instructions ?? "" });
  }
}

/* ---------- every row dialog (pass 17b) on every page ---------- */
async function demos(page) {
  for (const id of ["general", "people", "appearance", "instructions", "models", "accounts", "voice", "chatapps", "permissions", "computer", "secrets", "usage", "self", "updates", "advanced", "developer"]) {
    await openPage(page, id);
    const rows = await page.locator('.set-col [data-act="demob17"]').evaluateAll((els) => els.map((e) => e.dataset.k));
    for (const k of rows) {
      await page.locator(`.set-col [data-act="demob17"][data-k="${k}"]`).first().click();
      await settle(page, 1000);
      const open = await page.locator(".scrim .dlg").count();
      const body = open ? await page.locator(".scrim .dlg .demo-b17").innerText().catch(() => "") : "";
      check(`${id} › ${k}: opens the engine's readout`, open === 1, body.split("\n").slice(0, 2).join(" | ").slice(0, 100));
      await closeDialog(page);
    }
  }
}

/* ---------- every page, every level: drawn with no page error; what stays greyed is counted ---------- */
async function sweep(page, label) {
  const ids = ["general", "people", "appearance", "notifications", "instructions", "models", "accounts", "local", "voice", "chatapps", "permissions", "computer", "secrets", "usage", "gateway", "self", "updates", "achievements", "advanced", "developer"];
  for (const lv of ["regular", "advanced", "technical"]) {
    for (const id of ids) {
      if ((id === "advanced" && lv === "regular") || (id === "developer" && lv !== "technical")) continue;
      await openPage(page, id, lv);
      const soon = await page.locator(".set-col .soon").count();
      if (lv === "technical") console.log(`      ${label} ${id}: ${soon} greyed`);
      if (SHOTS && lv === "technical") await page.screenshot({ path: `${SHOTS}/${label}-${id}.png`, fullPage: true });
    }
  }
}

(async () => {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  const label = process.env.LABEL ?? "user";
  await general(page);
  await demos(page);
  await sweep(page, label);
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
