// Verifies the conversation leftovers (round 3) against a running engine: every control this area made live is clicked in
// the real window, and the change is confirmed through the engine's own GET route.
// Run: PORT=<port> TOKEN=<hex> DATA_DIR=<the engine's BRANCH_DATA_DIR> node design/redesign/tools/verify-conversation-3.cjs
// Use a throwaway engine (fresh BRANCH_DATA_DIR, a BRANCH_WORKSPACE outside any git checkout, the offline demo provider).
// Test fixtures, said plainly: the conversations holding a workspace.checkpoint or gateway.propose tool call are imported
// through POST /api/sessions/import (the demo model never calls those tools), and the gateway suggestion is written as
// gateway.proposed.json in DATA_DIR, as the gateway.propose tool would. The routes under test are the real ones: snapshot
// restore, proposal accept and discard, and the rest below. What the script changes is read first and put back at the end,
// except "Don't ask again", which the engine keeps for good (that is its job).
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { readFileSync, writeFileSync, rmSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, DATA_DIR = process.env.DATA_DIR;
if (!PORT || !TOKEN || !DATA_DIR) { console.error("PORT, TOKEN and DATA_DIR are required"); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);

async function api(path, body, method) {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error || ""}`);
  return data;
}
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await pause(250); }
}

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .side-nav", { timeout: 15000 });
}
async function openChat(page, sid) {
  await page.locator(`#side [data-act="chat"][data-id="${sid}"]`).waitFor({ timeout: 10000 });
  await page.locator(`#side [data-act="chat"][data-id="${sid}"]`).click();
  await page.locator("#conversation").waitFor();
  await pause(400);
}
async function importChat(messages) {
  const archive = { format: "branch-agent-conversation", version: 1, exportedAt: new Date().toISOString(), messages };
  return (await api("sessions/import", archive)).sessionId;
}

/* ---------- rec: the recommendation bar ---------- */
async function verifyRec(page) {
  const bar = (await api("deployment/suggestion")).bar;
  check("setup: the engine suggests a bar", bar === "updates", `bar ${bar}`);
  const recbar = page.locator("#main .recbar");
  await recbar.waitFor({ timeout: 10000 });
  check("rec bar drawn over the conversation, in the engine's words", (await recbar.innerText()).includes("Keep Branch up to date by itself?"));
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  check("rec bar drawn in Inbox", await page.locator("#main .recbar").isVisible());
  await page.locator('#side [data-act="view"][data-v="overview"]').click();
  check("rec bar drawn in Overview", await page.locator("#main .recbar").isVisible());
  await page.locator('#main .recbar [data-act="rec"][data-v="later"]').click();
  check("rec Not now hides the bar for this window", await until(async () => (await page.locator("#main .recbar").count()) === 0));
  await page.reload(); await page.waitForSelector("#side .side-nav");
  await page.locator('#side [data-act="view"][data-v="overview"]').click();
  await page.locator("#main .recbar").waitFor({ timeout: 10000 });
  check("rec bar is back after the window opens again", true);
  await page.locator('#main .recbar [data-act="rec"][data-v="yes"]').click();
  const after = await until(async () => { const c = await api("comfort"); return c.values.notify.autoUpdate === "install" && c; });
  const nowBar = (await api("deployment/suggestion")).bar;
  check("rec Yes turns on installing updates when idle", !!after && nowBar === null, `GET comfort notify.autoUpdate ${after && after.values.notify.autoUpdate}; GET suggestion ${nowBar}`);
  check("rec bar gone once the engine stops suggesting it", await until(async () => (await page.locator("#main .recbar").count()) === 0));
  await api("comfort", { card: "notify", values: { autoUpdate: "off" } });
  await page.reload(); await page.waitForSelector("#side .side-nav");
  await page.locator('#side [data-act="view"][data-v="overview"]').click();
  await page.locator("#main .recbar").waitFor({ timeout: 10000 });
  await page.locator('#main .recbar [data-act="rec"][data-v="never"]').click();
  const never = await until(async () => (await api("deployment/suggestion")).bar === null);
  check("rec Don't ask again is kept by the engine", !!never, "GET suggestion bar null with autoUpdate off");
}

/* ---------- ckpt: a checkpoint in the thread ---------- */
async function verifyCheckpoint(page, editorWas) {
  const file = `verify-${stamp}.txt`;
  await api("workspace-editor/settings", { mode: "on" });
  try {
    const first = await api("workspace-editor/save", { path: file, content: "before\n", opened: null });
    const snap = await api("history/snapshots", { label: `before tidying ${stamp}` });
    const opened = (await api(`workspace-editor/read?path=${encodeURIComponent(file)}`)).opened;
    await api("workspace-editor/save", { path: file, content: "after\n", opened });
    check("setup: the file changed after the point was kept", (await api(`workspace-editor/read?path=${encodeURIComponent(file)}`)).content === "after\n", `saved ${first.path || file}`);
    const sid = await importChat([
      { role: "user", content: `tidy ${stamp}` },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "workspace.checkpoint", arguments: JSON.stringify({ label: snap.label }) }] },
      { role: "tool", toolCallId: "c1", content: JSON.stringify({ ok: true, result: snap }) },
      { role: "assistant", content: `done ${stamp}` },
    ]);
    await page.reload(); await page.waitForSelector("#side .side-nav");
    await openChat(page, sid);
    const block = page.locator("#conversation .ckpt");
    await block.waitFor({ timeout: 10000 });
    check("ckpt block shows the engine's label", (await block.innerText()).includes(snap.label));
    await block.locator('[data-act="ckpt"]').click();
    const back = await until(async () => (await api(`workspace-editor/read?path=${encodeURIComponent(file)}`)).content === "before\n");
    check("ckpt Put it all back writes the kept files back", !!back, "GET workspace-editor/read -> \"before\"");
    check("ckpt block says what came back", /Put back: all \d+ files are where they were/.test(await block.innerText()), await block.innerText());
    return sid;
  } finally {
    await api("workspace-editor/settings", { mode: editorWas });
  }
}

/* ---------- self-apply / self-no: a change to Branch itself ---------- */
/* The suggestion as the gateway.propose tool would write it, and a conversation holding the call that made it. */
function propose(config, delta, ok) {
  writeFileSync(join(DATA_DIR, "gateway.proposed.json"), JSON.stringify({ config, why: `verify ${stamp} ${delta}`, proposedAt: new Date().toISOString(),
    check: { ok, detail: ok ? "started cleanly" : "the throwaway engine did not answer" } }));
}
function proposalChat(holdSeconds, delta) {
  return importChat([
    { role: "user", content: `restart slower ${stamp} ${delta}` },
    { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "gateway.propose", arguments: JSON.stringify({ change: { holdSeconds }, why: `verify ${stamp} ${delta}` }) }] },
    { role: "tool", toolCallId: "g1", content: JSON.stringify({ ok: true, result: { waitingForOwner: true } }) },
    { role: "assistant", content: `suggested ${stamp} ${delta}` },
  ]);
}
async function verifySelf(page) {
  const view = await api("never-break");
  const sid = await proposalChat(view.config.holdSeconds + 7, 7);
  propose({ ...view.config, holdSeconds: view.config.holdSeconds + 7 }, 7, true);
  await page.reload(); await page.waitForSelector("#side .side-nav");
  await openChat(page, sid);
  const card = page.locator("#conversation .self10");
  await card.waitFor({ timeout: 10000 });
  const text = await card.innerText();
  check("self card shows the change now and after", text.includes("holdSeconds") && text.includes(String(view.config.holdSeconds + 7)), text.replace(/\s+/g, " ").slice(0, 160));
  await card.locator('[data-act="self-apply"]').click();
  const applied = await until(async () => { const v = await api("never-break"); return v.proposal === null && v.config.holdSeconds === view.config.holdSeconds + 7 && v; });
  const toast = await page.locator(".toast").innerText().catch(() => "");
  check("self-apply saves the change for the next start", !!applied, `GET never-break holdSeconds ${applied && applied.config.holdSeconds}, proposal null; toast "${toast}"`);
  check("self-apply says the engine's own words", toast.includes("next time Branch starts"));
  check("self card gone once nothing waits", await until(async () => (await card.count()) === 0));

  const second = await proposalChat(view.config.holdSeconds + 9, 9);
  propose({ ...view.config, holdSeconds: view.config.holdSeconds + 9 }, 9, true);
  await page.reload(); await page.waitForSelector("#side .side-nav");
  await openChat(page, sid);
  await pause(800);
  check("an older suggestion's conversation does not claim the newer one", (await card.count()) === 0);
  await openChat(page, second);
  await card.waitFor({ timeout: 10000 });
  await card.locator('[data-act="self-no"]').click();
  const discarded = await until(async () => { const v = await api("never-break"); return v.proposal === null && v.config.holdSeconds === view.config.holdSeconds + 7 && v; });
  check("self-no discards the change and changes nothing", !!discarded, "GET never-break proposal null, holdSeconds unchanged");

  const third = await proposalChat(view.config.holdSeconds + 11, 11);
  propose({ ...view.config, holdSeconds: view.config.holdSeconds + 11 }, 11, false);
  await page.reload(); await page.waitForSelector("#side .side-nav");
  await openChat(page, third);
  await card.waitFor({ timeout: 10000 });
  check("a change that did not start cleanly offers no Apply and says why", (await card.locator('[data-act="self-apply"]').count()) === 0 && (await card.innerText()).includes("did not answer"));
  await card.locator('[data-act="self-no"]').click();
  await until(async () => (await api("never-break")).proposal === null);
}

/* ---------- who answers ---------- */
async function verifyWho(page, sid, trunk) {
  await openChat(page, sid);
  await pause(600);
  await page.locator('[data-act="plusmenu"]').click();
  const rows = page.locator('.pop [data-act="who"]');
  await rows.first().waitFor({ timeout: 10000 });
  check("who lists Branch and the engine's Trunks", (await rows.count()) >= 2 && (await page.locator(".pop").innerText()).includes(trunk.name));
  await page.locator(`.pop [data-act="who"][data-v="${trunk.id}"]`).click();
  const chosen = await until(async () => (await api(`trunks/conversations/${sid}`)).trunk?.id === trunk.id);
  check("who makes the Trunk answer this conversation", !!chosen, `GET trunks/conversations -> ${trunk.name}`);
  await page.locator('[data-act="plusmenu"]').click();
  check("who shows the Trunk as chosen", (await page.locator(`.pop [data-act="who"][data-v="${trunk.id}"]`).getAttribute("aria-checked")) === "true");
  await page.locator('.pop [data-act="who"][data-v=""]').click();
  const mine = await until(async () => (await api(`trunks/conversations/${sid}`)).trunk === null);
  check("who gives the conversation back to Branch", !!mine, "GET trunks/conversations -> trunk null");
}

/* ---------- teach ---------- */
async function verifyTeach(page, trunk) {
  const before = (await api("workflows")).workflows.length;
  await page.locator('#side [data-act="view"][data-v="automations"]').click();
  await page.locator('#main [data-act="ptab"][data-v="procedures"]').click();
  await page.locator('#main [data-act="teach-start"]').click();
  await page.locator(`.pop [data-act="teach-start"][data-id="${trunk.id}"]`).click();
  const bar = page.locator(".bar.teach");
  await bar.waitFor({ timeout: 10000 });
  const watching = await until(async () => (await api(`trunks/${trunk.id}`)).watching);
  check("teach-start makes the Trunk watch and shows the bar", !!watching && (await bar.innerText()).includes(`${trunk.name} is watching and learning.`), `GET trunks/{id} watching ${watching}`);
  check("teach-stop waits until a task is done", await bar.locator('[data-act="teach-stop"]').isDisabled());
  await page.locator("#prompt").fill(`teach task ${stamp}`);
  await page.locator("#send").click();
  // A new conversation starts on Ask first, so the demo task's file writes wait for a yes, given here one by one.
  const ready = await until(async () => {
    const allow = page.locator('#live-ask [data-act="ask"][data-v="allow"]');
    if (await allow.count()) await allow.click().catch(() => {});
    return !(await bar.locator('[data-act="teach-stop"]').isDisabled());
  }, 30000);
  check("the bar follows the new conversation, and the task done can be saved", !!ready);
  await bar.locator('[data-act="teach-stop"]').click();
  const taught = await until(async () => { const t = (await api(`trunks/${trunk.id}`)); return t.trunk.taught.length === 1 && t.watching === null && t; });
  const flows = (await api("workflows")).workflows.length;
  // The yes carries the task on as a new task in the same conversation; the newest finished one there is the lesson.
  const runs = (await api("state")).runs, asked = runs.find((r) => r.prompt === `teach task ${stamp}`);
  const lesson = runs.filter((r) => asked && r.sessionId === asked.sessionId && r.status === "completed")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  check("teach-stop gives the Trunk the task as a workflow", !!taught && flows === before + 1, `GET trunks/{id} taught ${taught && taught.trunk.taught.map((x) => x.name).join(", ")}; GET workflows ${before} -> ${flows}`);
  check("teach-stop names the task done in that conversation", !!taught && !!lesson && taught.trunk.taught[0].runId === lesson.id, `taught runId ${taught && taught.trunk.taught[0].runId}`);
  check("the bar is gone once saved", await until(async () => (await page.locator(".bar.teach").count()) === 0));
}

/* ---------- the Working row ---------- */
async function verifyWorking(page) {
  const policy = (await api("policy")).policy;
  await api("policy", { ...policy, limits: { ...policy.limits, toolCallsPerMinute: 1 } });
  let sid = null;
  try {
    const running = api("run", { prompt: `slow task ${stamp}` }).catch(() => null);
    const run = await until(async () => (await api("state")).runs.find((r) => r.prompt === `slow task ${stamp}` && r.status === "running"));
    sid = run && run.sessionId;
    const row = page.locator(`#side [data-act="chat"][data-id="${sid}"][data-running="true"]`);
    await row.waitFor({ timeout: 10000 });
    check("a conversation with a task running reads Working in the list", (await row.innerText()).includes("Working"), (await row.innerText()).replace(/\s+/g, " "));
    await api(`runs/${run.id}/cancel`, {});
    await running;
    check("and stops once the task stops", await until(async () => (await page.locator(`#side [data-act="chat"][data-id="${sid}"][data-running="true"]`).count()) === 0));
  } finally {
    await api("policy", policy);
  }
}

(async () => {
  const saved = {
    onboarding: (await api("onboarding").catch(() => ({}))).done === true,
    autoUpdate: (await api("comfort")).values.notify.autoUpdate,
    editor: (await api("workspace-editor/settings")).mode,
    trunks: (await api("trunks")).modes || {},
    gateway: existsSync(join(DATA_DIR, "gateway.json")) ? readFileSync(join(DATA_DIR, "gateway.json"), "utf8") : null,
  };
  let browser = null, trunk = null;
  const errors = [];
  try {
    await api("onboarding", { done: true });
    await api("comfort", { card: "notify", values: { autoUpdate: "off" } });
    await api("trunks/switch", { part: "trunks", mode: "on" });
    await api("trunks/switch", { part: "conversations", mode: "on" });
    await api("trunks/switch", { part: "teach", mode: "on" });
    trunk = (await api("trunks", { name: `Verify ${stamp}`, title: "Checks who answers" })).trunk;
    const plain = await api("run", { prompt: `who answers ${stamp}` });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page);
    await verifyRec(page);
    await verifyCheckpoint(page, saved.editor);
    await verifySelf(page);
    await page.reload(); await page.waitForSelector("#side .side-nav");
    await verifyWho(page, plain.sessionId, trunk);
    await verifyTeach(page, trunk);
    await verifyWorking(page);
    check("no page errors", errors.length === 0, errors.join(" | "));
  } catch (error) {
    check("script ran to the end", false, error.message);
  } finally {
    if (browser) await browser.close();
    await api("comfort", { card: "notify", values: { autoUpdate: saved.autoUpdate } }).catch((e) => console.log("restore updates:", e.message));
    if (trunk) await api(`trunks/${trunk.id}/remove`, {}).catch((e) => console.log("remove Trunk:", e.message));
    for (const part of ["teach", "conversations", "trunks"]) await api("trunks/switch", { part, mode: saved.trunks[part] ?? "off" }).catch((e) => console.log(`restore ${part}:`, e.message));
    if (saved.gateway === null) rmSync(join(DATA_DIR, "gateway.json"), { force: true }); else writeFileSync(join(DATA_DIR, "gateway.json"), saved.gateway);
    rmSync(join(DATA_DIR, "gateway.proposed.json"), { force: true });
    if (!saved.onboarding) console.log("note: onboarding was left done (the engine has no route to undo it)");
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
