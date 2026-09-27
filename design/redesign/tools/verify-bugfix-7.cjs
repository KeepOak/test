/* Bugfix 7 (the window bugs the re-pointed chat tests in PR #292 found): proves each item in the real window against a
   FRESH engine, reading every change back through the engine's own GET route. Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-7.cjs
   Checks that need a model that answers in a set way (two different answers to the same words, a long answer, an answer
   held back, a file write that stops on a question, a restart) run on in-process engines with a scripted model, each in
   its own temp folder on a free port. Stand-ins, all inside this script: the scripted models, including two stand-in
   connections registered in-process ("think-claude" as an anthropic provider, "think-local" as an ollama one, so the
   engine gives each its thinking levels); the clipboard's refusal (writeText rejects) and the selection copy
   (execCommand), replaced in the page for the failure checks. Test data: conversations it sends, a Trunk named "Verify
   Trunk" (POST /api/trunks), a memory note written in-process with store.save (the window has no route that adds one),
   and on the fresh engine the typed-commands switch, put back as it was. */
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }

function client(base, token) {
  return async (p, body) => {
    const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
}
const BASE = `http://127.0.0.1:${PORT}`;
const api = client(BASE, TOKEN);
const dist = join(__dirname, "../../../dist/");
const load = (file) => import(pathToFileURL(join(dist, file)).href);

async function signIn(context, base, token, call) {
  await call("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  const page = await context.newPage();
  const errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.url().includes("/api/")) asked.push({ method: r.method(), path: new URL(r.url()).pathname }); });
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  return { page, errors, asked };
}
const newConversation = async (page) => { await page.locator('#side [data-act="newmenu"]').click(); await page.locator('[data-act="newconv"]').click(); await page.locator("#prompt").waitFor(); };
const currentId = (page) => page.evaluate(() => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);
const toastSays = (page, words) => page.locator(".toast").filter({ hasText: words }).waitFor({ state: "attached", timeout: 8000 }).then(() => true, () => false);

/* An in-process engine with a scripted model, on a free port, cleaned up by the returned close(). */
async function scriptedEngine(provider, root = mkdtempSync(join(tmpdir(), "verify-bugfix-7-")), options = {}) {
  const { createBranch, savePolicy } = await load("index.js");
  const { startServer } = await load("server.js");
  const { saveConversationModeSettings } = await load("conversation-mode.js");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  if (options.askBeforeChanges) savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  options.before?.(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1", ...(options.presence ? { presence: options.presence } : {}) });
  const base = server.url.replace(/\/$/, "");
  const close = async (keep) => { await server.close().catch(() => {}); await app.close().catch(() => {}); if (!keep) rmSync(root, { recursive: true, force: true }); };
  return { app, server, base, call: client(base, server.token), close, root };
}

/* ---------- on the fresh engine ---------- */

/* 1: the empty conversation is the prototype's emptyChat(): the question and starting points that send themselves. */
async function emptyChat(page, asked) {
  await newConversation(page);
  const h1 = await page.locator("#main .empty-chat h1").innerText().catch(() => "");
  const chips = await page.locator('#main .empty-chat [data-act="sugg"]').allInnerTexts();
  check("1 the empty conversation asks the prototype's question", h1 === "What should Branch do?", h1);
  check("1 with the prototype's starting points, each live", chips.length === 3 && await page.locator('#main .empty-chat [data-act="sugg"].soon').count() === 0, chips.join(" | "));
  const before = asked.filter((r) => r.path === "/api/run").length;
  await page.locator('#main .empty-chat [data-act="sugg"]').first().click();
  const run = await until(async () => (await api("state")).runs.find((r) => r.prompt === chips[0]), 15000);
  check("1 a starting point sends itself (POST /api/run; GET /api/state has the task with its words)", run && asked.filter((r) => r.path === "/api/run").length === before + 1, run?.id);
  check("1 and the conversation shows it as the person's message", (await page.locator("#conversation .u").first().textContent()).trim() === chips[0]);
  await until(async () => (await page.locator("#conversation .b .txt").count()) > 0, 15000);
  return run;
}

/* 4: Copy on a reply puts its words on the clipboard; a refused clipboard copies through the selection; when both fail
   the refusal is said. */
async function copy(page, sessionId, call) {
  const reply = (await call(`sessions/${sessionId}`)).messages.filter((m) => m.role === "assistant").at(-1)?.content;
  const button = () => page.locator("#conversation .b").last().getByRole("button", { name: "Copy", exact: true });
  await page.locator("#conversation .b").last().hover();
  check("4 Copy on a reply is live (not greyed)", await button().count() === 1 && !(await button().evaluate((b) => b.classList.contains("soon"))));
  await button().click();
  const copied = await until(async () => page.evaluate(() => navigator.clipboard.readText()), 5000);
  check("4 Copy puts the reply's words on the clipboard, as GET /api/sessions/<id> has them", copied && copied.replace(/\r\n/g, "\n") === reply, JSON.stringify(copied).slice(0, 80));
  check("4 and says the prototype's words", await toastSays(page, "Copied."));
  await page.evaluate(() => { window.__sel = 0; navigator.clipboard.writeText = () => Promise.reject(new Error("Clipboard refused by the stand-in")); document.execCommand = (name) => { if (name === "copy") window.__sel += 1; return name === "copy"; }; });
  await page.evaluate(() => document.querySelector(".toast")?.remove());
  await page.locator("#conversation .b").last().hover();
  await button().click();
  check("4 a refused clipboard copies through the selection instead", await toastSays(page, "Copied.") && await page.evaluate(() => window.__sel) === 1);
  await page.evaluate(() => { document.execCommand = () => false; document.querySelector(".toast")?.remove(); });
  await page.locator("#conversation .b").last().hover();
  await button().click();
  check("4 when both fail, the clipboard's own refusal is shown", await toastSays(page, "Clipboard refused by the stand-in"));
}

/* 5: a conversation found in the side search is offered under Past sessions, reads, and carries on. */
async function pastSession(page, sessionId, word) {
  await page.locator("#side-q").fill(word);
  const row = page.locator(`#side [data-act="sr-sess"][data-v="${sessionId}"]`);
  const shown = await row.waitFor({ timeout: 10000 }).then(() => true, () => false);
  const listed = (await api("sessions?limit=50")).sessions.some((s) => s.sessionId === sessionId);
  check("5 a conversation the list shows is offered under Past sessions (POST /api/sessions/search found it)", shown && listed);
  if (!shown) return;
  await row.click();
  const words = (await api(`sessions/${sessionId}`)).messages.find((m) => m.role === "user")?.content ?? "";
  check("5 it opens to read, with its messages (GET /api/sessions/<id>)", (await page.locator(".sess9").innerText()).includes(words));
  const before = new Set((await api("sessions?limit=50")).sessions.map((s) => s.sessionId));
  await page.getByRole("button", { name: "Carry it on", exact: true }).click();
  const copyOf = await until(async () => (await api("sessions?limit=50")).sessions.find((s) => !before.has(s.sessionId)), 10000);
  const same = copyOf && (await api(`sessions/${copyOf.sessionId}`)).messages.length === (await api(`sessions/${sessionId}`)).messages.length;
  check("5 Carry it on makes the copy (POST /api/sessions/<id>/duplicate; GET shows the same messages) and opens it", same && await until(async () => (await currentId(page)) === copyOf.sessionId, 8000), copyOf?.sessionId);
}

/* 9: a slash command on the empty screen: Enter takes it from the list, the next Enter runs it; nothing goes to the model. */
async function slash(page, asked) {
  const was = (await api("commands/settings")).mode;
  await api("commands/settings", { mode: "on" }); // the typed commands ship off; put back after
  await newConversation(page);
  const runs = asked.filter((r) => r.path === "/api/run").length, ran = asked.filter((r) => r.path === "/api/commands/run").length;
  await page.locator("#prompt").fill("/help");
  await page.locator(".slash6").waitFor({ timeout: 8000 }).catch(() => {});
  await page.locator("#prompt").press("Enter");
  const picked = await page.locator("#prompt").inputValue();
  await page.locator("#prompt").press("Enter");
  const cleared = await until(async () => (await page.locator("#prompt").inputValue()) === "", 10000);
  check("9 Enter takes /help from the list (as the prototype's pickSlash), the next Enter runs it (POST /api/commands/run)", picked.startsWith("/help") && cleared && asked.filter((r) => r.path === "/api/commands/run").length > ran, JSON.stringify(picked));
  check("9 and nothing was sent to the model (no POST /api/run)", asked.filter((r) => r.path === "/api/run").length === runs);
  await api("commands/settings", { mode: was });
}

/* 7: the tool playground is live now (unhold-control; verify-unhold-control.cjs runs tools through it): Open opens the
   prototype's "Tool playground" with the engine's tools. */
async function playground(page) {
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').click();
  await page.locator('[data-act="setpage"][data-v="developer"]').first().click();
  const open = page.locator('[data-act="playground-open"]');
  await open.waitFor({ timeout: 8000 });
  check("7 Settings › Developer › Playground is live", await open.evaluate((b) => !b.classList.contains("soon")));
  await open.click();
  check("7 Open shows the Tool playground with the engine's tools (GET /api/tools/forms)",
    !!(await until(async () => (await page.locator(".dlg #play-tool option").count()) === (await api("tools/forms")).tools.length && (await page.locator(".dlg #play-tool option").count()) > 0, 8000)));
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator('[data-act="setlevel"][data-v="regular"]').click().catch(() => {});
  await page.locator(".settings .set-back").click();
  await page.locator("#prompt").waitFor();
}

/* U6: with the network gone the status bar says "Not connected" (the prototype's words), and "Connected" once back. */
async function offline(page) {
  const status = page.locator('#statusbar [data-act="machines"]');
  await page.context().setOffline(true);
  await page.evaluate(() => dispatchEvent(new Event("offline")));
  const down = await until(async () => /Not connected/.test(await status.innerText()), 15000);
  await page.context().setOffline(false);
  const up = await until(async () => /Connected/.test(await status.innerText()) && !/Not connected/.test(await status.innerText()), 15000);
  check("U6 offline, the status bar says Not connected; back online, Connected", down && up);
}

/* ---------- on scripted engines ---------- */

/* 3: comparing the task watched again with an earlier run of the same words, both read from GET /api/runs/<id>/inspect. */
async function compare(browser) {
  let round = 0;
  const e = await scriptedEngine({ name: "scripted", async complete() { round += 1; return { content: `The answer for round ${round}.\nSame second line.`, toolCalls: [] }; } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors } = await signIn(context, e.base, e.server.token, e.call);
  try {
    for (const n of [1, 2]) {
      await newConversation(page);
      await page.locator("#prompt").fill("apples");
      await page.locator("#send").click();
      await until(async () => (await page.locator("#conversation").innerText()).includes(`round ${n}`), 15000);
      await until(async () => (await e.call("state")).runs.filter((r) => r.status === "completed").length >= n, 10000);
    }
    await page.locator('#side [data-act="view"][data-v="inbox"]').click();
    await page.locator('#main [data-act="ptab"][data-place="inbox"][data-v="history"]').click();
    const pick = page.locator('#main [data-act="compare"]');
    await pick.waitFor({ timeout: 10000 });
    await pick.click();
    const dlg = page.getByRole("dialog", { name: "Two tasks side by side" });
    await dlg.locator("table.cmp6").waitFor({ timeout: 10000 });
    const runs = (await e.call("state")).runs.filter((r) => r.prompt === "apples");
    const [newer, older] = [runs[0], runs[1]];
    const [a, b] = await Promise.all([e.call(`runs/${older.id}/inspect`), e.call(`runs/${newer.id}/inspect`)]);
    const cells = await dlg.locator("table.cmp6 tbody tr").evaluateAll((rows) => rows.map((r) => [r.querySelector("th").textContent, ...[...r.querySelectorAll("td")].map((d) => d.textContent)]));
    const rounds = cells.find((c) => c[0] === "Rounds"), tools = cells.find((c) => c[0] === "Tools used");
    check("3 Compare beside Watch a task again opens Two tasks side by side", cells.map((c) => c[0]).join() === "Cost,Time,Rounds,Tools used");
    check("3 its figures are each task's own (GET /api/runs/<id>/inspect)", rounds?.[1] === String(a.rounds.length) && rounds?.[2] === String(b.rounds.length) && tools?.[1] === String(a.calls.length) && tools?.[2] === String(b.calls.length), JSON.stringify(cells));
    const del = await dlg.locator(".diff6 .d-del").allTextContents(), add = await dlg.locator(".diff6 .d-add").allTextContents();
    check("3 and the answers' difference, line by line", del.some((l) => l.includes("round 1")) && add.some((l) => l.includes("round 2")) && ![...del, ...add].some((l) => l.includes("Same second line")));
    await dlg.getByRole("button", { name: "Done", exact: true }).click();
  } catch (err) { check("3 compare checks finished", false, err.stack); }
  check("no page errors (compare engine)", errors.length === 0, errors.join(" | "));
  await context.close();
  await e.close();
}

/* 4 (Copy), 6 (web-ui :140), 9 (a new reply redraws; Page Up), 10 (Branch from here), K5 (the model menu's thinking levels) and the
   empty screen's Trunks: one engine whose model answers long, holds an answer back when asked, and has two stand-in
   connections that take thinking levels as their providers do. */
async function conversation(browser) {
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of a long answer, with enough words to take a line.`).join("\n\n");
  let release = null;
  const answer = async (request) => {
    const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    if (asked.includes("hold on")) await new Promise((r) => { release = r; });
    return { content: asked.includes("long") ? long : "A short answer.", toolCalls: [] };
  };
  const e = await scriptedEngine({ name: "scripted", complete: answer }, undefined, {
    before: (app) => {
      for (const [id, name, provider, model] of [["think-claude", "Anthropic", "anthropic", "claude-sonnet-4-5"], ["think-local", "Ollama", "ollama", "llama3.1:8b"]])
        app.runtime.models.register({ id, name, model, provider: { name: provider, complete: answer } });
      app.store.save("memory", app.runtime.owner, "verify-note", { text: "Prefer **short** answers and `npm start`, never <script>alert(1)</script>." });
    },
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: e.base });
  const trunk = (await e.call("trunks", { name: "Verify Trunk" })).trunk;
  const { page, errors } = await signIn(context, e.base, e.server.token, e.call);
  try {
    /* 1: the Trunks row of the empty screen opens the Trunk's own conversation. */
    await newConversation(page);
    const ask = page.locator(`#main .askrow [data-act="chat"][data-id="${trunk.chatSessionId}"]`);
    const listed = await ask.waitFor({ timeout: 10000 }).then(() => true, () => false);
    check("1 Or ask a Trunk: shows the Trunk (GET /api/trunks)", listed && (await ask.getAttribute("aria-label")) === "Ask Verify Trunk");
    if (listed) { await ask.click(); check("1 and opens its own conversation (its chatSessionId)", await until(async () => (await currentId(page)) === trunk.chatSessionId, 8000)); }

    /* 9: a new reply redraws the conversation; Page Up with nothing focused reads back through it. */
    await newConversation(page);
    await page.locator("#prompt").fill("a long answer please");
    await page.locator("#send").click();
    check("9 a new reply redraws the conversation", await until(async () => (await page.locator("#conversation").innerText()).includes("Paragraph 40"), 15000));
    await page.waitForTimeout(800);
    const gap = () => page.evaluate(() => { const b = document.getElementById("scroll"); return b.scrollHeight - b.scrollTop - b.clientHeight; });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("PageUp");
    await page.waitForTimeout(300);
    check("9 Page Up with the focus on the page scrolls the conversation up", (await gap()) > 80, `${await gap()} px from the bottom`);
    const sid = await currentId(page);
    await copy(page, sid, e.call);

    /* K5: the model menu offers the levels of the conversation's own model, read as it opens. */
    await e.call(`sessions/${sid}/model`, { preset: "think-claude", reasoning: null });
    const levels = (await e.call("state")).models.presets.find((p) => p.id === "think-claude").thinking.levels;
    await page.locator('#composer [data-act="modelmenu2"]').click();
    const menu = page.locator("#app > .pop");
    await menu.waitFor();
    const offered = await menu.locator('[data-act="pick-think"]').evaluateAll((n) => n.map((x) => x.dataset.v));
    check("K5 the model menu's Thinking row has the conversation's model's levels (GET /api/state presets)", JSON.stringify(offered) === JSON.stringify(levels), offered.join());
    await menu.locator('[data-act="pick-think"][data-v="medium"]').click();
    const kept = await until(async () => (await e.call(`sessions/${sid}/model`)).reasoning === "medium", 8000);
    await page.keyboard.press("Escape");
    check("K5 picking medium keeps it (GET /api/sessions/<id>/model) and the chip says so", kept && await until(async () => /claude-sonnet-4-5 · medium/.test(await page.locator('#composer [data-act="modelmenu2"] .lbl').innerText()), 8000));

    /* 10: Branch from here waits while an answer is pending; after it, the dialog starts the path. */
    await page.locator("#prompt").fill("hold on a moment");
    await page.locator("#send").click();
    await until(async () => release, 10000);
    const reply = page.locator("#conversation .b").filter({ hasText: "Paragraph 1 of" }).first();
    await reply.hover();
    check("10 while an answer is pending, Branch from here waits (disabled)", await reply.getByRole("button", { name: "Branch from here", exact: true }).isDisabled());
    release();
    await until(async () => (await page.locator("#conversation").innerText()).includes("A short answer."), 15000);
    await page.waitForTimeout(500);
    await reply.hover();
    await reply.getByRole("button", { name: "Branch from here", exact: true }).click();
    await page.getByRole("button", { name: "Start the new path", exact: true }).click();
    const moved = await until(async () => { const id = await currentId(page); return id && id !== sid ? id : null; }, 10000);
    const paths = moved ? (await e.call(`sessions/${sid}/paths`)).paths ?? [] : [];
    check("10 Branch from here › Start the new path makes the path (POST /api/sessions/<id>/branch; GET …/paths lists both) and opens it",
      moved && paths.some((p) => p.sessionId === moved) && paths.some((p) => p.sessionId === sid), `${paths.length} paths`);

    /* 6 (:140): a saved note keeps its inline formatting in Library › Memory and cannot carry markup. */
    await page.locator('#side [data-act="view"][data-v="library"]').click();
    await page.locator('#main [data-act="ptab"][data-place="library"][data-v="memory"]').click();
    const card = page.locator("#main .prow").filter({ hasText: "answers" }).first();
    await card.waitFor({ timeout: 10000 });
    const note = (await e.call("state")).memory.find((m) => m.id === "verify-note" || m.data?.text?.includes("short"));
    check("6 a memory note (GET /api/state memory) keeps its bold and code in Library › Memory", note && await card.locator("strong").innerText() === "short" && await card.locator("code").innerText() === "npm start");
    check("6 and its <script> stays words, never an element", await card.locator("script").count() === 0 && /<script>/.test(await card.innerText()));
  } catch (err) { check("conversation checks finished", false, err.stack); }
  check("no page errors (conversation engine)", errors.length === 0, errors.join(" | "));
  await context.close();
  await e.close();
}

/* 2: a task a restart cut off while it waited on a question: the prototype's card, Pick it up and Leave it, each through
   the engine's own route. */
async function cutOff(browser) {
  const writer = { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    const named = /^write (\S+)/.exec(String(request.messages.findLast((m) => m.role === "user")?.content ?? ""));
    const again = last?.role === "tool" && /"status":"interrupted"/.test(String(last.content));
    if (named && (last?.role === "user" || again)) return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named[1], content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
  const first = await scriptedEngine(writer, undefined, { askBeforeChanges: true });
  const a = await first.app.runtime.run({ prompt: "write a.txt" }), b = await first.app.runtime.run({ prompt: "write b.txt" });
  await first.close(true);
  const e = await scriptedEngine(writer, first.root, { askBeforeChanges: true, presence: "app" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors } = await signIn(context, e.base, e.server.token, e.call);
  try {
    const attention = (await e.call("state")).attention;
    check("2 after a real restart both tasks are cut off and can be carried on (GET /api/state attention)", [a, b].every((r) => attention.some((x) => x.runId === r.id && x.canContinue)), `${a.status}/${b.status}`);
    await page.locator('#side [data-act="view"][data-v="inbox"]').click();
    await page.locator('#main [data-act="ptab"][data-place="inbox"][data-v="needs"]').click();
    const card = (words) => page.locator("#main .cut15").filter({ hasText: words });
    const shown = await card("write a.txt").waitFor({ timeout: 10000 }).then(() => true, () => false);
    check("2 Inbox shows the prototype's card for each: Pick up what the update cut off, Leave it, Pick it up",
      shown && await card("write b.txt").count() === 1 && (await card("write a.txt").innerText()).includes("Pick up what the update cut off"));
    await card("write a.txt").getByRole("button", { name: "Leave it", exact: true }).click();
    const left = await until(async () => (await e.call("state")).runs.find((r) => r.id === a.id)?.status === "cancelled", 10000);
    check("2 Leave it stops it (POST /api/runs/<id>/cancel; GET /api/state: cancelled) and its card goes", left && await until(async () => (await card("write a.txt").count()) === 0, 8000));
    await card("write b.txt").getByRole("button", { name: "Pick it up", exact: true }).click();
    // Carried on as a new task in the same conversation, which stops on the question again.
    const picked = await until(async () => (await e.call("state")).runs.some((r) => r.sessionId === b.sessionId && r.id !== b.id && r.status === "needs_input") && (await e.call("policy")).waiting.some((q) => q.sessionId === b.sessionId), 15000);
    const where = await until(async () => (await currentId(page)) === b.sessionId, 8000);
    const st = (await e.call("state")).runs.filter((r) => r.sessionId === b.sessionId).map((r) => r.status).join(), q = (await e.call("policy")).waiting.filter((x) => x.sessionId === b.sessionId).length;
    check("2 Pick it up carries it on (POST /api/runs/<id>/resume): it asks its question again (GET /api/policy)", picked && where, `runs ${st}, questions ${q}, open ${await currentId(page)} want ${b.sessionId}`);
  } catch (err) { check("cut-off checks finished", false, err.stack); }
  check("no page errors (restart engine)", errors.length === 0, errors.join(" | "));
  await context.close();
  await e.close();
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors, asked } = await signIn(context, BASE, TOKEN, api);
  try {
    const run = await emptyChat(page, asked);
    if (run) await pastSession(page, run.sessionId, run.prompt.split(" ")[2]);
    await slash(page, asked);
    await playground(page);
    await offline(page);
  } catch (e) { check("fresh-engine checks finished", false, e.stack); }
  check("no page errors (fresh engine)", errors.length === 0, errors.join(" | "));
  await context.close();
  await compare(browser);
  await conversation(browser);
  await cutOff(browser);
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
