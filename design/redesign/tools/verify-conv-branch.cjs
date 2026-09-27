// Verifies pass 17's conversation features against a running engine: every control chat/branches.js, chat/leaveout.js,
// chat/more.js, chat/unread.js, chat/quick.js and chat/diagram.js mark live is clicked in the real window, and the change
// is confirmed through the engine's own GET route.
// Run: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-conv-branch.cjs
// Use a throwaway engine (fresh BRANCH_DATA_DIR, the offline demo provider). It makes conversations, a Trunk, paths and
// read marks there, and changes the quick-ask keys, then puts the keys back. The demo provider cannot write a diagram, so
// Save to Library is also proved on a second, in-process engine with a scripted model (its own temp folder, a free port).
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("PORT and TOKEN are required"); process.exit(2); }
const results = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const MERMAID = "flowchart LR\n  A[Something breaks] --> B{Under 150?}\n  B -- yes --> C[You pay]\n  B -- no --> D[Landlord pays]";

function client(base, token) {
  return async function api(path, body, method) {
    const res = await fetch(`${base}/api/${path}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error || ""}`);
    return data;
  };
}
const BASE = `http://127.0.0.1:${PORT}`;
const api = client(BASE, TOKEN);
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await pause(250); }
}
const idle = (call, sid) => async () => !(await call("state")).runs.some((r) => r.sessionId === sid && ["running", "queued"].includes(r.status));

async function signIn(page, base, token, call) {
  await call("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  await page.goto(base + "/");
  await page.getByLabel("Session token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .row, #side [data-act='chat']", { timeout: 15000 });
}
const unreadOf = async (sid) => (await api("sessions?limit=50")).sessions.find((s) => s.sessionId === sid)?.unread;
async function rowMenu(page, sid, act) {
  await page.locator(`#side .row[data-id="${sid}"]`).click({ button: "right" });
  await page.locator(`.pop [data-act="${act}"]`).click();
}
async function openChat(page, sid) {
  await page.locator(`#side .row[data-id="${sid}"]`).click();
  await page.waitForSelector("#conversation [data-i15]");
}
async function hoverAct(page, mid, act) {
  const row = page.locator(`#conversation [data-i15="${mid}"]`);
  await row.hover();
  await row.locator(`.msg-acts [data-act="${act}"]`).click();
}

async function verifyUnread(page, ctx) {
  check("a reply nobody opened is unread (GET /api/sessions)", await unreadOf(ctx.sid) === true);
  await page.evaluate(() => document.querySelector("[data-act='view'][data-v='inbox']").click());
  await page.locator("#side .row .unread").first().waitFor({ timeout: 8000 });
  check("the list shows the unread dot", await page.locator(`#side .row[data-id="${ctx.sid}"] .unread`).count() === 1);
  await rowMenu(page, ctx.sid, "unread17c");
  check("unread17c marks a conversation read", await until(async () => (await unreadOf(ctx.sid)) === false));
  await rowMenu(page, ctx.sid, "unread17c");
  check("unread17c marks it unread again", await until(async () => (await unreadOf(ctx.sid)) === true));
  await page.locator("#side [data-act='markread17c']").click();
  check("markread17c marks every conversation read", await until(async () => (await api("sessions?limit=50")).sessions.every((s) => !s.unread)));
  await api("read-marks", { conversation: ctx.sid, unread: true });
  await page.evaluate(() => document.querySelector("[data-act='view'][data-v='inbox']").click());
  await openChat(page, ctx.sid);
  check("opening a conversation marks it read", await until(async () => (await unreadOf(ctx.sid)) === false));

  // Inbox: the finished tasks came after the marks began, so they are unread until read.
  await page.locator("[data-act='view'][data-v='inbox']").click();
  await page.locator("[data-act='ptab'][data-place='inbox'][data-v='finished']").click();
  await page.locator("#main .prow.unr17c").first().waitFor({ timeout: 8000 });
  const first = await page.locator("#main .prow.unr17c").first().getAttribute("data-rk");
  await page.locator("#main .prow.unr17c").first().locator("[data-act='chat']").click();
  check("opening an Inbox item marks it read", await until(async () => (await api("read-marks")).inbox.read.includes(first)), first);
  await page.locator("[data-act='view'][data-v='inbox']").click();
  await page.locator("[data-act='ptab'][data-place='inbox'][data-v='finished']").click();
  await page.locator("#main [data-act='inread17c']").click();
  const marks = await until(async () => { const m = (await api("read-marks")).inbox; return m.read.length === 0 && m; });
  check("inread17c marks the Inbox read", !!marks && await until(async () => (await page.locator("#main .prow.unr17c").count()) === 0), marks && `since ${marks.since}`);
}

async function verifyBranch(page, ctx) {
  await openChat(page, ctx.sid);
  const msgs = (await api(`sessions/${ctx.sid}`)).messages;
  const reply = msgs.find((m) => m.role === "assistant" && !m.toolCalls?.length);
  await hoverAct(page, reply.messageId, "more17c");
  const menu = await page.locator(".pop").innerText();
  check("more17c lists Branch from here and Leave out of context", menu.includes("Branch from here") && menu.includes("Leave out of context"));
  await page.locator(".pop [data-act='br17c']").click();
  await page.locator(".dlg[aria-label='Branch from here']").waitFor();
  await page.locator("#br-name17c").fill("Verify path");
  const preset = (await api("state")).models.presets[0];
  await page.locator(`.dlg [data-act='brmodel17c'][data-v="${preset.id}"]`).click();
  await page.locator(".dlg [data-act='brmake17c']").click();
  const tree = await until(async () => { const t = await api(`sessions/${ctx.sid}/paths`); return t.paths.length === 2 && t; });
  const made = tree && tree.paths[1];
  check("br17c + brmodel17c + brmake17c make a named path with its model", made && made.name === "Verify path" && made.preset === preset.id && made.branchPointMessageId === reply.messageId, made && JSON.stringify({ name: made.name, preset: made.preset }));
  await page.locator(".brbar17c").waitFor({ timeout: 8000 });
  check("the window opens the new path, with the “On the path” bar", (await page.locator(".brbar17c").innerText()).includes("Verify path"));
  check("the marker shows two paths from here", (await page.locator("#conversation .brm17c").innerText()).includes("2 paths from here"));
  await page.locator(".brbar17c [data-act='brcmp17c']").click();
  const cols = await page.locator(".dlg .cmpc17c").count();
  check("brcmp17c compares the two paths' answers", cols === 2);
  await page.locator(".dlg [data-act='dlg-close']").click();
  await page.locator(".brbar17c [data-act='brgo17c']").click();
  const back = await until(async () => (await page.locator(".brbar17c").count()) === 0 && (await page.locator(`#side .row[data-id="${ctx.sid}"][aria-current="true"]`).count()) === 1);
  check("brgo17c switches back to the original", back, `GET paths current ${(await api(`sessions/${ctx.sid}/paths`)).current.slice(0, 8)}`);

  // From your own message: the path begins just before it and the words are answered again there.
  const asked = msgs.filter((m) => m.role === "user")[1];
  await hoverAct(page, asked.messageId, "br17c");
  await page.locator("#br-name17c").fill("Again");
  await page.locator(".dlg [data-act='brmake17c']").click();
  const again = await until(async () => (await api(`sessions/${ctx.sid}/paths`)).paths.find((p) => p.name === "Again"));
  const answered = again && await until(async () => { const m = (await api(`sessions/${again.sessionId}`)).messages; return (await idle(api, again.sessionId)()) && m.some((x) => x.role === "assistant" && !x.toolCalls?.length && m.indexOf(x) >= again.copied) && m; }, 30000);
  check("branching from your own message answers it again on the new path", answered && answered.filter((m) => m.role === "user" && m.content === asked.content).length === 1, answered && `${answered.length} messages, copied ${again.copied}`);

  // The side panel's Branches tab.
  await page.locator("[data-act='pane'][data-p='activity']").first().click();
  await page.locator(".ptab[data-p='branches']").click();
  await page.locator(".brp17c").waitFor();
  const rows = await page.locator(".brp17c .brr17c").count();
  check("the Branches tab lists every path", rows === (await api(`sessions/${ctx.sid}/paths`)).paths.length, `${rows} rows`);
  await page.locator(".brp17c [data-act='brgo17c']").first().click();
  const switched = await until(async () => (await page.locator(`#side .row[data-id="${ctx.sid}"][aria-current="true"]`).count()) === 1);
  check("Switch in the Branches tab opens that path", switched);
  await page.locator(".ptab[data-p='branches']").click();
  await page.locator(".brp17c [data-act='brcmp17c']").click();
  await page.locator(".dlg .cmpsel17c select").first().waitFor();
  await page.locator("#br-sel117c").selectOption(again.sessionId);
  check("with more than two paths, the pickers choose which to compare", (await page.locator(".dlg .cmpc17c h3").allInnerTexts()).includes("Again"));
  await page.locator(".dlg [data-act='dlg-close']").click();
  await page.locator(".brp17c [data-act='br17c']").click();
  await page.locator("#br-name17c").fill("From the latest");
  await page.locator(".dlg [data-act='brmake17c']").click();
  check("New path from the latest makes a path", await until(async () => (await api(`sessions/${ctx.sid}/paths`)).paths.some((p) => p.name === "From the latest")));
  await page.locator("[data-act='pane'][data-p='close']").click();
}

async function verifyLeaveOut(page, ctx) {
  await openChat(page, ctx.sid);
  const first = (await api(`sessions/${ctx.sid}`)).messages.find((m) => m.role === "user");
  const leftOut = async () => (await api(`sessions/${ctx.sid}`)).messages.find((m) => m.messageId === first.messageId)?.leftOut === true;
  await hoverAct(page, first.messageId, "more17c");
  await page.locator(".pop [data-act='out17c']").click();
  check("out17c leaves a message out of context", await until(leftOut));
  await page.locator(".outb17c").waitFor();
  check("the message is faded with its badge", await page.locator(`#conversation [data-i15="${first.messageId}"].out17c`).count() === 1);
  await page.locator(".toast [data-act='undo']").click();
  check("Undo puts it back", await until(async () => !(await leftOut())));
  await hoverAct(page, first.messageId, "more17c");
  await page.locator(".pop [data-act='out17c']").click();
  await until(leftOut);
  await page.locator(".outb17c [data-act='out17c']").click();
  check("Put back puts it back in context", await until(async () => !(await leftOut())));
}

async function verifyQuick(page, ctx) {
  await page.locator("#side [data-act='newmenu']").click();
  await page.locator(".pop [data-act='qa17c']").click();
  await page.locator(".qa17c").waitFor();
  const words = `quick ask ${ctx.stamp}`;
  await page.locator("#qa-in17c").fill(words);
  await page.locator(`.qa17c [data-act='qato17c'][data-v="${ctx.trunk.id}"]`).click();
  check("qato17c keeps what was typed when the Trunk changes", await page.locator("#qa-in17c").inputValue() === words);
  await page.locator(".qa17c [data-act='qasend17c']").click();
  const made = await until(async () => (await api("sessions?limit=50")).sessions.find((s) => s.opening === words), 20000);
  const who = made && await api(`trunks/conversations/${made.sessionId}`);
  check("qasend17c starts a new conversation with the chosen Trunk", made && who.trunk?.id === ctx.trunk.id, made && `trunk ${who.trunk?.name}`);
  if (made) await until(idle(api, made.sessionId), 30000);
  await page.keyboard.press("Control+Shift+Space");
  check("the quick-ask keys open the box", await until(async () => (await page.locator(".qa17c").count()) === 1));
  await page.locator(".qa17c [data-act='qaclose17c']").click();
  check("qaclose17c closes it", (await page.locator(".qa17c").count()) === 0);
  await page.keyboard.press("Control+Shift+Space");
  await page.locator(".qa17c [data-act='qato17c'][data-v='branch']").click();
  await page.locator("#qa-in17c").fill(`${words} to Branch`);
  await page.keyboard.press("Enter");
  const plain = await until(async () => (await api("sessions?limit=50")).sessions.find((s) => s.opening === `${words} to Branch`), 20000);
  const plainWho = plain && await api(`trunks/conversations/${plain.sessionId}`);
  check("Enter sends to Branch as a new conversation", plain && plainWho.kind === "plain");
  if (plain) await until(idle(api, plain.sessionId), 30000);

  // The keys live in the engine's keys card, so the owner can change them from Keyboard shortcuts.
  await page.locator("#main").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("?");
  await page.locator(".dlg .keys15 [data-act='key15'][data-v='quickAsk']").click();
  await page.keyboard.press("Alt+Q");
  check("the quick-ask keys can be changed (GET /api/comfort keys.quickAsk)", await until(async () => (await api("comfort")).values.keys.quickAsk === "Alt+Q"));
  await page.locator(".dlg [data-act='keyreset15'][data-v='quickAsk']").click();
  check("and put back", await until(async () => (await api("comfort")).values.keys.quickAsk === "Ctrl+Shift+Space"));
  await page.locator(".dlg [data-act='dlg-close']").click();
}

async function verifyDiagram(page, browser) {
  const archive = { format: "branch-agent-conversation", version: 1, exportedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "Draw how a repair gets handled." }, { role: "assistant", content: "Here it is.\n\n```mermaid\n" + MERMAID + "\n```" }] };
  const imported = await api("sessions/import", archive);
  await page.reload();
  await page.waitForSelector("#side .row");
  await openChat(page, imported.sessionId);
  await page.locator(".dia17c").waitFor();
  check("a mermaid block draws as a diagram card with its text", (await page.locator(".dia17c pre").innerText()).includes("flowchart LR"));
  check("with no task holding the answer, Save to Library stays greyed", (await page.locator(".dia17c .acts button").nth(2).getAttribute("aria-disabled")) === "true");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.locator(".dia17c [data-act='diacopy17c']").click();
  // The clipboard on Windows writes line ends as CRLF.
  const copied = await until(async () => { const t = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"); return t === MERMAID && t; });
  check("diacopy17c copies the diagram's text", copied, copied ? "" : `clipboard: ${JSON.stringify(await page.evaluate(() => navigator.clipboard.readText()).catch((e) => e.message))}; toast: ${await page.locator(".toast").innerText().catch(() => "")}`);
  await page.locator(".dia17c [data-act='diaopen17c']").click();
  const frame = page.locator(".dlg iframe.dframe17c");
  await frame.waitFor();
  const src = await frame.getAttribute("src"), sandbox = await frame.getAttribute("sandbox");
  const served = await fetch(BASE + src).then(async (r) => ({ ok: r.ok, csp: r.headers.get("content-security-policy"), body: await r.text() }));
  check("diaopen17c opens it larger as an artifact, in a sandboxed frame", sandbox === "" && served.ok && /sandbox/.test(served.csp) && served.body.includes("flowchart LR"), src);
  await page.locator(".dlg [data-act='dlg-close']").click();
  await verifyDiagramSave(browser);
}

/* Save to Library needs the task whose answer holds the diagram, so it runs on an engine whose model writes one. */
async function verifyDiagramSave(browser) {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-diagram-"));
  const provider = { name: "scripted", async complete() { return { content: "Here it is.\n\n```mermaid\n" + MERMAID + "\n```", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = client(server.url, server.token);
  const page = await browser.newPage();
  page.on("pageerror", (e) => check("no page errors (scripted engine)", false, e.message));
  try {
    const run = await call("run", { prompt: "Draw how a repair gets handled." });
    await signIn(page, server.url, server.token, call);
    await openChat(page, run.sessionId);
    await page.locator(".dia17c [data-act='diasave17c']").click();
    const kept = await until(async () => (await call("artifacts")).artifacts.find((a) => a.runId === run.id && a.name.endsWith(".mmd")));
    check("diasave17c keeps the text in Library (GET /api/artifacts)", kept, kept && kept.name);
    check("and the card reads In Library", await until(async () => (await page.locator(".dia17c [data-act='diasave17c']").innerText()) === "In Library"));
  } finally {
    await page.close();
    await server.close().catch(() => {});
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

async function setup() {
  const stamp = Date.now().toString(36);
  await api("trunks/switch", { part: "trunks", mode: "on" });
  await api("trunks/switch", { part: "conversations", mode: "on" });
  const trunk = (await api("trunks", { name: `Verify ${stamp}`, title: "Checks quick ask" })).trunk;
  const first = await api("run", { prompt: `first message ${stamp}` });
  await api("run", { sessionId: first.sessionId, prompt: `second message ${stamp}` });
  await until(idle(api, first.sessionId), 30000);
  return { sid: first.sessionId, trunk, stamp };
}

(async () => {
  const keysBefore = (await api("comfort")).values.keys.quickAsk, modesBefore = (await api("trunks")).modes ?? {};
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const ctx = await setup();
    await signIn(page, BASE, TOKEN, api);
    // ONLY=unread,branch,... runs just those parts (all by default).
    const only = (process.env.ONLY || "unread,branch,leaveout,quick,diagram").split(",");
    if (only.includes("unread")) await verifyUnread(page, ctx);
    if (only.includes("branch")) await verifyBranch(page, ctx);
    if (only.includes("leaveout")) await verifyLeaveOut(page, ctx);
    if (only.includes("quick")) await verifyQuick(page, ctx);
    if (only.includes("diagram")) await verifyDiagram(page, browser);
  } catch (error) {
    check("the run finished", false, error.message);
  } finally {
    await api("comfort", { card: "keys", values: { quickAsk: keysBefore } }).catch((e) => console.log("restore keys:", e.message));
    for (const part of ["conversations", "trunks"])
      await api("trunks/switch", { part, mode: modesBefore[part] ?? "off" }).catch((e) => console.log(`restore ${part}:`, e.message));
    check("no page errors", errors.length === 0, errors.join(" | "));
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
