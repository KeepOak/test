// Measures the CPU the window uses once it is left alone: Branch's face, four Trunks listed (two painted characters, one
// character with no sleep loop, one pebble), the pet and the painted scene, with one Trunk's conversation open. No input
// at all after it loads. The share of one core used by every Chromium process (CDP SystemInfo.getProcessInfo) is
// sampled for SAMPLE seconds ending at each checkpoint (default 3 and 12 minutes), with what still moves then: videos
// playing, pebble faces drawing, CSS animations running. Headed Chromium, 1366x900, as verify-motion-cpu.cjs, placed off
// screen so that a real pointer passing over it does not count as input.
// ACTIVE=1 has the owner at the window instead: the pointer moves every 20 seconds over the open conversation.
//   PORT=<port> TOKEN=<session token> OPEN=<session id to open> [AT=180,720] [SAMPLE=30] [ACTIVE=1]
//   node design/redesign/tools/verify-sleep-cpu.cjs
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, OPEN = process.env.OPEN || "";
const AT = (process.env.AT || "180,720").split(",").map(Number), SAMPLE = Number(process.env.SAMPLE || 30);
const base = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function cpu(session) {
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  return processInfo.reduce((a, p) => a + p.cpuTime, 0);
}

/* What still moves: videos playing (awake loops and sleeping ones), pebble canvases that changed over a second, running
   CSS animations, and the faces (by their key, core/sleep.js data-rk) with a video playing or a canvas changing. */
const moving = (page) => page.evaluate(async () => {
  const shot = () => new Map([...document.querySelectorAll(".pbl-cv")].map((c) => [c, c.toDataURL()]));
  const a = shot();
  await new Promise((r) => setTimeout(r, 1000));
  const b = shot(), changed = [...b].filter(([c, url]) => a.has(c) && a.get(c) !== url).map(([c]) => c);
  const playing = [...document.querySelectorAll("video")].filter((v) => !v.paused);
  const faces = new Set([...playing, ...changed].map((el) => el.closest("[data-rk]")?.dataset.rk).filter(Boolean));
  return {
    videosAwake: playing.filter((v) => !/sleep/.test(v.src)).length,
    videosAsleep: playing.filter((v) => /sleep/.test(v.src)).length,
    pebblesChanging: changed.length,
    cssRunning: document.getAnimations().filter((x) => x.playState === "running").length,
    facesMoving: faces.size,
    asleep: document.documentElement.className.match(/(doze18|still18)/)?.[1] ?? "awake",
  };
});

(async () => {
  if (!PORT || !TOKEN) throw new Error("PORT and TOKEN are needed");
  const browser = await chromium.launch({ headless: false, args: ["--disable-backgrounding-occluded-windows", "--window-position=-2400,0"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "no-preference", serviceWorkers: "block" });
  await context.addInitScript(`try { sessionStorage.setItem("branch-token", ${JSON.stringify(TOKEN)}); } catch {}`);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/");
  await page.waitForSelector("#app #side .list .row", { timeout: 30000 });
  if (OPEN) await page.evaluate((id) => document.querySelector(`#side [data-id="${id}"]`)?.click(), OPEN);
  const start = Date.now(), session = await browser.newBrowserCDPSession();
  let step = 0;
  const active = process.env.ACTIVE ? setInterval(() => page.mouse.move(800 + (step++ % 2) * 20, 450).catch(() => {}), 20000) : null;
  for (const at of AT) {
    await wait(Math.max(0, start + (at - SAMPLE) * 1000 - Date.now()));
    const c0 = await cpu(session), t0 = Date.now();
    await wait(SAMPLE * 1000);
    const used = (await cpu(session)) - c0, secs = (Date.now() - t0) / 1000;
    console.log(JSON.stringify({ minute: at / 60, cpuPercentOfOneCore: Math.round((used / secs) * 1000) / 10, ...(await moving(page)), pageErrors: errors.length }));
  }
  clearInterval(active);
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
