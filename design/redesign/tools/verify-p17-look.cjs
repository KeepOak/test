// Verifies pass 17's look (design/redesign/pass17/AESTHETIC17.md) in the real window against a running engine.
// The look adds no controls; what it changes is proved from the window's computed styles, and every look setting it
// touches (theme, More contrast, light or dark) is changed through the window or the engine's routes and read back with
// GET /api/look or GET /api/state. Page errors are recorded and must be zero.
//   1. Slate's tokens in Daylight and Moonlight equal the CSS, and BRANCH_EF agrees (More contrast on puts Slate through
//      BRANCH_EF: the inline colours must equal the stylesheet's).
//   2. Faint text (--ink-3) is at least 4.5:1 on the page, sidebar, cards and glass, at 1440 and 390, light and dark;
//      and on real faint text (a Settings hint, a conversation row's line).
//   3. More contrast, switched in Settings › Appearance: GET /api/look says "more", the soft hairline becomes the full line.
//   4. Every theme in /theme-catalogue.js, worn through the window's own wear() (POST /api/look), in both modes: the
//      hairline and wash follow that theme's own colours, and glass lowers faint-text contrast by no more than 0.35.
//      Catalogue themes are not held to 4.5:1 (their colours are KeepOak's); their faint-text contrast is printed.
//   5. The components: the raised current row, the floating composer, the Settings card, glass popovers, one send that
//      turns copper when there is something to send, greyed controls that stay still on hover.
//   6. Motion: a fresh popover and dialog arrive once; picking a theme redraws the gallery without replaying it; with
//      reduced motion the dialog has no animation.
//   7. Settings has no sideways scroll at 390.
// Run on a throwaway engine: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-p17-look.cjs
// It puts back the theme, contrast and light-or-dark it found.
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}
const results = [];
function check(name, ok, how) { results.push([name, ok ? "PASS" : "FAIL", how]); if (!ok) console.log(`FAIL ${name}: ${how}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- colour maths (WCAG) ---------- */
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg, bg) => fg.slice(0, 3).map((v, i) => bg[i] + (v - bg[i]) * fg[3]);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
const near = (a, b, tol = 2) => !!a && !!b && a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol) && Math.abs((a[3] ?? 1) - (b[3] ?? 1)) < 0.02;
const r2 = (n) => Math.round(n * 100) / 100;

/* In the page: a token resolved to [r,g,b,a] by painting it on a probe. */
const PROBE = `window.__tok = (name) => {
  let p = document.getElementById("probe17");
  if (!p) { p = document.createElement("i"); p.id = "probe17"; p.hidden = true; document.body.appendChild(p); }
  p.style.backgroundColor = "var(" + name + ")";
  const s = getComputedStyle(p).backgroundColor;
  let m = /^rgba?\\(([^)]+)\\)$/.exec(s);
  if (m) { const v = m[1].split(",").map(parseFloat); return [v[0], v[1], v[2], v[3] ?? 1]; }
  m = /^color\\(srgb ([^)]+)\\)$/.exec(s);
  if (m) { const [rgb, a] = m[1].split("/"); const v = rgb.trim().split(/\\s+/).map((x) => parseFloat(x) * 255); return [v[0], v[1], v[2], a ? parseFloat(a) : 1]; }
  return null;
};
window.__bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c; } return getComputedStyle(document.body).backgroundColor; };`;
const tok = (page, name) => page.evaluate((n) => window.__tok(n), name);
const toks = async (page, names) => { const o = {}; for (const n of names) o[n] = await tok(page, n); return o; };
const rgbOf = (s) => {
  let m = /rgba?\(([^)]+)\)/.exec(s || "");
  if (m) { const v = m[1].split(",").map(parseFloat); return [v[0], v[1], v[2], v[3] ?? 1]; }
  m = /color\(srgb ([^)]+)\)/.exec(s || "");
  if (m) { const [rgb, a] = m[1].split("/"); const v = rgb.trim().split(/\s+/).map((x) => parseFloat(x) * 255); return [v[0], v[1], v[2], a ? parseFloat(a) : 1]; }
  return null;
};

const SLATE = {
  light: { "--bg": "#F6F8F9", "--side": "#EDF1F3", "--raise": "#FFFFFF", "--ink": "#141D24", "--ink-2": "#3A4751", "--ink-3": "#5F6C76", "--line": "#DFE5E9", "--btn": "#141D24", "--on-btn": "#F6F8F9" },
  dark: { "--bg": "#0F1418", "--side": "#0B0F12", "--raise": "#161D22", "--ink": "#E6ECF0", "--ink-2": "#AEBAC3", "--ink-3": "#85929B", "--line": "#1D262C", "--btn": "#E6ECF0", "--on-btn": "#0F1418" },
};

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine");
  if (await page.isVisible(".ob9")) await page.click('.ob9 [data-act="ob-close"]');
  await page.evaluate(PROBE);
}
async function setMode(page, mode) {
  const prefs = (await api("state")).preferences;
  await api("preferences", { ...prefs, appearance: mode === "light" ? "daylight" : "forest", followSystem: false });
  await page.reload();
  await page.waitForSelector("#side .machine");
  await page.evaluate(PROBE);
  await wait(500);
  const got = await page.evaluate(() => document.documentElement.dataset.theme);
  const read = (await api("state")).preferences.appearance;
  check(`mode ${mode}`, got === mode && read === (mode === "light" ? "daylight" : "forest"), `window data-theme=${got}, GET /api/state appearance=${read}`);
}
/* The sidebar's own buttons; at 390 the sidebar is folded away, so the click is sent to the button itself. */
const view = (page, v) => page.$eval(v === "settings" ? '#side .owner-row [data-act="view"][data-v="settings"]' : `#side [data-act="view"][data-v="${v}"]`, (b) => b.click());

async function slateTokens(page, mode) {
  const want = SLATE[mode];
  const got = await toks(page, Object.keys(want));
  const bad = Object.entries(want).filter(([k, v]) => !near(got[k], hex(v), 1)).map(([k]) => k);
  check(`slate tokens ${mode}`, bad.length === 0, bad.length ? `differ: ${bad.join(", ")}` : "bg, side, raise, ink, ink-2, ink-3, line, btn, on-btn equal pass 17's Slate");
  const ef = await page.evaluate(async () => (await import("/app/shell/look.js")).BRANCH_EF);
  const efMap = { "--bg": "bg", "--side": "side", "--raise": "raise", "--ink": "ink", "--ink-2": "ink2", "--ink-3": "ink3", "--line": "line", "--btn": "btn", "--on-btn": "onBtn" };
  const efBad = Object.entries(efMap).filter(([k, e]) => ef[mode][e].toUpperCase() !== want[k]).map(([k]) => k);
  check(`BRANCH_EF ${mode}`, efBad.length === 0, efBad.length ? `BRANCH_EF differs on ${efBad.join(", ")}` : "BRANCH_EF equals the stylesheet's Slate");
}

async function faintContrast(page, mode, width) {
  await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
  await wait(300);
  const t = await toks(page, ["--ink-3", "--bg", "--side", "--raise", "--glass17"]);
  const glass = over(t["--glass17"], t["--bg"]);
  const pairs = { page: t["--bg"], sidebar: t["--side"], cards: t["--raise"], glass };
  const out = Object.entries(pairs).map(([k, bg]) => [k, r2(ratio(t["--ink-3"], bg))]);
  check(`faint text ${mode} ${width}`, out.every(([, v]) => v >= 4.5), out.map(([k, v]) => `${k} ${v}:1`).join(", "));
  // real faint text: a Settings hint and a conversation row's second line
  await view(page, "settings");
  await wait(300);
  const samples = await page.evaluate(() => [".set-col .ctl small", "#side .row p"].map((q) => {
    const el = [...document.querySelectorAll(q)].find((e) => e.offsetParent !== null) ?? document.querySelector(q);
    return el ? [q, getComputedStyle(el).color, window.__bgOf(el)] : [q, null, null];
  }));
  for (const [q, fg, bg] of samples) {
    if (!fg) { check(`faint sample ${q} ${mode} ${width}`, true, "not on screen at this width (skipped)"); continue; }
    const v = r2(ratio(rgbOf(fg), rgbOf(bg)));
    check(`faint sample ${q} ${mode} ${width}`, v >= 4.5, `${v}:1 (${fg} on ${bg})`);
  }
}

async function moreContrast(page, mode) {
  await view(page, "settings");
  await page.click('[data-act="setpage"][data-v="appearance"]');
  await page.waitForSelector("#a-contrast");
  await page.locator("#a-contrast").check();
  await wait(600);
  const look = await api("look");
  const cls = await page.evaluate(() => document.documentElement.classList.contains("contrast17"));
  const t = await toks(page, ["--hair17", "--line"]);
  check(`more contrast on ${mode}`, look.contrast === "more" && cls && near(t["--hair17"], t["--line"], 1), `GET /api/look contrast=${look.contrast}; html.contrast17=${cls}; hairline ${JSON.stringify(t["--hair17"])} = line ${JSON.stringify(t["--line"])}`);
  // Slate through BRANCH_EF (inline colours) must equal the stylesheet's
  const inline = await page.evaluate(() => ["--bg", "--side", "--raise", "--ink", "--ink-2", "--ink-3", "--line", "--btn", "--on-btn"].map((k) => [k, document.documentElement.style.getPropertyValue(k).trim().toUpperCase()]));
  const bad = inline.filter(([k, v]) => v !== SLATE[mode][k]).map(([k, v]) => `${k}=${v || "unset"}`);
  check(`slate via BRANCH_EF ${mode}`, bad.length === 0, bad.length ? bad.join(", ") : "inline Slate colours equal the stylesheet");
  await page.locator("#a-contrast").uncheck();
  await wait(600);
  const back = await api("look");
  const cls2 = await page.evaluate(() => document.documentElement.classList.contains("contrast17"));
  const t2 = await toks(page, ["--hair17", "--line"]);
  check(`more contrast off ${mode}`, back.contrast === "standard" && !cls2 && Math.abs(t2["--hair17"][3] - 0.7) < 0.02, `GET /api/look contrast=${back.contrast}; html.contrast17=${cls2}; hairline alpha ${r2(t2["--hair17"][3])}`);
}

async function themeSweep(page, mode) {
  const ids = await page.evaluate(async () => (await import("/theme-catalogue.js")).THEMES.map((t) => t[0]));
  const bad = [], faint = [];
  for (const id of ids) {
    await page.evaluate(async (i) => (await import("/app/shell/look.js")).wear(i), id);
    const t = await toks(page, ["--line", "--ink", "--ink-3", "--bg", "--raise", "--hair17", "--wash17", "--glass17"]);
    const hairOk = near(t["--hair17"], [...t["--line"].slice(0, 3), 0.7], 2);
    const washOk = near(t["--wash17"], [...t["--ink"].slice(0, 3), 0.05], 2);
    const onRaise = ratio(t["--ink-3"], t["--raise"]), onGlass = ratio(t["--ink-3"], over(t["--glass17"], t["--bg"]));
    const glassOk = onRaise - onGlass <= 0.35;
    if (!hairOk || !washOk || !glassOk) bad.push(`${id}(${!hairOk ? "hair " : ""}${!washOk ? "wash " : ""}${!glassOk ? "glass" : ""})`);
    faint.push(`${id} ${r2(ratio(t["--ink-3"], t["--bg"]))}`);
  }
  const worn = (await api("look")).theme;
  check(`theme sweep ${mode}`, bad.length === 0 && worn === ids[ids.length - 1], `${ids.length} themes worn via POST /api/look (GET says ${worn}); ${bad.length ? "failed: " + bad.join(", ") : "hairline, wash and glass follow each theme"}`);
  console.log(`  catalogue faint-text contrast on the page (${mode}, info only): ${faint.join(", ")}`);
  await page.evaluate(async () => (await import("/app/shell/look.js")).wear("slate"));
  check(`slate back ${mode}`, (await api("look")).theme === "slate", "GET /api/look theme=slate");
}

async function components(page, mode) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const row = page.locator("#side .row").first();
  await row.click();
  await wait(500);
  const c = await page.evaluate(() => {
    const cur = document.querySelector('#side .row[aria-current="true"]'), box = document.getElementById("composer");
    const cs = (e) => (e ? getComputedStyle(e) : null);
    return { rowBg: cs(cur)?.backgroundColor, rowSh: cs(cur)?.boxShadow, boxR: cs(box)?.borderTopLeftRadius, boxSh: cs(box)?.boxShadow, raise: window.__tok("--raise") };
  });
  check(`raised current row ${mode}`, !!c.rowBg && near(rgbOf(c.rowBg), c.raise, 1) && c.rowSh !== "none", `current row ${c.rowBg}, shadow ${c.rowSh !== "none"}`);
  check(`floating composer ${mode}`, c.boxR === "26px" && c.boxSh !== "none", `radius ${c.boxR}, lift ${c.boxSh !== "none"}`);
  // one send: a quiet wash when empty, copper once there is something to send, quiet again when cleared
  await page.fill("#prompt", "hello");
  await wait(400);
  const ready = await page.evaluate(() => { const s = document.getElementById("send"); return [s.classList.contains("ready"), getComputedStyle(s).backgroundColor]; });
  const accent = await tok(page, "--accent");
  await page.fill("#prompt", "");
  await wait(150);
  const empty = await page.evaluate(() => document.getElementById("send").classList.contains("ready"));
  check(`send ready ${mode}`, ready[0] && near(rgbOf(ready[1]), accent, 1) && !empty, `typed: ready=${ready[0]} ${ready[1]}; cleared: ready=${empty}`);
  // greyed controls stay still on hover
  // (the controls pass 17 gives a hover wash; the window buttons' own hover is older than pass 17 and left alone)
  const GREYED = ".app :is(.row,.nav,.mi,.btn,.tab,.c-btn,.chip-c,.icon-btn,.tb-btn,.sb,.owner).soon:visible";
  const seen = [];
  for (const opener of [null, '[data-act="chatmenu"]', "#side .owner"]) {
    if (opener) { await page.keyboard.press("Escape"); await page.mouse.click(1000, 500); await page.click(opener); await wait(300); }
    const all = page.locator(GREYED);
    for (let i = 0; i < Math.min(await all.count(), 3); i++) {
      const el = all.nth(i);
      await el.hover();
      await wait(250);
      seen.push(await el.evaluate((e) => [e.className, getComputedStyle(e).backgroundColor]));
    }
  }
  await page.keyboard.press("Escape");
  await page.mouse.click(1000, 500);
  const lit = seen.filter(([, bg]) => bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent");
  check(`greyed hover ${mode}`, seen.length > 0 && lit.length === 0, `${seen.length} greyed controls hovered (${[...new Set(seen.map((s) => s[0]))].join("; ")}); washed: ${lit.map((s) => s.join(" ")).join(", ") || "none"}`);
  // the Settings card: a section of only rows becomes one 16px card
  await view(page, "settings");
  await page.click('[data-act="setpage"][data-v="general"]');
  await wait(300);
  const card = await page.evaluate(() => { const e = document.querySelector(".set-col .sec:not(:has(> :not(h2,p,.ctl))) > .ctl"); return e ? [getComputedStyle(e).borderTopLeftRadius, getComputedStyle(e).backgroundColor] : null; });
  check(`settings card ${mode}`, !!card && card[0] === "16px", card ? `first row radius ${card[0]}, ${card[1]}` : "no row");
}

async function motion(page, mode) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click("#side .owner");
  await page.waitForSelector(".pop");
  const pop = await page.evaluate(() => { const p = document.querySelector(".pop"); return [p.classList.contains("in17"), getComputedStyle(p).backdropFilter]; });
  check(`popover glass and arrival ${mode}`, pop[0] && /blur/.test(pop[1]), `in17=${pop[0]}, backdrop ${pop[1]}`);
  await page.keyboard.press("Escape");
  await page.mouse.click(1000, 500);
  await view(page, "settings");
  await page.click('[data-act="setpage"][data-v="appearance"]');
  await page.click('[data-act="skins"]');
  await page.waitForSelector(".scrim .themes6");
  const fresh = await page.evaluate(() => document.querySelector(".scrim").classList.contains("in17"));
  await page.evaluate(() => { document.querySelector(".scrim").dataset.mark17 = "1"; });
  await page.click('[data-act="skin"][data-v="nord"]');
  await wait(600);
  const after = await page.evaluate(() => { const s = document.querySelector(".scrim"); return s ? [s.dataset.mark17 === "1", s.getAnimations({ subtree: true }).filter((a) => /dlg17|scrim17/.test(a.animationName)).length] : [false, -1]; });
  const worn = (await api("look")).theme;
  check(`dialog arrives once ${mode}`, fresh && after[0] && after[1] === 0 && worn === "nord", `fresh dialog in17=${fresh}; after picking a theme (GET /api/look theme=${worn}) same dialog=${after[0]}, replaying animations=${after[1]}`);
  await page.click('[data-act="skin"][data-v="slate"]').catch(() => {});
  await wait(400);
  await page.click('[data-act="dlg-close"]').catch(() => {});
  if ((await api("look")).theme !== "slate") await api("look", { theme: "slate" });
}

async function reduced(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  await view(page, "settings");
  await page.click('[data-act="setpage"][data-v="appearance"]');
  await page.click('[data-act="skins"]');
  await page.waitForSelector(".scrim .dlg");
  const n = await page.evaluate(() => document.querySelector(".scrim").getAnimations({ subtree: true }).length);
  check("reduced motion", n === 0, `animations on the dialog with reduced motion: ${n}`);
  await ctx.close();
  return errors;
}

async function narrowSettings(page, mode) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await view(page, "settings");
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(400);
  const w = await page.evaluate(() => { const c = document.querySelector(".set-col"); return [document.scrollingElement.scrollWidth, innerWidth, c ? c.scrollWidth - c.clientWidth : 0]; });
  check(`settings 390 no sideways scroll ${mode}`, w[0] <= w[1] && w[2] <= 1, `page ${w[0]}/${w[1]}, settings column overflow ${w[2]}px`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

(async () => {
  await api("onboarding", { done: true });
  const st = await api("state");
  const prefs0 = st.preferences, look0 = await api("look");
  if (!(st.sessions ?? []).length) await api("run", { prompt: "A conversation to look at" });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    if (look0.theme !== "slate" || look0.contrast !== "standard") await api("look", { theme: "slate", contrast: "standard" });
    for (const mode of ["light", "dark"]) {
      await setMode(page, mode);
      await slateTokens(page, mode);
      await faintContrast(page, mode, 1440);
      await faintContrast(page, mode, 390);
      await page.setViewportSize({ width: 1440, height: 900 });
      await moreContrast(page, mode);
      await components(page, mode);
      await motion(page, mode);
      await narrowSettings(page, mode);
      await themeSweep(page, mode);
    }
    errors.push(...await reduced(browser));
  } finally {
    await api("preferences", prefs0).catch((e) => console.log("put back preferences:", e.message));
    await api("look", { theme: look0.theme, contrast: look0.contrast }).catch((e) => console.log("put back look:", e.message));
    await browser.close();
  }
  check("page errors", errors.length === 0, errors.length ? errors.slice(0, 5).join(" | ") : "none");
  for (const [n, s, how] of results) console.log(`${s}  ${n}: ${how}`);
  const failed = results.filter((r) => r[1] === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
