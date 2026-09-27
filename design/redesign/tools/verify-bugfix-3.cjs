/* Bugfix 3 (the security reviewer's shell and accounts test port, PR #322): proves each fix in the real window against a
   FRESH engine, reading every change back through the engine's own GET route. Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-3.cjs
   It must be the engine's first run: it checks that "several accounts per connection" is still off, then adds an account
   through the window with no API switch. Test data it makes through the engine: the cli-claude-code program connection
   (POST /api/providers/cli-agents, which installs and signs in to nothing), one Trunk, one household person (switched to
   and back), and the pet and achievements switches. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const isGreyed = async (loc) => (await loc.count()) > 0 && ((await loc.first().getAttribute("aria-disabled")) === "true" || (await loc.first().isDisabled()));

/* Counts the window's live timers by delay, so a timer that should not run can be seen not running. */
const timerProbe = () => {
  const live = new Map();
  const set = window.setInterval, clear = window.clearInterval;
  window.setInterval = (fn, ms, ...rest) => { const id = set(fn, ms, ...rest); live.set(id, ms); return id; };
  window.clearInterval = (id) => { live.delete(id); return clear(id); };
  window.__intervals = (ms) => [...live.values()].filter((v) => v === ms).length;
};

async function signIn(context) {
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  const page = await context.newPage();
  const errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.url().includes("/api/")) asked.push({ at: Date.now(), method: r.method(), path: new URL(r.url()).pathname, body: r.postData() }); });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  return { page, errors, asked };
}
async function reload(page) { await page.reload(); await page.locator("#main").waitFor(); await settle(page, 1500); }
async function openSettings(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setpage"][data-v="${id === "general" ? "people" : "general"}"]`).first().click();
  await settle(page, 300);
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1200);
}

/* 9: the first run has no practice door any more (the owner's decision: setup is how a model is chosen). */
async function practice(page) {
  if (!(await page.locator(".first").count())) { await page.locator('[data-act="owner"]').first().click(); await page.locator('.pop [data-act="firstrun"]').click(); }
  await page.locator(".first").waitFor();
  await page.locator('.first [data-act="fr-next"]').first().click(); await settle(page, 300);
  const think = await page.locator(".first").innerText();
  check("9 first run: How should Branch think? has no practice door", think.includes("How should Branch think?") && !/Practice/.test(think), think.slice(0, 160));
  for (let i = 0; i < 8 && (await page.locator(".first").count()); i++) {
    const out = page.locator('.first [data-act="fr-skip"], .first [data-act="welcome-x"], .first [data-act="fr-next"]').first();
    if (!(await out.count())) break;
    await out.click(); await settle(page, 300);
  }
  if (await page.locator(".first").count()) await page.keyboard.press("Escape");
}

/* GATE and 1: a fresh engine, accounts mode off; the window adds a cli-claude-code account and switches the mode on itself.
   The Trunk chips are greyed for this sign-in connection, and the Trunk's keys never name it. */
async function gate(page, asked) {
  const before = await api("accounts");
  check("GATE fresh engine: several accounts per connection is off", before.mode === "off", `mode=${before.mode}`);
  await api("providers/cli-agents", { id: "claude-code" });
  await api("trunks/switch", { part: "trunks", mode: "on" });
  const trunk = (await api("trunks", { name: `Bugfix three ${Date.now() % 100000}`, description: "Checks the account chips" })).trunk;
  const pool = (await api("accounts")).pools.find((p) => p.pool === "cli-claude-code");
  check("GATE the cli-claude-code connection is listed (a sign-in pool)", pool?.kind === "cli", JSON.stringify(pool?.kind));
  await reload(page);
  await openSettings(page, "accounts");
  await page.locator('[data-act="addacct"][data-v="cli-claude-code"]').click();
  await page.locator('.dlg [data-act="aa-done"]').waitFor();
  const chips = page.locator('.dlg [data-act="aa-tr"]');
  const n = await chips.count();
  let allGrey = n > 1;
  for (let i = 0; i < n; i++) allGrey = allGrey && (await isGreyed(chips.nth(i)));
  check("1 step 3: every 'Which Trunks use it' chip is greyed for a sign-in connection", allGrey, `${n} chips, the Trunk's included: ${await isGreyed(page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"]`))}`);
  await page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"]`).click({ force: true }).catch(() => {});
  const since = Date.now();
  await page.locator('.dlg [data-act="aa-done"]').click();
  const after = await until(async () => { const v = await api("accounts"); return v.pools.find((p) => p.pool === "cli-claude-code")?.accounts.length === 2 ? v : null; });
  const p = after?.pools.find((x) => x.pool === "cli-claude-code");
  check("GATE GET /api/accounts shows the account added through the window", p?.accounts.length === 2, `${p?.accounts.length} accounts: ${p?.accounts.map((a) => a.id).join(", ")}`);
  check("GATE the mode is now when-needed", after?.mode === "when-needed", `mode=${after?.mode}`);
  check("GATE autoSwitch stays off", p?.autoSwitch === false, `autoSwitch=${p?.autoSwitch}`);
  const sent = asked.filter((r) => r.at >= since && r.method === "POST" && r.path === "/api/accounts/settings").map((r) => r.body);
  check("GATE the window sent exactly { mode: when-needed } (the route's strict shape)", sent.length === 1 && sent[0] === JSON.stringify({ mode: "when-needed" }), sent.join(" | "));
  check("GATE no error line in the wizard", !(await page.locator('.dlg [role="alert"]').count()));
  const t = (await api(`trunks/${trunk.id}`)).trunk;
  check("1 useInTrunks: the Trunk's keys never name the sign-in connection", !t?.keys?.accounts?.["cli-claude-code"], JSON.stringify(t?.keys ?? null));
  await page.keyboard.press("Escape");
  await settle(page, 400);
  return trunk;
}

/* 4: at 390 px the "Another … account" button stays inside the page. */
async function narrow(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page, "accounts");
  const m = await page.evaluate(() => {
    const b = document.querySelector('[data-act="addacct"][data-v]'), col = b?.closest(".set-col") ?? document.scrollingElement;
    const r = b?.getBoundingClientRect();
    return { right: r?.right ?? 0, width: window.innerWidth, doc: document.documentElement.scrollWidth, docW: document.documentElement.clientWidth, col: col.scrollWidth - col.clientWidth };
  });
  check("4 at 390 px: 'Another … account' ends inside the window", m.right <= m.width, `button right ${Math.round(m.right)}, window ${m.width}`);
  check("4 at 390 px: no sideways scroll", m.doc <= m.docW && m.col <= 0, `page ${m.doc}/${m.docW}, column overflow ${m.col}`);
  await page.setViewportSize({ width: 1280, height: 860 });
}

/* 2: on a household profile the owner-only controls on Settings › Accounts are greyed. */
async function household(page) {
  const person = await api("profiles", { name: `Verify ${Date.now() % 100000}`, pin: "4826" });
  await api("profiles/switch", { profileId: person.id, pin: "4826" });
  try {
    await reload(page);
    const active = (await api("profiles")).active;
    check("2 the engine says a household person is active", active?.id === person.id);
    await openSettings(page, "accounts");
    const add = page.locator('[data-act="addacct"]');
    let grey = (await add.count()) > 0;
    for (let i = 0; i < (await add.count()); i++) grey = grey && (await isGreyed(add.nth(i)));
    check("2 household: every 'Add an account' button is greyed", grey, `${await add.count()} buttons`);
    const menu = page.locator('[data-act="acct-menu"]').first();
    if (await menu.count()) {
      await menu.click();
      check("2 household: the account menu's Answer first and Sign out are greyed", (await isGreyed(page.locator('.pop [data-act="acct-first"]'))) && (await isGreyed(page.locator('.pop [data-act="acct-out"]'))));
      await page.keyboard.press("Escape");
    } else console.log("NOTE  2 household: no account is shared with this person (only an API key can be), so the account menu is not drawn");
    await openSettings(page, "models");
    const madd = page.locator('[data-act="addacct"]');
    let mgrey = (await madd.count()) > 0;
    for (let i = 0; i < (await madd.count()); i++) mgrey = mgrey && (await isGreyed(madd.nth(i)));
    check("2 household: Models › Connections' add buttons are greyed too", mgrey, `${await madd.count()} buttons`);
    let refused = "";
    try { await api("accounts/add", { pool: "cli-claude-code", label: "Should be refused" }); } catch (e) { refused = e.message; }
    check("2 household: the engine refuses the add (so greying is right)", refused.includes("belongs to the owner") || refused.includes("owner"), refused);
  } finally {
    await api("profiles/switch", { profileId: null });
  }
  await reload(page);
  check("2 back to the owner: 'Add an account' is live again", !(await isGreyed(page.locator('[data-act="addacct"]').first())) || !(await page.locator('[data-act="addacct"]').count()));
}

/* 18: a Mac shows Cmd for the engine's Ctrl; elsewhere it stays Ctrl. */
async function macKeys(browser, pageHere) {
  const here = await pageHere.locator("#side-q + kbd, .sq9 kbd").first().textContent().catch(() => "");
  check("18 not a Mac: the palette key reads Ctrl", /^Ctrl\b/.test(here ?? ""), here);
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const { page, errors } = await signIn(ctx);
  const mac = await page.locator(".sq9 kbd").first().textContent().catch(() => "");
  check("18 on a Mac: the palette key reads Cmd", /^Cmd\b/.test(mac ?? ""), mac);
  check("18 on a Mac: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* 14, 15, 13: nothing asked and no pet timer while delight is off; then the achievements timer finds what was earned
   without a redraw, and following the computer's light or dark is told to the engine. */
async function delight(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(timerProbe);
  const { page, errors, asked } = await signIn(ctx);
  check("14 delight off (fresh): achievements are off on the engine", (await api("delight")).settings?.achievements?.on === false);
  await settle(page, 16000);
  check("14 delight off: the window never asks for achievements", !asked.some((r) => r.path === "/api/delight/achievements"), `${asked.filter((r) => r.path === "/api/delight/achievements").length} requests`);
  check("14 pet off: no 360 ms pet timer runs", (await page.evaluate(() => window.__intervals(360))) === 0);
  check("15 achievements off: no achievements timer runs", (await page.evaluate(() => window.__intervals(15000))) === 0);

  await api("delight/settings", { pets: { on: true }, achievements: { on: true } });
  await reload(page);
  check("14 pet on: its timer runs", (await page.evaluate(() => window.__intervals(360))) === 1);
  check("15 achievements on: the light timer runs", (await page.evaluate(() => window.__intervals(15000))) === 1);

  /* 13: Light, then Auto, from the person menu. */
  await page.locator('[data-act="owner"]').first().click();
  await page.locator('.pop [data-act="themeset"][data-v="light"]').click();
  await settle(page, 800);
  await page.locator('[data-act="owner"]').first().click();
  await page.locator('.pop [data-act="themeset"][data-v="system"]').click();
  await settle(page, 1200);
  const flagged = asked.filter((r) => r.path === "/api/delight/noticed").map((r) => r.body);
  check("13 following the computer is reported to delight/noticed", flagged.includes(JSON.stringify({ what: "flag", flag: "follow-system" })), flagged.join(" | "));
  check("13 the engine keeps it in the preferences", (await api("state")).preferences?.followSystem === true);

  /* 15: no click, no redraw: the timer looks and the celebration shows, then the engine is told. */
  const quietFrom = Date.now();
  const shown = await until(async () => (await page.locator(".ach-toast, .ach-big").count()) > 0, 35000);
  check("15 the celebration shows without a redraw (timer)", shown, `${Math.round((Date.now() - quietFrom) / 1000)} s`);
  const view = await api("delight/achievements");
  const follow = (a) => a.id.startsWith("noticed:flag:follow-system");
  check("13 the engine earned 'Follow the sun' (noticed:flag:follow-system)", !!view.list?.find(follow)?.got, JSON.stringify(view.list?.find(follow) ?? null));
  const told = asked.filter((r) => r.path === "/api/delight/told").flatMap((r) => JSON.parse(r.body ?? "{}").ids ?? []);
  check("15 what was shown was told to the engine and is no longer fresh", told.length > 0 && !(view.fresh ?? []).some((a) => told.includes(a.id)), `told ${told.join(", ")}`);

  const idleFrom = Date.now();
  await settle(page, 32000);
  const looks = asked.filter((r) => r.at >= idleFrom && r.path === "/api/delight/achievements").length;
  const redraws = asked.filter((r) => r.at >= idleFrom && r.path === "/api/state").length;
  check("15 idle with achievements on: the timer keeps looking with no refresh", looks >= 2 && redraws === 0, `${looks} looks, ${redraws} refreshes in 32 s`);

  /* Switched off outside the window: the window learns it on its next refresh (here, an engine event), re-reads the
     switches, and from then on asks nothing. A look already on its way before that refresh does not count. */
  const offPost = Date.now();
  await api("delight/settings", { pets: { on: false }, achievements: { on: false } });
  await api("trunks", { name: `Refresh ${Date.now() % 100000}`, description: "Makes an engine event" });
  const reread = await until(async () => asked.find((r) => r.at > offPost && r.path === "/api/delight"), 15000);
  const offAt = reread?.at ?? Date.now();
  await settle(page, 17000);
  const late = asked.filter((r) => r.at > offAt && r.path.startsWith("/api/delight")).map((r) => `${r.path} +${r.at - offAt}ms`);
  check("14 switched off elsewhere: after its refresh the window re-reads the switches and stops asking", !!reread && !late.some((x) => x.startsWith("/api/delight/achievements")), `re-read ${reread ? `${reread.at - offPost} ms after the change` : "never"}; after: ${late.join(", ") || "nothing"}`);
  check("14 switched off elsewhere: the pet timer stops", (await page.evaluate(() => window.__intervals(360))) === 0);
  check("15 switched off elsewhere: the light timer stops", (await page.evaluate(() => window.__intervals(15000))) === 0);
  check("delight: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* 16: a theme changed outside the window (as `branch theme` does) reaches the open window on its next refresh. */
async function lookFollows(page) {
  const before = await page.evaluate(() => document.documentElement.dataset.palette);
  const next = before === "forest" ? "slate" : "forest";
  await api("look", { theme: next });
  await api("trunks", { name: `Look ${Date.now() % 100000}`, description: "Makes an engine event" });
  const worn = await until(async () => (await page.evaluate(() => document.documentElement.dataset.palette)) === next, 8000);
  check("16 a theme changed outside reaches the open window", worn, `was ${before}, engine ${next}, window ${await page.evaluate(() => document.documentElement.dataset.palette)}`);
  await api("look", { theme: "slate" });
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors, asked } = await signIn(context);
  try {
    await practice(page);
    await gate(page, asked);
    await narrow(page);
    await household(page);
    await macKeys(browser, page);
    await lookFollows(page);
    await delight(browser);
  } catch (e) { check("script finished", false, e.stack); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
