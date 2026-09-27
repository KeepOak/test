/* Times a brand-new person's path in the real window, from a FRESH engine to the first finished task, on the local-model
   path: connect, setup's Models step, "Use" on a model Ollama already has (the download is timed apart, see below),
   the hello answered, then the showcase suggestion "Tidy my Downloads folder" sent from the empty conversation, each
   approval answered yes only when it names the fixture folder, until the task ends. It prints the seconds of each leg
   and the task's own ending (completed or failed, in the engine's words). Nothing is written in: the model is the real
   one Ollama serves.
     USERPROFILE=<fixture home> HOME=<fixture home> BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> \
       BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> MODEL=qwen2.5:7b FIXTURE=<fixture home>\Downloads node design/redesign/tools/time-first-task.cjs
   The download: Ollama's own pull of MODEL is not in these seconds; PULL=1 pulls it first through the picker's own
   route and prints that time on its own line. */
const { chromium } = require("../../../node_modules/playwright");

const { PORT, TOKEN, MODEL = "qwen2.5:7b", FIXTURE = "", PULL } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await sleep(250); } }
const secs = (a, b) => ((b - a) / 1000).toFixed(1);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (PULL) {
    const p0 = Date.now();
    await api("local-models/switch", { mode: "when-needed" });
    const job = await api("local-models/setup", { runtime: "ollama", name: MODEL });
    await until(async () => { const all = await api("local-models"); return (all.ollama?.models ?? []).some((m) => m.name === MODEL) && (all.oneClick?.connections ?? []).length > 0; }, 3_600_000);
    console.log(`download of ${MODEL} (job ${job.id}): ${secs(p0, Date.now())} s, not counted below`);
  }
  const t0 = Date.now();
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  // Setup opens by itself on a fresh engine; its Models step holds the local-model picker.
  // Welcome's promise is ticked, then Next until the Models step's picker shows the model.
  await page.locator("label.ob-agree").click();
  const use = page.locator(`.lp [data-act="lp-use"][data-v="${MODEL}"], .lp [data-act="lp-auto"][data-v="${MODEL}"]`).first();
  for (let i = 0; i < 4 && !(await use.isVisible().catch(() => false)); i++) {
    await page.locator('[data-act="ob-next"]').first().click();
    await sleep(400);
  }
  await use.waitFor({ timeout: 60_000 });
  const t1 = Date.now();
  await use.click();
  const hello = await until(async () => { const said = await page.locator(".lp .status").first().textContent(); return /answered|Hello|OK/i.test(said ?? "") ? said : null; }, 180_000);
  const t2 = Date.now();
  console.log(`connect to the picker: ${secs(t0, t1)} s; Use to the hello answered: ${secs(t1, t2)} s (${(hello ?? "no answer").trim().slice(0, 120)})`);
  await page.locator('[data-act="ob-close"]').first().click();
  const chip = page.locator('[data-act="sugg"]').filter({ hasText: /Downloads/ }).first();
  await chip.waitFor({ timeout: 20_000 });
  const before = new Set(((await api("state")).runs ?? []).map((r) => r.id));
  await chip.click();
  const t3 = Date.now();
  let run = null, asked = 0, said = [];
  for (;;) {
    const state = await api("state");
    run = (state.runs ?? []).find((r) => !before.has(r.id)) ?? null;
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) break;
    for (const q of (await api("policy")).waiting ?? []) {
      if (said.includes(q.fingerprint)) continue;
      said.push(q.fingerprint);
      asked++;
      const text = JSON.stringify(q);
      // The engine asks once to work in the Downloads folder, naming its real path (src/owner-folders.ts); that question,
      // or one naming the fixture folder, is answered yes for the conversation. Anything else is refused.
      const slashes = (path) => String(path ?? "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
      const downloadsQuestion = q.tool === "files.ownerFolder" && /\/downloads$/.test(slashes(q.target))
        && (!FIXTURE || slashes(q.target) === slashes(FIXTURE));
      const yes = downloadsQuestion || (FIXTURE && text.includes(JSON.stringify(FIXTURE).slice(1, -1)));
      console.log(`approval ${asked}: ${yes ? "yes" : "no"} · ${String(q.summary ?? q.tool ?? "").slice(0, 160)}`);
      await api("policy/approve", { sessionId: q.sessionId, decision: yes ? "allow" : "deny", remember: yes ? "session" : "never", fingerprint: q.fingerprint, carryOn: true });
    }
    if (Date.now() - t3 > 300_000) break;
    await sleep(500);
  }
  const t4 = Date.now();
  console.log(`the showcase task: ${run?.status ?? "did not end"} after ${secs(t3, t4)} s, ${asked} approval(s): ${String(run?.output ?? "").slice(0, 300)}`);
  console.log(`TOTAL fresh engine to the first task's end: ${secs(t0, t4)} s (the model download excluded)`);
  console.log(`page errors: ${errors.length}${errors.length ? " " + errors.join(" | ") : ""}`);
  await browser.close();
  process.exit(run?.status === "completed" && !errors.length ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
