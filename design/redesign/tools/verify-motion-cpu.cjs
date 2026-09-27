// Measures how much CPU the idle window uses, with motion on and with motion reduced, as a share of one core: the
// CPU time of every Chromium process (browser, renderer, GPU, ...) over an idle stretch, from CDP
// SystemInfo.getProcessInfo. Headed Chromium (GPU compositing, as the desktop app draws), 1366x900.
// Prepare the engine as verify-perf.cjs does (seed-perf.mjs for the long conversation, then Trunks on with three
// Trunks and onboarding done), then:
//   PORT=<port> TOKEN=<session token> [REPS=3] [SECS=15] [VIEWS=home,long,hidden] [MODES=motion,still]
//   node design/redesign/tools/verify-motion-cpu.cjs
// Views: home (the empty conversation, its hero loop and the sidebar's faces), long (the longest conversation open),
// hidden (home with another tab in front). Prints each run as JSON, then the median of each view and mode.
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
const SECS = Number(process.env.SECS || 15), REPS = Number(process.env.REPS || 3);
const base = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path) => fetch(`${base}/api/${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());

async function cpu(session) {
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const by = {};
  for (const p of processInfo) by[p.type] = (by[p.type] || 0) + p.cpuTime;
  return by;
}

async function run(view, still) {
  const browser = await chromium.launch({ headless: false, args: ["--disable-backgrounding-occluded-windows"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: still ? "reduce" : "no-preference", serviceWorkers: "block" });
  await context.addInitScript(`try { sessionStorage.setItem("branch-token", ${JSON.stringify(TOKEN)}); } catch {}`);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/");
  await page.waitForSelector("#app #side .list .row", { timeout: 30000 });
  if (view === "long") {
    const sessions = (await api("sessions?limit=50")).sessions ?? [];
    const long = [...sessions].sort((a, b) => b.messageCount - a.messageCount)[0];
    await page.evaluate((id) => document.querySelector(`#side [data-act="chat"][data-id="${id}"]`).click(), long.sessionId);
    await page.waitForFunction(() => document.querySelectorAll("#conversation [data-i15]").length > 20, null, { timeout: 30000 });
  }
  if (view === "hidden") { const other = await context.newPage(); await other.bringToFront(); }
  await wait(6000);
  const session = await browser.newBrowserCDPSession();
  const c0 = await cpu(session), t0 = Date.now();
  await wait(SECS * 1000);
  const c1 = await cpu(session), secs = (Date.now() - t0) / 1000;
  const row = { view, mode: still ? "still" : "motion" };
  let total = 0;
  for (const type of Object.keys(c1)) { const used = c1[type] - (c0[type] || 0); total += used; row[type] = Math.round((used / secs) * 1000) / 10; }
  row.total = Math.round((total / secs) * 1000) / 10;
  row.errors = errors.length;
  await browser.close();
  return row;
}

(async () => {
  if (!PORT || !TOKEN) throw new Error("PORT and TOKEN are needed");
  const views = (process.env.VIEWS || "home,long,hidden").split(","), modes = (process.env.MODES || "motion,still").split(",");
  const rows = [];
  for (const view of views) for (const mode of modes) {
    if (view === "hidden" && mode === "still") continue;
    for (let i = 0; i < REPS; i++) { const row = await run(view, mode === "still"); rows.push(row); console.log(JSON.stringify(row)); }
  }
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  console.log("\n% of one core, median of " + REPS);
  for (const view of views) for (const mode of modes) {
    const mine = rows.filter((r) => r.view === view && r.mode === mode);
    if (mine.length) console.log(`${view.padEnd(7)} ${mode.padEnd(7)} total ${String(median(mine.map((r) => r.total))).padStart(6)}   renderer ${median(mine.map((r) => r.renderer))}   GPU ${median(mine.map((r) => r.GPU ?? 0))}   page errors ${mine.reduce((a, r) => a + r.errors, 0)}`);
  }
})().catch((error) => { console.error(error); process.exit(1); });
