// Screenshots for the title bar wordmark and icon/text alignment pass: the header of a new conversation and of a
// Trunk's conversation at 1440, 1024 and 390, light and dark, Windows and Mac, at 1x and 2x; the ask-mode menu's
// Lockdown row and the composer's mode chip with Lockdown on. Use a throwaway engine (it makes a Trunk and switches
// Lockdown on and off). Records page errors and exits non-zero when there are any.
// Run: PORT=<port> TOKEN=<session token> PREFIX=before|after [OUT=<folder>] node design/redesign/tools/shots-chrome-wordmark.cjs
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const fs = require("fs");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, PREFIX = process.env.PREFIX || "shot";
const OUT = (process.env.OUT || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/chrome-wordmark").replace(/\/?$/, "/");
const BASE = `http://127.0.0.1:${PORT}`;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, { width, height, scale, theme, mac }, errors) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme });
  if (mac) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine", { timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: `${OUT}${PREFIX}-failed.png` }); throw e; });
  if (await page.isVisible(".ob9")) await page.click('.ob9 [data-act="ob-close"]');
  await wait(900);
  return { ctx, page };
}

async function trunkRow(page, id) {
  const row = page.locator(`#side .row[data-id="${id}"]`);
  // On a narrow window the list is slid away; the row's own click handler opens the conversation either way.
  if (await row.count()) { await row.first().evaluate((el) => el.click()); await wait(700); return true; }
  return false;
}

(async () => {
  const errors = [];
  await api("onboarding", { done: true });
  const look = async (theme) => api("preferences", { ...(await api("state")).preferences, appearance: theme === "dark" ? "forest" : "daylight", followSystem: false });
  const trunks = (await api("trunks")).trunks ?? [];
  const trunk = trunks.find((t) => t.name === "Researcher") ?? (await api("trunks", { name: "Researcher", title: "Research", description: "Finds sources" })).trunk;
  const browser = await chromium.launch();
  const sizes = [[1440, 900], [1024, 768], [390, 844]];
  for (const theme of ["light", "dark"]) for (const scale of [1, 2]) for (const mac of [false, true]) for (const [width, height] of sizes) {
    await look(theme);
    if (mac && (theme === "dark" || width === 390)) continue;
    const { ctx, page } = await open(browser, { width, height, scale, theme, mac }, errors);
    const name = `${width}-${theme}${mac ? "-mac" : ""}-${scale}x`;
    const clip = { x: 0, y: 0, width, height: width < 761 ? 130 : 90 };
    await page.screenshot({ path: `${OUT}${PREFIX}-new-${name}.png`, clip });
    if (scale === 1 && !mac) await page.screenshot({ path: `${OUT}${PREFIX}-full-new-${width}-${theme}.png` });
    if (scale === 1 && !mac && width === 1440) {
      await page.click('#side [data-act="view"][data-v="library"]');
      await wait(600);
      await page.screenshot({ path: `${OUT}${PREFIX}-full-place-${width}-${theme}.png` });
      await page.evaluate(() => document.querySelector('#side .row[data-id]')?.click());
      await wait(700);
    }
    // The wordmark's other home, drawn only here for comparison (never shipped): small and quiet at the list's foot,
    // above the owner, in a new conversation as option A's shot is.
    if (PREFIX === "after" && scale === 1 && !mac && width !== 390) {
      await page.evaluate(() => document.querySelector('#side [data-act="newmenu"]').click());
      await page.click('.pop [data-act="newconv"]');
      await wait(600);
      await page.evaluate(() => {
        document.querySelector(".wm17")?.remove();
        const mark = Object.assign(document.createElement("p"), { className: "wm17", innerHTML: "Branch <span>Agent</span>" });
        Object.assign(mark.style, { margin: "0 0 6px 22px", textAlign: "left" });
        document.querySelector("#side .owner-wrap")?.before(mark);
      });
      await page.screenshot({ path: `${OUT}${PREFIX}-option-b-side-${width}-${theme}.png` });
    }
    if (trunk.chatSessionId && await trunkRow(page, trunk.chatSessionId)) {
      await page.screenshot({ path: `${OUT}${PREFIX}-trunk-${name}.png`, clip });
    }
    await ctx.close();
  }
  await look("light");
  for (const scale of [1, 2]) {
    const { ctx, page } = await open(browser, { width: 1440, height: 900, scale, theme: "light" }, errors);
    await page.click('[data-act="modemenu2"]');
    await wait(500);
    const pop = page.locator("#app > .pop").first();
    await pop.screenshot({ path: `${OUT}${PREFIX}-modemenu-${scale}x.png` });
    const row = page.locator("#app > .pop .row-in").last();
    await row.screenshot({ path: `${OUT}${PREFIX}-lockrow-${scale}x.png` });
    await page.keyboard.press("Escape");
    await wait(200);
    // The plus menu's two switch rows: Temporary conversation, Ask me questions first.
    await page.click('[data-act="plusmenu"]');
    await wait(500);
    const rows = page.locator("#app > .pop .row-in");
    for (let i = 0; i < Math.min(2, await rows.count()); i++) await rows.nth(i).screenshot({ path: `${OUT}${PREFIX}-plusrow${i + 1}-${scale}x.png` });
    await page.keyboard.press("Escape");
    await api("lockdown", { on: true });
    await page.reload();
    await wait(1500);
    const chip = page.locator('[data-act="modemenu2"]').first();
    await chip.screenshot({ path: `${OUT}${PREFIX}-lockchip-${scale}x.png` });
    await page.locator(".statusbar").screenshot({ path: `${OUT}${PREFIX}-statusbar-${scale}x.png` });
    if (scale === 1) {
      // Lockdown's banners with the floating row: a conversation and a place.
      await page.screenshot({ path: `${OUT}${PREFIX}-locked-chat-1440.png` });
      await page.click('#side [data-act="view"][data-v="library"]');
      await wait(700);
      await page.screenshot({ path: `${OUT}${PREFIX}-locked-place-1440.png` });
    }
    await api("lockdown", { on: false });
    await ctx.close();
  }
  await browser.close();
  console.log(`page errors: ${errors.length}`);
  for (const e of errors) console.log("  " + e);
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
