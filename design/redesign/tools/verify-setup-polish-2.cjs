/* Setup polish 2: proves, in the real window against a FRESH engine with setup open (onboarding not done), the owner's
   five reports:
     1. no achievement pop-up while setup is open, and nothing setup asks for (the ask mode, the look, the hello, adding a
        model, the first Trunks and their introductions, a proposal, pairing a phone) is earned; the owner's own change
        after setup is (Rule maker);
     2. the "Pair a phone" dialog: the QR beside the steps, a Link row and a Code row, each with a Copy that really copies
        (read back from the clipboard), a select-text fallback when the clipboard refuses, and pairing exactly as #351
        (a stand-in phone answers with the link and code read off the rows, and waits for the owner's tick);
     3. the Trunk template cards draw each template's face (its colour and shape), and the Trunk made from one wears it;
     4. "Let Branch propose Trunks": with no model it shows the engine's words and starts nothing; with a model it starts
        a real "Make me a Trunk:" task that calls trunk.propose, whose proposal is a picked card, made on Continue;
     5. the bell on the note and on the card keeps achievements quiet (the engine's delight settings achievements.quiet),
        with Undo, and it holds after a reload while achievements are still earned.
   The model is a stand-in: an OpenAI-shaped stub this script serves on 127.0.0.1:1234 (LM Studio's own address), added
   through the engine's POST /api/connections/from-preset. It answers "Make me a Trunk:" with a trunk.propose call.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-setup-polish-2.cjs
   Screenshots go to SHOTS (default: the session folder). Page errors must be zero. */
const http = require("node:http");
const { generateKeyPairSync } = require("node:crypto");
let playwright;
try { playwright = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright"); }
catch { playwright = require("playwright"); }
const { chromium } = playwright;

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/setup-polish-2/";
const PROPOSAL = { name: "Quill", title: "Receipts and renewals", description: "Files receipts and says before a subscription renews.", why: "You asked for help with receipts." };
/* The setup templates' colours and shapes (public/app/flows/setup.js TEMPLATES), by index, and the shape names. */
const TEMPLATE_FACES = [["#4f6fa8", 0], ["#d8612a", 2], ["#2f8c86", 1], ["#56616b", 3], ["#b84a6b", 4], ["#8a5aa8", 3]];
const SHAPE_NAMES = ["circle", "pebble", "leaf", "acorn", "shield"];
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: `${SHOTS}${name}.png` });

/* The engine's routes, read as the owner. `setup` sends the header the window sends while setup is open. */
async function api(p, body, setup = false) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, ...(setup ? { "x-branch-origin": "setup" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(250); } }
const gotIds = async (setup) => new Set((await api("delight/achievements", undefined, setup)).list.filter((a) => a.got).map((a) => a.id));

/* ---------- the stand-in model ---------- */
function reply(body) {
  const last = body.messages?.at(-1) ?? {};
  const tool = (body.tools ?? []).find((t) => /^Propose a new Trunk/.test(t.function?.description ?? ""));
  const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
  if (last.role === "user" && tool && /Make me a Trunk:/.test(text))
    return { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool.function.name, arguments: JSON.stringify(PROPOSAL) } }] };
  return { content: last.role === "tool" ? "I proposed a Trunk for you." : "OK" };
}
function answer(res, body) {
  const said = reply(body), usage = { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 }, finish = said.tool_calls ? "tool_calls" : "stop";
  if (!body.stream) {
    const calls = said.tool_calls?.map(({ index: _index, ...call }) => call);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: said.content ?? null, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", ...(said.content ? { content: said.content } : {}), ...(said.tool_calls ? { tool_calls: said.tool_calls } : {}) } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}
function stub() {
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] })); return; }
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) { answer(res, JSON.parse(raw || "{}")); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`the stand-in model could not take 127.0.0.1:1234 (${error.code}); free it and run again`)));
    server.listen(1234, "127.0.0.1", () => resolve(server));
  });
}

/* ---------- the window ---------- */
/* Counts every achievement note or card drawn while setup is on screen, from the first paint. */
const WATCH = () => {
  window.__achOverSetup = 0;
  new MutationObserver(() => { if (document.querySelector(".ob9") && document.querySelector(".ach-toast, .ach-big")) window.__achOverSetup++; })
    .observe(document, { childList: true, subtree: true });
};
async function signIn(context) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator(".ob9").waitFor({ timeout: 20000 });
  return { page, errors };
}
const next = async (page) => { await page.locator('.ob9 [data-act="ob-next"]').click(); await page.waitForTimeout(700); };

/* Welcome to Yours: the hello, the ask mode and the look, each a real change or a real call. */
async function earlySteps(page) {
  await page.locator(".ob-agree").click();
  await next(page); // Where
  await next(page); // Models
  await page.locator('.ob9 [data-act="ob-test"]').click();
  await page.locator("#ob-test-out .sdot.bad").waitFor({ timeout: 15000 }); // no model yet: the engine's refusal
  await next(page); // Yours
  await page.locator('.ob9 [data-act="ob15"][data-k="asks"][data-v="plan"]').click();
  await until(async () => (await api("conversation-mode/settings", undefined, true)).settings.newConversation === "plan");
  await page.locator('.ob9 [data-act="ob15"][data-k="look"][data-v="dark"]').click();
  await page.waitForTimeout(500);
  check("setup: Plan and Dark were saved by the engine", (await api("conversation-mode/settings", undefined, true)).settings.newConversation === "plan");
  await next(page); // Trunks
}

/* 3: each template card draws its face: the av() pebble with the template's colour and shape. */
async function templateFaces(page) {
  const faces = await page.$$eval(".ob9 .ob-tpl[data-act='ob-tpl']", (cards) => cards.map((card) => {
    const av = card.querySelector(".av");
    return av ? { c: av.style.getPropertyValue("--c").trim().toLowerCase(), r: av.style.getPropertyValue("--r").trim(), eyes: av.querySelectorAll(".eye").length, dot: !!card.querySelector(".ob-dot") } : null;
  }));
  const shapes = await page.evaluate(async () => (await import("/app/core/ui.js")).SHAPES);
  const right = faces.length === TEMPLATE_FACES.length && faces.every((f, i) => f && f.c === TEMPLATE_FACES[i][0] && f.r === shapes[TEMPLATE_FACES[i][1]] && f.eyes === 2 && !f.dot);
  check("3 each template card is a Trunk face in the template's colour and shape", right, JSON.stringify(faces.map((f) => f && `${f.c} ${f.eyes}`)));
  await shot(page, "sp2-3-template-faces");
}

/* 4a: with no model, Propose shows the engine's own words and starts no task. */
async function proposeWithoutModel(page) {
  const words = (await api("state", undefined, true)).modelNeeded;
  const sessions = (await api("sessions?limit=50", undefined, true)).sessions.length;
  await page.locator("#ob-life").fill("I keep receipts for work and pay for too many subscriptions.");
  await page.locator('.ob9 [data-act="ob-propose"]').click();
  const note = await until(async () => (await page.locator(".ob9 .hint[role=status]").textContent())?.trim());
  check("4 with no model, Propose says the engine's own words", !!words && note === words, note);
  check("4 with no model, no task was started", (await api("sessions?limit=50", undefined, true)).sessions.length === sessions);
}

/* 4b: with a model, Propose starts a real task; its trunk.propose call is a picked card; the words typed are kept. */
async function proposeWithModel(page) {
  await api("connections/from-preset", { provider: "lm-studio", key: "stub-key", model: "stub-model", name: "Stand-in" }, true);
  await page.locator('.ob9 [data-act="ob-propose"]').click();
  const card = page.locator('.ob9 [data-act="ob-prop"]').first();
  await card.waitFor({ timeout: 30000 });
  const shown = await card.innerText();
  check("4 with a model, Branch's trunk.propose is a card", shown.includes(PROPOSAL.name) && shown.includes(PROPOSAL.description), shown.replace(/\n/g, " / "));
  check("4 the proposed card is picked, the owner's words are kept", (await card.getAttribute("aria-pressed")) === "true" && (await page.locator("#ob-life").inputValue()).startsWith("I keep receipts"));
  const left = (await api("sessions?limit=50", undefined, true)).sessions.filter((s) => /Make me a Trunk/.test(s.opening ?? s.title ?? ""));
  check("4 the proposal's temporary conversation was discarded once read", left.length === 0);
  await shot(page, "sp2-4-proposed");
}

/* Leaving Trunks makes the picked template (with its face) and the picked proposal (with exactly its fields). */
async function madeTrunks(page) {
  await page.locator('.ob9 [data-act="ob-tpl"][data-i="1"]').click();
  await next(page);
  const list = await until(async () => { const l = (await api("trunks", undefined, true)).trunks; return l.length >= 2 ? l : null; }, 20000);
  const expense = list?.find((tr) => tr.name === "Expense Manager"), quill = list?.find((tr) => tr.name === PROPOSAL.name);
  check("3 the Trunk made from a template wears its colour and shape", expense?.chosenColour === TEMPLATE_FACES[1][0] && expense?.look?.shape === SHAPE_NAMES[TEMPLATE_FACES[1][1]], `${expense?.chosenColour} ${expense?.look?.shape}`);
  const face = await page.evaluate(async (tr) => (await import("/app/core/ui.js")).faceOf(tr), expense);
  check("3 the card's face is the made Trunk's face", face.color === TEMPLATE_FACES[1][0] && face.shape === SHAPE_NAMES[TEMPLATE_FACES[1][1]]);
  check("4 the picked proposal is made with its own fields", quill?.title === PROPOSAL.title && quill?.description === PROPOSAL.description);
}

/* 2: the phone dialog's rows, Copy (and its fallback), and pairing as #351 built it. */
async function pairDialog(page) {
  await page.locator('.ob9 [data-act="pair"]').click();
  await page.locator('.dlg [data-act="pair-on"]').click({ timeout: 10000 });
  const field = page.locator(".dlg #pair-link");
  await field.waitFor({ timeout: 10000 });
  const invite = (await api("devices", undefined, true)).invitation;
  const link = await field.inputValue(), code = (await page.locator(".dlg #pair-code").innerText()).replace(/\D/g, "");
  const layout = await page.evaluate(() => {
    const qr = document.querySelector(".dlg .qr-wrap"), kids = [...qr.children].map((n) => n.getBoundingClientRect()), f = document.querySelector("#pair-link");
    return { side: kids.length === 2 && Math.abs(kids[0].top - kids[1].top) < 60 && kids[1].left > kids[0].right - 1, fits: f.scrollWidth <= f.clientWidth + 1,
      rows: [...document.querySelectorAll(".dlg .pair-row15")].map((r) => r.querySelector(".pair-lab15").textContent) };
  });
  check("2 the QR and the steps sit side by side", layout.side);
  check("2 a Link row and a Code row, labelled", JSON.stringify(layout.rows) === JSON.stringify(["Link", "Code"]), JSON.stringify(layout.rows));
  check("2 the Link is the invitation's full address, on one line in its field", link.includes(invite.id) && layout.fits, `${link} fits=${layout.fits}`);
  check("2 the Code is six digits, shown spaced", /^\d{6}$/.test(code) && /^\d{3} \d{3}$/.test(await page.locator(".dlg #pair-code").innerText()));
  await shot(page, "sp2-2-pair-dialog");
  await copies(page, link, code);
  await pairsAsBefore(page, link, code);
}
async function copies(page, link, code) {
  await page.locator('.dlg [data-act="pair-copy"][data-v="link"]').click();
  await page.waitForTimeout(200);
  check("2 Copy link copies the link and says Copied", (await page.evaluate(() => navigator.clipboard.readText())) === link
    && (await page.locator('.dlg [data-act="pair-copy"][data-v="link"]').innerText()).trim() === "Copied.");
  await page.locator('.dlg [data-act="pair-copy"][data-v="code"]').click();
  await page.waitForTimeout(200);
  check("2 Copy code copies the six digits", (await page.evaluate(() => navigator.clipboard.readText())) === code);
  await shot(page, "sp2-2-copied");
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException("refused", "NotAllowedError")); });
  await page.locator('.dlg [data-act="pair-copy"][data-v="link"]').click();
  await page.waitForTimeout(200);
  const picked = await page.evaluate(() => { const f = document.activeElement; return f?.id === "pair-link" && f.selectionStart === 0 && f.selectionEnd === f.value.length; });
  check("2 when the clipboard refuses, the link is selected to copy by hand", picked && (await page.locator(".toast").innerText()).includes("copy it by hand"));
}
/* A stand-in phone answers with what the rows show; it waits for the owner's tick, as #351 built it. */
async function pairsAsBefore(page, link, code) {
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const offer = /offer=([a-f0-9]{32})/.exec(link)?.[1];
  const res = await fetch(`${BASE}/api/devices/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer, code, name: "Stand-in phone", platform: "ios", publicKey: key }) });
  check("2 a phone answering with the Link and Code is heard", res.status === 200, String(res.status));
  await page.locator('.dlg [data-act="pair-letin"]').waitFor({ timeout: 10000 });
  check("2 Let it in waits for the owner's tick", await page.locator('.dlg [data-act="pair-letin"]').isDisabled());
  await page.locator("#pair-match").check();
  await page.locator('.dlg [data-act="pair-letin"]').click();
  const paired = await until(async () => (await api("devices", undefined, true)).devices.find((d) => d.name === "Stand-in phone"));
  check("2 the owner's yes lets it in", !!paired);
}

/* Through to the end, Done, and the tour put away: setup is over. */
async function finishSetup(page) {
  while (await page.locator('.ob9 [data-act="ob-next"]').count()) await next(page);
  await page.locator('.ob9 [data-act="ob-done"]:not([disabled])').waitFor({ timeout: 60000 });
  await page.locator('.ob9 [data-act="ob-done"]').click();
  await page.locator(".ob9").waitFor({ state: "detached" });
  await page.waitForTimeout(1500);
  if (await page.locator(".tour-layer").count()) await page.keyboard.press("Escape");
}

/* 5: a real note after setup, its bell and Undo; then the card's bell, which holds after a reload. */
async function bells(page) {
  await api("run", { prompt: "Say hello." }); // the owner's own first task, after setup
  const note = page.locator(".ach-toast");
  await note.waitFor({ timeout: 30000 });
  await shot(page, "sp2-5-note-bell");
  check("5 the note has the bell, named", (await note.locator('[data-act="ach-mute"]').getAttribute("aria-label")) === "Stop achievement pop-ups");
  await note.locator('[data-act="ach-mute"]').click();
  const quiet = await until(async () => (await api("delight")).settings.achievements.quiet === true);
  const gone = await note.waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false);
  check("5 the bell keeps achievements quiet in the engine, and the note goes", quiet && gone);
  check("5 a short note says so, with Undo", (await page.locator(".toast").innerText()).includes("without any pop-up") && (await page.locator('.toast [data-act="undo"]').count()) === 1);
  await page.locator('.toast [data-act="undo"]').click();
  check("5 Undo brings the pop-ups back", await until(async () => (await api("delight")).settings.achievements.quiet === false));
  await api("devices/mode", { mode: "off" }); // the owner's own rule change: Rule maker, a Gold card
  const card = page.locator(".ach-big .card");
  await card.waitFor({ timeout: 40000 });
  await shot(page, "sp2-5-card-bell");
  await card.locator('[data-act="ach-mute"]').click();
  check("5 the card's bell keeps them quiet", await until(async () => (await api("delight")).settings.achievements.quiet === true));
  await page.reload();
  await page.locator("#main").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const saved = await page.evaluate(async () => (await import("/app/shell/scene.js")).D.settings?.achievements?.quiet);
  const view = await api("delight/achievements");
  check("5 after a reload it is still quiet, and achievements are still earned and listed", saved === true && view.on && view.list.some((a) => a.id === "audit:policy.changed:1" && a.got));
}

async function main() {
  const model = await stub();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await context.addInitScript(WATCH);
  try {
    /* The first look finds, quietly, what a fresh engine ships with (the "Tidy my memory" procedure). The window used to
       make that look itself before setup opened; setup now opens on the first draw (setup-resume), so it is made here. */
    await gotIds();
    const { page, errors } = await signIn(context);
    const before = await gotIds(true);
    await earlySteps(page);
    await templateFaces(page);
    await proposeWithoutModel(page);
    await proposeWithModel(page);
    await madeTrunks(page);
    await pairDialog(page);
    await finishSetup(page);
    await page.waitForTimeout(17000); // past the window's 15 s look, so anything setup had earned would show now
    const after = await gotIds();
    const earned = [...after].filter((id) => !before.has(id));
    check("1 nothing setup asked for was earned", earned.length === 0, earned.join(", "));
    check("1 no achievement pop-up was drawn while setup was open", (await page.evaluate(() => window.__achOverSetup)) === 0);
    await bells(page);
    check("1 the owner's own change after setup is earned (Rule maker)", (await gotIds()).has("audit:policy.changed:1"));
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    model.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
