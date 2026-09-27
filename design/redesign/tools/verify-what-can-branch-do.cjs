/* "What can Branch do", proved in the real window against a fresh engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> [SHOTS=<dir>] node design/redesign/tools/verify-what-can-branch-do.cjs
   The gallery opens from Overview, the Guide menu and an empty conversation; each tab lists exactly what the engine's
   GET routes return (count and names); Try it opens a new conversation with the request in the box, not sent (no
   conversation or task is made until Send); Branch's face sleeps and the gallery's motion holds still while the window
   is hidden or idle for a minute, and wakes on the next key. Screenshots at 1440 and 390 wide, light and dark, go to
   SHOTS. Page errors and console errors: zero. */
const path = require("node:path");
const { chromium } = require(path.join(__dirname, "../../../node_modules/playwright"));

const { PORT, TOKEN, SHOTS } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_MS = 60_000; // public/app/flows/whatcan.js IDLE_MS, the pet's nap rule
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await sleep(150); } }
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => { const b = document.createElement("button"); b.dataset.act = n; Object.assign(b.dataset, d); document.getElementById("app").appendChild(b); b.click(); b.remove(); }, [name, data]);
  await sleep(500);
}

/* What each tab must list, read from the engine's own routes (an item with no description is left out). */
const oneLine = (text) => { const first = String(text ?? "").trim().split(/\r?\n/)[0].trim(); return /^(.+?[.!?])(?=\s|$)/.exec(first)?.[1] ?? first; };
const uniq = (names) => [...new Set(names)];
async function expected() {
  const [tools, state, browser, apps, prompts, flows] = await Promise.all(["tools", "state", "skills/browser", "channel-setup", "prompts", "flows"].map((p) => api(p)));
  const saved = new Set(prompts.prompts.map((p) => p.command));
  return {
    tools: uniq(tools.tools.filter((x) => oneLine(x.description)).map((x) => x.name)),
    skills: uniq([...state.skills, ...browser.skills].filter((x) => oneLine(x.description)).map((x) => x.name)),
    apps: apps.channels.filter((x) => oneLine(x.what)).map((x) => x.name),
    prompts: uniq([...prompts.prompts.filter((p) => oneLine(p.description) && p.body).map((p) => p.title),
      ...prompts.examples.filter((p) => !saved.has(p.command) && oneLine(p.description) && p.body).map((p) => p.title),
      ...flows.flows.filter((f) => oneLine(f.description)).map((f) => f.name)]),
    raw: { tools, prompts },
  };
}

const gallery = (page) => page.locator(".dlg [data-wc]");
async function listed(page, tab) {
  await page.click(`.dlg [data-act="whatcan-tab"][data-v="${tab}"]`);
  await until(async () => (await page.locator(`.dlg .wc-list[data-tab="${tab}"]`).count()) === 1);
  return page.locator(".dlg .wc-card b").allTextContents();
}
const same = (a, b) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

async function entries(page, want) {
  for (const tab of ["tools", "skills", "apps", "prompts"]) {
    const names = await listed(page, tab);
    check(`${tab}: the gallery lists exactly what the engine returns`, same(names, want[tab]), `${names.length} listed, ${want[tab].length} from the engine`);
  }
  const tool = want.raw.tools.tools.find((x) => x.name === want.tools[0]);
  await page.click('.dlg [data-act="whatcan-tab"][data-v="tools"]');
  const line = await page.locator(`.dlg .wc-card:has(button[data-v="${tool.name}"]) small`).textContent();
  check("a tool's line is the engine's own description, first sentence", line === oneLine(tool.description), line);
}

async function opensFrom(page) {
  await act(page, "view", { v: "overview" });
  await page.click('#main [data-act="whatcan"]');
  check("opens from Home (Overview)", await until(async () => (await gallery(page).count()) === 1));
  await act(page, "dlg-close");
  await page.click('[data-act="guide"]');
  await page.click('.pop [data-act="whatcan"]');
  check("opens from Help (the Guide menu)", await until(async () => (await gallery(page).count()) === 1));
  await act(page, "dlg-close");
  await act(page, "newconv");
  await page.click('.empty-chat [data-act="whatcan"]');
  check("opens from the empty conversation", await until(async () => (await gallery(page).count()) === 1));
}

async function tryIt(page, want) {
  const before = (await api("sessions")).sessions.length;
  const example = want.raw.prompts.examples.find((p) => p.title === want.prompts.find((n) => want.raw.prompts.examples.some((e) => e.title === n)));
  await page.click('.dlg [data-act="whatcan-tab"][data-v="prompts"]');
  await page.click(`.dlg [data-act="whatcan-try"][data-v="${example.title}"]`);
  check("Try it (a starter prompt): a new conversation with the engine's own words in the box", await until(async () => (await gallery(page).count()) === 0 && (await page.inputValue("#prompt")) === example.body.trim()));
  check("…not sent: no conversation or task made (GET /api/sessions, GET /api/state runs)", (await api("sessions")).sessions.length === before && (await api("state")).runs.length === 0);
  await page.click('.empty-chat [data-act="whatcan"]');
  await until(async () => (await gallery(page).count()) === 1);
  const tool = want.raw.tools.tools.find((x) => x.name === want.tools[0]);
  await page.click('.dlg [data-act="whatcan-tab"][data-v="tools"]');
  await page.click(`.dlg [data-act="whatcan-try"][data-v="${tool.name}"]`);
  const words = `Use the ${tool.name} tool. It says: ${oneLine(tool.description)}`;
  check("Try it (a tool): the request made from its name and line, in the box", await until(async () => (await page.inputValue("#prompt")) === words), words);
  check("…still not sent", (await api("sessions")).sessions.length === before && (await api("state")).runs.length === 0);
}

const faceState = (page) => page.evaluate(() => {
  const b = document.querySelector(".dlg [data-wc]"), card = b?.querySelector(".wc-card"), v = b?.querySelector(".wc-face video");
  return { asleep: b?.classList.contains("asleep-wc"), st: b?.querySelector(".wc-face [data-st]")?.dataset.st, loop: v?.getAttribute("src") ?? "", paused: v ? v.paused : null, play: card ? getComputedStyle(card).animationPlayState : "" };
});
async function sleeps(page) {
  await act(page, "whatcan");
  await until(async () => (await gallery(page).count()) === 1);
  let s = await until(async () => { const f = await faceState(page); return f.st === "idle" && f.paused === false ? f : null; });
  check("awake: Branch's face plays its idle loop and the cards move", s && !s.asleep && /anim-idle/.test(s.loop) && s.play === "running", JSON.stringify(s));
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  s = await until(async () => { const f = await faceState(page); return f.asleep ? f : null; }, 3000);
  check("hidden: its sleep loop, and the gallery's motion paused", s && s.st === "sleep" && /anim-sleep/.test(s.loop) && s.play === "paused", JSON.stringify(s));
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await page.keyboard.press("Shift");
  s = await until(async () => { const f = await faceState(page); return !f.asleep && f.st === "idle" && f.paused === false ? f : null; }, 5000);
  check("shown again and a key pressed: awake, its idle loop playing", s && s.play === "running", JSON.stringify(s));
  console.log(`      (waiting ${IDLE_MS / 1000 + 2} s with no click or key)`);
  await sleep(IDLE_MS + 2000);
  s = await faceState(page);
  check("idle for a minute: its sleep loop, and the gallery's motion paused", s.asleep && s.st === "sleep" && /anim-sleep/.test(s.loop) && s.play === "paused", JSON.stringify(s));
  await page.keyboard.press("Shift");
  s = await until(async () => { const f = await faceState(page); return !f.asleep && f.st === "idle" && f.paused === false ? f : null; }, 5000);
  check("the next key wakes it, its idle loop playing", s && s.play === "running", JSON.stringify(s));
}

async function shots(page) {
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await act(page, "dlg-close");
    await act(page, "themeset", { v: scheme }); // the window's own Light / Dark choice
    await act(page, "newconv");
    await page.click('.empty-chat [data-act="whatcan"]');
    await until(async () => (await gallery(page).count()) === 1);
    await sleep(600);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector(".dlg").getBoundingClientRect().right <= window.innerWidth + 1);
    check(`${w} ${scheme}: the gallery fits the window`, wide);
    check(`${w} ${scheme}: drawn in ${scheme}`, (await page.evaluate(() => document.documentElement.dataset.theme)) === scheme);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `what-can-branch-do-${w}-${scheme}.png`) });
    if (SHOTS && w === 1440) for (const tab of ["skills", "apps", "prompts"]) {
      await page.click(`.dlg [data-act="whatcan-tab"][data-v="${tab}"]`);
      await sleep(400);
      await page.screenshot({ path: path.join(SHOTS, `what-can-branch-do-${w}-${scheme}-${tab}.png`) });
    }
    await act(page, "dlg-close");
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  /* Everything after signing in counts. Before it, the sign-in screen's own first read of GET /api/state is refused
     (401, no token yet): that is the window's boot, listed separately and not counted. */
  const errors = [], boot = [];
  let signedIn = false;
  const note = (text) => (signedIn ? errors : boot).push(text);
  page.on("pageerror", (e) => note(e.message));
  page.on("console", (m) => { if (m.type() === "error") note(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) note(`${r.status()} ${r.url()}`); });
  try {
    await api("onboarding", { done: true });
    const want = await expected();
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector("#main", { timeout: 15000 });
    signedIn = true;
    await sleep(1500);
    await opensFrom(page);
    await entries(page, want);
    await tryIt(page, want);
    await sleeps(page);
    await shots(page);
  } catch (error) {
    check("ran to the end", false, error.stack);
  } finally {
    if (boot.length) console.log(`      (before signing in: ${boot.join("; ")})`);
    check("no page errors, console errors or failed requests after signing in", errors.length === 0, errors.join("; "));
    await browser.close();
  }
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
