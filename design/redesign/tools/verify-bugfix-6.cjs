/* Bugfix 6 (the window bugs the re-pointed test PRs #319 and #320 found): proves each fix in the real window against a
   FRESH engine, reading every change back through the engine's own GET route. Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-6.cjs
   Replies, questions and Answer aloud need a model that answers, so those checks run on a second, in-process engine with
   a scripted model (its own temp folder, a free port). Stand-ins, all inside this script: dictation's two routes are
   answered here (no microphone is opened; the words are the stand-in's), and on the scripted engine POST /api/voice/speak
   answers a silent sound and the page's play() only counts (no voice is set up and nothing is heard). Test data it makes
   through the engine: a household person "Sam" (switched to, then back), the Gateway mode, Most steps in one task and
   the read-aloud setting, each put back as it was. */
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }

function client(base, token) {
  return async (p, body) => {
    const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
}
const BASE = `http://127.0.0.1:${PORT}`;
const api = client(BASE, TOKEN);

async function signIn(context, base, token, call) {
  await call("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  const page = await context.newPage();
  const errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.url().includes("/api/")) asked.push({ method: r.method(), path: new URL(r.url()).pathname, body: r.postData() }); });
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);
  return { page, errors, asked };
}
async function openSettings(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await page.locator(`[data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
}
const setLevel = async (page, v) => { await page.locator(`[data-act="setlevel"][data-v="${v}"]`).click(); await page.waitForTimeout(300); };
const backToChat = async (page) => { await openSettings(page, "general"); await page.locator(".settings .set-back").click(); await page.locator("#conversation").waitFor(); };

/* 1: a place command opens the place, and its answer is kept in the conversation. */
async function command(page) {
  const was = (await api("commands/settings")).mode;
  await api("commands/settings", { mode: "on" }); // the typed commands ship off; put back after
  await page.reload();
  await page.locator("#prompt").waitFor();
  await backToChat(page);
  await page.locator("#prompt").fill("/go library memory");
  await page.locator("#send").click();
  const opened = await page.locator('#main [data-act="ptab"][data-place="library"][data-v="memory"][aria-selected="true"]').waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("1 /go library memory opens Library › Memory (POST /api/commands/run answered do:go)", opened);
  await backToChat(page);
  check("1 and the answer is kept in the conversation", await page.locator("#conversation").getByText("Opening library:memory.").first().isVisible());
  await api("commands/settings", { mode: was });
}

/* 2: a place has the prototype's header: on a phone its button brings the list back; wide, it sits in the title bar. */
async function placeHead(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.locator('[data-act="side"]').first().click();
  await page.locator("#app.side-open").waitFor();
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  await page.locator('#main [data-act="ptab"][data-place="inbox"]').first().waitFor();
  await page.waitForTimeout(400); // the list finishes sliding away
  const menu = page.locator('#main .head [data-act="side"]');
  check("2 on a phone a place draws the header with Show conversations", await menu.isVisible());
  await menu.click();
  await page.waitForFunction(() => document.getElementById("side").getBoundingClientRect().left >= 0);
  await page.locator('#side [data-act="view"][data-v="library"]').click();
  const lib = await page.locator('#main [data-act="ptab"][data-place="library"]').first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("2 and from there the list opens Library (place switch redraws #main)", lib && (await page.locator("#main h1").first().innerText()) === "Library");
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(400);
  check("2 wide, the place header is in the title bar (Settings gear), not above the place",
    (await page.locator('.titlebar .tb-head14 [data-act="view"][data-v="settings"]').count()) === 1 && (await page.locator("#main .head").count()) === 0);
}

/* 5: dictation with the engine's two routes answered by a stand-in: the words fill the box while it listens. */
async function dictation(page) {
  const state = { open: false, words: "compare the two quotes", presses: [] };
  await page.route("**/api/voice/dictation/listen", async (route) => {
    state.open = JSON.parse(route.request().postData() ?? "{}").on === true;
    state.presses.push(state.open);
    await route.fulfill({ json: { open: state.open, refusal: "" } });
  });
  await page.route("**/api/voice/dictation", (route) => route.fulfill({ json: { settings: { mode: "on", silenceSeconds: 4 }, mode: "on", canDictate: true, refusal: "", isOwner: true, engine: { how: "", available: true }, open: state.open, words: state.words, settled: !state.open } }));
  await page.reload();
  await page.locator("#prompt").waitFor();
  await backToChat(page);
  await page.locator("#prompt").fill("Please");
  await page.locator('#composer [data-act="dict"]').click();
  await page.locator(".dict").filter({ hasText: "Listening" }).waitFor();
  const live = await until(() => page.evaluate(() => document.getElementById("prompt")?.value.includes("compare the two quotes")), 5000);
  check("5 while it listens the words fill the message box (hidden behind the listening row)", live && await page.locator("#prompt").isHidden());
  await page.locator('[data-act="dict-done"]').click();
  await page.locator(".dict").waitFor({ state: "detached" });
  const kept = await page.locator("#prompt").inputValue();
  check("5 Done keeps the words after what was typed; one press on, one off", kept === "Please compare the two quotes" && JSON.stringify(state.presses) === "[true,false]", `${kept} ${JSON.stringify(state.presses)}`);
  await page.locator("#prompt").fill("");
  await page.unroute("**/api/voice/dictation/listen");
  await page.unroute("**/api/voice/dictation");
}

/* 6 and 7: Voice › Advanced follows the prototype; Answer aloud is the engine's autoReadAloud. */
async function voice(page) {
  await openSettings(page, "voice");
  await setLevel(page, "advanced");
  const heads = await page.locator(".set-col").locator("h1, h2").evaluateAll((all) => all.filter((n) => n.checkVisibility()).map((n) => n.textContent.trim()));
  check("6 Voice at Advanced: the prototype's sections in its order, no Live conversations", JSON.stringify(heads) === JSON.stringify(["Voice", "Talking", "Speaking back", "Listening, more", "Talking, more"]), heads.join(" · "));
  const group = page.locator(".set-col").getByRole("group", { name: "Answer aloud", exact: true });
  check("7 Answer aloud starts on the engine's value (Never)", (await api("voice/settings")).autoReadAloud === false && await group.getByRole("button", { name: "Never", pressed: true }).count() === 1);
  check("7 When I talk is greyed (no engine setting)", (await group.getByRole("button", { name: "When I talk" }).getAttribute("aria-disabled")) === "true");
  await group.getByRole("button", { name: "Always", exact: true }).click();
  check("7 Always saves autoReadAloud true (GET /api/voice/settings)", await until(async () => (await api("voice/settings")).autoReadAloud === true));
  await page.reload();
  await page.locator("#prompt").waitFor();
  await openSettings(page, "voice");
  await setLevel(page, "advanced");
  check("7 after a reload Always is pressed from the engine", await group.getByRole("button", { name: "Always", pressed: true }).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await group.getByRole("button", { name: "Never", exact: true }).click();
  check("7 Never saves autoReadAloud false", await until(async () => (await api("voice/settings")).autoReadAloud === false));
  await setLevel(page, "regular");
}

/* 10: Models › Budgets' Most steps in one task is the engine's step limit, in a plain box as the prototype's. */
async function steps(page) {
  await openSettings(page, "models");
  await setLevel(page, "advanced");
  const box = page.getByRole("textbox", { name: "Most steps in one task", exact: true });
  await box.waitFor();
  const shipped = (await api("knobs")).values.limits.maxSteps;
  check("10 the box shows the engine's value (GET /api/knobs)", (await box.inputValue()) === String(shipped), await box.inputValue());
  await box.fill("25");
  await box.press("Enter");
  check("10 a change reaches the engine", await until(async () => (await api("knobs")).values.limits.maxSteps === 25));
  await box.fill(String(shipped));
  await box.press("Enter");
  await until(async () => (await api("knobs")).values.limits.maxSteps === shipped);
  await setLevel(page, "regular");
}

/* 13: the Gateway three-way is pressed from the engine's saved mode as soon as the page shows, also after a reload. */
async function gateway(page) {
  const before = (await api("never-break")).mode;
  const group = () => page.locator(".set-col").getByRole("group", { name: "Gateway", exact: true });
  await openSettings(page, "gateway");
  check("13 one position is pressed the moment the page shows", (await group().locator('[aria-pressed="true"]').count()) === 1);
  await group().getByRole("button", { name: "When needed", exact: true }).click();
  check("13 When needed is saved (GET /api/never-break)", await until(async () => (await api("never-break")).mode === "when-needed"));
  await page.reload();
  await page.locator("#prompt").waitFor();
  await openSettings(page, "gateway");
  check("13 after a reload it comes back pressed at once", (await group().getByRole("button", { name: "When needed", exact: true }).getAttribute("aria-pressed")) === "true");
  await api("never-break", { mode: before });
}

/* 11 and a profile switch: on somebody else's profile every Settings page is listed, and none asks for chat apps or the
   locker; the Overview's "Who is using Branch" follows the switch without a press. */
async function household(page, asked) {
  await page.locator('#side [data-act="view"][data-v="overview"]').click();
  await page.locator("#main h2", { hasText: "Who is using Branch" }).waitFor();
  const name = `Sam ${Date.now() % 10000}`;
  const sam = await api("profiles", { name, pin: "2468" });
  await page.evaluate(() => { window.__drawn = document.getElementById("main").firstElementChild; });
  await api("profiles/switch", { profileId: sam.id ?? sam.profile?.id, pin: "2468" });
  const shown = await until(() => page.evaluate((who) => (document.querySelector(".owner .who14")?.textContent ?? "").includes(who)
    && document.getElementById("main").firstElementChild !== window.__drawn && !/Who is using Branch/.test(document.getElementById("main").textContent), name), 15000);
  check("C a profile switch, made in the engine, redraws #main for the person (the owner's Overview is gone)", shown);
  const from = asked.length;
  await openSettings(page, "general");
  for (const one of ["gateway", "secrets", "instructions", "general"]) {
    check(`11 on the household person's profile Settings lists ${one}, as the prototype does`, (await page.locator(`[data-act="setpage"][data-v="${one}"]`).count()) === 1);
    await openSettings(page, one);
  }
  await page.waitForTimeout(3000);
  const owners = asked.slice(from).filter((r) => /^\/api\/(channels|channel-setup|secrets)(\/|$)/.test(r.path)).map((r) => r.path);
  check("11 and nothing asked for the owner's chat apps or locker", owners.length === 0, owners.join(" "));
  await api("profiles/switch", { profileId: null });
  check("the owner is back (GET /api/profiles)", (await api("profiles")).isOwner === true);
}

/* 4, 7's speaking and C's redraws, on an engine whose model answers: a question card, a triple press, a finished reply. */
async function scripted(browser) {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const { readPolicy, savePolicy } = await import(pathToFileURL(join(dist, "policy.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-bugfix-6-"));
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1), user = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    if (last.role === "tool") return { content: "Written.", toolCalls: [] };
    if (user.includes("note") || user === "Yes, go ahead.") return { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
    return { content: "Hello from the scripted model.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const call = client(server.url.replace(/\/$/, ""), server.token);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.addInitScript(() => { window.__played = 0; HTMLMediaElement.prototype.play = function () { window.__played += 1; return Promise.resolve(); }; });
  const spoken = [];
  await context.route("**/api/voice/speak", (route) => { spoken.push(JSON.parse(route.request().postData() ?? "{}")); return route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.alloc(44) }); });
  const { page, errors, asked } = await signIn(context, server.url.replace(/\/$/, ""), server.token, call);
  try {
    for (let round = 1; round <= 3; round++) {
      const approvesBefore = asked.filter((r) => r.path === "/api/policy/approve").length;
      const writtenBefore = (await page.locator("#conversation").innerText()).split("Written.").length;
      await page.locator("#prompt").fill(`write a note for me (${round})`);
      await page.locator("#send").click();
      const card = page.locator("#live-ask");
      await card.locator(".acts .btn.pri").waitFor({ timeout: 20000 });
      if (round === 1) check("C a waiting question redraws the conversation (its card shows)", true);
      await page.waitForTimeout(round * 700); // lands between the window's re-reads at different moments
      await card.evaluate((node) => { const yes = node.querySelector(".acts .btn.pri"); const no = [...node.querySelectorAll(".acts button")].find((b) => b.textContent === "Don’t allow"); yes.click(); yes.click(); no.click(); });
      const written = await until(async () => (await page.locator("#conversation").innerText()).split("Written.").length > writtenBefore, 15000);
      const approves = asked.filter((r) => r.path === "/api/policy/approve").length - approvesBefore;
      check(`4 round ${round}: a triple press on the big answer sends one answer and the task writes (Written.)`, written && approves === 1, `answers sent ${approves}`);
    }
    await call("voice/settings", { autoReadAloud: true });
    await page.locator("#prompt").fill("say hello");
    await page.locator("#send").click();
    check("C a new reply redraws the conversation", await until(async () => (await page.locator("#conversation").innerText()).includes("Hello from the scripted model."), 15000));
    await until(async () => spoken.length > 0, 5000);
    check("7 with Always, the finished reply is read aloud once (POST /api/voice/speak with its words, then played)",
      spoken.length === 1 && spoken[0].text === "Hello from the scripted model." && await page.evaluate(() => window.__played) === 1, JSON.stringify(spoken));
    await call("voice/settings", { autoReadAloud: false });
    await page.locator("#prompt").fill("say hello again");
    await page.locator("#send").click();
    await until(async () => (await page.locator("#conversation").innerText()).split("Hello from the scripted model.").length > 2, 15000);
    await page.waitForTimeout(1500);
    check("7 with Never, nothing is read aloud", spoken.length === 1, JSON.stringify(spoken));
    await call("voice/settings", { autoReadAloud: true });
    await page.reload();
    await page.locator("#prompt").waitFor();
    await page.waitForTimeout(3000);
    check("7 after a reload no old reply is read aloud", spoken.length === 1);
    await call("voice/settings", { autoReadAloud: false });
  } catch (e) { check("scripted engine checks finished", false, e.stack); }
  check("no page errors (scripted engine)", errors.length === 0, errors.join(" | "));
  await context.close();
  await server.close().catch(() => {});
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors, asked } = await signIn(context, BASE, TOKEN, api);
  try {
    await command(page);
    await placeHead(page);
    await dictation(page);
    await voice(page);
    await steps(page);
    await gateway(page);
    await household(page, asked);
  } catch (e) { check("script finished", false, e.stack); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await scripted(browser);
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
