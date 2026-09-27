/* Clicks every Settings control this area made live against a running engine and confirms each change through the
   engine's own GET route. Run against a throwaway engine only (it adds accounts, a Trunk and a connection):
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> DATA_DIR=<the same fresh dir> node design/redesign/tools/verify-settings.cjs
   Two small stand-ins answer where outside programs would: an OpenAI-shaped proxy on 127.0.0.1:4000 (so a LiteLLM proxy
   connection can be added with a test key, giving the accounts routes a key connection to work on) and Ollama's API on
   127.0.0.1:11434 (so downloads, stopping, removing and a model in memory come from Ollama's real routes as the engine
   calls them). Nothing else on this computer is touched; both close when the script ends. */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

/* DATA_DIR is optional: with it, the gateway's suggested change is written there (the assistant's gateway.propose tool
   would need a model run) so "Use it" and "Discard" can be tried; without it those two are skipped. */
const PORT = process.env.PORT, TOKEN = process.env.TOKEN, DATA_DIR = process.env.DATA_DIR;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN (and DATA_DIR for the gateway's suggestion)."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}

/* ---------- stand-ins ---------- */
function listen(port, handler) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.once("error", (e) => reject(new Error(e.code === "EADDRINUSE" ? `port ${port} is in use (is ${port === 11434 ? "Ollama" : "a proxy"} running?); stop it and run again` : e.message)));
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}
const readBody = (req) => new Promise((done) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { done(JSON.parse(b || "{}")); } catch { done({}); } }); });
const json = (res, data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };

const proxy = () => listen(4000, (req, res) => {
  if (req.url.startsWith("/v1/models")) return json(res, { object: "list", data: [{ id: "stand-in-model", object: "model" }] });
  json(res, { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
});

const ollamaModels = [{ name: "stand-in:1b", size: 1_300_000_000, details: { family: "stand-in", parameter_size: "1B" } }];
const ollama = () => listen(11434, async (req, res) => {
  if (req.url === "/api/version") return json(res, { version: "0.0.0-stand-in" });
  if (req.url === "/api/tags") return json(res, { models: ollamaModels });
  if (req.url === "/api/ps") return json(res, { models: ollamaModels.slice(0, 1).map((m) => ({ name: m.name, size: m.size })) });
  if (req.url === "/api/delete") { const { model } = await readBody(req); const i = ollamaModels.findIndex((m) => m.name === model); if (i >= 0) ollamaModels.splice(i, 1); return json(res, {}); }
  if (req.url === "/api/pull") {
    const { model } = await readBody(req);
    const slow = !model.includes("3b");
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const total = 1_000_000;
    let done = 0, stopped = false;
    req.on("close", () => { stopped = true; });
    res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
    while (!stopped && done < total) {
      await new Promise((r) => setTimeout(r, slow ? 400 : 60));
      done = Math.min(total, done + (slow ? 20_000 : 200_000));
      res.write(JSON.stringify({ status: "downloading", total, completed: done }) + "\n");
    }
    if (stopped) return;
    ollamaModels.push({ name: model, size: total, details: { family: model.split(":")[0], parameter_size: "" } });
    res.end(JSON.stringify({ status: "success" }) + "\n");
    return;
  }
  res.writeHead(404); res.end("{}");
});

/* ---------- the window ---------- */
async function main() {
  let servers;
  try { servers = [await proxy(), await ollama()]; } catch (e) { console.error(e.message); process.exit(2); }
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try { await run(page); } catch (e) { check("script finished", false, e.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  for (const s of servers) s.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}

const live = async (page, sel) => {
  const el = page.locator(sel).first();
  await el.waitFor({ state: "visible", timeout: 10000 });
  if ((await el.getAttribute("aria-disabled")) === "true") throw new Error(`${sel} is greyed`);
  return el;
};
const click = async (page, sel) => (await live(page, sel)).click();
const toastText = async (page) => (await page.locator(".toast").first().textContent({ timeout: 5000 }).catch(() => "")) ?? "";
const settle = (page, ms = 600) => page.waitForTimeout(ms);
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await click(page, `[data-act="setpage"][data-v="${id}"]`);
  await settle(page);
}

async function setup() {
  await api("trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await api("trunks", { name: "Verify" });
  const conn = await api("connections/from-preset", { provider: "litellm", key: "stand-in-key-0001" });
  await api("accounts/settings", { mode: "on" });
  return { trunk, pool: conn.id };
}

async function run(page) {
  const { trunk, pool } = await setup();
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  await accountsWizard(page, pool, trunk);
  await accountsPage(page, pool);
  await modelsPage(page);
  await localPage(page);
  await instructionsPage(page);
  await advancedPage(page);
  await usagePage(page);
  await gatewayPage(page);
  await updatesPage(page);
}

async function accountsWizard(page, pool, trunk) {
  await openPage(page, "accounts");
  await click(page, '[data-act="addacct"]:not([data-v])');
  await page.locator(".aa-list12").waitFor();
  await click(page, '[data-act="aa-grp"][data-v="key"]');
  const keyTab = await page.locator('[data-act="aa-grp"][data-v="key"]').getAttribute("aria-selected");
  const shown = await page.locator(".aa-list12 .prov").count();
  check("aa-grp: the A key tab shows the key services", keyTab === "true" && shown > 0, `${shown} cards`);
  await page.locator("#aa-q").fill("LiteLLM");
  await settle(page, 300);
  await click(page, `[data-act="aa-prov"][data-v="${pool}"]`);
  await page.locator("#aa-key").fill("stand-in-key-0002");
  await click(page, '[data-act="aa-key"]');
  await page.locator("#aa-name").waitFor();
  const html = await page.content();
  let view = await api("accounts");
  let p = view.pools.find((x) => x.pool === pool);
  check("aa-key: the key went to the engine and is not in the window", p.accounts.length === 2 && !html.includes("stand-in-key-0002"), `${p.accounts.length} accounts`);
  const added = p.accounts[1];
  await click(page, '[data-act="aa-nm"]:has-text("Work")');
  const name = await page.locator("#aa-name").inputValue();
  check("aa-nm: the quick name fills the name field", name.endsWith("· Work"), name);
  await click(page, `[data-act="aa-tr"][data-v="${trunk.id}"]`);
  await click(page, '[data-act="aa-pos"][data-v="first"]');
  await click(page, '[data-act="aa-done"]');
  await settle(page, 1200);
  view = await api("accounts");
  p = view.pools.find((x) => x.pool === pool);
  check("aa-done/aa-nm: the name is saved", p.accounts.find((a) => a.id === added.id)?.label === name, name);
  check("aa-pos: First puts it at the top of its connection", p.accounts[0].id === added.id);
  const t = (await api(`trunks/${trunk.id}`)).trunk;
  check("aa-tr: the chosen Trunk uses it", t.keys.accounts[pool] === added.id, JSON.stringify(t.keys.accounts));

  await click(page, '[data-act="addacct"]:not([data-v])');
  const catalog = (await api("connections/catalog")).services;
  const gone = catalog.find((s) => s.terms?.standing === "retired");
  await click(page, '[data-act="aa-grp"][data-v="gone"]');
  await click(page, `[data-act="aa-gone"][data-v="${gone.id}"]`);
  const said = await toastText(page);
  check("aa-gone: says the catalogue's own words", said.trim() === String(gone.terms.warning || gone.note).trim(), said.slice(0, 60));
  await click(page, '[data-act="aa-grp"][data-v="local"]');
  await click(page, '[data-act="aa-local"]');
  await settle(page);
  check("aa-local: opens Settings › On this computer", (await page.locator(".set-col h1").textContent()) === "On this computer");
}

async function accountsPage(page, pool) {
  for (const label of ["Spare A", "Spare B"]) await api("accounts/add", { pool, label, key: `stand-in-key-${label.slice(-1)}000` });
  await openPage(page, "accounts");
  let view = await api("accounts");
  let p = view.pools.find((x) => x.pool === pool);
  const target = p.accounts.find((a) => a.label === "Spare A");
  await click(page, `[data-act="acct-menu"][data-id="${target.id}"]`);
  await click(page, `.pop [data-act="acct-first"][data-id="${target.id}"]`);
  await settle(page, 800);
  p = (await api("accounts")).pools.find((x) => x.pool === pool);
  check("acct-menu + acct-first: it answers first (pool default)", p.defaultAccount === target.id);
  await click(page, `[data-act="acct-menu"][data-id="${target.id}"]`);
  await click(page, `.pop [data-act="acct-out"][data-id="${target.id}"]`);
  await settle(page, 800);
  p = (await api("accounts")).pools.find((x) => x.pool === pool);
  check("acct-out: the account is removed", !p.accounts.some((a) => a.id === target.id));

  await click(page, '[data-act="setlevel"][data-v="advanced"]');
  await settle(page);
  await click(page, '[data-act="acsel15"]');
  const spare = p.accounts.find((a) => a.label === "Spare B");
  const last = p.accounts[p.accounts.length - 1];
  check("acsel15: ticks appear", (await page.locator(".chk15").count()) === p.accounts.length);
  await page.locator(`.chk15[data-acc15="${pool}/${spare.id}"]`).check();
  await click(page, '[data-act="acbulk15"][data-v="pause"]');
  await settle(page, 800);
  p = (await api("accounts")).pools.find((x) => x.pool === pool);
  check("acbulk15 pause: paused in the engine", p.accounts.find((a) => a.id === spare.id)?.disabled === true);
  await click(page, '[data-act="acsel15"]');
  await page.locator(`.chk15[data-acc15="${pool}/${last.id}"]`).check();
  await click(page, '[data-act="acbulk15"][data-v="top"]');
  await settle(page, 1000);
  p = (await api("accounts")).pools.find((x) => x.pool === pool);
  check("acbulk15 top: first in the engine's order", p.accounts[0].id === last.id);
  await click(page, '[data-act="acsel15"]');
  await page.locator(`.chk15[data-acc15="${pool}/${spare.id}"]`).check();
  await click(page, '[data-act="acbulk15"][data-v="remove"]');
  await settle(page, 800);
  p = (await api("accounts")).pools.find((x) => x.pool === pool);
  check("acbulk15 remove: signed out in the engine", !p.accounts.some((a) => a.id === spare.id));
  await click(page, '[data-act="acct-up"]:not([disabled])');
  await settle(page, 800);
  check("acct-up still moves (engine order changed)", JSON.stringify((await api("accounts")).pools.find((x) => x.pool === pool).accounts.map((a) => a.id)) !== JSON.stringify(p.accounts.map((a) => a.id)));
}

async function modelsPage(page) {
  await openPage(page, "models");
  const state = await api("state");
  const bodies = { connections: ".acct-g", defaults: `.set-col .ctl .seg button:has-text("${state.models.presets[0].name}")`, local: '.lp [data-act="lp-pick"]', second: "#m-second", media: "#m-img" };
  for (const [tab, sel] of Object.entries(bodies)) {
    await click(page, `[data-act="mtab"][data-v="${tab}"]`);
    await settle(page, 300);
    check(`mtab ${tab}: draws its own content`, (await page.locator(sel).count()) > 0 && (await page.locator(`[data-act="mtab"][data-v="${tab}"]`).getAttribute("aria-selected")) === "true");
  }
  /* The tab is the shared local-model picker now (flows/localpick.js); its one-click download, Cancel, connect and select
     are clicked through in verify-local-oneclick.cjs against a stand-in runtime. */
  await click(page, '[data-act="mtab"][data-v="local"]');
  const recs = (await api("local-models")).recommendations;
  const rows = await page.locator('#main .lp [data-act="lp-pick"]').count();
  check("On this computer: the picker lists the engine's recommendations", rows === recs.length, `${rows} of ${recs.length}`);
}

async function localPage(page) {
  await api("local-models/switch", { mode: "on" });
  await openPage(page, "local");
  const data = await api("local-models");
  const offer = data.oneClick.offers.find((o) => o.variants.length > 1);
  const other = offer.variants.find((v) => v.quant !== (offer.suggested ?? offer.variants[0].quant));
  await click(page, `[data-act="lm-v"][data-id="${offer.id}"][data-v="${other.quant}"]`);
  await settle(page, 300);
  const card = page.locator(".lm12", { has: page.locator(`[data-act="lm-v"][data-id="${offer.id}"]`) });
  const pill = (await card.locator(".pill").textContent()).trim();
  const install = (await card.locator('[data-act="lm-get"]').textContent()).trim();
  const tip = await card.locator(".pill").getAttribute("data-tip");
  check("lm-v: the card shows that size's fit and download from the engine", pill === other.note.split(":")[0] && tip === other.note && install.endsWith(`${(other.downloadBytes / 2 ** 30).toFixed(1)} GB`), `${pill} / ${install}`);
  const loaded = data.oneClick.loaded[0]?.name;
  const removable = data.ollama.models.find((m) => m.name !== loaded)?.name;
  await click(page, `[data-act="lm-rm"][data-id="${removable}"]`);
  await settle(page, 1000);
  check("lm-rm: Ollama no longer lists it", !(await api("local-models")).ollama.models.some((m) => m.name === removable), removable);
  await click(page, '[data-act="lm-chat"]');
  await settle(page);
  check("lm-chat: opens a conversation", (await page.locator(".settings").count()) === 0 && (await page.locator("#composer, .composer").count()) > 0);
}

async function instructionsPage(page) {
  await openPage(page, "instructions");
  for (const text of ["First version from the check.", "Second version from the check."]) {
    await click(page, '[data-act="if-open"][data-f="soul"]');
    await page.locator("#if-text").fill(text);
    await click(page, '[data-act="if-save"]');
    await settle(page, 800);
  }
  const saved = await api("settings-kit/files/soul");
  check("if-save: the engine holds the saved text", saved.text.trim() === "Second version from the check." && saved.lastSave);
  await click(page, '[data-act="if-open"][data-f="soul"]');
  await click(page, '[data-act="if-back"]');
  await settle(page, 800);
  const back = await api("settings-kit/files/soul");
  const shown = await page.locator("#if-text").inputValue();
  check("if-back: the engine put the version before back, and the editor shows it", back.text.trim() === "First version from the check." && shown.trim() === back.text.trim());
  await click(page, '.dlg [data-act="dlg-close"]');
}

async function advancedPage(page) {
  await openPage(page, "advanced");
  const [popup] = await Promise.all([page.context().waitForEvent("page"), click(page, '[data-act="adv-logs"]')]);
  await popup.waitForLoadState();
  const opened = await popup.evaluate(() => document.body.innerText);
  const logs = await (await fetch(`${BASE}/api/logs`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
  const first = logs.split("\n")[0];
  check("Open logs: a new window shows the engine's logs", first ? opened.includes(first.slice(0, 40)) : opened.trim() === "", `${logs.split("\n").length - 1} lines`);
  await popup.close();
}

async function usagePage(page) {
  await api("run", { prompt: "Say hello for the usage check." }).catch(() => null);
  await page.waitForTimeout(1500);
  await api("usage/report/settings", { mode: "on" });
  await openPage(page, "usage");
  await click(page, '[data-act="rep15"][data-v="7"]');
  await settle(page, 800);
  const data = (await api("usage?range=7d&by=day")).data;
  const cost = data.reduce((s, d) => s + d.estimatedCost, 0).toFixed(2), tasks = data.reduce((s, d) => s + d.runs, 0);
  const head = await page.locator(".rep-h15").textContent();
  check("rep15: the card adds up the engine's last 7 days", head.includes("Last 7 days") && head.includes(`$${cost}`) && head.includes(`${tasks} tasks`), head.trim().slice(0, 80));
  await click(page, '[data-act="repopen15"]');
  const report = await api("usage/report", { range: "7d", format: "markdown" });
  const pre = await page.locator(".dlg pre").textContent();
  check("repopen15: shows the engine's usage report", pre.trim() === report.body.trim(), report.body.split("\n")[0]);
  await click(page, '.dlg [data-act="dlg-close"]');
}

async function gatewayPage(page) {
  if (!DATA_DIR) { console.log("SKIP  gw-prop (needs DATA_DIR)"); return; }
  const proposal = (hold) => fs.writeFileSync(path.join(DATA_DIR, "gateway.proposed.json"), JSON.stringify({ config: { mode: "off", startSeconds: 90, holdSeconds: hold, maxQuickCrashes: 4, gapSeconds: 300, watchSeconds: 300, workerEnv: {} }, why: "Written by the verify script.", proposedAt: new Date().toISOString(), check: { ok: true, detail: "started" } }));
  proposal(31);
  await openPage(page, "gateway");
  // The gateway is one on/off switch (when-needed reads as on).
  if (!(await page.locator("#gw-mode").isChecked())) await click(page, "#gw-mode");
  await settle(page, 800);
  await click(page, '[data-act="gw-prop"][data-v="no"]');
  await settle(page, 800);
  let gw = await api("never-break");
  check("gw-prop Discard: the engine has no suggestion waiting", gw.proposal === null && gw.config.holdSeconds !== 31);
  proposal(32);
  await openPage(page, "general");
  await openPage(page, "gateway");
  await click(page, '[data-act="gw-prop"][data-v="use"]');
  await settle(page, 800);
  gw = await api("never-break");
  check("gw-prop Use it: the engine saved the suggested timing", gw.proposal === null && gw.config.holdSeconds === 32, `holdSeconds ${gw.config.holdSeconds}`);
  await api("never-break", { mode: "off" });
}

async function updatesPage(page) {
  await openPage(page, "updates");
  const before = (await api("comfort")).values.notify.autoUpdate;
  await (await live(page, "#u-auto")).click();
  await settle(page, 800);
  const after = (await api("comfort")).values.notify.autoUpdate;
  check("u-auto: the engine saved Keep Branch up to date by itself", before !== after, `${before} → ${after}`);
}

main();
