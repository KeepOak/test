// Verifies pass 17's features whose home is a place (Inbox, Automations, Library, Customize) against a real engine:
// clicks every control this area made live and checks, through the engine's own GET routes, that the change really
// happened. Records every page error, and checks that the controls left greyed are greyed.
//
// Some features need a model (a task that hands a step over, a specialist's evaluation), so this script starts a small
// OpenAI-shaped model on this computer (MODEL_PORT, default 43393) and the engine is started pointing at it, with a fresh
// workspace this script fills (WORKSPACE):
//
//   BRANCH_DATA_DIR=<fresh folder> BRANCH_WORKSPACE=<fresh folder> BRANCH_PORT=<port> \
//   BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:43393/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify \
//   node dist/cli.js start
//   PORT=<port> TOKEN=<hex> WORKSPACE=<that workspace folder> node design/redesign/tools/verify-places17.cjs
//
// The model answers a message with "HANDOVER" in it by calling the engine's user.task tool once; a specialist's
// evaluation prompt by writing the file its check expects; anything else with "Done.".
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || "3393";
const TOKEN = process.env.TOKEN || "";
const WORKSPACE = process.env.WORKSPACE || "";
const MODEL_PORT = Number(process.env.MODEL_PORT || 43393);
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------- the model on this computer ---------- */
let asked = 0;
const toolNamed = (body, starts) => (body.tools ?? []).find((t) => String(t.function?.description ?? "").startsWith(starts))?.function?.name;
function answer(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1] ?? {};
  const text = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  if (last.role === "tool") return { content: "Done." };
  if (/HANDOVER/.test(text)) {
    const name = toolNamed(body, "Hand something to the person");
    if (name) return { tool: { name, arguments: JSON.stringify({ description: "Sign the renewal form by hand" }) } };
  }
  const write = /EVALUATE-WRITE (\S+) (\S+)/.exec(text);
  if (write) {
    fs.mkdirSync(path.dirname(path.join(WORKSPACE, write[1])), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE, write[1]), write[2]);
  }
  return { content: "Done." };
}
function reply(res, body) {
  const said = answer(body);
  const usage = { prompt_tokens: 10, completion_tokens: 5 };
  const message = said.tool
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_${asked}`, type: "function", function: said.tool }] }
    : { role: "assistant", content: said.content };
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = said.tool ? { tool_calls: [{ index: 0, id: `call_${asked}`, type: "function", function: said.tool }] } : { content: said.content };
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: said.tool ? "tool_calls" : "stop" }], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: said.tool ? "tool_calls" : "stop" }], usage }));
}
function startModel() {
  return new Promise((ready, fail) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); return; }
        if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end("{}"); return; }
        asked += 1;
        reply(res, body);
      });
    });
    server.on("error", fail);
    server.listen(MODEL_PORT, "127.0.0.1", () => ready(server));
  });
}

/* ---------- the engine ---------- */
async function call(method, route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${route}: ${r.status} ${text.slice(0, 300)}`), { body: text, status: r.status });
  try { return JSON.parse(text); } catch { return text; }
}
const get = (route) => call("GET", route);
const post = (route, body = {}) => call("POST", route, body);
const refusal = (method, route, body) => call(method, route, body).then(() => null, (e) => { try { return JSON.parse(e.body).error; } catch { return e.message; } });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function until(what, test, ms = 20000) {
  for (let t = 0; t < ms; t += 400) { const value = await test(); if (value) return value; await sleep(400); }
  throw new Error(`timed out waiting for ${what}`);
}
/* Moves between views the way the window routes a click (not for the controls under test). */
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => {
    const b = document.createElement("button");
    b.dataset.act = n;
    Object.assign(b.dataset, d);
    document.getElementById("app").appendChild(b);
    b.click();
    b.remove();
  }, [name, data]);
  await sleep(700);
}
/* The window's level (Regular, Advanced, Technical), set the way Settings sets it. */
const setLevel = (page, level) => act(page, "setlevel", { v: level });
const toastText = (page) => page.locator(".toast span").last().textContent({ timeout: 5000 }).catch(() => "");
/* Whether the window shows exactly these words in its toast within a few seconds (an earlier toast may still be up). */
const toastIs = (page, words) => until("the toast", async () => (await toastText(page)) === words, 6000).catch(() => false);
const greyed = async (page, selector) => (await page.locator(selector).count()) > 0 && (await page.locator(selector).evaluateAll((els) => els.every((e) => e.getAttribute("aria-disabled") === "true" || e.disabled)));

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#main", { timeout: 15000 });
  await sleep(1500);
}

/* ---------- engine-side setup, all through the engine's routes ---------- */
async function setup() {
  await post("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  await post("safety-extras/switch", { part: "activity-chain", mode: "on" });
  await post("commands/settings", { mode: "on" });
  for (const part of ["orders", "loops"]) await post("autonomy/switch", { part, mode: "when-needed" });
  const handed = await post("run", { prompt: "HANDOVER the signature to me" });
  if (!asked) throw new Error(`The engine did not ask the model on port ${MODEL_PORT}. Start it with BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:${MODEL_PORT}/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify, then run this again.`);
  await post("adapt/switch", { mode: "when-needed" });
  const stop = await post("adapt/stopped", { runId: handed.id, sessionId: handed.sessionId, what: "The September expense report", done: ["Read the statement"], nextStep: "Match the charges", said: "Models on this computer are switched off" });
  const order = (await post("autonomy/orders", { name: "Receipts in by the 3rd", authority: "Chase missing receipts", start: { kind: "manual" }, escalation: ["A receipt over 200"] })).order;
  await post("commands/run", { surface: "window", line: "/loop every 10m check the build", sessionId: handed.sessionId });
  const lib = await librarySetup();
  const custom = await customizeSetup();
  return { handed, stop, order, lib, custom };
}

/* ---------- Inbox ---------- */
async function inbox(page, s) {
  await act(page, "view", { v: "inbox" });
  await act(page, "ptab", { place: "inbox", v: "needs" });
  const card = `.adapt-b17 [data-act="adaptb17"][data-id="${s.stop.id}"]`;
  await page.waitForSelector(card, { timeout: 10000 });
  check("adapt card: the stop the engine has waiting (GET /api/adapt)", (await page.locator(".adapt-b17 b").first().textContent()) === s.stop.what);
  const plan = await post("adapt/plan", { stopId: s.stop.id });
  await page.click(card);
  await page.waitForSelector(".dlg .lead-b17", { timeout: 8000, state: "attached" });
  check("adaptb17 (What it needs): the engine's own sentence (POST /api/adapt/plan)", (await page.locator(".dlg .lead-b17").textContent()) === plan.message, plan.message);
  check("adaptgob17 and adaptpickb17 stay greyed (a yes installs and starts work: security review)", await greyed(page, '.dlg [data-act="adaptgob17"]') && await greyed(page, '.dlg [data-act="adaptpickb17"]'));
  await page.click('.dlg [data-act="adaptnob17"]');
  await until("the card to go", async () => (await page.locator(card).count()) === 0, 8000);
  check("adaptnob17 (Leave it stopped): no longer waiting (GET /api/adapt)", !(await get("adapt")).stops.some((x) => x.id === s.stop.id));

  const waiting = await until("the handed-over step", async () => (await get("deferred?waiting=1")).deferred[0]);
  await act(page, "ptab", { place: "inbox", v: "later" });
  const done = `.later-b17 [data-act="laterb17"][data-id="${waiting.id}"]`;
  await page.waitForSelector(done, { timeout: 8000 });
  check("Later tab: the job the task handed over, in its own words (GET /api/deferred)", (await page.locator(".later-b17 b").first().textContent()) === waiting.description.split("\n")[0]);
  check("Later tab: the count is the engine's waiting jobs", (await page.locator('[data-act="ptab"][data-v="later"] .n').textContent()) === String((await get("deferred?waiting=1")).deferred.length));
  await page.click(done);
  const settled = await until("the job settled", async () => (await get("deferred")).deferred.find((d) => d.id === waiting.id && d.settledAt));
  check("laterb17 (Done): answered (GET /api/deferred settledAt)", settled && settled.outcome === "Done.");
  await page.waitForSelector(".later-b17 .pill.done", { timeout: 8000 });

  await act(page, "ptab", { place: "inbox", v: "history" });
  await page.click('[data-act="chainb17"]');
  await page.waitForSelector(".dlg .chain-b17", { timeout: 8000 });
  const entries = (await get("safety-extras/activity?limit=50")).entries;
  const shown = await page.locator(".dlg .chain-b17 li").count();
  check("chainb17 (See the chain): one entry per link of the engine's chain (GET /api/safety-extras/activity)", shown === entries.length && shown > 0, `${shown} entries`);
  const withRun = entries.find((e) => e.runId);
  if (withRun) {
    await page.locator(`.dlg [data-act="rcptb17"][data-id="${withRun.runId}"]`).first().click();
    const receipts = await get(`runs/${withRun.runId}/receipts`);
    const bad = ["forged", "modified", "unsigned"].some((k) => (receipts.counts?.[k] ?? 0) > 0);
    await page.waitForSelector(".dlg .chain-b17 .pill", { timeout: 8000 });
    check("rcptb17 (Check this run): the run's receipts as the engine read them (GET /api/runs/{id}/receipts)", (await page.locator(".dlg .chain-b17 .pill").first().textContent()).includes(bad ? "" : "Signed · matches"));
  } else check("rcptb17: a chain entry with a run to check", false, "no entry had a runId");
  check("chaintamperb17 stays greyed (it would draw made-up entries)", await greyed(page, '.dlg [data-act="chaintamperb17"]'));
  await act(page, "dlg-close");
}

/* ---------- Automations ---------- */
async function automations(page, s) {
  await act(page, "view", { v: "automations" });
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  const pause = `[data-act="orderb17"][data-id="${s.order.id}"]`;
  await page.waitForSelector(pause, { timeout: 10000 });
  await page.click(pause);
  await until("the order paused", async () => (await get("autonomy/orders")).orders.find((o) => o.id === s.order.id).status === "paused");
  check("orderb17 (Pause): paused (GET /api/autonomy/orders)", true);
  await page.waitForSelector(`${pause}[data-v="resume"]`, { timeout: 8000 });
  await page.click(pause);
  await until("the order kept again", async () => (await get("autonomy/orders")).orders.find((o) => o.id === s.order.id).status === "active");
  check("orderb17 (Resume): kept again (GET /api/autonomy/orders)", true);
  await page.click('[data-act="ordersb17"]');
  await page.waitForSelector(".dlg #order-in-b17", { timeout: 8000 });
  check("ordersb17 (How they work): lists the engine's orders; Add it stays greyed", (await page.locator(".dlg .prow b").first().textContent()) === s.order.order.name && await greyed(page, '.dlg [data-act="orderaddb17"]'));
  await act(page, "dlg-close");
  const stopLoop = `[data-act="loopb17"][data-id="${s.handed.sessionId}"]`;
  await page.waitForSelector(stopLoop, { timeout: 8000 });
  await page.click(stopLoop);
  await until("the loop stopped", async () => ["done", undefined].includes((await get("autonomy/loops")).loops.find((l) => l.sessionId === s.handed.sessionId)?.status));
  check("loopb17 (Stop): stopped (GET /api/autonomy/loops)", true);

  await setLevel(page, "advanced");
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  await page.waitForSelector('[data-act="pauseallb17"]', { timeout: 8000 });
  const said = await refusal("POST", "dashboard/automations", { paused: true });
  await page.click('[data-act="pauseallb17"]');
  check("pauseallb17 with the dashboard off: the engine's refusal as it said it", said && await toastIs(page, said), said);
  await post("dashboard/settings", { mode: "on" }).catch(() => null);
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  await sleep(1000);
  await page.click('[data-act="pauseallb17"][data-v="pause"]');
  await until("paused", async () => (await get("dashboard")).paused);
  check("pauseallb17 (Pause all): paused (GET /api/dashboard paused)", true);
  await page.waitForSelector('[data-act="pauseallb17"][data-v="resume"]', { timeout: 8000 });
  await page.click('[data-act="pauseallb17"][data-v="resume"]');
  await until("resumed", async () => !(await get("dashboard")).paused);
  check("pauseallb17 (Resume all): resumed (GET /api/dashboard paused)", true);

  const demos = [["readiness", "autonomy/readiness", "skills"], ["holidays", "calendar", null], ["watches", "monitors", "monitors"], ["leads", "asks/leads", "top"], ["forecast", "asks/forecasts", "open"]];
  for (const [k, route, key] of demos) {
    await page.click(`[data-act="demob17"][data-k="${k}"]`);
    await page.waitForSelector(".dlg .demo-b17", { timeout: 8000, state: "attached" });
    const engine = await get(route);
    const n = key ? engine[key].length : engine.settings.daysOff.length;
    check(`demob17 ${k}: one row per engine item (GET /api/${route})`, (await page.locator(".dlg .demo-b17 .prow").count()) === n, `${n} rows`);
    await act(page, "dlg-close");
  }
  await page.click('[data-act="demob17"][data-k="readiness"]');
  await page.waitForSelector('.dlg [data-act="demodob17"]', { timeout: 8000 });
  await page.click('.dlg [data-act="demodob17"]');
  await page.waitForSelector('.dlg .lead-b17', { timeout: 8000 });
  const ledger = (await get("autonomy/ledger?status=all")).entries.length;
  check("demodob17 readiness (Open the ledger): the engine's ledger (GET /api/autonomy/ledger)", (await page.locator(".dlg .demo-b17 .prow").count()) === ledger, `${ledger} entries`);
  await act(page, "dlg-close");

  await act(page, "ptab", { place: "automations", v: "triggers" });
  for (const [k, route, key] of [["outhook", "webhooks", "webhooks"], ["hooks", "hooks", "hooks"]]) {
    await page.click(`[data-act="demob17"][data-k="${k}"]`);
    await page.waitForSelector(".dlg .demo-b17", { timeout: 8000, state: "attached" });
    check(`demob17 ${k}: one row per engine item (GET /api/${route}); its primary stays greyed`, (await page.locator(".dlg .demo-b17 .prow").count()) === (await get(route))[key].length && await greyed(page, '.dlg [data-act^="demodob17"]'));
    await act(page, "dlg-close");
  }
  await setLevel(page, "regular");
}

/* ---------- Library ---------- */
const CSV = "date,payee,category,amount\n2026-09-02,Paper Co,Supplies,412\n2026-09-05,Air,Travel,612\n2026-09-09,Cafe,Meals,48.4\n2026-09-11,Rail,Travel,100\n";
function writeWorkspace() {
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(WORKSPACE, file)), { recursive: true }); fs.writeFileSync(path.join(WORKSPACE, file), text); };
  put("money/expenses.csv", CSV);
  put("lease/lease-2025.md", "# Lease\n\n## Rent\n\nThe rent is 1420 a month.\n\n## Repairs\n\nThe tenant pays for repairs under 150.\n");
  put("lease/lease-2026.md", "# Lease\n\n## Rent\n\nThe rent is 1480 a month.\n\n## Repairs\n\nThe tenant pays for repairs under 150.\n");
  put("kb/one.md", "# Suppliers\n\nOakfield Supply quoted Brightline Paper prices. Oakfield Supply delivers to Harbour Office.\n");
  put("kb/two.md", "# Travel\n\nOakfield Supply and Harbour Office share a loading dock near Harbour Office.\n");
}
async function librarySetup() {
  if (!WORKSPACE) throw new Error("Set WORKSPACE to the engine's BRANCH_WORKSPACE folder.");
  writeWorkspace();
  const csv = await post("documents", { path: "money/expenses.csv" });
  const older = await post("documents", { path: "lease/lease-2025.md" });
  const newer = await post("documents", { path: "lease/lease-2026.md" });
  await post("labels", { target: "document", targetId: csv.id, label: "money" });
  const kb = await post("knowledge", { name: "Work", sources: [{ kind: "folder", path: "kb" }] });
  await post("knowledge/reindex", { collection: kb.id });
  await post("knowledge/map", { collection: kb.id });
  const fact = await post("action", { tool: "memory.put", args: { text: "The late fee is 100", source: "Invoice" } });
  await post("action", { tool: "memory.update", args: { id: fact.id, text: "The late fee is 120", source: "Invoice", expectedRevision: fact.revision } });
  // A fact saved by a task: each hand-run tool is its own task in its own conversation, so this one taught one fact.
  const paper = await post("action", { tool: "memory.put", args: { text: "Printer paper is bought every six weeks", source: "Supplier chat" } });
  const taught = (await get("state")).runs.find((r) => r.id === paper.data.originRunId);
  return { csv, older, newer, kb, fact, taught };
}
const rowsShown = (page) => page.locator(".dlg .demo-b17 .prow").count();

async function documentsTools(page, s) {
  const L = s.lib;
  await act(page, "view", { v: "library" });
  await act(page, "ptab", { place: "library", v: "documents" });
  await page.click('[data-act="sqlb17"]');
  await page.waitForSelector("#sql-q-b17", { timeout: 8000 });
  check("sqlb17: offers only the library's spreadsheets from workspace files (GET /api/documents)", (await page.locator('.dlg [data-act="sqlfileb17"]').count()) === 1 && (await page.locator('.dlg [data-act="sqlfileb17"]').textContent()) === L.csv.name);
  const sql = "SELECT category, SUM(amount) AS total FROM expenses GROUP BY category ORDER BY total DESC";
  await page.fill("#sql-q-b17", sql);
  await page.click('.dlg [data-act="sqlrunb17"]');
  await page.waitForSelector(".dlg .tbl-b17 tbody tr", { timeout: 8000 });
  const engine = await post("data/ask", { document: L.csv.id, sql });
  const cells = await page.locator(".dlg .tbl-b17 tbody td:first-child").allTextContents();
  check("sqlrunb17 (Run): the engine's rows (POST /api/data/ask)", JSON.stringify(cells) === JSON.stringify(engine.rows.map((r) => String(r[0]))), cells.join(", "));
  check("sqlrunb17: a chart drawn from those rows, one bar each", (await page.locator(".dlg .chart-b17 rect").count()) === engine.rows.length);
  check("sqlsaveb17 stays greyed (the report route keeps nothing)", await greyed(page, '.dlg [data-act="sqlsaveb17"]'));
  await act(page, "dlg-close");

  await page.click('[data-act="doccmpb17"]');
  await page.waitForSelector(".dlg #doc-a-b17", { timeout: 8000 });
  await page.selectOption("#doc-a-b17", L.older.id);
  await page.selectOption("#doc-b-b17", L.newer.id);
  await page.waitForSelector(".dlg .dif-b17", { timeout: 15000 });
  const compared = await post("action", { tool: "documents.compare", args: { file: "lease/lease-2025.md", against: "lease/lease-2026.md" } });
  check("doccmpb17 (Compare): one entry per change the engine found (documents.compare)", (await page.locator(".dlg .dif-b17").count()) === compared.changes.length, `${compared.changes.length} change(s)`);
  check("doccmpb17: Save the comparison stays greyed", await greyed(page, '.dlg [data-act="docsaveb17"]'));
  await page.click('.dlg [data-act="docmodeb17"][data-v="edit"]');
  check("docmodeb17 (Edit exactly): the mode changes; Make the edit stays greyed", (await page.locator(".dlg h2").textContent()) === "Edit exactly" && await greyed(page, '.dlg [data-act="docsaveb17"][data-v="edit"]'));
  await act(page, "dlg-close");

  await setLevel(page, "advanced");
  await act(page, "ptab", { place: "library", v: "documents" });
  await page.waitForSelector('[data-act="labelb17"][data-v="money"]', { timeout: 8000 });
  await page.click('[data-act="labelb17"][data-v="money"]');
  const listed = await page.locator("#main .place .prow .grow b").allTextContents();
  check("labelb17: only the documents carrying the label (GET /api/labels)", listed.includes(L.csv.name) && !listed.includes(L.older.name), listed.join(", "));
  await page.click('[data-act="labelb17"][data-v="money"]');

  await page.click('[data-act="dv15"][data-v="map"]');
  await page.waitForSelector('[data-act="kgb17"]', { timeout: 10000 });
  const names = (await post("knowledge/graph/names", { collection: L.kb.id })).names.map((n) => n.name);
  const chips = await page.locator('[data-act="kgb17"]').allTextContents();
  check("dv15 (Map) › Ask the map: the map's most-mentioned names (POST /api/knowledge/graph/names)", JSON.stringify(chips) === JSON.stringify(names), chips.join(", "));
  await page.click(`[data-act="kgb17"][data-v="${names[0]}"]`);
  await page.waitForSelector(".kgl-b17 li", { timeout: 8000 });
  const links = (await post("knowledge/graph", { collection: L.kb.id, entity: names[0] })).links;
  check("kgb17: what the documents say about it, one line per link (POST /api/knowledge/graph)", (await page.locator(".kgl-b17 li").count()) === links.length, `${links.length} link(s)`);
  await page.click('[data-act="dv15"][data-v="list"]');
}

async function managing(page) {
  for (const [k, route, key] of [["kbmanage", "knowledge", "collections"], ["sources", "asks/sources", "status"], ["pages", "asks/pages", "pages"]]) {
    await page.click(`[data-act="demob17"][data-k="${k}"]`);
    await page.waitForSelector(".dlg .demo-b17", { timeout: 8000, state: "attached" });
    check(`demob17 ${k}: one row per engine item (GET /api/${route})`, (await rowsShown(page)) === (await get(route))[key].length);
    await act(page, "dlg-close");
  }
  const off = await refusal("POST", "learn/tour", { subject: "code", of: "" });
  await page.click('[data-act="demob17"][data-k="learnfolder"]');
  check("demob17 learnfolder, switched off: the engine's refusal as it said it", off && await toastIs(page, off), off);
  await post("learn/switch", { mode: "when-needed" });
  await page.click('[data-act="demob17"][data-k="learnfolder"]');
  await page.waitForSelector(".dlg .demo-b17", { timeout: 20000, state: "attached" });
  const tour = await post("learn/tour", { subject: "code", of: "" });
  check("demob17 learnfolder: one row per stop of the engine's tour (POST /api/learn/tour)", (await rowsShown(page)) === tour.steps.length, `${tour.steps.length} stops`);
  await act(page, "dlg-close");
}

async function howItLearns(page, s) {
  const L = s.lib;
  await act(page, "ptab", { place: "library", v: "memory" });
  await page.waitForSelector('[data-act="demob17"][data-k="learnlog"]', { timeout: 8000 });
  for (const [k, route, key] of [["habits", "memory/learned", "noticed"], ["learnlog", "learning-more/journey?limit=50", "entries"]]) {
    await page.click(`[data-act="demob17"][data-k="${k}"]`);
    await page.waitForSelector(".dlg .demo-b17", { timeout: 8000, state: "attached" });
    check(`demob17 ${k}: one row per engine item (GET /api/${route})`, (await rowsShown(page)) === (await get(route))[key].length);
    await act(page, "dlg-close");
  }
  await page.click('[data-act="demob17"][data-k="factver"]');
  await page.waitForSelector('.dlg [data-act="demodob17"][data-k="factver"]', { timeout: 8000 });
  await page.click('.dlg [data-act="demodob17"][data-k="factver"]');
  const back = await until("the earlier version put back", async () => { const m = (await get("state")).memory.find((x) => x.id === L.fact.id); return m?.data?.text === "The late fee is 100" && m; });
  check("demodob17 factver (Put back the … version): the earlier words are the fact again (GET /api/state memory)", Boolean(back));

  await page.click('[data-act="demob17"][data-k="forgetconv"]');
  await page.waitForSelector(`.dlg [data-act="fconvb17"][data-v="${L.taught.sessionId}"]`, { timeout: 8000 });
  await page.click(`.dlg [data-act="fconvb17"][data-v="${L.taught.sessionId}"]`);
  const preview = await post("memory/forget/preview", { sessionId: L.taught.sessionId });
  await page.waitForSelector('.dlg [data-act="demodob17"][data-k="forgetconv"]', { timeout: 8000 });
  check("fconvb17: what that conversation taught (POST /api/memory/forget/preview)", (await rowsShown(page)) === preview.remove.length && preview.remove.length > 0, `${preview.remove.length} fact(s)`);
  await page.click('.dlg [data-act="demodob17"][data-k="forgetconv"]');
  await until("those facts forgotten", async () => !(await get("state")).memory.some((m) => preview.remove.some((r) => r.id === m.id)));
  check("demodob17 forgetconv (Forget these …): gone from memory (GET /api/state memory)", true);

  const before = (await get("memory/checkpoints")).checkpoints.length;
  await page.click('[data-act="demob17"][data-k="memckpt"]');
  await page.waitForSelector('.dlg [data-act="demodob17"][data-k="memckpt"]', { timeout: 8000 });
  check("demob17 memckpt: one row per checkpoint (GET /api/memory/checkpoints)", (await rowsShown(page)) === before);
  await page.click('.dlg [data-act="demodob17"][data-k="memckpt"]');
  await until("a checkpoint made", async () => (await get("memory/checkpoints")).checkpoints.length === before + 1);
  check("demodob17 memckpt (Make one now): a new checkpoint (GET /api/memory/checkpoints)", true);

  const file = path.join(WORKSPACE, "import.jsonl");
  const at = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify({ id: "8d0f7a52-3b41-4c8e-9a7e-2f1c5b6d7e90", data: { text: "Imported from another computer", source: "Import" }, createdAt: at, updatedAt: at, revision: 1 })}\n`);
  const chooser = page.waitForEvent("filechooser", { timeout: 8000 });
  await page.click('[data-act="demob17"][data-k="memimport"]');
  await (await chooser).setFiles(file);
  await until("the imported fact", async () => (await get("state")).memory.some((m) => m.data?.text === "Imported from another computer"));
  check("demob17 memimport (Choose a file): the file's fact is remembered (POST /api/memory/import, GET /api/state)", true);
  await setLevel(page, "regular");
}

async function library(page, s) {
  await documentsTools(page, s);
  await managing(page);
  await howItLearns(page, s);
}

/* ---------- Customize ---------- */
async function customizeSetup() {
  const spec = await post("action", { tool: "specialists.propose", args: { name: "Code reviewer", instructions: "Reviews code before it is kept.", style: "critic", permissions: ["files.read"], evaluation: { prompt: "EVALUATE-WRITE eval/ok.txt ok", checks: [{ path: "eval/ok.txt", expected: "ok" }] } } });
  await post("action", { tool: "specialists.evaluate", args: { id: spec.id } });
  await post("action", { tool: "specialists.promote", args: { id: spec.id } });
  return { spec };
}
const specNow = async (id) => (await get("state")).specialists.find((s) => s.id === id).data;

async function specialists(page, s) {
  const id = s.custom.spec.id;
  await act(page, "view", { v: "customize" });
  await act(page, "ptab", { place: "customize", v: "specialists" });
  await page.waitForSelector(`[data-act="specb17"][data-id="${id}"]`, { timeout: 8000 });
  check("specialist row: its style and version from the engine (GET /api/state specialists)", (await page.locator(".spec-b17").first().textContent()) === "critic style · version 1");
  await page.click(`[data-act="specb17"][data-id="${id}"]`);
  await page.waitForSelector('.dlg [data-act="specstyleb17"]', { timeout: 8000 });
  const styles = (await get("specialist-styles")).styles.map((x) => x.style);
  check("specb17 (Edit): the card offers the engine's own styles (GET /api/specialist-styles)", JSON.stringify(await page.locator('.dlg [data-act="specstyleb17"]').allTextContents()) === JSON.stringify(styles));
  await page.click('.dlg [data-act="specstyleb17"][data-v="researcher"]');
  const drafted = await until("a new draft version", async () => { const d = await specNow(id); return d.version === 2 && d; });
  check("specstyleb17: a new draft version in that style; the one in use is unchanged (specialists.propose, GET /api/state)", drafted.definition.style === "researcher" && drafted.activeVersion === 1);
  await page.waitForSelector('.dlg [data-act="specevalb17"]', { timeout: 8000 });
  await page.click('.dlg [data-act="specevalb17"]');
  await until("the evaluation passed", async () => (await specNow(id)).evaluationPassed, 30000);
  check("specevalb17 (Run test cases): the draft's evaluation passed (specialists.evaluate, GET /api/state)", true);
  await page.waitForSelector('.dlg [data-act="specverb17"][data-v="promote"]', { timeout: 8000 });
  await page.click('.dlg [data-act="specverb17"][data-v="promote"]');
  const promoted = await until("version 2 in use", async () => { const d = await specNow(id); return d.activeVersion === 2 && d; });
  check("specverb17 (Promote): version 2 is in use, version 1 kept for rollback (GET /api/state)", promoted.previousActive === 1);
  await page.waitForSelector('.dlg [data-act="specverb17"][data-v="back"]', { timeout: 8000 });
  await page.click('.dlg [data-act="specverb17"][data-v="back"]');
  await until("rolled back", async () => (await specNow(id)).activeVersion === 1);
  check("specverb17 (Roll back): version 1 is in use again (GET /api/state)", true);
  await page.waitForSelector('.dlg [data-act="specverb17"][data-v="promote"]', { timeout: 8000 }); // the card drawn again from the engine
  await act(page, "dlg-close");
  await setLevel(page, "advanced");
  await act(page, "ptab", { place: "customize", v: "specialists" });
  check("Other coding agents stays greyed (no route lists them; handing over starts a program)", await greyed(page, '[data-k="handoffcli"]'));
}

async function tools(page) {
  await act(page, "ptab", { place: "customize", v: "tools" });
  await act(page, "t9-kind", { v: "skills" });
  await page.waitForSelector('[data-k="curator"]', { timeout: 8000 });
  check("lint and harness stay greyed (no route)", await greyed(page, '[data-k="lint"]') && await greyed(page, '[data-k="harness"]'));
  await page.click('[data-act="demob17"][data-k="curator"]');
  await page.waitForSelector(".dlg .demo-b17", { timeout: 8000, state: "attached" });
  check("demob17 curator: one row per skill the engine counted (GET /api/learning-more/curator)", (await rowsShown(page)) === (await get("learning-more/curator")).skills.length);
  await act(page, "dlg-close");
  await act(page, "t9-kind", { v: "plugins" });
  for (const [k, key] of [["valves", "filters"], ["examples", "bundled"]]) {
    await page.click(`[data-act="demob17"][data-k="${k}"]`);
    await page.waitForSelector(".dlg .demo-b17", { timeout: 8000, state: "attached" });
    check(`demob17 ${k}: one row per engine item (GET /api/plugin-catalog/add-ons ${key})`, (await rowsShown(page)) === (await get("plugin-catalog/add-ons"))[key].length);
    await act(page, "dlg-close");
  }
  await act(page, "t9-kind", { v: "mcp" });
  await page.click('[data-act="demob17"][data-k="asmcp"]');
  await page.waitForSelector('.dlg [data-act="demodob17"][data-k="asmcp"]', { timeout: 8000 });
  check("demob17 asmcp: the tools Branch shares, and its address (GET /api/mcp/settings)", (await rowsShown(page)) === (await get("mcp/settings")).exposedTools.length + 1);
  await page.click('.dlg [data-act="demodob17"][data-k="asmcp"]');
  check("demodob17 asmcp (Copy the address): the address is on the clipboard", (await page.evaluate(() => navigator.clipboard.readText())) === `${BASE}/mcp`);
  await act(page, "dlg-close");
  await page.click('[data-act="demob17"][data-k="oaiapi"]');
  await page.waitForSelector('.dlg [data-act="demodob17"][data-k="oaiapi"]', { timeout: 8000 });
  const models = await (await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  check("demob17 oaiapi: the address and one row per model (GET /v1/models)", (await rowsShown(page)) === models.data.length + 1);
  await page.click('.dlg [data-act="demodob17"][data-k="oaiapi"]');
  check("demodob17 oaiapi (Copy the address): the address is on the clipboard", (await page.evaluate(() => navigator.clipboard.readText())) === `${BASE}/v1`);
  await act(page, "dlg-close");
  const off = await (await fetch(`${BASE}/.well-known/agent.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  await page.click('[data-act="demob17"][data-k="a2acard"]');
  const shownRefusal = await toastIs(page, off.error);
  check("demob17 a2acard, sharing off: the engine's refusal as it said it", shownRefusal, off.error);
  await setLevel(page, "regular");
}

async function customize(page, s) {
  await specialists(page, s);
  await tools(page);
}

const STEPS = [inbox, automations, library, customize];

async function run() {
  const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
  const model = await startModel();
  const s = await setup();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    for (const step of STEPS) {
      await page.keyboard.press("Escape").catch(() => null);
      try { await step(page, s); } catch (error) { check(`step ${step.name} ran`, false, error.message.split("\n").slice(0, 4).join(" ")); }
    }
  } finally {
    check("zero page errors", errors.length === 0, errors.join(" | "));
    await browser.close();
    model.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
