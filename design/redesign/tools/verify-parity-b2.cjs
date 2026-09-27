/* Parity B2 (briefs/PARITY.md, batch B2: the side panel, the stage and computers) in the real window, against a fresh
   engine this script starts itself: every control B2 made live is clicked and its change read back through the
   engine's own GET route, and what stays greyed is checked to be greyed. Zero page errors, console errors or refused
   requests after signing in.

   What it starts, all on this computer and all thrown away afterwards:
   - a fresh data folder with two paired computers written into the device book (Tower, Linux; Laptop, macOS), and a
     fresh workspace holding notes/old.md and notes/keep.md;
   - a stand-in model on MODEL_PORT, OpenAI-shaped: it plans "b2 plan" in two steps (holding the first step's answer
     until this script lets it go, so the task is caught working), runs two commands for "b2 commands" (one the rules
     allow, one that asks) and, for "b2 files", reads old.md, makes new.md, changes old.md and reads keep.md;
   - a page on PAGE_PORT that Branch's browser may open, for the owner's address field;
   - the engine on PORT (never 3210, 3299 or 3300), pointed at that model.
   The live view of This computer's screen is checked with the throwaway engine's screen switch left off: the view shows
   the engine's refusal in its own words, and the stream is let go on close and hide. Nothing reads this PC's screen.
   REAL_SCREEN=1 (only on a machine whose owner asked for it) turns the switch on and reads THIS PC's real screen: frames
   arrive several a second, and it never takes a screenshot while the screen is showing.
   Run:  PORT=3765 MODEL_PORT=43765 PAGE_PORT=43766 node design/redesign/tools/verify-parity-b2.cjs   (SHOTS=<dir> keeps screenshots) */
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT ?? 3765), MODEL_PORT = Number(process.env.MODEL_PORT ?? 43765), PAGE_PORT = Number(process.env.PAGE_PORT ?? 43766);
const PAGE = `http://127.0.0.1:${PAGE_PORT}/b2`;
const ENDPOINT = `http://127.0.0.1:${MODEL_PORT}/v1`;
const pages = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end('<!doctype html><title>B2 page</title><body bgcolor="#2f8c86"><h1>B2 page</h1></body>'); });
if ([3210, 3299, 3300].includes(PORT)) { console.error("Never the owner's ports."); process.exit(2); }
const ROOT = resolve(__dirname, "../../..");
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS ?? "";
const TOWER = "a1b2c3d4e5f60718", LAPTOP = "0f1e2d3c4b5a6978";
const OWNER = "Robin", TRUNK = "Mapper", TRUNK_TITLE = "Keeps the maps";
let TOKEN = "", failed = 0;
const OUT = { household: false, screenOpen: 0 };
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await pause(250); } return null; };
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => undefined) : undefined);

/* ---------- the stand-in model ---------- */
/* How a tool's name travels to this stand-in is the engine's own rule (src/providers.ts wireName, by wireRuleFor of the
   stand-in's address), read from dist when the script starts, never a copy of it: a copy once drifted (hashes after
   local models were given readable names) and the stand-in asked to load a tool it had already been offered, round
   after round. tests/real-model-tools.test.mjs pins what that rule is for a model on this computer. */
const naming = { wire: null };
const travels = (name, sent) => sent === naming.wire(name);
const PLAN = JSON.stringify({ steps: [{ title: "Look in the notes folder", touches: "notes", changes: false }, { title: "Write the summary", touches: "summary.md", changes: true }] });
const model = { held: [], hold: false };
const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
function answer(body) {
  const messages = body.messages ?? [];
  const system = messages.filter((m) => m.role === "system").map(textOf).join("\n");
  if (/You are planning a task/.test(system)) return { say: PLAN };
  const users = messages.map((m, i) => (m.role === "user" && textOf(m) !== "Yes, go ahead." ? i : -1)).filter((i) => i >= 0);
  const last = users.at(-1) ?? -1, prompt = textOf(messages[last]), since = messages.slice(last + 1);
  const named = new Map(since.flatMap((m) => m.tool_calls ?? []).map((c) => [c.id, c.function?.name]));
  const ok = (name) => since.filter((m) => m.role === "tool" && travels(name, named.get(m.tool_call_id)) && /"ok":\s*true/.test(textOf(m))).length;
  const offered = [...new Set((body.tools ?? []).map((x) => x.function?.name))];
  const offeredAs = (name) => offered.find((wireName) => travels(name, wireName));
  // A tool not offered this round is loaded by its exact name first (the engine's "Load tools you already know").
  const loader = (body.tools ?? []).find((x) => /^Load tools you already know/.test(x.function?.description ?? ""));
  // Loaded once and still not offered: said plainly, so the task ends and its check fails with the reason.
  const loaded = (name) => since.some((m) => (m.tool_calls ?? []).some((c) => c.function?.name === loader?.function.name && JSON.parse(c.function.arguments || "{}").names?.includes(name)));
  const call = (name, args) => (offered.length && !offeredAs(name) && loader
    ? (loaded(name) ? { say: `Not offered after loading: ${name}` } : { tool: loader.function.name, args: { names: [name] } })
    : { tool: offeredAs(name) ?? naming.wire(name), args });
  if (since.filter((m) => m.role === "tool").length > 10) return { say: "Stopped." };
  if (prompt.includes("b2 commands")) {
    const ran = ok("shell.execute");
    return ran === 0 ? call("shell.execute", { executable: "node", args: ["-v"] }) : ran === 1 ? call("shell.execute", { executable: "node", args: ["-p", "1+1"] }) : { say: "Both ran." };
  }
  if (prompt.includes("b2 files")) {
    const read = ok("files.read"), wrote = ok("files.write");
    if (read === 0) return call("files.read", { path: "notes/old.md" });
    if (wrote === 0) return call("files.write", { path: "notes/new.md", content: "made by the b2 check\nsecond line\n" });
    if (wrote === 1) return call("files.write", { path: "notes/old.md", content: "changed by the b2 check\n" });
    if (read === 1) return call("files.read", { path: "notes/keep.md" });
    return { say: "Read and wrote the notes." };
  }
  if (prompt.includes("b2 hold")) return { say: "Held and done.", hold: model.hold };
  // Plan first: a step's turn is held while this script says so, so the task is caught working through its plan.
  return { say: "Done.", hold: model.hold && /Look in the notes folder/.test(JSON.stringify(messages)) };
}
function respond(res, body, r) {
  const message = r.tool ? { role: "assistant", content: null, tool_calls: [{ id: `c${Date.now()}${Math.random().toString(16).slice(2, 6)}`, type: "function", function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } : { role: "assistant", content: r.say };
  const finish = message.tool_calls ? "tool_calls" : "stop", usage = { prompt_tokens: 10, completion_tokens: 5 };
  if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish }], usage })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = message.tool_calls ? { role: "assistant", tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) } : message;
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }] })); return; }
    const body = JSON.parse(raw || "{}"), r = answer(body);
    if (r.hold) { model.held.push(() => respond(res, body, r)); return; }
    respond(res, body, r);
  });
});
const letGo = () => { model.hold = false; for (const go of model.held.splice(0)) go(); };

/* ---------- a fresh engine ---------- */
async function seed(dataDir, workspace) {
  const { createBranch } = await import(pathToFileURL(join(ROOT, "dist/index.js")).href);
  const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir, provider: quiet });
  const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-26T00:00:00.000Z", lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] });
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "off", requests: [], devices: [device(TOWER, "Tower", "linux"), device(LAPTOP, "Laptop", "darwin")] });
  await app.close();
  mkdirSync(join(workspace, "notes"), { recursive: true });
  writeFileSync(join(workspace, "notes/old.md"), "the original words\n");
  writeFileSync(join(workspace, "notes/keep.md"), "only read\n");
}
function startEngine(dataDir, workspace, integrations) {
  const env = { ...process.env, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: workspace, BRANCH_PORT: String(PORT), BRANCH_INTEGRATIONS: integrations,
    BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: ENDPOINT, BRANCH_MODEL: "stand-in", BRANCH_API_KEY: "local-test" };
  const child = spawn(process.execPath, [join(ROOT, "dist/cli.js"), "start"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((ok, bad) => {
    let out = "";
    const timer = setTimeout(() => bad(new Error(`the engine did not start:\n${out}`)), 90000);
    const read = (chunk) => { out += chunk; const m = /paste into browser\): ([a-f0-9]+)/.exec(out); if (m) { clearTimeout(timer); TOKEN = m[1]; ok(child); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
  });
}

/* ---------- helpers ---------- */
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const greyed = async (loc) => (await loc.count()) > 0 && ((await loc.first().getAttribute("aria-disabled")) === "true" || await loc.first().isDisabled());
const act = (page, name, data = {}) => page.evaluate(([n, d]) => { const b = document.createElement("button"); b.dataset.act = n; Object.assign(b.dataset, d); document.body.appendChild(b); b.click(); b.remove(); }, [name, data]);
const text = async (loc) => ((await loc.count()) ? (await loc.first().textContent()).trim() : "");
const runFor = (prompt, statuses) => until(async () => (await api("state")).runs.find((r) => r.prompt === prompt && (!statuses || statuses.includes(r.status))), 45000);
/* The task once it is over, with its output; the check that follows says if it did not finish well. */
async function over(prompt) {
  const run = await runFor(prompt, ["completed", "failed", "cancelled"]);
  if (run?.status === "completed") return run;
  const runs = (await api("state")).runs.filter((r) => r.prompt === prompt);
  const now = runs.map((r) => `${r.status}: ${String(r.output ?? "").slice(0, 160)}`);
  if (process.env.DEBUG && runs[0]) console.log("  events:", JSON.stringify((await api(`runs/${runs[0].id}/steps`).catch(() => ({}))).steps?.map((x) => [x.kind, x.title ?? x.name ?? "", x.status ?? ""]) ?? []));
  throw new Error(`"${prompt}" did not complete · ${now.join(" | ")}`);
}
async function newConversation(page) {
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await page.locator("#prompt").waitFor({ state: "visible" });
}
async function send(page, words) {
  await until(async () => !(await api("state")).runs.some((r) => ["running", "queued"].includes(r.status)), 30000);
  await pause(1200);
  await page.locator("#prompt").fill(words);
  await page.locator("#send").click();
}
async function openPane(page, tab) {
  if (!(await page.locator("#pane:not([hidden])").count())) await page.locator('.head [data-act="pane"][data-p="activity"]').first().click();
  await page.locator(`#pane [data-p="${tab}"]`).click();
}

/* ---------- 1. chat-005: the plan stays in the thread while its task works ---------- */
async function planInThread(page) {
  await newConversation(page);
  await page.locator('[data-act="modemenu2"]').click();
  await page.locator('.pop [data-act="set-mode"][data-v="plan"]').click();
  await send(page, "b2 plan");
  const waiting = await runFor("b2 plan", ["needs_input"]);
  check("chat-005: the plan a task waits on is drawn", !!(await until(async () => (await page.locator("#conversation ul.plan li").count()) === 2)));
  model.hold = true;
  await page.locator("#prompt").fill("go ahead");
  await page.locator("#send").click();
  const working = await until(async () => { const p = (await api(`runs/${waiting.id}/plan`)).plan; return p?.steps?.some((s) => s.status === "working") && p; }, 30000);
  const run = (await api("state")).runs.find((r) => r.sessionId === waiting.sessionId && r.status === "running");
  check("chat-005: GET /api/runs/<id>/plan has a step working while the task runs", !!working && !!run, run?.status ?? "no running task");
  const now = await until(async () => (await page.locator("#conversation ul.plan li.now").count()) === 1, 15000);
  const drawn = (await page.locator("#conversation ul.plan li").allInnerTexts()).map((x) => x.trim());
  check("chat-005: the plan stays in the thread while the task works, its current step marked now", !!now && JSON.stringify(drawn) === JSON.stringify(working.steps.map((s) => s.title)), JSON.stringify(drawn));
  await shot(page, "01-plan-working");
  letGo();
  // The OK carried the plan on as the conversation's next task; the plan's own task keeps its question.
  const over = await until(async () => (await api("state")).runs.find((r) => r.sessionId === waiting.sessionId && r.prompt === "go ahead" && r.status === "completed"), 45000);
  const states = (await api("state")).runs.filter((r) => r.sessionId === waiting.sessionId).map((r) => `${r.prompt.slice(0, 30)}:${r.status}:${String(r.output ?? "").slice(0, 80)}`);
  check("chat-005: once the task is over the plan card goes", !!over && !!(await until(async () => (await page.locator("#conversation ul.plan").count()) === 0, 15000)), states.join(","));
}

/* ---------- 2. pane-stage-005: who let each command ---------- */
async function commands(page) {
  await newConversation(page);
  await send(page, "b2 commands");
  const first = await runFor("b2 commands", ["needs_input", "completed", "failed", "cancelled"]);
  if (first?.status !== "needs_input") throw new Error(`the second command did not ask first · ${first?.status}:${String(first?.output ?? "").slice(0, 160)}`);
  const allow = page.locator('#conversation [data-act="ask"][data-v="allow"]');
  await allow.first().waitFor({ timeout: 30000 }).catch(async (error) => {
    const runs = (await api("state")).runs.filter((r) => r.prompt === "b2 commands").map((r) => `${r.status}:${String(r.output ?? "").slice(0, 120)}`);
    throw new Error(`${error.message.split(String.fromCharCode(10))[0]} · ${runs.join(" | ")} · ${(await text(page.locator("#conversation"))).slice(-300)}`);
  });
  await allow.first().click();
  // QA Q050: the yes carries the task that asked on itself (no second task, nothing said in the owner's name), and it
  // runs the command it asked about.
  const asked = await runFor("b2 commands");
  const run = await until(async () => (await api("state")).runs.find((r) => r.id === asked.id && r.status === "completed"), 45000);
  if (!run) throw new Error(`the task was not carried on after the yes · ${String((await api("state")).runs.find((r) => r.id === asked.id)?.output ?? "").slice(0, 160)}`);
  const again = (await api("state")).runs.filter((r) => r.sessionId === asked.sessionId && r.id !== asked.id);
  check("pane-stage-005: the yes starts no second task", again.length === 0, again.map((r) => r.prompt).join(" | "));
  const work = await until(async () => { const w = await api(`panels/work?session=${run.sessionId}`); return w.terminal.entries.filter((e) => e.state === "done").length === 2 && w; }, 30000);
  const all = work ?? await api(`panels/work?session=${run.sessionId}`);
  const by = all.terminal.entries.filter((e) => e.state === "done").map((e) => `${e.what}=${e.allowed}`);
  if (!work) console.log("  terminal:", JSON.stringify(all.terminal.entries.map((e) => [e.what, e.state, e.allowed, String(e.output).slice(0, 60)])));
  check("pane-stage-005: GET /api/panels/work says who let each command", JSON.stringify(by) === JSON.stringify(["node -v=rules", "node -p 1+1=owner"]), by.join(", "));
  await openPane(page, "terminal");
  const want = all.terminal.entries.map((e) => (e.state === "waiting" ? "Waiting for your yes" : e.allowed === "rules" ? "Allowed by your rules" : e.allowed === "owner" ? `Approved by ${OWNER}` : "")).filter(Boolean);
  const pills = await until(async () => { const p = (await page.locator("#pane .termrow .pill").allTextContents()).map((x) => x.trim()); return p.length === want.length && p; }, 15000);
  check("pane-stage-005: each command's pill names who let it, as GET /api/panels/work says", JSON.stringify(pills) === JSON.stringify(want) && JSON.stringify(want) === JSON.stringify(["Allowed by your rules", `Approved by ${OWNER}`]), JSON.stringify(pills));
  await shot(page, "02-terminal");
}

/* ---------- 3. pane-stage-001, -003: the tab row, and Files with Read, who and when, and Put back ---------- */
async function files(page, workspace) {
  await newConversation(page);
  await send(page, "b2 files");
  const run = await over("b2 files");
  const work = await until(async () => { const w = await api(`panels/work?session=${run.sessionId}`); return w.files.read.length && w; });
  if (!work) console.log("  files run:", run.status, String(run.output).slice(0, 200), JSON.stringify((await api(`sessions/${run.sessionId}`)).messages.filter((m) => m.role === "tool").map((m) => String(m.content).slice(0, 120))));
  check("pane-stage-003: GET /api/panels/work lists the file only read, not the one read then changed", JSON.stringify(work?.files.read) === JSON.stringify(["notes/keep.md"]), JSON.stringify(work?.files.read));
  await openPane(page, "files");
  const tabs = (await page.locator("#pane .ptabs .ptab").allInnerTexts()).map((x) => x.trim());
  check("pane-stage-001: the tab row is the prototype's six, no Browser tab", JSON.stringify(tabs) === JSON.stringify(["Activity", "Timeline", "Plan", "Files", "Memory", "Terminal"]), tabs.join(", "));
  const rows = await until(async () => { const r = (await page.locator('#pane [data-act="fileopen"]').evaluateAll((els) => els.map((e) => `${e.dataset.n}=${e.querySelector(".pill").textContent}`))); return r.length === 3 && r; }, 15000);
  check("pane-stage-003: Files lists Made, Changed and Read", JSON.stringify(rows) === JSON.stringify(["notes/new.md=Made", "notes/old.md=Changed", "notes/keep.md=Read"]), JSON.stringify(rows));
  await page.locator('#pane [data-act="fileopen"][data-n="notes/old.md"]').click();
  const dlg = page.locator(".scrim .dlg");
  await dlg.waitFor();
  const said = await text(dlg.locator("p").first());
  check("pane-stage-003: a changed file says who changed it, when, and that a checkpoint was kept", /^Changed by .+ today at .+\. A checkpoint was kept first\.$/.test(said), said);
  check("pane-stage-003: Open stays greyed (no route opens a file in its own app)", await greyed(dlg.locator('[data-act="file-app"]')));
  const change = (await api("state")).runs.find((r) => r.id === run.id).changes.find((c) => c.path === "notes/old.md");
  await dlg.locator('[data-act="file-putback"]').click();
  const back = await until(async () => (await api(`history/files?path=${encodeURIComponent("notes/old.md")}`)).versions.find((v) => v.reason === `before restore of ${change.versionId}`));
  check("pane-stage-003: Put back the earlier version restores it (GET /api/history/files keeps the one it replaced)", !!back && readFileSync(join(workspace, "notes/old.md"), "utf8") === "the original words\n");
  await act(page, "fileopen", { n: "notes/new.md", st: "made" });
  await dlg.waitFor();
  // A Markdown file reads as an answer does (dogfood D19), so notes/new.md is drawn as text, not a raw block.
  const wrote = await text(dlg.locator(".docread18, pre.made-b2").first());
  check("pane-stage-003: a made file shows what the task wrote", wrote.startsWith("made by the b2 check"), wrote);
  check("pane-stage-003: Edit stays greyed (no route edits a file from the window)", await greyed(dlg.locator('[data-act="file-edit"]')));
  await page.keyboard.press("Escape");
  await act(page, "fileopen", { n: "notes/keep.md", st: "read" });
  await dlg.waitFor();
  check("pane-stage-003: a read file says it was only read", /^Read only\. .+ read this file and didn’t change it\.$/.test(await text(dlg.locator("p").first())), await text(dlg.locator("p").first()));
  await shot(page, "03-files");
  await page.keyboard.press("Escape");
}

/* ---------- 4. pane-stage-006, -012, -013: the stage named for the Trunk, its computers ---------- */
async function stage(page, trunk) {
  await act(page, "chat", { id: trunk.chatSessionId });
  await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
  const st = page.locator("#stage7");
  await st.waitFor();
  check("pane-stage-006: the view is named for the Trunk", (await text(st.locator(".st7-title b"))) === `${TRUNK}’s computer` && (await text(st.locator(".st7-back"))) === TRUNK, await text(st.locator(".st7-title b")));
  check("pane-stage-006: the dock has the Trunk's own face, name and role", (await st.locator(".dk7-h .av, .dk7-h .fig17, .dk7-h span").count()) > 0 && (await text(st.locator(".dk7-h small"))) === TRUNK_TITLE, await text(st.locator(".dk7-h")));
  check("pane-stage-006: the dock's foot says what This computer lets it reach, with Change what it may use", (await text(st.locator(".dk7-foot"))).includes("Change what it may use"));
  check("pane-stage-006b: the dock's foot says plainly that the screen is shown as it is", (await text(st.locator(".dk7-foot"))).includes("What’s on your screen is shown here as it is."));
  const tabs = await until(async () => { const x = (await st.locator(".st7-tabs [role=tab]").allInnerTexts()).map((s) => s.trim()); return x.length === 4 && x; });
  check("pane-stage-013: a tab per computer the Trunk may use, and All screens", JSON.stringify(tabs) === JSON.stringify(["This computer", "Tower", "Laptop", "All screens"]), JSON.stringify(tabs));
  await st.locator(`.st7-tabs [data-act="comp-view"][data-v="${TOWER}"]`).click();
  const picked = await until(async () => (await api(`devices/pick/${trunk.chatSessionId}`)).picked === TOWER);
  const chosen = await until(async () => (await st.locator(`.st7-tabs [data-v="${TOWER}"][aria-selected="true"]`).count()) === 1, 5000);
  check("pane-stage-013: a computer's tab picks it for the conversation (GET /api/devices/pick)", !!picked && !!chosen, JSON.stringify(await api(`devices/pick/${trunk.chatSessionId}`)));
  check("pane-stage-013: another computer's tab never shows This computer's screen", (await st.locator(".st7-screen img").count()) === 0 && (await st.locator(".st7-empty").count()) === 1);
  await st.locator('.st7-tabs [data-act="comp-grid"]').click();
  check("pane-stage-013: All screens shows every computer side by side", (await st.locator(".st7-grid .st7-cell").count()) === 3);
  await shot(page, "04-stage-grid");
  await st.locator('.st7-tabs [data-act="comp-view"][data-v="this"]').click();
  await until(async () => (await api(`devices/pick/${trunk.chatSessionId}`)).picked === "this");
  await st.locator('[data-act="comp-pick"]').click();
  const ko = page.locator(".pop .mi").filter({ hasText: "KeepOak computer" });
  check("pane-stage-012: the menu lists the KeepOak computer, disabled, Connect keepoak.com first", (await ko.count()) === 1 && await greyed(ko) && (await text(ko)).includes("Connect keepoak.com first"));
  await page.keyboard.press("Escape");
  await st.locator('[data-act="stage-pip"]').click();
  const bar = await until(async () => { const b = await text(page.locator("#pip7 .pip7-bar span")); return b && b; });
  check("pane-stage-006: the small window's bar says whose and which computer", bar === `${TRUNK} · This computer`, bar);
  await page.locator('#pip7 [data-act="stage"]').first().click();
  await st.waitFor();
  check("pane-stage-008: the steps' replay stays greyed (the engine keeps no frames per step)", (await st.locator('[data-act="stage-step"]').count()) === 0 || await greyed(st.locator('[data-act="stage-step"]')));
  check("pane-stage-006: Pause is the chat's own (POST /api/runs/<id>/pause, batch A), never a greyed stand-in", (await st.locator('[data-act="stage-pause"]').count()) === 0);
  await st.locator('.dk7-foot [data-act="setgo"]').click();
  check("pane-stage-006: Change what it may use opens Settings › Computer & browser", !!(await until(async () => (await text(page.locator(".settings h1"))) === "Computer & browser", 10000)));
  // Settings is a place, left by its own way back (as the prototype's is; Escape closes menus and dialogs only).
  await page.locator(".set-back").first().click();
  await page.locator("#prompt").waitFor({ state: "visible" });
}

/* ---------- 4b. the owner's address field: Branch's own browser goes where the owner typed ---------- */
async function browseStep(page) {
  await newConversation(page);
  await send(page, "b2 hello");
  const run = await over("b2 hello");
  await page.locator('.head [data-act="stage"][data-v="browser"]').first().click();
  const field = page.locator("#stage7 #st-addr");
  await field.waitFor();
  await field.fill(PAGE);
  await field.press("Enter");
  // A site no task has visited asks first: the engine's own question, answered with Allow once.
  const yes = page.locator('.scrim [data-act="browse-yes"]');
  await yes.waitFor({ timeout: 20000 });
  check("browse: the engine's question for a new site is put to the owner", (await text(page.locator(".scrim .dlg p"))).length > 0, await text(page.locator(".scrim .dlg p")));
  await yes.click();
  const seen = await until(async () => { const v = await api(`panels/live?session=${run.sessionId}`); return v.browser?.url === PAGE && v.browser.live && v.browser.frame && v; }, 30000);
  check("browse: GET /api/panels/live shows Branch's browser live on the page the owner typed", !!seen, seen ? `${seen.browser.url} · ${seen.browser.title}` : "");
  check("browse: the view paints its frames", !!(await until(async () => ((await page.locator("#stage7 .live7-img").getAttribute("src")) ?? "").startsWith("data:image/jpeg"), 15000)));
  await shot(page, "06-browse");
  model.hold = true;
  await page.locator('#stage7 [data-act="stage-close"]').click();
  await page.locator("#prompt").fill("b2 hold");
  await page.locator("#send").click();
  await runFor("b2 hold", ["running"]);
  await page.locator('.head [data-act="stage"][data-v="browser"]').first().click();
  check("browse: the field is disabled while a task works here", !!(await until(async () => page.locator("#stage7 #st-addr").isDisabled(), 10000)));
  letGo();
  await over("b2 hold");
  await page.locator('#stage7 [data-act="stage-close"]').click();
}

/* ---------- 4c. the owner's live view of This computer's screen (switch off unless REAL_SCREEN=1; no screenshots) ---------- */
const REAL_SCREEN = process.env.REAL_SCREEN === "1";
async function screenStep(page) {
  if (REAL_SCREEN) await api("desktop/settings", { enabled: true });
  try {
    await newConversation(page);
    await send(page, "b2 hello again");
    await over("b2 hello again");
    await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
    const got = await until(async () => (((await page.locator("#stage7 .livescr-img").getAttribute("src").catch(() => null)) ?? "").startsWith("data:image/")
      ? "frame" : (await text(page.locator("#stage7 .st7-empty small"))) || null), 20000);
    check("screen: This computer's screen arrives live (or the engine says why not, in its words)", !!got, got === "frame" ? "live frames" : String(got));
    if (!REAL_SCREEN) check("screen: with the switch off nothing of this PC's screen is read", got !== "frame", String(got));
    if (got === "frame") {
      // Frames stream down one open request while the view is open: counted as they are painted.
      await page.evaluate(() => { window.__b2frames = 0; new MutationObserver((list) => { for (const m of list) if (m.target.classList?.contains("livescr-img")) window.__b2frames++; }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["src"] }); });
      const t0 = Date.now();
      await pause(5000);
      const painted = await page.evaluate(() => window.__b2frames);
      const fps = painted / ((Date.now() - t0) / 1000);
      check("screen: it streams several frames a second while the view is open", fps >= 2, `${painted} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${fps.toFixed(1)} a second`);
    }
    await page.locator('#stage7 [data-act="stage-close"]').click();
    await pause(1500);
    check("screen: closing the view lets go of the stream", OUT.screenOpen === 0, `${OUT.screenOpen} still open after close`);
    await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
    await pause(1500);
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await pause(1500);
    check("screen: a hidden window lets go of the stream", OUT.screenOpen === 0, `${OUT.screenOpen} still open while hidden`);
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    check("screen: Take over stays greyed on This computer (viewing only)", (await page.locator('#stage7 [data-act="takeover"]').count()) === 0 || await greyed(page.locator('#stage7 [data-act="takeover"]')));
    await page.locator('#stage7 [data-act="stage-close"]').click();
  } finally {
    if (REAL_SCREEN) await api("desktop/settings", { enabled: false });
  }
}

/* ---------- 5. shell-036 and pane-stage-014: the switcher and Settings' computer cards ---------- */
async function switcherAndSettings(page, trunk) {
  await page.locator('[data-act="machines"]').first().click();
  const pop = page.locator(".pop");
  await pop.waitFor();
  const personal = pop.locator('[data-act="ws"][data-v="personal"]');
  check("shell-036: Workspace: Personal, chosen and greyed (no other workspace without keepoak.com)", (await text(pop.locator(".ph").first())) === "Workspace" && (await personal.getAttribute("aria-checked")) === "true" && await greyed(personal), await personal.evaluate((e) => e.outerHTML.slice(0, 200)).catch(() => "none"));
  const ko = pop.locator('[data-act="machine"][data-v="keepoak"]');
  check("shell-036: the KeepOak computer row is greyed, Connect keepoak.com to use it", await greyed(ko) && (await text(ko)).includes("Connect keepoak.com to use it"));
  await page.keyboard.press("Escape");
  await act(page, "setgo", { v: "computer" });
  const cards = page.locator(".settings .comp7-card");
  await until(async () => (await cards.filter({ hasText: "Tower" }).count()) === 1 && (await cards.filter({ hasText: "Used by" }).count()) >= 1);
  const devices = await api("devices");
  const tower = devices.devices.find((d) => d.id === TOWER);
  const mine = cards.filter({ hasText: "This computer" }).first(), towerCard = cards.filter({ hasText: "Tower" }).first();
  check("pane-stage-014: This computer's card is Ready", (await text(mine.locator(".pill"))) === "Ready");
  check("pane-stage-014: a paired computer's pill follows GET /api/devices connected", (await text(towerCard.locator(".pill"))) === (tower.connected ? "Ready" : "Offline"), `connected=${tower.connected}`);
  const view = await api(`trunks/${trunk.id}/computers`);
  check("pane-stage-014: Used by names the Trunks GET /api/trunks/<id>/computers allows", view.allowed.includes(TOWER) && (await text(towerCard.locator(".c7-users"))) === `Used by ${TRUNK}`, await text(towerCard.locator(".c7-users")));
  await shot(page, "05-settings-computers");
  await page.keyboard.press("Escape");
}

/* ---------- 6. pane-stage-005: a household person is shown the owner-only line ---------- */
async function household(page) {
  const person = await api("profiles", { name: "Kit", pin: "4321" });
  // A household person's window is refused the owner's reads (settings, Lockdown, ...): those refusals are the engine's.
  OUT.household = true;
  await api("profiles/switch", { profileId: person.id ?? person.profile?.id, pin: "4321" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await newConversation(page);
  await openPane(page, "terminal");
  check("pane-stage-005: a household person sees Only the owner sees the terminal.", (await text(page.locator("#pane .pane-b"))) === "Only the owner sees the terminal.");
  await api("profiles/switch", { profileId: null });
  OUT.household = false;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "branch-parity-b2-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace"), integrations = join(root, "integrations.json");
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  // This throwaway engine may reach the stand-in on this computer, and run node (the one program the commands use).
  writeFileSync(integrations, JSON.stringify({ web: { allowPrivateAddresses: true, allowedHosts: ["127.0.0.1"] }, browser: { allowedOrigins: [new URL(PAGE).origin] },
    shell: { executables: { node: { path: process.execPath } } } }));
  await new Promise((ok) => pages.listen(PAGE_PORT, "127.0.0.1", ok));
  const { wireName, wireRuleFor } = await import(pathToFileURL(join(ROOT, "dist/providers.js")).href);
  const rule = wireRuleFor(ENDPOINT);
  naming.wire = (name) => wireName(name, rule);
  await new Promise((ok) => stub.listen(MODEL_PORT, "127.0.0.1", ok));
  await seed(dataDir, workspace);
  const engine = await startEngine(dataDir, workspace, integrations);
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    await api("onboarding", { done: true });
    await api("profiles/owner/about", { name: OWNER });
    const { policy, presets } = await api("policy");
    const workspacePreset = presets.find((p) => p.id === "workspace");
    await api("policy", { ...policy, preset: "workspace", confirmLoosening: true, rules: [{ tool: "files.*", decision: "allow" }, { tool: "shell.execute", match: "node -v", decision: "allow" }, { tool: "shell.execute", decision: "ask" }, ...workspacePreset.rules] });
    // A new conversation follows those rules (it starts on Ask first otherwise, which sets aside every standing yes).
    await api("conversation-mode/settings", { newConversation: "follow", confirmLoosening: true });
    await api("trunks/switch", { part: "trunks", mode: "on" });
    await api("trunks/switch", { part: "conversations", mode: "on" });
    const trunk = (await api("trunks", { name: TRUNK, title: TRUNK_TITLE })).trunk;
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
    let signedIn = false;
    // The screen's refusal while its switch is off (409, shown in place of the screen in the engine's words) is expected.
    page.on("response", (r) => { if (signedIn && !OUT.household && r.status() >= 400 && !(r.status() === 409 && new URL(r.url()).pathname === "/api/panels/screen")) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
    const isScreen = (r) => new URL(r.url()).pathname === "/api/panels/screen";
    page.on("request", (r) => { if (isScreen(r)) OUT.screenOpen++; });
    page.on("requestfinished", (r) => { if (isScreen(r)) OUT.screenOpen--; });
    page.on("requestfailed", (r) => { if (isScreen(r)) OUT.screenOpen--; });
    await page.goto(BASE + "/");
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
    await pause(1500);
    signedIn = true;
    for (const [name, step] of [["plan", () => planInThread(page)], ["commands", () => commands(page)], ["files", () => files(page, workspace)],
      ["stage", () => stage(page, trunk)], ["browse", () => browseStep(page)], ["screen", () => screenStep(page)],
      ["switcher", () => switcherAndSettings(page, trunk)], ["household", () => household(page)]]) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      try { await step(); } catch (error) { check(`${name}: ran to the end`, false, error.message.split("\n")[0]); letGo(); await page.keyboard.press("Escape").catch(() => undefined); }
    }
  } finally {
    check("zero page errors, console errors or refused requests", errors.length === 0, errors.slice(0, 5).join(" | "));
    await browser.close();
    engine.kill();
    stub.close();
    pages.close();
    await pause(1500);
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { console.log(`left ${root}: ${error.message}`); }
  }
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
