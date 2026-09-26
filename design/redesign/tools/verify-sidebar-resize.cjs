// Verifies the panel edges of the new window with a real mouse and keyboard (claude/sidebar-resize): the list's edge
// widens and narrows the list, becomes a rail of icons and hides it, the slim edge left behind brings it back, a
// double-click resets it, the width survives a reload, the side panel's edge does the same, the Places fold matches the
// prototype and folds from anywhere on its header, and arrow keys move a focused edge. Layout is the window's own state,
// so it is read back from the window's saved choices (localStorage "branch-window") and from what is drawn.
// Run against a throwaway engine: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-sidebar-resize.cjs
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT || "3583", TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/sidebar-resize/";
if (!TOKEN) { console.error("Set TOKEN to the engine's session token."); process.exit(2); }

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

const results = [];
function check(what, ok, how) { results.push([what, ok ? "PASS" : "FAIL", how]); if (!ok) console.log(`FAIL ${what}: ${how}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A person's drag: press, hold a moment, move in steps, let go. */
async function drag(page, x0, y, x1) {
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await wait(150);
  await page.mouse.move(x1, y, { steps: 10 });
  await page.mouse.up();
  await wait(250);
}
async function press(page, x, y) { await page.mouse.move(x, y); await page.mouse.down(); await wait(150); await page.mouse.up(); await wait(300); }
const centre = async (page, sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
async function until(fn, ms = 3000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await wait(100); } }
const toasts = (page) => page.locator(".toast", { hasText: "Back to the usual size." }).count();
/* Tab from the title bar's theme button, as a keyboard user would, until the list's edge has focus (bounded). */
async function tabTo(page, id) {
  await page.locator('[data-act="theme-flip"]').focus();
  for (let i = 0; i < 20; i++) { await page.keyboard.press("Tab"); if (await page.evaluate((id) => document.activeElement?.id === id, id)) return i + 1; }
  return 0;
}
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("branch-window") || "{}"));
const sideWidth = (page) => page.evaluate(() => Math.round(document.getElementById("side").getBoundingClientRect().width));
const appClass = (page) => page.evaluate(() => document.getElementById("app").className);

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine");
  await wait(800);
}

async function listEdge(page) {
  const [x, y] = await centre(page, "#rz-side");
  const sweep = await page.evaluate(() => {
    const r = document.getElementById("rz-side").getBoundingClientRect(), miss = [];
    for (let x = Math.ceil(r.left); x < Math.floor(r.right); x++) { const el = document.elementFromPoint(x, 400); if (!el?.closest("#rz-side")) miss.push(`${x}:${el?.className}`); }
    return { width: r.width, miss };
  });
  check("the whole list edge is grabbable", sweep.miss.length === 0, `width ${sweep.width}px, covered at ${sweep.miss.join(" ") || "none"}`);
  const shape = await page.evaluate(() => { const r = document.getElementById("rz-side"); return [r.getAttribute("role"), r.getAttribute("aria-orientation"), r.getAttribute("aria-valuenow"), r.tabIndex, r.title]; });
  check("the list edge is a keyboard separator with its tooltip", shape[0] === "separator" && shape[1] === "vertical" && shape[2] === "292" && shape[3] === 0 && /Drag to resize · drag to the edge to hide · double-click to reset/.test(shape[4]), shape.join(" | "));
  check("no show/hide button in the title bar (the owner removed it)", (await page.locator('.titlebar [data-act="side-toggle"]').count()) === 0, "no .titlebar [data-act=side-toggle]");
  await drag(page, x, y, x + 100);
  check("dragging the edge right widens the list", Math.abs((await sideWidth(page)) - 392) <= 3 && Math.abs((await saved(page)).sideW - 392) <= 3, `side ${await sideWidth(page)}px, saved ${(await saved(page)).sideW}`);
  const [x2] = await centre(page, "#rz-side");
  await drag(page, x2, y, x2 - 150);
  const narrow = await sideWidth(page);
  check("dragging the edge left narrows the list", Math.abs(narrow - 242) <= 3, `side ${narrow}px`);
  await page.reload();
  await page.waitForSelector("#side .machine");
  await wait(600);
  check("the width survives a reload", Math.abs((await sideWidth(page)) - narrow) <= 1, `after reload ${await sideWidth(page)}px (was ${narrow})`);
}

async function railAndHidden(page) {
  const [x, y] = await centre(page, "#rz-side");
  await drag(page, x, y, 100);
  const rail = await page.evaluate(() => ({ w: Math.round(document.getElementById("side").getBoundingClientRect().width), rail: document.getElementById("app").classList.contains("rail9"),
    shut: !!document.querySelector(".side-nav.shut14"), tips: [...document.querySelectorAll(".side-nav .nav")].every((b) => b.dataset.tip && b.getAttribute("aria-label")),
    rows: [...document.querySelectorAll("#side .list .row[data-id]")].map((r) => r.dataset.tip) }));
  await page.screenshot({ path: SHOTS + "after-rail.png" });
  check("dragging below 150px makes the icon rail", rail.rail && rail.w === 68 && (await saved(page)).rail === true, `rail9 ${rail.rail}, side ${rail.w}px, saved rail ${(await saved(page)).rail}`);
  check("the rail shows Places as a column of icons with tooltips", !rail.shut && rail.tips, `shut14 ${rail.shut}, every place named ${rail.tips}`);
  check("the rail's conversation icons are named", rail.rows.length > 0 && rail.rows.every(Boolean), `row tips: ${rail.rows.join(", ")}`);
  const [xr] = await centre(page, "#rz-side");
  await drag(page, xr, y, 10);
  await hiddenLooksRight(page, "dragging below 40px hides the list");
  // the slim edge left at the window's left drags it back out
  await drag(page, 3, y, 300);
  const back = await sideWidth(page);
  check("the slim edge at the left drags the list back", !(await appClass(page)).includes("side-hidden") && Math.abs(back - 297) <= 4, `side ${back}px, classes ${await appClass(page)}`);
}

async function hiddenLooksRight(page, what) {
  const h = await page.evaluate(() => {
    const main = document.getElementById("main").getBoundingClientRect(), hits = [];
    for (const x of [10, 20, 30]) for (const y of [200, 400, 700]) hits.push(!!document.elementFromPoint(x, y)?.closest("#main"));
    const edge = document.elementFromPoint(2, 400)?.closest("#rz-side");
    return { side: Math.round(document.getElementById("side").getBoundingClientRect().width), left: Math.round(main.left), width: Math.round(main.width), win: innerWidth,
      hits: hits.every(Boolean), edge: !!edge, cursor: edge ? getComputedStyle(edge).cursor : "", label: edge?.getAttribute("aria-label") ?? "", bar: getComputedStyle(document.querySelector(".titlebar")).getPropertyValue("--side-w").trim(),
      hidden: document.getElementById("app").classList.contains("side-hidden") };
  });
  await page.screenshot({ path: SHOTS + "after-hidden.png" });
  check(what, h.hidden && h.side === 0 && (await saved(page)).sideHidden === true, `side-hidden ${h.hidden}, side ${h.side}px, saved ${(await saved(page)).sideHidden}`);
  check("hidden: the conversation takes the full width", h.left === 0 && h.width === h.win && h.hits, `main left ${h.left}, width ${h.width}/${h.win}, x 10-30 in #main ${h.hits}`);
  check("hidden: a slim grabbable edge stays at x=0", h.edge && h.cursor === "col-resize" && /Drag to show the list · Ctrl\+B/.test(h.label), `edge ${h.edge}, cursor ${h.cursor}, label "${h.label}"`);
  check("hidden: the title bar split follows to 0", h.bar === "0px", `--side-w ${h.bar}`);
}

async function keysAndReset(page) {
  await page.keyboard.press("Control+b");
  await wait(300);
  check("Ctrl+B hides the list", (await appClass(page)).includes("side-hidden") && (await sideWidth(page)) === 0, await appClass(page));
  await page.keyboard.press("Control+b");
  await wait(300);
  check("Ctrl+B shows it again", !(await appClass(page)).includes("side-hidden") && (await sideWidth(page)) > 150, `side ${await sideWidth(page)}px`);
  await page.keyboard.press("Control+b");
  await wait(300);
  await page.mouse.dblclick(3, 400);
  await wait(300);
  const toast1 = await page.locator(".toast", { hasText: "Back to the usual size." }).count();
  check("double-clicking the hidden edge restores the usual width", (await sideWidth(page)) === 292 && toast1 > 0, `side ${await sideWidth(page)}px, toast ${toast1}`);
  const [x, y] = await centre(page, "#rz-side");
  await drag(page, x, y, x + 120);
  await until(async () => (await toasts(page)) === 0, 8000); // the first reset's toast has gone
  const [x2] = await centre(page, "#rz-side");
  await page.mouse.dblclick(x2, y);
  await wait(300);
  check("double-clicking the edge resets to 292px with the toast", (await sideWidth(page)) === 292 && (await saved(page)).sideW === 292 && (await toasts(page)) > 0, `side ${await sideWidth(page)}px, toast ${await toasts(page)}`);
  const tabs = await tabTo(page, "rz-side");
  check("Tab from the title bar reaches the list's edge", tabs > 0, `${tabs} presses`);
  await page.keyboard.press("ArrowRight");
  await wait(200);
  const right = [await sideWidth(page), await page.locator("#rz-side").getAttribute("aria-valuenow"), await page.evaluate(() => document.activeElement?.id)];
  check("ArrowRight on the focused edge widens 16px and keeps focus", right[0] === 308 && right[1] === "308" && right[2] === "rz-side", right.join(" | "));
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await wait(200);
  check("ArrowLeft narrows 16px a press", (await sideWidth(page)) === 276, `side ${await sideWidth(page)}px`);
  await page.keyboard.press("Control+b");
  await wait(300);
  const hiddenTabs = await tabTo(page, "rz-side");
  check("Tab reaches the hidden list's slim edge", hiddenTabs > 0, `${hiddenTabs} presses`);
  await page.keyboard.press("Enter");
  await wait(300);
  check("Enter on the hidden edge brings the list back", !(await appClass(page)).includes("side-hidden") && (await sideWidth(page)) === 276, `side ${await sideWidth(page)}px`);
}

/* Focus mode (Ctrl+.) steps the list aside entirely: nothing of it, its edge included, is left to hit. */
async function focusMode(page) {
  const probe = () => page.evaluate(() => ({ main: [10, 100, 200].every((x) => document.elementFromPoint(x, 400)?.closest("#main")), edge: !!document.elementFromPoint(2, 400)?.closest("[data-resize]") }));
  await page.keyboard.press("Control+.");
  await wait(400);
  const shown = await probe();
  await page.screenshot({ path: SHOTS + "after-focus.png" });
  await page.keyboard.press("Control+.");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+.");
  await wait(400);
  const hidden = await probe();
  await page.keyboard.press("Control+.");
  await page.keyboard.press("Control+b");
  await wait(300);
  check("focus mode leaves nothing of the list to hit", shown.main && !shown.edge && hidden.main && !hidden.edge, `list shown ${JSON.stringify(shown)}, list hidden ${JSON.stringify(hidden)}`);
}

async function places(page) {
  const head = async () => { const b = await page.locator(".places-h14").boundingBox(); return [b.x, b.y + b.height / 2, b.width]; };
  let [hx, hy, hw] = await head();
  await press(page, hx + 60, hy); // on the word, well right of the chevron
  const shut = await page.evaluate(() => {
    const nav = document.querySelector(".side-nav"), b = [...nav.querySelectorAll(":scope > .nav")];
    return { shut: nav.classList.contains("shut14"), exp: document.querySelector(".places-h14").getAttribute("aria-expanded"), n: b.length,
      oneRow: new Set(b.map((x) => Math.round(x.getBoundingClientRect().top))).size === 1, h: b.map((x) => Math.round(x.getBoundingClientRect().height)),
      named: b.every((x) => x.getAttribute("aria-label") && x.dataset.tip === x.getAttribute("aria-label")), fontSize: getComputedStyle(b[0]).fontSize };
  });
  await page.screenshot({ path: SHOTS + "after-places-shut.png" });
  check("clicking the Places header's words folds it", shut.shut && shut.exp === "false", `shut14 ${shut.shut}, aria-expanded ${shut.exp}`);
  check("the fold is one row of six icons, names as tooltips (prototype pass 14)", shut.n === 6 && shut.oneRow && shut.h.every((h) => h === 34) && shut.named && shut.fontSize === "0px", JSON.stringify(shut));
  await page.reload();
  await page.waitForSelector("#side .machine");
  await wait(600);
  check("the fold is remembered across a reload", (await page.locator(".side-nav.shut14").count()) === 1 && (await saved(page)).placesShut === true, `saved placesShut ${(await saved(page)).placesShut}`);
  [hx, hy, hw] = await head();
  await press(page, hx + hw - 20, hy); // the far end of the header
  check("clicking the far end of the header opens it again", (await page.locator(".side-nav.shut14").count()) === 0 && (await page.locator(".places-h14").getAttribute("aria-expanded")) === "true", "opened");
  // a redraw between the press and the release (as the live stream does)
  await page.mouse.move(hx + 60, hy);
  await page.mouse.down();
  await page.evaluate(() => import("/app/core/dom.js").then((m) => m.renderNow()));
  await page.mouse.up();
  await wait(300);
  const survived = (await page.locator(".places-h14").getAttribute("aria-expanded")) === "false";
  results.push(["header press with a redraw between down and up (info)", survived ? "PASS" : "INFO", survived ? "folded" : "lost: the redraw replaced the button under the press (claude/window-perf)"]);
  if (survived) await press(page, hx + 60, hy);
}

async function pane(page, sessionId) {
  await page.click(`#side .row[data-id="${sessionId}"]`);
  await wait(600);
  await page.click('.head [data-act="pane"], .tb-head14 [data-act="pane"]');
  await page.waitForSelector("#rz-pane");
  await wait(300);
  const w = () => page.evaluate(() => Math.round(document.getElementById("pane").getBoundingClientRect().width));
  check("the side panel has its edge", (await w()) === 352, `pane ${await w()}px`);
  const [x, y] = await centre(page, "#rz-pane");
  await drag(page, x, y, x - 100);
  check("dragging the side panel's edge left widens it", Math.abs((await w()) - 452) <= 3 && Math.abs((await saved(page)).paneW - 452) <= 3, `pane ${await w()}px, saved ${(await saved(page)).paneW}`);
  await drag(page, x - 100, y, 1300);
  check("the side panel stops at 240px", (await w()) === 240, `pane ${await w()}px`);
  await page.reload();
  await page.waitForSelector("#side .machine");
  await wait(600);
  if (!(await page.locator("#rz-pane").count())) { await page.click(`#side .row[data-id="${sessionId}"]`); await wait(500); await page.click('.head [data-act="pane"], .tb-head14 [data-act="pane"]'); await page.waitForSelector("#rz-pane"); }
  check("the side panel's width survives a reload", (await w()) === 240, `pane ${await w()}px`);
  const [x2] = await centre(page, "#rz-pane");
  await page.mouse.dblclick(x2, y);
  await wait(300);
  check("double-clicking the side panel's edge resets to 352px", (await w()) === 352, `pane ${await w()}px`);
  await page.locator("#rz-pane").focus();
  await page.keyboard.press("ArrowLeft");
  await wait(200);
  check("ArrowLeft on the side panel's edge widens it 16px", (await w()) === 368, `pane ${await w()}px`);
  const dock = await page.locator("#stage7 .st7-dock [data-resize]").count();
  results.push(["computer dock edge", "INFO", dock ? "present: not driven here" : "not drawn on this branch (claude/live-stage draws it; the shared handler takes kind dock)"]);
}

async function narrow(browser) {
  const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
  await signIn(page);
  await page.evaluate(() => localStorage.setItem("branch-window", JSON.stringify({ sideHidden: true })));
  await page.reload();
  await page.waitForSelector("#side .machine");
  await wait(500);
  const cls = await appClass(page);
  await page.click('[data-act="side"]');
  const read = () => page.evaluate(() => { const s = document.getElementById("side"), r = s.getBoundingClientRect(); return { cls: document.getElementById("app").className, vis: getComputedStyle(s).visibility, right: Math.round(r.right) }; });
  const slid = (o) => o.cls.includes("side-open") && o.vis === "visible" && o.right > 100;
  await until(async () => slid(await read()), 3000);
  const open = await read();
  check("a narrow window ignores a saved hidden list and its menu button slides the list in", !cls.includes("side-hidden") && slid(open), `before ${cls}; after ${JSON.stringify(open)}`);
  await page.close();
}

(async () => {
  await api("onboarding", { done: true });
  for (const part of ["trunks", "rooms"]) await api("trunks/switch", { part, mode: "on" });
  const stamp = Date.now().toString(36);
  const trunk = (await api("trunks", { name: `Edge ${stamp}`, description: "Checks the edges" })).trunk;
  // a new Trunk starts its own conversation (it introduces itself there)
  const sessionId = trunk.chatSessionId ?? (await api("trunks")).trunks.find((t) => t.id === trunk.id)?.chatSessionId;
  if (!sessionId) throw new Error("the new Trunk has no conversation of its own");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  // a draw that throws is caught and logged by core/dom.js drawAll, so console errors count too (after signing in: the
  // first request before the token is refused with 401 by design)
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.screenshot({ path: SHOTS + "after-normal.png" });
  for (const step of [listEdge, railAndHidden, keysAndReset, focusMode, places]) await step(page).catch((e) => check(step.name, false, e.message));
  await pane(page, sessionId).catch((e) => check("pane", false, e.message));
  await narrow(browser).catch((e) => check("narrow", false, e.message));
  check("no page errors", errors.length === 0, errors.join(" | ") || "none");
  await browser.close();
  for (const [what, verdict, how] of results) console.log(`${verdict.padEnd(4)} ${what} — ${how}`);
  const failed = results.filter(([, v]) => v === "FAIL").length;
  console.log(failed ? `${failed} failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
