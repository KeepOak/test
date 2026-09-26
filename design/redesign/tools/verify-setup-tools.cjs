/* setup-tools: proves Setup's step 7, "Tools to start with", against a FRESH engine (never onboarded), reading every
   row and every change back through the engine's own GET routes. Page errors must be zero.
     start:  BRANCH_DATA_DIR=<fresh> BRANCH_WORKSPACE=<fresh> BRANCH_PORT=<port> node dist/cli.js start
     run:    PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-setup-tools.cjs
   What it changes, through the window, and puts back: three starter Trunks made in step 5 (Inbox Manager, Researcher,
   Bug Reproduction; they stay), one skill that comes with Branch installed, turned on and off again, the Google
   connector switched off and on again, the command-line tools found here allowed and taken back again, and the example
   notes server shipped with Branch added (switched off) and removed again. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { mkdirSync } = require("node:fs");
const { resolve } = require("node:path");

const { PORT, TOKEN } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS ?? "C:/Users/bishi/AppData/Local/Temp/claude-session-files/setup-tools";
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const TEMPLATES = { 0: "inbox", 2: "researcher", 4: "bug" };

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
}
/* Setup opens itself on an engine that was never onboarded; after a reload it is opened the way the Guide menu does. */
async function toToolsStep(page, pickTemplates) {
  if (!(await page.locator(".ob9").count())) await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("onboard")));
  await page.locator(".ob9").waitFor();
  /* A reload in the middle of setup goes back to the step it was on, the box already ticked (setup-resume). */
  if ((await page.locator("#ob-trust").count()) && !(await page.locator("#ob-trust").isChecked())) await page.locator(".ob-agree").click();
  await settle(page, 300);
  if (pickTemplates) {
    /* Before any Trunk is picked, the recommended part says so in one line. */
    await page.locator('.ob9 [data-act="ob-go"][data-v="6"]').click();
    await page.locator(".ob9 .obt").waitFor({ timeout: 20000 });
    const none = await page.locator(".ob9 .obt p.hint", { hasText: "No Trunks picked yet" }).count();
    check("with no Trunks picked, one line says so", none === 1 && (await page.locator(".ob9 .obt .rows").count()) === 0);
    await page.locator('.ob9 [data-act="ob-go"][data-v="4"]').click();
    await settle(page, 400);
    for (const i of Object.keys(TEMPLATES)) await page.locator(`.ob9 [data-act="ob-tpl"][data-i="${i}"]`).click();
  }
  await page.locator('.ob9 [data-act="ob-go"][data-v="6"]').click();
  await page.locator(".ob9 .obt").waitFor({ timeout: 20000 });
  await settle(page, 600);
}
async function reopen(page) {
  await page.reload();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  await toToolsStep(page, false);
}

/* Every section is filled from the engine: the counts, names and states on screen are the routes' own. */
async function sections(page) {
  const view = await api("setup/tools");
  for (const k of view.kinds) {
    const tile = page.locator(`.ob9 details.obt-kind[data-kind="${k.id}"]`);
    const text = (await tile.locator("summary").textContent()) ?? "";
    const chips = await tile.locator(".obt-names code").allTextContents();
    const ok = text.includes(String(k.tools)) && (k.asks === 0 || text.includes(String(k.asks))) && JSON.stringify(chips) === JSON.stringify(k.names);
    check(`comes with Branch: ${k.id} shows the engine's ${k.tools} tools, ${k.asks} asking first, ${k.off} off`, ok, text.replace(/\s+/g, " ").trim());
  }
  const [channels, personal, clis, skills] = await Promise.all([api("channel-setup"), api("personal"), api("clis"), api("skills/browser")]);
  const want = new Map();
  for (const id of Object.values(TEMPLATES)) for (const n of view.starters[id]) want.set(`${n.kind}:${n.id}`, n);
  const names = [...want.values()].map((n) => n.kind === "channel" ? channels.channels.find((c) => c.id === n.id).name : n.kind === "personal" ? personal.labels[n.id] : n.id);
  const shown = await page.locator(".ob9 .obt .rows").first().locator(".prow .grow b").allTextContents();
  check("recommended: one row for each thing the three Trunks need, named by the engine", JSON.stringify(shown) === JSON.stringify(names), shown.join(" | "));
  const cards = await page.locator(".ob9 .obt-skill b").allTextContents();
  check("skills: the skills that come with Branch (GET /api/skills/browser)", JSON.stringify(cards) === JSON.stringify(skills.skills.map((s) => s.name)), cards.join(", "));
  const found = await page.locator(".ob9 .obt-cli").allTextContents();
  check("found on this computer: the tools GET /api/clis found", JSON.stringify(found) === JSON.stringify(clis.found.map((c) => c.name)), found.join(", "));
  const allowed = await page.locator(".ob9 .obt-cli.on").allTextContents();
  check("found on this computer: the allowed ones are marked, as the engine says", JSON.stringify(allowed) === JSON.stringify(clis.found.filter((c) => c.allowed).map((c) => c.name)), allowed.join(", "));
  const servers = (await api("mcp/connections")).servers ?? [];
  check("tool servers: listed only when the engine has some", (await page.locator(".ob9 .obt .obt-h", { hasText: "Tool servers" }).count()) === (servers.length ? 1 : 0), `${servers.length} servers`);
  return { view, clis };
}

/* Nothing fake: no dead switch, every switch live, the old copy gone, and only the Google/Microsoft sign-ins greyed. */
async function nothingFake(page) {
  check("no dead data-sw=set switch in step 7", (await page.locator('.ob9 [data-sw="set"]').count()) === 0);
  const dead = await page.locator(".ob9 .obt .sw").evaluateAll((els) => els.filter((e) => e.disabled || e.getAttribute("aria-disabled") === "true").length);
  check("every switch in step 7 is live", dead === 0, `${await page.locator(".ob9 .obt .sw").count()} switches`);
  const greyed = await page.locator('.ob9 .obt [aria-disabled="true"]').evaluateAll((els) => els.map((e) => e.dataset.act));
  check("the only greyed controls are sign-ins that have no window flow yet", greyed.every((a) => a === "obt-signin"), greyed.join(",") || "none");
  const body = await page.locator(".ob9 .ob-body").textContent();
  check("the old copy is gone and the new line is shown", !body.includes("under the plug") && body.includes("You can change any of this later in Customize"));
}

async function skillToggle(page) {
  const name = "search-and-summarise";
  const box = () => page.locator(`.ob9 [data-sw="obt-skill"][data-v="${name}"]`);
  await box().click();
  const on = await until(async () => (await api("state")).skills.find((s) => s.name === name && s.activeVersion != null));
  check("skill switch on: installed and turned on (GET /api/state skills)", on);
  await until(async () => box().isChecked());
  check("skill switch keeps the keyboard on it after the redraw", await page.evaluate((n) => document.activeElement?.dataset?.v === n, name));
  await reopen(page);
  check("skill switch on survives a reload", await box().isChecked());
  await box().click();
  const off = await until(async () => (await api("state")).skills.find((s) => s.name === name && s.activeVersion == null));
  check("skill switch off: turned off (GET /api/state skills)", off);
  await reopen(page);
  check("skill switch off survives a reload", !(await box().isChecked()));
}

async function personalToggle(page) {
  const box = () => page.locator('.ob9 [data-sw="obt-part"][data-v="google"]');
  const was = (await api("personal")).modes.google;
  check("google switch shows the engine's mode", (await box().isChecked()) === (was !== "off"), was);
  await box().click();
  check("google switch off: POST /api/personal/switch saved it", await until(async () => (await api("personal")).modes.google === "off"));
  await reopen(page);
  check("google switch off survives a reload", !(await box().isChecked()));
  await box().click();
  check("google switch on again: saved as when-needed", await until(async () => (await api("personal")).modes.google === "when-needed"));
  await until(async () => box().isChecked());
  await settle(page, 500);
}

async function cliToggle(page, clis) {
  if (!clis.found.length) { check("command-line tools: none found, so no switch is drawn", (await page.locator("#obt-cli").count()) === 0); return; }
  const body = page.locator(".ob9 .ob-body");
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await settle(page, 300);
  const before = await body.evaluate((el) => el.scrollTop);
  const all = clis.found.every((c) => c.allowed);
  await page.locator("#obt-cli").click();
  const done = await until(async () => { const now = await api("clis"); return all ? now.programs.length === 0 : now.found.every((c) => c.allowed); }, 30000);
  check(`command-line switch ${all ? "off" : "on"}: GET /api/clis agrees`, done);
  await settle(page, 800);
  const after = await body.evaluate((el) => el.scrollTop);
  check("a switch redraws the step in place (no jump to the top)", before > 0 && Math.abs(after - before) < 4,`${before} -> ${after}`);
  await reopen(page);
  check("command-line switch survives a reload", (await page.locator("#obt-cli").isChecked()) === !all);
  await page.locator("#obt-cli").click();
  check("command-line switch back: GET /api/clis agrees", await until(async () => { const now = await api("clis"); return all ? now.found.every((c) => c.allowed) : now.programs.length === 0; }, 30000));
}

/* Connect opens the real chat app setup, on top of setup; Add a tool server opens the engine's connector catalogue. */
async function connects(page) {
  /* Allowing tools earns an achievement (the engine's own); its card is dismissed first so it does not cover the dialog. */
  for (const nice of await page.locator('[data-act="ach-close"]').all()) await nice.click().catch(() => {});
  await settle(page, 400);
  await page.locator('.ob9 [data-act="ch-open"][data-v="email"]').click();
  const dlg = page.locator(".scrim .dlg");
  await dlg.waitFor({ timeout: 10000 });
  await settle(page, 500);
  const label = await dlg.getAttribute("aria-label");
  const recipe = await api("channel-setup/email");
  const onTop = await dlg.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 20)); });
  check("Connect opens the email channel's own setup, on top of setup", onTop && label.includes(recipe.name ?? "Email"), label);
  await page.screenshot({ path: `${SHOTS}/connect-email.png` });
  await dlg.locator('[data-act="dlg-close"]').first().click();
  await settle(page, 400);
  await page.locator('.ob9 [data-act="tool-add"][data-v="mcp"]').click();
  await page.locator(".scrim .dlg .aa-list12").waitFor({ timeout: 10000 });
  const count = await page.locator('.scrim .dlg [data-act="mcp-add"]').count();
  check("Add a tool server opens the engine's connector catalogue", count === (await api("mcp/catalogue")).count, `${count} connectors`);
  await page.locator('.scrim .dlg [data-act="dlg-close"]').first().click();
  await settle(page, 400);
  check("setup is still open behind the dialogs", (await page.locator(".ob9 .obt").count()) === 1);
}

/* A server added from this step shows in it once the dialog closes, without leaving the step. The example notes server
   that ships with Branch is saved switched off (it reads no files and opens no network connection) and removed again. */
async function addServer(page) {
  await page.locator('.ob9 [data-act="tool-add"][data-v="mcp"]').click();
  await page.locator('.dlg [data-act="t9-own"]').click();
  await page.locator("#mcp-name").waitFor();
  await page.locator('.dlg [data-act="mcp-how"][data-v="cmd"]').click();
  await page.fill("#mcp-name", "Notes");
  await page.fill("#mcp-cmd", `"${process.execPath}" "${resolve("dist/examples/mcp-notes-server.js")}"`);
  await page.locator('.dlg [data-act="mcp-save"]').click();
  const saved = await until(async () => (await api("mcp/servers")).servers.find((s) => s.name === "Notes"));
  check("Add a tool server saves through POST /api/mcp/servers", saved);
  const shown = await until(async () => (await page.locator(".ob9 .obt .prow .grow b", { hasText: "Notes" }).count()) === 1);
  check("the new server is listed in step 7 without leaving it", shown && (await page.locator(".ob9 .obt .obt-h", { hasText: "Tool servers" }).count()) === 1);
  await page.screenshot({ path: `${SHOTS}/step7-server.png` });
  if (saved) await api(`mcp/servers/${saved.id}/remove`, {});
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    await toToolsStep(page, true);
    await page.screenshot({ path: `${SHOTS}/step7.png` });
    await page.locator(".ob9 .ob-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await settle(page, 300);
    await page.screenshot({ path: `${SHOTS}/step7-bottom.png` });
    await page.locator(".ob9 .ob-body").evaluate((el) => { el.scrollTop = 0; });
    const { clis } = await sections(page);
    await nothingFake(page);
    await skillToggle(page);
    await personalToggle(page);
    await cliToggle(page, clis);
    await connects(page);
    await addServer(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page, 500);
    await page.screenshot({ path: `${SHOTS}/step7-phone.png` });
    check("no sideways scroll at phone width", await page.locator(".ob9 .ob-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  } catch (error) { check(`ran to the end: ${error.message}`, false); }
  check("zero page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})();
