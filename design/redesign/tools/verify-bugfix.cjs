// Proves each window bug fixed on claude/rw4-bugfix against a real engine: every check drives the real window and reads
// the result back from the engine's own GET route (or, for a window-only behaviour, from the window's DOM). Page errors
// are recorded and must be zero.
//
// Tasks that ask for a yes, Trunks that answer, a plan and a failure need a model that does those things, so this script
// runs a small OpenAI-shaped model on this computer (MODEL_PORT, default 43366) and the engine is started pointing at it:
//   BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> \
//   BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:43366/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify \
//   node dist/cli.js start
//   PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix.cjs
// It changes the engine (a policy rule, Trunks, a room, a person, the dashboard switch, the step limit) and puts back what
// it read first where it can. The phone check runs apps/mobile/scripts/build-web.mjs (never a native build); it needs
// `npm ci` in apps/mobile once.
const http = require("node:http");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const MODEL_PORT = Number(process.env.MODEL_PORT || 43366);
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = path.resolve(__dirname, "../../..");
const wire = (name) => "branch_" + createHash("sha256").update(name).digest("hex").slice(0, 24);
const PLAN = '{"steps":[{"title":"Read the notes","touches":"notes.txt","changes":false},{"title":"Write the summary","touches":"summary.txt","changes":true}]}';

/* ---------- the model on this computer ---------- */
const model = { asked: 0, held: [] };
const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
function reply(body) {
  const msgs = body.messages ?? [], last = msgs.at(-1);
  const system = msgs.filter((m) => m.role === "system").map(textOf).join("\n");
  const user = textOf([...msgs].reverse().find((m) => m.role === "user"));
  const who = /\nYou are ([^(\n]+) \(@/.exec(system)?.[1]?.trim();
  if (/You are planning a task/.test(system)) return { content: PLAN };
  if (last?.role === "tool") return { content: "Written." };
  if (/^\[Room/.test(user) && who === "Ledger")
    return { tool: { name: "files.write", arguments: { path: "totals.csv", content: "x" } } };
  if (/^\[Room/.test(user)) return { content: `${who} here, in the room.` };
  /* Asked to write, it calls files.write whenever the conversation's newest message is the person's (a yes carried on
     reads "Yes, go ahead." and the call is made again, now allowed). */
  const write = msgs.filter((m) => m.role === "user").map((m) => /\bwrite (\w+)/.exec(textOf(m))).filter(Boolean).at(-1);
  if (write && last?.role === "user" && !/^\[Room/.test(user)) return { tool: { name: "files.write", arguments: { path: `${write[1]}.txt`, content: write[1] } } };
  if (/please fail/.test(user)) return { fail: "The verify model refuses this one on purpose." };
  if (/hold on/.test(user) && last?.role === "user") return { hold: true, content: "Held and done." };
  return { content: who ? `${who} here.` : `Answered: ${user.slice(0, 40)}` };
}
function respond(res, body, r) {
  const message = r.tool ? { role: "assistant", content: null, tool_calls: [{ id: `c${Date.now()}`, type: "function", function: { name: wire(r.tool.name), arguments: JSON.stringify(r.tool.arguments) } }] } : { role: "assistant", content: r.content };
  const finish = message.tool_calls ? "tool_calls" : "stop", usage = { prompt_tokens: 10, completion_tokens: 5 };
  if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = message.tool_calls ? { tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) } : { content: message.content };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
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
        model.asked += 1;
        const r = reply(body);
        if (r.fail) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: r.fail } })); return; }
        if (r.hold) { model.held.push(() => respond(res, body, r)); return; }
        respond(res, body, r);
      });
    });
    server.on("error", fail);
    server.listen(MODEL_PORT, "127.0.0.1", () => ready(server));
  });
}

/* ---------- the engine ---------- */
async function call(route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${route}: ${r.status} ${data.error ?? ""}`), { status: r.status });
  return data;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, ms = 20000) {
  for (let t = 0; t < ms; t += 250) { const v = await test().catch(() => null); if (v) return v; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function section(name, fn, page) {
  try { await fn(); } catch (error) {
    check(`${name}: ran to the end`, false, error.message.split("\n")[0]);
    if (process.env.DEBUG && page) console.log("  conversation:", (await page.locator("#conversation").innerText().catch(() => "")).slice(-400).replace(/\n/g, " | "));
  }
}

/* ---------- the window ---------- */
async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}
/* Moves between views the way the window routes a click (for getting somewhere, not for the control under test). */
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
async function newConversation(page) {
  await act(page, "newconv");
  await page.locator("#prompt").waitFor();
}
async function send(page, text) {
  await page.locator("#prompt").fill(text);
  await page.locator("#prompt").press("Enter");
}
const openSessionId = (page) => page.evaluate(() => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);

const lastReply = (page) => page.evaluate(() => [...document.querySelectorAll("#conversation .b")].at(-1)?.textContent ?? "");

/* ---------- 4: one answer per approval card ---------- */
async function approvalOnce(page) {
  const seen = [];
  let failNext = false;
  await page.route("**/api/policy/approve", async (route) => {
    seen.push(route.request().postDataJSON()?.decision);
    if (failNext) { failNext = false; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Refused by the verify script" }) }); return; }
    await sleep(1500);
    await route.continue();
  });
  await newConversation(page);
  await send(page, "write alpha");
  const card = page.locator("#live-ask");
  await card.waitFor({ timeout: 30000 });
  await card.locator(".btn.pri").dblclick();
  await card.locator('[data-act="ask"][data-v="deny"]').click({ force: true }).catch(() => undefined);
  await page.locator("#conversation").getByText("Written.").waitFor({ timeout: 30000 });
  check("4 approval: a double tap and a Don't allow send one answer", seen.length === 1 && seen[0] === "allow", `requests: ${JSON.stringify(seen)}`);
  const sid = await openSessionId(page), waitingHere = async () => (await call("policy")).waiting.filter((w) => w.sessionId === sid).length;
  check("4 approval: that one answer was the yes, and nothing waits in this conversation", (await waitingHere()) === 0);
  seen.length = 0;
  failNext = true;
  await send(page, "write beta");
  await card.waitFor({ timeout: 30000 });
  await card.locator(".btn.pri").click();
  await until("the refusal to come back", async () => seen.length === 1);
  await sleep(400);
  const again = await page.evaluate(() => [...document.querySelectorAll("#live-ask button")].filter((b) => !b.getAttribute("aria-disabled")).every((b) => !b.disabled));
  check("4 approval: after an error the card's buttons work again", again);
  await page.locator("#live-ask .btn.pri").click();
  await page.locator("#conversation").getByText("Written.").nth(1).waitFor({ timeout: 30000 });
  check("4 approval: the second press after the error is answered", seen.length === 2 && (await waitingHere()) === 0, JSON.stringify(seen));
  await page.unroute("**/api/policy/approve");
}

/* ---------- 9: every live-looking field is live; the step limit is the engine's ---------- */
async function unmarkedFields(page) {
  return page.evaluate(async () => {
    const { isLive } = await import("/app/core/features.js");
    return [...document.querySelectorAll("#app input, #app select, #app textarea")]
      .filter((el) => !el.readOnly && el.type !== "hidden" && !el.disabled && !el.closest(".lockscreen"))
      .filter((el) => !isLive("sw:" + (el.id || el.dataset.sw)))
      .map((el) => el.id || el.getAttribute("aria-label") || el.outerHTML.slice(0, 60));
  });
}
async function fieldsSweep(page) {
  const views = [["chat"], ["overview"], ["inbox", "history"], ["automations", "scheduled"], ["library"], ["team"], ["customize", "channels"]];
  const fakes = new Set();
  for (const [v, tab] of views) {
    await act(page, tab ? "ptab" : "view", tab ? { place: v, v: tab } : { v });
    for (const f of await unmarkedFields(page)) fakes.add(`${v}: ${f}`);
  }
  await act(page, "view", { v: "settings" });
  await act(page, "setlevel", { v: "technical" });
  const pages = await page.$$eval('[data-act="setpage"]', (b) => b.map((x) => x.dataset.v));
  for (const p of pages) { await act(page, "setpage", { v: p }); await sleep(300); for (const f of await unmarkedFields(page)) fakes.add(`settings/${p}: ${f}`); }
  check("9 greyOut: no enabled field anywhere is unmarked (nothing looks live that saves nothing)", fakes.size === 0, [...fakes].slice(0, 6).join("; "));
  await act(page, "setpage", { v: "permissions" });
  const rate = await page.locator('input[aria-label="Messages per conversation per hour"]').first();
  check("9 greyOut: an unread number box is greyed (Messages per conversation per hour)", (await rate.count()) && await rate.isDisabled());
  await act(page, "ptab", { place: "inbox", v: "history" });
  check("9 greyOut: the history search box that searches nothing is greyed", await page.locator("#histq").isDisabled());
}
async function stepLimit(page) {
  const before = (await call("knobs")).values.limits.maxSteps;
  await act(page, "view", { v: "settings" });
  await act(page, "setlevel", { v: "advanced" });
  await act(page, "setpage", { v: "models" });
  const box = page.locator("#m-steps");
  await box.waitFor({ timeout: 10000 });
  check("9 models: Most steps in one task shows the engine's value", Number(await box.inputValue()) === before, `window ${await box.inputValue()}, engine ${before}`);
  await box.fill(String(before + 1));
  await box.dispatchEvent("change");
  await until("the step limit to save", async () => (await call("knobs")).values.limits.maxSteps === before + 1);
  check("9 models: changing it saves through POST /api/knobs", (await call("knobs")).values.limits.maxSteps === before + 1);
  await call("knobs", { card: "limits", values: { maxSteps: before } });
  await act(page, "setlevel", { v: "regular" });
}

/* ---------- 10: slash commands carry out the engine's answer ---------- */
async function slashGo(page) {
  const catalog = (await call("commands/settings")).mode;
  await call("commands/settings", { mode: "on" });
  try { await slashGoOn(page); } finally { await call("commands/settings", { mode: catalog }); }
}
async function slashGoOn(page) {
  const answer = await call("commands/run", { surface: "window", line: "/go inbox history" });
  check("10 /go: the engine answers do go with a home", answer.handled && answer.client?.do === "go", JSON.stringify(answer.client));
  await newConversation(page);
  await send(page, "/go inbox history");
  await page.locator('#main .place [data-act="ptab"][data-v="history"][aria-selected="true"]').waitFor({ timeout: 10000 });
  check("10 /go inbox history opens Inbox › History", true);
  await newConversation(page);
  await send(page, "/settings appearance");
  await page.locator('[data-act="setpage"][data-v="appearance"][aria-current="true"]').waitFor({ timeout: 10000 });
  check("10 /settings appearance opens Settings › Appearance", true);
}

/* ---------- 11: dictation is the engine's ---------- */
async function dictation(page) {
  const state = await call("voice/dictation");
  await newConversation(page);
  const mic = page.locator('.composer button[aria-label="Dictate into the box"]');
  await mic.waitFor();
  await sleep(800);
  if (state.canDictate === false) {
    const why = state.refusal || state.engine?.how || "";
    const drawn = await mic.evaluate((b) => ({ off: b.getAttribute("aria-disabled"), tip: b.dataset.tip, act: b.dataset.act ?? null }));
    check("11 dictation: canDictate false greys the mic with the engine's own words", drawn.off === "true" && drawn.tip === why && !drawn.act, `tip: ${String(drawn.tip).slice(0, 60)}`);
  } else {
    check("11 dictation: canDictate true leaves the mic live (data-act=dict)", (await mic.getAttribute("data-act")) === "dict");
  }
  const code = fs.readFileSync(path.join(REPO, "public/app/chat/dictate.js"), "utf8");
  check("11 dictation: the browser recording path is gone (no MediaRecorder, no voice/transcribe)", !/MediaRecorder|voice\/transcribe/.test(code));
}

/* ---------- 13: the side conversation keeps the newest pick ---------- */
async function besideNewest(page) {
  const a = await call("run", { prompt: "alpha words for beside" }), b = await call("run", { prompt: "bravo words for beside" });
  const c = await call("run", { prompt: "the one open in the middle" });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.evaluate(async () => { const { refresh } = await import("/app/core/state.js"); await refresh(); });
  await act(page, "chat", { id: c.sessionId });
  await page.route(`**/api/sessions/${a.sessionId}`, async (route) => { await sleep(2000); await route.continue(); });
  await act(page, "beside15", { v: a.sessionId });
  await act(page, "beside15", { v: b.sessionId });
  await sleep(3000);
  const shown = await page.locator(".beside15 .thread").innerText().catch(() => "");
  check("13 beside: a slow read for the earlier pick does not replace the newest", /bravo words/.test(shown) && !/alpha words/.test(shown), shown.slice(0, 60));
  await page.unroute(`**/api/sessions/${a.sessionId}`);
  await act(page, "beside15", { v: "" });
}

/* ---------- 14: a view closes the phone's list; 16: settings search says No page matches. ---------- */
async function phoneList(page) {
  await page.setViewportSize({ width: 375, height: 812 });
  await act(page, "view", { v: "chat" });
  await page.locator('[data-act="side"]:visible').first().click();
  check("14 phone: the list slides in", await page.evaluate(() => document.getElementById("app").classList.contains("side-open")));
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await sleep(500);
  const state = await page.evaluate(() => ({ open: document.getElementById("app").classList.contains("side-open"), hit: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest(".settings") != null }));
  check("14 phone: Settings from the list closes it, and Settings takes the clicks", !state.open && state.hit, JSON.stringify(state));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#set-q").fill("zzqq no such page");
  await page.locator(".set-nav").getByText("No page matches.").waitFor({ timeout: 5000 });
  check("16 settings search: nothing found says No page matches.", true);
  await page.locator("#set-q").fill("");
}

/* ---------- 17: a redraw keeps the focused control and the caret ---------- */
async function keepsFocus(page) {
  await newConversation(page);
  await page.locator("#prompt").fill("hello world, still typing");
  await page.locator("#prompt").evaluate((box) => { box.focus(); box.setSelectionRange(5, 8); });
  await call("trunks/switch", { part: "trunks", mode: "on" });
  await call("trunks", { name: `Focus ${Date.now() % 10000}`, title: "Makes an engine event" });
  await sleep(2000);
  const typed = await page.evaluate(() => ({ id: document.activeElement?.id, from: document.activeElement?.selectionStart, to: document.activeElement?.selectionEnd }));
  check("17 focus: the message box keeps focus and its selection across an engine event", typed.id === "prompt" && typed.from === 5 && typed.to === 8, JSON.stringify(typed));
  await page.locator('#side [data-act="newmenu"]').focus();
  await call("trunks", { name: `Focus again ${Date.now() % 10000}`, title: "Another event" });
  await sleep(2000);
  const button = await page.evaluate(() => document.activeElement?.dataset?.act ?? document.activeElement?.tagName);
  check("17 focus: a focused button in the side list keeps focus across an engine event", button === "newmenu", String(button));
}

/* ---------- Trunks: rooms, @name, signed replies, a room member's yes answered once ---------- */
const S = {};
async function trunksFixture() {
  for (const part of ["trunks", "conversations", "rooms"]) await call("trunks/switch", { part, mode: "on" });
  S.scout = (await call("trunks", { name: "Scout", title: "Finds things" })).trunk;
  S.ledger = (await call("trunks", { name: "Ledger", title: "Keeps the books" })).trunk;
  S.room = (await call("trunks/rooms", { name: `Price check ${Date.now() % 100000}`, members: [S.scout.id, S.ledger.id] })).room;
}
const signedBy = (page) => page.evaluate(() => { const b = [...document.querySelectorAll("#conversation .b")].filter((x) => x.querySelector(".txt")).at(-1); return { face: !!b?.querySelector(".gut .av:not(.brand)"), from: b?.querySelector(".from")?.textContent ?? "" }; });
async function trunksAnswer(page) {
  await trunksFixture();
  await page.evaluate(async () => { const { refresh } = await import("/app/core/state.js"); await refresh(); });
  await newConversation(page);
  await send(page, "hello there");
  await until("the first reply", async () => /Answered/.test(await lastReply(page)));
  await send(page, `@${S.scout.handle} has the price moved?`);
  await until("Scout to answer here", async () => /Scout here\./.test(await lastReply(page)), 30000);
  const sid = await openSessionId(page);
  const info = await call(`trunks/conversations/${sid}`);
  check("5 @name: Scout answers in this conversation from now on (kind trunk)", info.kind === "trunk" && info.trunk?.id === S.scout.id, info.kind);
  check("11 signed: Scout's reply carries Scout's face", (await signedBy(page)).face);
  await act(page, "chat", { id: S.room.sessionId });
  await send(page, `@${S.scout.handle} what is the price?`);
  await until("Scout to answer in the room", async () => /Scout here, in the room\./.test(await page.locator("#conversation").innerText()), 30000);
  const room = await call(`trunks/rooms/${S.room.id}`);
  check("5 rooms: the room's message went to the room (POST /api/trunks/rooms/<id>/send)", room.events.some((e) => e.kind === "user" && /what is the price/.test(e.text)) && room.events.some((e) => e.kind === "member"));
  const sign = await signedBy(page);
  check("11 signed: a room reply carries the Trunk's face and name, without the @handle prefix", sign.face && sign.from === "Scout" && !/@scout:/i.test(await lastReply(page)), JSON.stringify(sign));
}
async function roomYesOnce(page) {
  const seen = [];
  await page.route(`**/api/trunks/rooms/${S.room.id}/answer`, async (route) => { seen.push(route.request().postDataJSON()?.decision); await sleep(1500); await route.continue(); });
  await send(page, `@${S.ledger.handle} write the totals`);
  const card = page.locator('#live-ask [data-act="room-ask"]').first();
  await card.waitFor({ timeout: 30000 });
  await card.dblclick();
  await page.locator('#live-ask [data-act="room-ask"][data-v="deny"]').first().click({ force: true }).catch(() => undefined);
  await until("the room to carry on", async () => /Written\./.test(await page.locator("#conversation").innerText()), 30000);
  check("5 rooms: a room member's yes is answered once for that request (POST .../answer)", seen.length === 1 && seen[0] === "allow", JSON.stringify(seen));
  await page.unroute(`**/api/trunks/rooms/${S.room.id}/answer`);
}

/* ---------- 6: typed while it works, the message goes through busy send ---------- */
async function busySend(page) {
  await call("flows-boards/switch", { part: "waiting-line", mode: "on" });
  await newConversation(page);
  const sent = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/flows-boards/busy/send")) sent.push(r.postDataJSON()); });
  await send(page, "hold on for a moment");
  await until("the model to hold the reply", async () => model.held.length === 1);
  await page.locator("#prompt").fill("and this one after");
  await page.locator("#prompt").press("Enter");
  await until("busy send", async () => sent.length === 1);
  const sid = sent[0].sessionId;
  const line = await call(`sessions/${sid}/followups`);
  check("6 busy: a message typed while it works goes to the waiting line (POST /api/flows-boards/busy/send)", sent[0].prompt === "and this one after" && line.followUps.length === 1, JSON.stringify(line.followUps.map((f) => f.prompt)));
  model.held.shift()();
  await until("the queued message to be answered", async () => /Answered: and this one after/.test(await page.locator("#conversation").innerText()), 30000);
  check("6 busy: the queued message runs after the task and its answer shows", true);
}

/* ---------- 8: the plan a task waits on; 9-run: a failed task's words ---------- */
async function planAndFailure(page) {
  await newConversation(page);
  await page.locator('[data-act="modemenu2"]').click();
  await page.locator('.pop [data-act="set-mode"][data-v="plan"]').click();
  await send(page, "summarise my notes");
  const plan = page.locator("#conversation ul.plan");
  await plan.waitFor({ timeout: 30000 });
  const items = (await plan.locator("li").allInnerTexts()).map((x) => x.trim());
  const run = (await call("state")).runs.find((r) => r.status === "needs_input");
  const engine = run ? (await call(`runs/${run.id}/plan`)).plan?.steps?.map((s) => s.title) : [];
  check("8 plan first: the plan the task waits on is drawn, as GET /api/runs/<id>/plan has it", JSON.stringify(items) === JSON.stringify(engine) && items.length === 2, JSON.stringify(items));
  await newConversation(page);
  await send(page, "please fail this one");
  await until("the task to fail", async () => (await call("state")).runs.some((r) => r.prompt === "please fail this one" && r.status === "failed"));
  const failed = (await call("state")).runs.find((r) => r.prompt === "please fail this one");
  await until("the failure words", async () => (await page.locator("#conversation").innerText()).includes(String(failed.output).trim().slice(0, 30)));
  check("9 failed run: the engine's words for the failure show in the conversation", true, String(failed.output).slice(0, 60));
}

/* ---------- 5, N1, N12: the person using Branch ---------- */
async function whoIsHere(page) {
  const owner = (await call("profiles")).roleLabels?.owner?.label ?? "";
  const person = await call("profiles", { name: "Verify Person", pin: "2468" });
  await call(`trunks/rooms/${S.room.id}`, { people: [person.id] });
  const secret = "Owner-only words for the verify script.";
  await call("settings-kit/files", { slot: "memory", text: secret });
  await act(page, "view", { v: "settings" });
  await act(page, "setpage", { v: "instructions" });
  await page.locator('[data-act="if-open"][data-f="memory"]').click();
  await until("the owner's editor", async () => (await page.locator("#if-text").inputValue()).includes(secret));
  try {
    await call("profiles/switch", { profileId: person.id, pin: "2468" });
    await until("the window to notice the switch", async () => (await page.locator("#side .owner .who14 b").innerText()) === "Verify Person", 20000);
    check("5 person button: on another person's profile it names that person", true);
    const view = await page.evaluate((s) => ({ editor: !!document.querySelector("#if-text"), text: document.body.innerText.includes(s) || [...document.querySelectorAll("textarea")].some((b) => b.value.includes(s)) }), secret);
    check("N1 switch: the owner-only editor and its words are gone for the household person", !view.editor && !view.text, JSON.stringify(view));
    await act(page, "view", { v: "settings" });
    const listed = await page.$$eval('[data-act="setpage"]', (b) => b.map((x) => x.dataset.v));
    check("N1 switch: Instructions and Saved sign-ins are not listed for the household person", !listed.includes("instructions") && !listed.includes("secrets"), listed.join(","));
    await act(page, "view", { v: "overview" });
    check("5 overview: Who is using Branch names that person", /Verify Person/.test(await page.locator(".tile", { hasText: "Who is using Branch" }).innerText()));
    check("N12 rooms: the household person's room has a row in the list", await page.locator(`#side .list [data-act="chat"][data-id="${S.room.sessionId}"]`).count() === 1);
  } finally {
    await call("profiles/switch", { profileId: null });
    await until("the owner again", async () => (await page.locator("#side .owner .who14 b").innerText()) === owner, 20000).catch(() => undefined);
    await call(`profiles/${person.id}/remove`, {}).catch(() => undefined);
  }
  check("5 person button: back on the owner's profile it names the owner", (await page.locator("#side .owner .who14 b").innerText()) === owner, owner);
}

/* ---------- 19: one #main ---------- */
async function oneMain(page) {
  const counts = [];
  for (const v of ["overview", "inbox", "automations", "library", "team", "customize"]) {
    await act(page, "view", { v });
    counts.push(await page.evaluate(() => [document.querySelectorAll("#main").length, document.querySelectorAll("main").length]));
  }
  check("19 places: each place leaves one #main and one <main>", counts.every(([ids, mains]) => ids === 1 && mains === 1), JSON.stringify(counts));
}

/* ---------- 8: the dashboard, and its links back into the window ---------- */
async function dashboard(page, context) {
  const before = (await call("dashboard/settings")).mode;
  await call("dashboard/settings", { mode: "on" });
  try {
    const html = await (await fetch(`${BASE}/dashboard`)).text();
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]).filter((p) => p !== "/");
    const status = await Promise.all(refs.map(async (p) => [p, (await fetch(BASE + p)).status]));
    check("8 dashboard: GET /dashboard and every file it links answer 200", status.every(([, s]) => s === 200), status.filter(([, s]) => s !== 200).map((x) => x.join(" ")).join(", "));
    const dash = await context.newPage();
    const errors = [];
    dash.on("pageerror", (e) => errors.push(e.message));
    await dash.goto(BASE + "/");
    await dash.evaluate((t) => sessionStorage.setItem("branch-token", t), TOKEN);
    await dash.goto(BASE + "/dashboard");
    await dash.locator("#db-grid").waitFor({ state: "visible", timeout: 20000 });
    check("8 dashboard: the page starts, reads /api/dashboard and draws its cards, with no page error", errors.length === 0, errors.join("; "));
    const sid = (await call("run", { prompt: "a conversation the dashboard links to" })).sessionId;
    await dash.goto(`${BASE}/#open=${sid}`);
    await dash.waitForFunction((id) => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id === id, sid, { timeout: 20000 });
    check("17 links: /#open=<conversation id> opens that conversation", true);
    await dash.goto(`${BASE}/#open=inbox:history`);
    await dash.locator('#main .place [data-act="ptab"][data-v="history"][aria-selected="true"]').waitFor({ timeout: 20000 });
    check("17 links: /#open=inbox:history opens Inbox › History", true);
    await dash.close();
  } finally {
    await call("dashboard/settings", { mode: before });
  }
}

/* ---------- 7: the phone's web build completes and every file it names is in it ---------- */
function phoneBuild() {
  const app = path.join(REPO, "apps/mobile");
  if (!fs.existsSync(path.join(app, "node_modules/jsqr"))) { check("7 phone: build-web (run npm ci in apps/mobile first)", false, "apps/mobile/node_modules is missing"); return; }
  const run = spawnSync(process.execPath, [path.join(app, "scripts/build-web.mjs")], { cwd: app, encoding: "utf8" });
  check("7 phone: apps/mobile/scripts/build-web.mjs completes", run.status === 0, (run.stderr || run.stdout).trim().split("\n").at(-1));
  const www = path.join(app, "www"), missing = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(www).filter((f) => /\.(js|html|css)$/.test(f) && !f.includes("vendor"))) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:from\s+|import\(\s*|(?:src|href)=)["'](\/[^"']+)["']|url\(["']?(\/[^"')]+)/g)) {
      const ref = (m[1] || m[2]).split("?")[0];
      if (!fs.existsSync(path.join(www, ref))) missing.push(`${path.relative(www, f)} -> ${ref}`);
    }
  }
  check("7 phone: every import, link and font the built page names is in www/", missing.length === 0, missing.join(", "));
}

/* ---------- the shell and accounts port's leftovers ---------- */
async function shellLeftovers(page) {
  await act(page, "view", { v: "settings" });
  const order = await page.$$eval('[data-act="setpage"]', (b) => b.map((x) => x.dataset.v));
  check("3 settings: Accounts comes right after Models, as in the prototype", order.indexOf("accounts") === order.indexOf("models") + 1, order.join(","));
  for (const [w, h] of [[390, 844], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await act(page, "view", { v: "chat" });
    await sleep(500);
    await page.locator('[data-act="usagepop"]').first().click({ force: true });
    await page.locator(".pop").waitFor();
    const box = await page.evaluate(() => { const p = document.querySelector(".pop").getBoundingClientRect(), c = document.querySelector("#composer").getBoundingClientRect(); return { over: p.left < c.right && p.right > c.left && p.top < c.bottom && p.bottom > c.top, inside: p.top >= 0 && p.bottom <= innerHeight && p.left >= 0 && p.right <= innerWidth }; });
    check(`5 popover at ${w}px: the usage popover stays in the window and off the message box`, !box.over && box.inside, JSON.stringify(box));
    await page.keyboard.press("Escape");
  }
  await page.keyboard.press("Control+.");
  const focused = await page.evaluate(() => document.getElementById("app").classList.contains("focus"));
  await page.locator("body").press("Escape");
  const left = await page.evaluate(() => !document.getElementById("app").classList.contains("focus"));
  check("6 Escape: Escape leaves Focus mode", focused && left, JSON.stringify({ focused, left }));
  const pane = page.locator('.head [data-act="pane"][data-p="activity"]').first();
  const was = await pane.getAttribute("aria-pressed");
  await pane.click();
  const now = await pane.getAttribute("aria-pressed");
  await pane.click();
  check("8 side panel: the header button's aria-pressed follows the panel", was === "false" && now === "true" && (await pane.getAttribute("aria-pressed")) === "false", `${was} → ${now}`);
  const asked = [];
  page.on("request", (r) => { if (/\/api\/search\?q=/.test(r.url())) asked.push(decodeURIComponent(r.url().split("q=")[1])); });
  await page.locator("#side-q").fill("s");
  await sleep(700);
  await page.locator("#side-q").fill("sc");
  await sleep(900);
  check("11 search: one letter is not sent to the engine; two are", !asked.includes("s") && asked.includes("sc"), JSON.stringify(asked));
  /* One conversation whose two messages share a word: the engine finds it more than once, the list shows it once. */
  const first = await call("run", { prompt: "quokkaword the first time" });
  await call("run", { prompt: "quokkaword the second time", sessionId: first.sessionId });
  const hits = (await call("search?q=quokkaword")).results.filter((h) => h.kind === "conversation");
  await page.locator("#side-q").fill("quokkaword");
  await until("message rows", async () => (await page.locator("#side .list .sr-row.msg9").count()) > 0, 10000).catch(() => undefined);
  const rows = await page.$$eval("#side .list .sr-row.msg9", (b) => b.map((x) => x.dataset.id));
  check("11 search: each conversation's messages are listed once", rows.length >= 1 && rows.length === new Set(rows).size, `engine hits ${hits.length}, rows ${rows.length}`);
  await page.locator("#side-q").fill("");
}

async function main() {
  const server = await startModel();
  const policy = (await call("policy")).policy;
  await call("policy", { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...(policy.rules ?? [])] });
  await call("run", { prompt: "is the model there" });
  if (!model.asked) throw new Error(`The engine did not ask the model on port ${MODEL_PORT}. Start it with BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:${MODEL_PORT}/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify.`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  const steps = [["4", approvalOnce], ["9 fields", fieldsSweep], ["9 steps", stepLimit], ["10", slashGo], ["11", dictation], ["13", besideNewest],
    ["14/16", phoneList], ["17", keepsFocus], ["19", oneMain], ["trunks", trunksAnswer], ["rooms yes", roomYesOnce], ["6", busySend],
    ["8/9", planAndFailure], ["5/N1/N12", whoIsHere], ["322", shellLeftovers], ["8 dashboard", (p) => dashboard(p, context)]];
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  for (const [name, fn] of steps.filter(([n]) => !only || only.includes(n))) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await section(name, () => fn(page), page);
  }
  if (!only || only.includes("7")) phoneBuild();
  check("zero page errors in the window", errors.length === 0, errors.slice(0, 3).join(" | "));
  await call("policy", policy).catch(() => undefined);
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} of ${results.length} checks failed` : `${results.length} passed, 0 failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
