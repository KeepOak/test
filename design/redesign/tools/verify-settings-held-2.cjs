/* Settings controls that were held for engine work (lane settings2), against a running throwaway engine:
     PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-settings-held-2.cjs
   Clicks each control this work made live in a headless browser and confirms the change through the engine's own GET
   route. Nothing leaves this computer. Covered: sw:f15-slow-down-near-a-rate-limit (model-savings pacing). */
const PW = process.env.PLAYWRIGHT ?? "playwright";
const { chromium } = require(PW);

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

async function pacing(page) {
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  const pace = page.locator("#main #f15-slow-down-near-a-rate-limit");
  await pace.waitFor({ timeout: 10000 });
  check("sw:f15-slow-down-near-a-rate-limit is live and on as shipped", !(await pace.isDisabled()) && (await api("model-savings")).values.pacing.mode === "on"
    && await until(() => pace.isChecked(), "drawn on"));
  await pace.uncheck();
  check("sw:f15-slow-down-near-a-rate-limit off: the pacing card is off", await until(async () => (await api("model-savings")).values.pacing.mode === "off", "off"));
  await pace.check();
  check("sw:f15-slow-down-near-a-rate-limit on again", await until(async () => (await api("model-savings")).values.pacing.mode === "on", "on"));
}

const STEPS = [pacing];

(async () => {
  await api("onboarding", { done: true });
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
    for (const step of STEPS) await step(page);
  } catch (error) { check("the run finished", false, error.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
