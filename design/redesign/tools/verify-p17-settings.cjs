/* Clicks every Settings control pass 17 made live (prototype patch17b) against a running engine, and confirms each
   through the engine's own GET route; also checks that the security-held and not-yet-real ones stay greyed.
   Run it only against a throwaway engine, seeded and started as design/redesign/tools/seed-p17-settings.mjs says
   (two offline model connections, moving in pointed at a made-up home), then:
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-p17-settings.cjs
   It puts back what it changed (the emergency stop it presses through the API is let go the same way). */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
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
const settle = (page, ms = 700) => page.waitForTimeout(ms);
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1500);
}
const dlg = (page) => page.locator(".scrim .dlg");
const closeDlg = async (page) => { if (await dlg(page).count()) { await page.locator('.scrim [data-act="dlg-close"]').first().click(); await settle(page, 300); } };
const greyed = async (loc) => (await loc.count()) > 0 && ((await loc.first().getAttribute("aria-disabled")) === "true" || await loc.first().isDisabled());
const onMode = (m) => Boolean(m) && m !== "off";
const kitValue = async (key, field) => (await api("settings-kit")).settings.find((s) => s.key === key).fields.find((f) => f.field === field).value;

/* Permissions › Test a rule: the window's verdict is the engine's, for a command and for an address. */
async function ruleTester(page) {
  await openPage(page, "permissions");
  await page.locator('[data-act="ruletestb17"]').click();
  await page.locator("#rule-in-b17").fill("rm notes.txt");
  await page.locator('[data-act="rulerunb17"]').click();
  await settle(page, 900);
  const engine = await api("rules/test", { tool: "shell.session.run", target: "rm notes.txt" });
  check("rule tester: a command is answered with the engine's own reason", (await dlg(page).locator(".res-line-b17 b").textContent()) === engine.because, engine.because);
  const words = { allow: "Allowed", ask: "Asks", deny: "Never" }[engine.decision];
  check("rule tester: the pill is the engine's decision", (await dlg(page).locator(".res-line-b17 .pill").textContent()) === words, engine.decision);
  await page.locator('[data-act="rulepickb17"][data-v="https://unknown.example"]').click();
  await settle(page, 900);
  const site = await api("rules/test", { tool: "web.fetch", target: "https://unknown.example" });
  check("rule tester: a picked address is asked as a site", (await dlg(page).locator(".res-line-b17 b").textContent()) === site.because, site.because);
  await closeDlg(page);
}

/* Permissions › What Trunks may reach: the engine's sentences, and its answer for one address. */
async function firewall(page) {
  await page.locator('[data-act="fwb17"]').click();
  await settle(page, 900);
  const { sentences } = await api("firewall");
  const shown = await dlg(page).locator(".fw-b17 li").allTextContents();
  check("network sentences: the engine's own, in order", JSON.stringify(shown) === JSON.stringify(sentences), `${shown.length} of ${sentences.length}`);
  await page.locator("#fw-in-b17").fill("https://unknown.example");
  await page.locator('[data-act="fwtestb17"]').click();
  await settle(page, 1500);
  const answer = await api("firewall/test", { address: "https://unknown.example" });
  const out = await page.locator("#fw-out-b17").textContent();
  check("check an address: the engine's answer is shown", out.includes(answer.reason ?? answer.address), out);
  await closeDlg(page);
}

/* Permissions › Why is this set?: a setting moved from how Branch ships is listed with the engine's words; putting back
   a tightening is done; putting back one that would loosen is refused by the engine and nothing changes. */
async function whyIsThisSet(page) {
  await api("settings-kit/apply", { plan: { source: "set", key: "policy", field: "unmatchedCommands", value: "allow" }, accept: ["policy.unmatchedCommands"], confirmLoosening: true });
  await api("settings-kit/apply", { plan: { source: "set", key: "loop_guard", field: "mode", value: "on" }, accept: ["loop_guard.mode"] });
  await openPage(page, "general");
  await openPage(page, "permissions");
  const kit = await api("settings-kit");
  const n = kit.settings.flatMap((s) => s.fields.filter((f) => JSON.stringify(f.value) !== JSON.stringify(f.initial))).length;
  check("why: the row counts the engine's changed settings", (await page.locator('[data-act="whyb17"]').textContent()) === `See ${n}`, `See ${n}`);
  await page.locator('[data-act="whyb17"]').click();
  await settle(page, 1500);
  const words = (await api("settings-kit/why/loop_guard.mode")).words;
  const row = dlg(page).locator('.why-b17:has([data-key="loop_guard"])');
  check("why: each row carries the engine's own words", (await row.locator("small").textContent()) === words, words);
  await dlg(page).locator('[data-act="whyputb17"][data-key="policy"][data-field="unmatchedCommands"]').click();
  await settle(page, 1500);
  const initial = kit.settings.find((s) => s.key === "policy").fields.find((f) => f.field === "unmatchedCommands").initial;
  check("put back: the engine holds the shipped value again", (await kitValue("policy", "unmatchedCommands")) === initial, initial);
  await dlg(page).locator('[data-act="whyputb17"][data-key="loop_guard"]').click();
  await settle(page, 1500);
  const toast = (await page.locator(".toast").last().textContent().catch(() => "")) ?? "";
  check("put back never loosens: the engine's refusal is shown", /careful/i.test(toast), toast);
  check("put back never loosens: the guard stays on", (await kitValue("loop_guard", "mode")) === "on");
  await closeDlg(page);
  await api("settings-kit/apply", { plan: { source: "set", key: "loop_guard", field: "mode", value: "off" }, accept: ["loop_guard.mode"], confirmLoosening: true });
}

/* Data & usage › Move in: what the engine found, its preview, and bringing it in. */
async function moveIn(page) {
  await openPage(page, "usage");
  await page.locator('[data-act="moveinb17"]').click();
  await settle(page, 1500);
  const found = (await api("move-in?look=1")).sources;
  const claude = found.find((s) => s.source === "claude-code");
  check("move in: the engine found the Claude Code folder", claude?.found === true, "start the engine with BRANCH_MOVE_IN_HOME from seed-p17-settings.mjs");
  const opts = await dlg(page).locator('[data-act="moveinpickb17"]').evaluateAll((els) => els.map((e) => [e.dataset.v, !e.disabled]));
  check("move in: one choice per assistant, open only where found", JSON.stringify(opts) === JSON.stringify(found.map((s) => [s.source, s.found])), JSON.stringify(opts));
  await dlg(page).locator('[data-act="moveinpickb17"][data-v="claude-code"]').click();
  await settle(page, 2500);
  const preview = await api("move-in/preview", { source: "claude-code" });
  const groups = await dlg(page).locator(".rows .prow b").allTextContents();
  check("move in: the preview's groups, as the engine lists them", JSON.stringify(groups.slice(0, -1)) === JSON.stringify(preview.groups.map((g) => g.name)), groups.join(", "));
  await dlg(page).locator('[data-act="moveingob17"]').click();
  await settle(page, 3000);
  const counts = (await api("move-in/brought")).counts;
  check("bring it in: the engine records what came from Claude Code", counts["claude-code"] > 0, String(counts["claude-code"]));
  check("move in: the row says where it came from", /Brought in from Claude Code/.test(await page.locator(".set-col").textContent()));
}

/* Data & usage › Take everything with you: the file holds exactly the parts ticked, and the export is on the record. */
async function exportAll(page) {
  await page.locator('.set-col [data-act="exportb17"]').click();
  await settle(page, 1200);
  await page.locator("#exp-b17-memory").uncheck();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator('[data-act="exportgob17"]').click()]);
  const file = await download.path();
  const { openAgent } = await import(pathToFileURL(resolve(__dirname, "../../../dist/agent-export.js")).href);
  const opened = openAgent(require("node:fs").readFileSync(file));
  const parts = opened.manifest.sections.map((s) => s.name).join(",");
  check("export: the file holds the ticked parts and not memory", parts === "procedures,skills,routing,permissions", parts);
  const record = (await api("audit?limit=20")).entries ?? (await api("audit?limit=20")).records ?? [];
  check("export: the engine wrote it into the record", JSON.stringify(record).includes("data.exported"));
}

/* Models › Compare models: the engine's suites; Run again runs the suite on both connections and the table follows. */
async function compare(page) {
  await openPage(page, "models");
  await page.locator('[data-act="compareb17"]').click();
  await settle(page, 1500);
  const { suites } = await api("evaluation/suites");
  check("compare: one choice per engine suite", (await dlg(page).locator('[data-act="cmpsuiteb17"]').count()) === suites.length, String(suites.length));
  const suite = suites.find((s) => s.id === "cost") ?? suites[0];
  await dlg(page).locator(`[data-act="cmpsuiteb17"][data-v="${suite.id}"]`).click();
  await settle(page, 1000);
  const before = (await api(`evaluation/history?suite=${suite.id}`)).runs.length;
  await dlg(page).locator('[data-act="cmprunb17"]').click();
  await page.waitForFunction((n) => document.querySelectorAll(".scrim .tbl-b17 tbody tr").length >= 2, null, { timeout: 120000 }).catch(() => {});
  const after = (await api(`evaluation/history?suite=${suite.id}`)).runs;
  check("run again: the engine ran the suite on both connections", after.length === before + 2, `${before} → ${after.length}`);
  const cells = await dlg(page).locator(".tbl-b17 tbody tr td:nth-child(2)").allTextContents();
  check("compare: the table shows the engine's right answers", cells.includes(`${after[0].summary.passed} of ${after[0].summary.total}`), cells.join(" | "));
  check("compare: side by side stays greyed", await greyed(dlg(page).locator('[data-act="cmpsideb17"]')));
  await closeDlg(page);
  await page.locator('[data-act="savingsb17"]').click();
  await settle(page, 1200);
  check("savings: the dialog opens from the engine's figures", (await dlg(page).count()) === 1);
  check("savings: mixing stays greyed", await greyed(dlg(page).locator('[data-act="mixb17"]')));
  await closeDlg(page);
  check("model arena stays greyed", await greyed(page.locator('.set-col button:has-text("Open the arena")')));
}

async function flip(page, pageId, id, engine) {
  const box = page.locator(`#${id}`);
  await box.waitFor({ state: "attached", timeout: 10000 });
  if (await greyed(box)) { check(`${pageId} › ${id} is live`, false, "greyed"); return; }
  const before = await engine();
  const shown = await page.waitForFunction(([sel, want]) => document.querySelector(sel)?.checked === want, [`#${id}`, before], { timeout: 8000 }).then(() => true, () => false);
  check(`${pageId} › ${id} shows the engine's value`, shown, String(before));
  for (const want of [!before, before]) {
    await page.locator(`#${id}`).click();
    await settle(page, 1200);
    const now = await engine();
    check(`${pageId} › ${id} → ${want ? "on" : "off"} in the engine`, now === want, String(now));
  }
}

/* Advanced › What it can do. */
async function advanced(page) {
  await openPage(page, "advanced");
  await flip(page, "advanced", "f15-read-links-you-paste", async () => onMode((await api("web-pages")).settings.mode));
  await flip(page, "advanced", "f15-smart-home", async () => onMode((await api("personal")).modes["home-control"]));
  check("deep research stays greyed", await greyed(page.locator("#f15-deep-research-reports")));
  // The whole-agent file holds no Trunks, so Share a Trunk is not pointed at it.
  check("share a Trunk stays greyed", await greyed(page.locator('.set-col .ctl:has(b:text-is("Share a Trunk")) button')));
}

/* Gateway › Never break: the journal is the engine's. */
async function journal(page) {
  await openPage(page, "gateway");
  await page.locator('[data-act="nbb17"]').click();
  await settle(page, 1200);
  const { entries } = await api("never-break/journal");
  const shown = await dlg(page).locator(".rows .prow b").allTextContents();
  check("journal: one row per engine entry", shown.length === entries.length && (!entries[0] || shown[0] === `${entries[0].fromVersion} → ${entries[0].toVersion}`), shown.join(", "));
  check("try a bad change stays greyed", await greyed(dlg(page).locator('[data-act="nbtryb17"]')));
  await closeDlg(page);
}

/* Permissions › Every change to what Branch may reach: the engine's record, and its CSV. */
async function auditRecord(page) {
  await openPage(page, "permissions");
  await page.locator('[data-act="demob17"][data-k="audit"]').click();
  await settle(page, 1200);
  const { entries } = await api("audit?limit=100");
  const shown = await dlg(page).locator(".rows .prow b").allTextContents();
  check("record: one row per engine entry, newest first", shown.length === entries.length && shown[0] === entries[0]?.subject, `${shown.length} of ${entries.length}`);
  const [download] = await Promise.all([page.waitForEvent("download"), dlg(page).locator('[data-act="demodob17"][data-k="audit"]').click()]);
  const lines = require("node:fs").readFileSync(await download.path(), "utf8").trim().split("\n").length;
  check("record: Export as CSV saves the engine's spreadsheet", lines > entries.length, `${lines} lines`);
  await closeDlg(page);
}

/* Held back for review: the emergency stop, pressed and let go. The stop's row still follows the engine: pressed through
   the API, it offers "Let them resume", which stays greyed too. The app lock is live (verify-app-lock.cjs presses it) and
   the password manager is live (unhold-approvals, verify-unhold-approvals.cjs); only Windows, which the engine cannot
   ask, stays greyed. */
async function heldBack(page) {
  await openPage(page, "secrets");
  check("password manager: Bitwarden and 1Password live, Windows greyed", (await page.locator('[data-act="vaultb17"]').count()) === 2
    && !(await greyed(page.locator('[data-act="vaultb17"]')))
    && await greyed(page.locator('[data-act="vaultwinb17"]')));
  check("a row with no readout yet stays greyed", await greyed(page.locator('[data-act="demob17-soon"][data-k="keys"]')));
  await openPage(page, "permissions");
  check("app lock is live, not greyed", !(await greyed(page.locator('[data-act="applockb17"]'))));
  check("emergency stop: pressing it stays greyed", await greyed(page.locator('[data-act="estopb17"]')));
  await api("safety-extras/stop", { everything: true });
  await openPage(page, "general");
  await openPage(page, "permissions");
  check("emergency stop: the row follows the engine, and letting go stays greyed", await greyed(page.locator('[data-act="estoprelb17"]')));
  await api("safety-extras/stop/release", {});
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#main").waitFor();
    await settle(page, 1500);
    for (const step of [ruleTester, firewall, whyIsThisSet, moveIn, exportAll, compare, advanced, journal, auditRecord, heldBack]) {
      try { await step(page); } catch (e) { check(`${step.name} finished`, false, e.message); await closeDlg(page).catch(() => {}); }
    }
  } catch (e) { check("script finished", false, e.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
