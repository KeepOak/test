// Clicks every control the conversation-media area made live, against a running engine, and checks through the engine's
// own routes that each did the real thing. Run: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-conv-media.cjs
// Setup it does through the engine first, and puts back at the end: the command list and the autonomy part for /bg
// switched on, approvals set to "Ask before changes" (so a background task waits and can be stopped), Trunks switched on.
// It adds one Trunk when there is none, and two conversations (one carrying a two-second sound file).
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT || "3322";
const TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
if (!TOKEN) { console.error("TOKEN is required"); process.exit(2); }

async function api(path, body) {
  const r = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error ?? ""}`);
  return data;
}
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); }
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await wait(300); } }

function wav() {
  const rate = 8000, n = rate * 2, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(3000 * Math.sin(i / 8) * (i / n)), 44 + i * 2);
  return buf.toString("base64");
}

async function setup() {
  const before = { commands: (await api("commands/settings")).mode, autonomy: (await api("autonomy")).modes["session-commands"],
    policy: (await api("policy")).policy, trunks: (await api("trunks")).modes.trunks };
  await api("commands/settings", { mode: "on" });
  await api("autonomy/switch", { part: "session-commands", mode: "on" });
  const ask = (await api("policy")).presets.find((p) => p.id === "ask-before-changes");
  await api("policy", { ...before.policy, preset: ask.id, rules: ask.rules });
  await api("trunks/switch", { part: "trunks", mode: "on" });
  if (!(await api("trunks")).trunks.length) await api("trunks", { name: "Verify" });
  const sound = await api("run", { prompt: "verify: the memo", attachments: [{ mediaType: "audio/wav", name: "memo.wav", data: wav() }] });
  const other = await api("run", { prompt: "verify: a second conversation" });
  return { before, soundSid: sound.sessionId, otherSid: other.sessionId };
}
async function restore(before) {
  await api("commands/settings", { mode: before.commands });
  await api("autonomy/switch", { part: "session-commands", mode: before.autonomy });
  await api("policy", before.policy);
  await api("trunks/switch", { part: "trunks", mode: before.trunks });
}

const live = (page, act) => page.locator(`[data-act="${act}"]:not([aria-disabled="true"])`).first();
const messagesOf = async (sid) => (await api(`sessions/${sid}`)).messages ?? [];
const sessionWith = async (words) => {
  for (const s of (await api("sessions?limit=50")).sessions) if ((await messagesOf(s.sessionId)).some((m) => m.role === "user" && m.content === words)) return s.sessionId;
  return null;
};
async function idle(page) { await page.waitForFunction(() => !document.querySelector("#send")?.disabled, null, { timeout: 30000 }); }

async function pictureAndFile(page) {
  await live(page, "plusmenu").click();
  await live(page, "imagine").click();
  await page.fill("#img-q", "a lighthouse at dusk");
  await live(page, "img-go").click();
  const sid = await until(() => sessionWith("Make a picture: a lighthouse at dusk"));
  check("imagine + img-go: POST /api/run recorded the message", sid, sid ?? "no conversation holds it");
  await idle(page);
  await live(page, "plusmenu").click();
  await live(page, "office15").click();
  await page.locator('[data-act="offk15"][data-v="xlsx"]').click();
  const picked = await page.locator('[data-act="offk15"][data-v="xlsx"]').getAttribute("aria-checked");
  check("offk15: the kind is chosen in the dialog", picked === "true");
  await page.fill("#off-in15", "the verify table");
  await live(page, "offgo15").click();
  const words = "Spreadsheet (Excel · .xlsx): the verify table";
  const got = await until(async () => sid && (await messagesOf(sid)).some((m) => m.role === "user" && m.content === words));
  check("office15 + offgo15: POST /api/run recorded the request", got, words);
  await idle(page);
}

async function background(page) {
  await page.waitForTimeout(3500); // the command list is read on the first background check
  await page.fill("#prompt", "sort the verify notes");
  await live(page, "plusmenu").click();
  await live(page, "bgrun15").click();
  const started = await until(async () => (await api("activity?waiting=1")).find((a) => a.prompt === "sort the verify notes"));
  check("bgrun15: /bg started a task (GET /api/activity)", started, started?.runId);
  const chip = await until(async () => (await page.locator(".bgchip15").count()) > 0);
  check("bglist15: the chip shows what runs in the background", chip);
  await live(page, "bglist15").click();
  await page.locator(`[data-act="bgstop15"][data-id="${started?.runId}"]`).click();
  const run = started && await until(async () => { const r = await api(`runs/${started.runId}`); return ["cancelled"].includes(r.status ?? r.run?.status) && r; });
  check("bgstop15: POST /api/runs/{id}/cancel stopped it (GET /api/runs/{id})", run, run ? "cancelled" : "still going");
  // A second one, stopped outside the window, shows as finished and opens its conversation.
  await page.fill("#prompt", "tidy the verify list");
  await live(page, "plusmenu").click();
  await live(page, "bgrun15").click();
  const second = await until(async () => (await api("activity?waiting=1")).find((a) => a.prompt === "tidy the verify list"));
  await page.waitForTimeout(3500);
  if (second) await api(`runs/${second.runId}/cancel`, {});
  await page.waitForTimeout(3500);
  await live(page, "bglist15").click();
  const openBtn = page.locator(`[data-act="bgopen15"][data-id="${second?.runId}"]`);
  const done = await until(async () => (await openBtn.count()) > 0 && (await page.locator(".pop").textContent()).includes("Finished · ready to read"), 12000);
  check("bglist15: a task that ended shows as finished, with Open", done);
  const opened = page.waitForResponse((r) => second && r.url().includes(`/api/sessions/${second.sessionId}`) && r.status() === 200);
  await openBtn.click();
  check("bgopen15: GET /api/sessions/{id} opened its conversation", await opened.then(() => true, () => false));
}

async function material(page) {
  await page.fill("#prompt", "look at @notes/plan.md first");
  const chip = await until(async () => (await page.locator(".mat15").count()) > 0);
  check("matrm15: the @ reference shows as a chip", chip);
  await live(page, "matrm15").click();
  const draft = await page.inputValue("#prompt");
  check("matrm15: x takes it out of the draft", !draft.includes("@notes/plan.md"), JSON.stringify(draft));
  await page.fill("#prompt", "");
}

async function sound(page, sid) {
  const file = page.waitForResponse((r) => r.url().includes("/api/attachments/file") && r.url().includes(sid) && r.status() === 200);
  await page.locator(`[data-act="chat"][data-id="${sid}"]`).first().click();
  check("mplay15: the sound comes from GET /api/attachments/file", await file.then(() => true, () => false));
  const timed = await until(async () => (await page.locator(".m-time15").first().textContent())?.trim() === "0:00 / 0:02");
  check("mplay15: its length is the file's own", timed);
  await live(page, "mplay15").click();
  const playing = await until(async () => (await page.locator('[data-act="mplay15"]').first().getAttribute("aria-label"))?.startsWith("Pause"));
  check("mplay15: it plays", playing);
  await live(page, "mplay15").click();
  const wave = page.locator('[data-act="mseek15"]').first();
  const box = await wave.boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  const moved = await until(async () => (await page.locator(".m-time15").first().textContent())?.trim() === "0:01 / 0:02");
  check("mseek15: clicking the waveform moves the position", moved);
}

async function besideAndRoster(page, otherSid) {
  await live(page, "chatmenu").click();
  await live(page, "beside15").click();
  await page.locator(`[data-act="beside15"][data-v="${otherSid}"]`).click();
  const first = (await messagesOf(otherSid)).find((m) => m.role === "user")?.content;
  const shown = await until(async () => (await page.locator(".beside15 .thread").textContent())?.includes(first));
  check("beside15: the other conversation (GET /api/sessions/{id}) opens beside", shown, first);
  await page.locator('.beside15 [data-act="beside15"][data-v=""]').click();
  check("beside15: x closes it", await until(async () => (await page.locator(".beside15").count()) === 0));
  const names = (await api("trunks")).trunks.filter((t) => !t.hidden).map((t) => t.name);
  await live(page, "roster10h").click();
  const listed = await until(async () => { const t = await page.locator(".pop").textContent(); return names.every((n) => t.includes(n)) && t; });
  check("roster10h: the popover lists the Trunks (GET /api/trunks)", listed, names.join(", "));
  const away = await api("reach/trunks/remote", {}).then((r) => r.computers.flatMap((c) => c.trunks.map((t) => t.name)), (e) => [e.message.replace(/^[^:]+: \d+ /, "")]);
  const text = await page.locator(".pop").textContent();
  check("roster10h: other computers come from POST /api/reach/trunks/remote", away.every((w) => text.includes(w)), away.join(", "));
  await page.keyboard.press("Escape");
  await live(page, "chatmenu").click();
  await live(page, "roster10").click();
  const again = await until(async () => { const t = await page.locator(".pop").textContent(); return t.includes("knows and may talk to") && names.every((n) => t.includes(n)); });
  check("roster10: the chat menu opens the same roster", again);
  await page.keyboard.press("Escape");
}

(async () => {
  const { before, soundSid, otherSid } = await setup();
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (process.env.DEBUG) page.on("response", (r) => { if (r.request().method() === "POST") console.log("  POST", r.url().replace(BASE, ""), r.status()); });
  try {
    await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector("#prompt");
    await pictureAndFile(page);
    await background(page);
    await material(page);
    await sound(page, soundSid);
    await besideAndRoster(page, otherSid);
  } catch (error) {
    check("run finished", false, error.message);
  } finally {
    await browser.close();
    await restore(before);
  }
  check("zero page errors", errors.length === 0, errors.join(" | "));
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
