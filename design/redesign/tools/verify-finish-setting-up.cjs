/* Overview › Finish setting up keeps what setup's old steps did for a new person, against three fresh engines this
   script starts and stops itself:
     A. verify-install-engine.mjs: an "installed" engine whose Windows sign-in list is an in-memory stand-in, so the real
        HKCU Run key is never read or written;
     B. a plain `node dist/cli.js start` from this checkout: not an installed app, so nothing is registered;
     C. verify-install-engine.mjs with LOGIN_ITEM=1: a Mac-style login item that macOS keeps waiting for approval.
   It proves, through the engine's own GET routes: a new install has the gateway on and starts at sign-in with no setup
   step (src/keep-running.ts), and updates by itself (src/comfort/settings.ts, #467); Keep it running has a line each to turn off the gateway, starting at sign-in and updating
   by itself, and each saves; People asks the owner's name and saves it; Reach it anywhere pairs a phone; Tools opens
   Customize › Tools with the engine's rows; the not-installed line shows and only that switch is off; and no page errors.
     PORT_A=<port> PORT_B=<port> PORT_C=<port> node design/redesign/tools/verify-finish-setting-up.cjs
   (defaults 3791, 3792, 3793). Screenshots go to $SHOTS, else %TEMP%/claude-session-files/finish-setting-up/. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../../..");
const PORT_A = Number(process.env.PORT_A ?? 3791), PORT_B = Number(process.env.PORT_B ?? 3792), PORT_C = Number(process.env.PORT_C ?? 3793);
if ([PORT_A, PORT_B, PORT_C].some((p) => [3210, 3299, 3300].includes(p))) throw new Error("Never these ports.");
const SHOTS = process.env.SHOTS ?? path.join(process.env.TEMP ?? os.tmpdir(), "claude-session-files", "finish-setting-up");
fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startEngine(args, env, label) {
  const base = { ...process.env };
  for (const name of ["BRANCH_EXECUTABLE", "BRANCH_INSTALL_ROOT", "BRANCH_GATEWAY_CHILD", "BRANCH_INTEGRATIONS"]) delete base[name]; // a checkout, not an install
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not start: ${out.slice(-600)}`)), 120000);
    const read = (chunk) => {
      out += chunk.toString();
      const token = /Local session token \(paste into browser\): ([0-9a-f]+)/.exec(out)?.[1];
      if (token) { clearTimeout(timer); resolve({ child, token }); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => reject(new Error(`${label} exited (${code}): ${out.slice(-600)}`)));
  });
}

const caller = (port, token) => async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, ...json };
};
const engineState = async (api) => {
  const [gw, dep, comfort] = await Promise.all([api("never-break"), api("deployment"), api("comfort")]);
  return { gw: gw.mode, boot: dep.autostart?.enabled, upd: comfort.values?.notify?.autoUpdate };
};
/* One engine at a time, so all three can share one port: the next starts once this one has exited. */
function stopEngine(child) { return new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.removeAllListeners("exit"); child.once("exit", () => resolve()); child.kill(); }); }
async function until(fn, tries = 60) { for (let i = 0; i < tries; i++) { if (await fn()) return true; await wait(100); } return false; }

/* A fresh engine would open setup by itself; it is noted as left for later ("Skip for now", which asks nothing and does
   not finish setup), so the window opens, and Overview is opened from the side. */
async function toOverview(browser, port, token, errors, init) {
  await caller(port, token)("onboarding", { skipped: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  page.on("pageerror", (e) => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator('#side [data-act="view"][data-v="overview"]').first().click();
  await page.locator("#main .fin18c").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => { const s = document.getElementById("fin-gw"); return s && !s.disabled; }, null, { timeout: 30000 });
  return page;
}
const shown = (page) => page.evaluate(() => Object.fromEntries(["fin-gw", "fin-boot", "fin-upd"].map((id) => { const s = document.getElementById(id); return [id, { on: s.checked, off: s.disabled }]; })));
const settled = (page, id) => page.waitForFunction((x) => { const s = document.getElementById(x); return s && !s.disabled; }, id, { timeout: 30000 });
async function flip(page, id) { await page.locator(`#${id}`).click(); await page.waitForTimeout(150); await settled(page, id); }
const lineUnder = (page, id) => page.locator(`#${id}`).evaluate((x) => { const n = x.closest(".ctl").nextElementSibling; return n?.matches("p.hint") ? n.textContent : ""; });

async function installedEngine(browser) {
  const { child, token } = await startEngine(["design/redesign/tools/verify-install-engine.mjs"], { PORT: String(PORT_A) }, "engine A");
  const api = caller(PORT_A, token), errors = [];
  try {
    check("A: a new install has the gateway on with no setup step", await until(async () => (await api("never-break")).mode === "on"));
    check("A: and starts at sign-in, to the tray", await until(async () => /Branch Agent\.exe" --start-minimized$/.test((await api("deployment")).autostart?.command ?? "")));
    const before = await engineState(api);
    check("A: and updates by itself", before.upd === "install", before.upd);
    check("A: setup is not done yet (nothing was asked)", (await api("onboarding")).done === false);
    const page = await toOverview(browser, PORT_A, token, errors);
    const s = await shown(page);
    check("A: Keep it running draws the three lines as the engine has them, each clickable", s["fin-gw"].on && s["fin-boot"].on && s["fin-upd"].on === (before.upd === "install") && Object.values(s).every((x) => !x.off), JSON.stringify(s));
    await page.locator("#main .fin18c").screenshot({ path: path.join(SHOTS, "a-finish-setting-up.png") });
    for (const [id, key, off, on] of [["fin-gw", "gw", "off", "on"], ["fin-boot", "boot", false, true], ["fin-upd", "upd", before.upd === "install" ? "off" : "install", before.upd]]) {
      await flip(page, id);
      const now = await engineState(api);
      check(`A: ${id} clicked saves through its route`, now[key] === off, JSON.stringify(now));
      if (id === "fin-gw") check("A: when it takes effect is said under the gateway line", /next time Branch starts/.test(await lineUnder(page, id)));
      await page.reload();
      await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
      await page.locator('#side [data-act="view"][data-v="overview"]').first().click();
      await settled(page, id);
      check(`A: ${id} reads back from the engine after a reload`, (await shown(page))[id].on === (off === "install" || off === true));
      await flip(page, id);
      check(`A: ${id} clicked again saves`, (await engineState(api))[key] === on);
    }
    const dep = await api("deployment");
    check("A: the stand-in sign-in list holds the installed program again", /Branch Agent\.exe" --start-minimized$/.test(dep.autostart.command ?? ""), dep.autostart.command);

    /* People: the owner's name. */
    await page.locator("#ob-name").fill("Robin");
    await page.locator("#ob-name").press("Enter");
    check("A: People saves the owner's name (GET /api/profiles)", await until(async () => (await api("profiles")).owner?.name === "Robin"));
    /* Reach it anywhere: pairing a phone opens the pairing dialog with an invitation from the engine. */
    await page.locator('#main .fin18c li [data-act="pair"]').click();
    await page.locator(".scrim").first().waitFor({ timeout: 10000 });
    check("A: Your phone opens the pairing dialog", (await page.locator(".scrim").count()) === 1);
    await page.screenshot({ path: path.join(SHOTS, "a-pair-phone.png") });
    await page.keyboard.press("Escape");
    await page.locator(".scrim").waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
    /* Tools: Open records the step and opens Customize › Tools, drawn from the engine. */
    await page.locator('#main .fin18c [data-act="fin18c"][data-v="tools"]').click();
    await page.locator("#main .t9").waitFor({ timeout: 30000 });
    const view = await page.evaluate(() => import("/app/core/state.js").then((m) => [m.S.view, m.S.tabs.customize].join(" ")));
    check("A: Tools opens Customize › Tools", view === "customize tools", view);
    check("A: and Open recorded the step (GET /api/onboarding)", (await api("onboarding")).completed.includes("tools"));
    check("A: zero page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await stopEngine(child);
  }
}

async function checkoutEngine(browser) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-finish-b-"));
  const { child, token } = await startEngine(["dist/cli.js", "start"], { BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: path.join(dataDir, "workspace"), BRANCH_PORT: String(PORT_B) }, "engine B");
  const api = caller(PORT_B, token), errors = [];
  try {
    const dep = await api("deployment");
    check("B: the engine says it is not an installed app", dep.installed === false && dep.autostart.available === false, JSON.stringify(dep.autostart));
    check("B: a checkout registers nothing and leaves the gateway as it was", (await api("never-break")).mode === "off");
    const page = await toOverview(browser, PORT_B, token, errors);
    const s = await shown(page);
    check("B: only the sign-in line is off; the other two stay clickable", s["fin-boot"].off && !s["fin-gw"].off && !s["fin-upd"].off, JSON.stringify(s));
    const line = await lineUnder(page, "fin-boot");
    check("B: the honest line says why", /has to be installed on this computer before it can start/.test(line), line);
    await page.locator("#main .fin18c").screenshot({ path: path.join(SHOTS, "b-not-installed.png") });
    check("B: zero page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await stopEngine(child);
  }
}

/* C: a login item that macOS keeps waiting for approval (the engine's LoginItem stand-in). The desktop bridge is stood in
   by the page's own window.branchDesktop, so the button proves it asks for exactly the engine's Login Items link. */
async function loginItemEngine(browser) {
  const { child, token } = await startEngine(["design/redesign/tools/verify-install-engine.mjs"], { PORT: String(PORT_C), LOGIN_ITEM: "1" }, "engine C");
  const api = caller(PORT_C, token), errors = [];
  try {
    check("C: a new install switches the login item on", await until(async () => (await api("deployment")).autostart?.enabled === true));
    const dep = await api("deployment");
    check("C: the engine says macOS wants approval", dep.autostart.needsApproval && /LoginItems/.test(dep.autostart.settingsLink), JSON.stringify(dep.autostart));
    const page = await toOverview(browser, PORT_C, token, errors, () => { window.__opened = []; window.branchDesktop = { openExternal: async (url) => { window.__opened.push(url); return true; } }; });
    const line = await lineUnder(page, "fin-boot");
    check("C: one line says where to approve it", /Login Items/.test(line), line);
    await page.locator('[data-act="fin-login-items"]').click();
    const opened = await page.evaluate(() => window.__opened);
    check("C: Open System Settings asks the desktop bridge for the engine's Login Items page", opened.length === 1 && opened[0] === dep.autostart.settingsLink, JSON.stringify(opened));
    await page.locator("#main .fin18c").screenshot({ path: path.join(SHOTS, "c-mac-login-item-approval.png") });
    check("C: zero page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await stopEngine(child);
  }
}

(async () => {
  check("setup's old tools step is gone from the window", !fs.existsSync(path.join(ROOT, "public/app/flows/setup-tools.js")));
  const browser = await chromium.launch({ headless: true });
  try {
    await installedEngine(browser);
    await checkoutEngine(browser);
    await loginItemEngine(browser);
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
