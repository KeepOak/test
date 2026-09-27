// Checks every control the pass-17 Timeline, Helpers, Steer and model-switch area made live, against a running engine,
// each confirmed through the engine's own routes.
//   PORT=<port> TOKEN=<hex> CERT=<cert.pem> KEY=<key.pem> node design/redesign/tools/verify-conv-timeline.cjs
// A stand-in model service (OpenAI-shaped "custom" connections at https://127.0.0.2:<free port>, as
// verify-approvals-modes.cjs sets them up) plays one task: it sends a piece of work to the Code mode (mode.task), whose
// helper asks to write a file and waits on that question; the task's next call is held, so it is really running.
// 1. Steer: the chip over the box reads "Steer <name>" while the task runs; Steer now sends the note
//    (GET /api/runs/<id>/inspect steering), the thread shows "You steered …", and the next model call carries it.
// 2. Helpers: the thread's chip "1 helpers · 1 needs you" opens Activity › Helpers, whose card names the helper, its model
//    and its exact question; Allow once answers that request (GET /api/policy no longer lists it, the helper is settled,
//    and nothing was started in its conversation).
// 3. Timeline: the tab after Activity; Step back and forward, a tick, Play (the step moves on its own), Show it in the
//    conversation, and Check the record (POST /api/safety-extras/activity/verify, held to the task's latest link).
//    Look inside on the reply has "Every step", which opens the Timeline at that task.
// 4. Model switch: a second message on the other stand-in model (POST /api/sessions/<id>/model); the thread shows the
//    note where the switch happened (GET /api/state runs[].model), and Why opens its explanation.
// Setup, for a throwaway engine only (its launch file lets it reach this computer's addresses, and it trusts the cert):
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=127.0.0.2 -addext subjectAltName=IP:127.0.0.2
//   echo '{"web":{"allowPrivateAddresses":true}}' > launch.json
//   NODE_EXTRA_CA_CERTS=cert.pem BRANCH_INTEGRATIONS=launch.json BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
// Puts back the policy, the modes switch, the chain switch and the model that answered before, and forgets both stand-ins.
const https = require("node:https");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const { PORT, TOKEN, CERT, KEY } = process.env;
if (!PORT || !TOKEN || !CERT || !KEY) { console.error("Set PORT, TOKEN, CERT and KEY (see the setup above)"); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const cleanup = [];
const api = async (path, body) => {
  const r = await fetch(BASE + "/api/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error ?? ""}`);
  return data;
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, ms = 30000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await pause(300)) { const v = await test().catch(() => null); if (v) return v; }
  throw new Error("timed out: " + what);
}
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };

/* ---------- the stand-in model service ---------- */
const wire = (name) => "branch_" + createHash("sha256").update(name).digest("hex").slice(0, 24);
const model = { held: [], bodies: [] };
const NOTE = "Only look at the newest file";
function answer(raw) {
  const body = JSON.parse(raw), messages = body.messages ?? [];
  const system = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const results = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: `c${Date.now()}`, type: "function", function: { name: wire(name), arguments: JSON.stringify(args) } }] });
  if (system.includes("You write and change code")) return { message: results ? { role: "assistant", content: "Done." } : call("files.write", { path: "notes/helper.md", content: "checked" }) };
  const prompt = String(messages[lastUser]?.content ?? "");
  if (prompt.includes("second check")) return { message: { role: "assistant", content: "Second answer." } };
  // Counted from the task's own message, so the steered note (it arrives as a message of its own) changes nothing.
  const asked = messages.map((m) => m.role === "user" && String(m.content).includes("timeline check")).lastIndexOf(true);
  const done = messages.slice(asked + 1).filter((m) => m.role === "tool").length;
  if (done === 0) return { message: call("mode.task", { mode: "code", message: "write notes/helper.md" }) };
  if (done === 1) return { message: call("files.list", { path: "." }), hold: true };
  return { message: { role: "assistant", content: "Finished." } };
}
function standIn() {
  const server = https.createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }, { id: "stand-in-b", object: "model" }] }));
      model.bodies.push(raw);
      let reply;
      try { reply = answer(raw); } catch (error) { reply = { message: { role: "assistant", content: String(error.message) } }; }
      const finish = reply.message.tool_calls ? "tool_calls" : "stop";
      if (/"stream":\s*true/.test(raw)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = reply.message.tool_calls ? { role: "assistant", tool_calls: [{ index: 0, ...reply.message.tool_calls[0] }] } : reply.message;
        const send = () => res.end(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: JSON.parse(raw).model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
        return reply.hold ? model.held.push(send) : send();
      }
      const send = () => res.end(JSON.stringify({ id: "r", object: "chat.completion", model: JSON.parse(raw).model, choices: [{ index: 0, message: reply.message, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 } }));
      if (reply.hold) model.held.push(send); else send();
    });
  });
  return new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.2", () => done(server)); });
}
const release = () => { for (const r of model.held.splice(0)) r(); };

/* ---------- setup: policy, modes, chain, two stand-in connections ---------- */
async function setup(port) {
  const state = await api("state");
  const { policy, presets } = await api("policy"), activePreset = state.models?.activePreset ?? null;
  const workspace = presets.find((p) => p.id === "workspace");
  const interop = await api("interop"), safety = await api("safety-extras");
  cleanup.push(() => api("policy", policy));
  cleanup.push(() => api("interop/switch", { part: "modes", mode: interop.modes?.modes ?? interop.modes ?? "off" }));
  cleanup.push(() => api("safety-extras/switch", { part: "activity-chain", mode: safety.modes?.["activity-chain"] ?? "off" }));
  // "Just do it inside my workspace", plus one question of the owner's own: before a file is written. The conversation
  // runs in Auto, so sending work to a mode needs no yes and the helper's write is the one thing that asks.
  await api("policy", { ...policy, preset: "workspace", rules: [{ tool: "files.write", decision: "ask", remember: "session" }, ...workspace.rules] });
  await api("interop/switch", { part: "modes", mode: "on" });
  await api("safety-extras/switch", { part: "activity-chain", mode: "on" });
  const baseUrl = `https://127.0.0.2:${port}/v1`;
  const a = await api("connections/from-preset", { provider: "custom", key: "stand-in-test-key", model: "stand-in", name: "Stand-in", extras: { baseUrl } });
  const b = await api("connections/from-preset", { provider: "custom", key: "stand-in-test-key", model: "stand-in-b", name: "Stand-in B", extras: { baseUrl } });
  cleanup.push(async () => { await api("connections/forget", { id: a.id }); await api("connections/forget", { id: b.id }); await api("models", { activePreset }); });
  await api("models", { activePreset: a.id });
  return { a, b };
}

async function signIn(page) {
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  await page.goto(BASE);
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}

/* 1 and 2: start the task, steer it while it runs, answer its helper's question. */
async function steerAndHelpers(page) {
  await page.locator('[data-act="modemenu2"]').click();
  await page.locator('[data-act="set-mode"][data-v="auto"]').click();
  await page.locator("#prompt").fill("timeline check");
  await page.locator("#send").click();
  const run = await until("the task running", async () => (await api("state")).runs.find((r) => r.prompt === "timeline check" && r.status === "running"));
  await until("the call held", async () => model.held.length > 0);
  const chip = page.locator('[data-act="steerb17"]');
  await chip.waitFor({ state: "visible", timeout: 20000 });
  check(/^Steer /.test((await chip.textContent()).trim()), "the chip over the box reads Steer <name> while the task runs");
  await chip.click();
  await page.locator("#steer-in-b17").fill(NOTE);
  await page.locator('[data-act="steergob17"]').click();
  const steering = await until("the steer recorded", async () => { const s = (await api(`runs/${run.id}/inspect`)).steering ?? []; return s.some((n) => n.text.includes(NOTE)) && s; });
  check(!!steering, "Steer now: GET /api/runs/<id>/inspect lists the note");
  await page.locator(".steered-b17").first().waitFor({ state: "visible", timeout: 15000 });
  check((await page.locator(".steered-b17").first().textContent()).includes(NOTE), "the thread shows You steered … from the task's record");
  const hl = page.locator('.hl17c[data-act="hpopen17c"]');
  await hl.waitFor({ state: "visible", timeout: 20000 });
  check(/1 helpers · 1 needs you/.test(await hl.textContent()), "the thread's chip reads 1 helpers · 1 needs you");
  await hl.click();
  const card = page.locator("#helpers17c .hpc17c").first();
  await card.waitFor({ state: "visible", timeout: 15000 });
  const steps = await api(`runs/${run.id}/steps`), helper = steps.helpers[0], q = helper.waiting[0];
  check(helper && (await card.textContent()).includes(helper.name) && (await card.textContent()).includes(helper.model), `the helper card names ${helper?.name} and its model ${helper?.model}`);
  check((await card.locator(".hpask17c").textContent()).includes(q.question || q.label), "its question names the exact request");
  await card.locator('[data-act="hpdo17c"][data-v="allow"]').click();
  await until("the question answered", async () => !(await api("policy")).waiting.some((w) => w.sessionId === q.sessionId && w.fingerprint === q.fingerprint));
  check(true, "Allow once: GET /api/policy no longer lists that exact request");
  const settled = await until("the helper settled", async () => { const h = (await api(`runs/${run.id}/steps`)).helpers[0]; return h.status !== "needs_input" && h; });
  check(settled.status === "completed", `the helper is settled (${settled.status}), not carried on`);
  check((await api("state")).runs.filter((r) => r.sessionId === helper.sessionId).length === 1, "nothing was started in the helper's conversation");
  const calls = model.bodies.length;
  release();
  await until("the task finished", async () => (await api(`runs/${run.id}`)).status === "completed" || (await api(`runs/${run.id}`)).run?.status === "completed", 30000);
  check(model.bodies.slice(calls).some((b) => b.includes(NOTE)), "the task's next model call carried the steered note");
  return run;
}

/* 3: the Timeline tab and its controls. */
async function timeline(page, run) {
  const data = await api(`runs/${run.id}/steps`), n = data.steps.length;
  await page.locator('#pane .ptab[data-p="tl17c"]').click();
  const at = page.locator(".tlat17c .tla-h17c b");
  await at.waitFor({ state: "visible", timeout: 15000 });
  // The panel reads the steps again at most every two seconds; the finished task's last steps arrive with the next read.
  const opened = await until("the newest step", async () => (await at.textContent()) === `At step ${n} of ${n}`, 10000).catch(() => false);
  check(opened, `the Timeline opens at the newest step (${n} steps from GET /api/runs/<id>/steps; shown: ${await at.textContent()})`);
  await page.locator('[data-act="tlstep17c"][data-v="-1"]').click();
  check((await at.textContent()) === `At step ${n - 1} of ${n}`, "Step back");
  await page.locator('[data-act="tlstep17c"][data-v="1"]').click();
  check((await at.textContent()) === `At step ${n} of ${n}`, "Step forward");
  await page.locator('.tk17c[data-act="tlgo17c"]').first().click();
  check((await at.textContent()) === `At step 1 of ${n}`, "a tick jumps to its step");
  check((await page.locator(".tlat17c h3").textContent()).length > 0 && data.steps[0].title.length > 0, "the step card shows the engine's words for step 1");
  await page.locator('[data-act="tlplay17c"]').click();
  await until("Play moves on", async () => (await at.textContent()) !== `At step 1 of ${n}`, 5000);
  check(true, "Play replays the steps on its own");
  await page.locator('[data-act="tlplay17c"]').click().catch(() => undefined);
  const tool = data.steps.findIndex((s) => s.kind === "tool" && s.callId);
  await page.locator(`.tll17c [data-act="tlgo17c"][data-v="${tool}"]`).click();
  const jump = page.locator('[data-act="tljump17c"]');
  await jump.waitFor({ state: "visible", timeout: 10000 });
  const mid = await jump.getAttribute("data-mid");
  await jump.click();
  check(await page.locator(`#conversation [data-i15="${mid}"].flash15`).count() === 1, "Show it in the conversation flashes the message that asked for the tool");
  if (!(await page.locator("#pane").isVisible())) await page.locator('.head [data-act="pane"]').click();
  await page.locator('#pane .ptab[data-p="tl17c"]').click();
  await page.locator('[data-act="tlver17c"]').click();
  const ver = page.locator(".tlver17c b");
  await until("the check answered", async () => (await ver.textContent()) !== "Checking each link…" && (await ver.textContent()) !== "Check the record", 10000);
  const engine = (await api("safety-extras/activity/verify", { tip: data.chain.tip })).check;
  check(engine.ok && (await ver.textContent()) === "Record intact", `Check the record: the engine says ${engine.reason} and the task's link is in the chain`);
}

/* Look inside on the reply opens the Timeline at that task. */
async function lookInside(page, run) {
  await page.locator('#pane .ptab[data-p="activity"]').click();
  const look = page.locator(`[data-act="inspect"][data-run="${run.id}"]`).last();
  await look.dispatchEvent("click"); // the message's buttons show on hover; the click is the same one a hover would allow
  const every = page.locator('.dlg [data-act="tlopen17c"]');
  await every.waitFor({ state: "visible", timeout: 15000 }).catch(async (error) => {
    console.log("look inside buttons:", await page.locator(`[data-act="inspect"]`).count(), "dialog:", await page.locator(".dlg").textContent().catch(() => "none"));
    throw error;
  });
  await every.click();
  await page.locator('#pane .ptab[data-p="tl17c"][aria-selected="true"]').waitFor({ timeout: 10000 });
  check((await page.locator(".tlh17c b").textContent()) === (await api(`runs/${run.id}/steps`)).title, "Look inside › Every step opens the Timeline at that task");
  // The reply's More menu has the same way in.
  await page.locator('#pane .ptab[data-p="activity"]').click();
  const reply = page.locator(`#conversation .b:has([data-act="inspect"][data-run="${run.id}"]) [data-act="more17c"]`).last();
  await reply.dispatchEvent("click");
  const row = page.locator('.pop [data-act="tlopen17c"]');
  await row.waitFor({ state: "visible", timeout: 10000 });
  check((await row.getAttribute("data-run")) === run.id && (await row.textContent()).includes("Every step behind this reply"), "More › Every step behind this reply names that task");
  await row.click();
  await page.locator('#pane .ptab[data-p="tl17c"][aria-selected="true"]').waitFor({ timeout: 10000 });
  check(true, "More › Every step behind this reply opens the Timeline");
  // DG-114, DG-118: closing the panel gives the keyboard back to the switch that opens it, by its close button or the keys.
  await page.locator('#pane [data-act="pane"][data-p="close"]').click();
  const onSwitch = () => page.evaluate(() => document.activeElement?.matches('[data-act="pane"][data-p="activity"]') ?? false);
  check(await page.locator("#pane").isHidden() && await onSwitch(), "closing the panel puts focus back on its switch");
  await page.keyboard.press("Control+Shift+K");
  await page.locator("#pane").waitFor({ state: "visible", timeout: 5000 });
  await page.keyboard.press("Control+Shift+K");
  check(await page.locator("#pane").isHidden() && await onSwitch(), "closing it with Ctrl+Shift+K does the same");
}

/* 4: a second message on the other model, and the note where the switch happened. */
async function modelSwitch(page, run, b) {
  await api(`sessions/${run.sessionId}/model`, { preset: b.id });
  await page.locator("#prompt").fill("second check");
  await page.locator("#send").click();
  const runs = await until("the second task", async () => { const all = (await api("state")).runs.filter((r) => r.sessionId === run.sessionId && r.status === "completed"); return all.length >= 2 && all; }, 30000);
  const ids = new Set(runs.map((r) => r.model?.presetId ?? r.model?.model));
  check(ids.size >= 2, `GET /api/state: the two tasks ran on different models (${[...ids].join(", ")})`);
  const note = page.locator(".drop17c");
  await note.waitFor({ state: "visible", timeout: 20000 });
  check((await note.textContent()).includes("Switched to"), "the thread shows the switch note where it happened");
  await note.locator('[data-act="dropwhy17c"]').click();
  check(await page.locator(".pop .pt").filter({ hasText: "Why earlier thinking" }).count() === 1, "Why opens the explanation");
  await page.keyboard.press("Escape");
}

(async () => {
  const server = await standIn();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const { b } = await setup(server.address().port);
    await signIn(page);
    await page.locator('[data-act="newmenu"]').first().click();
    await page.locator('[data-act="newconv"]').first().click();
    const run = await steerAndHelpers(page);
    await timeline(page, run);
    await lookInside(page, run);
    await modelSwitch(page, run, b);
  } catch (error) { check(false, error.message); }
  finally {
    release();
    for (const undo of cleanup.reverse()) await undo().catch((e) => console.log("cleanup:", e.message));
    check(errors.length === 0, `page errors: ${errors.length}${errors.length ? " " + errors.join(" | ") : ""}`);
    await browser.close();
    server.close();
  }
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
})();
