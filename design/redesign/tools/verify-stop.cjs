/* Stop in Send's place: while a conversation's task works (here: waiting on a yes under "Ask before changes"), the round
   button is Stop; typing gives Send back; Stop cancels the task (GET /api/runs/<id> says cancelled) and Send returns.
   Run: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-stop.cjs. It sets approvals to "Ask before changes" and
   puts the owner's policy back at the end. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { PORT, TOKEN } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN"); process.exit(2); }
const base = `http://127.0.0.1:${PORT}`;
const api = async (path, body) => {
  const r = await fetch(`${base}/api/${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 300)); } return null; };
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

(async () => {
  const before = (await api("policy")).policy;
  const ask = (await api("policy")).presets.find((p) => p.id === "ask-before-changes");
  await api("policy", { ...before, preset: ask.id, rules: ask.rules });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
    await page.goto(base + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#prompt").waitFor();
    const words = "write a verify note to notes/stop.md";
    await page.fill("#prompt", words);
    await page.locator("#send").click();
    const run = await until(async () => (await api("state")).runs.find((r) => r.prompt === words && ["running", "queued", "waiting", "needs_input"].includes(r.status)));
    check("the task is working or waiting", run, run?.status);
    const stop = page.locator('#send[data-act="stop-run"]');
    check("Stop holds Send's place while it works", await until(async () => (await stop.count()) === 1));
    check("Stop is named Stop", (await stop.getAttribute("aria-label")) === "Stop");
    await page.locator("#prompt").fill("something else");
    check("typing gives Send back", await until(async () => (await page.locator('#send[aria-label="Send"]').count()) === 1, 5000));
    await page.locator("#prompt").fill("");
    check("clearing the box brings Stop again", await until(async () => (await stop.count()) === 1, 5000));
    await stop.click();
    const done = run && await until(async () => { const r = await api(`runs/${run.id}`); const st = r.status ?? r.run?.status; return st === "cancelled" && st; });
    check("Stop cancels the task (GET /api/runs/<id>)", done, done || "still going");
    check("Send comes back once it has stopped", await until(async () => (await page.locator('#send[aria-label="Send"]').count()) === 1, 10000));
    check("no page errors", errors.length === 0, errors.join("; "));
  } finally {
    await browser.close();
    await api("policy", before).catch((e) => console.error("could not restore the policy:", e.message));
  }
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})();
