/* Decision models' uses (Settings › Models › Decision models), against a running throwaway engine:
     PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-settings-decisions.cjs
   Adds a stand-in model service on this computer (stub-model-decisions.cjs), starts eleven tasks in Ask first that each wait
   for a yes (Inbox › Needs you), then in a headless browser: switches "Sort the Inbox by urgency" on and off and "Send each
   message to the right Trunk" on and off, each confirmed through GET /api/decisions, and checks the Inbox draws the urgent
   request first while sorting is on and in the order they came while it is off, and that eleven waiting rows are asked
   about once (eight scored), not in a chain of redraws. Nothing leaves this computer. */
const path = require("node:path");
const PW = process.env.PLAYWRIGHT ?? "playwright";
const { chromium } = require(PW);
const { start } = require(path.join(__dirname, "stub-model-decisions.cjs"));

const BASE = `http://127.0.0.1:${process.env.PORT}`, TOKEN = process.env.TOKEN;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}
const until = async (read, what) => {
  for (let i = 0; i < 200; i++) { if (await read().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 100)); }
  console.log(`  never happened: ${what}`);
  return false;
};

async function prepare(stubPort) {
  const made = await api("connections/from-preset", { provider: "custom", key: "verify-decisions-key", model: "stub-model", extras: { baseUrl: `http://127.0.0.1:${stubPort}/v1` } });
  await api("models", { activePreset: made.id });
  await api("onboarding", { done: true });
  // Two tasks that wait for a yes, the plain one first. Each /api/run answers once its task stops to ask.
  for (const words of ["lunch-notes", "invoice-due-tomorrow", ...Array.from({ length: 9 }, (_, i) => `note-${i + 1}`)])
    await fetch(`${BASE}/api/run`, { method: "POST", headers, body: JSON.stringify({ prompt: `RUN ${words}`, mode: "ask" }) });
  const waiting = (await api("policy")).waiting ?? [];
  if (!["lunch", "invoice"].every((w) => waiting.some((q) => q.label.includes(w)))) throw new Error(`the two requests are not waiting (${waiting.length} are)`);
}

const go = (page, v) => page.evaluate((view) => document.querySelector(`[data-act="view"][data-v="${view}"]`)?.click(), v);
const rowsNow = (page) => page.locator("#main .rows .prow b").allInnerTexts();

async function decisions(page) {
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  const sort = page.locator("#main #f15-sort-the-inbox-by-urgency"), route = page.locator("#main #f15-send-each-message-to-the-right-trunk");
  await sort.waitFor({ timeout: 10000 });
  check("both switches are live and off as shipped", !(await sort.isDisabled()) && !(await route.isDisabled()) && !(await sort.isChecked()) && !(await route.isChecked()));
  await route.check();
  check("sw:f15-send-each-message-to-the-right-trunk on: settings.route", await until(async () => (await api("decisions")).settings.route === true, "route on"));
  await page.locator("#main #f15-send-each-message-to-the-right-trunk").uncheck();
  check("sw:f15-send-each-message-to-the-right-trunk off", await until(async () => (await api("decisions")).settings.route === false, "route off"));
  await go(page, "inbox");
  await until(async () => (await rowsNow(page)).length >= 2, "two rows");
  const before = await rowsNow(page);
  check("sorting off: the rows keep the order they came in", /lunch/.test(before[0] ?? "") && /invoice/.test(before[1] ?? ""), before.join(" | "));
  await go(page, "settings");
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  await page.locator("#main #f15-sort-the-inbox-by-urgency").check();
  check("sw:f15-sort-the-inbox-by-urgency on: settings.inbox", await until(async () => (await api("decisions")).settings.inbox === true, "inbox on"));
  const counted = (await api("decisions")).lastDay.decisions;
  const posts = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/decisions/urgency")) posts.push(Date.now()); });
  await go(page, "inbox");
  check("sorting on: the urgent request is drawn first", await until(async () => /invoice/.test((await rowsNow(page))[0] ?? ""), "invoice first"), (await rowsNow(page)).join(" | "));
  check("eight rows were scored by the decision model, the most one call asks", (await api("decisions")).lastDay.decisions === counted + 8);
  await new Promise((resolve) => setTimeout(resolve, 3000)); // redraws caused by the scores must not ask for the next eight
  check("one ask for eleven rows: a redraw never asks for the next few by itself", posts.length === 1, `${posts.length} asks`);
  await go(page, "settings");
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  await page.locator("#main #f15-sort-the-inbox-by-urgency").uncheck();
  check("sw:f15-sort-the-inbox-by-urgency off", await until(async () => (await api("decisions")).settings.inbox === false, "inbox off"));
  await go(page, "inbox");
  check("sorting off again: back to the order they came in", await until(async () => /lunch/.test((await rowsNow(page))[0] ?? ""), "lunch first"));
}

(async () => {
  const stub = await start(0);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await prepare(stub.port);
    await page.goto(BASE);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await go(page, "settings");
    await page.locator('[data-act="setlevel"][data-v="technical"]').click();
    await decisions(page);
  } catch (error) { check("the run finished", false, error.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  stub.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
