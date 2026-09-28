/* "What can Branch do", proved in the real window against a fresh engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> [SHOTS=<dir>] node design/redesign/tools/verify-what-can-branch-do.cjs
   The gallery opens from Overview, the Guide menu and an empty conversation; each tab lists exactly what the engine's
   GET routes return (count and names); a skill is listed only while it is switched on, in the words of the version that
   is on; Try it opens a new conversation with the request in the box, not sent (no conversation or task is made until
   Send); an answer that comes back once another dialog is open is not drawn over it. Screenshots at 1440 and 390 wide,
   light and dark, go to SHOTS. Page errors and console errors: zero. */
const path = require("node:path");
const { chromium } = require(path.join(__dirname, "../../../node_modules/playwright"));

const { PORT, TOKEN, SHOTS } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
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
/* Two of the skills that ship with Branch, installed through the engine (an install is off until switched on): the first
   switched on and then given a newer draft that is not on, the second left off. Answers what the first says while on. */
async function skills() {
  const [first, second] = (await api("skills/browser")).skills;
  const on = (await api("skills/browser", { name: first.name })).skill;
  await api(`skills/${on.id}/activate`, { version: on.headVersion, expectedRevision: on.revision, acknowledge: true });
  const view = await api(`skills/${on.id}`);
  const draft = view.document.replace(/^description:.*$/m, "description: A newer draft of this skill that is not switched on.");
  await api(`skills/${on.id}/update`, { document: draft, expectedRevision: view.revision });
  await api("skills/browser", { name: second.name });
  return { on: view.versions.find((v) => v.version === on.headVersion), off: second.name };
}

async function expected() {
  const [tools, state, apps, prompts, flows] = await Promise.all(["tools", "state", "channel-setup", "prompts", "flows"].map((p) => api(p)));
  const saved = new Set(prompts.prompts.map((p) => p.command));
  return {
    tools: uniq(tools.tools.filter((x) => oneLine(x.description)).map((x) => x.name)),
    skills: uniq(state.skills.filter((x) => x.activeVersion !== null).map((x) => x.activeName)),
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

async function entries(page, want, skill) {
  for (const tab of ["tools", "skills", "apps", "prompts"]) {
    const names = await listed(page, tab);
    check(`${tab}: the gallery lists exactly what the engine returns`, same(names, want[tab]), `${names.length} listed, ${want[tab].length} from the engine`);
  }
  const tool = want.raw.tools.tools.find((x) => x.name === want.tools[0]);
  await page.click('.dlg [data-act="whatcan-tab"][data-v="tools"]');
  const line = await page.locator(`.dlg .wc-card:has(button[data-v="${tool.name}"]) small`).textContent();
  check("a tool's line is the engine's own description, first sentence", line === oneLine(tool.description), line);
  const skills = await listed(page, "skills");
  check("skills: only the one switched on, not the one left off", same(skills, [skill.on.name]) && !skills.includes(skill.off), skills.join(", "));
  const said = await page.locator(`.dlg .wc-card:has(button[data-v="${skill.on.name}"]) small`).textContent();
  check("…in the words of the version that is on, not its newer draft", said === oneLine(skill.on.description), said);
}

/* An answer that comes back once another dialog is open is not drawn over it (the gallery's reads held meanwhile). */
async function staleOpen(page) {
  await act(page, "dlg-close");
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/api/flows", async (route) => { await held; await route.continue(); });
  await act(page, "whatcan");
  await act(page, "whatsnew13");
  await until(async () => (await page.locator(".dlg .new13").count()) === 1);
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/flows"));
  release();
  await answered;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
  check("an answer that comes back once another dialog is open is not drawn over it", (await page.locator(".dlg .new13").count()) === 1 && (await gallery(page).count()) === 0);
  await page.unroute("**/api/flows");
  await act(page, "dlg-close");
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
  const fields = [...new Set([...example.body.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g)].map((m) => m[1]))].filter((name) => name !== "today");
  for (const name of fields) await page.fill(`#wc-field-${name}`, `Sample ${name}`);
  if (fields.length) await page.click('[data-act="whatcan-prepare"]');
  const prepared = example.body.replace(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g, (_, name) => name === "today" ? new Date().toLocaleDateString("en-CA") : `Sample ${name}`).trim();
  check("Try it (a starter prompt): the filled draft is in a new conversation", await until(async () => (await gallery(page).count()) === 0 && (await page.inputValue("#prompt")) === prepared));
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
    const skill = await skills();
    const want = await expected();
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector("#main", { timeout: 15000 });
    signedIn = true;
    await sleep(1500);
    await opensFrom(page);
    await entries(page, want, skill);
    await tryIt(page, want);
    await staleOpen(page);
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
