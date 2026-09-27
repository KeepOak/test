/* No demo model (the owner's decision): proves, against a FRESH engine with no model set up, that nothing offers a
   made-up model, that a message gets the engine's plain refusal with the way to set one up, and that a stand-in real
   model (an OpenAI-shaped stub this script serves on a local port) answers once it is added — with no restart.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
       (with BRANCH_PROVIDER and BRANCH_MODEL_PRESETS unset)
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-no-demo.cjs
   Every change is read back through the engine's own GET routes. Page errors must be zero. Test data it makes through the
   engine: one conversation refused, one LM Studio connection named "Stand-in" answered by the stub on 127.0.0.1:1234 (added with
   POST /api/connections/from-preset, later forgotten again), and one answered conversation. */
const http = require("node:http");
let playwright;
try { playwright = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright"); }
catch { playwright = require("playwright"); }
const { chromium } = playwright;

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const REPLY = "Hello from the stand-in model.";
const REFUSAL = /^No model yet\. Choose one in setup or in Settings › Models\.$/;
const DEMO = /Offline demonstration|offline-demo-fixture|Practice mode|Practice first/;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (page, ms = 700) => page.waitForTimeout(ms);

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(250); } }

/* An OpenAI-shaped model on this computer: lists one model, and answers every chat with the same words (streamed or not). */
function stub() {
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] })); return; }
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
      const body = JSON.parse(raw || "{}");
      const usage = { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: REPLY } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage }));
      }
      return;
    }
    res.writeHead(404); res.end();
  });
  // The catalog's LM Studio line may be reached on its own address only (src/local-connection-policy.ts), so the stub
  // takes that port; the script stops if something else already holds it.
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(1234, "127.0.0.1", () => resolve(server)); });
}

/* Every model list the engine hands the window, and whether any names a demo. */
async function modelLists() {
  const [state, savings, knobs, accounts] = await Promise.all([api("state"), api("model-savings").catch(() => ({})), api("knobs").catch(() => ({})), api("accounts").catch(() => ({}))]);
  const text = JSON.stringify([state.models, state.activeModel, savings.connections, knobs.connections, accounts.pools]);
  const demoModel = (state.models?.presets ?? []).some((p) => p.model === "demo" || p.provider === "offline-demo-fixture");
  return { state, text, demo: DEMO.test(text) || demoModel };
}

async function signIn(context) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  return { page, errors };
}
const shown = async (page, sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible());
/* After a reload: the quiet "New to Branch?" card sits over the send button once setup has been seen, so it is dismissed. */
async function reload(page) {
  await page.reload(); await page.locator("#main").waitFor(); await settle(page, 1500);
  const card = page.locator('.welcome10 [data-act="welcome-x"]');
  if (!(await card.count())) await card.waitFor({ timeout: 2500 }).catch(() => null);
  if (await card.count()) { await card.click(); await settle(page, 300); }
}

/* 1: a fresh engine with no model: nothing listed, nothing named as answering, the words for the window. */
async function freshEngine() {
  const { state, text, demo } = await modelLists();
  check("1 fresh engine: onboarding is not done", state.onboarding?.done === false, JSON.stringify(state.onboarding));
  check("1 no model is listed (GET /api/state models.presets)", (state.models?.presets ?? []).length === 0, `${state.models?.presets?.length} presets`);
  check("1 nothing is named as answering (activeModel null)", state.activeModel === null, JSON.stringify(state.activeModel));
  check("1 the engine's words for the window (modelNeeded)", REFUSAL.test(state.modelNeeded ?? ""), state.modelNeeded);
  check("1 no model list names a demo (state, model-savings, knobs, accounts)", !demo, text.slice(0, 160));
  const tested = await api("models/test", {}).then(() => "answered", (e) => e.message);
  check("1 POST /api/models/test refuses in the same words", REFUSAL.test(tested.replace(/^models\/test: /, "")), tested);
}

/* 2: setup opens by itself; skipping it leaves the message box saying a model is needed, with Set up. */
async function refusal(page) {
  const setupOpened = await until(async () => shown(page, ".ob9"), 5000);
  check("2 setup opens on a fresh engine", !!setupOpened);
  if (setupOpened) { await page.locator('.ob9 [data-act="ob-close"]').click(); await settle(page); }
  const row = page.locator('.dock [role="status"]');
  const rowText = (await row.count()) ? await row.first().innerText() : "";
  check("2 the message box states a model is needed, in the engine's words", /No model yet\. Choose one in setup or in Settings › Models\./.test(rowText), rowText);
  check("2 its Set up opens setup's Models step while setup is not done", (await page.locator('.dock [role="status"] [data-act="onboard"][data-v="2"]').count()) === 1);
  const body = await page.locator("body").innerText();
  check("2 no demo anywhere in the window", !DEMO.test(body), body.match(DEMO)?.[0] ?? "");
  const before = (await api("state")).runs.length;
  await page.locator("#prompt").fill("hello");
  await page.locator("#send").click();
  const run = await until(async () => { const runs = (await api("state")).runs; return runs.length > before ? runs.find((r) => r.prompt === "hello" && !["running", "queued"].includes(r.status)) : null; });
  check("2 the message's task was refused (GET /api/state runs: failed)", run?.status === "failed", run?.status);
  check("2 its output is the plain refusal, verbatim", REFUSAL.test(run?.output ?? ""), run?.output);
  const said = await until(async () => (await page.locator("#conversation").innerText()).includes("No model yet. Choose one in setup or in Settings › Models."), 8000);
  check("2 the conversation shows the refusal", !!said);
  check("2 the refusal did not finish setup", (await api("state")).onboarding?.done === false);
  await page.locator('.dock [data-act="onboard"][data-v="2"]').click();
  await page.locator(".ob9").waitFor();
  await page.locator("#ob-trust").check();
  await page.locator('.ob9 [data-act="ob-next"]').click();
  await settle(page, 500);
  check("2 Set up, then Start, lands on setup's Models step", (await page.locator(".ob9 h2").first().innerText()).includes("Which models should answer?"));
  await page.locator('.ob9 [data-act="ob-close"]').click();
  await settle(page);
}

/* 3: the first run has no practice door, and can still go on without choosing. */
async function firstRun(page) {
  await page.locator('[data-act="owner"]').first().click();
  await page.locator('.pop [data-act="firstrun"]').click();
  await page.locator(".first").waitFor();
  await page.locator('.first [data-act="fr-next"]').first().click();
  await settle(page, 300);
  const think = await page.locator(".first").innerText();
  check("3 first run: How should Branch think? has no Practice first door", think.includes("How should Branch think?") && !/Practice/.test(think), think.replace(/\s+/g, " ").slice(0, 140));
  await page.locator('.first [data-act="fr-next"]').first().click();
  check("3 its Later goes on to the accounts step", !!(await page.waitForSelector("text=Connect your accounts", { timeout: 5000 }).catch(() => null)));
  await page.keyboard.press("Escape");
  await settle(page, 300);
}

/* 4: a stand-in real model added with no restart answers, finishes setup, and the message box stops asking. */
async function standIn(page) {
  const added = await api("connections/from-preset", { provider: "lm-studio", key: "stub-key", model: "stub-model", name: "Stand-in" });
  const { state, demo } = await modelLists();
  check("4 the stand-in is the model now (GET /api/state activeModel)", state.activeModel?.presetId === added.id && state.modelNeeded === null, JSON.stringify(state.activeModel?.presetName));
  check("4 the model list holds only the stand-in, no demo", (state.models?.presets ?? []).map((p) => p.id).join() === added.id && !demo);
  await reload(page);
  check("4 the message box no longer says a model is needed", (await page.locator('.dock [role="status"]').count()) === 0);
  if (await page.locator('[data-act="newconv"]').count()) await page.locator('[data-act="newconv"]').first().click();
  await settle(page, 400);
  await page.locator("#prompt").fill("hello again");
  await page.locator("#send").click();
  const run = await until(async () => (await api("state")).runs.find((r) => r.prompt === "hello again" && r.status !== "running" && r.status !== "queued"), 30000);
  check("4 the stand-in answered (GET /api/state runs: completed)", run?.status === "completed" && run.output.includes(REPLY), `${run?.status}: ${run?.output}`);
  check("4 the answer shows in the conversation", !!(await until(async () => (await page.locator("#conversation").innerText()).includes(REPLY), 8000)));
  check("4 the first real answer finished setup (GET /api/state onboarding.done)", (await api("state")).onboarding?.done === true);
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setpage"][data-v="models"]').first().click();
  await settle(page, 1200);
  const models = await page.locator(".settings").innerText();
  check("4 Settings › Models names the stand-in and no demo", models.includes("Stand-in") && !DEMO.test(models), models.match(DEMO)?.[0] ?? "");
  await page.keyboard.press("Escape");
  return added.id;
}

/* 5: with setup done, forgetting the only model brings the words back, and Set up opens Settings › Models. */
async function afterSetup(page, id) {
  await api("connections/forget", { id });
  const state = await api("state");
  check("5 forgetting the only model leaves none (and no error)", state.activeModel === null && REFUSAL.test(state.modelNeeded ?? "") && state.models.presets.length === 0);
  await reload(page);
  const go = page.locator('.dock [role="status"] [data-act="setgo"][data-v="models"]');
  check("5 with setup done, Set up goes to Settings › Models", (await go.count()) === 1);
  if (await go.count()) { await go.click(); await settle(page, 1200); }
  check("5 Settings › Models is open", await shown(page, '.settings [data-act="setpage"][data-v="models"][aria-current="true"]'), await page.locator(".settings h1, .settings h2").first().innerText().catch(() => ""));
}

(async () => {
  const server = await stub();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  let errors = [];
  try {
    await freshEngine();
    const signed = await signIn(context);
    errors = signed.errors;
    await refusal(signed.page);
    await firstRun(signed.page);
    const id = await standIn(signed.page);
    await afterSetup(signed.page, id);
  } catch (error) {
    check("the run finished", false, error.message);
  } finally {
    check("zero page errors", errors.length === 0, errors.join(" | "));
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
