/* The classic pebble's 3D animations (core/pebble.js, art in public/art/pebble, made by design/art/pebble): proves in the
   real window, on a FRESH in-process engine with a scripted model (its own temp folder, a free port), that
     1. each of the ten states plays on a Trunk's face when that Trunk is really in it: tasks the scripted model holds
        mid-turn (think), after looking (search), reading (read) or writing (work) a file, a question to the owner
        (wait), a plain reply (talk), a finished task that wrote a file (yay), a failed task (oops), a paused Trunk
        (sleep), and a Trunk with nothing to do (idle);
     2. the Trunk's colour and shape are the ones drawn, and an eye style reaches the drawing;
     3. hovering and pressing a face play their reactions, and a message arriving wakes an idle Trunk;
     4. with motion reduced (the computer's setting, or the engine's "Keep things still") every face shows its still;
     5. with 30 Trunks on screen, drawing stays cheap (Performance API and the page's own counter);
   and that the page has no errors.
     node design/redesign/tools/verify-pebble-anim.cjs
   Test data it makes through the engine: 30 Trunks named Pebble 1…30, in the temp folder, removed at the end. */
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(150); } }

const COLOURS = ["#2f8c86", "#d8612a", "#8a5aa8", "#5e8c4a", "#4f6fa8", "#c9982e", "#b84a6b", "#56616b"];
const SHAPES = ["circle", "pebble", "leaf", "acorn", "shield"];
const EYES = ["round", "wide", "sleepy"];
const TALK_SETTLE = 6000;   // the Trunks' introductions are plain replies: let their talking end first
const STATES = ["idle", "think", "search", "read", "work", "wait", "talk", "yay", "oops", "sleep"];

/* WebKit (Safari, the Mac app's web view), when Playwright has it: faces move there too, in the Trunk's colour. */
async function webkitLook(base, token, id, colour, hue) {
  const { webkit } = require("playwright");
  let wk;
  try { wk = await webkit.launch(); } catch (e) { check("6 WebKit available to test", false, e.message.split("\n")[0]); return; }
  const page = await wk.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  const px = await until(() => page.evaluate((i) => {
    const c = document.querySelector(`#side .av.pbl[data-pbl-id="${i}"] canvas`);
    return c ? [...c.getContext("2d").getImageData(Math.round(c.width * 0.36), Math.round(c.height * 0.74), 1, 1).data] : null;
  }, id), 15000);
  const want = colour.match(/\w\w/g).map((x) => parseInt(x, 16));
  check("6 in WebKit a face moves on its canvas, in the Trunk's colour", px && px[3] > 200 && Math.abs(hue(px) - hue(want)) < 12, `${px} vs ${want}`);
  check("6 no page errors in WebKit", errors.length === 0, errors.join(" | "));
  await wk.close();
}

/* The scripted model: what it does is named in the message ("pebble:<state>"); held turns wait for the end. */
const gates = [];
const hold = () => new Promise((resolve) => gates.push(resolve));
const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Date.now()}`, name, arguments: JSON.stringify(args) }] });
const provider = { name: "scripted", async complete(request) {
  const msgs = request.messages;
  const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
  const used = msgs.slice(lastUser + 1).some((m) => m.role === "tool");
  const mode = /pebble:(\w+)/.exec(String(msgs[lastUser]?.content ?? ""))?.[1];
  const tag = String(Math.random()).slice(2, 8);
  if (mode === "think") { await hold(); return say("Thought it over."); }
  if (mode === "search") { if (!used) return call("files.search", { query: "pebble" }); await hold(); return say("Found it."); }
  if (mode === "read") { if (!used) return call("files.read", { path: "note.txt" }); await hold(); return say("Read it."); }
  if (mode === "work") { if (!used) return call("files.write", { path: `work-${tag}.txt`, content: "x" }); await hold(); return say("Wrote it."); }
  if (mode === "yay") { if (!used) return call("files.write", { path: `done-${tag}.txt`, content: "x" }); return say("All done."); }
  if (mode === "wait") return call("user.ask", { question: "Which one should I take?" });
  if (mode === "oops") throw new Error("The scripted model refused on purpose.");
  if (mode === "wake") { await hold(); return say("Awake."); }
  return say("Hello there.");
} };

(async () => {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-pebble-anim-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(join(root, "workspace", "note.txt"), "A note to read.");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const base = server.url.replace(/\/$/, "");
  const call_ = async (p, body) => {
    const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
  const browser = await chromium.launch({ headless: !process.env.PEBBLE_HEADED }); // PEBBLE_HEADED=1 measures at the screen's real frame rate
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const sheets = new Set();
  page.on("request", (r) => { const m = /\/art\/pebble\/([\w-]+\.webp)/.exec(r.url()); if (m) sheets.add(m[1]); });
  const LOOK = { face: "pattern", letters: "", emoji: "", shuffle: 0, colour: null, shape: null, motion: "none", depth: "flat" };
  try {
    await call_("onboarding", { done: true });
    await call_("trunks/switch", { part: "trunks", mode: "on" });
    const trunks = [];
    for (let i = 0; i < 30; i++) {
      const { trunk } = await call_("trunks", { name: `Pebble ${i + 1}`, title: "Test" });
      await call_(`trunks/${trunk.id}`, { chosenColour: COLOURS[i % 8], look: { ...LOOK, shape: SHAPES[i % 5] }, eyes: EYES[i % 3] });
      trunks.push(trunk);
    }
    await app.trunks.introduced();
    await page.goto(base + "/");
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#prompt").waitFor({ timeout: 60000 });
    await page.waitForTimeout(TALK_SETTLE);
    const ids = trunks.map((t) => t.id);
    const face = (id) => page.locator(`#side .av.pbl[data-pbl-id="${id}"]`).first();
    const show = (id) => page.evaluate((i) => document.querySelector(`#side .av.pbl[data-pbl-id="${i}"]`)?.dataset.pblShow ?? null, id);
    const where = (id) => page.evaluate((i) => { const el = document.querySelector(`#side .av.pbl[data-pbl-id="${i}"]`); if (!el) return "no face"; const r = el.getBoundingClientRect(); return `top ${Math.round(r.top)}, ${el.className}`; }, id);
    /* Every value a face acted out, recorded in the page as it happens (reactions last well under a second). */
    await page.evaluate(() => {
      window.__shows = {};
      new MutationObserver((rs) => { for (const r of rs) { const id = r.target.dataset.pblId, v = r.target.dataset.pblShow; if (id && v) (window.__shows[id] ??= []).push(v); } })
        .observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-pbl-show"] });
    });
    const shows = (id) => page.evaluate((i) => window.__shows[i] ?? [], id);

    /* 1. The ten states, each on its own Trunk (the first ten in the sidebar). */
    check("1 the sidebar draws the Trunks as 3D pebbles", await until(async () => (await page.locator("#side .av.pbl").count()) >= 10), `${await page.locator("#side .av.pbl").count()} faces`);
    /* The newest Trunks head the sidebar, so the states go to those (a face out of view rests on its still). */
    const by = Object.fromEntries(STATES.map((s, i) => [s, trunks[trunks.length - 1 - i]]));
    const send = (s) => call_("run", { prompt: `pebble:${s}`, sessionId: by[s].chatSessionId }).catch((e) => e);
    for (const s of ["think", "search", "read", "work", "wait", "oops"]) send(s);
    await call_(`trunks/${by.sleep.id}/pause`, { now: false });
    /* Idle: the Trunks that were given nothing to do (only the busiest faces move, so any one of them that does). */
    const driven = new Set(Object.values(by).map((t) => t.id).filter((id) => id !== by.idle.id));
    const idleNow = () => page.evaluate((busy) => [...document.querySelectorAll('#side .av.pbl[data-pbl-show="idle"]')].map((el) => el.dataset.pblId).find((id) => !busy.includes(id)) ?? null, [...driven]);
    const idleId = await until(idleNow, 20000);
    check("1 idle: a Trunk with nothing to do plays idle", !!idleId);
    if (idleId) by.idle = trunks.find((t) => t.id === idleId);
    for (const s of ["think", "search", "read", "work", "wait", "oops", "sleep"]) {
      const ok = await until(async () => { await face(by[s].id).scrollIntoViewIfNeeded(); return (await show(by[s].id)) === s; }, 20000);
      check(`1 ${s}: the face plays ${s} while the Trunk is in it`, ok, `shows ${await show(by[s].id)}; ${await where(by[s].id)}`);
    }
    if (process.env.PEBBLE_SHOTS) { // a picture of the sidebar with the states playing, for a reviewer
      await page.locator("#side").evaluate((el) => el.querySelector(".av.pbl")?.scrollIntoView({ block: "start" }));
      await page.locator("#side").screenshot({ path: join(process.env.PEBBLE_SHOTS, "sidebar-states.png") });
    }
    const run = await call_("run", { prompt: "pebble:talk", sessionId: by.talk.chatSessionId });
    check("1 talk: a plain reply makes its Trunk talk", run.status === "completed" && await until(async () => (await shows(by.talk.id)).includes("talk"), 6000), JSON.stringify((await shows(by.talk.id)).slice(-4)));
    const done = await call_("run", { prompt: "pebble:yay", sessionId: by.yay.chatSessionId });
    check("1 yay: a finished task that wrote a file celebrates", done.status === "completed" && await until(async () => { await face(by.yay.id).scrollIntoViewIfNeeded(); return (await shows(by.yay.id)).includes("yay"); }, 6000), `${JSON.stringify((await shows(by.yay.id)).slice(-4))}; ${await where(by.yay.id)}`);
    check("1 the states come from the engine: the held tasks are running there", (await call_("state")).runs.filter((r) => r.status === "running").length >= 4);

    /* 2. Colour, shape and eyes. */
    const pixel = await until(async () => { await face(by.idle.id).scrollIntoViewIfNeeded(); return page.evaluate((id) => {
      const c = document.querySelector(`#side .av.pbl[data-pbl-id="${id}"] canvas`);
      if (!c) return null;
      const d = c.getContext("2d").getImageData(Math.round(c.width * 0.36), Math.round(c.height * 0.74), 1, 1).data;
      return [...d];
    }, by.idle.id); }, 6000);
    const hue = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn || 1; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
    const want = COLOURS[trunks.indexOf(by.idle) % 8].match(/\w\w/g).map((x) => parseInt(x, 16));
    check("2 the body is drawn in the Trunk's colour (same hue, shaded)", pixel && pixel[3] > 200 && Math.abs(hue(pixel) - hue(want)) < 12, `${pixel} vs ${want}`);
    const shapes = await page.evaluate((list) => list.map((id) => document.querySelector(`#side .av.pbl[data-pbl-id="${id}"]`)?.dataset.pblShape), ids.slice(0, 5));
    check("2 each Trunk's shape is the one drawn", JSON.stringify(shapes) === JSON.stringify(["0", "1", "2", "3", "4"]), JSON.stringify(shapes));
    check("2 the sheets of each shape were loaded", [0, 1, 2, 3, 4].every((k) => sheets.has(`idle-body-${k}.webp`) || [...sheets].some((s) => s.endsWith(`-body-${k}.webp`))), [...sheets].filter((s) => s.includes("body")).join(","));
    const kept = await page.evaluate((list) => list.map((id) => document.querySelector(`#side .av.pbl[data-pbl-id="${id}"]`)?.dataset.pblEyes), ids.slice(0, 6));
    const saved = (await call_("trunks")).trunks.filter((t) => ids.slice(0, 6).includes(t.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map((t) => t.eyes ?? "round");
    check("2 each Trunk's eyes, as the engine keeps them, are the ones drawn", JSON.stringify(kept) === JSON.stringify(saved) && JSON.stringify(saved) === JSON.stringify([...EYES, ...EYES]), `${JSON.stringify(kept)} / ${JSON.stringify(saved)}`);
    const eyes = await page.evaluate(async () => {
      const { av } = await import("/app/core/ui.js");
      return ["round", "wide", "sleepy", "odd"].map((e) => /data-pbl-eyes="(\w+)"/.exec(av({ id: "eyes-probe", name: "Eyes", eyes: e }, 40))?.[1]);
    });
    check("2 an eye style reaches the face's markup (and anything else is round)", JSON.stringify(eyes) === JSON.stringify(["round", "wide", "sleepy", "round"]), JSON.stringify(eyes));
    /* Two faces wearing wide and sleepy eyes, put in the page the way any region draws one: their own passes are drawn. */
    await page.evaluate(async () => {
      const { av } = await import("/app/core/ui.js");
      const { applyCss } = await import("/app/core/dom.js");
      const box = Object.assign(document.createElement("div"), { id: "eyes-probe" });
      box.innerHTML = av({ name: "Wide eyes", eyes: "wide" }, 60) + av({ name: "Sleepy eyes", eyes: "sleepy" }, 60);
      applyCss(box);
      document.querySelector("#main").prepend(box);
    });
    /* Only the busiest faces move: hovering each one gives it a reaction, which puts it first. */
    let canvases = 0;
    for (const k of [0, 1]) {
      await page.locator("#eyes-probe .av.pbl").nth(k).hover();
      canvases += await until(async () => (await page.locator("#eyes-probe .av.pbl").nth(k).locator("canvas").count()) > 0, 4000) ? 1 : 0;
    }
    const fx = (e) => [...sheets].some((s) => s.endsWith(`-fx-${e}.webp`));
    const drawnEyes = canvases === 2 && await until(async () => fx("wide") && fx("sleepy"), 4000);
    check("2 wide and sleepy eyes are drawn from their own passes", drawnEyes, [...sheets].filter((s) => s.includes("-fx-")).join(","));
    await page.evaluate(() => document.getElementById("eyes-probe")?.remove());
    const small = await page.evaluate(async () => (await import("/app/core/ui.js")).av({ id: "x", name: "Small" }, 20));
    check("2 a face 24px or smaller stays the crisp flat pebble", small.includes('class="peb"') && !small.includes("pbl"));

    /* 3. Reactions: hover, a press, and a message waking an idle Trunk. */
    await page.mouse.move(5, 995);
    await page.waitForTimeout(3000);
    const idleFace = face(by.idle.id);
    await idleFace.hover();
    check("3 hovering a Trunk's row plays its hover reaction", await until(async () => (await shows(by.idle.id)).includes("hover"), 3000), JSON.stringify((await shows(by.idle.id)).slice(-3)));
    await page.waitForTimeout(1200);
    await page.evaluate((id) => { const el = document.querySelector(`#side .av.pbl[data-pbl-id="${id}"]`); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); }, by.idle.id);
    check("3 pressing a face plays its pat reaction", await until(async () => (await shows(by.idle.id)).includes("pat"), 3000));
    await page.waitForTimeout(1500);
    const wakeId = trunks[10].id;
    call_("run", { prompt: "pebble:wake", sessionId: trunks[10].chatSessionId }).catch(() => undefined);
    check("3 a message arriving wakes an idle Trunk", await until(async () => (await shows(wakeId)).includes("wake"), 8000), JSON.stringify((await shows(wakeId)).slice(-3)));

    /* 5. Thirty Trunks: the Trunks page draws every one of them, plus the sidebar. */
    await page.setViewportSize({ width: 1280, height: 2300 });
    await page.locator("#side").getByText("Customize", { exact: true }).click();
    await until(async () => (await page.locator("#main .av.pbl").count()) >= 30, 10000);
    const inView = await page.evaluate(() => [...document.querySelectorAll(".av.pbl")].filter((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.width > 0; }).length);
    check("5 Customize › Trunks and the sidebar put 30 or more faces in view at once", inView >= 30, `${inView} in view`);
    await page.mouse.move(640, 500);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const before = await metric();
    const stats0 = await page.evaluate(async () => { const s = (await import("/app/core/pebble.js")).pebbleStats; s.max = 0; return { ...s, t: performance.now() }; });
    const longs = await page.evaluate(() => { window.__long = 0; try { new PerformanceObserver((l) => { window.__long += l.getEntries().length; }).observe({ type: "longtask" }); } catch (e) { return e.message; } return "ok"; });
    await page.waitForTimeout(10000);
    const after = await metric();
    const stats1 = await page.evaluate(async () => ({ ...(await import("/app/core/pebble.js")).pebbleStats, t: performance.now(), faces: document.querySelectorAll(".av.pbl").length, canvases: document.querySelectorAll(".av.pbl canvas").length, long: window.__long }));
    const wall = (stats1.t - stats0.t) / 1000;
    const pebbleShare = (stats1.ms - stats0.ms) / 1000 / wall;
    const scriptShare = (after.ScriptDuration - before.ScriptDuration) / wall;
    const taskShare = (after.TaskDuration - before.TaskDuration) / wall;
    const perf = `${stats1.faces} faces, ${stats1.canvases} moving, ${((stats1.passes - stats0.passes) / wall).toFixed(1)} passes/s, pebble ${(pebbleShare * 100).toFixed(2)}% of the time, all script ${(scriptShare * 100).toFixed(1)}%, main thread busy ${(taskShare * 100).toFixed(1)}%, ${stats1.long} long tasks (${longs})`;
    check("5 with 30 Trunks, at most twelve faces move and the rest are stills", stats1.faces >= 10 && stats1.canvases <= 12, perf);
    check("5 drawing the faces takes under 5% of the time", pebbleShare < 0.05, perf);
    check("5 the whole page's script stays under 15% of the time", scriptShare < 0.15, perf);
    check("5 no drawing pass is long enough to drop a frame (under 16 ms)", stats1.max < 16, `longest pass ${stats1.max.toFixed(2)} ms; ${perf}`);

    /* 4. Reduced motion: the computer's setting, then the engine's own. */
    await page.emulateMedia({ reducedMotion: "reduce" });
    check("4 with the computer's reduced motion every face is a still", await until(async () => page.evaluate(() => document.querySelectorAll(".av.pbl canvas").length === 0 && document.querySelectorAll(".av.pbl.pbl-live").length === 0), 3000));
    const stillShown = await page.evaluate(() => { const f = document.querySelector("#side .av.pbl .pbl-b"); return f ? getComputedStyle(f).backgroundImage : ""; });
    check("4 and the still is the rendered one", /still-body-\d\.webp/.test(stillShown), stillShown);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await until(async () => page.evaluate(() => document.querySelectorAll(".av.pbl canvas").length > 0), 3000);
    /* Keep things still, saved the way Settings › Appearance saves it (shell/look.js savePrefs, POST /api/preferences). */
    const still = (on) => page.evaluate(async (v) => { await (await import("/app/shell/look.js")).savePrefs({ reduceMotion: v }); (await import("/app/core/dom.js")).render(); }, on);
    await still(true);
    check("4 with Keep things still on in the engine every face is a still", (await call_("state")).preferences.reduceMotion === true && await until(async () => page.evaluate(() => document.querySelectorAll(".av.pbl canvas").length === 0), 6000));
    await still(false);
    check("4 and they move again when it is off", (await call_("state")).preferences.reduceMotion === false && await until(async () => page.evaluate(() => document.querySelectorAll(".av.pbl canvas").length > 0), 6000));
    /* 6. What the Mac app's WebKit gets: the same canvas composite (no see-through video is needed). */
    await webkitLook(base, server.token, by.idle.id, COLOURS[trunks.indexOf(by.idle) % 8], hue);
  } catch (e) { check("script finished", false, e.stack); }
  gates.splice(0).forEach((release) => release());
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  await server.close().catch(() => {});
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
