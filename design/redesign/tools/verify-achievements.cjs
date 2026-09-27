/* Settings › Achievements shows what the owner has earned. Proves it in the real window against the engine's own GET
   routes, with zero page errors:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> node design/redesign/tools/seed-achievements.mjs
     BRANCH_DATA_DIR=<same dir> BRANCH_WORKSPACE=<same dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> [SHOTS=<folder>] node design/redesign/tools/verify-achievements.cjs
   1 the record kept from before Q251 (achievements "off" that nobody chose) reads as on, and the seeded past is earned;
   2 the page draws every achievement the engine lists, the earned ones unlocked with the day they were earned in their
     tooltip, the lede's count and each tier's share from the engine;
   3 a category tab shows only the engine's achievements of that kind;
   4 the past arrives quietly: none of what it earned pops up or throws confetti over 20 s of the window's own polling
     (something new, such as opening Settings for the first time, is still celebrated once), and nothing is left "fresh";
   5 "Keep achievements quiet" really changes the engine's switch (GET /api/delight) and leaves achievements on;
   6 Trunks and a settings change made through the engine's routes are part of that past.
   Screenshots, light and dark, desktop and 390 wide, go to SHOTS when it is set. Test data: the seed's six tasks, the
   Trunks "Juniper" and "Rowan", and the pet name "Pip". */
const { join } = require("node:path");
const { chromium } = require(join(__dirname, "../../../node_modules/playwright"));

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, SHOTS = process.env.SHOTS;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}

async function openAchievements(page) {
  await page.keyboard.press("Control+Comma");
  await page.locator(`[data-act="setpage"][data-v="achievements"]`).click();
  await page.locator(".achs .ach").first().waitFor({ timeout: 15000 });
}

(async () => {
  await api("onboarding", { done: true });
  const trunks = (await api("trunks")).trunks ?? [];
  if (!trunks.some((t) => t.name === "Juniper")) await api("trunks", { name: "Juniper" });
  if (!trunks.some((t) => t.name === "Rowan")) await api("trunks", { name: "Rowan" });
  await api("delight/settings", { pets: { name: "Pip" } });
  const summary = await api("delight");
  check("1 an 'off' nobody chose reads as on", summary.settings.achievements.on === true, JSON.stringify(summary.settings.achievements));
  // What the past earned, found at the first look (the settings change above looked); none of it may pop up.
  const past = (await api("delight/achievements?lang=en")).list.filter((a) => a.got).map((a) => a.name);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  // Every pop-up the window shows, however briefly, by the achievement's name.
  await page.addInitScript(() => {
    window.__pops = [];
    new MutationObserver((changes) => { for (const c of changes) for (const n of c.addedNodes) {
      if (n.nodeType === 1 && (n.classList.contains("ach-toast") || n.classList.contains("ach-big"))) window.__pops.push(n.querySelector(".card > b")?.textContent ?? n.textContent);
    } }).observe(document, { childList: true, subtree: true });
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await openAchievements(page);

  const view = await api("delight/achievements?lang=en");
  const earned = view.list.filter((a) => a.got);
  check("1 the seeded past is earned", view.on === true && view.list.find((a) => a.id === "tasks:5")?.got, `earned ${view.earned} of ${view.total}`);
  check("2 every achievement is drawn", await page.locator(".achs .ach").count() === view.list.length);
  check("2 the earned ones are unlocked", await page.locator(".achs .ach:not(.locked)").count() === earned.length, `${earned.length} earned`);
  const titles = await page.locator(".achs .ach:not(.locked)").evaluateAll((els) => els.map((el) => el.title));
  check("2 each earned one has its tier and the day in its tooltip", titles.length > 0 && titles.every((t) => / · .*\d/.test(t)), titles[0]);
  check("2 the lede counts what the engine counts", (await page.locator(".lede").innerText()).includes(`${view.earned} of ${view.total}`));
  const bronze = view.list.filter((a) => a.tier === "Bronze");
  check("2 each tier's share is the engine's", (await page.locator(".ach-sum .tierc").first().innerText()).includes(`${bronze.filter((a) => a.got).length}/${bronze.length}`));

  const kind = "Getting started";
  await page.locator(`[data-act="achcat"][data-v="${kind}"]`).click();
  check("3 a category shows only its own", await page.locator(".achs .ach").count() === view.list.filter((a) => a.kind === kind).length);
  await page.locator(`[data-act="achcat"][data-v="All"]`).click();

  await page.waitForTimeout(20000); // the window's own polling, at least one full look
  const pops = await page.evaluate(() => window.__pops);
  check("4 nothing the past earned pops up", past.length > 0 && !pops.some((text) => past.some((name) => text.includes(` · ${name} · `) || text === name)), `${past.length} earned quietly; popped: ${JSON.stringify(pops)}`);
  check("4 nothing is left to celebrate", (await api("delight/achievements?lang=en")).fresh.length === 0);

  if (SHOTS) {
    // Daylight and Forest, as the pass 17 shots switch them (the engine's preferences), each drawn afresh.
    for (const [scheme, appearance] of [["light", "daylight"], ["dark", "forest"]]) {
      const prefs = (await api("state")).preferences;
      await api("preferences", { ...prefs, appearance, followSystem: false });
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.reload();
      await page.locator("#prompt").waitFor({ timeout: 60000 });
      await openAchievements(page);
      for (const [w, h] of [[1280, 860], [390, 844]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.locator(".ach-toast, .ach-big").first().waitFor({ state: "detached", timeout: 12000 }).catch(() => null); // a pop-up still up after 12 s is drawn as it is
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SHOTS, `achievements-${scheme}-${w}.png`) });
      }
    }
    await page.setViewportSize({ width: 1280, height: 860 });
  }

  await page.locator("#ach-q").check();
  await page.waitForTimeout(800);
  const quiet = await api("delight");
  check("5 keep quiet changes the engine's switch and leaves them on", quiet.settings.achievements.quiet === true && quiet.settings.achievements.on === true);
  await page.locator("#ach-q").uncheck();
  await page.waitForTimeout(800);
  check("5 and back", (await api("delight")).settings.achievements.quiet === false);

  const names = (await api("trunks")).trunks.map((t) => t.name);
  check("6 the Trunks made through the engine are there", names.includes("Juniper") && names.includes("Rowan"));
  check("zero page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
