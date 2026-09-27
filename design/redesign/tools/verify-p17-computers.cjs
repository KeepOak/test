/* Pass 17 part D (§1, §2, §3, §4, §8, §9) in the real window, against a fresh engine this script starts itself:
   every control made live is clicked and its change read back through the engine's own GET route; the greyed ones
   (cloud computers, phone calls, meeting notes, the fine chat-app controls, the decision switches the engine does not
   use yet) are checked to be greyed. No page error, console error or refused request is allowed after signing in,
   except the one refusal it asks for on purpose.

   What it starts, all on this computer and all thrown away afterwards:
   - a fresh data folder with two paired computers written into the device book (Tower, Linux; Laptop, macOS);
   - a stand-in model on STUB_PORT, OpenAI-shaped: a learning task gets one workbook.save call, a decision gets its JSON,
     anything else "Done."; the same server stands in for Telegram and refuses the bot token (401), as Telegram does
     once a token is revoked (every method, getMe too, so the engine starts with the token already refused);
   - the engine on PORT (never 3210), pointed at that model and at that Telegram through BRANCH_INTEGRATIONS.
   Run:  PORT=3391 STUB_PORT=33910 node design/redesign/tools/verify-p17-computers.cjs */
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = Number(process.env.PORT ?? 3391), STUB_PORT = Number(process.env.STUB_PORT ?? 33910);
if (PORT === 3210 || PORT === 3299) { console.error("Never the owner's port."); process.exit(2); }
const ROOT = resolve(__dirname, "../../..");
const BASE = `http://127.0.0.1:${PORT}`;
const TOWER = "a1b2c3d4e5f60718", LAPTOP = "0f1e2d3c4b5a6978";
const RUN = Date.now().toString(36).slice(-5);
let TOKEN = "", failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };

/* ---------- the stand-in model and Telegram ---------- */
const wire = (name) => "branch_" + createHash("sha256").update(name).digest("hex").slice(0, 24);
const MUSTS = [
  { text: "An order needs an order number", status: "pass", checks: ["Try to send the form without one", "It says the number is needed"] },
  { text: "Cancelling is free", status: "fail", checks: ["Open a sent order", "Press Cancel"], found: "A fee is added" },
  { text: "A draft is kept for a week", status: "unclear", checks: ["Would need a week"] },
];
function answerFor(body) {
  const msgs = body.messages ?? [], lastUser = msgs.map((m) => m.role).lastIndexOf("user");
  const text = String(msgs[lastUser]?.content ?? "");
  const id = /workbookId ([a-f0-9-]{36})/.exec(text)?.[1];
  const saved = msgs.slice(lastUser).some((m) => m.role === "tool");
  const save = (body.tools ?? []).find((t) => t.function?.name === wire("workbook.save"));
  if (id && !saved && save) return { tool: { name: save.function.name, arguments: JSON.stringify({ workbookId: id, source: "orders.example", pages: 3, must: MUSTS }) } };
  if (/Answer yes or no/.test(text)) return { text: JSON.stringify({ answer: true, confidence: 0.93, why: "It asks for a payment." }) };
  if (/Pick exactly one/.test(text)) return { text: JSON.stringify({ choice: "Books", confidence: 0.9, why: "It is about money." }) };
  return { text: "Done." };
}
function reply(res, stream, out) {
  const message = out.tool ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: out.tool }] } : { role: "assistant", content: out.text };
  const finish = out.tool ? "tool_calls" : "stop";
  if (!stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = out.tool ? { tool_calls: [{ index: 0, id: "call_1", type: "function", function: out.tool }] } : { content: out.text };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.url.startsWith("/tg/")) {
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" })); return;
    }
    const body = JSON.parse(raw || "{}");
    reply(res, body.stream, answerFor(body));
  });
});

/* ---------- a fresh engine ---------- */
async function seed(dataDir, workspace) {
  const { createBranch } = await import(pathToFileURL(join(ROOT, "dist/index.js")).href);
  const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir, provider: quiet });
  const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-26T00:00:00.000Z", lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] });
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "on", requests: [], devices: [device(TOWER, "Tower", "linux"), device(LAPTOP, "Laptop", "darwin")] });
  await app.close();
}
function startEngine(dataDir, workspace, integrations) {
  const env = { ...process.env, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: workspace, BRANCH_PORT: String(PORT), BRANCH_INTEGRATIONS: integrations,
    BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: `http://127.0.0.1:${STUB_PORT}/v1`, BRANCH_MODEL: "stand-in", BRANCH_API_KEY: "local-test", TG_STAND_IN: "revoked-token" };
  const child = spawn(process.execPath, [join(ROOT, "dist/cli.js"), "start"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((ok, bad) => {
    let out = "";
    const timer = setTimeout(() => bad(new Error(`the engine did not start:\n${out}`)), 60000);
    const read = (chunk) => { out += chunk; const m = /paste into browser\): ([a-f0-9]+)/.exec(out); if (m) { clearTimeout(timer); TOKEN = m[1]; ok(child); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
  });
}

/* ---------- helpers ---------- */
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } return null; };
const greyed = async (loc) => (await loc.count()) > 0 && ((await loc.first().getAttribute("aria-disabled")) === "true" || await loc.first().isDisabled());
const live = async (loc) => (await loc.count()) > 0 && !(await greyed(loc));
const dlg = (page) => page.locator(".scrim .dlg");
const closeDlg = async (page) => { if (await dlg(page).count()) { await page.locator('.scrim [data-act="dlg-close"]').first().click(); await settle(page, 300); } };
/* Runs one of the window's own actions, as a button of its would (for places reached from elsewhere in the window). */
const act = (page, name, data = {}) => page.evaluate(([n, d]) => { const b = document.createElement("button"); b.dataset.act = n; Object.assign(b.dataset, d); document.body.appendChild(b); b.click(); b.remove(); }, [name, data]);
async function settingsPage(page, id, lv = "technical") {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setlevel"][data-v="${lv}"]`).first().click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1500);
}
const computersOf = (id) => api(`trunks/${id}/computers`);

/* ---------- §9 and §1: computers per Trunk; the cloud stays greyed ---------- */
async function settingsComputer(page, trunk) {
  await settingsPage(page, "computer");
  const chip = page.locator(`#main [data-act="comp-chip"][data-id="${trunk.id}"][data-v="${TOWER}"]`);
  check("Which Trunk uses which: a chip per computer, live", await live(chip) && (await page.locator(`#main [data-act="comp-chip"][data-id="${trunk.id}"]`).count()) === 3);
  await chip.click();
  await until(async () => !(await computersOf(trunk.id)).allowed.includes(TOWER));
  const after = await computersOf(trunk.id);
  check("comp-chip: taking Tower off is saved", after.limited && JSON.stringify(after.allowed) === JSON.stringify(["this", LAPTOP]), after.allowed.join(","));
  await page.locator(`#main [data-act="comp-max"][data-id="${trunk.id}"][data-v="2"]`).click();
  check("comp-max: At once 2 is saved", (await until(async () => (await computersOf(trunk.id)).atOnce === 2)) === true);
  const too = page.locator(`#main [data-act="comp-max"][data-id="${trunk.id}"][data-v="4"]`);
  await too.click();
  await settle(page, 800);
  check("comp-max: more than its computers is refused by the engine", (await computersOf(trunk.id)).atOnce === 2);
  check("§1 cloud offer: Set one up is greyed", await greyed(page.locator('#main .cl-offer17d [data-act="cloudnew17d"]')));
  await page.locator('#main [data-act="comp-add"]').first().click();
  await settle(page, 500);
  const cloudKind = dlg(page).locator('[data-act="comp-add-go"][data-v="cloud"]');
  check("§1 Add a computer: the kind reads “A cloud computer” and stays greyed", (await cloudKind.locator("b").textContent()) === "A cloud computer" && await greyed(cloudKind));
  await closeDlg(page);
}

async function itsComputers(page, trunk) {
  await page.keyboard.press("Escape");
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-v="trunks"]').click();
  await page.locator(`#main [data-act="edit"][data-id="${trunk.id}"]`).click();
  await settle(page, 400);
  await dlg(page).locator('[data-act="st-tab"][data-v="its17d"]').click();
  await settle(page, 1200);
  const tower = dlg(page).locator(`input[data-sw="itsc17d"][data-v="${TOWER}"]`);
  check("Its computers: a checkbox per computer, live", (await dlg(page).locator('input[data-sw="itsc17d"]').count()) === 3 && !(await tower.isDisabled()));
  await tower.check();
  check("Its computers: ticking Tower is saved", !!(await until(async () => (await computersOf(trunk.id)).allowed.includes(TOWER))));
  await settle(page, 800);
  await dlg(page).locator(`[data-act="itsfirst17d"][data-v="${LAPTOP}"]`).click();
  check("A new conversation starts on: Laptop moves first", !!(await until(async () => (await computersOf(trunk.id)).allowed[0] === LAPTOP)));
  await settle(page, 800);
  await dlg(page).locator('[data-act="itsmax17d"][data-v="3"]').click();
  check("At once: 3 is saved", !!(await until(async () => (await computersOf(trunk.id)).atOnce === 3)));
  await settle(page, 800);
  check("At once: numbers above the allowed count are disabled", (await computersOf(trunk.id)).allowed.length === 3 && await dlg(page).locator('[data-act="itsmax17d"][data-v="4"]').isDisabled());
  check("§1 Give it its own cloud computer: greyed", await greyed(dlg(page).locator('[data-act="cloudnew17d"]')));
  await closeDlg(page);
}

async function conversationComputer(page, trunk) {
  const { sessionId } = await api("trunks/conversations", { trunkId: trunk.id });
  await act(page, "chat", { id: sessionId });
  await settle(page, 1200);
  await act(page, "stage", { v: "computer" });
  const chip = page.locator('#stage7 [data-act="comp-pick"]');
  await until(async () => (await chip.count()) > 0);
  check("the full-size view's computer chip is live", await live(chip));
  await chip.click();
  await settle(page, 400);
  const radios = page.locator('.pop [data-act="convcomp17d"]');
  check("This conversation uses: one choice per allowed computer", (await radios.count()) === 3);
  check("Up to N at once, of M allowed · Change", /Up to 3 at once/.test(await page.locator(".pop .comp-max17d").textContent()) && await live(page.locator('.pop .comp-max17d [data-act="edit"]')));
  await page.locator(`.pop [data-act="convcomp17d"][data-v="${TOWER}"]`).click();
  check("convcomp17d: the conversation's pick is Tower", !!(await until(async () => (await api(`devices/pick/${sessionId}`)).picked === TOWER)));
  await settle(page, 600);
  await chip.click();
  await settle(page, 400);
  await page.locator('.pop [data-act="comp-toggle"][data-v="this"]').click();
  check("comp-toggle: This computer comes off the Trunk's list", !!(await until(async () => !(await computersOf(trunk.id)).allowed.includes("this"))));
  const at = await computersOf(trunk.id);
  check("comp-toggle: At once drops with the shorter list", at.atOnce === 2, String(at.atOnce));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page, 300);
  return sessionId;
}

/* ---------- §2: calls and meetings, greyed ---------- */
async function calls(page) {
  check("no dialog opens by itself after a computer change", (await dlg(page).count()) === 0);
  await page.locator('[data-act="plusmenu"]').first().click();
  await settle(page, 300);
  check("+ menu: Phone call… is drawn and greyed", await greyed(page.locator('.pop [data-act="call17d"]')));
  check("+ menu: Join a meeting… is drawn and greyed", await greyed(page.locator('.pop [data-act="meet17d"]')));
  await page.keyboard.press("Escape");
  await settingsPage(page, "voice", "advanced");
  check("Voice › Calls and meetings: both switches greyed", (await page.locator('#main input[data-sw="cmsw17d"]:disabled').count()) === 2);
  check("Voice › Calling from: Set up greyed", await greyed(page.locator('#main [data-act="call17d"]')));
}

/* ---------- §4: decision models ---------- */
async function decisions(page) {
  await settingsPage(page, "models", "technical");
  const model = page.locator('#main [data-act="dmmodel17d"][data-v="default"]');
  check("Model for decisions: the engine's connections, live", await live(model));
  await model.click();
  check("dmmodel17d: the choice is saved", !!(await until(async () => (await api("decisions")).settings.model === "default")));
  await settle(page, 800);
  for (const title of ["Send each message to the right Trunk", "Sort the Inbox by urgency", "Filter long lists before a Trunk reads them"])
    check(`“${title}” stays greyed (the engine does not use it yet)`, await page.locator(`#main input[aria-label="${title}"]`).isDisabled());
  await page.locator('#main [data-act="dmkind17d"][data-v="yes"]').click();
  await settle(page, 300);
  await page.locator("#dm-q17d").fill("Is this email asking for a payment?");
  await page.locator('#main [data-act="dmrun17d"]').click();
  await until(async () => /Yes/.test(await page.locator("#dm-out17d .dm-r17d > b").textContent()));
  const shown = await page.locator("#dm-out17d").textContent();
  check("Decide: the engine's answer, how sure and the model", /Yes/.test(shown) && /93% sure/.test(shown) && /Default connection/.test(shown), shown.trim().slice(0, 80));
  check("Decide: the engine counted it", (await api("decisions")).lastDay.decisions >= 1);
  await page.locator('#main [data-act="dmkind17d"][data-v="pick"]').click();
  await page.locator("#dm-q17d").fill("Who answers about money?");
  await page.locator("#dm-o17d").fill("Books, Trips");
  await page.locator('#main [data-act="dmrun17d"]').click();
  check("Decide: pick one comes back as one of the choices", !!(await until(async () => (await page.locator("#dm-out17d .dm-r17d > b").textContent()) === "Books")));
  await page.locator("#dm-sure17d").fill("0.8");
  await page.locator("#dm-sure17d").press("Tab");
  check("Technical: the threshold is saved", !!(await until(async () => (await api("decisions")).settings.minConfidence === 0.8)));
  await page.locator("#dm-max17d").fill("50");
  await page.locator("#dm-max17d").press("Tab");
  check("Technical: the longest list is saved", !!(await until(async () => (await api("decisions")).settings.maxList === 50)));
}

/* ---------- §3: learn this app or workflow ---------- */
async function learn(page) {
  await page.keyboard.press("Escape");
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-v="tools"]').click();
  await page.locator('#main [data-act="t9-kind"][data-v="skills"]').click();
  await settle(page, 800);
  const first = page.locator("#main .t9-item").first();
  check("Skills: learn-this is first", /learn-this/.test(await first.textContent()));
  check("Where it runs the checks: a private computer is greyed", await greyed(page.locator('#main [data-act="wbwhere17d"]')));
  await page.locator("#wb-what17d").fill(`The orders page ${RUN}`);
  await page.locator('#main [data-act="wbstart17d"]').click();
  const book = await until(async () => (await api("workbooks")).workbooks.find((w) => w.name === `The orders page ${RUN}` && w.status === "ready"), 30000);
  check("Start learning: a real task saved the workbook", !!book, book ? `${book.must.length} MUSTs` : "");
  const title = await until(async () => (await dlg(page).locator("h2").textContent()) === `The orders page ${RUN}`);
  check("the workbook opens when it is ready", !!title);
  check("the ring says 1/3", (await dlg(page).locator(".wb-ring17d b").textContent()) === "1/3");
  await dlg(page).locator('[data-act="wbtab17d"][data-v="checks"]').click();
  check("The checks tab shows the checks", (await dlg(page).locator(".wb-checks17d > li").count()) === 3);
  const download = page.waitForEvent("download", { timeout: 10000 });
  await dlg(page).locator('[data-act="wbexport17d"]').click();
  const file = await download.catch(() => null);
  check("Save the workbook: a Markdown file", !!file && file.suggestedFilename() === `The orders page ${RUN}.md`, file?.suggestedFilename() ?? "");
  await dlg(page).locator('[data-act="wbskill17d"]').click();
  const made = await until(async () => (await api(`workbooks/${book.id}`)).workbook.skillId);
  const skill = made ? (await api("state")).skills.find((s) => s.id === made) : null;
  check("Make it a skill: made, and switched off for review", !!skill && skill.activeVersion === null, skill?.name ?? "");
  await settle(page, 600);
  await dlg(page).locator('[data-act="wbrerun17d"]').click();
  const again = await until(async () => { const w = (await api(`workbooks/${book.id}`)).workbook; return w.status === "ready" && w.changed === false ? w : null; }, 30000);
  check("Run the checks again: same result, read back", !!again);
  await closeDlg(page);
  await page.locator("#wb-on17d").uncheck();
  check("learn-this switch: off is saved", !!(await until(async () => (await api("workbooks")).mode === "off")));
  await settle(page, 600);
  await page.locator("#wb-on17d").check();
  check("learn-this switch: on again", !!(await until(async () => (await api("workbooks")).mode === "on")));
}

/* ---------- §8: chat apps ---------- */
async function chatApps(page) {
  const refused = await until(async () => (await api("channels")).channels.find((c) => c.kind === "telegram" && c.health?.state === "needs attention"), 20000);
  check("the engine reports Telegram's refused token", !!refused, refused?.health.reason ?? "");
  await settingsPage(page, "chatapps", "regular");
  const row = page.locator("#main .ca17d .prow").first();
  check("Settings › Chat apps: Telegram, Offline, with the engine's reason", /Telegram/.test(await row.textContent()) && /Offline/.test(await row.textContent()) && (await row.locator("small").textContent()) === refused.health.reason);
  check("Settings › Chat apps: Open and All chat apps are live", await live(row.locator('[data-act="ch-open"]')) && await live(page.locator('#main [data-act="ptab"][data-v="channels"]')));
  await settingsPage(page, "chatapps", "technical");
  for (const title of ["Edited messages", "Photo albums as one message", "Watch for a chat app that stops receiving", "Show online or offline in the app"])
    check(`“${title}” stays greyed`, await page.locator(`#main input[aria-label="${title}"]`).isDisabled());
  check("Formatting in each app stays greyed", await greyed(page.locator('#main [data-act="chfmt17d"]')));
  await page.keyboard.press("Escape");
  await page.locator('[data-act="view"][data-v="inbox"]').click();
  await settle(page, 1200);
  const prompt = page.locator("#main .rev17d");
  check("Inbox › Needs you: the revoked-token prompt", (await prompt.count()) === 1 && (await prompt.locator("small").textContent()) === refused.health.reason);
  check("Turn Telegram off stays greyed", await greyed(prompt.locator('[data-act="revoff17d"]')));
  await prompt.locator('[data-act="revfix17d"]').click();
  await until(async () => (await dlg(page).count()) > 0);
  check("Paste the new token opens its setup at Paste, saying why", /The old token stopped working/.test(await dlg(page).textContent()) && (await dlg(page).locator(".chw-steps12 .now").textContent()).includes("Paste"));
  await closeDlg(page);
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-v="channels"]').click();
  await settle(page, 1500);
  const tile = page.locator('#main [data-act="ch-open"][data-v="telegram"]');
  check("Customize › Channels: Offline · the bot token was revoked, red dot", /Offline · the bot token was revoked/.test(await tile.textContent()) && (await tile.locator(".dot12.off17d").count()) === 1);
  await tile.click();
  await until(async () => (await dlg(page).count()) > 0);
  check("the app's own page: Offline, and Paste a new token is live", /Offline/.test(await dlg(page).locator(".chx17d").textContent()) && await live(dlg(page).locator('[data-act="revfix17d"]')));
  check("the app's own page: the fine switches stay greyed", (await dlg(page).locator('.chx17d input[data-sw="chx17d"]:disabled').count()) === 3);
  await closeDlg(page);
}

/* ---------- the words, in French: every part D word goes through t() ---------- */
async function french(page) {
  const fr = require(join(ROOT, "public/locales/fr.json"));
  await page.evaluate(() => localStorage.setItem("branch-language", "fr"));
  await page.reload();
  await page.waitForSelector("#side .machine");
  await settle(page, 1500);
  const rawKey = async () => (await page.content()).match(/window\.p17d\.[a-z0-9-]+/)?.[0] ?? null;
  await settingsPage(page, "models", "technical");
  check("French: Decision models in French", (await page.locator("#main .dm17d h2").textContent()) === fr["window.p17d.decision-models"]);
  check("French: its Decide button in French", (await page.locator('#main [data-act="dmrun17d"]').textContent()) === fr["window.p17d.decide"]);
  await settingsPage(page, "chatapps", "technical");
  check("French: Settings › Chat apps in French", (await page.locator("#main .lede").first().textContent()) === fr["window.p17d.chat-apps-lede"]);
  await settingsPage(page, "voice", "advanced");
  check("French: Calls and meetings in French", (await page.locator("#main h2", { hasText: fr["window.p17d.calls-meetings"] }).count()) === 1);
  check("French: no raw key on screen", (await rawKey()) === null, (await rawKey()) ?? "");
  await page.keyboard.press("Escape");
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-v="tools"]').click();
  await page.locator('#main [data-act="t9-kind"][data-v="skills"]').click();
  await settle(page, 800);
  check("French: learn-this in French", (await page.locator("#main .wb17d h2").first().textContent()) === fr["window.p17d.how-it-works"]);
  check("French: no raw key in Customize", (await rawKey()) === null, (await rawKey()) ?? "");
  await page.evaluate(() => localStorage.setItem("branch-language", "en"));
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "branch-p17d-verify-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace"), integrations = join(root, "integrations.json");
  require("node:fs").mkdirSync(workspace, { recursive: true });
  // This throwaway engine may reach the stand-in on this computer; nothing else is allowed.
  writeFileSync(integrations, JSON.stringify({ web: { allowPrivateAddresses: true, allowedHosts: ["127.0.0.1"] },
    channels: [{ type: "telegram", tokenEnv: "TG_STAND_IN", apiBase: `http://127.0.0.1:${STUB_PORT}/tg` }] }));
  await new Promise((ok) => stub.listen(STUB_PORT, "127.0.0.1", ok));
  await seed(dataDir, workspace);
  const engine = await startEngine(dataDir, workspace, integrations);
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    await api("onboarding", { done: true });
    await api("trunks/switch", { part: "trunks", mode: "on" });
    await api("trunks/switch", { part: "conversations", mode: "on" });
    const trunk = (await api("trunks", { name: `Mapper ${RUN}` })).trunk;
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    page.on("pageerror", (e) => errors.push(e.message));
    // A console error that is only a refused request is judged by the request below; anything else counts.
    page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
    // Every refused request after signing in counts, except the one refusal this script asks for on purpose (At once 4).
    let signedIn = false;
    page.on("response", (r) => {
      if (!signedIn || r.status() < 400) return;
      if (r.status() === 400 && r.request().method() === "POST" && r.url().endsWith("/computers")) return;
      errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector("#side .machine");
    await settle(page, 1500);
    signedIn = true;
    await settingsComputer(page, trunk);
    await itsComputers(page, trunk);
    await conversationComputer(page, trunk);
    await calls(page);
    await decisions(page);
    await learn(page);
    await chatApps(page);
    await french(page);
    check("no page errors, console errors or refused requests", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    engine.kill();
    stub.close();
    await new Promise((r) => setTimeout(r, 800));
    try { rmSync(root, { recursive: true, force: true }); } catch { /* a file the engine still held is left for the temp cleaner */ }
  }
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
