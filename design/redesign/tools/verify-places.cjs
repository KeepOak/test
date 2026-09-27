// Verifies the places/team/achievements area against a real engine: clicks every control the area made live and checks,
// through the engine's own GET routes, that the change really happened. Records every page error.
//
// A few things can only exist after Branch was closed on them (a task it can continue, a goal it was driving) or be filed
// from a chat app (a request to change Branch itself), so the run has three steps against a FRESH data folder:
//   1. engine running:  PORT=<port> TOKEN=<hex> DATA=<data folder> node design/redesign/tools/verify-places.cjs prepare
//   2. engine stopped:  node design/redesign/tools/verify-places.cjs seed <data folder>
//   3. engine running:  PORT=<port> TOKEN=<hex> DATA=<data folder> node design/redesign/tools/verify-places.cjs
// Step 1 makes real tasks and goals through the engine and writes verify-places.json into the data folder; step 2 edits
// only what an API cannot make: it marks two finished tasks "interrupted" (what the engine does at start to a task that
// was running when it closed), one "needs_input", the two goals "working" (Branch closed while driving them), and files
// one request to change Branch as a chat app's /improve would. Step 3 does the rest through the engine's routes.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || "3325";
const TOKEN = process.env.TOKEN || "";
const BASE = `http://127.0.0.1:${PORT}`;
const NOTE = path.join(process.env.DATA || process.argv[3] || ".", "verify-places.json");

async function call(method, route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const get = (route) => call("GET", route);
const post = (route, body = {}) => call("POST", route, body);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function settled(sessionId) {
  for (let i = 0; i < 60; i++) {
    const g = (await get(`sessions/${sessionId}/goal`)).goal;
    if (g && g.status !== "working") return g;
    await sleep(500);
  }
  throw new Error("goal never settled");
}

/* Step 1: real tasks and goals, through the engine. */
async function prepare() {
  const cut = [];
  for (const prompt of ["First task Branch will be closed on", "Second task Branch will be closed on"]) cut.push((await post("run", { prompt })).id);
  const waiting = (await post("run", { prompt: "A task that stops to ask you" })).id;
  await post("goal-undo/settings", { goal: "on", snapshots: "off" });
  const goals = [];
  for (const objective of ["Write a haiku about oak trees", "List three colours"]) {
    const g = await post("goals", { objective, maxRounds: 6 });
    await settled(g.sessionId);
    goals.push(g.sessionId);
  }
  fs.writeFileSync(NOTE, JSON.stringify({ cut, waiting, goals }, null, 2));
  console.log("prepared:", NOTE);
}

/* Step 2, engine stopped: Branch "closed" on the two tasks and while driving the two goals; one request from a chat app. */
function seed(dir) {
  const { DatabaseSync } = require("node:sqlite");
  const note = JSON.parse(fs.readFileSync(path.join(dir, "verify-places.json"), "utf8"));
  const db = new DatabaseSync(path.join(dir, "branch.sqlite"));
  // What the engine itself does at start to a task that was running when Branch closed (src/store.ts).
  for (const id of note.cut) db.prepare("UPDATE tasks SET status='interrupted' WHERE id=?").run(id);
  // A task that stopped to ask the owner, so Team › Live now has a row to draw.
  db.prepare("UPDATE tasks SET status='needs_input' WHERE id=?").run(note.waiting);
  for (const sid of note.goals) {
    const row = db.prepare("SELECT data FROM settings WHERE id=?").get(`goal:${sid}`);
    const goal = JSON.parse(String(row.data));
    db.prepare("UPDATE settings SET data=? WHERE id=?").run(JSON.stringify({ ...goal, status: "working", reason: "", activeSince: Date.now() }), `goal:${sid}`);
  }
  const owner = String(db.prepare("SELECT owner FROM tasks LIMIT 1").get().owner);
  note.request = { id: require("node:crypto").randomUUID(), text: "Skip files that are open when tidying Downloads" };
  db.prepare("INSERT INTO self_development_requests(id, owner, text, sender, status, created_at, answer) VALUES(?,?,?,?,?,?,NULL)")
    .run(note.request.id, owner, note.request.text, JSON.stringify({ channel: "telegram", chatId: "1", senderId: "1", senderName: "Verifier", messageId: "1" }), "waiting", new Date().toISOString());
  db.close();
  fs.writeFileSync(path.join(dir, "verify-places.json"), JSON.stringify(note, null, 2));
  console.log("seeded:", dir);
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
  await sleep(400);
}

/* Engine-side setup that needs no restart. */
async function seedLive() {
  await post("flows-boards/switch", { part: "kanban", mode: "on" });
  const card = (await post("flows-boards/board/cards", { title: "Renew the car insurance", notes: "Before it runs out" })).card;
  const jsonl = [
    { id: "fact-dup-a", data: { text: "The archive folder is Downloads/Archive" } },
    { id: "fact-dup-b", data: { text: "The archive folder is in Downloads/Archive" } },
    { id: "fact-city-a", data: { text: "Home city: Paris", validFrom: "2024-01-01T00:00:00.000Z" } },
    { id: "fact-city-b", data: { text: "Home city: Lyon", validFrom: "2025-01-01T00:00:00.000Z" } },
  ].map((l) => JSON.stringify(l)).join("\n");
  await post("memory/import", { jsonl });
  await post("memory/settings", { review: false, requireApproval: true, consolidateDaily: false });
  const keep = await post("action", { tool: "memory.put", args: { text: "Prefers tea in the afternoon", source: "verify" } });
  const drop = await post("action", { tool: "memory.put", args: { text: "Likes loud music", source: "verify" } });
  await post("memory/settings", { review: false, requireApproval: false, consolidateDaily: false });
  await post("delight/settings", { achievements: { on: true } });
  await post("action", { tool: "procedures.propose", args: { name: "Find last month's invoices", preconditions: [], steps: [{ tool: "memory.search", args: { query: "invoice" }, expected: {} }, { tool: "files.list", args: { path: "." }, expected: {} }] } });
  await post("prompts/settings", { mode: "on" });
  await post("prompts", { title: "Weekly review", body: "Tell me what got done this week.", group: "Planning", command: "weekly" });
  return { card, keep: keep.proposalId, drop: drop.proposalId };
}

async function signIn(page) {
  await call("POST", "onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#main", { timeout: 15000 });
  await sleep(1500);
}

async function board(page, live) {
  await act(page, "ptab", { place: "automations", v: "board" });
  await page.waitForSelector(`[data-card15="${live.card.id}"]`, { timeout: 8000 });
  await page.click(`[data-card15="${live.card.id}"] [data-act="bmove15"]`);
  await page.click(`.pop [data-act="bto15"][data-v="doing"]`);
  await sleep(800);
  const lanes = (await get("flows-boards/board")).lanes;
  check("bmove15/bto15: card moved to Doing (GET /api/flows-boards/board)", lanes.doing.some((c) => c.id === live.card.id));
  check("board: the card shows under Doing", await page.locator(`[data-col15="doing"] [data-card15="${live.card.id}"]`).count() === 1);
}

async function ideas(page) {
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  await page.click('[data-act="ideas15"]');
  const cards = await page.locator('.dlg [data-act="idea15"]').count();
  check("ideas15: the ideas dialog lists all 13", cards === 13, String(cards));
  await page.click('.dlg [data-act="idea15"][data-i="3"]');
  const value = await page.inputValue("#nl-in");
  check("idea15: the Scheduled box holds the idea's words", value === "every weekday at 7:30, send me the weather, my calendar and what needs me");
  await act(page, "ptab", { place: "automations", v: "procedures" });
  await sleep(800);
  const saved = (await get("prompts")).prompts;
  const rows = await page.locator('[data-act="prompt-use"]').count();
  check("saved prompts: one row per prompt the engine keeps (GET /api/prompts)", rows === Math.min(3, saved.length) && rows > 0, String(rows));
  const recipe = (await get("state")).procedures.find((p) => p.data?.definition?.name === "Find last month's invoices");
  // The row's Open button opens the recipe (as the prototype draws it, round 4); the row shows its name and status.
  const open = page.locator(`[data-act="flow"][data-id="${recipe.id}"]`);
  const row = page.locator(".prow", { has: open });
  check("procedures: the row shows the recipe's own name and status", (await row.textContent()).includes("Find last month's invoices") && (await row.textContent()).includes(recipe.data.status));
  await open.click();
  await page.waitForSelector(".dlg .flow-row", { timeout: 5000 });
  const steps = await page.locator(".dlg .flow-row input").evaluateAll((els) => els.map((e) => e.value));
  check("procedures (flow): the row opens the recipe with its real steps", steps.length === 2 && steps[0].startsWith("memory.search") && steps[1].startsWith("files.list"), steps.join(" | "));
  await act(page, "dlg-close");
}

async function tidy(page) {
  await act(page, "ptab", { place: "library", v: "memory" });
  await sleep(800);
  const found = await get("memory/tidy");
  const n = found.duplicates.length + found.contradictions.length + found.leastUseful.length;
  const shown = await page.locator('[data-act="tidy15"] .n15').textContent().catch(() => "");
  check("tidy15: the count is the engine's findings (GET /api/memory/tidy)", n > 0 && shown === String(n), `${shown} vs ${n}`);
  const archivedBefore = (await get("memory/archive")).archived.length;
  await page.click('[data-act="tidy15"]');
  await page.waitForSelector(".dlg .td-row15", { timeout: 8000 });
  const rows = await page.locator(".dlg .td-row15").count();
  const pending = (await get("memory/proposals")).proposals.filter((p) => p.source === "Suggested while tidying memory");
  check("tidy15: one row per staged suggestion (GET /api/memory/proposals)", rows === pending.length && rows > 0, `${rows} rows`);
  const merge = pending.find((p) => p.kind === "merge");
  await page.click(`.dlg [data-td15="${merge.id}"] [data-act="tidydo15"]:not([data-x])`);
  await sleep(800);
  const archivedAfter = (await get("memory/archive")).archived;
  check("tidydo15 (Merge them): the dropped fact is set aside (GET /api/memory/archive)", archivedAfter.length > archivedBefore && merge.memoryIds.every((id) => archivedAfter.some((a) => a.id === id)));
  const other = pending.find((p) => p.id !== merge.id);
  await page.click(`.dlg [data-td15="${other.id}"] [data-act="tidydo15"][data-x]`);
  await sleep(800);
  const still = (await get("memory/proposals")).proposals.some((p) => p.id === other.id);
  const memory = (await get("state")).memory.map((m) => m.id);
  check("tidydo15 (Leave it): the suggestion is declined and its facts stay", !still && other.memoryIds.every((id) => memory.includes(id)));
  await act(page, "dlg-close");
}

async function exports(page) {
  await page.click('[data-act="memmore15"]');
  const [jsonl] = await Promise.all([page.waitForEvent("download"), page.click('.pop [data-act="memexp15"]:not([data-v])')]);
  const saved = fs.readFileSync(await jsonl.path(), "utf8");
  const engine = await (await fetch(`${BASE}/api/memory/export?format=jsonl`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
  check("memexp15 (JSON Lines): saved as the engine names it, with the engine's lines", jsonl.suggestedFilename() === "memory.jsonl" && saved === engine, jsonl.suggestedFilename());
  await page.click('[data-act="memmore15"]');
  const [full] = await Promise.all([page.waitForEvent("download"), page.click('.pop [data-act="memexp15"][data-v="archive"]')]);
  const archive = JSON.parse(fs.readFileSync(await full.path(), "utf8"));
  const engineArchive = await get("memory/export");
  check("memexp15 (full archive): the engine's archive, named by its format", full.suggestedFilename() === "branch-agent-memory.json" && archive.records.length === engineArchive.records.length, full.suggestedFilename());
}

async function archive(page) {
  await page.click('[data-act="memmore15"]');
  await page.click('.pop [data-act="memarch15"]');
  await page.waitForSelector(".dlg", { timeout: 5000 });
  const archived = (await get("memory/archive")).archived;
  const rows = await page.locator('.dlg [data-act="memarch15"][data-id]').count();
  check("memarch15: the archive lists what the engine archived (GET /api/memory/archive)", rows === archived.length && rows > 0, String(rows));
  const id = archived[0].id;
  await page.click(`.dlg [data-act="memarch15"][data-id="${id}"]`);
  await sleep(800);
  const after = (await get("memory/archive")).archived.some((a) => a.id === id);
  const back = (await get("state")).memory.some((m) => m.id === id);
  check("memarch15 (Restore): the fact is back in memory", !after && back);
  check("memarch15: Purge all is live now (it landed on redesign/window; proved by its own verify script)", await page.locator('.dlg [data-act="memarch15"][data-v="purge"]:not([aria-disabled="true"])').count() === 1);
  await act(page, "dlg-close");
}

async function inbox(page, note) {
  await act(page, "ptab", { place: "inbox", v: "needs" });
  await sleep(1200);
  const cards = await page.locator(".cut15").count();
  const canContinue = (await get("state")).attention.filter((a) => a.canContinue);
  check("cut15: one card per task Branch can continue (state.attention)", cards === canContinue.length && cards === 2, String(cards));
  const [leave, pick] = note.cut;
  await page.click(`[data-act="cutno15"][data-id="${leave}"]`);
  await sleep(800);
  check("cutno15: the task is ended (GET /api/runs/<id>)", (await get(`runs/${leave}`)).run.status === "cancelled");
  const session = (await get(`runs/${pick}`)).run.sessionId;
  await page.click(`[data-act="cutgo15"][data-id="${pick}"]`);
  await sleep(3000);
  const st = await get("state");
  const newer = st.runs.find((r) => r.sessionId === session && r.id !== pick);
  check("cutgo15: the task carries on in its conversation (a new task there, card gone)", Boolean(newer) && !st.attention.some((a) => a.runId === pick));
  check("cutgo15: its conversation is open", await page.evaluate(() => Boolean(document.querySelector("#conversation"))));

  await act(page, "ptab", { place: "inbox", v: "needs" });
  await sleep(1200);
  const waiting = (await get("self-development/requests")).requests.filter((r) => r.status === "waiting");
  check("selfrev15: one card per waiting request (GET /api/self-development/requests)", await page.locator(".self15").count() === waiting.length && waiting.length === 1);
  await page.click(`[data-act="selfrev15"][data-id="${note.request.id}"]`);
  const body = await page.locator(".dlg").textContent();
  check("selfrev15: the review shows the request as it was sent", body.includes(note.request.text));
  check("selfdo15: Decline and Approve stay greyed", await page.locator('.dlg [data-act="selfdo15"][aria-disabled="true"]').count() === 2);
  await act(page, "dlg-close");
}

async function verify(page) {
  await act(page, "setlevel", { v: "technical" });
  await act(page, "ptab", { place: "inbox", v: "history" });
  await sleep(1000);
  await page.click('[data-act="verify15"]');
  await sleep(1200);
  const check1 = (await post("safety-extras/activity/verify")).check;
  const title = await page.locator("#ver-t15").textContent();
  const sub = await page.locator("#ver-s15").textContent();
  check("verify15: the dialog says what the engine's check found", title === (check1.ok ? "Record intact" : check1.reason) && (!check1.ok || sub.includes(check1.reason)), title);
  check("verify15: the chain head shows at the Technical level", sub.includes(check1.tip.slice(0, 4)) && sub.includes("sha-256"));
  await act(page, "dlg-close");
  await act(page, "setlevel", { v: "regular" });
  const text = await page.locator(".place").first().textContent();
  check("history: no raw ids in the rows", !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(text));
}

async function remember(page, live) {
  const runs = (await get("state")).runs;
  const proposals = (await get("memory/proposals")).proposals;
  const sid = runs.find((r) => r.id === proposals.find((p) => p.id === live.keep).runId).sessionId;
  await act(page, "chat", { id: sid });
  await sleep(1500);
  check("mem: the conversation asks about each suggestion its tasks made", await page.locator('#conversation [data-act="mem"][data-v="kept"]').count() >= 1);
  const keepSid = sid;
  await page.click(`#conversation [data-act="mem"][data-id="${live.keep}"][data-v="kept"]`);
  await sleep(800);
  const memory = (await get("state")).memory;
  check("mem (Remember): the fact is in memory and no longer waiting", memory.some((m) => m.data.text === "Prefers tea in the afternoon") && !(await get("memory/proposals")).proposals.some((p) => p.id === live.keep));
  check("mem: the answer shows as Remembered", (await page.locator("#conversation .decided").textContent().catch(() => "")).includes("Remembered"));
  const dropSid = runs.find((r) => r.id === proposals.find((p) => p.id === live.drop).runId).sessionId;
  if (dropSid !== keepSid) { await act(page, "chat", { id: dropSid }); await sleep(1500); }
  await page.click(`#conversation [data-act="mem"][data-id="${live.drop}"][data-v="forgot"]`);
  await sleep(800);
  check("mem (Don't): the suggestion is turned down and nothing is saved", !(await get("memory/proposals")).proposals.some((p) => p.id === live.drop) && !(await get("state")).memory.some((m) => m.data.text === "Likes loud music"));
}

async function goals(page, note) {
  const [resumeSid, stopSid] = note.goals;
  await act(page, "chat", { id: resumeSid });
  await sleep(1500);
  check("goal strip: shows the engine's paused goal", (await page.locator(".goal6").textContent().catch(() => "")).includes("Write a haiku about oak trees"));
  await page.click('.goal6 [data-act="goal-st"][data-v="resume"]');
  await sleep(600);
  const resumed = (await get(`sessions/${resumeSid}/goal`)).goal;
  check("goal-st (Resume): the goal is no longer paused (GET /api/sessions/<id>/goal)", resumed.status !== "paused", resumed.status);
  await settled(resumeSid).catch(() => null);
  await act(page, "chat", { id: stopSid });
  await sleep(1500);
  await page.click('.goal6 [data-act="goal-st"][data-v="stop"]');
  await sleep(600);
  const stopped = (await get(`sessions/${stopSid}/goal`)).goal;
  check("goal-st (Stop): the goal is stopped", stopped.status === "stopped", stopped.status);
  check("goal strip: gone once the goal has stopped", await page.locator(".goal6").count() === 0);
  await page.click('[data-act="plusmenu"]');
  await page.click('.pop [data-act="goal-fill"]');
  check("goal-fill: the message box holds /goal", (await page.inputValue("#prompt")) === "/goal ");
}

async function achievements(page) {
  for (let i = 0; i < 250; i++) await post("delight/noticed", { what: "pat" });
  await act(page, "setgo", { v: "achievements" });
  await sleep(1500);
  const view = await get("delight/achievements");
  check("achievements: every achievement the engine lists is drawn", await page.locator(".achs .ach").count() === view.list.length);
  check("achievements: the lede says earned of total", (await page.locator(".set-col .lede").textContent()).includes(`${view.earned} of ${view.total} unlocked`));
  await page.click('[data-act="achcat"][data-v="Pets"]');
  await sleep(300);
  check("achcat: the Pets tab shows only the engine's Pets", await page.locator(".achs .ach").count() === view.list.filter((a) => a.kind === "Pets").length);
  const big = await page.waitForSelector(".ach-big", { timeout: 25000 }).catch(() => null);
  const shown = big ? await page.locator(".ach-big b").textContent() : "";
  check("celebration: a real unlock shows the big card", Boolean(big) && view.fresh.some((a) => a.name === shown), shown);
  if (big) {
    await page.click('.ach-big [data-act="ach-close"]');
    const told = !(await get("delight/achievements")).fresh.some((a) => a.name === shown);
    check("ach-close: Nice closes it, and the engine was told (not fresh any more)", await page.locator(".ach-big").count() === 0 && told);
  }
}

async function team(page) {
  await act(page, "setgo", { v: "people" });
  await sleep(800);
  await page.click('[data-act="p-open-team"][data-v="groups"]');
  await sleep(500);
  check("p-open-team: opens Team on the Groups tab", await page.locator('[data-act="ptab"][data-place="team"][data-v="groups"][aria-selected="true"]').count() === 1);
  await act(page, "ptab", { place: "team", v: "live" });
  await sleep(600);
  const st = await get("state");
  const profiles = await get("profiles");
  const person = profiles.profiles.find((p) => p.id === profiles.active)?.name || profiles.roleLabels.owner.label;
  const live = st.runs.filter((r) => r.status === "running" || r.status === "needs_input");
  const rows = await page.locator(".run6").count();
  const liveText = await page.locator(".runs6").first().textContent();
  check("team live: one row per task working or waiting (state.runs)", rows === live.length && rows > 0, String(rows));
  check("team live: the person here and This computer · Branch <version>", liveText.includes(person) && liveText.includes(`This computer · Branch ${st.version}`));
  check("team live: the task's own words, no raw id and no made-up label", liveText.includes("A task that stops to ask you") && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(liveText) && !liveText.includes("Task"));
  await act(page, "ptab", { place: "team", v: "people" });
  // Team › People is the prototype's peopleTab (pass 10c), whose invite is p-invite, the same list as Settings › People.
  // unhold/people: live now; adding somebody through it is proved in verify-unhold-people.cjs.
  check("p-invite (Team › People) is live", await page.locator('#main .place [data-act="p-invite"]:not([aria-disabled="true"])').count() === 1);
  await act(page, "view", { v: "overview" });
  await sleep(800);
  check("invite is live (proved in verify-unhold-people.cjs)", await page.locator('#main [data-act="invite"]:not([aria-disabled="true"])').count() === 1);
  await act(page, "ptab", { place: "library", v: "documents" });
  check("dv15 is live now (proved in verify-places17.cjs)", await page.locator('[data-act="dv15"]:not([aria-disabled="true"])').count() === 2);
}

async function run() {
  const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
  const note = JSON.parse(fs.readFileSync(NOTE, "utf8"));
  const live = await seedLive();
  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    for (const step of [board, ideas, tidy, exports, archive, (p) => inbox(p, note), verify, (p) => remember(p, live), (p) => goals(p, note), achievements, team]) {
      await page.keyboard.press("Escape").catch(() => null);
      try { await step(page, live); } catch (error) { check(`step ${step.name || "inline"} ran`, false, error.message.split("\n")[0]); }
    }
  } finally {
    check("zero page errors", errors.length === 0, errors.join(" | "));
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const mode = process.argv[2];
if (mode === "prepare") prepare().catch((e) => { console.error(e); process.exit(1); });
else if (mode === "seed") seed(process.argv[3]);
else run().catch((e) => { console.error(e); process.exit(1); });
