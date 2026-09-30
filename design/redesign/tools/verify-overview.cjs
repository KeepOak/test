// Verifies the Overview's structure and the selective glass (claude/overview-structure) against a throwaway engine:
// - Seeds real engine data through the API: a Trunk made from setup (x-branch-origin: setup, #386), one made from the
//   window, a task asked from setup, and tasks asked from the window (one with a long unbroken path).
// - At 1440, 1024 and 390 wide, in light and dark: no clipped text in the place (every element's scrollWidth ≤ its
//   clientWidth, nothing ends in an ellipsis and nothing spills past its section), no raw internal prompt (the Trunk
//   introduction, "Trunk: …", setup's task), what the window asked is listed, Health is one line (only what needs
//   attention, or "All N checks OK") with every check behind Details, and Spend is small text when nothing is priced.
// - With a scene on: backdrop-filter only on floating chrome (popovers, title bar, status bar, the dialog's scrim, toasts;
//   the list keeps its own see-through look), content solid, WCAG AA for chrome text over the worst possible scene (the
//   glass composited over black and over white), the solid fallback under prefers-reduced-transparency and the
//   @supports rule, and the list's resize edge still grabbable along its whole width (#389).
// - Zero page errors and zero console errors.
// Run: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-overview.cjs
const { chromium } = require("playwright");

const PORT = process.env.PORT || "3743", TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/overview/";
if (!TOKEN) { console.error("Set TOKEN to the engine's session token."); process.exit(2); }

async function api(path, body, origin = "window") {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-branch-origin": origin }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}
const results = [];
function check(what, ok, how) { results.push([what, ok ? "PASS" : "FAIL", how]); if (!ok) console.log(`FAIL ${what}: ${how}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* A computed colour's opacity: rgba(…, a) or color(srgb r g b / a); 1 when it has none. */
const alphaOf = (c) => { const m = String(c).match(/\/\s*([\d.]+)\s*\)|rgba\([^)]*,\s*([\d.]+)\)/); return m ? Number(m[1] ?? m[2]) : 1; };
const solid = (c) => alphaOf(c) === 1 && !/transparent/.test(c);

const INTRO = "Introduce yourself to the owner in two or three short sentences";
const ASKED = "Summarise my week";
const LONG = "Tidy C:\\Users\\owner\\Documents\\Projects\\a-folder-name-that-goes-on-and-on-without-any-spaces-at-all-to-wrap";
const FROM_SETUP = "Say hello from setup";

/* Real data, once per engine: the tasks fail without a model, and are real tasks all the same. */
async function seed() {
  const trunks = (await api("trunks")).trunks ?? [];
  if (!trunks.some((t) => t.name === "Trunk 3")) await api("trunks", { name: "Trunk 3" }, "setup");
  if (!trunks.some((t) => t.name === "Nova")) await api("trunks", { name: "Nova" });
  const runs = (await api("state")).runs;
  if (!runs.some((r) => r.prompt === FROM_SETUP)) await api("run", { prompt: FROM_SETUP }, "setup");
  if (!runs.some((r) => r.prompt === LONG)) await api("run", { prompt: LONG });
  if (!runs.some((r) => r.prompt === ASKED)) await api("run", { prompt: ASKED });
  await api("onboarding", { done: true }); // setup is finished, so the window opens on its places
  await wait(1500);
  const state = await api("state");
  const setupRun = state.runs.find((r) => r.prompt === FROM_SETUP), mine = state.runs.find((r) => r.prompt === ASKED);
  check("the engine marks setup's task and its own asks aside (GET /api/state)", setupRun?.aside === true && mine && !mine.aside
    && state.runs.filter((r) => r.prompt.startsWith(INTRO) || r.prompt.startsWith("Trunk: ")).every((r) => r.aside === true),
  `setup task aside=${setupRun?.aside}, window task aside=${mine?.aside}, intro/opener runs all aside`);
  return state;
}

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine");
  await wait(800);
}
async function openOverview(page) {
  await page.locator('#side .nav[data-v="overview"]').click();
  await page.locator("#main .ovs-status").waitFor();
  await page.locator("#main .ovs-health").waitFor({ timeout: 8000 });
  await wait(400);
}

/* Every element in the place: its text must fit (scrollWidth ≤ clientWidth), no ellipsis, nothing past its section. */
function clipScan() {
  const place = document.querySelector("#main .place"), out = [];
  for (const el of place.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || !el.getClientRects().length || el.closest("details:not([open]) > :not(summary)")) continue;
    const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "auto" && cs.overflowX !== "scroll" && el.clientWidth > 0) out.push(`scroll ${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}`);
    if (text && cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth) out.push(`ellipsis ${el.className}`);
    const box = el.closest("section.tile");
    if (text && box && box !== el) { const r = el.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.right > b.right + 1 || r.left < b.left - 1) out.push(`spills ${el.tagName}.${el.className} ${Math.round(r.right)}>${Math.round(b.right)}`); }
  }
  const pr = place.getBoundingClientRect();
  if (pr.right > document.documentElement.clientWidth + 1) out.push(`place wider than the window ${pr.right}`);
  return out;
}

async function structure(page, width, theme, health) {
  const tag = `${width} ${theme}`;
  const clipped = await page.evaluate(clipScan);
  check(`${tag}: no clipped text`, clipped.length === 0, clipped.slice(0, 6).join("; ") || "every scrollWidth ≤ clientWidth, no ellipsis, nothing spills");
  const text = await page.locator("#main").innerText();
  const raw = [INTRO, "Trunk: ", FROM_SETUP, "Opened"].filter((w) => text.includes(w));
  check(`${tag}: no raw internal prompts`, raw.length === 0, raw.length ? `found: ${raw.join(" | ")}` : "no intro ask, no Trunk: opener, no setup task");
  const recent = await page.locator("#main .ovs-act").allInnerTexts();
  check(`${tag}: recent activity is what the window asked`, recent.some((r) => r.includes(ASKED)) && recent.some((r) => r.includes("a-folder-name")), recent.map((r) => r.split("\n")[0].slice(0, 40)).join(" / "));
  const bad = health.items.filter((i) => !i.ok);
  const line = await page.locator("#main .ovs-health > .ovs-check").allInnerTexts();
  const lineOk = bad.length ? line.length === bad.length : line.length === 1 && line[0].includes(`All ${health.items.length} checks OK`);
  check(`${tag}: Health is one line, only what needs attention`, lineOk, `${line.length} line(s) for ${bad.length} failing of ${health.items.length}: ${line.map((l) => l.replace(/\s+/g, " ").slice(0, 60)).join(" | ")}`);
  const shut = await page.locator("#main .ovs-details").evaluate((d) => !d.open);
  await page.locator("#main .ovs-details summary").click();
  const all = await page.locator("#main .ovs-details .ovs-check").count();
  const clippedOpen = await page.evaluate(clipScan);
  await page.locator("#main .ovs-details summary").click();
  check(`${tag}: every check sits behind Details`, shut && all === health.items.length && clippedOpen.length === 0, `closed at first: ${shut}; open shows ${all} of ${health.items.length}; clipped when open: ${clippedOpen.length}`);
  const spend = await page.locator("#main .tile").filter({ has: page.getByRole("heading", { name: "Spend this week" }) });
  const big = await spend.locator(".big-n").count(), note = await spend.locator("p").allInnerTexts();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const priced = (await api("state")).runs.some((r) => !r.aside && typeof r.cost?.amount === "number" && new Date(r.createdAt).getTime() > weekAgo);
  if (priced) check(`${tag}: Spend shows the priced total`, big === 1, `big figure ${big}`);
  else check(`${tag}: Spend is small text with nothing priced`, big === 0 && note.length === 1, `big figure ${big}, text: ${note.join(" | ")}`);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector("#main .ovs-cols")).gridTemplateColumns.split(" ").length);
  check(`${tag}: sections sized to their content (${cols} column(s))`, width === 390 ? cols === 1 : cols === 2, `grid columns ${cols}`);
  await page.screenshot({ path: `${SHOTS}overview-${width}-${theme}.png`, fullPage: false });
}

/* Text over the glass, composited over the worst a scene can be behind it. */
function contrastScan() {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/) ?? c.match(/color\(srgb ([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); const srgb = c.startsWith("color("); return { r: srgb ? p[0] * 255 : p[0], g: srgb ? p[1] * 255 : p[1], b: srgb ? p[2] * 255 : p[2], a: p[3] ?? 1 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  /* Any scene: its darkest and lightest possible pixel (black, white) under the scene's own veil, the theme's list colour
     at the engine's lowest strength (background.scrim min 20, src/delight.ts; .bg-scrim). */
  const veil = { ...parse(getComputedStyle(document.querySelector(".bg-scrim")).backgroundColor), a: 0.2 };
  const scenes = [over(veil, { r: 0, g: 0, b: 0, a: 1 }), over(veil, { r: 255, g: 255, b: 255, a: 1 })];
  const surfaces = [[".titlebar", null], [".side", null], [".statusbar", null], [".pop", null], [".toast", null], [".dlg", null]];
  const out = [];
  for (const [sel, pseudo] of surfaces) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const bg = parse(getComputedStyle(el, pseudo).backgroundColor);
    if (!bg || bg.a === 0) continue;
    const texts = [];
    for (const t of el.querySelectorAll("*")) {
      if (!t.getClientRects().length || ![...t.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(t);
      // greyed controls are inactive (WCAG 1.4.3 exempts them); text on its own filled chip is not over the glass
      if (cs.visibility === "hidden" || Number(cs.opacity) < 0.6 || t.closest(".soon,[aria-disabled='true'],.av,.pill,.btn.pri,.btn.bad,.badge,.kbd,kbd")) continue;
      const own = parse(cs.backgroundColor);
      if (own && own.a > 0.5) continue;
      texts.push([parse(cs.color), `${t.tagName}.${t.className} "${t.textContent.trim().slice(0, 20)}"`]);
    }
    const worstAt = (alpha) => {
      let worst = 99, at = "";
      for (const [fg, name] of texts) for (const under of scenes) {
        const base = over({ ...bg, a: alpha }, under), r = ratio(over(fg, base), base);
        if (r < worst) { worst = r; at = name; }
      }
      return [worst, at];
    };
    const [worst, at] = worstAt(bg.a);
    let needs = 1; // the least opacity at which every text here is AA over black and over white, for tuning --chrome-a
    for (let a = 0.8; a <= 1.0001; a += 0.01) if (worstAt(a)[0] >= 4.5) { needs = Math.round(a * 100) / 100; break; }
    if (worst < 99) out.push([`${sel}${pseudo ?? ""}`, Math.round(worst * 100) / 100, at, bg.a, needs]);
  }
  return out;
}

function glassScan() {
  const hits = [];
  for (const el of document.querySelectorAll("*")) for (const pseudo of [null, "::before", "::after"]) {
    if (pseudo && ["none", "normal"].includes(getComputedStyle(el, pseudo).content)) continue; // a pseudo-element not drawn
    const bf = getComputedStyle(el, pseudo).backdropFilter;
    if (bf && bf !== "none" && el.getClientRects().length) hits.push({ id: el.id, cls: String(el.className), pseudo, bf,
      chrome: el.matches(".pop,.toast,.titlebar,.statusbar,.scrim,.app.has-bg .side,.app.mac .side") && (!pseudo || el.matches(".titlebar")),
      content: !!el.closest(".main .place,.tile,.card,.dlg,.pane,.sec") || el.matches(".main") });
  }
  return hits;
}

async function glass(page, theme, cdp) {
  // the scene at its most see-through (the engine's lowest veil) and a bright picture, the hardest case for the glass
  await api("delight/settings", { background: { on: true, scrim: 20 } });
  await page.evaluate(() => localStorage.setItem("branch-scene", JSON.stringify({ bg: "painted", scene: "day17-meadow", season: "auto", petWhere: "side" })));
  await page.reload(); await page.waitForSelector("#side .machine"); await wait(600);
  await openOverview(page);
  await page.waitForSelector("#app.has-bg");
  await page.locator('#side [data-act="owner"]').click();
  await page.locator(".pop").first().waitFor();
  await page.evaluate(() => import("/app/core/ui.js").then((m) => m.toast("Back to the usual size.")));
  await wait(300);
  const hits = await page.evaluate(glassScan);
  const off = hits.filter((h) => !h.chrome || h.content);
  check(`${theme}: glass only on chrome`, off.length === 0 && hits.some((h) => /pop/.test(h.cls)) && hits.some((h) => /titlebar/.test(h.cls)) && hits.some((h) => /statusbar/.test(h.cls)) && hits.some((h) => /toast/.test(h.cls)),
    off.length ? `off chrome: ${off.map((h) => `${h.cls}${h.pseudo ?? ""}`).join(", ")}` : `on: ${[...new Set(hits.map((h) => `${h.cls.split(" ")[0]}${h.pseudo ?? ""}`))].join(", ")}`);
  const pop = await page.locator(".pop").first().evaluate((el) => { const cs = getComputedStyle(el); return { bf: cs.backdropFilter, bg: cs.backgroundColor, sh: cs.boxShadow }; });
  check(`${theme}: popover glass is blur + saturate, translucent token, hairline`, /blur/.test(pop.bf) && /saturate/.test(pop.bf) && alphaOf(pop.bg) < 1 && /inset/.test(pop.sh), `${pop.bf} · ${pop.bg} · ${pop.sh.slice(0, 60)}`);
  const main = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById("main")); return [cs.backdropFilter, cs.backgroundColor]; });
  check(`${theme}: content stays solid over a scene`, main[0] === "none" && solid(main[1]), main.join(" · "));
  let contrast = await page.evaluate(contrastScan);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("?");
  const dlg = await page.locator(".dlg").first().waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (dlg) {
    await wait(700); // the scrim and dialog fade in
    contrast =contrast.concat((await page.evaluate(contrastScan)).filter((c) => c[0] === ".dlg"));
    const d = await page.evaluate(() => [getComputedStyle(document.querySelector(".dlg")).backdropFilter, getComputedStyle(document.querySelector(".scrim")).backdropFilter, getComputedStyle(document.querySelector(".dlg")).backgroundColor]);
    check(`${theme}: a dialog over the scene is glass (blurred scrim, translucent dialog, none on the dialog itself)`, d[0] === "none" && /blur/.test(d[1]) && alphaOf(d[2]) < 1, d.join(" · "));
    await page.screenshot({ path: `${SHOTS}glass-dialog-${theme}.png` });
    await page.keyboard.press("Escape");
  } else check(`${theme}: a dialog over the scene is glass`, false, "the shortcuts dialog did not open");
  const low = contrast.filter((c) => c[1] < 4.5);
  check(`${theme}: WCAG AA for chrome text over any scene`, low.length === 0 && contrast.length >= 4, contrast.map((c) => `${c[0]} ${c[1]}:1 (AA from ${c[4]})`).join(", ") + (low.length ? ` · lowest at ${low.map((c) => c[2]).join("; ")}` : ""));
  await page.locator('#side [data-act="owner"]').click();
  await page.evaluate(() => import("/app/core/ui.js").then((m) => m.toast("Back to the usual size.")));
  await wait(200);
  await page.screenshot({ path: `${SHOTS}glass-${theme}.png` });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  await wait(200);
  const flat = await page.evaluate(() => [".pop", ".toast", ".statusbar", ".side", ".titlebar"].map((s) => { const cs = getComputedStyle(document.querySelector(s)); return [s, cs.backdropFilter, cs.backgroundColor]; }));
  check(`${theme}: solid under prefers-reduced-transparency`, flat.every(([, bf, bg]) => bf === "none" && solid(bg)), flat.map((f) => f.join(" ")).join(" · "));
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await page.keyboard.press("Escape");
  const supports = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
    const rule = rules.find((r) => r instanceof CSSSupportsRule && /not/.test(r.conditionText) && /backdrop-filter/.test(r.conditionText));
    if (!rule) return "no @supports not (backdrop-filter) rule";
    // what the rule sets, applied as if backdrop-filter were missing
    const set = [...rule.cssRules[0].style];
    for (const name of set) document.documentElement.style.setProperty(name, rule.cssRules[0].style.getPropertyValue(name).trim());
    const bg = getComputedStyle(document.querySelector(".statusbar")).backgroundColor;
    for (const name of set) document.documentElement.style.removeProperty(name);
    return [rule.conditionText, bg];
  });
  check(`${theme}: solid when backdrop-filter is unsupported (@supports)`, Array.isArray(supports) && solid(supports[1]), Array.isArray(supports) ? `${supports[0]} → statusbar ${supports[1]}` : supports);
  const sweep = await page.evaluate(() => {
    const r = document.getElementById("rz-side")?.getBoundingClientRect(), miss = [];
    if (!r) return "no list edge";
    for (let x = Math.ceil(r.left); x < Math.floor(r.right); x++) { const el = document.elementFromPoint(x, 400); if (!el?.closest("#rz-side")) miss.push(`${x}:${el?.className}`); }
    return miss.join(" ");
  });
  check(`${theme}: the list edge is grabbable along its whole width over a scene (#389)`, sweep === "", sweep || "every x hits #rz-side");
  await api("delight/settings", { background: { on: false, scrim: 60 } });
}

(async () => {
  const health = await api("health");
  await seed();
  const browser = await chromium.launch();
  const errors = [];
  for (const theme of ["light", "dark"]) {
    // light or dark is the engine's preference (POST /api/preferences, as the title bar's switch saves it)
    const prefs = (await api("state")).preferences;
    await api("preferences", { ...prefs, followSystem: false, appearance: theme === "light" ? "daylight" : "forest" });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${theme} page: ${e.message}`));
    await signIn(page);
    // a draw that throws is logged by core/dom.js drawAll, so console errors count too, from after signing in (the first
    // request before the token is refused with 401 by design)
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${theme} console: ${m.text()}`); });
    await openOverview(page);
    check(`${theme}: the window is in ${theme}`, (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, await page.evaluate(() => document.documentElement.dataset.theme));
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await wait(500);
      await structure(page, width, theme, health);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await glass(page, theme, await context.newCDPSession(page));
    await context.close();
  }
  await browser.close();
  check("zero page and console errors", errors.length === 0, errors.slice(0, 5).join(" | ") || "none");
  for (const [what, verdict, how] of results) console.log(`${verdict}  ${what} — ${how}`);
  const failed = results.filter((r) => r[1] === "FAIL").length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
