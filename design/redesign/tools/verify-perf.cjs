// Measures how the window performs against a running engine, and prints the numbers as a table. With a second engine
// (BEFORE_PORT/BEFORE_TOKEN, one serving the window as it was), it measures both and prints them side by side.
// Prepare each engine from a fresh data folder:
//   BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> node design/redesign/tools/seed-perf.mjs
//   BRANCH_DATA_DIR=<same> BRANCH_WORKSPACE=<same> BRANCH_PORT=<port> node dist/cli.js start
// Run: PORT=<port> TOKEN=<session token> [BEFORE_PORT=<port> BEFORE_TOKEN=<token> | BEFORE_JSON=<an earlier OUT file>]
//      [IDLE=30] [OUT=<file>] node design/redesign/tools/verify-perf.cjs
// It changes the engine it measures (Trunks, a household person, Lockdown, an App lock PIN), so give it throwaway engines.
// What it records, headless Chromium, 1366x900:
// - startup: a fresh browser (nothing cached) from navigation to the first full draw of the sidebar and #main;
// - idle requests a minute, and script and style/layout milliseconds a minute (CDP Performance.getMetrics), on the home view, a long
//   conversation, the Inbox, and with the tab hidden;
// - time per render: renderNow() with nothing changed (the idle tick) and a full redraw of #main;
// - what one engine event costs (the re-read and redraw the stream's handler does), and key-to-paint while typing;
// - click-to-paint and long tasks (over 50 ms, PerformanceObserver) for clicks in setup, the conversation, the places
//   and Settings.
// Page errors are recorded and must be zero.
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const IDLE = Number(process.env.IDLE || 30);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function engine(port, token) {
  const base = `http://127.0.0.1:${port}`;
  const api = async (path, body) => {
    const res = await fetch(`${base}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
    return data;
  };
  return { base, token, api };
}

/* Test data made through the engine: onboarding marked done and three Trunks (seed-perf.mjs wrote the conversations). */
async function fixtures(e) {
  await e.api("onboarding", { done: true });
  await e.api("trunks/switch", { part: "trunks", mode: "on" });
  const have = (await e.api("trunks")).trunks ?? [];
  for (let i = have.length; i < 3; i++) await e.api("trunks", { name: `Perf ${i}`, description: "Keeps the numbers" });
  const sessions = (await e.api("sessions?limit=50")).sessions ?? [];
  const long = [...sessions].sort((a, b) => b.messageCount - a.messageCount)[0];
  const short = sessions.find((s) => /^Step 0 of conversation/.test(s.opening ?? ""));
  if (!long || long.messageCount < 100 || !short) throw new Error("Run seed-perf.mjs on the engine's data folder first");
  return { long: long.sessionId, short: short.sessionId };
}

/* Runs before any window script: the token for this tab, a long-task log, a first-draw mark, and a way to hide the tab. */
const PROBE = (token) => `
  try { sessionStorage.setItem("branch-token", ${JSON.stringify(token)}); } catch {}
  window.__long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ start: e.startTime, ms: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
  window.__ready = null;
  const seen = () => {
    const side = document.querySelector("#app #side"), main = document.querySelector("#main");
    if (!window.__ready && side && side.children.length && main && main.firstElementChild && !document.querySelector(".signin")) window.__ready = performance.now();
  };
  new MutationObserver(seen).observe(document, { childList: true, subtree: true });
  window.__hide = () => {
    Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  window.__show = () => {
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  /* Clicks a control and answers how long until the next painted frame after the page shows what the click asked for. */
  window.__clickPaint = async (selector, done, timeout = 15000) => {
    const el = document.querySelector(selector);
    if (!el) return { error: "no " + selector };
    const test = done ? new Function("return (" + done + ")") : () => true;
    const t0 = performance.now();
    el.click();
    for (;;) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (test()) break;
      if (performance.now() - t0 > timeout) return { error: "timed out: " + selector };
    }
    const t1 = performance.now();
    await new Promise((r) => setTimeout(r, 150));
    const long = window.__long.filter((e) => e.start + e.ms >= t0 && e.start <= t1 + 150);
    return { ms: t1 - t0, long: long.length, longMs: long.reduce((a, e) => a + e.ms, 0), worst: long.reduce((a, e) => Math.max(a, e.ms), 0) };
  };
`;

async function newPage(browser, e, errors) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(PROBE(e.token));
  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(err.message));
  const requests = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) requests.push({ at: Date.now(), path: u.pathname.slice(5) + (u.search.includes("waiting=1") ? "?waiting=1" : "") }); });
  return { context, page, requests };
}

async function startup(browser, e, errors) {
  const { context, page } = await newPage(browser, e, errors);
  await page.goto(e.base + "/");
  await page.waitForFunction(() => window.__ready != null, undefined, { timeout: 60000 });
  await wait(1500);
  const out = await page.evaluate(() => {
    const locale = performance.getEntriesByType("resource").filter((r) => r.name.includes("/locales/"));
    const before = window.__long.filter((l) => l.start <= window.__ready);
    return {
      ready: window.__ready,
      localeKB: Math.round(locale.reduce((a, r) => a + (r.encodedBodySize || r.transferSize || 0), 0) / 1024),
      longCount: before.length,
      longMs: Math.round(before.reduce((a, l) => a + l.ms, 0)),
      apiBeforeReady: performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/") && r.startTime < window.__ready).length,
    };
  });
  await context.close();
  return out;
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(list.map((x) => [x.name, x.value]));
  return { script: m.ScriptDuration * 1000, layout: (m.LayoutDuration + m.RecalcStyleDuration) * 1000, layouts: m.LayoutCount, recalcs: m.RecalcStyleCount };
}

/* Sits still for IDLE seconds and counts what the window asked the engine and how much main-thread work it did. */
async function idle(page, requests, cdp, label) {
  await wait(3000);
  const from = Date.now(), cpu0 = await metrics(cdp);
  const paints0 = await page.evaluate(() => window.__mainPaints ?? 0);
  await wait(IDLE * 1000);
  const cpu1 = await metrics(cdp), paints1 = await page.evaluate(() => window.__mainPaints ?? 0);
  const took = requests.filter((r) => r.at >= from && r.at < from + IDLE * 1000);
  const by = {};
  for (const r of took) by[r.path] = (by[r.path] ?? 0) + 1;
  const scale = 60 / IDLE;
  return { label, perMin: Math.round(took.length * scale), scriptPerMin: Math.round((cpu1.script - cpu0.script) * scale), layoutPerMin: Math.round((cpu1.layout - cpu0.layout) * scale), layoutsPerMin: Math.round((cpu1.layouts - cpu0.layouts) * scale), recalcsPerMin: Math.round((cpu1.recalcs - cpu0.recalcs) * scale), paintsPerMin: Math.round((paints1 - paints0) * scale),
    top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => `${p} ${Math.round(n * scale)}`).join(", ") };
}

async function renderTimes(page) {
  return page.evaluate(async () => {
    const dom = await import("/app/core/dom.js");
    const main = document.querySelector("#main");
    const time = (n, before) => { let total = 0; for (let i = 0; i < n; i++) { before?.(); const t0 = performance.now(); dom.renderNow(); total += performance.now() - t0; } return total / n; };
    const tick = time(20);
    const full = time(10, () => main.dispatchEvent(new Event("change", { bubbles: true })));
    return { tick: +tick.toFixed(2), full: +full.toFixed(2) };
  });
}

/* What one engine event costs the window: the stream's handler re-reads the engine and redraws (main.js connect()).
   The same path is taken here, as if an event had come in, and timed from the start to the next painted frame. */
async function eventCost(page, requests, label) {
  const from = Date.now();
  const r = await page.evaluate(async () => {
    const [{ refresh }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    const main = document.querySelector("#main"), first = main.firstElementChild, before = window.__long.length;
    const t0 = performance.now();
    await refresh();
    const t1 = performance.now();
    renderNow();
    const t2 = performance.now();
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    const long = window.__long.slice(before);
    return { fetchMs: t1 - t0, drawMs: t2 - t1, repainted: main.firstElementChild !== first, worst: long.reduce((a, e) => Math.max(a, e.ms), 0) };
  });
  await wait(300);
  return { label, ...r, requests: requests.filter((q) => q.at >= from).length };
}

/* Typing in the composer: each key from keydown to the next painted frame. */
async function typing(page) {
  await page.evaluate(() => {
    window.__keys = [];
    document.addEventListener("keydown", () => { const t0 = performance.now(); requestAnimationFrame(() => setTimeout(() => window.__keys.push(performance.now() - t0), 0)); }, true);
  });
  await page.focus("#prompt");
  await page.keyboard.type("checking how quickly the letters show", { delay: 40 });
  await wait(300);
  const keys = await page.evaluate(() => window.__keys);
  await page.evaluate(() => { const p = document.querySelector("#prompt"); p.value = ""; p.dispatchEvent(new Event("input", { bubbles: true })); });
  keys.sort((a, b) => a - b);
  return { median: +keys[Math.floor(keys.length / 2)].toFixed(1), worst: +keys.at(-1).toFixed(1) };
}

async function click(page, label, selector, done, rows) {
  const r = await page.evaluate(([s, d]) => window.__clickPaint(s, d), [selector, done ?? null]);
  rows.push({ label, ...r });
  await wait(400);
}

async function clicks(page, ids) {
  const rows = [];
  const view = (v) => `#side [data-act="view"][data-v="${v}"]`;
  await click(page, "place: Inbox", view("inbox"), `document.querySelector("#main .scroll, #main .main")`, rows);
  await click(page, "place: Automations", view("automations"), null, rows);
  await click(page, "place: Library", view("library"), null, rows);
  await click(page, "place: Customize", view("customize"), null, rows);
  await click(page, "Settings: open", view("settings"), `document.querySelector('[data-act="setpage"]')`, rows);
  for (const p of ["models", "appearance", "general"]) await click(page, `Settings: page ${p}`, `[data-act="setpage"][data-v="${p}"]`, `document.querySelector('[data-act="setpage"][data-v="${p}"][aria-current="true"]')`, rows);
  await click(page, "conversation: open long", `#side [data-act="chat"][data-id="${ids.long}"]`, `document.querySelectorAll("#conversation [data-i15]").length > 20`, rows);
  await click(page, "conversation: open short", `#side [data-act="chat"][data-id="${ids.short}"]`, `document.querySelectorAll("#conversation [data-i15]").length > 0 && document.querySelectorAll("#conversation [data-i15]").length < 20`, rows);
  await click(page, "conversation: back to long", `#side [data-act="chat"][data-id="${ids.long}"]`, `document.querySelectorAll("#conversation [data-i15]").length > 20`, rows);
  await page.evaluate(async () => (await import("/app/core/actions.js")).run("onboard"));
  await page.waitForSelector('[data-act="ob-go"], [data-act="ob-next"]', { timeout: 15000 });
  await page.locator("#ob-trust").check({ force: true });
  await wait(300);
  await page.evaluate(() => document.querySelector('[data-act="ob-go"][data-v="1"]')?.click());
  await wait(600);
  for (let i = 0; i < 3; i++) {
    await click(page, "setup: choose where (this)", `[data-act="ob-set"][data-k="where"][data-v="this"]`, `document.querySelector('[data-act="ob-set"][data-v="this"][aria-pressed="true"]')`, rows);
    await click(page, "setup: choose where (later)", `[data-act="ob-set"][data-k="where"][data-v="later"]`, `document.querySelector('[data-act="ob-set"][data-v="later"][aria-pressed="true"]')`, rows);
  }
  await page.evaluate(() => document.querySelector('[data-act="ob-go"][data-v="4"]')?.click());
  await wait(600);
  for (let i = 0; i < 3; i++) await click(page, "setup: pick a Trunk template", `[data-act="ob-tpl"][data-i="${i}"]`, `document.querySelector('[data-act="ob-tpl"][data-i="${i}"][aria-pressed="true"]')`, rows);
  await page.evaluate(() => document.querySelector('[data-act="ob-close"]')?.click());
  return rows;
}

async function measure(browser, e, name) {
  const errors = [];
  const ids = await fixtures(e);
  const start = [];
  for (let i = 0; i < 3; i++) start.push(await startup(browser, e, errors));
  start.sort((a, b) => a.ready - b.ready);
  const s = start[1];

  const { context, page, requests } = await newPage(browser, e, errors);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(e.base + "/");
  await page.waitForFunction(() => window.__ready != null, undefined, { timeout: 60000 });
  await page.evaluate(() => { window.__mainPaints = 0; new MutationObserver(() => window.__mainPaints++).observe(document.querySelector("#main"), { childList: true }); });
  const idles = [];
  idles.push(await idle(page, requests, cdp, "home (new conversation)"));
  const renderHome = await renderTimes(page);
  await page.evaluate((id) => document.querySelector(`#side [data-act="chat"][data-id="${id}"]`).click(), ids.long);
  await page.waitForFunction(() => document.querySelectorAll("#conversation [data-i15]").length > 20, undefined, { timeout: 30000 });
  idles.push(await idle(page, requests, cdp, "long conversation open"));
  const renderLong = await renderTimes(page);
  const events = [await eventCost(page, requests, "long conversation, untouched")];
  const keys = await typing(page);
  events.push(await eventCost(page, requests, "long conversation, just typed in"));
  await page.evaluate(() => document.querySelector('#side [data-act="view"][data-v="inbox"]').click());
  idles.push(await idle(page, requests, cdp, "Inbox open"));
  await page.evaluate(() => window.__hide());
  idles.push(await idle(page, requests, cdp, "tab hidden (Inbox)"));
  await page.evaluate(() => window.__show());
  await page.evaluate(() => document.querySelector('#side [data-act="view"][data-v="chat"]')?.click());
  await wait(1000);
  const clickRows = await clicks(page, ids);
  const kept = await presses(page);
  const reach = await latency(page, e);
  await context.close();
  return { name, startup: s, idles, render: { home: renderHome, long: renderLong }, events, keys, clicks: clickRows, kept, reach, errors };
}

/* A person's press takes 80-200 ms. Presses with a real mouse on sidebar controls, each held 150 ms while something the
   sidebar shows changes (a conversation's last line, as a new message does) and the window redraws: a press whose
   button was replaced under it never becomes a click. Answers how many of the presses still did their job. */
async function presses(page) {
  let ok = 0, total = 0;
  const targets = [['[data-act="places14"]', () => page.evaluate(() => document.querySelector('[data-act="places14"]').getAttribute("aria-expanded"))],
    ['[data-act="projtoggle"]', () => page.evaluate(() => document.querySelector('[data-act="projtoggle"]')?.getAttribute("aria-expanded"))]];
  for (const [selector, read] of targets) {
    for (let i = 0; i < 4; i++) {
      const box = await page.locator(selector).boundingBox();
      if (!box) continue;
      const before = await read();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.evaluate(async () => {
        const [{ E }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
        if (E.sessions[0]) E.sessions[0].lastMessage = `${E.sessions[0].lastMessage ?? ""}.`;
        renderNow();
      });
      await wait(150);
      await page.mouse.up();
      await wait(300);
      total++;
      if ((await read()) !== before) ok++;
    }
  }
  await page.mouse.move(700, 450);
  return { ok, total };
}

/* How soon the window follows what changed in the engine: Lockdown on and off, a switch to another person and back, and
   App lock. Each is changed through the engine's own route and timed until the window shows it. Test values on a
   throwaway engine only. */
async function latency(page, e) {
  const out = {};
  const timed = async (change, until) => { const t0 = Date.now(); await change(); await until(); return Date.now() - t0; };
  const shown = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 30000, polling: 50 });
  out.lockdownOn = await timed(() => e.api("lockdown", { on: true }), () => shown(() => document.getElementById("app")?.classList.contains("locked")));
  out.lockdownOff = await timed(() => e.api("lockdown", { on: false }), () => shown(() => !document.getElementById("app")?.classList.contains("locked")));
  const list = await e.api("profiles");
  const person = (list.profiles ?? []).find((p) => p.name === "Perf person") ?? await e.api("profiles", { name: "Perf person", pin: "2468" });
  const reloaded = () => page.waitForEvent("framenavigated", { timeout: 30000 });
  let nav = reloaded();
  out.switchAway = await timed(() => e.api("profiles/switch", { profileId: person.id, pin: "2468" }), () => nav);
  await page.waitForFunction(() => window.__ready != null, undefined, { timeout: 30000 });
  await wait(1000);
  nav = reloaded();
  out.switchBack = await timed(() => e.api("profiles/switch", { profileId: null }), () => nav);
  await page.waitForFunction(() => window.__ready != null, undefined, { timeout: 30000 });
  await wait(1000);
  if (!(await e.api("lock")).pinSet) await e.api("lock/pin", { pin: "1357" });
  out.appLock = await timed(() => e.api("lock", {}), () => shown(() => !!document.querySelector(".lockscreen")));
  await e.api("lock/unlock", { pin: "1357" });
  return out;
}

function table(runs) {
  const col = (v) => String(v ?? "").padStart(14);
  const line = (label, values) => console.log(label.padEnd(40) + values.map(col).join(""));
  console.log("\n" + "".padEnd(40) + runs.map((r) => col(r.name)).join(""));
  line("startup to interactive (ms, median of 3)", runs.map((r) => Math.round(r.startup.ready)));
  line("  long tasks before interactive", runs.map((r) => `${r.startup.longCount} / ${r.startup.longMs}ms`));
  line("  locale downloaded (KB)", runs.map((r) => r.startup.localeKB));
  line("  API requests before interactive", runs.map((r) => r.startup.apiBeforeReady));
  for (let i = 0; i < runs[0].idles.length; i++) {
    const label = runs[0].idles[i].label;
    line(`idle requests/min: ${label}`, runs.map((r) => r.idles[i].perMin));
    line(`  script ms/min`, runs.map((r) => r.idles[i].scriptPerMin));
    line(`  style + layout ms/min`, runs.map((r) => r.idles[i].layoutPerMin));
    line(`  layouts / style recalcs a minute`, runs.map((r) => `${r.idles[i].layoutsPerMin} / ${r.idles[i].recalcsPerMin}`));
    line(`  #main repaints/min`, runs.map((r) => r.idles[i].paintsPerMin));
  }
  line("render, nothing changed (ms): home", runs.map((r) => r.render.home.tick));
  line("render, nothing changed (ms): long conv", runs.map((r) => r.render.long.tick));
  line("render, full #main (ms): home", runs.map((r) => r.render.home.full));
  line("render, full #main (ms): long conv", runs.map((r) => r.render.long.full));
  for (let i = 0; i < runs[0].events.length; i++) {
    line(`engine event: ${runs[0].events[i].label}`, runs.map((r) => `${r.events[i].requests} req`));
    line(`  re-read + draw (ms)`, runs.map((r) => `${Math.round(r.events[i].fetchMs)} + ${Math.round(r.events[i].drawMs)}`));
    line(`  #main repainted / worst long task`, runs.map((r) => `${r.events[i].repainted ? "yes" : "no"} / ${Math.round(r.events[i].worst)}`));
  }
  line("typing in long conv: key to paint (ms)", runs.map((r) => `${r.keys.median} / ${r.keys.worst}`));
  console.log("  (typing: median / worst)");
  const labels = [...new Set(runs[0].clicks.map((c) => c.label))];
  for (const label of labels) {
    const cell = (r) => {
      const rows = r.clicks.filter((c) => c.label === label && c.ms != null);
      if (!rows.length) return r.clicks.find((c) => c.label === label)?.error ?? "-";
      const ms = rows.reduce((a, c) => a + c.ms, 0) / rows.length, worst = Math.max(...rows.map((c) => c.worst));
      return `${Math.round(ms)}ms/${Math.round(worst)}`;
    };
    line(`click ${label}`, runs.map(cell));
  }
  console.log("  (click cells: click-to-paint mean / worst long task in ms)");
  line("presses kept, a redraw landing mid-press", runs.map((r) => `${r.kept.ok} of ${r.kept.total}`));
  line("Lockdown on: until the banner shows (ms)", runs.map((r) => r.reach.lockdownOn));
  line("Lockdown off: until it goes (ms)", runs.map((r) => r.reach.lockdownOff));
  line("switch to a person: until reload (ms)", runs.map((r) => r.reach.switchAway));
  line("switch back: until reload (ms)", runs.map((r) => r.reach.switchBack));
  line("App lock: until the lock screen (ms)", runs.map((r) => r.reach.appLock));
  for (const r of runs) {
    console.log(`\n${r.name}: busiest idle routes`);
    for (const i of r.idles) console.log(`  ${i.label}: ${i.top}`);
    console.log(`${r.name}: page errors ${r.errors.length}${r.errors.length ? "\n  " + r.errors.join("\n  ") : ""}`);
  }
}

(async () => {
  const runs = [];
  const browser = await chromium.launch({ headless: true });
  try {
    if (process.env.BEFORE_JSON) runs.push(...JSON.parse(require("node:fs").readFileSync(process.env.BEFORE_JSON, "utf8")).map((r) => ({ ...r, name: "before" })));
    else if (process.env.BEFORE_PORT) runs.push(await measure(browser, engine(process.env.BEFORE_PORT, process.env.BEFORE_TOKEN), "before"));
    if (!process.env.PORT || !process.env.TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
    runs.push(await measure(browser, engine(process.env.PORT, process.env.TOKEN), runs.length ? "after" : "now"));
  } finally { await browser.close(); }
  table(runs);
  if (process.env.OUT) require("node:fs").writeFileSync(process.env.OUT, JSON.stringify(runs, null, 2));
  const errors = runs.reduce((a, r) => a + r.errors.length, 0);
  process.exit(errors ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
