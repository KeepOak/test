/* Batch E, proved in the real window with the real mouse, each change read back through the engine's own GET route.
   Page errors must be zero. Two engines:
   1. The reviewer's throwaway engine (PORT, TOKEN), fresh data, no model, the browser dashboard left as it ships:
        BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
        PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-batch-e.cjs
      - Automations › Scheduled › Pause all and Resume all (pauseallb17) with the dashboard off:
        GET /api/dashboard/automations, GET /api/schedules.
      - Team › Signing in: taking away the last check (si-chain) is refused in plain words and the check stays on:
        GET /api/people/settings.
   2. A second engine started here in-process with a scripted model (its own temp folder, a free port): a Trunk, asked
      in its own conversation, calls procedures.auto.suggest_change; the flow editor shows "<Trunk> suggests a change",
      "Keep it as it is" answers no and "Approve version 2" answers the next one yes: GET /api/autonomy/ledger and
      GET /api/autonomy/procedures. */
const { chromium } = require(process.env.PLAYWRIGHT || require("node:path").join(__dirname, "../../../node_modules/playwright"));
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gselChoices, gselShown, pickGsel } = require("./gsel.cjs");

const { PORT, TOKEN } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await sleep(150); } }

function client(base, token) {
  return async (p, body) => {
    const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
}
async function signIn(page, base, token, api) {
  await api("onboarding", { done: true });
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator('.side-nav [data-act="view"]').first().waitFor({ timeout: 60000 });
}
const place = (page, v) => page.locator(`.side-nav [data-act="view"][data-v="${v}"]`).first().click();
const tab = (page, where, v) => page.locator(`[data-act="ptab"][data-place="${where}"][data-v="${v}"]`).first().click();
const toastText = async (page) => (await until(async () => (await page.locator(".toast").first().innerText()) || null, 8000)) ?? "";
const clearToast = (page) => page.evaluate(() => document.querySelector(".toast")?.remove());

/* ---------- 1. the reviewer's engine ---------- */
async function pauseAll(page, api) {
  check("the browser dashboard is off", (await api("dashboard/settings")).mode === "off");
  await api("schedules", { prompt: "Check the post", kind: "reminder", dueAt: new Date(Date.now() + 3600e3).toISOString() });
  const pending = (await api("schedules")).schedules.filter((s) => s.data.status === "pending").length;
  await page.evaluate(() => { const b = document.createElement("button"); b.dataset.act = "setlevel"; b.dataset.v = "advanced"; document.getElementById("app").appendChild(b); b.click(); b.remove(); });
  await place(page, "automations");
  await tab(page, "automations", "scheduled");
  const button = page.locator('[data-act="pauseallb17"]');
  await button.waitFor();
  await until(async () => (await button.getAttribute("data-v")) === "pause");
  await button.click();
  const paused = await until(async () => (await api("dashboard/automations")).paused);
  const still = (await api("schedules")).schedules.filter((s) => s.data.status === "pending").length;
  check("pauseallb17: Pause all pauses with the dashboard off", paused && still === 0,
    `GET /api/dashboard/automations: ${paused?.schedules?.length ?? 0} schedule(s) paused of ${pending}; GET /api/schedules: ${still} pending`);
  check("the row says Resume all", await until(async () => (await button.getAttribute("data-v")) === "resume"));
  await button.click();
  const resumed = await until(async () => (await api("dashboard/automations")).paused === null);
  const back = (await api("schedules")).schedules.filter((s) => s.data.status === "pending").length;
  check("pauseallb17: Resume all puts them back", resumed && back === pending, `GET /api/dashboard/automations: paused null; ${back} pending`);
  check("the dashboard stays off", (await api("dashboard/settings")).mode === "off");
}

async function signingIn(page, api) {
  await place(page, "team");
  await tab(page, "team", "signin");
  const pin = page.locator('[data-act="si-chain"][data-v="pin"]');
  await pin.waitFor();
  const before = (await api("people/settings")).settings.chain;
  await clearToast(page);
  await pin.click();
  const said = await toastText(page);
  const after = (await api("people/settings")).settings.chain;
  check("si-chain: the last check is refused in plain words", /^Keep at least one way for people to prove it's them/.test(said), `the toast says "${said}"`);
  check("si-chain: the last check stays on", JSON.stringify(before) === JSON.stringify(after) && (await pin.getAttribute("aria-pressed")) === "true", `GET /api/people/settings chain ${JSON.stringify(after)}`);
}

/* ---------- 2. the scripted engine ---------- */
const withCheck = [{ title: "Read", prompt: "Read the card statement." }, { title: "Check", prompt: "Ask me for any missing receipt.", confirm: true },
  { title: "Match", prompt: "Match receipts in Downloads." }];
function scripted(state) {
  return { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    const said = [...request.messages].reverse().find((m) => m.role === "user" && /^suggest \d/.test(String(m.content ?? "")));
    // After the owner's yes the task carries on, told its call did not run, so it makes the call again.
    const again = last?.role === "tool" && !/"ok":true/.test(String(last.content));
    const asked = (last?.role === "user" || again) && said && /^suggest (\d)/.exec(String(said.content));
    if (asked) {
      const steps = asked[1] === "1" ? withCheck : withCheck.slice(1);
      return { content: "", toolCalls: [{ id: `s${Date.now()}`, name: "procedures.auto.suggest_change",
        arguments: JSON.stringify({ procedureId: state.procedureId, steps, why: "Last month two receipts were missing and the report had to be built twice." }) }] };
    }
    return { content: "Suggested.", toolCalls: [] };
  } };
}
async function suggestions(browser, errors) {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-batch-e-"));
  const state = {};
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(state) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const api = client(server.url, server.token);
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => errors.push(`scripted: ${e.message}`));
  try {
    await api("autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: true });
    const { procedure } = await api("autonomy/procedures", { name: "Month-end report", start: { kind: "manual" },
      steps: [{ title: "Read", prompt: "Read the card statement." }, { title: "Match", prompt: "Match receipts in Downloads." }] });
    state.procedureId = procedure.id;
    const trunk = (await api("trunks", { name: "Ledger" })).trunk;
    const ask = async (n) => {
      // A new Trunk first introduces itself in its conversation; the owner's message goes once that has finished.
      const run = await until(() => app.runtime.run({ prompt: `suggest ${n}`, sessionId: trunk.chatSessionId }), 20000);
      // Asking the owner is itself asked first under the approval rules; the owner says yes (the Inbox's own route).
      if (run?.status === "needs_input") {
        const asked = app.runtime.approvals.questionFor(run.sessionId);
        await api("policy/approve", { sessionId: run.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
      }
      const mine = (e) => e.kind === "procedure" && e.status === "pending" && e.payload?.procedureId === procedure.id;
      return (await until(async () => (await api("autonomy/ledger")).entries.find(mine))) ?? { run };
    };
    const first = await ask(1);
    check("a Trunk's turn calls procedures.auto.suggest_change", first.from === "assistant" && first.payload?.trunk === trunk.id,
      `GET /api/autonomy/ledger: from ${first.from}, trunk ${first.payload?.trunk === trunk.id ? "Ledger" : first.payload?.trunk}${first.run ? `; run ${first.run.status}` : ""}`);
    await signIn(page, server.url, server.token, api);
    const open = async () => {
      await place(page, "automations");
      await tab(page, "automations", "procedures");
      await page.locator(".pp-pill17d").first().waitFor({ timeout: 15000 });
      await page.locator(`[data-act="flow"][data-id="${procedure.id}"]`).click();
      await page.locator(".dlg .fp17d").waitFor();
    };
    await open();
    check("the suggestion names the Trunk, shows its face and why", /Ledger suggests a change/.test(await page.locator(".dlg .fp17d").innerText()) && (await page.locator(".dlg .fp17d .av").count()) === 1);
    const kinds = await gselChoices(page.locator(".dlg #fk-0")), disabled = kinds.filter((c) => c.off).map((c) => c.words);
    check("every kind of step can be picked: the engine runs them all", disabled.length === 0 && kinds.length === 8, disabled.join(", "));
    await page.locator('.dlg [data-act="ppsee17d"]').click();
    await page.locator('.dlg [data-act="ppdeny17d"]').waitFor();
    check("ppsee17d: See the change shows the difference", (await page.locator(".dlg .df17d li.add").count()) === 1);
    await clearToast(page);
    await page.locator('.dlg [data-act="ppdeny17d"]').click();
    const said = await toastText(page);
    const denied = await until(async () => (await api("autonomy/ledger?status=all")).entries.find((e) => e.id === first.id && e.status === "dismissed"));
    check("ppdeny17d: Keep it as it is answers no", denied && (await api("autonomy/procedures")).procedures[0].version === undefined, `GET /api/autonomy/ledger: dismissed; the toast says "${said}"`);
    await page.keyboard.press("Escape");
    const second = await ask(2);
    await open();
    await page.locator('.dlg [data-act="ppsee17d"]').click();
    await page.locator('.dlg [data-act="ppapprove17d"]').click();
    const changed = await until(async () => (await api("autonomy/procedures")).procedures.find((p) => p.version === 2));
    const accepted = (await api("autonomy/ledger?status=all")).entries.find((e) => e.id === second.id)?.status;
    check("ppapprove17d: Approve version 2 answers the suggestion yes", changed && accepted === "accepted",
      `GET /api/autonomy/procedures: version ${changed?.version}, steps ${changed?.procedure.steps.map((s) => s.title).join(", ")}; ledger ${accepted}`);
  } finally {
    await page.close(); await server.close(); await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const base = `http://127.0.0.1:${PORT}`, api = client(base, TOKEN);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page, base, TOKEN, api);
    await pauseAll(page, api);
    await signingIn(page, api);
    await page.close();
    await suggestions(browser, errors);
  } catch (error) {
    check("ran to the end", false, error.message);
  } finally {
    await browser.close();
  }
  check("zero page errors", errors.length === 0, errors.join(" | "));
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
