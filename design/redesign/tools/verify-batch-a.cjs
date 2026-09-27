/* Batch A of the tip audit (briefs/status/audit-tip.md): the conversation and the composer, each driven with the real
   mouse and keyboard in the real window (headless, never a visible window) and read back through the engine's own GET
   routes. It starts its OWN throwaway engine on PORT (a fresh data folder, seeded before it starts with one conversation
   whose task used the computer and was cut off), answered by a scripted stand-in model it serves itself on MODEL_PORT
   (default: a free port the system picks), then stops both:
     npm run build && PORT=<free port> node design/redesign/tools/verify-batch-a.cjs
   Screenshots go to SHOTS. Page errors must be zero. */
const { chromium } = require("playwright");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.PORT || 3424);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH || (existsSync("C:/Users/bishi/AppData/Local/Temp/claude-session-files/lead") ? "C:/Users/bishi/AppData/Local/Temp/claude-session-files/lead/batch-a" : os.tmpdir());
const SHOTS = process.env.SHOTS || join(SCRATCH, "shots");
mkdirSync(SHOTS, { recursive: true });
const ROOT = resolve(__dirname, "../../..");

/* ---------- the stand-in model: "SCRIPT:slow" spends eight seconds on a first step that only looks for a tool, then
   answers; anything else answers at once ---------- */
function decide(body) {
  const asked = [...body.messages].reverse().find((m) => m.role === "user");
  const words = String(asked?.content ?? "");
  const toolTurns = body.messages.slice(body.messages.lastIndexOf(asked)).filter((m) => m.role === "tool").length;
  const search = (body.tools ?? []).find((t) => /^Find a tool by saying/.test(t.function.description));
  if (/SCRIPT:slow/.test(words) && toolTurns === 0 && search) return { tool: search.function.name, args: { query: "list files" }, wait: 8000 };
  return { text: `OK: ${words.slice(0, 60)}` };
}
function standIn() {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        if (!req.url.includes("chat/completions")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "standin" }] })); return; }
        const body = JSON.parse(raw || "{}"), d = decide(body);
        if (d.wait) await new Promise((r) => setTimeout(r, d.wait));
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        const call = d.tool ? { id: `c${Date.now()}`, type: "function", function: { name: d.tool, arguments: JSON.stringify(d.args) } } : null;
        const finish = call ? "tool_calls" : "stop";
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const delta = call ? { role: "assistant", tool_calls: [{ index: 0, ...call }] } : { role: "assistant", content: d.text };
          res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        const message = call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: d.text };
        res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: body.model, usage, choices: [{ index: 0, message, finish_reason: finish }] }));
      });
    });
    server.listen(Number(process.env.MODEL_PORT || 0), "127.0.0.1", () => done(server));
  });
}

/* ---------- the seed, written before the engine starts: a conversation whose task used the computer, paused ---------- */
const SEED = `
import { crc32, deflateSync } from "node:zlib";
import { createBranch } from "./dist/index.js";
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([len, Buffer.from(type), data, crc]); };
const head = Buffer.alloc(13); head.writeUInt32BE(48, 0); head.writeUInt32BE(30, 4); head[8] = 8;
const rows = Buffer.alloc(49 * 30, 0x80); for (let y = 0; y < 30; y++) rows[y * 49] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
const app = await createBranch({ workspace: process.env.BRANCH_WORKSPACE, dataDir: process.env.BRANCH_DATA_DIR, provider: quiet });
const run = app.store.createRun(app.runtime.owner, "Check the spreadsheet on screen");
app.store.message(run.sessionId, { role: "user", content: run.prompt });
app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "desktop.screenshot", arguments: "{}" }] });
const picture = await app.runtime.artifacts.write(run.id, "desk.png", "image/png", png);
app.store.message(run.sessionId, { role: "tool", toolCallId: "c1", content: JSON.stringify({ ok: true, result: { ...picture, window: "", width: 48, height: 30 } }) });
// Paused by the owner, as runtime.ts records a pause: a restart leaves it for their Resume (never-break/resume.ts).
app.store.event(run.id, "run.paused", { message: "Paused after this step. Nothing is lost." });
app.store.finish(run.id, "interrupted", "Paused after this step. Nothing is lost.");
await app.close();
console.log(JSON.stringify({ sessionId: run.sessionId, runId: run.id }));
`;

/* ---------- the engine ---------- */
let TOKEN = "";
function startEngine(dir, modelPort) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["dist/cli.js", "start"], { cwd: ROOT, env: { ...process.env, BRANCH_DATA_DIR: join(dir, "data"), BRANCH_WORKSPACE: join(dir, "ws"), BRANCH_PORT: String(PORT),
      BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: `http://127.0.0.1:${modelPort}/v1`, BRANCH_MODEL: "standin", BRANCH_API_KEY: "sk-standin", BRANCH_OLLAMA_URL: "http://127.0.0.1:9" } });
    let out = "";
    const timer = setTimeout(() => fail(new Error(`the engine did not start: ${out.slice(-400)}`)), 60000);
    const read = (chunk) => { out += chunk; const m = /paste into browser\): ([0-9a-f]{64})/.exec(out); if (m && !TOKEN) { TOKEN = m[1]; clearTimeout(timer); done(child); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
  });
}
async function api(path, body, headers = {}) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const error = new Error(`${path}: ${res.status} ${data.error ?? ""}`); error.status = res.status; throw error; }
  return data;
}

/* ---------- helpers ---------- */
const results = [];
const remote = []; // every request the window made for other computers' Trunks
const check = (name, ok, how = "") => { results.push([name, ok ? "PASS" : "FAIL", how]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${how ? `  (${how})` : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await wait(200); } }
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const greyed = async (loc) => (await loc.getAttribute("aria-disabled")) === "true" || (await loc.isDisabled());
const tipOf = (loc) => loc.getAttribute("data-tip");
async function openChat(page, id) { await page.locator(`#side [data-act="chat"][data-id="${id}"]`).first().click(); await page.locator("#prompt").waitFor(); await wait(400); }
async function fresh(page) { await page.reload(); await page.locator("#app #side").waitFor({ state: "visible" }); await wait(600); }

async function main() {
  const dir = mkdtempSync(join(SCRATCH, "verify-"));
  const env = { ...process.env, BRANCH_DATA_DIR: join(dir, "data"), BRANCH_WORKSPACE: join(dir, "ws") };
  const seeded = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", SEED], { cwd: ROOT, env, encoding: "utf8" }).trim().split("\n").at(-1));
  const model = await standIn();
  const engine = await startEngine(dir, model.address().port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.url().includes("/api/reach/trunks/remote")) remote.push(r.url()); });
  try {
    await api("onboarding", { done: true });
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
    await commands(page);
    await remoteTrunks(page);
    await reasons(page);
    await welcomes(page);
    await tint(page);
    await computerCard(page, seeded);
    await pause(page);
    await pinPlain(page);
    await settingsSwitch(page);
  } catch (error) {
    check("run to the end", false, error.stack?.split("\n").slice(0, 3).join(" | "));
    await shot(page, "zz-failed").catch(() => undefined);
  } finally {
    check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await browser.close();
    engine.kill();
    model.close();
    await wait(800);
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (error) { console.log(`left ${dir}: ${error.code}`); }
  }
  const failed = results.filter((r) => r[1] === "FAIL").length;
  console.log(`\n${results.filter((r) => r[1] === "PASS").length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/* The shared commands ship on in this window: "/" lists them, + › Run it in the background starts a task of its own. */
async function commands(page) {
  const list = await api("commands?surface=window");
  check("commands: this window's list is on and offers /bg", list.mode === "on" && list.commands.some((c) => c.name === "bg" && c.listed), `GET /api/commands?surface=window mode ${list.mode}`);
  const door = await api("commands?surface=window", undefined, { "x-branch-tunnel": "1" }).catch((error) => ({ refused: error.status }));
  check("commands: the window's key from beyond this computer keeps them off", door.refused || (door.mode === "off" && !door.commands.some((c) => c.name === "bg")), JSON.stringify(door.refused ? { status: door.refused } : { mode: door.mode }));
  const phone = await api("commands?surface=phone");
  check("commands: the phone keeps them off", phone.mode === "off" && !phone.commands.some((c) => c.name === "bg"), `mode ${phone.mode}`);
  await page.locator("#prompt").fill("/");
  await page.locator("#prompt").dispatchEvent("input");
  const menu = page.locator(".slash6");
  await menu.waitFor({ timeout: 10000 });
  const names = await menu.locator("[role=option] b").allTextContents();
  check("commands: / lists the shared commands", ["/bg", "/usage", "/new"].every((n) => names.includes(n)), names.slice(0, 12).join(" "));
  await page.keyboard.press("Escape");
  await page.locator("#prompt").fill("");
  // Nothing switched on first: /bg's own part ("session-commands") ships on since #467.
  await page.locator("#prompt").fill("SCRIPT:quick tidy the notes");
  const offered = await until(async () => {
    await page.locator('[data-act="plusmenu"]').first().click();
    if (await page.locator('.pop [data-act="bgrun15"]').count()) return true;
    await page.keyboard.press("Escape");
    await wait(600);
    return false;
  }, 15000);
  check("commands: + › Run it in the background is live", offered && !(await greyed(page.locator('.pop [data-act="bgrun15"]'))));
  await shot(page, "a1-plus-menu");
  await page.locator('.pop [data-act="bgrun15"]').click();
  const bg = await until(async () => (await api("state")).runs.find((r) => r.prompt.includes("quick tidy the notes")));
  check("commands: it started the task in a conversation of its own", !!bg, bg ? `GET /api/state run ${bg.id.slice(0, 8)} ${bg.status}` : "no run");
}

/* E2: while "Trunks on other computers" is off, the @ list and the roster never ask for them; on, the roster does. */
async function remoteTrunks(page) {
  await api("trunks/switch", { part: "trunks", mode: "on" });
  await api("trunks", { name: "Wren", title: "Checks" });
  await fresh(page);
  const modes = (await api("reach")).modes;
  await page.locator("#prompt").fill("@");
  await page.locator("#prompt").dispatchEvent("input");
  await page.locator('.pop [data-act="mention-pick"]').first().waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#prompt").fill("");
  await page.locator('[data-act="roster10h"]').first().click();
  await page.locator(".pop .ph").first().waitFor();
  await wait(500);
  check("E2: nothing asked for other computers' Trunks while that part is off", modes["remote-trunks"] === "off" && remote.length === 0, `GET /api/reach remote-trunks ${modes["remote-trunks"]}; ${remote.length} requests`);
  await shot(page, "a2-roster");
  await page.keyboard.press("Escape");
  await api("reach/switch", { part: "remote-trunks", mode: "on" });
  await fresh(page);
  await page.locator('[data-act="roster10h"]').first().click();
  check("E2: switched on, the roster asks", !!(await until(async () => remote.length > 0, 8000)), `${remote.length} request(s)`);
  await page.keyboard.press("Escape");
  await api("reach/switch", { part: "remote-trunks", mode: "off" });
}

/* The greyed controls of the conversation say exactly why. */
async function reasons(page) {
  await page.locator('[data-act="plusmenu"]').first().click();
  check("why: Take a screenshot", /can't take a picture of your screen/.test(await tipOf(page.locator('.pop [data-act="shot"]'))));
  await page.keyboard.press("Escape");
  await page.locator('[data-act="roster10h"]').first().click();
  const knows = page.locator('.pop input[data-sw="knows"]').first();
  await knows.waitFor();
  check("why: who may talk to whom", /keeps no list per Trunk/.test(await tipOf(knows)));
  check("why: the hops limit", /three hops/.test(await tipOf(page.locator('.pop [data-why="hops"]'))));
  await page.keyboard.press("Escape");
}

/* The empty welcomes draw no mascot. */
async function welcomes(page) {
  await page.locator('#side [data-act="view"][data-v="team"]').first().click();
  await page.locator('#main .place [data-act="ptab"][data-v="live"]').first().click();
  const empty = page.locator("#main .empty18c").first();
  await empty.waitFor();
  check("mascot: Team › Live now's welcome is a sentence and a button, no picture", (await empty.locator("img, video").count()) === 0 && (await empty.locator("button").count()) === 1, await empty.locator("p").innerText());
  await shot(page, "a3-empty-welcome");
}

/* shell-013: a Trunk's header carries its colour. */
async function tint(page) {
  const trunk = (await api("trunks")).trunks.find((x) => x.name === "Wren");
  await api(`trunks/${trunk.id}`, { chosenColour: "#1f5139" });
  const saved = (await api("trunks")).trunks.find((x) => x.id === trunk.id).chosenColour;
  await fresh(page);
  await openChat(page, trunk.chatSessionId);
  const tints = await until(() => page.evaluate(() => { const h = document.querySelector(".head")?.style.getPropertyValue("--tint"); return h ? [h, document.querySelector(".titlebar").style.getPropertyValue("--tint14")] : null; }));
  check("tint: the header and the title row carry the Trunk's colour", tints?.[0] === `${saved}66` && tints?.[1] === `${saved}66`, `GET /api/trunks chosenColour ${saved}; ${JSON.stringify(tints)}`);
  await shot(page, "a4-tint");
}

/* pane-stage-011: the computer card; Carry on resumes the paused task. */
async function computerCard(page, seeded) {
  await fresh(page);
  await openChat(page, seeded.sessionId);
  const card = page.locator("#main .card.comp7").first();
  await card.waitFor({ timeout: 10000 });
  const pill = await card.locator(".pill").innerText();
  const pic = await until(async () => (await card.locator(".comp7-thumb img.shot7").count()) > 0, 8000);
  check("computer card: Stopped, with the task's picture", /Stopped/.test(pill) && !!pic, `pill "${pill}"`);
  await shot(page, "a5-computer-card");
  await card.locator('[data-act="lw-resume"]').click();
  const resumed = await until(async () => (await api("state")).runs.find((r) => r.sessionId === seeded.sessionId && r.id !== seeded.runId && r.status === "completed"));
  check("computer card: Carry on resumed it (POST /api/runs/<id>/resume)", !!resumed, resumed ? `GET /api/state: run ${resumed.id.slice(0, 8)} completed` : "no resumed run");
  const done = await until(async () => /Done/.test(await card.locator(".pill").innerText()), 10000);
  check("computer card: then Done, with no Carry on", !!done && (await card.locator('[data-act="lw-resume"]').count()) === 0);
}

/* pane-stage-006: the full-size view's Pause pauses the working task. */
async function pause(page) {
  await page.keyboard.press("Control+n"); // a new conversation
  await wait(600);
  await page.locator("#prompt").fill("SCRIPT:slow work on the report");
  await page.keyboard.press("Enter");
  const run = await until(async () => (await api("state")).runs.find((r) => r.prompt.includes("slow work on the report") && r.status === "running"));
  if (!run) { check("pause: a working task", false); return; }
  await openChat(page, run.sessionId);
  await page.locator('[data-act="stage"][data-v="computer"]').first().click();
  const button = page.locator('#stage7 [data-act="lw-pause"]');
  await until(async () => (await button.count()) > 0, 10000);
  if (!(await button.count())) await shot(page, "a6-stage-no-pause");
  check("pause: the full-size view's Pause is live", (await button.count()) > 0 && !(await greyed(button)));
  await shot(page, "a6-stage-pause");
  await button.click();
  const asked = await until(async () => (await api(`runs/${run.id}`)).events.some((e) => e.kind === "run.pause_asked"), 8000);
  const after = await until(async () => { const got = (await api(`runs/${run.id}`)).run.status; return got !== "running" ? got : null; }, 30000); // after the step it is on
  check("pause: the engine paused it", !!asked && after === "interrupted", `GET /api/runs/<id>: run.pause_asked, then ${after}`);
  await page.keyboard.press("Escape");
}

/* chat-029: an ordinary conversation is pinned from its own menu. */
async function pinPlain(page) {
  const plain = (await api("sessions")).sessions.find((s) => /slow work on the report/.test(s.opening ?? s.title ?? ""));
  if (!plain) { check("pin: an ordinary conversation", false); return; }
  await fresh(page);
  await openChat(page, plain.sessionId);
  await page.locator('[data-act="chatmenu"]').first().click();
  const pin = page.locator('.pop [data-act="pin-id"]');
  check("pin: Pin to top is live in the conversation menu", (await pin.count()) === 1 && !(await greyed(pin)));
  await pin.click();
  const pinned = await until(async () => (await api("sessions")).sessions.find((s) => s.sessionId === plain.sessionId)?.pinned);
  check("pin: the engine keeps it pinned", pinned === true, "GET /api/sessions pinned");
}

/* Settings › General's shared commands switch is this window's: on as it ships, off and on for this window alone. */
async function settingsSwitch(page) {
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="general"]').first().click();
  const sw = page.locator("#g-cmds");
  await sw.waitFor();
  check("settings: the shared commands switch shows this window's on", await sw.isChecked(), (await sw.locator("xpath=..").locator("small").innerText()).slice(0, 90));
  await sw.click();
  const off = await until(async () => (await api("commands?surface=window")).mode === "off", 8000);
  await sw.click();
  const on = await until(async () => (await api("commands?surface=window")).mode === "on", 8000);
  const phone = (await api("commands?surface=phone")).mode;
  check("settings: off and on again change this window only; the phone stays off", !!off && !!on && phone === "off", `window off, then on; phone ${phone}`);
  await shot(page, "a7-settings-commands");
}

main();
