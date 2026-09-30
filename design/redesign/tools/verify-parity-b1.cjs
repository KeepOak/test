// Parity B1 (briefs/PARITY.md, batch B1: the conversation and the composer): clicks every B1 control with the mouse, as
// a set-up owner (a stand-in model) and as a brand-new owner (no model), and confirms each change through the engine's
// own routes. Zero page errors.
//   PORT=<port> TOKEN=<hex> CERT=<cert.pem> KEY=<key.pem> [ONLY=fresh | ONLY=<step,step>] [SHOTS=<dir>]
//   node design/redesign/tools/verify-parity-b1.cjs
// The stand-in model service (an OpenAI-shaped "custom" connection at https://127.0.0.2:<free port>, as
// verify-conv-timeline.cjs sets it up) plays each task by the words it is sent. Setup, for throwaway engines only:
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=127.0.0.2 -addext subjectAltName=IP:127.0.0.2
//   echo '{"web":{"allowPrivateAddresses":true}}' > launch.json
//   NODE_EXTRA_CA_CERTS=cert.pem BRANCH_INTEGRATIONS=launch.json BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
// ONLY=fresh runs the no-model pass instead, against an engine on its own fresh data dir that has never had a model:
// the composer, the + menu and the mode menu must draw there without page errors. ONLY=<a,b> runs just those steps.
// Everything it changed (policy, switches, connections, Trunks, rooms, settings) is put back at the end.
const https = require("node:https");
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");
const { readFileSync, mkdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("playwright");

const { PORT, TOKEN, CERT, KEY } = process.env;
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/parity-b1";
if (!PORT || !TOKEN || !CERT || !KEY) { console.error("Set PORT, TOKEN, CERT and KEY (see the setup above)"); process.exit(2); }
mkdirSync(SHOTS, { recursive: true });
const cleanup = [];
const client = (port, token) => async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error ?? ""}`);
  return data;
};
const api = client(PORT, TOKEN);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, ms = 30000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await pause(300)) { const v = await test().catch(() => null); if (v) return v; }
  throw new Error("timed out: " + what);
}
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => undefined);

/* ---------- a tiny picture the stand-in hands back from /images/generations ---------- */
function png(w, h, [r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------- the stand-in model service ---------- */
const wire = (name) => "branch_" + createHash("sha256").update(name).digest("hex").slice(0, 24);
const CHOICE = { question: "How careful should I be?", options: [{ title: "Ask before anything", hint: "Every step waits for you" }, { title: "Ask before sending", hint: "Reading is fine" }] };
const CHART = '```chart\n{"type":"bar","title":"Parity chart","data":[{"label":"A","value":3},{"label":"B","value":5}]}\n```';
const model = { bodies: [] };
function answer(raw) {
  const body = JSON.parse(raw), messages = body.messages ?? [];
  const system = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
  /* An approval's yes carries the task on with the engine's own "Yes, go ahead.": the task being carried on is the
     owner's words before it, and what it has done is every tool that answered ok since them. */
  const users = messages.map((m, i) => (m.role === "user" && m.content !== "Yes, go ahead." ? i : -1)).filter((i) => i >= 0);
  const lastUser = users.at(-1) ?? -1;
  const prompt = String(messages[lastUser]?.content ?? "");
  const since = messages.slice(lastUser + 1);
  const named = new Map(since.flatMap((m) => m.tool_calls ?? []).map((c) => [c.id, c.function?.name]));
  const ok = (name) => since.filter((m) => m.role === "tool" && named.get(m.tool_call_id) === wire(name) && /"ok":\s*true/.test(String(m.content))).length;
  const done = since.filter((m) => m.role === "tool").length;
  const say = (content) => ({ message: { role: "assistant", content } });
  const toolCall = (name, args) => ({ message: { role: "assistant", content: null, tool_calls: [{ id: `c${Date.now()}${Math.random().toString(16).slice(2, 6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } });
  /* A tool in a closed toolbox is not offered this round (a carry-on's "Yes, go ahead." names none): open them first. */
  const offered = new Set((body.tools ?? []).map((x) => x.function?.name));
  const opener = (body.tools ?? []).find((x) => x.function?.parameters?.properties?.groups);
  const call = (name, args) => (offered.size && !offered.has(wire(name)) && opener
    ? toolCall(opener.function.name, { groups: opener.function.parameters.properties.groups.items.enum })
    : toolCall(wire(name), args));
  if (/ask the person a few short questions/i.test(system)) return say(JSON.stringify({ questions: [{ question: "Which folder should I tidy?", suggested: "Downloads" }] }));
  if ((/summar/i.test(system) && /json/i.test(system)) || prompt.startsWith("Summarize the conversation below")) return say(JSON.stringify({ goals: ["Check the parity of the window"], decisions: ["Use the engine's own words"], openQuestions: ["Whether the stamps read well"], filesTouched: ["notes/b1.md"] }));
  if (prompt.includes("b1 steps")) return done === 0 ? call("files.list", { path: "." }) : done === 1 ? call("files.list", { path: "." }) : say("Looked in the folder twice.");
  if (prompt.includes("b1 choice")) return done === 0 ? call("user.ask", CHOICE) : say("Noted.");
  if (prompt === CHOICE.options[1].title || prompt.includes("b1 own answer")) return say("Noted your answer.");
  if (prompt.includes("b1 room write")) return !ok("files.write") ? call("files.write", { path: `notes/room-${Math.random().toString(16).slice(2, 8)}.md`, content: "room" }) : say("Written.");
  if (prompt.includes("b1 write")) return done === 0 ? call("files.write", { path: "notes/b1.md", content: "parity" }) : say("Written.");
  if (prompt.includes("b1 chart")) return say(`Here it is.\n\n${CHART}`);
  if (done > 12) return say("Stopped.");
  /* A point can be kept only once something changed: write, keep a point, read the file, then change it. */
  if (prompt.includes("b1 checkpoint file")) return !ok("files.write") ? call("files.write", { path: "notes/ck.md", content: "before" })
    : !ok("workspace.checkpoint") ? call("workspace.checkpoint", { label: "Before the parity check" })
      : !ok("files.read") ? call("files.read", { path: "notes/ck.md" })
        : ok("files.write") < 2 ? call("files.write", { path: "notes/ck.md", content: "changed" }) : say("Kept a point, then changed the file.");
  if (prompt.includes("Make a picture:")) return !ok("media.image") ? call("media.image", { prompt: prompt.replace("Make a picture:", "").trim() || "a leaf" }) : say("Here is the picture.");
  if (prompt.includes("b1 retry")) return say(`Answer ${model.bodies.length}.`);
  return say("ok");
}
function standIn() {
  const server = https.createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }] }));
      if (req.url.includes("/images/generations")) return res.end(JSON.stringify({ created: 1, data: [{ b64_json: png(64, 40, [47, 140, 134]).toString("base64") }] }));
      model.bodies.push(raw);
      let reply;
      try { reply = answer(raw); } catch (error) { reply = { message: { role: "assistant", content: String(error.message) } }; }
      const finish = reply.message.tool_calls ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 1200, completion_tokens: 12, total_tokens: 1212, prompt_tokens_details: { cached_tokens: 800 } };
      if (/"stream":\s*true/.test(raw)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = reply.message.tool_calls ? { role: "assistant", tool_calls: [{ index: 0, ...reply.message.tool_calls[0] }] } : reply.message;
        return res.end(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: JSON.parse(raw).model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: JSON.parse(raw).model, choices: [], usage })}\n\ndata: [DONE]\n\n`);
      }
      res.end(JSON.stringify({ id: "r", object: "chat.completion", model: JSON.parse(raw).model, choices: [{ index: 0, message: reply.message, finish_reason: finish }], usage }));
    });
  });
  return new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.2", () => done(server)); });
}

/* ---------- setup ---------- */
async function setup(port) {
  const state = await api("state");
  const { policy, presets } = await api("policy"), activePreset = state.models?.activePreset ?? null;
  const workspace = presets.find((p) => p.id === "workspace");
  cleanup.push(() => api("policy", { ...policy, confirmLoosening: true }));
  await api("policy", { ...policy, preset: "workspace", rules: [{ tool: "files.write", decision: "ask", remember: "never" }, ...workspace.rules] });
  const a = await api("connections/from-preset", { provider: "custom", key: "stand-in-test-key", model: "stand-in", name: "Stand-in", extras: { baseUrl: `https://127.0.0.2:${port}/v1` } });
  cleanup.push(async () => { await api("connections/forget", { id: a.id }); await api("models", { activePreset }); });
  await api("models", { activePreset: a.id });
  return { a };
}
async function signIn(page, port, token) {
  await client(port, token)("onboarding", { done: true });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}
async function newConversation(page) {
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await page.locator("#prompt").waitFor({ state: "visible" });
}
async function say(page, words) {
  /* A message sent while the last task still works joins the waiting line: wait until the box can send. */
  await until("no task is working", async () => !(await api("state")).runs.some((r) => ["running", "queued"].includes(r.status)), 30000);
  await pause(1200); // the window's own follow reads once a second
  await page.locator("#prompt").click();
  await page.locator("#prompt").fill(words);
  await page.locator("#send").click();
}
const runOf = async (prompt) => until(`the task for "${prompt}"`, async () => (await api("state")).runs.find((r) => r.prompt === prompt));
const settled = async (prompt, statuses = ["completed"]) => until(`"${prompt}" settled`, async () => { const r = (await api("state")).runs.find((x) => x.prompt === prompt); return r && statuses.includes(r.status) && r; }, 45000);
/* A message's own buttons show on hover, as the prototype's do: the mouse goes there first. */
async function hoverClick(page, row, act) {
  await row.hover();
  await row.locator(`[data-act="${act}"]`).first().click();
}

module.exports = { api, client, until, pause, check, shot, setup, signIn, newConversation, say, runOf, settled, hoverClick, CHOICE, CHART, model, cleanup };

/* ---------- 1. the thread: stamps, steps folded to one line, done line, Sent at, Try again, cost ---------- */
async function thread(page) {
  await newConversation(page);
  await say(page, "b1 steps");
  const run = await settled("b1 steps");
  const view = await api(`sessions/${run.sessionId}`);
  check(view.messages.filter((m) => m.role === "user" || m.role === "assistant").every((m) => typeof m.at === "string"), "GET /api/sessions/<id>: every message says when it was written");
  const stamp = page.locator("#conversation .stamp").first();
  await stamp.waitFor({ timeout: 20000 });
  check(/^Today /.test(await stamp.textContent()), `a day stamp before the first message: "${await stamp.textContent()}"`);
  const steps = page.locator("#conversation details.steps").first();
  await steps.waitFor({ timeout: 20000 });
  const summary = page.locator("#conversation details.steps summary").first();
  await until("the steps line names the count", async () => /^2 steps/.test(await summary.textContent()), 15000);
  check(true, `the tool calls fold to one line: "${await summary.textContent()}"`);
  await summary.click();
  const items = await page.locator("#conversation details.steps li").count();
  const engine = (await api(`runs/${run.id}/steps`)).steps.filter((s) => s.kind === "tool");
  check(items === engine.length, `opening it lists each step (${items} of the engine's ${engine.length} tool steps)`);
  const doneLine = page.locator("#conversation .done-line").first();
  check(await doneLine.count() === 1 && /^Done in /.test(await doneLine.textContent()), `the finished task says how long it took: "${await doneLine.textContent().catch(() => "")}"`);
  const reply = page.locator("#conversation .b[data-i15]").last();
  const ts = reply.locator(".ts15");
  check(await ts.count() === 1 && /Sent at/.test(await ts.getAttribute("aria-label")), `the reply's row ends with its time: ${await ts.getAttribute("aria-label").catch(() => "none")}`);
  const cost = page.locator("#composer .cost15");
  const price = await api(`sessions/${run.sessionId}/cost`);
  check(price.amount === null ? await cost.count() === 0 : await cost.count() === 1, `the cost line follows GET /api/sessions/<id>/cost (${price.amount === null ? "no price: none drawn" : await cost.textContent()})`);
  await shot(page, "01-thread-steps");
  return run;
}

async function tryAgain(page) {
  await newConversation(page);
  await say(page, "b1 retry");
  const first = await settled("b1 retry");
  const before = (await api(`sessions/${first.sessionId}`)).messages.filter((m) => m.role === "assistant").map((m) => m.content);
  const reply = page.locator("#conversation .b[data-i15]").last();
  await reply.waitFor();
  await hoverClick(page, reply, "retry15");
  await until("a second task with the same words", async () => (await api("state")).runs.filter((r) => r.prompt === "b1 retry" && r.status === "completed").length >= 2, 30000);
  const after = (await api(`sessions/${first.sessionId}`)).messages;
  const users = after.filter((m) => m.role === "user" && m.content === "b1 retry").length;
  const answers = after.filter((m) => m.role === "assistant").map((m) => m.content);
  check(users === 1 && answers.length === 1 && answers[0] !== before[0], `Try again went back and asked again: one question, a new answer ("${before[0]}" → "${answers[0]}")`);
}


/* Answers each approval card the task shows with its own Allow (each names its exact request), until the task settles. */
async function allowUntilSettled(page, prompt) {
  return until(`"${prompt}" settled, allowing each request it asks`, async () => {
    const allow = page.locator('#live-ask [data-act="ask"][data-v="allow"]');
    if (await allow.count()) await allow.first().click().catch(() => undefined);
    const runs = (await api("state")).runs, first = runs.find((x) => x.prompt === prompt);
    if (!first) return null;
    /* The newest task in that conversation (the task itself, or the carry-on after a yes) has finished. */
    const newest = runs.filter((x) => x.sessionId === first.sessionId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    return ["completed", "failed"].includes(newest.status) && !(await api("policy")).waiting?.some((q) => q.sessionId === first.sessionId) && first;
  }, 60000);
}

/* ---------- 2. a question with lettered options: pick one, or type your own ---------- */
const said = async (sid) => (await api(`sessions/${sid}`)).messages;
async function choice(page) {
  await newConversation(page);
  await say(page, "b1 choice");
  const sid = (await runOf("b1 choice")).sessionId;
  const card = page.locator("#conversation .card.choice").first();
  await card.waitFor({ timeout: 30000 });
  check(await card.locator('[data-act="pick"]').count() === CHOICE.options.length, `the choice card offers the engine's ${CHOICE.options.length} options, lettered`);
  await card.locator('[data-act="pick"]').nth(1).click();
  await settled(CHOICE.options[1].title);
  check((await said(sid)).some((m) => m.role === "user" && m.content === CHOICE.options[1].title), "picking B sends its title as the answer (GET /api/sessions/<id>)");
  await until("the picked option is marked", async () => (await page.locator("#conversation .card.choice .opt.picked").count()) === 1, 15000);
  check(true, "the card keeps the picked option and locks the rest");
  await newConversation(page);
  await say(page, "b1 choice");
  await until("a second choice card", async () => (await page.locator("#conversation .card.choice input").count()) === 1, 30000);
  const own = "b1 own answer, typed";
  await page.locator("#conversation .card.choice input").fill(own);
  await page.locator('#conversation .card.choice button[type="submit"]').click();
  const run = await settled(own);
  check((await said(run.sessionId)).some((m) => m.role === "user" && m.content === own), "Or type your own answer: Reply sends those words as the answer");
  await shot(page, "02-choice");
}

/* ---------- 3. the chart card's Copy code, Look inside's rows and Copy the record ---------- */
async function chartAndInspect(page) {
  await newConversation(page);
  await say(page, "b1 chart");
  const run = await settled("b1 chart");
  const card = page.locator("#conversation .card.art").first();
  await card.waitFor({ timeout: 20000 });
  await card.locator('[data-act="art-copy"]').click();
  const code = await page.evaluate(() => navigator.clipboard.readText());
  const reply = (await said(run.sessionId)).find((m) => m.role === "assistant" && m.content.includes("```chart"));
  check(!!code.trim() && reply.content.includes(code.trim()), "Copy code puts the reply's own chart code on the clipboard");
  const row = page.locator("#conversation .b[data-i15]").last();
  await hoverClick(page, row, "inspect");
  const dlg = page.locator(".dlg").last();
  await dlg.waitFor();
  const rec = await api(`runs/${run.id}/inspect`);
  const tools = dlg.locator("dt", { hasText: "Tools offered" });
  check(rec.toolsOffered ? await tools.count() === 1 : await tools.count() === 0, `Look inside's Tools offered follows GET /api/runs/<id>/inspect (${rec.toolsOffered ? `${rec.toolsOffered.shown} · ${rec.toolsOffered.oneStepAway} more` : "none"})`);
  await dlg.locator('[data-act="insp-copy"]').click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  check(JSON.stringify(copied.rounds) === JSON.stringify(rec.rounds) && JSON.stringify(copied.toolsOffered) === JSON.stringify(rec.toolsOffered), "Copy the record copies the engine's record of that task");
  await page.keyboard.press("Escape");
  await shot(page, "03-chart-inspect");
}

/* ---------- 4. an approval answered in the thread, then Put it all back and its Undo ---------- */
async function checkpoint(page) {
  const { workspace } = await api("state");
  const file = join(workspace, "notes", "ck.md");
  /* This step's writes go ahead without a card (the approval card is checked with the picture below): the policy
     allows writing, and the conversation is set to Auto from the mode chip before it starts. */
  const { policy } = await api("policy");
  await api("policy", { ...policy, rules: [{ tool: "files.write", decision: "allow" }, ...policy.rules.filter((r) => r.tool !== "files.write")], confirmLoosening: true });
  await newConversation(page);
  await page.locator('[data-act="modemenu2"]').click();
  await page.locator('.pop [data-act="set-mode"][data-v="auto"]').click();
  await page.keyboard.press("Escape");
  try { await say(page, "b1 checkpoint file"); await settled("b1 checkpoint file"); } finally { await api("policy", policy); }
  check(existsSync(file) && readFileSync(file, "utf8") === "changed", "the task wrote a file, kept a point, then changed the file");
  await page.locator('#conversation [data-act="ckpt"]').first().click();
  await until("the file is put back", async () => existsSync(file) && readFileSync(file, "utf8") === "before", 15000);
  check(true, "Put it all back put the file back as it was at the kept point");
  const undo = page.locator('.toast [data-act="undo"]');
  await undo.waitFor({ timeout: 5000 });
  await undo.click();
  await until("Undo brings the change back", async () => readFileSync(file, "utf8") === "changed", 15000);
  check(true, "the toast's Undo puts the file back (POST /api/history/snapshots/<kept>/restore)");
  await shot(page, "04-checkpoint");
}

/* ---------- 5. Make a picture: the picture card, Make it again, and picking a version ---------- */
async function picture(page) {
  const words = "Make a picture: a green leaf";
  await newConversation(page);
  await say(page, words);
  const run = await allowUntilSettled(page, words);
  const decided = page.locator("#conversation .decided").first();
  await decided.waitFor({ timeout: 20000 });
  check(/Allowed/.test(await decided.textContent()), `the answered approval stays in the thread as a decided line: "${(await decided.textContent()).trim()}"`);
  const card = page.locator("#conversation .card.img6").first();
  const made = await card.waitFor({ timeout: 20000 }).then(() => true, () => false);
  check(made, "the picture the model made (media.image, once allowed) is drawn as the picture card");
  if (!made) return;
  await until("the picture's bytes are shown", async () => !!(await card.locator("img.img6-main").getAttribute("src")), 15000);
  check(true, "the card shows the picture the engine kept (GET /api/artifacts/file)");
  await card.locator('[data-act="img-again"]').click();
  const pictures = async () => (await said(run.sessionId)).filter((m) => m.role === "tool" && /"ok":\s*true/.test(m.content) && m.content.includes('"path"')).length;
  await until("a second picture from the same words", async () => {
    const allow = page.locator('#live-ask [data-act="ask"][data-v="allow"]');
    if (await allow.count()) await allow.first().click().catch(() => undefined);
    return (await pictures()) >= 2;
  }, 60000);
  check(true, "Make it again asked the model again with the same words");
  const vers = page.locator('#conversation .card.img6').first().locator('[data-act="img-pick"]');
  await until("two versions to pick", async () => (await vers.count()) >= 2, 20000);
  const main = page.locator("#conversation .card.img6 img.img6-main").first();
  const first = await main.getAttribute("src");
  await vers.nth(1).click();
  await until("the other version is shown", async () => (await main.getAttribute("src")) !== first, 5000).catch(() => null);
  check((await main.getAttribute("src")) !== first && (await vers.nth(1).getAttribute("aria-pressed")) === "true", "picking a version shows that version");
  await shot(page, "05-picture");
}

/* ---------- 6. the + menu: Use a skill, ' /', the @ list's Material, Ask me questions first ---------- */
async function plusMenu(page) {
  const skill = await api("skills/install", { document: "---\nname: b1-fixture\ndescription: Use this skill for local fixture checks.\nallowed-tools: files.read\n---\n\nFixture.\n" });
  cleanup.push(() => api(`skills/${skill.id}/remove`, { expectedRevision: skill.revision }));
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await newConversation(page);
  await page.locator('[data-act="plusmenu"]').click();
  await page.locator('.pop [data-act="skills15"]').click();
  const row = page.locator('.pop [data-act="slash-pick"]', { hasText: "/b1-fixture" });
  await row.waitFor({ timeout: 10000 });
  await row.click();
  check((await page.locator("#prompt").inputValue()).trim() === "/b1-fixture", "Use a skill lists the engine's skills (GET /api/state skills) and puts /name in the box");
  await page.locator("#prompt").fill("");
  await page.locator("#prompt").pressSequentially("tidy this up /b");
  const mid = page.locator('.pop [data-act="slash-pick"]').first();
  check(await mid.waitFor({ timeout: 5000 }).then(() => true, () => false), "' /' mid-message opens the Skills list");
  await mid.click();
  check((await page.locator("#prompt").inputValue()).includes("tidy this up /b1-fixture"), "picking it there puts the skill in the message");
  await page.locator("#prompt").fill("");
  await page.locator("#prompt").pressSequentially("look at @");
  const diff = page.locator('.pop [data-act="mention-pick"][data-v="diff"]');
  check(await diff.waitFor({ timeout: 5000 }).then(() => true, () => false), "the @ list has Material: Changes (diff) and A link");
  await diff.click();
  check((await page.locator("#prompt").inputValue()).includes("@diff"), "picking Changes (diff) puts @diff in the box");
  await page.locator("#prompt").fill("");
  /* Ask me questions first: the owner's saved switch (GET /api/ask-first/settings). */
  const before = (await api("ask-first/settings")).askFirst;
  cleanup.push(() => api("ask-first/settings", { askFirst: before }));
  await page.locator('[data-act="plusmenu"]').click();
  await page.locator("#pm-ask").click();
  await until("the switch is saved", async () => (await api("ask-first/settings")).askFirst === true, 10000);
  check(true, "Ask me questions first is saved on (GET /api/ask-first/settings)");
  await page.keyboard.press("Escape");
  await until("the box shows its Asks first flag", async () => (await page.locator("#composer .flag", { hasText: "Asks first" }).count()) === 1, 10000);
  check(true, "the box shows its Asks first flag");
  const long = "b1 ask first: please tidy up the folder, then sort the files by kind, then write a short note of what moved and why it moved.";
  await say(page, long);
  const q = page.locator('.dlg input[data-sw="af"]');
  await q.waitFor({ timeout: 20000 });
  check((await q.inputValue()) === "Downloads", "the engine's question opens with the answer it would assume filled in");
  await page.locator('.dlg [data-act="af-go"]').click();
  const run = await until("the task with the answers under it", async () => (await api("state")).runs.find((r) => r.prompt.startsWith(long) && r.prompt.includes("Downloads")), 30000);
  check(!!run, "Send puts the answers under the request (POST /api/ask-first/answers) and sends that");
  await page.locator('[data-act="plusmenu"]').click();
  await page.locator("#pm-ask").click();
  await until("the switch is saved off", async () => (await api("ask-first/settings")).askFirst === false, 10000);
  check(true, "and switching it off is saved too");
  await page.keyboard.press("Escape");
  await shot(page, "06-plus");
}

/* ---------- 7. Room left: Round by round and Tidy up (the engine's /compact) ---------- */
async function roomLeft(page) {
  const was = (await api("commands/settings")).mode;
  await api("commands/settings", { mode: "on" });
  cleanup.push(() => api("commands/settings", { mode: was }));
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await newConversation(page);
  await say(page, "b1 steps");
  const run = await settled("b1 steps");
  /* /compact keeps the newest six messages, so the conversation needs a few more turns before there is anything to fold. */
  for (const n of [1, 2, 3]) { await say(page, `b1 more ${n}`); await settled(`b1 more ${n}`); }
  const meter = page.locator('[data-act="roommenu"]').first();
  await meter.waitFor({ timeout: 20000 });
  await meter.click();
  const rounds = page.locator(".pop .rounds15 .r-bars15 i");
  await rounds.first().waitFor({ timeout: 10000 });
  /* The window reads the conversation's newest four tasks' rounds (GET /api/runs/<id>/inspect) and draws the last eight. */
  const newest = (await api("state")).runs.filter((r) => r.sessionId === run.sessionId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 4);
  let recorded = 0;
  for (const one of newest) recorded += (await api(`runs/${one.id}/inspect`)).rounds.filter((r) => r.tokens?.input > 0).length;
  check(await rounds.count() === Math.min(8, recorded), `Round by round draws a bar per round the engine recorded (${await rounds.count()} of ${recorded}, at most 8)`);
  check(/reused from the cache/.test(await page.locator(".pop .rounds15").textContent()), "and says how much the provider's cache served, as it said");
  await page.locator('.pop [data-act="tidyconv15"]').click();
  const sum = await until("the conversation was folded", async () => (await api(`sessions/${run.sessionId}/summary`)).summary, 45000);
  check(!!sum, "Tidy up this conversation ran /compact (GET /api/sessions/<id>/summary)");
  await page.locator("#conversation details.sum15").waitFor({ timeout: 15000 });
  check(true, "and the thread opens with the Earlier in this conversation card");
  await shot(page, "07-room-left");
}

/* ---------- 8. moving around: Connect another agent, the header's stage buttons, Use a saved prompt ---------- */
async function moving(page) {
  await newConversation(page);
  await say(page, "b1 retry");
  await settled("b1 retry");
  await page.locator('.head [data-act="stage"][data-v="browser"]').click();
  await until("the stage opens", async () => (await page.locator(".stage7").count()) > 0, 10000);
  check(true, "the header's globe opens the browser full size (chat/stage.js)");
  await page.locator('[data-act="stage-close"]').first().click().catch(() => page.keyboard.press("Escape"));
  await page.locator('.head [data-act="stage"][data-v="computer"]').click();
  await until("the computer view", async () => (await page.locator('.stage7 [data-act="stage"][data-v="computer"][aria-pressed="true"]').count()) > 0, 10000);
  check(true, "the header's monitor opens its computer full size");
  await page.locator('[data-act="stage-close"]').first().click().catch(() => page.keyboard.press("Escape"));
  await page.locator('[data-act="roster10h"]').first().click();
  await page.locator('.pop [data-act="t9-kind-roster"]').click();
  await until("Customize › Tools at Agents", async () => (await page.locator('[data-act="t9-kind"][data-v="agents"][aria-current="true"]').count()) >= 1, 10000);
  check(true, "Who it knows › Connect another agent opens Customize › Tools at Agents");
  const library = (await api("prompts")).settings.mode;
  if (library === "off") { await api("prompts/settings", { mode: "on" }); cleanup.push(() => api("prompts/settings", { mode: library })); }
  const saved = await api("prompts", { title: "B1 weekly", body: "b1 saved prompt body" });
  const pid = saved.prompt?.id ?? saved.id;
  cleanup.push(() => api("prompts/remove", { id: pid }));
  await page.locator('[data-act="view"][data-v="automations"]').first().click();
  await page.locator('[data-act="ptab"][data-place="automations"][data-v="procedures"]').click();
  const use = page.locator(`[data-act="prompt-use"][data-v="${pid}"]`);
  await use.waitFor({ timeout: 15000 });
  await use.click();
  await until("the saved prompt is in the box", async () => (await page.locator("#prompt").inputValue()) === "b1 saved prompt body", 10000);
  check(true, "Automations › Use puts the saved prompt's words (GET /api/prompts) in the box");
  await page.locator("#prompt").fill("");
  await shot(page, "08-moving");
}

/* ---------- 9. a room: two asks, one card, each Yes or No naming its own request ---------- */
async function room(page) {
  const { modes } = await api("trunks");
  for (const part of ["trunks", "rooms"]) { const was = modes[part]; await api("trunks/switch", { part, mode: "on" }); cleanup.push(() => api("trunks/switch", { part, mode: was })); }
  const made = [];
  for (const name of ["Scout", "Ledger"]) made.push((await api("trunks", { name, title: "Checks", description: "Checks things for parity." })).trunk);
  cleanup.push(async () => { for (const tr of made) await api(`trunks/${tr.id}/remove`, {}).catch((e) => console.log("cleanup:", e.message)); });
  const r = (await api("trunks/rooms", { name: "B1 room", members: made.map((x) => x.id), rule: "all" })).room;
  cleanup.push(() => api(`trunks/rooms/${r.id}/remove`, {}));
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await page.locator(`#side [data-act="chat"][data-id="${r.sessionId}"]`).click();
  await until("the room's box", async () => /Message the room/.test(await page.locator("#prompt").getAttribute("placeholder")), 10000);
  check(true, "the room's box says Message the room (pass 18: @ to call a Trunk is the @ list's hint)");
  check(/Messages from/.test(await page.locator("#conversation, .scroll").first().textContent()), "the room line names its members");
  /* A room's members answer one after another and the room stops at the first question, so two questions wait at once
     only when both members' own room conversations have one: each is asked there directly (POST /api/run). */
  const view = await api(`trunks/rooms/${r.id}`);
  const asked = made.map((tr) => api("run", { prompt: "b1 room write", sessionId: view.memberSessions[tr.id] }).catch((e) => ({ error: e.message })));
  const card = page.locator("#conversation .card.g-ask");
  await until("both members wait (GET /api/trunks/rooms/<id>)", async () => (await api(`trunks/rooms/${r.id}`)).waiting?.length === 2, 60000);
  /* The window reads a room once, when it first opens it: a fresh window reads what waits now. */
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await page.locator(`#side [data-act="chat"][data-id="${r.sessionId}"]`).click();
  await until("both members wait in one card", async () => (await card.locator('[data-act="g-ans"][data-v="allow"]').count()) === 2, 20000);
  check(true, "Two things need you: one row per member, each naming its request");
  const all = card.locator('[data-act="g-all"]');
  check(await all.count() === 1 && ((await all.isDisabled()) || (await all.getAttribute("aria-disabled")) === "true"), "Yes to both is drawn and greyed");
  const firstFp = await card.locator('[data-act="g-ans"][data-v="allow"]').first().getAttribute("data-fp");
  await card.locator('[data-act="g-ans"][data-v="allow"]').first().click();
  await until("that one request is answered", async () => !(await api(`trunks/rooms/${r.id}`)).waiting?.some((q) => q.fingerprint === firstFp), 30000);
  check(true, "Yes answers exactly that member's request (GET /api/trunks/rooms/<id> waiting)");
  await until("the row keeps its Allowed pill", async () => (await card.locator(".pill.done").count()) >= 1, 15000);
  check(true, "and its row keeps an Allowed pill while the other waits");
  await card.locator('[data-act="g-ans"][data-v="deny"]').first().click();
  await until("nothing waits", async () => !(await api(`trunks/rooms/${r.id}`)).waiting?.length, 30000);
  check(true, "No refuses the other one");
  await Promise.all(asked);
  await shot(page, "09-room");
}

/* ---------- 10. a brand-new owner with no model: the composer, the + menu and the thread draw, with no page errors ---------- */
async function fresh(page) {
  await newConversation(page);
  await page.locator("#composer").waitFor();
  check(/Message/.test(await page.locator("#prompt").getAttribute("placeholder")), "the box draws without a model");
  await page.locator('[data-act="plusmenu"]').click();
  check(await page.locator('.pop [data-act="skills15"]').count() === 1, "the + menu draws without a model");
  await page.keyboard.press("Escape");
  await page.locator('[data-act="modemenu2"]').click();
  check(await page.locator('.pop [data-act="scope"]').count() === 2 && await page.locator('.pop [data-act="scope"][aria-disabled="true"]').count() === 2, "the mode menu's Applies to is drawn and greyed");
  await page.keyboard.press("Escape");
  await shot(page, "10-fresh");
}

(async () => {
  if (require.main !== module) return;
  const server = await standIn();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${PORT}` });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const only = (process.env.ONLY || "").split(",").filter(Boolean);
  const want = (name) => !only.length || only.includes(name);
  try {
    if (only.length === 1 && only[0] === "fresh") { await signIn(page, PORT, TOKEN); await fresh(page); }
    else {
      await setup(server.address().port);
      await signIn(page, PORT, TOKEN);
      for (const [name, step] of Object.entries({ thread, retry: tryAgain, choice, chartAndInspect, checkpoint, picture, plusMenu, roomLeft, moving, room }))
        if (want(name)) { console.log(`-- ${name}`); await step(page).catch(async (error) => { check(false, `${name}: ${error.message.split("\n").slice(0, 8).join(" | ")}`); await shot(page, `zz-${name}`); }); }
    }
  } catch (error) { check(false, error.stack || error.message); await shot(page, "zz-failure"); }
  finally {
    for (const undo of cleanup.reverse()) await undo().catch((e) => console.log("cleanup:", e.message));
    check(errors.length === 0, `page errors: ${errors.length}${errors.length ? " " + errors.join(" | ") : ""}`);
    await browser.close();
    server.close();
  }
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
})();
