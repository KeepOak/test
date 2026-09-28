// Every Trunk's and Branch's face is its character, moving (core/ui.js av, core/figures.js); the list's rows first. Seeds a throwaway engine through
// its own routes (Trunks wearing characters, a room of two, a Trunk with the classic pebble, Branch conversations enough
// to overflow the list), then checks in the window:
//   - every row draws the character GET /api/trunks says its Trunk wears (a room its two members, Branch's own Branch),
//     the loop for the state the row shows (the character's loop for that state, else its idle loop), its still as poster;
//   - a Trunk with no character keeps the face core/ui.js av draws (no row loop);
//   - only rows on screen play, at most PLAY_MAX at once, none while the window is hidden, and a row never on screen
//     loaded nothing; reduced motion (the computer's setting, then the engine's reduceMotion) shows the stills;
//   - CPU (CDP TaskDuration) with the rows playing and with them still; zero page errors.
// Screenshots of the list at 1440 and 390, light and dark, go to OUT.
// Run: PORT=<port> TOKEN=<session token> [OUT=<folder>] node design/redesign/tools/verify-animated-characters.cjs
const { chromium } = require("playwright");
const fs = require("fs");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
const OUT = (process.env.OUT || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/lead/figs/shots").replace(/\/?$/, "/");
const BASE = `http://127.0.0.1:${PORT}`;
const PLAY_MAX = 6; // core/figures.js
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = "") { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); }

async function seed() {
  await api("onboarding", { done: true });
  const made = {};
  for (const [name, character] of [["Scout", "ember"], ["Ledger", "tock"], ["Ada", null]]) {
    const { trunk } = await api("trunks", { name });
    if (character) await api(`trunks/${trunk.id}`, { character });
    made[name] = trunk;
  }
  await api(`trunks/${made.Scout.id}`, { pinned: true });
  await api("trunks/switch", { part: "rooms", mode: "on" });
  const { room } = await api("trunks/rooms", { name: "Month-end", members: [made.Ledger.id, made.Scout.id] });
  await api(`trunks/${made.Ledger.id}`, { pinned: true }); // pinned, so the screenshots show every kind of row
  await api(`trunks/rooms/${room.id}`, { pinned: true });
  for (let i = 0; i < 12; i++) await api("run", { prompt: `Note ${i + 1}` }).catch((e) => console.log(`(a Branch task ended: ${e.message.slice(0, 80)})`));
  return { made, room };
}

/* What the engine says each row should show: its characters, by the row's conversation. */
async function expected() {
  const all = await api("trunks"), looks = new Map(all.characters.map((c) => [c.id, c]));
  const byChat = new Map(all.trunks.map((t) => [t.chatSessionId, t]));
  const rooms = new Map(all.rooms.map((r) => [r.sessionId, r]));
  return (sid) => {
    const t = byChat.get(sid);
    if (t) return t.character ? [looks.get(t.character)] : [];
    const r = rooms.get(sid);
    if (r) return r.members.slice(0, 2).map((id) => all.trunks.find((x) => x.id === id)).map((m) => m?.character ? looks.get(m.character) : null);
    return [looks.get("branch")];
  };
}

const rowsNow = (page) => page.$$eval("#side .list .row", (rows) => rows.map((r) => ({
  id: r.dataset.id,
  figs: [...r.querySelectorAll(".fig17r")].map((f) => { const m = f.querySelector(".fig12"); return { st: f.dataset.st, tag: m?.tagName, src: m?.getAttribute("src"), poster: m?.getAttribute("poster") }; }),
  other: !!r.querySelector(".avw .av:not(.fig17r)"),
})));
const loopsNow = (page) => page.$$eval("#side .list .row video.fig12", (vs) => vs.map((v) => {
  const b = v.getBoundingClientRect(), list = v.closest(".list").getBoundingClientRect();
  const on = b.width > 0 && b.bottom > Math.max(0, list.top) && b.top < Math.min(innerHeight, list.bottom) && b.right > 0 && b.left < innerWidth;
  return { on, playing: !v.paused, ready: v.readyState, net: v.networkState };
}));

async function characters(page, want) {
  const rows = await rowsNow(page);
  check("the list has rows", rows.length >= 16, `${rows.length} rows`);
  let good = 0;
  for (const r of rows) {
    const looks = want(r.id);
    if (!looks.length || looks.every((l) => !l)) { check(`row ${r.id.slice(0, 8)}: a Trunk with no character keeps its own face`, !r.figs.length && r.other); continue; }
    const ok = r.figs.length === looks.length && r.figs.every((f, i) => {
      const l = looks[i];
      if (!l) return true;
      const loop = l.states[f.st] ?? l.states.idle;
      return f.tag === "VIDEO" && f.src === loop && f.poster === l.still;
    });
    if (ok) good++; else check(`row ${r.id.slice(0, 8)} shows ${looks.map((l) => l?.id).join("+")}`, false, JSON.stringify(r.figs));
  }
  check("every row with a character draws that character's loop for its state, with its still as poster", good === rows.filter((r) => want(r.id).some(Boolean)).length, `${good} rows`);
  const pair = rows.find((r) => r.figs.length === 2);
  check("the room's row shows its two members", !!pair, pair ? pair.figs.map((f) => f.src).join(" + ") : "");
}

/* Other faces: a Trunk's conversation and the room's (the header, the agent beside it) draw the characters moving; no still picture anywhere. */
async function elsewhere(page, made) {
  for (const [name, sid] of [["Scout", made.scoutChat], ["Month-end", made.roomChat]]) {
    await page.click(`#side .row[data-id="${sid}"]`);
    await wait(1200);
    const n = await page.$$eval(".fig17r video.fig12, .agent12 video.fig12", (vs) => vs.filter((v) => !v.closest("#side")).length);
    const stills = await page.$$eval(".av.look12:not(.fig17r) img", (is) => is.length);
    check(`${name}'s conversation draws its characters moving, no still`, n > 0 && stills === 0, `${n} loops, ${stills} stills`);
  }
}

async function gating(page) {
  await page.setViewportSize({ width: 1440, height: 520 });
  await wait(1500);
  let loops = await loopsNow(page);
  const off = loops.filter((l) => !l.on), playing = loops.filter((l) => l.playing);
  check("some rows are off screen for this check", off.length > 0, `${off.length} of ${loops.length}`);
  check("only rows on screen play", playing.every((l) => l.on), JSON.stringify(loops));
  check(`at most ${PLAY_MAX} play at once, and some do`, playing.length > 0 && playing.length <= PLAY_MAX, `${playing.length} playing`);
  check("a row never on screen loaded nothing", off.every((l) => l.ready === 0), off.map((l) => l.ready).join(","));
  await page.setViewportSize({ width: 1440, height: 1400 });
  await wait(1500);
  loops = await loopsNow(page);
  const on = loops.filter((l) => l.on).length, n = loops.filter((l) => l.playing).length;
  check(`with ${on} rows on screen, exactly ${PLAY_MAX} play`, on > PLAY_MAX && n === PLAY_MAX, `${n} playing`);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await wait(400);
  check("none play while the window is hidden", (await loopsNow(page)).every((l) => !l.playing));
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await wait(800);
  check("they play again when it is shown", (await loopsNow(page)).some((l) => l.playing));
}

async function stills(page, how) {
  const figs = (await rowsNow(page)).flatMap((r) => r.figs);
  check(`${how}: every row shows its still, no loop`, figs.length > 0 && figs.every((f) => f.tag === "IMG"), `${figs.length} figures, ${figs.filter((f) => f.tag !== "IMG").length} loops`);
  check(`${how}: no row video on the page`, (await page.$$("#side .list video")).length === 0);
}

async function cpu(page, cdp) {
  const task = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value;
  const a = await task(); await wait(5000); const b = await task();
  return ((b - a) / 5) * 1000; // ms of main-thread work per second
}

async function shots(page, tag) {
  for (const [mode, appearance] of [["light", "daylight"], ["dark", "forest"]]) {
    const prefs = (await api("state")).preferences;
    await api("preferences", { ...prefs, appearance, followSystem: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.waitForSelector("#side .list .row");
    await wait(2500);
    await page.screenshot({ path: `${OUT}${tag}-1440-${mode}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(600);
    const menu = page.locator('[data-act="side"]:visible').first();
    if (await menu.count()) await menu.click();
    await wait(1500);
    await page.screenshot({ path: `${OUT}${tag}-390-${mode}.png` });
  }
}

(async () => {
  const seeded = (await api("trunks")).trunks.some((t) => t.name === "Scout") ? null : await seed();
  if (seeded) console.log(`seeded: ${Object.values(seeded.made).map((t) => t.name).join(", ")}, room ${seeded.room.name}`);
  const want = await expected();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 520 } }); // short from the start: rows below it have never been on screen
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .list .row");
  await wait(1500);
  await characters(page, want);
  await gating(page); // first: a face drawn elsewhere hands its loaded node to a row showing the same loop
  const all = await api("trunks");
  await elsewhere(page, { scoutChat: all.trunks.find((t) => t.name === "Scout").chatSessionId, roomChat: all.rooms.find((r) => r.name === "Month-end").sessionId });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.setViewportSize({ width: 1440, height: 900 });
  await wait(1000);
  const moving = await cpu(page, cdp);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await wait(800);
  await stills(page, "the computer asks for reduced motion");
  const still = await cpu(page, cdp);
  console.log(`CPU (main-thread ms per second): rows playing ${moving.toFixed(1)}, rows still ${still.toFixed(1)}`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await wait(800);
  check("the loops come back when it no longer does", (await page.$$("#side .list video.fig12")).length > 0);

  const prefs = (await api("state")).preferences;
  await api("preferences", { ...prefs, reduceMotion: true });
  check("the engine keeps reduceMotion", (await api("state")).preferences.reduceMotion === true);
  await page.reload();
  await page.waitForSelector("#side .list .row");
  await wait(1200);
  await stills(page, "the engine's reduceMotion");
  await api("preferences", { ...(await api("state")).preferences, reduceMotion: false });

  await shots(page, "after");
  check("zero page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
  console.log(`${failed ? "FAILED" : "ALL PASS"} (${failed} failed); screenshots in ${OUT}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
