// The real update test: an installed release is updated to the newest one by pressing its own
// Update button, on a test machine, with real saved work in it. See docs/agents/real-update-test.md.
//
// It runs ON the test machine (Linux or Windows), next to `playwright-core` (npm i playwright-core;
// no browsers are needed, the app is driven over its own DevTools port). Every command reads the
// same environment the app was started with, so the caller isolates the app (a throwaway HOME on
// Linux, BRANCH_DESKTOP_HOME and TEMP on Windows) and this script never touches anyone's real data.
//
//   node real-update-test.mjs launch  --exe <program> --port 9391
//   node real-update-test.mjs plant   --data <state folder> --out planted.json
//   node real-update-test.mjs update  --port 9391 --scratch <temp>/branch-agent-update [--fault corrupt|drop|kill-switch] [--drop-cmd "<cmd>"]
//   node real-update-test.mjs verify  --data <state folder> --planted planted.json [--expect 0.18.0]
//   node real-update-test.mjs quit    --data <state folder>
import { spawn, execSync } from "node:child_process";
import { existsSync, openSync, writeSync, closeSync, statSync, readFileSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const [command, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const at = rest.indexOf(`--${name}`); return at === -1 ? fallback : rest[at + 1]; };
const say = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const fail = (line) => { console.log(`FAIL: ${line}`); process.exit(1); };
const windows = process.platform === "win32";

/** A fixture process remains outside the installed app throughout its update/relaunch. */
async function fixture() {
  if (!process.send) fail("the fixture must be started by fixture-start");
  const module = flag("provider-module") ?? join(dirname(flag("exe")), "resources", "app", "dist", "demo.js");
  const { DemoProvider } = await import(pathToFileURL(module).href);
  const { startFixtureService } = await import("./model-service.mjs");
  const service = await startFixtureService(new DemoProvider(), { persistent: true, token: randomBytes(24).toString("base64url") });
  process.send(service.env, () => process.disconnect());
}

async function fixtureState() {
  const path = flag("state");
  if (!path) fail("--state is the fixture's private environment file");
  const text = await readFile(path, "utf8");
  if (text.length > 2048) throw new Error("Fixture environment is too large");
  const env = JSON.parse(text);
  if (env.BRANCH_PROVIDER !== "openai" || env.BRANCH_MODEL !== "demo"
    || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1$/.test(env.BRANCH_ENDPOINT)
    || !/^[A-Za-z0-9_-]{32}$/.test(env.BRANCH_API_KEY)) throw new Error("Invalid fixture environment");
  return env;
}

async function startFixture() {
  const state = flag("state"), exe = flag("exe");
  const module = flag("provider-module");
  if (!state || !(module ? existsSync(module) : exe && existsSync(exe)))
    fail("fixture-start needs --state and an installed --exe or extracted --provider-module");
  if (existsSync(state)) fail("stop the recorded external fixture before starting another one");
  const args = [fileURLToPath(import.meta.url), "fixture", ...(module ? ["--provider-module", module] : ["--exe", exe])];
  const child = spawn(process.execPath, args,
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  let timer;
  try {
    const env = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("External fixture did not start within ten seconds")), 10000);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("External fixture exited before becoming ready")));
      child.once("message", resolve);
    });
    await writeFile(state, JSON.stringify(env), { mode: 0o600 });
    await fixtureState(); // Only generated loopback metadata is admitted to relaunch scripts.
    if (flag("shell-env")) {
      const lines = Object.entries(env).filter(([key]) => /^BRANCH_(PROVIDER|ENDPOINT|MODEL|API_KEY)$/.test(key))
        .map(([key, value]) => `export ${key}='${value}'`).join("\n");
      await writeFile(flag("shell-env"), lines + "\nunset BRANCH_MODEL_PRESETS\n", { mode: 0o600 });
    }
    child.unref();
  } catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
}

async function stopFixture() {
  if (!flag("state") || !existsSync(flag("state"))) return;
  const env = await fixtureState();
  try {
    const response = await fetch(env.BRANCH_ENDPOINT.replace(/\/v1$/, "/__fixture/stop"), { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${env.BRANCH_API_KEY}` }, signal: AbortSignal.timeout(3000) });
    if (response.status !== 204) throw new Error("External fixture refused shutdown");
  } catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; }
  await unlink(flag("state"));
  if (flag("shell-env") && existsSync(flag("shell-env"))) await unlink(flag("shell-env"));
}

/** The running engine's address and key, read from its own data folder the way `branch` does. */
async function engine(data) {
  const note = JSON.parse(await readFile(join(data, "running.json"), "utf8"));
  const token = (await readFile(join(data, "session-token"), "utf8")).trim();
  return async (method, path, body) => {
    const response = await fetch(`${note.url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}
async function waitForEngine(data, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    try { const call = await engine(data); const health = await call("GET", "/api/health"); return { call, health }; } catch { await delay(1000); }
  }
  fail(`nothing answered from ${data} within ${seconds}s`);
}

async function launch() {
  const exe = flag("exe"), port = flag("port", "9391");
  if (!exe || !existsSync(exe)) fail(`no program at ${exe}`);
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  say(`started ${exe} (pid ${child.pid}) with its DevTools port on ${port}`);
  const page = await window(port);
  await page.getByText("Connected", { exact: true }).first().waitFor({ timeout: 120000 }).catch(() => undefined);
  say(`window answers: ${await page.title()}`);
  process.exit(0);
}

async function window(port) {
  const { chromium } = await import("playwright-core");
  for (let i = 0; i < 90; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser.contexts()[0]?.pages().find((p) => /127\.0\.0\.1/.test(p.url()));
      if (page) { page.setDefaultTimeout(30000); return page; }
      await browser.close();
    } catch { /* not up yet */ }
    await delay(1000);
  }
  fail(`the window never opened its DevTools port ${port}`);
}

/** A conversation, a changed setting, a memory and a schedule, each read back as the app keeps it. */
async function plant() {
  const data = flag("data"), out = flag("out", "planted.json");
  const { call } = await waitForEngine(data);
  const note = JSON.parse(await readFile(join(data, "running.json"), "utf8"));
  const stamp = Date.now().toString(36);
  const run = await call("POST", "/api/run", { prompt: `Real update test ${stamp}: remember the word juniper.` });
  const sessionId = run.sessionId ?? run.session?.id ?? run.run?.sessionId;
  if (!sessionId) fail(`the conversation came back without a session id: ${JSON.stringify(run).slice(0, 300)}`);
  const preferences = await call("POST", "/api/preferences", { appearance: "daylight", accent: "slate", textSize: "large", density: "compact" });
  const memory = await call("POST", "/api/action", { tool: "memory.put", args: { text: `The real update test fact ${stamp}: the owner's test plant is a juniper.`, source: "real-update-test" } });
  const schedule = await call("POST", "/api/schedules", { prompt: `Real update test reminder ${stamp}`, dueAt: "2031-01-01T09:00:00.000Z", kind: "reminder" });
  const planted = {
    stamp, version: note.version ?? null, sessionId,
    conversation: await call("GET", `/api/sessions/${sessionId}/export`),
    preferences, memoryId: memory?.id ?? memory?.result?.id ?? null, memoryText: `The real update test fact ${stamp}: the owner's test plant is a juniper.`,
    scheduleId: schedule?.id ?? schedule?.schedule?.id ?? null,
  };
  await writeFile(out, JSON.stringify(planted, null, 2));
  say(`planted conversation ${sessionId}, preferences, memory ${planted.memoryId}, schedule ${planted.scheduleId} -> ${out}`);
}

/** Only what a person would see as "the same": words, choices and times, not bookkeeping fields. */
const messages = (exported) => JSON.stringify((exported?.messages ?? exported?.session?.messages ?? exported?.entries ?? exported)
  , (key, value) => (["updatedAt", "revision", "readAt", "lastOpenedAt"].includes(key) ? undefined : value));

const parsed = (value) => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } };

async function verify() {
  const data = flag("data"), expect = flag("expect");
  const planted = JSON.parse(await readFile(flag("planted", "planted.json"), "utf8"));
  const { call } = await waitForEngine(data, Number(flag("wait", "180")));
  const problems = [];
  const note = JSON.parse(await readFile(join(data, "running.json"), "utf8"));
  const version = note.version ?? null;
  say(`the engine answers as version ${version} (pid ${note.pid})`);
  if (expect && version !== expect) problems.push(`version is ${version}, expected ${expect}`);
  const conversation = await call("GET", `/api/sessions/${planted.sessionId}/export`).catch((error) => ({ error: error.message }));
  if (conversation.error) problems.push(`conversation: ${conversation.error}`);
  else if (messages(conversation) !== messages(planted.conversation)) problems.push("conversation: the messages differ from before the update");
  const backup = await call("GET", "/api/backup");
  // The backup is every table as rows; the records Branch keeps hold their fields as JSON text.
  const records = Object.entries(backup.tables ?? {}).flatMap(([kind, rows]) => (Array.isArray(rows) ? rows : [])
    .map((row) => ({ ...row, kind, data: parsed(row.data) })));
  const find = (kind, id) => records.find((r) => r.kind === kind && r.id === id);
  const preferences = find("settings", "preferences");
  const want = planted.preferences;
  if (!preferences) problems.push("setting: the changed preferences are gone");
  else for (const key of Object.keys(want)) if (preferences.data?.[key] !== want[key]) problems.push(`setting ${key}: ${preferences.data?.[key]} instead of ${want[key]}`);
  const memory = records.find((r) => r.kind === "memory" && r.data?.text === planted.memoryText);
  if (!memory) problems.push("memory: the saved fact is gone");
  const schedule = planted.scheduleId ? find("schedules", planted.scheduleId) : records.find((r) => r.kind === "schedules" && String(r.data?.prompt).includes(planted.stamp));
  if (!schedule) problems.push("schedule: the reminder is gone");
  else if (schedule.data?.dueAt !== "2031-01-01T09:00:00.000Z") problems.push(`schedule: due ${schedule.data?.dueAt} instead of 2031-01-01T09:00:00.000Z`);
  if (!records.length) problems.push(`backup: no records came back (keys ${Object.keys(backup).join(",")})`);
  if (backup.appVersion && backup.appVersion !== version) problems.push(`the backup says ${backup.appVersion}, running.json says ${version}`);
  if (problems.length) { for (const p of problems) console.log(`  - ${p}`); fail(`${problems.length} thing(s) did not survive`); }
  say(`PASS: version ${version}; the conversation, the setting, the memory and the schedule are all unchanged`);
}

async function quit() {
  const data = flag("data");
  const note = JSON.parse(await readFile(join(data, "running.json"), "utf8"));
  const pids = [note.pid].filter(Boolean);
  say(`closing the app (pid ${pids.join(",")})`);
  for (const pid of pids) try { process.kill(pid, windows ? undefined : "SIGTERM"); } catch { /* already gone */ }
}

/** The one thing that goes wrong, done to the real app while its own update runs. */
function faultWatcher(kind, scratch, dropCmd) {
  if (!kind) return () => undefined;
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    const archive = windows ? "Branch-Agent-windows-x64.zip" : "Branch-Agent-linux-x64.tar.gz";
    const path = join(scratch, archive);
    const size = existsSync(path) ? statSync(path).size : 0;
    if (kind === "corrupt" && size > 20_000_000) {
      // A few bytes early in the file change after they arrived, as a bad disk or a meddling proxy would.
      const fd = openSync(path, "r+"); writeSync(fd, Buffer.from("not what was published"), 0, 22, 1_000_000); closeSync(fd);
      done = true; say(`FAULT: changed 22 bytes of the half-downloaded file at 1 MB (${size} bytes so far)`);
    }
    if (kind === "drop" && size > 50_000_000) {
      done = true; say(`FAULT: cutting the download connection at ${size} bytes: ${dropCmd}`);
      try { console.log(execSync(dropCmd, { encoding: "utf8" })); } catch (error) { console.log(`drop command: ${error.message}`); }
    }
    if (kind === "kill-switch") {
      const log = join(scratch, "apply-update.log");
      const text = existsSync(log) ? readFileSync(log, "utf8") : "";
      if (/copying new version/.test(text)) {
        done = true; say("FAULT: the switch-over has started copying files; ending it now, hard");
        try {
          // Only what this update started: its script and the copy it is running, found by the test's own temp folder.
          if (windows) execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${scratch}*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`);
          else execSync(`pkill -KILL -f apply-update.sh; pkill -KILL -f 'cp -Rp ${scratch}'`);
        } catch (error) { console.log(`kill: ${error.message}`); }
      }
    }
  }, windows && kind === "kill-switch" ? 50 : 200);
  return () => clearInterval(timer);
}

/**
 * Windows, harness only. The app starts its hand-over through the Task Scheduler, so the new version
 * is opened with the signed-in person's own environment, not the test's, and would open that person's
 * real Branch data. Before the hand-over gets that far, the lines that start the app are given the
 * test's BRANCH_DESKTOP_HOME and TEMP back. Nothing else in the script is touched; the file is written
 * over in place (never truncated) because cmd.exe is already reading it.
 */
function keepRelaunchIsolated(scratch) {
  if (!windows) return () => undefined;
  const script = join(scratch, "apply-update.cmd");
  const names = ["BRANCH_DESKTOP_HOME", "BRANCH_PROVIDER", "BRANCH_ENDPOINT", "BRANCH_MODEL", "BRANCH_API_KEY", "TEMP", "TMP"].filter((name) => process.env[name]);
  const timer = setInterval(() => {
    if (!existsSync(script)) return;
    const text = readFileSync(script, "utf8");
    if (!/start "" "/.test(text) || text.includes("rem real-update-test")) return;
    const sets = names.map((name) => `set "${name}=${process.env[name]}"`).join(" & ");
    const patched = Buffer.from(`${text.replace(/start "" "/g, `${sets} & start "" "`)}rem real-update-test\r\n`, "utf8");
    const fd = openSync(script, "r+"); writeSync(fd, patched, 0, patched.length, 0); closeSync(fd);
    clearInterval(timer); say(`harness: the hand-over's relaunch keeps ${names.join(", ")}`);
  }, 20);
  return () => clearInterval(timer);
}

async function update() {
  const port = flag("port", "9391"), scratch = flag("scratch"), fault = flag("fault"), dropCmd = flag("drop-cmd", "");
  if (!scratch) fail("--scratch is the app's temp folder plus branch-agent-update");
  const page = await window(port);
  // The person's way in: the workspace menu at the foot of the side rail, then "Check for updates",
  // which opens Settings at About; the Check for updates button there is the one the app wires up.
  await page.keyboard.press("Escape");
  await page.locator("#owner-menu-button").click();
  await page.locator("#menu-updates").click();
  await page.locator("#updates-check").click();
  await page.locator("#updates-status").filter({ hasText: /ready to install|newest version|did not|could not|failed/i }).waitFor({ timeout: 60000 });
  say(`after Check for updates: ${await page.locator("#updates-status").innerText()}`);
  if (!(await page.locator("#updates-install").isVisible())) {
    await page.screenshot({ path: "no-update-button.png" }).catch(() => undefined);
    fail("the Update and restart button did not appear");
  }
  const stopFault = faultWatcher(fault, scratch, dropCmd);
  const stopPatch = keepRelaunchIsolated(scratch);
  const started = Date.now();
  await page.locator("#updates-install").click();
  say("pressed Update and restart");
  let last = "";
  while (Date.now() - started < 15 * 60 * 1000) {
    let seen = "";
    try {
      const screen = await page.locator("#update-screen").isVisible({ timeout: 2000 });
      seen = screen
        ? `screen: ${await page.locator("#update-stage").innerText({ timeout: 2000 })} | ${await page.locator("#update-detail").innerText({ timeout: 2000 }).catch(() => "")}`
        : `settings: ${await page.locator("#updates-status").innerText({ timeout: 2000 })}`;
    } catch { break; }
    if (seen !== last) { say(`[${Math.round((Date.now() - started) / 1000)}s] ${seen}`); last = seen; }
    if (!/screen/.test(seen) && /did not|could not|failed|stopped|error|terminated|fetch/i.test(seen) && Date.now() - started > 3000) {
      stopFault(); stopPatch(); say(`the app stopped the update and stayed open: ${seen}`); process.exit(0);
    }
    await delay(500);
  }
  say(`the window closed after ${Math.round((Date.now() - started) / 1000)}s; the hand-over script takes it from here`);
  // The hand-over is still to come: keep watching long enough for it (and for a fault aimed at it).
  for (let i = 0; i < 600; i++) await delay(100);
  stopFault(); stopPatch();
  process.exit(0);
}

const commands = { launch, plant, update, verify, quit, fixture, "fixture-start": startFixture, "fixture-stop": stopFixture };
if (!commands[command]) fail(`usage: node real-update-test.mjs ${Object.keys(commands).join("|")} ...`);
await commands[command]();
