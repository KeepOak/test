/* The automations engine work, proved in the real window against a FRESH engine, each control read back through the
   engine's own GET route. Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> node design/redesign/tools/seed-automations.mjs
     BRANCH_DATA_DIR=<same> BRANCH_WORKSPACE=<same> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> DATA=<same data dir> node design/redesign/tools/verify-automations.cjs
   1. Words to a schedule (nl-add, the proposal card, Confirm): GET /api/schedules.
   2. Procedure steps as a proposal (flow-add, flow-mv, flow-rm, flow-save, Approve, Go back to this): GET /api/autonomy/procedures
      and GET /api/autonomy/ledger. A saved recipe draws Add a step greyed (no step is written there).
   3. Purge all archived facts (memarch15): GET /api/memory/archive.
   4. Roll back an accepted gateway change (self-apply, then self-undo): GET /api/never-break.
   5. The bounded diff of a change to Branch itself (selfrev15): GET /api/self-development/requests/<id>/diff. */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT || require("node:path").join(__dirname, "../../../node_modules/playwright"));
const { gselChoices, gselShown, pickGsel } = require("./gsel.cjs");

const { PORT, TOKEN, DATA } = process.env;
if (!PORT || !TOKEN || !DATA) { console.error("Set PORT, TOKEN and DATA."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const NOTE = JSON.parse(fs.readFileSync(path.join(DATA, "verify-automations.json"), "utf8"));
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await sleep(200); } }
const greyed = async (loc) => (await loc.count()) > 0 && ((await loc.first().getAttribute("aria-disabled")) === "true" || (await loc.first().isDisabled()));
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => { const b = document.createElement("button"); b.dataset.act = n; Object.assign(b.dataset, d); document.getElementById("app").appendChild(b); b.click(); b.remove(); }, [name, data]);
  await sleep(500);
}
const text = (page, sel) => page.locator(sel).first().textContent().catch(() => "");

async function schedules(page) {
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  await page.fill("#nl-in", "every weekday at 8, check my inbox for invoices");
  await page.click('[data-act="nl-add"]');
  await page.waitForSelector(".prop17d", { timeout: 8000 });
  check("nl-add: the card shows what the engine read", (await text(page, "#pp-first17d")).startsWith("Weekdays at 8:00 AM · first run") && (await page.inputValue("#pp-what17d")) === "check my inbox for invoices", await text(page, "#pp-first17d"));
  check("nl-add: a proposal saves nothing (GET /api/schedules)", (await api("schedules")).schedules.length === 0);
  await page.click('.prop17d [data-k="days"][data-v="weekly"]');
  await until(async () => (await text(page, "#pp-first17d")).startsWith("Fridays at 8:00 AM"));
  await page.click('.prop17d [data-k="day"][data-v="1"]');
  check("ppset17d: once a week on Monday is read again by the engine", await until(async () => (await text(page, "#pp-first17d")).startsWith("Mondays at 8:00 AM")), await text(page, "#pp-first17d"));
  check("Who does it is live (verify-finish-soon-a.cjs proves the routine)", (await page.locator(".prop17d .seg button.soon").count()) === 0);
  await page.click('[data-act="ppno17d"]');
  check("ppno17d: Cancel closes the card and saves nothing", (await page.locator(".prop17d").count()) === 0 && (await api("schedules")).schedules.length === 0);
  await page.fill("#nl-in", "every Sunday, find blurry and duplicate photos");
  await page.click('[data-act="nl-add"]');
  await page.waitForSelector(".prop17d", { timeout: 8000 });
  check("no time said: marked, and Confirm waits", (await text(page, ".prop17d .need17d span")).includes("it didn’t say when") && await page.locator('[data-act="ppok17d"]').isDisabled());
  await page.fill("#pp-time17d", "18:30");
  await page.dispatchEvent("#pp-time17d", "change");
  check("picking a time reads it again", await until(async () => (await text(page, "#pp-first17d")).startsWith("Sundays at 6:30 PM") && !(await page.locator('[data-act="ppok17d"]').isDisabled())), await text(page, "#pp-first17d"));
  await page.click('[data-act="ppok17d"]');
  const saved = await until(async () => (await api("schedules")).schedules[0]);
  check("ppok17d: Confirm saves the schedule (GET /api/schedules)", saved && saved.data.dailyAt === "18:30" && saved.data.weekdays?.join() === "0" && saved.data.prompt === "find blurry and duplicate photos", JSON.stringify(saved?.data ?? {}).slice(0, 160));
  await act(page, "ptab", { place: "automations", v: "triggers" });
  // Add waits (disabled) while the box is empty (B002 in verify-stress-fixes.cjs); live means it is not a greyed "soon".
  check("Triggers: Add is live (verify-finish-soon-a.cjs proves it)", (await page.locator('form.nl button[type="submit"]').first().getAttribute("aria-disabled")) !== "true");
}

async function procedures(page) {
  await act(page, "ptab", { place: "automations", v: "procedures" });
  await page.waitForSelector(`[data-act="flow"][data-v="auto"][data-id="${NOTE.procedure}"]`, { timeout: 8000 });
  await page.click(`[data-act="flow"][data-id="${NOTE.recipe}"]`);
  await page.waitForSelector(".dlg .flow-row", { timeout: 5000 });
  // finish-soon-a: a recipe's steps can be moved or taken out (verify-finish-soon-a.cjs proves the save); no step is written here.
  check("a saved recipe: Add a step is drawn greyed, and its Save is live", (await greyed(page.locator(".dlg .btn.soon", { hasText: "Add a step" }))) && !(await greyed(page.locator(".dlg .btn", { hasText: "Save" }))));
  await act(page, "dlg-close");
  await page.click(`[data-act="flow"][data-v="auto"][data-id="${NOTE.procedure}"]`);
  await page.waitForSelector(".dlg .flow-row .gsel", { timeout: 5000 });
  await page.click('.dlg [data-act="flow-add"]');
  await page.click('.dlg [data-act="flow-add"]');
  check("flow-add: two draft steps added", (await page.locator(".dlg .flow-row").count()) === 4);
  await page.click('.dlg [data-act="flow-rm"][data-j="3"]');
  check("flow-rm: a draft step taken out", (await page.locator(".dlg .flow-row").count()) === 3);
  await pickGsel(page.locator("#fk-2"), "ask");
  await page.fill("#ft-2", "Delete the duplicates it found?");
  await page.click('.dlg [data-act="flow-mv"][data-j="2"][data-d="-1"]');
  check("flow-mv: the new step moved up", (await page.inputValue("#ft-1")) === "Delete the duplicates it found?");
  await page.click('.dlg [data-act="flow-save"]');
  await page.waitForSelector(".dlg .df17d", { timeout: 5000 });
  check("flow-save: the change is shown before anything changes", (await page.locator(".dlg .df17d li.add").count()) === 1 && (await text(page, ".dlg")).includes("as version 2"));
  check("flow-save: nothing changed yet (GET /api/autonomy/procedures)", (await api("autonomy/procedures")).procedures[0].procedure.steps.length === 2);
  await page.click('.dlg [data-act="ppapprove17d"]');
  const after = await until(async () => { const p = (await api("autonomy/procedures")).procedures.find((x) => x.id === NOTE.procedure); return p?.version === 2 && p; });
  check("ppapprove17d: the same procedure, version 2, with the new steps (GET /api/autonomy/procedures)", after && after.procedure.steps.map((s) => s.prompt).join(" | ") === "List what is in Downloads | Delete the duplicates it found? | Tell me what moved" && after.procedure.steps[1].confirm === true && after.history.length === 1);
  const asked = (await api("autonomy/ledger?status=accepted")).entries.find((e) => e.payload?.procedureId === NOTE.procedure);
  check("it went through the owner's yes (GET /api/autonomy/ledger)", asked && asked.from === "owner" && asked.kind === "procedure");
  await page.click(`[data-act="flow"][data-v="auto"][data-id="${NOTE.procedure}"]`);
  await page.waitForSelector('.dlg [data-act="ppold17d"]', { timeout: 5000 });
  await page.click('.dlg [data-act="ppold17d"][data-v="1"]');
  await page.waitForSelector(".dlg .df17d", { timeout: 5000 });
  await page.click('.dlg [data-act="ppapprove17d"]');
  const back = await until(async () => { const p = (await api("autonomy/procedures")).procedures.find((x) => x.id === NOTE.procedure); return p?.version === 3 && p; });
  check("ppold17d: going back to version 1 is version 3 with its steps", back && back.procedure.steps.length === 2 && back.history.length === 2);
}

async function purge(page) {
  await act(page, "ptab", { place: "library", v: "memory" });
  await page.click('[data-act="memmore15"]');
  await page.click('.pop [data-act="memarch15"]');
  await page.waitForSelector('.dlg [data-act="memarch15"][data-v="purge"]', { timeout: 5000 });
  check("the archive shows the engine's three facts", (await page.locator('.dlg [data-act="memarch15"][data-id]').count()) === 3);
  await page.click('.dlg [data-act="memarch15"][data-v="purge"]');
  check("memarch15 Purge all: every archived fact is gone (GET /api/memory/archive)", await until(async () => (await api("memory/archive")).total === 0));
  check("Purge all is greyed once nothing is left", await until(async () => page.locator('.dlg [data-act="memarch15"][data-v="purge"]').isDisabled()));
  await act(page, "dlg-close");
}

async function rollback(page) {
  await act(page, "chat", { id: NOTE.sessionId });
  await page.waitForSelector('[data-act="self-apply"]', { timeout: 10000 });
  await page.click('[data-act="self-apply"]');
  const applied = await until(async () => { const v = await api("never-break"); return v.accepted && v.config.startSeconds === 30 && v; });
  check("self-apply: accepted (GET /api/never-break)", applied);
  await page.waitForSelector('[data-act="self-undo"]', { timeout: 8000 });
  await page.click('[data-act="self-undo"]');
  const back = await until(async () => { const v = await api("never-break"); return v.accepted?.rolledBackAt && v.config.startSeconds === 90 && v; });
  check("self-undo: rolled back to the timings before (GET /api/never-break)", back);
  check("the card says it was rolled back", await until(async () => (await page.locator(".self10 .pill", { hasText: "Rolled back" }).count()) === 1));
}

async function selfDiff(page) {
  await act(page, "ptab", { place: "inbox", v: "needs" });
  await page.waitForSelector(`[data-act="selfrev15"][data-id="${NOTE.approved}"]`, { timeout: 10000 });
  await page.click(`[data-act="selfrev15"][data-id="${NOTE.approved}"]`);
  await page.waitForSelector(".dlg .diff15", { timeout: 15000 }); // the engine reads the diff first; a busy machine takes longer
  const diff = await api(`self-development/requests/${NOTE.approved}/diff`);
  check("selfrev15: the diff is the engine's (GET /api/self-development/requests/<id>/diff)", (await text(page, ".dlg .df-h15 code")) === diff.files[0].path && (await page.locator(".dlg .diff15 .d-add", { hasText: "isOpen" }).count()) === 1);
  check("Publish the draft stays greyed", await greyed(page.locator('.dlg [data-act="selfdo15"][data-v="published"]')));
  await act(page, "dlg-close");
  await page.click(`[data-act="selfrev15"][data-id="${NOTE.waiting}"]`);
  await page.waitForSelector(".dlg .stages15", { timeout: 8000 });
  const none = await api(`self-development/requests/${NOTE.waiting}/diff`);
  check("before a yes, the engine's own sentence says nothing has changed", (await text(page, ".dlg")).includes(none.note));
  check("Approve the edits stays greyed", await greyed(page.locator('.dlg [data-act="selfdo15"][data-v="editing"]')));
  await act(page, "dlg-close");
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A draw that throws is caught and written to the console (core/dom.js), so console errors count too; a refused
  // resource before sign-in does not.
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  try {
    await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector("#main", { timeout: 15000 });
    await sleep(1200);
    for (const step of [schedules, procedures, purge, rollback, selfDiff]) {
      try { await step(page); } catch (error) { check(`${step.name} ran to the end`, false, error.message.split("\n")[0]); }
    }
    check("no page or console errors", errors.length === 0, errors.join("; "));
  } finally { await browser.close(); }
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})();
