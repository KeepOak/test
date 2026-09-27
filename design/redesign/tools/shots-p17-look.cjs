// Screenshots for the pass 17 look: the chat, a place (Automations) and Settings at 1440 and 390, in Daylight and
// Moonlight, plus a popover and a dialog at 1440. Use a throwaway engine: it switches light and dark in the preferences.
// Run: PORT=<port> TOKEN=<session token> PREFIX=before|after [OUT=<folder>] node design/redesign/tools/shots-p17-look.cjs
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const fs = require("fs");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, PREFIX = process.env.PREFIX || "shot";
const OUT = (process.env.OUT || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/p17port").replace(/\/?$/, "/");
const BASE = `http://127.0.0.1:${PORT}`;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({}));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const soft = (p) => p.catch(() => {});

async function screens(page, mode) {
  const list = [
    ["chat", async () => { const row = page.locator("#side .row").first(); if (await row.count()) await row.click(); }],
    ["place", () => page.click('#side [data-act="view"][data-v="automations"]')],
    ["settings", () => page.click('#side .owner-row [data-act="view"][data-v="settings"]')],
  ];
  for (const [name, go] of list) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await wait(200);
    await go();
    await wait(500);
    await page.screenshot({ path: `${OUT}${PREFIX}-${name}-1440${mode}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(500);
    await page.screenshot({ path: `${OUT}${PREFIX}-${name}-390${mode}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await wait(300);
  await soft(page.click("#side .owner", { timeout: 3000 }));
  await wait(400);
  await page.screenshot({ path: `${OUT}${PREFIX}-pop-owner-1440${mode}.png` });
  await page.keyboard.press("Escape");
  await page.mouse.click(900, 450);
  await soft(page.click('#side .owner-row [data-act="view"][data-v="settings"]', { timeout: 3000 }));
  await soft(page.click('[data-act="setpage"][data-v="appearance"]', { timeout: 3000 }));
  await soft(page.click('[data-act="skins"]', { timeout: 3000 }));
  await wait(500);
  await page.screenshot({ path: `${OUT}${PREFIX}-dlg-skins-1440${mode}.png` });
  await soft(page.click('[data-act="dlg-close"]', { timeout: 3000 }));
}

(async () => {
  await api("onboarding", { done: true });
  const st = await api("state");
  if (!(st.sessions ?? []).length) await api("run", { prompt: "Summarise what is in my Downloads folder" });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine");
  if (await page.isVisible(".ob9")) await page.click('.ob9 [data-act="ob-close"]');
  for (const [mode, appearance] of [["light", "daylight"], ["dark", "forest"]]) {
    const prefs = (await api("state")).preferences;
    await api("preferences", { ...prefs, appearance, followSystem: false });
    await page.reload();
    await page.waitForSelector("#side .machine");
    await wait(600);
    await screens(page, mode);
  }
  console.log(`saved to ${OUT}; page errors: ${errors.length}`, errors.slice(0, 5));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
