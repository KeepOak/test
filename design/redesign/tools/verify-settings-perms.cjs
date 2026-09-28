/* Settings › Permissions › Messages per conversation per hour, against a running throwaway engine:
     PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-settings-perms.cjs
   In a headless browser: the box shows the engine's figure (60 as shipped), a new figure is saved and confirmed through
   GET /api/knobs (limits.messagesPerConversationHour), and a figure that is not a whole number is not sent. What the
   limit does to tasks is covered by tests/conversation-rate.test.mjs. */
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
const rate = async () => (await api("knobs")).values.limits.messagesPerConversationHour;

async function permissions(page) {
  await page.locator('[data-act="setpage"][data-v="permissions"]').click();
  const box = page.locator("#main #p-rate");
  await box.waitFor({ timeout: 10000 });
  check("sw:p-rate is live and shows the engine's figure", !(await box.isDisabled()) && await until(async () => (await box.inputValue()) === "60", "60"));
  await box.fill("25");
  await box.press("Tab");
  check("sw:p-rate → limits.messagesPerConversationHour 25", await until(async () => (await rate()) === 25, "25"));
  await page.locator("#main #p-rate").fill("lots");
  await page.locator("#main #p-rate").press("Tab");
  check("not a whole number: nothing is sent and the box shows the engine's figure", await until(async () => (await page.locator("#main #p-rate").inputValue()) === "25", "25 again") && (await rate()) === 25);
  await page.locator("#main #p-rate").fill("60");
  await page.locator("#main #p-rate").press("Tab");
  check("sw:p-rate back → 60", await until(async () => (await rate()) === 60, "60"));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api("onboarding", { done: true });
    await page.goto(BASE);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setlevel"][data-v="technical"]').click();
    await permissions(page);
  } catch (error) { check("the run finished", false, error.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
