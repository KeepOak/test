// Verifies the places/customize leftovers (round 3) against a real engine: clicks every control this area made live and
// checks, through the engine's own GET routes, that the change really happened. Records every page error.
//
// A better version of a skill is only ever written by a model (the engine's POST /api/skills/{id}/draft asks one to
// improve the skill from a finished task), and the offline demo model cannot write a skill file. So this script starts a
// small OpenAI-shaped model on this computer (MODEL_PORT, default 43343) and the engine is started pointing at it:
//
//   BRANCH_DATA_DIR=<fresh folder> BRANCH_WORKSPACE=<fresh folder> BRANCH_PORT=<port> \
//   BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:43343/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify \
//   node dist/cli.js start
//   PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-places-leftovers.cjs
//
// Asked to improve a skill, the model answers with the same SKILL.md and one more step; asked anything else, "Done.".
// Everything else goes through the engine's own routes: skills are installed, pinned to a conversation and used on
// finished tasks, two drafts are made, one skill is switched off so it is suggested, and recordings are switched on.
"use strict";
const http = require("node:http");

const PORT = process.env.PORT || "3343";
const TOKEN = process.env.TOKEN || "";
const MODEL_PORT = Number(process.env.MODEL_PORT || 43343);
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------- the model on this computer ---------- */
let asked = 0;
function answer(body) {
  const text = (body.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  const skill = /Current SKILL\.md:\n([\s\S]*?)\n\n(?:A task|Tasks) where/.exec(text);
  if (skill) return `${skill[1].trim()}\n\n## Also\n- Check the result once more before saying it is done.\n`;
  return "Done.";
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
        const content = answer(body);
        const usage = { prompt_tokens: 10, completion_tokens: 5 };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage }));
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
  if (!r.ok) throw Object.assign(new Error(`${method} ${route}: ${r.status} ${text.slice(0, 300)}`), { body: text });
  try { return JSON.parse(text); } catch { return text; }
}
const get = (route) => call("GET", route);
const post = (route, body = {}) => call("POST", route, body);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
  await sleep(500);
}
async function until(what, test, ms = 20000) {
  for (let t = 0; t < ms; t += 400) { const value = await test(); if (value) return value; await sleep(400); }
  throw new Error(`timed out waiting for ${what}`);
}

const SKILL_A = "---\nname: invoice-check\ndescription: Match an invoice against what was paid and list any difference.\n---\n\n1. Read the invoice.\n2. Find the payment.\n3. Say whether they match.\n";
const SKILL_B = "---\nname: receipt-filing\ndescription: File each receipt into a folder named for the month it was paid.\n---\n\n1. Read the receipt date.\n2. Move it to that month's folder.\n";

/* Engine-side setup, all through the engine's routes. */
async function setup() {
  const recordingsBefore = (await get("recordings")).settings.mode;
  const a = await post("skills/install", { document: SKILL_A });
  const first = await post("run", { prompt: "Match this invoice against what was paid" });
  if (!asked) throw new Error(`The engine did not ask the model on port ${MODEL_PORT}. Start it with BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:${MODEL_PORT}/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify (and a fresh BRANCH_DATA_DIR), then run this again.`);
  await post(`sessions/${first.sessionId}/skill`, { skillId: a.id });
  const used = await post("run", { prompt: "Match the second invoice against what was paid", sessionId: first.sessionId });
  const older = (await post(`skills/${a.id}/draft`, { runId: used.id })).candidateVersion;
  const newer = (await post(`skills/${a.id}/draft`, { runId: used.id })).candidateVersion;
  const b = await post("skills/install", { document: SKILL_B });
  await post(`skills/${b.id}/disable`, { expectedRevision: b.revision });
  const filed = await post("run", { prompt: "File this receipt into the folder for the month it was paid" });
  return { recordingsBefore, a: a.id, b: b.id, used, filed, older, newer };
}

async function signIn(page) {
  await call("POST", "onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#main", { timeout: 15000 });
  await sleep(1500);
}
const toastText = (page) => page.locator(".toast span").textContent({ timeout: 5000 }).catch(() => "");

/* replay: with recordings off the engine's own sentence; with them on the task's own frames, stepped and played. */
async function replay(page, s) {
  await act(page, "ptab", { place: "inbox", v: "history" });
  await page.waitForSelector(`[data-act="replay"][data-id="${s.used.id}"]`, { timeout: 8000 });
  const newest = (await get("state")).runs.find((r) => r.status === "completed");
  const tile = page.locator(`.tile [data-act="replay"][data-id="${newest.id}"]`);
  check("replay tile: offers the newest finished task by its own words", (await tile.textContent()).includes(newest.prompt.split("\n")[0].slice(0, 60)));
  if (s.recordingsBefore === "off") {
    const refused = await get(`runs/${s.used.id}/recording`).then(() => null, (e) => JSON.parse(e.body).error);
    await page.click(`.prow [data-act="replay"][data-id="${s.used.id}"]`);
    check("replay (recordings off): the engine's refusal is shown as it said it", refused && (await toastText(page)) === refused, refused);
  }
  await post("recordings", { mode: "when-needed" });
  check("recordings switched on for the rest (GET /api/recordings)", (await get("recordings")).settings.mode === "when-needed");
  const recording = await get(`runs/${s.used.id}/recording`);
  await page.click(`.prow [data-act="replay"][data-id="${s.used.id}"]`);
  await page.waitForSelector(".dlg .replay6 .tl li", { timeout: 8000 });
  const labels = await page.locator(".dlg .replay6 .tl li span").evaluateAll((els) => els.map((e) => e.firstChild.textContent));
  check("replay: one step per frame of the task's recording (GET /api/runs/{id}/recording)", labels.length === recording.frames.length && labels.every((l, i) => l === recording.frames[i].label), `${labels.length} frames: ${labels.join(" | ")}`);
  const now = () => page.locator(".dlg .replay6 .tl li.now6 span").evaluate((e) => e.firstChild.textContent);
  check("replay: starts on the first frame", (await now()) === recording.frames[0].label);
  await page.click('.dlg [data-act="rp"][data-v="step"]');
  check("rp (Step): moves to the next frame", (await now()) === recording.frames[1].label);
  await page.click('.dlg [data-act="rp"][data-v="play"]');
  const last = recording.frames.length - 1;
  await until("the last frame", async () => (await page.locator(".dlg .replay6 .tl li").nth(last).getAttribute("class")).includes("now6"), 800 * recording.frames.length + 4000);
  const width = await page.locator(".dlg .replay6 .meter6 u").evaluate((e) => e.style.width);
  check("rp (Play): plays through to the last frame", (await now()) === recording.frames[last].label && width === "100%", width);
  check("replay: Save as a page and Make a workflow stay greyed", await page.locator('.dlg-f [data-act="toast"][aria-disabled="true"]').count() === 2);
  await page.click('.dlg [data-act="rp"][data-v="play"]');
  await act(page, "dlg-close");
  await sleep(1200);
  check("replay: the task itself was not run again", (await get("state")).runs.filter((r) => r.prompt === s.used.prompt).length === 1);
}

/* rev: the newest draft is tried, then kept; the older one is thrown away. Each is read back from the engine. */
async function revisions(page, s) {
  await act(page, "ptab", { place: "customize", v: "tools" });
  await page.click('[data-act="t9-kind"][data-v="skills"]');
  const card = `.t9-learn [data-act="rev"][data-version="${s.newer}"]`;
  await page.waitForSelector(card, { timeout: 8000 });
  const shown = await get("skill-revisions");
  const draft = shown.revisions.find((r) => r.skillId === s.a && r.version === s.newer);
  const diff = await page.locator(".t9-learn .diff6").textContent();
  check("rev card: the newest draft, with the engine's changed lines", diff.replace(/\s+/g, "") === draft.diff.replace(/\s+/g, ""), draft.diff.split("\n").filter((l) => l.startsWith("+")).join(" / "));
  await page.click(`${card}[data-v="tried"]`);
  const tried = await until("the practice run", async () => (await get("skill-revisions")).revisions.find((r) => r.skillId === s.a && r.version === s.newer)?.trial);
  check("rev (Practice run): the engine tried the draft (GET /api/skill-revisions trial)", tried && tried.tasks > 0 && tried.noWorse && !tried.unreadable, `${tried.tasks} task(s), no worse: ${tried.noWorse}`);
  await page.waitForSelector(`${card}[data-v="tried"]:text("Try again")`, { timeout: 5000 });
  check("rev: after a practice run the button says Try again", true);
  await page.click(`${card}[data-v="kept"]`);
  const kept = await until("the draft kept", async () => { const x = (await get("skill-revisions")).revisions.find((r) => r.skillId === s.a && r.version === s.newer); return x?.decision && x; });
  const skill = await get(`skills/${s.a}`);
  check("rev (Keep it): accepted, and the skill now uses that version (GET /api/skills/{id})", kept.decision === "accepted" && skill.activeVersion === s.newer, `decision ${kept.decision}, activeVersion ${skill.activeVersion}`);
  const olderCard = `.t9-learn [data-act="rev"][data-version="${s.older}"]`;
  await page.waitForSelector(olderCard, { timeout: 8000 });
  await page.click(`${olderCard}[data-v="gone"]`);
  const gone = await until("the draft thrown away", async () => { const x = (await get("skill-revisions")).revisions.find((r) => r.skillId === s.a && r.version === s.older); return x?.decision && x; });
  const after = await get(`skills/${s.a}`);
  check("rev (Throw it away): rejected, and the skill stays on the version it had", gone.decision === "rejected" && after.activeVersion === s.newer, `decision ${gone.decision}, activeVersion ${after.activeVersion}`);
  check("rev: no draft left waiting, so the card is gone", await until("the card to go", async () => (await page.locator(".t9-learn").count()) === 0, 5000));
}

/* sugg15: the switched-off skill the engine suggests is switched on. */
async function suggestion(page, s) {
  const suggested = (await get("skills/suggest")).suggestions;
  check("setup: the engine suggests the switched-off skill (GET /api/skills/suggest)", suggested.some((x) => x.id === s.b && x.source === "installed"));
  const add = page.locator(`[data-act="sugg15"][data-v="${s.b}"]`);
  await add.waitFor({ timeout: 8000 });
  await add.click();
  const skill = await until("the skill switched on", async () => { const x = await get(`skills/${s.b}`); return x.activeVersion !== null && x; });
  check("sugg15 (Add): the skill is switched on at its newest version (GET /api/skills/{id})", skill.activeVersion === skill.headVersion);
  check("sugg15: it is no longer suggested, and its row is gone", !(await get("skills/suggest")).suggestions.some((x) => x.id === s.b) && await until("the row to go", async () => (await add.count()) === 0, 5000));
}

/* What stays greyed, and the documents list the Map would sit beside. */
async function greyed(page) {
  const doc = await post("documents", { name: "verify-notes.md", text: "Notes for the verify script." });
  await act(page, "ptab", { place: "library", v: "documents" });
  await page.waitForSelector(".prow b", { timeout: 8000 });
  const names = await page.locator("#main .prow b").allTextContents();
  const listed = (await get("documents")).documents.map((d) => d.name);
  check("documents list: the engine's documents (GET /api/documents)", listed.includes(doc.name) && names.length === listed.length && listed.every((n) => names.includes(n)), names.join(", "));
  check("dv15 is live now: the map's names come from POST /api/knowledge/graph/names (proved in verify-places17.cjs)", await page.locator('[data-act="dv15"]:not([aria-disabled="true"])').count() === 2);
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  check("nl-add is live now (words to a schedule landed with #331; proved by its own verify script)", await page.locator('[data-act="nl-add"]:not([aria-disabled="true"])').count() >= 1);
  await act(page, "ptab", { place: "customize", v: "tools" });
  await page.click('[data-act="t9-kind"][data-v="mcp"]');
  await page.click('.t9-addbtn[data-act="tool-add"]');
  await page.waitForSelector(".dlg", { timeout: 5000 });
  check("mcp-cat: not drawn (the engine keeps no connector catalogue)", await page.locator('[data-act="mcp-cat"], [data-act="mcp-add"]').count() === 0);
  await act(page, "dlg-close");
}

async function run() {
  const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
  const model = await startModel();
  const s = await setup();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    for (const step of [replay, revisions, suggestion, greyed]) {
      await page.keyboard.press("Escape").catch(() => null);
      try { await step(page, s); } catch (error) { check(`step ${step.name} ran`, false, error.message.split("\n")[0]); }
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

run().catch((e) => { console.error(e); process.exit(1); });
