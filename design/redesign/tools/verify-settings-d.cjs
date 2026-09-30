/* Batch D of the tip audit (Settings pages), against a running throwaway engine:
     PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-settings-d.cjs
   It adds a stand-in model service on this computer (stub-model-b6 on a free port, reached through the catalogue's
   "custom" connection, so the connection runs locally and is an API key list), a second key account on it and a Trunk,
   then clicks every control batch D made live in a headless browser and confirms each change through the engine's own
   GET route. Nothing leaves this computer. Covered: acct-resume, acct-rename, acct-rename-save, acct-trunks, acct-trunk,
   acct-trunks-save, sw:ac-fall (and ac-next's reason), m-def (4 rows), sw:f15-pick-the-model-per-task, comp-add's three
   greyed kinds and their reasons, rule-save8 and rulerunb17 waiting for words. lm-run and lp-use-studio need Ollama and
   LM Studio themselves, so they are covered by tests/settings-batch-d.test.mjs (D5) and tests/local-oneclick.test.mjs
   (O8, P4) instead. */
const path = require("node:path");
const PW = process.env.PLAYWRIGHT ?? "playwright";
const { chromium } = require(PW);
const { start } = require(path.join(__dirname, "stub-model-b6.cjs"));

const BASE = `http://127.0.0.1:${process.env.PORT}`, TOKEN = process.env.TOKEN;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}
const until = async (read, what) => {
  for (let i = 0; i < 150; i++) { if (await read().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 100)); }
  console.log(`  never happened: ${what}`);
  return false;
};
const whyOf = (locator) => locator.locator("xpath=ancestor::div[contains(@class,'ctl')]").getAttribute("data-why-text");

async function prepare(stubPort) {
  const made = await api("connections/from-preset", { provider: "custom", key: "verify-d-key", model: "stub-model", extras: { baseUrl: `http://127.0.0.1:${stubPort}/v1` } });
  await api("onboarding", { done: true });
  const modes = await api("trunks");
  if (modes.modes?.trunks !== "on") await api("trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await api("trunks", { name: "Verify Scout" });
  const added = await api("accounts/add", { pool: made.id, label: "Second", key: "verify-d-second-key" });
  return { pool: made.id, second: added.accounts.at(-1).id, trunk: trunk.id };
}

async function accounts(page, s) {
  await page.locator('[data-act="setpage"][data-v="accounts"]').click();
  const menu = () => page.locator(`#main [data-act="acct-menu"][data-pool="${s.pool}"][data-id="${s.second}"]`).click();
  await menu();
  await page.locator('.pop [data-act="acct-rename"]').click();
  await page.getByLabel("Call it", { exact: true }).fill("Verify plan");
  await page.locator('.dlg [data-act="acct-rename-save"]').click();
  check("acct-rename: the engine keeps the new name", await until(async () => (await api("accounts")).pools.find((p) => p.pool === s.pool).accounts.some((a) => a.id === s.second && a.label === "Verify plan"), "renamed"));
  await menu();
  await page.locator('.pop [data-act="acct-trunks"]').click();
  await page.locator(`.dlg [data-act="acct-trunk"][data-v="${s.trunk}"]`).click();
  await page.locator('.dlg [data-act="acct-trunks-save"]').click();
  check("acct-trunks: the Trunk uses the account", await until(async () => (await api(`trunks/${s.trunk}`)).trunk.keys.accounts[s.pool] === s.second, "picked"));
  await menu();
  await page.locator('.pop [data-act="acct-trunks"]').click();
  await page.locator('.dlg [data-act="acct-trunk"][data-v="anyone"]').click();
  await page.locator('.dlg [data-act="acct-trunks-save"]').click();
  check("acct-trunks: Anyone who needs it clears the pick", await until(async () => !(s.pool in (await api(`trunks/${s.trunk}`)).trunk.keys.accounts), "cleared"));
  const disabled = async () => (await api("accounts")).pools.find((p) => p.pool === s.pool).accounts.find((a) => a.id === s.second).disabled;
  await page.locator('#main [data-act="acsel15"]').click();
  await page.locator(`#main [data-acc15="${s.pool}/${s.second}"]`).check();
  await page.locator('#main [data-act="acbulk15"][data-v="pause"]').click();
  await until(async () => (await disabled()) === true, "paused");
  await page.locator(`#main [data-act="acct-resume"][data-pool="${s.pool}"][data-id="${s.second}"]`).click();
  check("acct-resume: a paused account answers again", await until(async () => (await disabled()) === false, "resumed"));
  const fall = page.locator("#main #ac-fall");
  await fall.check();
  check("sw:ac-fall on: the model on this computer is in the fallback order", await until(async () => (await api("state")).models.fallbackOrder.includes(s.pool), "in order"));
  await fall.uncheck();
  check("sw:ac-fall off: out of the order", await until(async () => !(await api("state")).models.fallbackOrder.includes(s.pool), "out"));
  const next = page.locator("#main #ac-next");
  await next.uncheck();
  check("sw:ac-next off: the list stops moving on", await until(async () => (await api("accounts")).pools.find((p) => p.pool === s.pool).autoSwitch === false, "off"));
  await next.check();
  check("sw:ac-next on", await until(async () => (await api("accounts")).pools.find((p) => p.pool === s.pool).autoSwitch === true, "on"));
  await page.locator('#main [data-act="ac-strategy"][data-v="round-robin"]').click();
  check("ac-strategy: take turns", await until(async () => (await api("accounts")).pools.find((p) => p.pool === s.pool).strategy === "round-robin", "strategy"));
  await page.locator('#main [data-act="ac-strategy"][data-v="priority"]').click();
  check("ac-strategy: fill first", await until(async () => (await api("accounts")).pools.find((p) => p.pool === s.pool).strategy === "priority", "strategy back"));
}

async function defaults(page, s) {
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  await page.locator('#main [data-act="mtab"][data-v="defaults"]').click();
  const pick = (k) => page.locator(`#main [data-act="m-def"][data-k="${k}"][data-v="${s.pool}"]`);
  await pick("planning").click();
  check("m-def planning: phases.planModel", await until(async () => (await api("model-savings")).values.phases.planModel === s.pool, "planning"));
  await pick("quick").click();
  check("m-def quick: subtasks.subtaskModel", await until(async () => (await api("knobs")).values.subtasks.subtaskModel === s.pool, "quick"));
  await pick("summaries").click();
  check("m-def summaries: subtasks.sideJobModel", await until(async () => (await api("knobs")).values.subtasks.sideJobModel === s.pool, "summaries"));
  await pick("everyday").click();
  check("m-def everyday: activePreset", await until(async () => (await api("state")).models.activePreset === s.pool, "everyday"));
  const byTask = page.locator("#main #f15-pick-the-model-per-task");
  await byTask.check();
  check("sw:f15-pick-the-model-per-task on: difficulty between the two picks", await until(async () => { const d = (await api("model-savings")).values.difficulty; return d.mode === "when-needed" && d.easyModel === s.pool && d.hardModel === s.pool; }, "by task"));
  await byTask.uncheck();
  check("sw:f15-pick-the-model-per-task off", await until(async () => (await api("model-savings")).values.difficulty.mode === "off", "off"));
}

async function computersAndRules(page) {
  await page.locator('[data-act="setpage"][data-v="computer"]').click();
  await page.locator('#main [data-act="comp-add"]').click();
  for (const [kind, words] of [["sandbox", /private computer/], ["cloud", /keepoak\.com/], ["remote", /safety review/]]) {
    const card = page.locator(`.dlg [data-act="comp-kind"][data-v="${kind}"]`);
    check(`comp-add ${kind}: greyed with its reason`, (await card.getAttribute("aria-disabled")) === "true" && words.test(await card.getAttribute("data-tip") ?? ""));
  }
  await page.keyboard.press("Escape");
  await page.locator('[data-act="setpage"][data-v="permissions"]').click();
  await page.locator('#main [data-act="rule-add8"]').click();
  const save = page.locator('.dlg [data-act="rule-save8"]');
  const emptyAdd = await save.isDisabled();
  await page.locator(".dlg #rule-new8").fill("git status");
  check("rule-save8 waits for words", emptyAdd && !(await save.isDisabled()));
  await page.keyboard.press("Escape");
  await page.locator('#main [data-act="ruletestb17"]').click();
  const run = page.locator('.dlg [data-act="rulerunb17"]');
  const emptyTest = await run.isDisabled();
  await page.locator(".dlg #rule-in-b17").fill("git status");
  await run.click();
  check("rulerunb17 waits for words, then the engine answers", emptyTest && await page.locator(".dlg .res-line-b17").waitFor({ timeout: 10000 }).then(() => true, () => false));
  await page.keyboard.press("Escape");
}

(async () => {
  const stub = await start(0);
  const s = await prepare(stub.port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(BASE);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setlevel"][data-v="technical"]').click();
    await accounts(page, s);
    await defaults(page, s);
    await computersAndRules(page);
  } catch (error) { check("the run finished", false, error.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  stub.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
