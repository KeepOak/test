/* Settings › Models: Mix models on hard questions, and OpenRouter's "Only ones I list", against a running throwaway engine:
     PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-settings-models-more.cjs
   Adds two stand-in model connections on this computer (stub-model-b6 through the catalogue's "custom" connection), picks
   them for hard and easy tasks, then in a headless browser: the mix switch is greyed with its reason until Pick the model
   per task is on, then switches on and off, each confirmed through GET /api/model-savings (difficulty.mixHard, and the
   mixture in liveMixtures). With no OpenRouter connection, "Only ones I list" stays greyed with its reason. OpenRouter's
   list itself is covered by tests/models-mix-openrouter.test.mjs: asking openrouter.ai would leave this computer. */
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
  const one = await api("connections/from-preset", { provider: "custom", key: "verify-mix-a", model: "stub-model", extras: { baseUrl: `http://127.0.0.1:${stubPort}/v1` } });
  const two = await api("connections/from-preset", { provider: "custom", key: "verify-mix-b", model: "stub-model", name: "Second stub", extras: { baseUrl: `http://127.0.0.1:${stubPort}/v1` } });
  await api("onboarding", { done: true });
  await api("model-savings", { card: "phases", values: { planModel: one.id } });
  await api("knobs", { card: "subtasks", values: { subtaskModel: two.id } });
  return { hard: one.id, easy: two.id };
}

async function mixing(page, s) {
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  const perTask = page.locator("#main #f15-pick-the-model-per-task");
  await perTask.waitFor({ timeout: 10000 });
  const greyed = page.locator('#main input.sw[data-why="f15-mix-models-on-hard-questions"]');
  check("mix: greyed with its reason while Pick the model per task is off", await until(async () => (await greyed.count()) === 1 && /Pick the model per task/.test(await whyOf(greyed) ?? ""), "greyed"));
  await perTask.check();
  await until(async () => (await api("model-savings")).values.difficulty.mode !== "off", "per task on");
  const mix = page.locator("#main #f15-mix-models-on-hard-questions");
  await mix.waitFor({ timeout: 10000 });
  check("mix: live once both picks differ, off until chosen", !(await mix.isDisabled()) && !(await mix.isChecked()));
  await mix.check();
  check("sw:f15-mix-models-on-hard-questions on: difficulty.mixHard and the mixture is live", await until(async () => { const v = await api("model-savings"); return v.values.difficulty.mixHard === true && v.liveMixtures.includes("mixture-hard-questions"); }, "mix on"));
  await page.locator("#main #f15-mix-models-on-hard-questions").uncheck();
  check("sw:f15-mix-models-on-hard-questions off: the mixture leaves", await until(async () => { const v = await api("model-savings"); return v.values.difficulty.mixHard === false && !v.liveMixtures.includes("mixture-hard-questions"); }, "mix off"));
  await page.locator("#main #f15-pick-the-model-per-task").uncheck();
  await until(async () => (await api("model-savings")).values.difficulty.mode === "off", "per task off");
}

async function openRouter(page) {
  const only = page.locator('#main [data-why="m-openrouter-only"]');
  check("Only ones I list: greyed with its reason with no OpenRouter connection", (await api("model-savings")).openRouter === false
    && await until(async () => (await only.count()) === 1 && /OpenRouter connection first/.test(await only.getAttribute("data-tip") ?? await whyOf(only) ?? ""), "greyed"));
}

(async () => {
  const stub = await start(0);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const s = await prepare(stub.port);
    await page.goto(BASE);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setlevel"][data-v="technical"]').click();
    await mixing(page, s);
    await openRouter(page);
  } catch (error) { check("the run finished", false, error.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  stub.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
