/* Settings › Chat apps › "Show steps in chats" in the real window, against the engine's own GET route, with zero page
   errors. The switch is the engine's `steps` chat switch (POST /api/channels/live; src/channels/chat-live-settings.ts).
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> [SHOTS=<folder>] node design/redesign/tools/verify-chatparity.cjs
   1 a fresh engine ships the switch on, and the window draws it checked;
   2 turning it off really changes the engine's switch (GET /api/channels), and the window draws it unchecked;
   3 turning it on again really changes it back. */
const { join } = require("node:path");
const { chromium } = require(join(__dirname, "../../../node_modules/playwright"));

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, SHOTS = process.env.SHOTS;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
if (["3210", "3299", "3300"].includes(PORT)) { console.error("Never the owner's ports."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, origin: BASE, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const steps = async () => (await api("channels")).live?.steps;
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

(async () => {
  await api("onboarding", { done: true });
  check("1 the engine ships Show steps in chats on", await steps() === "on");
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Before signing in the window asks once without a key (401); that is how it finds the sign-in screen, not an error.
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.keyboard.press("Control+Comma");
  await page.locator(`[data-act="setpage"][data-v="chatapps"]`).click();
  const box = page.locator("#f15-show-steps-in-chats");
  await box.waitFor({ timeout: 15000 });
  check("1 the window draws it checked", await box.isChecked());
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "chatparity-on.png") });

  await box.click();
  check("2 off reaches the engine", await until(async () => await steps() === "off"));
  await until(async () => !(await page.locator("#f15-show-steps-in-chats").isChecked()));
  check("2 the window draws it unchecked", !(await page.locator("#f15-show-steps-in-chats").isChecked()));

  await page.locator("#f15-show-steps-in-chats").click();
  check("3 on reaches the engine", await until(async () => await steps() === "on"));
  check("3 the window draws it checked", await until(() => page.locator("#f15-show-steps-in-chats").isChecked()));

  check("zero page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
