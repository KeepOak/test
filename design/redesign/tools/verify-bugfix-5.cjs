/* Bugfix 5 (PR #336): proves each fix in the real window against a FRESH engine, reading every change back through the
   engine's own GET route. Page errors must be zero. Headless; no window opens on the desktop.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-5.cjs
   The engine runs its offline demo model (every task asks to write branch-demo.txt), so with "ask before changes" each
   task stops on a real question. Test data it makes through the engine: the policy preset, the saved-prompts switch, one
   Trunk and the Trunks switches, one installed skill whose test run starts a real helper, and last, two household
   people with a role each (made last so the profile list cannot change what the other checks read). */
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

async function signIn(context) {
  await api("onboarding", { done: true });
  const page = await context.newPage();
  const errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.url().includes("/api/")) asked.push({ method: r.method(), path: new URL(r.url()).pathname + new URL(r.url()).search }); });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#app #side").waitFor();
  await settle(page, 1500);
  return { page, errors, asked };
}
async function reload(page) { await page.reload(); await page.locator("#app #side").waitFor(); await settle(page, 1500); }
async function place(page, view, tab) {
  await page.locator(`#side [data-act="view"][data-v="${view}"]`).first().click();
  if (tab) await page.locator(`#main .place [data-act="ptab"][data-v="${tab}"]`).first().click();
  await settle(page, 900);
}
async function newConversation(page) {
  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator('.pop [data-act="newconv"]').click();
  await page.locator("#prompt").waitFor();
}
async function openSettings(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1200);
}

/* 1 (#321 prompt-library-ui :47): the "/" menu reads the list once when it opens, and again after a prompt is saved. */
async function slashMenu(page, asked) {
  await api("prompts/settings", { mode: "on" });
  await newConversation(page);
  await page.locator("#prompt").pressSequentially("/wee");
  await settle(page, 800);
  check("1 before saving, /weekly is not offered", (await page.locator('.slash6 b', { hasText: "/weekly" }).count()) === 0);
  await page.locator("#prompt").fill("");
  await page.locator("#prompt").dispatchEvent("input");
  await place(page, "automations", "procedures");
  await page.locator('#main [data-act="prompt-new"]').click();
  const dlg = page.locator(".dlg");
  await dlg.getByLabel("Name", { exact: true }).fill("Weekly review");
  await dlg.getByLabel("Command", { exact: true }).fill("weekly");
  await dlg.getByLabel("What to ask", { exact: true }).fill("Review the week since {{day}}.");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await dlg.waitFor({ state: "detached" });
  const saved = await until(async () => ((await api("prompts")).prompts ?? []).find((p) => p.command === "weekly"));
  check("1 GET /api/prompts has the saved prompt weekly", Boolean(saved));
  await newConversation(page);
  const from = asked.length;
  await page.locator("#prompt").pressSequentially("/wee", { delay: 120 });
  const shown = await page.locator(".slash6 b", { hasText: "/weekly" }).waitFor({ timeout: 8000 }).then(() => true, () => false);
  check("1 after saving, typing /wee offers /weekly", shown);
  const reads = asked.slice(from).filter((r) => r.method === "GET" && r.path.startsWith("/api/commands")).length;
  check("1 four keys typed read GET /api/commands once, when the menu opened", reads === 1, `${reads} reads`);
  await page.locator("#prompt").pressSequentially("k", { delay: 120 });
  await settle(page, 500);
  const more = asked.slice(from).filter((r) => r.method === "GET" && r.path.startsWith("/api/commands")).length;
  check("1 a fifth key does not read it again", more === 1, `${more} reads`);
  await page.locator("#prompt").fill("");
  await page.locator("#prompt").dispatchEvent("input");
}

/* 2 (#321 p2-rooms-ui :82): with choosing off, Who answers offers only Branch; switched on, the Trunk is offered. */
async function whoAnswers(page) {
  await api("trunks/switch", { part: "trunks", mode: "on" });
  const scout = (await api("trunks", { name: "Scout", title: "Finds things" })).trunk;
  const modes = (await api("trunks")).modes ?? {};
  check("2 GET /api/trunks: Trunks on, conversations off", modes.trunks !== "off" && modes.conversations === "off", JSON.stringify(modes));
  await reload(page);
  await newConversation(page);
  await page.locator("#prompt").fill("hello");
  await page.locator("#prompt").press("Enter");
  const sid = await page.waitForFunction(() => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id, null, { timeout: 20000 }).then((h) => h.jsonValue());
  await settle(page, 2500);
  const rows = async () => {
    await page.locator('[data-act="plusmenu"]').click();
    const pop = page.locator(".pop");
    await pop.waitFor();
    await settle(page, 300);
    const out = { branch: await pop.locator('[data-act="who"][data-v=""]').count(), trunks: await pop.locator('[data-act="who"][data-v]:not([data-v=""])').count() };
    await page.keyboard.press("Escape");
    return out;
  };
  const off = await rows();
  check("2 choosing off: Branch is offered and no Trunk", off.branch === 1 && off.trunks === 0, JSON.stringify(off));
  await api("trunks/switch", { part: "conversations", mode: "on" });
  check("2 GET /api/trunks: conversations on", (await api("trunks")).modes?.conversations !== "off");
  await reload(page);
  await page.locator(`#side .list [data-act="chat"][data-id="${sid}"]`).click();
  await settle(page, 1500);
  const on = await rows();
  check("2 control, choosing on: the Trunk is offered", on.trunks >= 1 && (await api("trunks")).trunks.some((t) => t.id === scout.id), JSON.stringify(on));
  await api("trunks/switch", { part: "conversations", mode: "off" });
}

/* 3 (#321 task-states Q51 :137): a task waiting for an answer is listed in the running popover with its question. */
async function waitingTask(page) {
  const run = await api("run", { prompt: "Tidy the folder" });
  check("3 POST /api/run: the demo task stopped to ask", run.status === "needs_input", run.status);
  const item = await until(async () => (await api("activity?waiting=1")).find((a) => a.runId === run.id && a.task?.state === "waiting-owner"));
  const reason = item?.task?.reason ?? "";
  check("3 GET /api/activity?waiting=1 lists it as waiting-owner with its question", Boolean(item && reason), reason);
  await reload(page);
  await page.locator('[data-act="tasks10"]').click();
  const pop = page.locator(".pop");
  await pop.waitFor();
  // Every demo task asks the same question, so the row is the one named by this task's conversation.
  const row = pop.locator('.mi[role="menuitem"]').filter({ hasText: reason }).filter({ hasText: "Tidy the folder" });
  const listed = await row.count();
  check("3 the running popover lists the waiting task with that question", listed === 1, (await pop.innerText()).replace(/\s+/g, " ").slice(0, 300));
  check("3 with a clock, not a spinner", listed === 1 && (await row.locator(".spin").count()) === 0);
  await page.keyboard.press("Escape");
  return run;
}

/* 4 (FEATURES17C §4): a helper's question changes neither the Inbox's count, its list, nor the rail badge; it is answered
   in the parent's Activity › Helpers. A real helper: a skill's test run delegates each example to a task of its own. */
async function helpers(page) {
  const skill = await api("skills/install", { document: "---\nname: demo-check\ndescription: Checks the demo file.\n---\nWrite the demo file, then check it.\n" });
  const report = await api(`skills/${skill.id}/test`, { examples: ["Write the demo file"] });
  const child = report.results?.[0]?.runId;
  const policy = await api("policy");
  const helperAsks = policy.waiting.filter((q) => q.parentRunId), ownAsks = policy.waiting.filter((q) => !q.parentRunId);
  check("4 GET /api/policy: the helper's question names its parent task", helperAsks.length === 1 && helperAsks[0].runId === child && helperAsks[0].parentRunId === report.parentRunId, `${policy.waiting.length} waiting`);
  const state = await api("state");
  const attention = state.attention.filter((a) => !a.parentRunId).length;
  check("4 GET /api/state: the helper's waiting task is marked in attention", state.attention.some((a) => a.runId === child && a.parentRunId === report.parentRunId));
  await reload(page);
  await place(page, "inbox", "needs");
  await settle(page, 1500);
  const count = Number(await page.locator('#main [data-act="ptab"][data-v="needs"] .n').textContent());
  const expected = ownAsks.length + (state.trunkWaiting?.length ?? 0);
  check("4 Inbox › Needs you counts only the owner's own questions", count === expected, `shows ${count}, engine has ${ownAsks.length} own + ${helperAsks.length} helper`);
  const helperRow = await page.locator(`#main [data-act="ask"][data-sid="${helperAsks[0]?.sessionId}"]`).count();
  const ownRows = await page.locator('#main [data-act="ask"][data-v="allow"]').count();
  check("4 the Inbox list has no row for the helper's question, and one for each of the owner's", helperRow === 0 && ownRows === ownAsks.length, `helper rows ${helperRow}, own rows ${ownRows}`);
  const badge = Number(await page.locator('#side [data-act="view"][data-v="inbox"] .cnt').textContent().catch(() => "0"));
  check("4 the rail badge leaves the helper's task out", badge === attention + (state.trunkWaiting?.length ?? 0), `badge ${badge}, attention ${state.attention.length} with 1 helper`);
  // Answered where it belongs: the parent's conversation, Activity › Helpers, Allow once.
  const parent = state.runs.find((r) => r.id === report.parentRunId);
  await page.locator(`#side .list [data-act="chat"][data-id="${parent.sessionId}"]`).click();
  await page.locator('[data-act="hpopen17c"]').first().click({ timeout: 15000 });
  const allow = page.locator(`[data-act="hpdo17c"][data-v="allow"][data-sid="${helperAsks[0].sessionId}"]`);
  await allow.waitFor({ timeout: 15000 });
  await allow.click();
  const settled = await until(async () => { const r = (await api("state")).runs.find((x) => x.id === child); return r?.status === "completed" ? r : null; });
  check("4 Activity › Helpers still answers it: the helper is settled (GET /api/state)", Boolean(settled));
  check("4 and its question is gone (GET /api/policy)", !(await api("policy")).waiting.some((q) => q.runId === child));
}

/* 5 (#321 people): a person's card lists Trunks, and the allowance as the prototype writes it. */
async function peopleCard(page) {
  const sam = await api("profiles", { name: "Sam", pin: "1234" });
  await api(`profiles/${sam.id}/role`, { role: "adult", categories: ["read", "files"], projects: [], dailySpendLimit: 2.5 });
  const jo = await api("profiles", { name: "Jo", pin: "4321" });
  await api(`profiles/${jo.id}/role`, { role: "adult", categories: ["read"], projects: [], dailySpendLimit: 5 });
  const roles = await api("profiles");
  check("5 GET /api/profiles has both people", ["Sam", "Jo"].every((n) => roles.profiles.some((p) => p.name === n)));
  await reload(page);
  await openSettings(page, "people");
  const facts = async (id) => {
    await page.locator(`[data-act="p-sel"][data-v="${id}"]`).click();
    await settle(page, 500);
    return page.locator(".pcard10 dl.kv").evaluate((dl) => [...dl.querySelectorAll("dt")].map((dt) => `${dt.textContent}=${dt.nextElementSibling?.textContent}`));
  };
  const samFacts = await facts(sam.id), joFacts = await facts(jo.id);
  check("5 Sam's card: Trunks row and $2.50 a day", samFacts.includes("Trunks=—") && samFacts.includes("Daily allowance=$2.50 a day"), samFacts.join(", "));
  check("5 Jo's card: $5 a day, as the prototype writes whole dollars", joFacts.includes("Daily allowance=$5 a day"), joFacts.join(", "));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const { page, errors, asked } = await signIn(context);
  try {
    await slashMenu(page, asked);
    await whoAnswers(page);
    await api("policy", { preset: "ask-before-changes" });
    await waitingTask(page);
    await helpers(page);
    await peopleCard(page);
  } catch (error) { check(`ran to the end (${error.message.split("\n")[0]})`, false); }
  check("zero page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
