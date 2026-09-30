/* Settings › Chat apps: What the Trunk sees and Staying connected, against a running throwaway engine:
     PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-settings-chatapps.cjs
   In a headless browser: every switch, both rows of choices and the "stalled after" box are live and drawn from the
   engine, and each change is confirmed through GET /api/channels (`intake`). No chat app is connected, so nothing is
   sent anywhere (online status would change a bot's profile only on a connected app). The per-app watchdog line and
   what each setting does to real messages are covered by tests/chat-intake.test.mjs. */
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
const intake = async () => (await api("channels")).intake;

async function chatapps(page) {
  await page.locator('[data-act="setpage"][data-v="chatapps"]').click();
  const switches = [["f15-edited-messages", "edited", true], ["f15-photo-albums-as-one-message", "albums", true],
    ["f15-watch-for-a-chat-app-that-stops-receivin", "watchdog", true], ["f15-show-online-or-offline-in-the-app", "presence", false]];
  for (const [id, field, shipped] of switches) {
    const box = page.locator(`#main #${id}`);
    await box.waitFor({ timeout: 10000 });
    check(`sw:${id} is live and drawn as the engine has it (${shipped ? "on" : "off"})`, !(await box.isDisabled()) && await until(async () => (await box.isChecked()) === shipped, "drawn"));
    await box.setChecked(!shipped);
    check(`sw:${id} → intake.${field} ${!shipped}`, await until(async () => (await intake())[field] === !shipped, field));
    await page.locator(`#main #${id}`).setChecked(shipped);
    check(`sw:${id} back → intake.${field} ${shipped}`, await until(async () => (await intake())[field] === shipped, field));
  }
  await page.locator('#main [data-act="ca-split"][data-v="3000"]').click();
  check("ca-split 3 seconds → intake.splitWaitMs 3000", await until(async () => (await intake()).splitWaitMs === 3000, "split"));
  await page.locator('#main [data-act="ca-split"][data-v="0"]').click();
  check("ca-split Off → intake.splitWaitMs 0", await until(async () => (await intake()).splitWaitMs === 0, "split off"));
  await page.locator('#main [data-act="ca-reconnect"][data-v="10"]').click();
  check("ca-reconnect 10 minutes → intake.reconnectMinutes 10", await until(async () => (await intake()).reconnectMinutes === 10, "reconnect"));
  const stall = page.locator("#main #ca-stall17d");
  check("ca-stall17d shows the engine's figure", await until(async () => (await stall.inputValue()) === "90", "90"));
  await stall.fill("120");
  await stall.press("Tab");
  check("ca-stall17d → intake.stalledAfterSeconds 120", await until(async () => (await intake()).stalledAfterSeconds === 120, "stall"));
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
    await chatapps(page);
  } catch (error) { check("the run finished", false, error.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
