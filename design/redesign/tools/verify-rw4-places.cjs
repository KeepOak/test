// Verifies the 1:1 fill of places and Customize (round 4) against a real engine: seeds real data through the engine's own
// routes so every row the prototype draws has something to show, clicks every control this round made live, and checks
// through the engine's GET routes that the change really happened. Records every page error.
//
// A task that waits for your yes needs a model that asks for a tool, so this script runs a small OpenAI-shaped model on
// this computer (MODEL_PORT, default 43363) while it works. The Tools tab needs a real tool server, so the engine is
// started with a launch file naming the repo's own test server (tests/fixtures/mcp-server.mjs). Three steps, on FRESH folders:
//   launch.json: {"mcp":[{"id":"fixture","transport":"stdio","command":"<node>","args":["<repo>/tests/fixtures/mcp-server.mjs"],"tools":["echo"],"expectedVersion":"1.0.0"}]}
//   start:  BRANCH_DATA_DIR=<data> BRANCH_WORKSPACE=<ws> BRANCH_PORT=<port> BRANCH_INTEGRATIONS=launch.json \
//           BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:43363/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify node dist/cli.js start
//   1. engine running:  PORT=<port> TOKEN=<hex> DATA=<data> node design/redesign/tools/verify-rw4-places.cjs prepare
//   2. engine stopped:  node design/redesign/tools/verify-rw4-places.cjs seed <data>
//   3. engine running again (same command):  PORT=<port> TOKEN=<new hex> DATA=<data> node design/redesign/tools/verify-rw4-places.cjs
// Step 1 makes tasks, a Trunk, a specialist, facts, a board card, a saved prompt, a procedure, a check-in list, a job with
// a check script, a document, a kept file and a request for a tool server. Step 2 edits only what no route can make: two
// finished tasks marked "interrupted" (what the engine does at start to a task running when it closed), one
// "needs_input", and one request to change Branch as a chat app's /improve files it. Step 3 asks for two approvals (they
// live in memory, so after the restart), then clicks. `node ... seedlive` does step 3's seeding only (for oneone.cjs).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createHash, randomUUID } = require("node:crypto");

const PORT = process.env.PORT || "3363";
const TOKEN = process.env.TOKEN || "";
const MODEL_PORT = Number(process.env.MODEL_PORT || 43363);
const BASE = `http://127.0.0.1:${PORT}`;
const NOTE = path.join(process.env.DATA || process.argv[3] || ".", "verify-rw4-places.json");
const ASK = "Write the file that needs your yes";
const wire = (name) => "branch_" + createHash("sha256").update(name).digest("hex").slice(0, 24);

/* ---------- the model on this computer: asked to write the file, it calls files.write once; otherwise "Done." ---------- */
function answer(body) {
  const msgs = body.messages ?? [];
  const user = [...msgs].reverse().find((m) => m.role === "user");
  const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
  const answered = msgs.some((m) => m.role === "tool");
  if (text.includes(ASK) && !answered) {
    const name = `approve-${randomUUID().slice(0, 8)}.txt`;
    return { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: wire("files.write"), arguments: JSON.stringify({ path: name, content: "yes" }) } }] };
  }
  return { role: "assistant", content: "Done." };
}
function startModel() {
  return new Promise((ready, fail) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "verify", object: "model" }] })); return; }
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); return; }
        const message = answer(body);
        const finish = message.tool_calls ? "tool_calls" : "stop";
        const usage = { prompt_tokens: 10, completion_tokens: 5 };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const delta = message.tool_calls ? { tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) } : { content: message.content };
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage }));
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
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const get = (route) => call("GET", route);
const post = (route, body = {}) => call("POST", route, body);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, ms = 20000) {
  for (let t = 0; t < ms; t += 400) { const value = await test(); if (value) return value; await sleep(400); }
  throw new Error(`timed out waiting for ${what}`);
}

/* Step 1: everything a route can make. */
async function prepare() {
  await post("onboarding", { done: true });
  // A server opened at start is not kept by the connection manager; on demand it is, so after the restart it is listed.
  await post("mcp/connections", { keepWarmMinutes: 5, maxConcurrentServers: 4, reconnectAttempts: 3, connect: "on-demand" });
  await post("trunks/switch", { part: "trunks", mode: "on" });
  const trunk = (await post("trunks", { name: "Verifier", title: "Checks the round", description: "Checks the round" })).trunk;
  await post("action", { tool: "specialists.propose", args: { name: "Proofreader", instructions: "Reads anything before it is sent.", permissions: [], evaluation: { prompt: "Read notes.md", checks: [{ path: "notes.md", expected: "ok" }] } } });
  const cut = [];
  for (const prompt of ["First task Branch will be closed on", "Second task Branch will be closed on"]) cut.push((await post("run", { prompt })).id);
  const waiting = (await post("run", { prompt: "A task that stops to ask you" })).id;
  await post("documents", { name: "notes.md", text: "# Notes\nThe archive folder is Downloads/Archive." });
  const jsonl = [
    { id: "fact-dup-a", data: { text: "The archive folder is Downloads/Archive" } },
    { id: "fact-dup-b", data: { text: "The archive folder is in Downloads/Archive" } },
  ].map((l) => JSON.stringify(l)).join("\n");
  await post("memory/import", { jsonl });
  await post("action", { tool: "memory.put", args: { text: "Prefers tea in the afternoon", source: "verify" } });
  await post("flows-boards/switch", { part: "kanban", mode: "on" });
  await post("flows-boards/board/cards", { title: "Renew the car insurance", notes: "Before it runs out" });
  await post("flows-boards/switch", { part: "install-requests", mode: "on" });
  await post("action", { tool: "install.request", args: { kind: "mcp", name: "notes", server: { transport: "stdio", command: process.execPath, args: ["notes.mjs"] }, why: "Read the notes folder" } });
  await post("prompts/settings", { mode: "on" });
  await post("prompts", { title: "Weekly review", body: "Tell me what got done this week.", group: "Planning", command: "weekly" });
  await post("action", { tool: "procedures.propose", args: { name: "Find last month's invoices", preconditions: [], steps: [{ tool: "files.list", args: { path: "." }, expected: {} }] } });
  await post("delight/settings", { achievements: { on: true } });
  await post("heartbeat/switches", { checkIn: "on", scriptGates: "on" });
  const hb = (await get("heartbeat")).heartbeat.settings;
  await post("heartbeat", { ...hb, checklist: "A reply from the landlord\nAny Trunk stuck for more than 10 minutes" });
  await post("schedules", { prompt: "Month-end close", kind: "task", dueAt: new Date(Date.now() + 86400000).toISOString(), gate: { executable: process.execPath, args: ["-e", "0"] } });
  // Last, so the newest finished task has an earlier one of the same words to compare with.
  const tidy = await post("run", { prompt: "Tidy the notes folder" });
  await post("run", { prompt: "Tidy the notes folder" });
  await post("artifacts/save", { runId: tidy.id, name: "summary.txt", mediaType: "text/plain", code: "Tidied." });
  fs.writeFileSync(NOTE, JSON.stringify({ trunk: trunk.id, cut, waiting, tidy: tidy.id }, null, 2));
  console.log("prepared:", NOTE);
}

/* Step 2, engine stopped: Branch "closed" on two tasks, one stopped to ask, and one request from a chat app. */
function seed(dir) {
  const { DatabaseSync } = require("node:sqlite");
  const note = JSON.parse(fs.readFileSync(path.join(dir, "verify-rw4-places.json"), "utf8"));
  const db = new DatabaseSync(path.join(dir, "branch.sqlite"));
  for (const id of note.cut) db.prepare("UPDATE tasks SET status='interrupted' WHERE id=?").run(id);
  db.prepare("UPDATE tasks SET status='needs_input' WHERE id=?").run(note.waiting);
  const owner = String(db.prepare("SELECT owner FROM tasks LIMIT 1").get().owner);
  note.request = { id: randomUUID(), text: "Skip files that are open when tidying Downloads" };
  db.prepare("INSERT INTO self_development_requests(id, owner, text, sender, status, created_at, answer) VALUES(?,?,?,?,?,?,NULL)")
    .run(note.request.id, owner, note.request.text, JSON.stringify({ channel: "telegram", chatId: "1", senderId: "1", senderName: "Verifier", messageId: "1" }), "waiting", new Date().toISOString());
  db.close();
  fs.writeFileSync(path.join(dir, "verify-rw4-places.json"), JSON.stringify(note, null, 2));
  console.log("seeded:", dir);
}

/* Step 3's seeding: two tasks waiting for your yes (approvals are kept in memory, so they are made after the restart). */
async function seedLive() {
  await post("policy", { preset: "ask-before-changes" });
  const before = (await get("policy")).waiting.length;
  for (let i = before; i < 2; i++) {
    post("run", { prompt: `${ASK} ${i + 1}` }).catch((error) => console.log("run:", error.message));
    await until("a task waiting for a yes", async () => (await get("policy")).waiting.length > i);
  }
  console.log("waiting for a yes:", (await get("policy")).waiting.length);
  // Two requests for a tool server, one to decline and one to allow (the first was made in step 1).
  const installs = (await get("flows-boards/installs")).requests.filter((r) => r.status === "waiting");
  for (let i = installs.length; i < 2; i++)
    await post("action", { tool: "install.request", args: { kind: "mcp", name: `notes-${i + 1}`, server: { transport: "stdio", command: process.execPath, args: ["notes.mjs"] }, why: "Read the notes folder" } });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* Clicks a data-act the way the window routes every click, for moving between views (not for the controls under test). */
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => {
    const b = document.createElement("button");
    b.dataset.act = n;
    Object.assign(b.dataset, d);
    document.getElementById("app").appendChild(b);
    b.click();
    b.remove();
  }, [name, data]);
  await sleep(900);
}
const greyed = (page, selector) => page.locator(selector).first().evaluate((el) => el.classList.contains("soon") || el.getAttribute("aria-disabled") === "true" || el.disabled).catch(() => false);

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#main", { timeout: 15000 });
  await sleep(1500);
}

/* Customize: a new Trunk (POST /api/trunks, seen in GET /api/trunks); the specialists and patterns; the server's detail. */
async function customize(page) {
  const before = (await get("trunks")).trunks.length;
  await act(page, "view", { v: "customize" });
  await act(page, "ptab", { place: "customize", v: "trunks" });
  await page.click('#main [data-act="chat"][data-id="new"]');
  const made = await until("the new Trunk", async () => { const t = (await get("trunks")).trunks; return t.length > before && t; }, 10000).catch(() => null);
  check("chat/new-trunk: A new Trunk made a Trunk (GET /api/trunks)", made && made.some((t) => t.name === `Trunk ${before + 1}`), made ? made.map((t) => t.name).join(", ") : "none");
  check("new-trunk: its own conversation opened", await until("the chat view", async () => (await page.evaluate(() => !!document.querySelector("#composer"))), 8000).catch(() => false));

  await act(page, "view", { v: "customize" });
  await act(page, "ptab", { place: "customize", v: "specialists" });
  const spec = (await get("state")).specialists[0]?.data?.definition?.name;
  check("specialists: the engine's specialist is listed by name (GET /api/state)", spec && (await page.locator("#main .prow b", { hasText: spec }).count()) === 1, spec);
  check("pat15: six patterns drawn, none checked, greyed", (await page.locator('#main [data-act="pat15"]').count()) === 6 && (await page.locator('#main [data-act="pat15"][aria-checked="true"]').count()) === 0 && await greyed(page, '#main [data-act="pat15"]'));

  await act(page, "ptab", { place: "customize", v: "tools" });
  await act(page, "t9-kind", { v: "mcp" });
  await page.waitForSelector('#main .t9-item[data-v="fixture"]', { timeout: 8000 }).catch(() => {});
  const tools = (await get("state")).tools.filter((t) => t.name.startsWith("mcp.fixture."));
  const rows = await page.locator("#main .t9-perm code").allTextContents();
  check("tools: What each tool may do lists the server's tools (GET /api/state tools)", tools.length > 0 && tools.every((t) => rows.includes(t.description)), rows.join(", "));
  check("tools: the choices, Test it and Check for updates are greyed", await greyed(page, '#main .t9-perm [data-act="seg"]') && await greyed(page, '#main [data-act="tool-test"]') && await greyed(page, '#main [data-act="tool-upd"]'));
  // finish-soon-a: a launch-file server is written in the owner's own launch file, so no Remove is drawn for it.
  check("tools: a launch-file server draws no Remove", (await page.locator('#main [data-act="tool-rm"][data-k="mcp"]').count()) === 0);
}

/* Inbox: a request for a tool server declined and allowed (GET /api/flows-boards/installs); two tasks compared from their
   inspect records (GET /api/runs/<id>/inspect). */
async function inbox(page) {
  await act(page, "view", { v: "inbox" });
  await act(page, "ptab", { place: "inbox", v: "needs" });
  await page.waitForSelector('#main [data-act="xdo-no"]', { timeout: 8000 }).catch(() => {});
  // unhold-approvals: Allow all is live and counts only what it may answer (questions and Trunk messages, never the
  // install requests, whose own Allow stays greyed); with fewer than two of those it is not drawn.
  const allowable = ((await get("policy")).waiting ?? []).filter((q) => !q.parentRunId).length + ((await get("state")).trunkWaiting ?? []).length;
  const allowAll = page.locator('#main [data-act="allowall"]');
  check("allowall: drawn only for two or more it may answer, live, with that count",
    allowable > 1 ? !(await greyed(page, '#main [data-act="allowall"]')) && (await allowAll.innerText()).includes(String(allowable)) : (await allowAll.count()) === 0, `${allowable}`);
  const [first, second] = (await get("flows-boards/installs")).requests.filter((r) => r.status === "waiting");
  await page.click(`#main [data-act="xdo-no"][data-id="${first.id}"][data-v="denied"]`);
  const declined = await until("the decline", async () => (await get("flows-boards/installs")).requests.find((r) => r.id === first.id && r.status !== "waiting"), 8000).catch(() => null);
  check("xdo-no Don’t: the request is declined (GET /api/flows-boards/installs)", declined?.status === "declined", declined?.status);
  // Allow stays greyed for the security review: drawn, not clickable, and the request keeps waiting.
  check("xdo Allow: drawn and greyed (security review)", await greyed(page, `#main [data-act="xdo"][data-id="${second.id}"][data-v="allowed"]`));
  const still = (await get("flows-boards/installs")).requests.find((r) => r.id === second.id);
  check("xdo Allow: nothing approved", still?.status === "waiting", still?.status);

  await act(page, "ptab", { place: "inbox", v: "history" });
  const btn = page.locator('#main [data-act="compare"]');
  await btn.waitFor({ timeout: 8000 }).catch(() => {});
  const [newer, older] = await btn.evaluate((el) => [el.dataset.id, el.dataset.v]).catch(() => []);
  await btn.click();
  await page.waitForSelector(".cmp6", { timeout: 8000 }).catch(() => {});
  const cells = await page.locator(".cmp6 tbody tr").nth(2).locator("td").allTextContents();
  const [a, b] = await Promise.all([get(`runs/${older}/inspect`), get(`runs/${newer}/inspect`)]);
  check("compare: the two tasks' rounds match their inspect records (GET /api/runs/<id>/inspect)", a.run.prompt === b.run.prompt && cells[0] === String(a.rounds.length) && cells[1] === String(b.rounds.length), cells.join(" | "));
  await act(page, "dlg-close");
}

/* Automations: a procedure's Open shows its steps; the check script's Allow and Not now stay greyed. */
async function automations(page) {
  await act(page, "view", { v: "automations" });
  await act(page, "ptab", { place: "automations", v: "procedures" });
  const proc = (await get("state")).procedures[0];
  await page.click(`#main [data-act="flow"][data-id="${proc.id}"]`);
  await sleep(600);
  check("flow: Open shows the procedure (GET /api/state procedures)", (await page.locator(".flow-svg").count()) === 1 && (await page.locator(".dlg, dialog").first().textContent()).includes(proc.data.definition.name));
  await act(page, "dlg-close");
  check("proc-run: Run now greyed", await greyed(page, '#main [data-act="proc-run"]'));
  await act(page, "ptab", { place: "automations", v: "checkins" });
  await page.waitForSelector('#main [data-act="gate-yes"]', { timeout: 8000 }).catch(() => {});
  const gated = (await get("heartbeat")).schedules.find((s) => s.gate && !s.gate.approved);
  check("check script: the waiting job is drawn with its program (GET /api/heartbeat)", gated && (await page.locator("#main .tile", { hasText: gated.prompt }).count()) === 1);
  check("gate-yes/gate-no greyed", await greyed(page, '#main [data-act="gate-yes"]') && await greyed(page, '#main [data-act="gate-no"]'));
}

async function clicks() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await signIn(page);
    await customize(page);
    await inbox(page);
    await automations(page);
  } finally {
    check("no page errors", errors.length === 0, errors.join(" | "));
    await browser.close();
  }
}

(async () => {
  const mode = process.argv[2] || "verify";
  if (mode === "seed") return seed(process.argv[3] || process.env.DATA);
  const model = await startModel();
  try {
    if (mode === "prepare") return await prepare();
    await seedLive();
    if (mode === "seedlive") return;
    await clicks();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    model.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
