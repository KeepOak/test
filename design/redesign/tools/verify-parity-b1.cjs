// Parity B1 (briefs/PARITY.md, batch B1: the conversation and the composer): clicks every B1 control with the mouse, as
// a set-up owner (a stand-in model) and as a brand-new owner (no model), and confirms each change through the engine's
// own routes. Zero page errors.
//   PORT=<port> TOKEN=<hex> CERT=<cert.pem> KEY=<key.pem> [FRESH_PORT=<port> FRESH_TOKEN=<hex>] [SHOTS=<dir>]
//   node design/redesign/tools/verify-parity-b1.cjs
// The stand-in model service (an OpenAI-shaped "custom" connection at https://127.0.0.2:<free port>, as
// verify-conv-timeline.cjs sets it up) plays each task by the words it is sent. Setup, for throwaway engines only:
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=127.0.0.2 -addext subjectAltName=IP:127.0.0.2
//   echo '{"web":{"allowPrivateAddresses":true}}' > launch.json
//   NODE_EXTRA_CA_CERTS=cert.pem BRANCH_INTEGRATIONS=launch.json BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
// FRESH_* is a second engine on its own fresh data dir that has never had a model: the composer, the + menu and the
// thread furniture must draw there without a model and without page errors.
// Everything it changed (policy, switches, connections, Trunks, rooms, settings) is put back at the end.
const https = require("node:https");
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");
const { readFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const { PORT, TOKEN, CERT, KEY, FRESH_PORT, FRESH_TOKEN } = process.env;
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
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const prompt = String(messages[lastUser]?.content ?? "");
  const done = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  const say = (content) => ({ message: { role: "assistant", content } });
  const call = (name, args) => ({ message: { role: "assistant", content: null, tool_calls: [{ id: `c${Date.now()}${Math.random().toString(16).slice(2, 6)}`, type: "function", function: { name: wire(name), arguments: JSON.stringify(args) } }] } });
  if (/summar/i.test(system) && /json/i.test(system)) return say(JSON.stringify({ goals: ["Check the parity of the window"], decisions: ["Use the engine's own words"], openQuestions: ["Whether the stamps read well"], filesTouched: ["notes/b1.md"] }));
  if (prompt.includes("b1 steps")) return done === 0 ? call("files.list", { path: "." }) : done === 1 ? call("files.list", { path: "." }) : say("Looked in the folder twice.");
  if (prompt.includes("b1 choice")) return done === 0 ? call("user.ask", CHOICE) : say("Noted.");
  if (prompt === CHOICE.options[1].title || prompt.includes("b1 own answer")) return say("Noted your answer.");
  if (prompt.includes("b1 write")) return done === 0 ? call("files.write", { path: "notes/b1.md", content: "parity" }) : say("Written.");
  if (prompt.includes("b1 chart")) return say(`Here it is.\n\n${CHART}`);
  if (prompt.includes("b1 checkpoint")) return done === 0 ? call("workspace.checkpoint", { label: "Before the parity check" }) : done === 1 ? call("files.write", { path: "notes/ck.md", content: "changed" }) : say("Kept a point, then changed a file.");
  if (prompt.includes("Make a picture:")) return done === 0 ? call("media.image", { prompt: prompt.replace("Make a picture:", "").trim() || "a leaf" }) : say("Here is the picture.");
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

(async () => {
  if (require.main !== module) return;
  const server = await standIn();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const only = (process.env.ONLY || "").split(",").filter(Boolean);
  const want = (name) => !only.length || only.includes(name);
  try {
    await setup(server.address().port);
    await signIn(page, PORT, TOKEN);
    if (want("thread")) await thread(page);
    if (want("retry")) await tryAgain(page);
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
