// Verifies the conversation's message actions against a running engine: every control chat/messages.js marks live is
// clicked in the real window, and the change is confirmed through the engine's own GET route.
// Run: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-conv-messages.cjs
// Use a throwaway engine (fresh BRANCH_DATA_DIR, the offline demo provider): it creates a Trunk and a project, sets a
// price for the demo model, turns on the waiting line and briefly sets a tool-call limit, then puts the limit back.
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("PORT and TOKEN are required"); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body, method) {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error || ""}`);
  return data;
}
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await pause(250); }
}

// What the script changes is read first and put back at the end (pricing replaces the whole corrections object).
async function saveSettings() {
  return {
    pricing: (await api("pricing")).overrides ?? {},
    trunks: (await api("trunks")).modes?.trunks ?? "off",
    waiting: (await api("flows-boards")).modes?.["waiting-line"] ?? "off",
    project: (await api("projects")).active.id,
  };
}
async function restoreSettings(saved, ctx) {
  await api("projects/active", { active: saved.project }).catch((e) => console.log("restore project:", e.message));
  if (ctx) {
    await api(`projects/${ctx.project.id}/remove`, {}).catch((e) => console.log("remove project:", e.message));
    await api(`trunks/${ctx.trunk.id}/remove`, {}).catch((e) => console.log("remove Trunk:", e.message));
  }
  await api("pricing", { overrides: saved.pricing }).catch((e) => console.log("restore pricing:", e.message));
  await api("trunks/switch", { part: "trunks", mode: saved.trunks }).catch((e) => console.log("restore Trunks switch:", e.message));
  await api("flows-boards/switch", { part: "waiting-line", mode: saved.waiting }).catch((e) => console.log("restore waiting line:", e.message));
}

async function setup(saved) {
  const stamp = Date.now().toString(36);
  await api("trunks/switch", { part: "trunks", mode: "on" });
  const trunk = (await api("trunks", { name: `Verify ${stamp}`, title: "Checks the message actions" })).trunk;
  const project = await api("projects", { id: `verify-${stamp}`, name: `Verify ${stamp}` });
  await api("pricing", { overrides: { ...saved.pricing, demo: { input: 1, output: 1 } } });
  const first = await api("run", { prompt: `first message ${stamp}` });
  await api("run", { sessionId: first.sessionId, prompt: `second message ${stamp}` });
  return { sid: first.sessionId, trunk, project, stamp };
}

async function signIn(page) {
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .row, #side [data-act='chat']", { timeout: 15000 });
}
const rowOf = (page, id) => page.locator(`#conversation [data-i15="${id}"]`);
async function hoverClick(page, row, act) {
  await row.hover();
  await row.locator(`.msg-acts [data-act="${act}"]`).click();
}

async function verifyPins(page, ctx, msgs) {
  const firstUser = msgs.find((m) => m.role === "user"), lastBot = [...msgs].reverse().find((m) => m.role === "assistant" && !m.toolCalls?.length);
  await hoverClick(page, rowOf(page, firstUser.messageId), "pin15");
  let pins = await until(async () => { const p = (await api(`sessions/${ctx.sid}/pins`)).pins; return p.length === 1 && p; });
  check("pin15 pins a message", pins && pins[0].sourceId === firstUser.messageId, `GET pins -> ${JSON.stringify(pins && pins.map((p) => p.sourceId))}`);
  await hoverClick(page, rowOf(page, lastBot.messageId), "pin15");
  pins = await until(async () => { const p = (await api(`sessions/${ctx.sid}/pins`)).pins; return p.length === 2 && p; });
  check("pin15 pins a reply", !!pins, `GET pins count ${pins && pins.length}`);
  await page.locator(".pins15 [data-act='pinlist15']").click();
  const listed = await page.locator(".pop .pinrow15").count();
  check("pinlist15 lists every pin", listed === 2, `${listed} rows`);
  await page.locator(".pop .pinrow15 [data-act='pinjump15']").first().click();
  const flashed = await until(() => page.locator(`#conversation [data-i15="${firstUser.messageId}"].flash15`).count());
  check("pinjump15 scrolls to the pinned message", flashed === 1);
  await page.locator(".pins15 [data-act='pinlist15']").click();
  await page.locator(".pop .pinrow15 [data-act='pin15']").first().click();
  pins = await until(async () => { const p = (await api(`sessions/${ctx.sid}/pins`)).pins; return p.length === 1 && p; });
  check("pin15 unpins from the list", pins && pins[0].sourceId === lastBot.messageId, "GET pins count 1");
}

async function verifyInspect(page, ctx, msgs) {
  const lastBot = [...msgs].reverse().find((m) => m.role === "assistant" && !m.toolCalls?.length);
  await hoverClick(page, rowOf(page, lastBot.messageId), "inspect");
  const dlg = page.locator(".dlg[aria-label='Look inside']");
  await dlg.waitFor();
  const runs = (await api("state")).runs.filter((r) => r.sessionId === ctx.sid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rec = await api(`runs/${runs[0].id}/inspect`);
  const text = await dlg.innerText();
  check("inspect shows the task's record", text.includes(rec.rounds.at(-1).model) && text.includes(rec.cost.display), `model ${rec.rounds.at(-1).model}, cost ${rec.cost.display}`);
  await dlg.locator("[data-act='dlg-close']").click();
  await page.locator("[data-act='chatmenu']").first().click();
  await page.locator(".pop [data-act='inspect']").click();
  await dlg.waitFor();
  check("inspect from the conversation menu opens the last task's record", (await dlg.innerText()).includes(rec.rounds.at(-1).model));
  await dlg.locator("[data-act='dlg-close']").click();
}

const idleIn = (sid) => async () => !(await api("state")).runs.some((r) => r.sessionId === sid && ["running", "queued"].includes(r.status));

// The default choice puts back the conversation and the files; when the files cannot all come back the toast must be
// the engine's own note, word for word, never "Went back, files included."
async function verifyEditBoth(page, ctx) {
  const before = (await api(`sessions/${ctx.sid}`)).messages;
  const lastUser = [...before].reverse().find((m) => m.role === "user");
  await hoverClick(page, rowOf(page, lastUser.messageId), "u-edit");
  await page.locator("#rw-text").fill(`edited both ${ctx.stamp}`);
  const answered = page.waitForResponse((r) => r.url().endsWith("/rewind") && r.request().method() === "POST");
  await page.locator("[data-act='rw-go']").click();
  const outcome = await (await answered).json();
  const expected = outcome.files && (outcome.files.method === "none" || outcome.files.note) ? outcome.files.note : "Went back, files included.";
  // The toast with Undo appears once the conversation has been re-read after the rewind.
  const withUndo = page.locator(".toast:has([data-act='undo']) span");
  await withUndo.waitFor({ timeout: 10000 });
  const toastText = (await withUndo.innerText()).trim();
  check("rw-go with the default choice tells the engine's outcome", outcome.restore === "both" && toastText === expected, `files ${JSON.stringify(outcome.files)}; toast "${toastText}"`);
  await until(async () => (await api(`sessions/${ctx.sid}`)).messages.some((x) => x.content === `edited both ${ctx.stamp}`) && (await idleIn(ctx.sid)()), 15000);
  await page.locator(".toast [data-act='undo']").click();
  const undone = await until(async () => (await api(`sessions/${ctx.sid}/rewind`)).undo === null, 10000);
  check("undo after the default choice (unrevert)", !!undone);
  await until(async () => (await page.locator("#conversation").innerText()).includes(lastUser.content));
  await pause(500);
}

async function verifyEdit(page, ctx) {
  const before = (await api(`sessions/${ctx.sid}`)).messages;
  const firstUser = before.find((m) => m.role === "user");
  await hoverClick(page, rowOf(page, firstUser.messageId), "u-edit");
  await page.locator("#rw-text").fill(`edited ${ctx.stamp}`);
  await page.locator("[data-act='rw-what'][data-v='conversation']").click();
  const pressed = await page.locator("[data-act='rw-what'][data-v='conversation']").getAttribute("aria-pressed");
  check("rw-what picks what to put back", pressed === "true");
  await page.locator("[data-act='rw-go']").click();
  // The edited words are sent at once; Undo needs that task to have finished (the engine refuses while it works).
  const idle = idleIn(ctx.sid);
  const after = await until(async () => { const m = (await api(`sessions/${ctx.sid}`)).messages; return m.some((x) => x.content === `edited ${ctx.stamp}`) && (await idle()) && m; }, 15000);
  const status = await api(`sessions/${ctx.sid}/rewind`);
  check("rw-go goes back and sends the edited words", after && !after.some((x) => x.content === firstUser.content) && status.undo && status.undo.restore === "conversation",
    `GET session: first message now "${after && after.find((x) => x.role === "user").content}", rewind undo ${JSON.stringify(status.undo && status.undo.restore)}`);
  await page.locator(".toast [data-act='undo']").click();
  const undone = await until(async () => (await api(`sessions/${ctx.sid}/rewind`)).undo === null && (await api(`sessions/${ctx.sid}`)).messages.some((x) => x.content === firstUser.content), 10000);
  check("undo puts the conversation back (unrevert)", !!undone, "GET rewind undo null, original message back");
  await until(async () => (await page.locator("#conversation").innerText()).includes(firstUser.content));
  await pause(500);
}

async function verifySlash(page) {
  const commands = (await api("commands?surface=window")).commands.filter((c) => c.listed !== false);
  const box = page.locator("#prompt");
  await box.fill("");
  await box.pressSequentially("/");
  await page.locator(".slash6").waitFor();
  const shown = await page.locator(".slash6 [role='option'] b").allInnerTexts();
  check("slash list is the engine's commands", JSON.stringify(shown) === JSON.stringify(commands.map((c) => "/" + c.name)), shown.join(" "));
  await page.locator(".slash6 [data-act='slash6-pick']").nth(1).click();
  const value = await box.inputValue();
  check("slash6-pick puts the command in the box", value === `/${commands[1].name} `, JSON.stringify(value));
  await box.fill("");
  await page.locator("[data-act='plusmenu']").click();
  await page.locator(".pop [data-act='prompts-fill']").click();
  const opened = await until(() => page.locator(".slash6").count());
  check("prompts-fill opens the command list", opened === 1 && (await box.inputValue()) === "/");
  await box.fill("");
}

async function verifyMention(page, ctx) {
  const trunks = (await api("trunks")).trunks;
  const box = page.locator("#prompt");
  await box.fill("");
  await box.pressSequentially("hi @");
  await page.locator(".pop [data-act='mention-pick']").first().waitFor();
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  const names = await page.locator(".pop [data-act='mention-pick'] .mi-t").allInnerTexts();
  check("mention list is the engine's Trunks, box keeps focus", focused === "prompt" && names.includes(ctx.trunk.name) && names.length === trunks.length, names.join(", "));
  await page.locator(`.pop [data-act='mention-pick'][data-v="${ctx.trunk.name}"]`).click();
  check("mention-pick calls the Trunk in the box", (await box.inputValue()) === `hi @${ctx.trunk.name} `);
  await box.fill("");
}

async function verifyStatus(page, ctx) {
  const room = await api(`sessions/${ctx.sid}/context`), pct = Math.round((room.left / room.limit) * 100);
  const roomBtn = page.locator("#statusbar [data-act='roommenu']");
  await roomBtn.waitFor();
  check("roommenu button shows the engine's room", (await roomBtn.innerText()).includes(`${pct}%`), `${pct}% of ${room.limit}`);
  await roomBtn.click();
  const popText = await page.locator(".pop").innerText();
  check("roommenu popover", popText.includes("Room left in this conversation") && popText.includes(`${pct}% of`), popText.split("\n")[1]);
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  const usage = await api("usage?range=7d&by=day"), today = usage.data.find((d) => d.date === new Date().toISOString().slice(0, 10));
  const spendBtn = page.locator("#statusbar [data-act='spendmenu']");
  await spendBtn.waitFor();
  const want = `Today $${today.estimatedCost.toFixed(2)}`;
  check("spendmenu shows today's spend from GET /api/usage", (await spendBtn.innerText()).trim() === want, want);
  await spendBtn.click();
  check("spendmenu popover", (await page.locator(".pop").innerText()).includes(want));
  await page.mouse.click(5, 5);
}

async function verifyProject(page, ctx) {
  await page.locator("#side [data-act='projtoggle']").click();
  await page.locator(`#side [data-act='project'][data-v="${ctx.project.id}"]`).click();
  const active = await until(async () => (await api("projects")).active.id === ctx.project.id);
  check("project makes it the active project", !!active, `GET projects active ${ctx.project.id}`);
  const current = await until(async () => (await page.locator(`#side [data-act='project'][data-v="${ctx.project.id}"]`).getAttribute("aria-current")) === "true");
  check("project row shows it is active", current);
  await page.locator("#side [data-act='project'][data-v='default']").click();
  await until(async () => (await api("projects")).active.id === "default");
}

async function verifyQueue(page, ctx) {
  const policy = (await api("policy")).policy;
  await api("flows-boards/switch", { part: "waiting-line", mode: "on" });
  await api("policy", { ...policy, limits: { ...policy.limits, toolCallsPerMinute: 1 } });
  try {
    const running = api("run", { sessionId: ctx.sid, prompt: `slow task ${ctx.stamp}` }).catch(() => null);
    await until(async () => (await api("state")).runs.some((r) => r.sessionId === ctx.sid && r.status === "running"));
    await api(`sessions/${ctx.sid}/followups`, { prompt: `queued one ${ctx.stamp}` });
    await api(`sessions/${ctx.sid}/followups`, { prompt: `queued two ${ctx.stamp}` });
    const queued = (await api(`sessions/${ctx.sid}/followups`)).followUps;
    check("setup: two messages wait while the task works", queued.length === 2);
    const chip = page.locator("#main .dock [data-act='queue15']");
    await chip.waitFor({ timeout: 10000 });
    check("queue15 shows the waiting line", (await chip.innerText()).includes("2 waiting"));
    await chip.click();
    await page.locator(".pop [data-act='qup15']").nth(1).click();
    let now = (await api(`sessions/${ctx.sid}/followups`)).followUps;
    check("qup15 moves a message up", now[0].id === queued[1].id, now.map((f) => f.prompt).join(" | "));
    await page.locator(".pop input[data-q15]").first().fill(`reworded ${ctx.stamp}`);
    await page.locator(".pop input[data-q15]").first().press("Tab");
    now = await until(async () => { const f = (await api(`sessions/${ctx.sid}/followups`)).followUps; return f[0].prompt === `reworded ${ctx.stamp}` && f; });
    check("reword saves through the edit route", !!now);
    await page.locator(".pop [data-act='qrm15']").first().click();
    now = (await api(`sessions/${ctx.sid}/followups`)).followUps;
    check("qrm15 removes a message", now.length === 1 && now[0].id === queued[0].id, now.map((f) => f.prompt).join(" | "));
    await page.locator(".pop [data-act='qrm15']").first().click();
    const run = (await api("state")).runs.find((r) => r.sessionId === ctx.sid && r.status === "running");
    if (run) await api(`runs/${run.id}/cancel`, {});
    await running;
  } finally {
    await api("policy", policy);
  }
}

(async () => {
  const saved = await saveSettings();
  let ctx = null, browser = null;
  const errors = [];
  try {
    ctx = await setup(saved);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page);
    await page.locator(`#side [data-act='chat'][data-id="${ctx.sid}"]`).click();
    await page.locator("#conversation .u").first().waitFor();
    const msgs = (await api(`sessions/${ctx.sid}`)).messages;
    await verifyPins(page, ctx, msgs);
    await verifyInspect(page, ctx, msgs);
    await verifyEditBoth(page, ctx);
    await verifyEdit(page, ctx);
    await verifySlash(page);
    await verifyMention(page, ctx);
    await verifyStatus(page, ctx);
    await verifyProject(page, ctx);
    await verifyQueue(page, ctx);
  } catch (error) {
    check("script ran to the end", false, error.message);
  } finally {
    if (browser) await browser.close();
    await restoreSettings(saved, ctx);
  }
  check("no page errors", errors.length === 0, errors.join(" / "));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
