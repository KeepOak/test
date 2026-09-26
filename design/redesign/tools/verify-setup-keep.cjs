/* Setup › Keep it running (step 8), against three fresh engines this script starts and stops itself:
     A. verify-setup-keep-engine.mjs: an "installed" engine whose Windows sign-in list is an in-memory stand-in, so the
        real HKCU Run key is never read or written;
     B. a plain `node dist/cli.js start` from this checkout: not an installed app, so it has no program to register;
     C. verify-setup-keep-engine.mjs with LOGIN_ITEM=1: a Mac-style login item that macOS keeps waiting for approval.
   It proves, through the engine's own GET routes: the gateway is one on/off switch that saves, and an old "when-needed"
   reads as on; "Start with Windows" and "Keep Branch up to date by itself" are clickable, save, and survive a reload;
   a first setup draws the three switches on (ship-on) and Continue saves them; the not-installed line shows and only
   that switch is off; the old fake permission handlers are gone; and no page errors.
     PORT_A=<port> PORT_B=<port> PORT_C=<port> node design/redesign/tools/verify-setup-keep.cjs
   (defaults 3791, 3792, 3793). Screenshots go to %TEMP%/claude-session-files/setup-keep/. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../../..");
const PORT_A = Number(process.env.PORT_A ?? 3791), PORT_B = Number(process.env.PORT_B ?? 3792), PORT_C = Number(process.env.PORT_C ?? 3793);
if ([PORT_A, PORT_B, PORT_C].some((p) => [3210, 3299, 3300].includes(p))) throw new Error("Never these ports.");
const SHOTS = path.join(process.env.TEMP ?? os.tmpdir(), "claude-session-files", "setup-keep");
fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };

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
/* A native switch shows its new state at once; the save is proved only when the engine's GET says so. */
async function engineBecomes(api, mode) {
  for (let i = 0; i < 50; i++) { if ((await api("never-break")).mode === mode) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}
const engineState = async (api) => {
  const [gw, dep, comfort] = await Promise.all([api("never-break"), api("deployment"), api("comfort")]);
  return { gw: gw.mode, boot: dep.autostart?.enabled, upd: comfort.values?.notify?.autoUpdate };
};

async function signIn(browser, port, token, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return page;
}

/* Setup opens by itself on a first run; after onboarding it opens from the window's own "onboard" action. */
async function toKeepStep(page, opensByItself) {
  if (!opensByItself) await page.evaluate(() => { const b = document.createElement("button"); b.type = "button"; b.dataset.act = "onboard"; b.dataset.v = "1"; document.getElementById("app").append(b); b.click(); b.remove(); });
  await page.locator(".ob9").waitFor({ timeout: 30000 });
  if (!(await page.locator("#ob-trust").isChecked())) await page.locator(".ob-agree").click();
  await page.locator('.ob-rail [data-act="ob-go"][data-v="7"]').click();
  await page.waitForFunction(() => { const s = document.querySelector("#ob-gw"); return s && !s.disabled && document.querySelector(".ob9")?.dataset.step === "7"; }, null, { timeout: 30000 });
}
const shown = (page) => page.evaluate(() => Object.fromEntries(["ob-gw", "ob-boot", "ob-upd"].map((id) => { const s = document.getElementById(id); return [id, { on: s.checked, off: s.disabled }]; })));
const settled = (page, id) => page.waitForFunction((x) => { const s = document.getElementById(x); return s && !s.disabled; }, id, { timeout: 30000 });
async function flip(page, id) { await page.locator(`#${id}`).click(); await page.waitForTimeout(150); await settled(page, id); }

async function installedEngine(browser) {
  const { child, token } = await startEngine(["design/redesign/tools/verify-setup-keep-engine.mjs"], { PORT: String(PORT_A) }, "engine A");
  const api = caller(PORT_A, token), errors = [];
  try {
    const before = await engineState(api);
    check("A: a fresh engine ships all three off", before.gw === "off" && before.boot === false && before.upd === "off", JSON.stringify(before));
    const page = await signIn(browser, PORT_A, token, errors);
    await toKeepStep(page, true);
    check("A: the gateway is one switch, no three-way left", (await page.locator('.ob9 [data-act="ob-gw"], .ob9 .seg').count()) === 0 && (await page.locator("#ob-gw.sw").count()) === 1);
    const first = await shown(page);
    check("A: a first setup draws the three switches on (ship-on) and clickable", Object.values(first).every((s) => s.on && !s.off), JSON.stringify(first));
    check("A: nothing is saved before Continue", JSON.stringify(await engineState(api)) === JSON.stringify(before));
    await page.screenshot({ path: path.join(SHOTS, "a-first-setup-defaults.png") });
    await page.locator('.ob9 [data-act="ob-next"]').click();
    await page.waitForFunction(() => document.querySelector(".ob9")?.dataset.step === "8", null, { timeout: 30000 });
    const applied = await engineState(api);
    check("A: Continue saves the defaults (gateway on, sign-in list, update by itself)", applied.gw === "on" && applied.boot === true && applied.upd === "install", JSON.stringify(applied));
    const dep = await api("deployment");
    check("A: the stand-in sign-in list holds the installed program, opening to the tray", /Branch Agent\.exe" --start-minimized$/.test(dep.autostart.command ?? ""), dep.autostart.command);

    await api("onboarding", { done: true }); // after this, the step draws only what the engine has
    for (const [id, key, off] of [["ob-gw", "gw", "off"], ["ob-boot", "boot", false], ["ob-upd", "upd", "off"]]) {
      await page.reload();
      await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
      await toKeepStep(page, false);
      check(`A: ${id} reads on from the engine after a reload`, (await shown(page))[id].on === true);
      await flip(page, id);
      const now = await engineState(api);
      check(`A: ${id} clicked off saves through its route`, now[key] === off, JSON.stringify(now));
      if (id === "ob-gw") {
        const note = await page.evaluate(() => document.getElementById("ob-gw").closest(".ctl").nextElementSibling);
        const said = await page.locator("#ob-gw").evaluate((s) => { const n = s.closest(".ctl").nextElementSibling; return n?.matches("p.hint") ? n.textContent : ""; });
        check("A: when it takes effect is said right under the gateway row", /next time Branch starts/.test(said), said || String(note));
        await page.screenshot({ path: path.join(SHOTS, "a-gateway-saved-note.png") });
      }
      await page.reload();
      await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
      await toKeepStep(page, false);
      check(`A: ${id} stays off after a reload`, (await shown(page))[id].on === false);
      await flip(page, id);
      check(`A: ${id} clicked on again saves`, (await engineState(api))[key] !== off);
    }

    await api("never-break", { mode: "when-needed" });
    await page.reload();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await toKeepStep(page, false);
    check("A: an old \"when-needed\" reads as on", (await shown(page))["ob-gw"].on === true);
    await page.screenshot({ path: path.join(SHOTS, "a-keep-step.png") });
    await flip(page, "ob-gw");
    check("A: turning it off from when-needed saves off", (await api("never-break")).mode === "off");
    await page.keyboard.press("Escape");

    // Settings › Gateway and the status-bar popover are the same one switch.
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="gateway"]').click();
    await page.waitForFunction(() => { const s = document.querySelector("#main #gw-mode"); return s && !s.disabled; }, null, { timeout: 30000 });
    check("A: Settings › Gateway has no three-way", (await page.locator('#main [data-act="gw-mode"]').count()) === 0);
    await page.locator("#main #gw-mode").click();
    await page.waitForFunction(() => document.querySelector("#main #gw-mode")?.checked === true, null, { timeout: 30000 });
    check("A: Settings › Gateway switch saves on", await engineBecomes(api, "on"));
    await page.screenshot({ path: path.join(SHOTS, "a-settings-gateway.png") });
    const pop = page.locator('[data-act="gwpop"]').first();
    if (await pop.count()) {
      await pop.click();
      await page.locator("#gwpop-sw").waitFor({ timeout: 10000 });
      check("A: the gateway popover is a switch drawn on", await page.locator("#gwpop-sw").isChecked());
      check("A: the popover has no three-way left", (await page.locator('[data-act="gwpop-mode"]').count()) === 0);
      const row = await page.locator("#gwpop-sw").evaluate((sw) => { const r = sw.closest(".row-in"), label = r.querySelector("span"); const lh = parseFloat(getComputedStyle(label).lineHeight) || 20; return { oneLine: label.getBoundingClientRect().height <= lh * 1.5, sameRow: Math.abs(label.getBoundingClientRect().top + label.getBoundingClientRect().height / 2 - (sw.getBoundingClientRect().top + sw.getBoundingClientRect().height / 2)) < 8 }; });
      check("A: the popover's label and switch sit on one row", row.oneLine && row.sameRow, JSON.stringify(row));
      check("A: the popover keeps Gateway settings…", (await page.locator('.pop [data-act="setgo"][data-v="gateway"]').count()) === 1);
      await page.locator(".pop").first().screenshot({ path: path.join(SHOTS, "a-gateway-popover.png") });
      await page.locator("#gwpop-sw").click();
      await page.waitForFunction(() => document.querySelector("#gwpop-sw")?.checked === false, null, { timeout: 10000 });
      check("A: the popover switch saves off", await engineBecomes(api, "off"));
    } else check("A: the gateway popover is drawn", false);

    check("A: no fake permission handler is drawn", (await page.locator('[data-act="perm-allow"], [data-act="perm-settings"]').count()) === 0);
    check("A: zero page errors", errors.length === 0, errors.join(" | "));
  } finally {
    child.kill();
  }
}

async function checkoutEngine(browser) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-setup-keep-b-"));
  const { child, token } = await startEngine(["dist/cli.js", "start"], { BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: path.join(dataDir, "workspace"), BRANCH_PORT: String(PORT_B) }, "engine B");
  const api = caller(PORT_B, token), errors = [];
  try {
    const dep = await api("deployment");
    check("B: the engine says it is not an installed app", dep.installed === false && dep.autostart.available === false, JSON.stringify(dep.autostart));
    const refused = await api("deployment/autostart", { enabled: true });
    check("B: the engine refuses to register a checkout", refused.status >= 400 && /has to be installed/.test(refused.error ?? ""), refused.error);
    const page = await signIn(browser, PORT_B, token, errors);
    await toKeepStep(page, true);
    const s = await shown(page);
    check("B: only \"Start with Windows\" is off; the other two stay clickable", s["ob-boot"].off && !s["ob-gw"].off && !s["ob-upd"].off, JSON.stringify(s));
    const line = await page.locator("#ob-boot").evaluate((x) => { const n = x.closest(".ctl").nextElementSibling; return n?.matches("p.hint") ? n.textContent : ""; });
    check("B: the honest line says why, in one line", /has to be installed on this computer before it can start/.test(line), line);
    await page.screenshot({ path: path.join(SHOTS, "b-not-installed.png") });
    check("B: zero page errors", errors.length === 0, errors.join(" | "));
  } finally {
    child.kill();
  }
}

/* C: a login item that macOS keeps waiting for approval (the engine's LoginItem stand-in). The desktop bridge is stood in
   by the page's own window.branchDesktop, so the button proves it asks for exactly the engine's Login Items link. */
async function loginItemEngine(browser) {
  const { child, token } = await startEngine(["design/redesign/tools/verify-setup-keep-engine.mjs"], { PORT: String(PORT_C), LOGIN_ITEM: "1" }, "engine C");
  const api = caller(PORT_C, token), errors = [];
  try {
    await api("onboarding", { done: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => { window.__opened = []; window.branchDesktop = { openExternal: async (url) => { window.__opened.push(url); return true; } }; });
    await page.goto(`http://127.0.0.1:${PORT_C}/`);
    await page.getByLabel("Session token", { exact: true }).fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await toKeepStep(page, false);
    await flip(page, "ob-boot");
    const dep = await api("deployment");
    check("C: switching it on saves the login item, and the engine says macOS wants approval", dep.autostart.enabled && dep.autostart.needsApproval && /LoginItems/.test(dep.autostart.settingsLink), JSON.stringify(dep.autostart));
    const line = await page.locator("#ob-boot").evaluate((x) => { const n = x.closest(".ctl").nextElementSibling; return n?.matches("p.hint") ? n.textContent : ""; });
    check("C: one line says where to approve it", /Login Items/.test(line), line);
    await page.locator('[data-act="ob-login-items"]').click();
    const opened = await page.evaluate(() => window.__opened);
    check("C: Open System Settings asks the desktop bridge for the engine's Login Items page", opened.length === 1 && opened[0] === dep.autostart.settingsLink, JSON.stringify(opened));
    await page.screenshot({ path: path.join(SHOTS, "c-mac-login-item-approval.png") });
    check("C: zero page errors", errors.length === 0, errors.join(" | "));
  } finally {
    child.kill();
  }
}

function staticChecks() {
  check("the fake mac/permissions.js is gone", !fs.existsSync(path.join(ROOT, "public/app/mac/permissions.js")));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []));
  const hits = walk(path.join(ROOT, "public/app")).filter((f) => /perm-allow|perm-settings|Would request permission/.test(fs.readFileSync(f, "utf8")));
  check("no perm-allow / perm-settings handler remains in the window", hits.length === 0, hits.join(", "));
}

(async () => {
  staticChecks();
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
