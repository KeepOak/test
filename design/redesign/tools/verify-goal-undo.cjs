// Checks the goal strip's Undo and the "Undo this goal" dialog against a running engine, each confirmed through the
// engine's own routes.
//   PORT=<port> TOKEN=<hex> WORKSPACE=<the engine's workspace folder> node design/redesign/tools/verify-goal-undo.cjs
// A stand-in model service (an OpenAI-shaped "custom" connection on http://127.0.0.1:<free port>) plays the goal's round:
// it writes goal-made.txt with the file tool and saves one fact with memory.put; the grader scores it below done, so the
// goal carries on until this script pauses it (the strip, and so Undo, shows only while a goal is working or paused).
// 1. Undo on the strip opens "Undo this goal", whose rows are the engine's preview (GET /api/sessions/<id>/goal/undo):
//    the rounds, the file, and the fact.
// 2. "Undo the goal" undoes it (POST …/goal/undo): GET …/goal is null, the fact is gone from GET /api/memory, the file is
//    gone from the workspace, and the strip is gone from the conversation.
// Setup, for a throwaway engine only (its launch file lets it reach this computer's addresses):
//   echo '{"web":{"allowPrivateAddresses":true}}' > launch.json
//   BRANCH_INTEGRATIONS=launch.json BRANCH_WORKSPACE=<fresh dir> BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
const http = require("node:http");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("playwright");

const { PORT, TOKEN, WORKSPACE } = process.env;
if (!PORT || !TOKEN || !WORKSPACE) { console.error("Set PORT, TOKEN and WORKSPACE (see the setup above)"); process.exit(2); }
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
  for (const t0 = Date.now(); Date.now() - t0 < ms; await pause(250)) { const v = await test().catch(() => null); if (v) return v; }
  throw new Error("timed out: " + what);
}
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };

/* ---------- the stand-in model ---------- */
const FACT = "You buy printer paper about every six weeks";
function answer(body) {
  const messages = body.messages ?? [], last = messages.at(-1);
  if (/judging whether a goal/.test(String(last?.content ?? "")))
    return { role: "assistant", content: JSON.stringify({ score: 0.3, missing: ["the order itself"], blocked: false }) };
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const results = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  const by = (re) => (body.tools ?? []).find((t) => re.test(t.function?.description ?? ""))?.function?.name;
  const call = (name, args) => ({ id: `c${Date.now()}${Math.random()}`.replace(".", ""), type: "function", function: { name, arguments: JSON.stringify(args) } });
  if (!/Goal: Reorder the paper/.test(String(messages[lastUser]?.content ?? ""))) return { role: "assistant", content: "Working on it." };
  const write = by(/^Write a UTF-8 workspace file/), put = by(/^Save one clear fact with its source/), load = by(/^Load tools you already know the exact names of/);
  // The fact tool may be one step away: it is loaded first with the engine's own loader.
  if (!put && load && results === 0) return { role: "assistant", content: null, tool_calls: [call(load, { names: ["memory.put"] })] };
  const wrote = messages.slice(lastUser + 1).some((m) => (m.tool_calls ?? []).some((c) => c.function?.name === write));
  if (put && write && !wrote)
    return { role: "assistant", content: null, tool_calls: [call(write, { path: "goal-made.txt", content: "made by the goal" }), call(put, { text: FACT, source: "the order history" })] };
  return { role: "assistant", content: "Working on it." };
}
function standIn() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }] }));
      const body = JSON.parse(raw || "{}"), message = answer(body), finish = message.tool_calls ? "tool_calls" : "stop";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = message.tool_calls ? { role: "assistant", tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) } : message;
        return res.end(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
      }
      res.end(JSON.stringify({ id: "r", object: "chat.completion", model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
    });
  });
  return new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => done(server)); });
}

async function signIn(page) {
  await api("onboarding", { done: true });
  await page.goto(BASE);
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}

(async () => {
  const model = await standIn();
  const cleanup = [() => model.close()];
  const browser = await chromium.launch({ headless: true });
  try {
    const { policy, presets } = await api("policy");
    cleanup.push(() => api("policy", { ...policy, confirmLoosening: true })); // putting back what was there before
    await api("policy", { ...policy, preset: "workspace", rules: presets.find((p) => p.id === "workspace").rules });
    const added = await api("connections/from-preset", { provider: "custom", key: "stand-in-test-key", model: "stand-in", name: "Stand-in",
      extras: { baseUrl: `http://127.0.0.1:${model.address().port}/v1` } });
    cleanup.push(() => api("connections/forget", { id: added.id }));
    await api("models", { activePreset: added.id });
    const started = await api("goals", { objective: "Reorder the paper", maxRounds: 20 });
    const sid = started.sessionId;
    await until("the goal's first round", async () => (await api(`sessions/${sid}/goal`)).goal?.round >= 1 && existsSync(join(WORKSPACE, "goal-made.txt")));
    await api(`sessions/${sid}/goal`, { action: "pause" });
    await until("the goal paused", async () => (await api(`sessions/${sid}/goal`)).goal?.status === "paused");
    const facts = async () => ((await api("state")).memory ?? []).map((m) => m.data?.text ?? m.text);
    check((await facts()).includes(FACT), "the goal learned its fact (GET /api/memory)");

    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page);
    await page.locator(`#side [data-act='chat'][data-id="${sid}"]`).click();
    await page.locator(`[data-act="goalundob17"][data-id="${sid}"]`).waitFor({ timeout: 30000 });
    check(true, "the strip of a paused goal has Undo beside Stop");
    await page.locator(`[data-act="goalundob17"][data-id="${sid}"]`).click();
    const dlg = page.locator(".dlg");
    await dlg.waitFor();
    const text = await dlg.innerText();
    const preview = await api(`sessions/${sid}/goal/undo`);
    check(/Undo this goal/.test(text), "the dialog is titled Undo this goal");
    check(text.includes(`${preview.rounds} so far`) && /Kept in the history/.test(text), `Rounds: ${preview.rounds} so far, kept in the history (GET …/goal/undo)`);
    check(text.includes("goal-made.txt") && preview.files.some((f) => f.path === "goal-made.txt"), "the file the goal made is listed");
    check(text.includes(FACT) && preview.facts.some((f) => f.text === FACT) && /Forgotten/.test(text), "the fact it learned is listed as Forgotten");
    await dlg.locator('[data-act="goalundogob17"]').click();
    await until("the goal undone", async () => (await api(`sessions/${sid}/goal`)).goal === null);
    check(true, "Undo the goal: GET …/goal is null");
    check(!(await facts()).includes(FACT), "the fact is forgotten (GET /api/memory)");
    check(!existsSync(join(WORKSPACE, "goal-made.txt")), "the file the goal made is gone from the workspace");
    await until("the strip gone", async () => (await page.locator(`[data-act="goalundob17"][data-id="${sid}"]`).count()) === 0, 10000);
    check(true, "the strip is gone from the conversation");
    const kept = (await api(`sessions/${sid}`)).messages ?? [];
    check(kept.some((m) => m.role === "user" && /Reorder the paper/.test(m.content)), "the conversation itself stays (GET /api/sessions/<id>)");
    check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  } finally {
    await browser.close();
    for (const step of cleanup.reverse()) await Promise.resolve(step()).catch((e) => console.log("cleanup:", e.message));
  }
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
