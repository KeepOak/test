/* unhold-control: clicks every control this group made live, on a fresh engine of its own, and reads each change back
   through the engine. Run after `npx tsc -p .`:  node design/redesign/tools/verify-unhold-control.cjs
   It starts its own engine in this process (a fresh temp data folder, port 0, a scripted model), so it needs no PORT or
   TOKEN and never touches another engine. The shared Linux desktop is a scripted stand-in (no Docker, no notice window on
   anybody's screen, a made-up viewer password), exactly as tests/shared-desktop.test.mjs stands one in.
   Controls: Take over / Hand back (stage), Open a terminal for me + a command (Terminal tab), Playground (Settings ›
   Developer), and Settings › Computer's "See the screen and use the mouse", "Ask before opening an app it hasn't used",
   "Where scripts run" and "Work in apps in the background". */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { mkdtemp, rm, stat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:net");

const ROOT = resolve(__dirname, "../../..");
const dist = (file) => import(pathToFileURL(join(ROOT, "dist", file)).href);
const VIEWER_PASSWORD = "viewer-pw-unhold-7c1e";
const results = [];
const check = (what, ok, detail = "") => { results.push([ok ? "PASS" : "FAIL", what, detail]); if (!ok) process.exitCode = 1; };
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };
const exists = (path) => stat(path).then(() => true, () => false);

/* The stand-in desktop: the engine's own LinuxDesktopSandbox with its docker, password feeder, viewer probe, listener
   and notice replaced, so starting it runs nothing on this computer. */
function standIn(desktop, listeners) {
  desktop.runner = async (file, args) => (args[0] === "image" ? "ok" : args[0] === "run" ? "abcdef012345\n" : "");
  desktop.feeder = async () => {};
  desktop.spawnerFn = () => ({ stdin: { write() {}, end() {} }, stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {}, pid: 1 });
  desktop.banner = { async show() {}, async hide() {} };
  desktop.password = () => VIEWER_PASSWORD;
  desktop.pauseMs = 1;
  desktop.probe = async () => true;
  desktop.createListener = () => new Promise((done) => { const s = createServer(); listeners.push(s); s.listen(0, "127.0.0.1", () => done(s)); });
}

async function engine() {
  const root = await mkdtemp(join(tmpdir(), "branch-unhold-control-"));
  const { createBranch } = await dist("index.js");
  const { startServer } = await dist("server.js");
  const { loadIntegrations } = await dist("integrations/bootstrap.js");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  // The programs installed on this computer, as `branch start` sets them up with no launch file (default-shell.ts).
  const integrations = await loadIntegrations(app.registry, undefined, process.env, app.secretsFor, app.channelHost);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  return { root, app, server, integrations, workspace: join(root, "workspace") };
}

function caller(server) {
  return async (path, body) => {
    const r = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error ?? ""}`);
    return data;
  };
}

async function takeOver(page, api, app) {
  await page.locator('#pane [data-act="stage"][data-v="browser"]').click();
  await page.locator("#stage7").waitFor();
  check("browser view offers no Take over (Branch's own browser has no hand-over)", (await page.locator('#stage7 [data-act="takeover"]').count()) === 0);
  await page.locator('#stage7 .st7-sw [data-v="computer"]').click();
  const take = page.locator('#stage7 [data-act="takeover"]');
  check("computer view draws Take over while the shared desktop runs with Branch in control", await until(async () => (await take.count()) === 1 && (await take.getAttribute("aria-disabled")) !== "true"));
  await take.click();
  const held = await until(async () => (await api("linux-desktop")).control === "user");
  check("Take over: GET /api/linux-desktop says control is the owner's", !!held);
  let refused = "";
  await app.linuxDesktop.act(app.runtime.owner, { type: "key", chord: "Return" }).catch((e) => { refused = e.message; });
  check("while taken over, Branch's desktop action is refused by the engine", /let go of it/.test(refused), refused);
  check("the stage says clearly the owner has control", await until(async () => (await page.locator("#stage7 .pill.you").textContent()) === "You have control"));
  const name = (await api("state")).identity?.name ?? "";
  const back = page.locator('#stage7 [data-act="handback"]');
  check("Hand back names the assistant (engine's name)", (await back.textContent()) === `Hand back to ${name}`);
  await page.locator('#stage7 .st7-sw [data-v="browser"]').click();
  check("Hand back stays reachable on the browser view while the owner holds it", (await page.locator('#stage7 [data-act="handback"]').count()) === 1);
  await page.locator('#stage7 [data-act="handback"]').click();
  check("Hand back: GET /api/linux-desktop says Branch has it again", !!(await until(async () => (await api("linux-desktop")).control === "agent")));
  check("after Hand back, Branch's desktop action runs", (await app.linuxDesktop.act(app.runtime.owner, { type: "key", chord: "Return" })).ran === "key");
  await page.locator('#stage7 [data-act="stage-close"]').click();
}

async function terminal(page, api, workspace) {
  await page.locator('#pane [data-act="ptabp"][data-p="terminal"]').click();
  await page.locator('#pane [data-act="shell"][data-v="open"]').click();
  const q = page.locator("#shell-q");
  await q.waitFor();
  check("Open a terminal for me opens the terminal", await q.isVisible());
  const rows = async () => (await api("sessions?limit=200")).sessions.length;
  const rowsBefore = await rows();
  await q.fill("node -e require('fs').mkdirSync('from-window')");
  await q.press("Enter");
  const yes = page.locator('#pane [data-act="shell-yes"]');
  await yes.waitFor({ timeout: 15000 });
  check("a command from the window asks first (the engine's own question)", /Before I go ahead/.test(await page.locator("#pane .shell").innerText()));
  check("nothing ran before the yes", !(await exists(join(workspace, "from-window"))));
  const shown = await page.locator("#pane .shell-out .out").count();
  await yes.click();
  check("Allow once runs exactly that command (the folder now exists in the workspace)", !!(await until(() => exists(join(workspace, "from-window")))));
  check("and what came back is shown", !!(await until(async () => (await page.locator("#pane .shell-out .out").count()) > shown)));
  const ran = await until(async () => (await api("state")).runs.find((r) => r.prompt === "shell.execute: node -e require('fs').mkdirSync('from-window')" && r.status === "completed"));
  check("the command is recorded as a finished run of its own (GET /api/state)", !!ran, ran ? `${ran.id} ${ran.source ?? ""}` : "");
  const here = (await api("state")).runs.find((r) => r.prompt === "Say done.")?.sessionId;
  check("kept in the conversation the terminal belongs to, and no new conversation in the side list (GET /api/sessions)", ran?.sessionId === here && (await rows()) === rowsBefore, `${ran?.sessionId} vs ${here}`);
  const rules = (await api("policy")).policy.rules;
  check("no standing yes was kept for commands", !rules.some((r) => r.decision === "allow" && /shell|\*/.test(r.tool)), JSON.stringify(rules));
  await api("lockdown", { on: true });
  await page.locator('#pane [data-act="shell"][data-v="close"]').click();
  await page.locator('#pane [data-act="shell"][data-v="open"]').click({ timeout: 15000 });
  const { lockdownToolRefusalText } = await dist("index.js");
  await until(async () => (await page.locator("#pane .shell-out .out").count()) > 0); // the reopened terminal keeps what it showed
  const lines = await page.locator("#pane .shell-out .out").count();
  await q.fill("node -e require('fs').mkdirSync('under-lockdown')");
  await q.press("Enter");
  await until(async () => (await page.locator("#pane .shell-out .out").count()) > lines);
  const answer = (await page.locator("#pane .shell-out .out").allTextContents()).at(-1) ?? "";
  check("under Lockdown the command is refused without asking, in the engine's Lockdown words", answer.includes(lockdownToolRefusalText) && (await page.locator('#pane [data-act="shell-yes"]').count()) === 0 && !(await exists(join(workspace, "under-lockdown"))), answer);
  check("the Lockdown hint shows in the Terminal tab", await until(async () => /commands are refused without asking/.test(await page.locator("#pane .term7").innerText())));
  await api("lockdown", { on: false });
  await page.locator('#pane [data-act="shell"][data-v="close"]').click();
}

async function openPlayground(page) {
  // Settings' search filters page names only, so the Developer page is opened by name (it shows at Technical).
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setlevel"][data-v="technical"]').click();
  await page.locator('[data-act="setpage"][data-v="developer"]').click();
  await page.locator("#main").getByRole("button", { name: "Open", exact: true }).first().click({ timeout: 10000 });
  await page.waitForFunction(() => document.getElementById("play-tool")?.options.length > 1);
}

async function playground(page, api, workspace) {
  await openPlayground(page);
  await page.locator("#play-tool").selectOption("files.write");
  await page.locator("#play-field-path").fill("played.txt");
  await page.locator("#play-field-content").fill("written by hand");
  await page.getByRole("button", { name: "Run files.write", exact: true }).click();
  await page.locator("#play-confirm").waitFor();
  check("the playground asks first under Ask before changes", /Before I go ahead/.test(await page.locator("#play-result").innerText()));
  await page.locator("#play-field-content").fill("changed after the question");
  check("changing a field drops the question (no yes can land on a changed request)", (await page.locator("#play-confirm").count()) === 0);
  await page.getByRole("button", { name: "Run files.write", exact: true }).click();
  await page.locator("#play-confirm").click();
  await page.locator("#play-result .code-block").waitFor();
  const read = await api("tools/try", { name: "files.read", arguments: { path: "played.txt" } });
  check("Allow once wrote the file (read back with files.read)", JSON.stringify(read.result ?? "").includes("changed after the question"), JSON.stringify(read).slice(0, 200));
  await page.locator("#play-tool").selectOption("files.read");
  await page.locator("#play-field-path").fill("played.txt");
  await page.getByRole("button", { name: "Run files.read", exact: true }).click();
  check("a read-only tool runs and shows what came back", !!(await until(async () => /changed after the question/.test(await page.locator("#play-result .code-body").innerText()))));
  const before = (await api("policy")).policy;
  await api("policy", { rules: [{ tool: "files.write", decision: "deny" }] });
  await page.locator("#play-tool").selectOption("files.write");
  await page.locator("#play-field-path").fill("denied.txt");
  await page.locator("#play-field-content").fill("never");
  await page.getByRole("button", { name: "Run files.write", exact: true }).click();
  await until(async () => (await page.locator("#play-result p").count()) > 0);
  check("a tool the owner's policy denies is refused, with no yes offered", (await page.locator("#play-confirm").count()) === 0 && !(await exists(join(workspace, "denied.txt"))),
    await page.locator("#play-result").innerText());
  await api("policy", { preset: before.preset, rules: before.rules });
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

async function computerPage(page, api) {
  await page.locator('[data-act="setpage"][data-v="computer"]').first().click();
  const screen = page.locator("#c-screen");
  await screen.waitFor();
  const was = (await api("desktop/settings")).enabled;
  await screen.click();
  check("See the screen and use the mouse: GET /api/desktop/settings follows", !!(await until(async () => (await api("desktop/settings")).enabled === !was)));
  await page.locator("#c-screen").click();
  check("and back", !!(await until(async () => (await api("desktop/settings")).enabled === was)));
  const presetBefore = (await api("policy")).policy.preset;
  // rw4: it ships on, so the switch is flipped from whatever the engine says and then put back.
  const asking = (await api("desktop/app-ask")).on;
  check("Ask before opening an app it hasn't used: the switch shows the engine's value", (await page.locator("#c-ask").isChecked()) === asking);
  await page.locator("#c-ask").click();
  check("Ask before opening an app it hasn't used: GET /api/desktop/app-ask follows", !!(await until(async () => (await api("desktop/app-ask")).on === !asking)));
  check("and the approval preset is left as it was", (await api("policy")).policy.preset === presetBefore);
  await page.locator("#c-ask").click();
  check("and back again", !!(await until(async () => (await api("desktop/app-ask")).on === asking)));
  const wall = (await api("os-sandbox")).settings;
  await page.locator('[data-act="c-where"][data-v="sealed"]').click();
  const sealed = await until(async () => { const s = (await api("os-sandbox")).settings; return s.mode === "on" && s; });
  check("Where scripts run › Sealed box: GET /api/os-sandbox mode is on", !!sealed);
  check("the rest of the wall's record is kept (the route replaces it)", sealed && sealed.network === wall.network && JSON.stringify(sealed.unreadable) === JSON.stringify(wall.unreadable));
  await page.locator('[data-act="c-where"][data-v="this"]').click();
  check("Where scripts run › This computer: mode is off", !!(await until(async () => (await api("os-sandbox")).settings.mode === "off")));
  check("Where scripts run shows the engine's choice", !!(await until(async () => (await page.locator('[data-act="c-where"][data-v="this"]').getAttribute("aria-pressed")) === "true")));
  const bg = page.locator("#f15-work-in-apps-in-the-background");
  await bg.click();
  check("Work in apps in the background: GET /api/reach says when-needed", !!(await until(async () => (await api("reach")).modes["background-screen"] === "when-needed")));
  await page.locator("#f15-work-in-apps-in-the-background").click();
  check("and off again", !!(await until(async () => (await api("reach")).modes["background-screen"] === "off")));
  await api("lockdown", { on: true });
  await api("desktop/settings", { enabled: true });
  check("under Lockdown the screen switch still reads off", (await api("desktop/settings")).enabled === false);
  await api("lockdown", { on: false });
  await api("desktop/settings", { enabled: false });
}

(async () => {
  const listeners = [];
  const { root, app, server, integrations, workspace } = await engine();
  const api = caller(server);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [], bodies = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", async (r) => { if (r.url().includes("/api/")) bodies.push(await r.text().catch(() => "")); });
  try {
    standIn(app.linuxDesktop, listeners);
    await api("linux-desktop", { mode: "on" });
    await app.linuxDesktop.start(app.runtime.owner);
    await api("policy", { preset: "ask-before-changes" });
    await api("onboarding", { done: true });
    await page.goto(server.url + "/");
    await page.getByLabel("Session token").fill(server.token);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#prompt").waitFor();
    errors.length = 0; // the window's one request before sign-in is refused by design
    await page.fill("#prompt", "Say done.");
    await page.locator("#send").click();
    const run = await until(async () => (await api("state")).runs.find((r) => r.prompt === "Say done." && r.status === "completed"));
    check("a conversation to work in", !!run);
    await page.locator(`[data-act="chat"][data-id="${run.sessionId}"]`).first().click();
    await page.keyboard.press("Control+Shift+K");
    await takeOver(page, api, app);
    await terminal(page, api, workspace);
    await playground(page, api, workspace);
    await computerPage(page, api);
    check("the viewer password never reached the window (no /api answer carried it)", !bodies.some((b) => b.includes(VIEWER_PASSWORD)) && !(await page.content()).includes(VIEWER_PASSWORD));
    check("no page errors", errors.length === 0, errors.join(" | "));
  } catch (error) {
    check("the script ran to the end", false, error.message);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch((e) => console.error(e.message));
  } finally {
    await browser.close();
    await api("linux-desktop", { mode: "off" }).catch((e) => console.error(e.message));
    for (const s of listeners) s.close();
    await server.close();
    await integrations.close();
    await app.close();
    await rm(root, { recursive: true, force: true }).catch((e) => console.error(e.message));
  }
  for (const r of results) console.log(r.join("  "));
  console.log(process.exitCode ? "some checks failed" : "all checks passed");
  process.exit(process.exitCode ?? 0);
})();
