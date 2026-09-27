// Checks every control the approvals-and-modes area made live, against a running engine, through the engine's own routes.
//   PORT=<port> TOKEN=<hex> [CERT=<cert.pem> KEY=<key.pem>] node design/redesign/tools/verify-approvals-modes.cjs
// Without CERT and KEY only the Lockdown checks run; the save-progress checks need the setup below.
// 1. Lockdown, both ways, confirmed each time with GET /api/lockdown: the mode menu's switch on and then off; the
//    Overview's Lockdown button on, then the red banner it shows, whose "Turn it off" switches it off.
// 2. The save-progress offer: a stand-in model service answers with the allowance headers of a window 98% used and holds
//    its reply, so a task is really running near a measured limit. The offer appears from GET /api/usage/glance; Save
//    progress sends the running task the engine's note (GET /api/runs/<id>/inspect steering, and seen arriving at the
//    model), and Not now dismisses it without asking anything. The stand-in is an OpenAI-shaped "custom" connection at https://127.0.0.2:<free port>: Branch counts
//    only 127.0.0.1/localhost as a local model (which never reports a limit), and wants https anywhere else.
// Setup, for a throwaway engine only (its launch file lets it reach this computer's addresses, and it trusts the cert):
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=127.0.0.2 -addext subjectAltName=IP:127.0.0.2
//   echo '{"web":{"allowPrivateAddresses":true}}' > launch.json
//   NODE_EXTRA_CA_CERTS=cert.pem BRANCH_INTEGRATIONS=launch.json BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
// Leaves Lockdown off, takes the stand-in connection out again (POST /api/connections/forget), puts back the model that
// answered before, and prints each check.
const https = require("node:https");
const { readFileSync } = require("node:fs");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const { PORT, TOKEN, CERT, KEY } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN"); process.exit(2); }
const cleanup = [];
const BASE = `http://127.0.0.1:${PORT}`;
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
  for (const t0 = Date.now(); Date.now() - t0 < ms; await pause(300)) { const v = await test(); if (v) return v; }
  throw new Error("timed out: " + what);
}
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };

/* The stand-in model service: headers at once (the engine reads the allowance from them), the reply only when released. */
const model = { held: [], bodies: [] };
// How tool names reach a model (src/providers.ts wireName): the read-only listing of the workspace, which needs no yes.
const LIST = "branch_" + require("node:crypto").createHash("sha256").update("files.list").digest("hex").slice(0, 24);
function standIn() {
  const server = https.createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method === "GET") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }] })); }
      model.bodies.push(raw);
      const stream = /"stream":\s*true/.test(raw);
      res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json", "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "2", "x-ratelimit-reset-requests": "30m0s" });
      res.flushHeaders();
      // A task's first call is held and then lists the workspace, so the task takes another round, the one a steered
      // note goes in front of; its second call finishes it.
      const first = !/"role":\s*"tool"/.test(raw);
      if (first && !raw.includes(LIST)) console.log("the stand-in was not offered files.list");
      const message = first ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: LIST, arguments: '{"path":"."}' } }] } : { role: "assistant", content: "ok" };
      const finish = first ? "tool_calls" : "stop";
      const reply = () => stream
        ? res.end(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "stand-in", choices: [{ index: 0, delta: first ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : message, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
        : res.end(JSON.stringify({ id: "r", object: "chat.completion", model: "stand-in", choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      if (first) model.held.push(reply); else reply();
    });
  });
  return new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.2", () => done(server)); });
}
const release = () => { for (const r of model.held.splice(0)) r(); };

async function signIn(page) {
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  await page.goto(BASE);
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}

const lockedNow = async () => (await api("lockdown")).on;
async function modeSwitch(page) {
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await page.locator('[data-act="modemenu2"]').click();
  return page.locator("#pm-lock2");
}
/* The mode menu's switch, on and then off. */
async function lockdownSwitch(page) {
  await api("lockdown", { on: false });
  let sw = await modeSwitch(page);
  check(!(await sw.isChecked()) && (await sw.isEnabled()), "the mode menu's Lockdown switch is off and can be switched");
  await sw.click();
  check((await until("Lockdown on", lockedNow)) === true, "switch on: GET /api/lockdown says on");
  // The menu draws itself again from the engine's answer (GET /api/conversation-mode locked).
  sw = page.locator("#pm-lock2:checked");
  await sw.waitFor({ timeout: 15000 });
  check(await sw.isEnabled(), "while on, the switch is drawn on and can be switched off");
  await sw.click();
  check((await until("Lockdown off", async () => !(await lockedNow()))) === true, "switch off: GET /api/lockdown says off");
  await page.keyboard.press("Escape");
}
/* The places' red banner: shown while Lockdown is on (#app.locked), its "Turn it off" switches it off. The Overview's
   Lockdown button switches it on. */
async function lockdownBanner(page) {
  await api("lockdown", { on: false });
  await page.locator('[data-act="view"][data-v="overview"]').first().click();
  await page.locator('.tile [data-act="lock"]').click();
  check((await until("Lockdown on", lockedNow)) === true, "the Overview's Lockdown button: GET /api/lockdown says on");
  const banner = page.locator('.lock-banner [data-act="lock"]').first();
  await banner.waitFor({ state: "visible", timeout: 15000 });
  check(await page.locator("#app.locked").count() === 1, "while on, the window shows the Lockdown banner");
  await banner.click();
  check((await until("Lockdown off", async () => !(await lockedNow()))) === true, "the banner's Turn it off: GET /api/lockdown says off");
  await page.locator(".lock-banner").first().waitFor({ state: "hidden", timeout: 15000 });
  check(await page.locator("#app.locked").count() === 0, "the banner is gone once it is off");
}

async function saveProgressOffer(page, saves, port) {
  const before = (await api("state")).models?.activePreset ?? null;
  const added = await api("connections/from-preset", { provider: "custom", key: "stand-in-test-key", model: "stand-in", name: "Stand-in",
    extras: { baseUrl: `https://127.0.0.2:${port}/v1` } });
  cleanup.push(async () => { await api("connections/forget", { id: added.id }); await api("models", { activePreset: before }); });
  await api("models", { activePreset: added.id });
  const run = api("run", { prompt: "hello" }).catch((e) => e);
  const g = await until("a running task near the limit", async () => { const x = await api("usage/glance"); return x.running > 0 && x.crossings.length ? x : null; })
    .catch(async (error) => { console.log("the task:", String(await Promise.race([run, pause(100).then(() => "still running")]))); throw error; });
  const runId = (await api("state")).runs.find((r) => r.status === "running")?.id;
  check(g.settings.saveProgress === "ask", "GET /api/usage/glance: the owner's offer is on, a task runs, a measured window is past 95%");
  await page.reload();
  const offer = page.locator(".ckpt-q");
  await offer.waitFor({ state: "visible", timeout: 30000 });
  check((await offer.textContent()).includes(g.crossings[0].connectionName), "the offer names the engine's connection");
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/usage/save-progress"));
  await offer.locator('[data-act="ckpt-save"]').click();
  const said = await (await answer).json();
  check(said.asked >= 1, `Save progress: POST /api/usage/save-progress asked ${said.asked} running task(s)`);
  const steering = (await api(`runs/${runId}/inspect`)).steering ?? [];
  check(steering.some((n) => n.text.includes("nearly out of its allowance")), "GET /api/runs/<id>/inspect: the task was steered with the engine's note");
  const calls = model.bodies.length;
  release();
  const ended = await run;
  const later = model.bodies.slice(calls);
  if (!later.length) console.log("the task:", ended instanceof Error ? ended.message : JSON.stringify(ended).slice(0, 300));
  check(later.some((b) => b.includes("nearly out of its allowance")), "the running task's next model call carried the engine's save-progress note");
  return saves.length;
}

async function notNow(page, saves, before) {
  await page.evaluate(() => localStorage.removeItem("branch-save-progress-asked"));
  const run = api("run", { prompt: "hello again" }).catch((e) => e);
  await until("a running task", async () => (await api("usage/glance")).running > 0);
  await page.reload();
  const offer = page.locator(".ckpt-q");
  await offer.waitFor({ state: "visible", timeout: 30000 });
  await offer.locator('[data-act="ckpt-no"]').click();
  check((await page.locator(".ckpt-q").count()) === 0 && saves.length === before, "Not now: the offer is gone and nothing was asked");
  release();
  await run;
}

(async () => {
  const server = CERT && KEY ? await standIn() : null;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [], saves = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/usage/save-progress")) saves.push(r.url());
  });
  try {
    await signIn(page);
    await lockdownSwitch(page);
    await lockdownBanner(page);
    if (server) await notNow(page, saves, await saveProgressOffer(page, saves, server.address().port));
    else console.log("SKIP save-progress: needs CERT, KEY and the engine setup in this file's header");
  } catch (error) { check(false, error.message); }
  finally {
    release();
    await api("lockdown", { on: false }).catch((e) => console.log(e.message));
    for (const undo of cleanup) await undo().catch((e) => console.log(e.message));
    check(errors.length === 0, `page errors: ${errors.length}${errors.length ? " " + errors.join(" | ") : ""}`);
    await browser.close();
    server?.close();
  }
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
})();
