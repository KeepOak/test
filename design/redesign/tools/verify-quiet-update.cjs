// Before/after: what a background Beta build does to Branch's window and to the owner's other work (the owner,
// 2026-09-27: "when my app is in the middle of updating in the background everything is slow").
// Run it with Electron as the main process, as the updater runs: node_modules/electron/dist/electron.exe <this file>.
// The window is hidden and rendered offscreen; nothing shows on the screen.
//   PORT, TOKEN, SESSION  an engine of your own and a long conversation in it (the thread is scrolled every frame)
//   IMPL                  none (the probes alone), before (dev-build.js from DIST, in this process, as main did),
//                         after (the build's own low-priority process, build-client.js from DIST)
//   DIST, COMMIT, BUILD_DIR  the dist folder to take the build from, the Beta commit, a build folder of your own
//   AFFINITY              optional core mask: this process and all it starts share those cores, so the build and
//                         the owner's work compete for them without taking cores from anything else
//   OUT                   where the numbers go (JSON: the whole run and each build step)
// Measured: rAF gaps while scrolling, the time from main sending a key to the page seeing it, main's event-loop
// delay, and a fixed foreground job (hash 64 MB, write and read back 32 MB) every 2 s at normal priority.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { monitorEventLoopDelay } = require("node:perf_hooks");

const FG_JOB = `const { createHash, randomBytes } = require("node:crypto"); const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const data = randomBytes(32 << 20), file = path.join(os.tmpdir(), "quiet-fg-" + process.pid + ".bin");
const job = () => { const t = performance.now(); for (let i = 0; i < 2; i++) createHash("sha256").update(data).digest(); fs.writeFileSync(file, data); fs.readFileSync(file); return performance.now() - t; };
setInterval(() => console.log(job().toFixed(1)), 2000);
process.on("SIGTERM", () => { fs.rmSync(file, { force: true }); process.exit(0); });`;
const E = process.env, IMPL = E.IMPL ?? "none";
const t0 = Date.now(), now = () => Date.now() - t0;
const marks = [];
const mark = (name) => { marks.push({ name, at: now() }); console.log(`${(now() / 1000).toFixed(1)}s ${name}`); };
const frames = [], keys = [], fg = [], eld = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// AFFINITY=<mask>: this process, and so everything it starts (the window's own processes, the build, the canary, the
// owner's stand-in job), shares the same few cores: the build and the owner's work then compete for them, as on a busy
// computer, without taking cores from anything else running here.
if (E.AFFINITY) require("node:child_process").execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${Number(E.AFFINITY)}`]);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(60);
  const sent = new Map(); let inFlight = null;
  win.webContents.on("console-message", (e) => {
    const m = /^qk (\d+)$/.exec(e.message ?? "");
    if (m && sent.has(+m[1])) { keys.push({ at: now(), ms: Number(process.hrtime.bigint() - sent.get(+m[1])) / 1e6 }); sent.delete(+m[1]); inFlight = null; }
    const f = /^qf (.+)$/.exec(e.message ?? "");
    if (f) for (const d of f[1].split(",")) frames.push({ at: now(), ms: +d });
  });
  await win.loadURL(`http://127.0.0.1:${E.PORT}/`);
  const js = (code) => win.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]).catch((e) => `ERR ${e.message}`);
  await wait(1500);
  await js(`(() => { const f = document.getElementById('token'); f.value = ${JSON.stringify(E.TOKEN)}; f.dispatchEvent(new Event('input',{bubbles:true})); [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Connect').click(); })()`);
  await wait(3000);
  await js(`document.querySelector('[data-id="${E.SESSION}"]')?.click()`);
  await wait(2500);
  // Frames: scroll the long conversation up and down every frame (new rows to raster), and report rAF gaps each second.
  console.log("thread rows", await js(`document.getElementById('conversation')?.children.length`));
  await js(`(() => { const box = document.getElementById('scroll'); let dir = 1, last = performance.now(), gaps = [];
    const step = (t) => { gaps.push(Math.round(t - last)); last = t; box.scrollTop += dir * 40; if (box.scrollTop <= 0 || box.scrollTop + box.clientHeight >= box.scrollHeight - 1) dir = -dir; requestAnimationFrame(step); };
    requestAnimationFrame(step); setInterval(() => { if (gaps.length) console.log('qf ' + gaps.splice(0).join(',')); }, 1000);
    document.addEventListener('keydown', (e) => { if (e.key === 'F13') console.log('qk ' + e.keyCode + '' ); }, true); })()`);
  // Keys: F13 every 250 ms; the time from main sending it to the page seeing it (it goes through this process).
  const keyTimer = setInterval(() => {
    if (inFlight !== null && Number(process.hrtime.bigint() - inFlight) / 1e6 < 2000) return;
    if (inFlight !== null) keys.push({ at: now(), ms: 2000, lost: true });
    inFlight = process.hrtime.bigint(); sent.set(124, inFlight);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "F13" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "F13" });
  }, 250);
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  const eldTimer = setInterval(() => { eld.push({ at: now(), p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 }); loop.reset(); }, 1000);
  // The owner's other work: a fixed job (hashing and a file written and read back) every 2 s, at normal priority.
  const fgChild = spawn("node", ["-e", FG_JOB], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  fgChild.stdout.on("data", (c) => { for (const line of String(c).split(/\r?\n/)) if (/^\d+(\.\d+)?$/.test(line.trim())) fg.push({ at: now(), ms: +line }); });
  // The modules the app has loaded already (main imports them at start), so loading them is not counted as the build's.
  const mod = (p) => import(pathToFileURL(join(E.DIST ?? "", p)).href);
  const loaded = IMPL === "none" ? null : { dev: IMPL === "before" ? await mod("desktop/dev-build.js") : null, client: IMPL === "after" ? await mod("desktop/build-client.js") : null, canary: await mod("never-break/canary.js") };
  await wait(4000);
  mark("start");
  let failure = null;
  if (IMPL === "none") await wait(Number(E.DURATION ?? 60) * 1000);
  else {
    const plan = { repo: "stabrea/Branch-Agent", buildDir: E.BUILD_DIR, commit: E.COMMIT, running: null, assetName: "Branch-Agent-windows-x64.zip", platform: "win32",
      onStage: (stage, state) => mark(`${stage}:${state}`), onVersion: () => undefined };
    const log = join(E.BUILD_DIR, "build.log"); mkdirSync(E.BUILD_DIR, { recursive: true }); writeFileSync(log, "");
    let built;
    try {
      if (IMPL === "before") { const dev = loaded.dev; built = await dev.buildDev(dev.realRun("win32", log), plan); }
      else { const h = loaded.client.runHostedBuild(plan, { log }); h.lowered.then((w) => console.log("lowered:", w)); built = await h.done; }
    } catch (error) { failure = `${error.message} | ${error.detail ?? ""}`; }
    if (!failure) {
      const { runCanary, stagedEngine } = loaded.canary;
      const appDir = join(built.folder, readdirSync(built.folder).find((n) => n.startsWith("Branch Agent-")));
      const data = join(E.BUILD_DIR, "..", `canary-${Date.now()}`, "data"); mkdirSync(data, { recursive: true });
      mark("canary");
      const res = await runCanary({ engine: stagedEngine(appDir, "win32", "Branch Agent.exe"), dataCopy: data, expectedVersion: built.version });
      if (!res.ok) failure = `canary: ${res.detail}`;
      mark("swap-copy");
      const into = join(E.BUILD_DIR, "..", "swap-copy");
      await new Promise((r) => spawn(join(process.env.SystemRoot, "System32", "robocopy.exe"), [appDir, into, "/MIR", "/R:1", "/W:1", "/NP", "/NFL", "/NDL"], { stdio: "ignore", windowsHide: true }).on("exit", r));
      rmSync(into, { recursive: true, force: true });
    }
  }
  mark("end");
  clearInterval(keyTimer); clearInterval(eldTimer); fgChild.kill();
  // Windows ends the job without running its own tidy-up, so its file is removed here.
  setTimeout(() => rmSync(join(require("node:os").tmpdir(), `quiet-fg-${fgChild.pid}.bin`), { force: true }), 500);
  await wait(1200);
  const within = (list, a, b) => list.filter((x) => x.at >= a && x.at < b);
  const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1); };
  const summary = (a, b) => {
    const f = within(frames, a, b).map((x) => x.ms), k = within(keys, a, b).map((x) => x.ms), e = within(eld, a, b), j = within(fg, a, b).map((x) => x.ms);
    const secs = (b - a) / 1000;
    return { seconds: +secs.toFixed(1),
      frameP50: pct(f, 50), frameP95: pct(f, 95), frameP99: pct(f, 99), framesOver50msPct: f.length ? +((100 * f.filter((x) => x > 50).length) / f.length).toFixed(2) : null, frameMax: f.length ? Math.max(...f) : null,
      keyP50: pct(k, 50), keyP95: pct(k, 95), keyMax: k.length ? +Math.max(...k).toFixed(1) : null, keysSeen: k.length,
      mainEldP99: pct(e.map((x) => x.p99), 50), mainEldMax: e.length ? +Math.max(...e.map((x) => x.max)).toFixed(1) : null,
      fgJobMedianMs: pct(j, 50), fgJobP90Ms: pct(j, 90), fgJobs: j.length };
  };
  const start = marks.find((m) => m.name === "start").at, end = marks.find((m) => m.name === "end").at;
  const phases = marks.slice(marks.findIndex((m) => m.name === "start"), -1).map((m, i, all) => ({ phase: m.name, ...summary(m.at, all[i + 1]?.at ?? end) })).filter((p) => p.seconds > 0.5);
  const result = { impl: IMPL, commit: E.COMMIT ?? null, failure, whole: summary(start, end), phases };
  writeFileSync(E.OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.whole));
  console.table(phases.map((p) => ({ phase: p.phase, s: p.seconds, f95: p.frameP95, f99: p.frameP99, over50: p.framesOver50msPct, k50: p.keyP50, k95: p.keyP95, kmax: p.keyMax, eldMax: p.mainEldMax, fg: p.fgJobMedianMs })));
  if (failure) console.log("FAILED", failure);
  app.exit(0);
});
