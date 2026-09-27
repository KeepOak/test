/* Dogfood safety, in the real window against a FRESH engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-dogfood-safety.cjs
   Automations › words to a schedule: the proposal card says what the schedule may do (the engine's words, the least
   its words need), and Confirm saves exactly that list, with no screen, sending or running (GET /api/schedules/<id>).
   The screen guard, the No that replies and the model's room are engine behaviour, proved with stand-ins in
   tests/screen-guard.test.mjs, tests/refusal-reply.test.mjs and tests/context-room.test.mjs. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const { PORT = "3404", TOKEN } = process.env;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => { const b = document.createElement("button"); b.dataset.act = n; Object.assign(b.dataset, d); document.getElementById("app").appendChild(b); b.click(); b.remove(); }, [name, data]);
  await sleep(500);
}
const dangerous = (list) => list.filter((p) => p.startsWith("desktop.") || ["channels.send", "code.execute", "shell.execute", "remote.execute"].includes(p));

async function scheduleCard(page) {
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  await page.fill("#nl-in", "every weekday at 8, read the merged pull requests and summarise them. Read-only, public web.");
  await page.click('[data-act="nl-add"]');
  await page.waitForSelector(".prop17d", { timeout: 8000 });
  const card = await page.locator(".prop17d").innerText();
  check("the card says what it may do, in the engine's words", /What it may do: It only reads/.test(card) && /cannot use your screen, send anything or run programs/.test(card), card.split("\n").find((l) => l.startsWith("What it may do")));
  check("a proposal saves nothing (GET /api/schedules)", (await api("schedules")).schedules.length === 0);
  await page.click('[data-act="ppok17d"]');
  const saved = await (async () => { for (let i = 0; i < 40; i++) { const got = (await api("schedules")).schedules; if (got.length) return got; await sleep(250); } return []; })();
  check("Confirm saves one schedule (GET /api/schedules)", saved.length === 1);
  const record = saved[0] ? await api(`schedules/${saved[0].id}`) : { data: {} };
  const permissions = record.data?.permissions ?? [];
  check("it holds reading and nothing that sends, runs or sees the screen", permissions.includes("web.read") && dangerous(permissions).length === 0 && !permissions.includes("files.write"), permissions.join(", "));
}

(async () => {
  if (!TOKEN) throw new Error("TOKEN is required");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  try {
    await api("onboarding", { done: true });
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector("#main", { timeout: 15000 });
    await sleep(1200);
    try { await scheduleCard(page); } catch (error) { check("scheduleCard ran to the end", false, error.message.split("\n")[0]); }
    check("no page or console errors", errors.length === 0, errors.join("; "));
  } finally { await browser.close(); }
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})();
