/* Versioned app folders, for real (src/desktop/app-folders.ts, shell-switch.ts, shell-window.ts): an install laid out as
   <root>/app-<version>/ with Electron's own stock program (hard links to it where the drive allows, never a program made
   here), running hidden on a folder of its own with the detached gateway on. Two consecutive updates switch the shell
   while a task is working and a gateway client keeps asking; a third, broken one is caught by the switch script and
   the version before comes back by itself and says why.

   Isolated: its own APPDATA, LOCALAPPDATA, USERPROFILE, TEMP and data folder, dynamic ports, hidden windows (the tray,
   never shown), no scheduler (the switch script is started the way the hand-over's own fallback starts it), and every
   process it started is ended by its id or by a program path inside its own temporary folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, openSync } from "node:fs";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isJunk } from "junk";
import { discardTemp } from "./temp-dir.mjs";
import { scriptedModel } from "./fixtures/hot-model.mjs";
import { assembleApp } from "../scripts/assemble-app.mjs";
import { includedInApp } from "../scripts/package-desktop.mjs";
import { linkOrCopy, pointerFiles, readPointer, writePointer } from "../dist/desktop/app-folders.js";
import { shellUpMarker, windowsSwitchScript, failureName } from "../dist/desktop/shell-switch.js";
import { hiddenLauncher } from "../dist/desktop/hand-over.js";
import { proveOnce, sessionKey } from "../dist/engine-proof.js";

const exe = "Branch Agent.exe";
/** Each step, outside the test's own folder, so a run that fails or hangs still says how far it got. */
const progressFile = join(tmpdir(), "branch-versioned-progress.log");
const progress = (line) => { try { appendFileSync(progressFile, `[${new Date().toISOString()}] ${line}
`); } catch { /* best effort */ } };
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, check, ms = 120_000, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(every);
  }
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function files(dir, root = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await files(path, root, out); else out.push(relative(root, path));
  }
  return out;
}

/** Electron's own stock folder: the one a build machine's install put in place, or the one named for this computer. */
function stockDist() {
  if (process.env.BRANCH_TEST_ELECTRON) return dirname(process.env.BRANCH_TEST_ELECTRON);
  return process.env.CI ? join(repoRoot, "node_modules", "electron", "dist") : null;
}

/** One version's folder: the stock runtime (links where possible), and the app with its own version. */
async function versionFolder(root, version, { from = null, dist, broken = false }) {
  const folder = join(root, `app-${version}`);
  for (const name of await files(from ?? dist)) {
    if (from ? name.startsWith(`resources${sep}`) : name.startsWith(`resources${sep}default_app`)) continue;
    await linkOrCopy(join(from ?? dist, name), join(folder, name === "electron.exe" ? exe : name));
  }
  const app = join(folder, "resources", "app");
  if (from) {
    // The app's files shared with the version it came from, as a real build's unchanged files would be.
    for (const name of await files(join(from, "resources", "app"))) if (name !== "package.json") await linkOrCopy(join(from, "resources", "app", name), join(app, name));
  } else await assembleApp({ source: repoRoot, into: app, included: includedInApp, isJunk });
  const manifest = JSON.parse(await readFile(join(from ?? repoRoot, from ? "resources/app/package.json" : "package.json"), "utf8"));
  await writeFile(join(app, "package.json"), JSON.stringify({ ...manifest, version }, null, 2));
  if (broken) {
    // A version whose shell never gets as far as a window.
    await rm(join(app, "dist", "desktop", "main.js"));
    await writeFile(join(app, "dist", "desktop", "main.js"), "process.exit(3);\n");
  }
  return folder;
}

/** The main process of a shell, through the Node inspector this run gave it (NODE_OPTIONS, a port of its own). */
async function inspector(port) {
  const list = await until(`the inspector on ${port}`, async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json(), 60_000);
  const socket = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0; const waiting = new Map();
  socket.onmessage = (event) => { const message = JSON.parse(event.data); waiting.get(message.id)?.(message); waiting.delete(message.id); };
  const evaluate = (expression) => new Promise((done, fail) => {
    const at = ++id;
    waiting.set(at, (message) => {
      const details = message.result?.exceptionDetails;
      if (message.error || details) fail(new Error(message.error?.message ?? details.exception?.description ?? details.text)); else done(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: at, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
  });
  return { evaluate, close: () => socket.close() };
}
/** What a shell's main process says on its console, into the progress file, from the moment its inspector answers. */
async function listen(port, tag) {
  const list = await until(`the inspector on ${port}`, async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json(), 180_000, 100).catch(() => null);
  if (!list) { progress(`${tag}: no inspector answered`); return; }
  const socket = new WebSocket(list[0].webSocketDebuggerUrl);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled") progress(`${tag} console.${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 600)}`);
    if (message.method === "Runtime.exceptionThrown") progress(`${tag} exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
  };
  socket.onopen = () => { progress(`${tag}: inspector connected`); socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" })); };
  socket.onclose = () => progress(`${tag}: inspector closed`);
}
/** Runs `code` in the shell's page (its own window, the one opened on the engine with ?desktop=1). */
const inPage = (shell, code) => shell.evaluate(`(async () => {
  const { BrowserWindow } = require("electron");
  const window = BrowserWindow.getAllWindows().find((one) => !one.isDestroyed() && one.webContents.getURL().includes("desktop=1"));
  return window ? await window.webContents.executeJavaScript(${JSON.stringify(`(async () => { ${code} })()`)}, true) : undefined;
})()`);
const connected = (shell) => until("the window to connect", () => inPage(shell, `
  const machines = document.querySelector('#statusbar [data-act="machines"]');
  return !!document.querySelector('#statusbar [data-act="updmenu"]') && /^Connected/.test(machines?.textContent ?? "");`), 180_000, 500);

test("two updates switch the shell to new app folders with the gateway, a working task and the draft carried through; a broken third goes back by itself", {
  skip: process.platform !== "win32" ? "versioned app folders are Windows-only" : !stockDist() ? "set BRANCH_TEST_ELECTRON to an existing stock electron.exe" : false,
  timeout: 900_000,
}, async (t) => {
  const dist = stockDist(), stockHash = await sha256(join(dist, "electron.exe"));
  const home = await mkdtemp(join(tmpdir(), "branch-versioned-"));
  const root = join(home, "Programs", "Branch Agent"), userData = join(home, "Roaming", "Branch Agent"), dataDir = join(userData, "state");
  const temp = join(home, "Temp"), scratch = join(temp, "branch-agent-update");
  for (const dir of [root, dataDir, temp, join(home, "Local"), join(home, "User")]) await mkdir(dir, { recursive: true });
  await writeFile(join(dataDir, "gateway.json"), JSON.stringify({ mode: "on" }));
  await writeFile(join(userData, "window-state.json"), JSON.stringify({ maximized: false }));
  const model = await scriptedModel(t, [{ text: "Hello there." }, { text: "The answer that crossed two updates.", held: true }]);
  const started = new Set(), shells = [];
  const env = (port) => ({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, APPDATA: join(home, "Roaming"), LOCALAPPDATA: join(home, "Local"),
    USERPROFILE: join(home, "User"), TEMP: temp, TMP: temp, BRANCH_DESKTOP_HOME: userData, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: join(home, "workspace"),
    BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: model.endpoint, BRANCH_MODEL: "m", BRANCH_API_KEY: "test-key" });
  // A packaged app takes its inspector only on its command line (NODE_OPTIONS is refused), so the switch script is given it.
  const inspect = (port) => `--inspect=127.0.0.1:${port}`;
  t.after(async () => {
    for (const shell of shells) shell.close();
    const note = await readFile(join(dataDir, "running.json"), "utf8").then(JSON.parse, () => null);
    const token = await readFile(join(dataDir, "session-token"), "utf8").then((text) => text.trim(), () => null);
    const boot = note && token ? await proveOnce(note.url, token, 5000).catch(() => null) : null;
    if (boot) await fetch(`${note.url}/api/deployment/quit`, { method: "POST", headers: { authorization: `Bearer ${sessionKey(token, boot)}` }, signal: AbortSignal.timeout(15000) }).catch(() => undefined);
    // Only what this test started (by id), then its switch scripts (their command line names its folder) and anything
    // still running from inside its own temporary folder (by path). Scripts too: none may outlive its folder.
    for (const pid of started) { try { process.kill(pid); } catch { /* gone */ } }
    await new Promise((done) => spawn(`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.CommandLine -and $_.CommandLine.Contains($env:BRANCH_TEST_HOME)) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:BRANCH_TEST_HOME, [StringComparison]::OrdinalIgnoreCase))) } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }"],
    { env: { ...process.env, BRANCH_TEST_HOME: home }, windowsHide: true, stdio: "ignore" }).once("exit", done));
    progress("cleaned up");
    await wait(1000);
    await discardTemp(home, { tries: 40, pause: 250 });
  });

  progress(`start ${home}`);
  try { await body(); } catch (error) {
    progress(`FAILED: ${error.stack}`);
    progress(`switch log:
${await readFile(join(scratch, "apply-update.log"), "utf8").catch(() => "(none)")}`);
    progress(`scratch: ${(await readdir(scratch).catch(() => [])).join(", ")}`);
    throw error;
  }
  async function body() {
  const versions = ["0.99.1", "0.99.2", "0.99.3", "0.99.4"];
  const a = await versionFolder(root, versions[0], { dist });
  const b = await versionFolder(root, versions[1], { from: a, dist });
  const c = await versionFolder(root, versions[2], { from: b, dist });
  const d = await versionFolder(root, versions[3], { from: c, dist, broken: true });
  await writePointer(root, { folder: `app-${versions[0]}`, version: versions[0], previous: null, at: new Date().toISOString() });

  // The first version, started as the tray start does: hidden, never shown.
  // Its own output goes to a file in the test's folder, for a failure to show.
  const output = openSync(join(home, "first-shell.log"), "a");
  const first = spawn(join(a, exe), ["--start-minimized", inspect(9401)], { env: env(9401), detached: true, stdio: ["ignore", output, output], windowsHide: true });
  t.after(() => { try { closeSync(output); } catch { /* closed */ } });
  started.add(first.pid); first.unref();
  let shell = await inspector(9401).catch(async (error) => { throw new Error(`${error.message}
${await readFile(join(home, "first-shell.log"), "utf8").catch(() => "")}`); });
  shells.push(shell);
  await connected(shell);
  await inPage(shell, `for (const [path, body] of [["/api/onboarding", { done: true }], ["/api/conversation-mode/settings", { newConversation: "follow", confirmLoosening: true }]])
    await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); location.reload();`).catch(() => undefined);
  await connected(shell);
  progress("first shell onboarded");
  const running = JSON.parse(await readFile(join(dataDir, "running.json"), "utf8"));
  const gateway = (await (await fetch(`${running.url}/gateway/health`)).json()).gateway.pid;

  // A client of the gateway that keeps asking all the way through (as a chat app's connection would): none may fail.
  let asked = 0, failed = 0, asking = true;
  const client = (async () => { while (asking) { try { const r = await fetch(`${running.url}/gateway/health`, { signal: AbortSignal.timeout(5000) }); if (r.ok) asked++; else failed++; } catch { failed++; } await wait(200); } })();
  // A conversation, then a task at work in it in the gateway's engine: its answer is held by the model until both shells
  // have switched. (A first message waits for its conversation to be confirmed before any window hands over, so the
  // held one is the second: the conversation already exists, as the owner's usually does.)
  const say = (words) => inPage(shell, `const box = document.getElementById("prompt"); box.value = ${JSON.stringify(words)}; box.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("send").click();`);
  await say("Hello");
  await until("the first answer", () => inPage(shell, `return (await (await fetch("/api/state")).json()).runs.some((run) => run.prompt === "Hello" && run.status === "completed");`));
  await until("the conversation in the window", () => inPage(shell, `return !!document.querySelector("#prompt") && !document.getElementById("send")?.disabled;`));
  await say("Work through two updates");
  await model.until(2);

  const switchTo = async (from, fromFolder, to, toFolder, port, { upSeconds = 90 } = {}) => {
    const draft = `a draft typed in ${from}`;
    await inPage(shell, `const box = document.getElementById("prompt"); box.value = ${JSON.stringify(draft)}; box.dispatchEvent(new Event("input", { bubbles: true }));
      box.setSelectionRange(2, 7);`);
    // What main does at the switch (shell-window.ts handOverHook): the window is in the tray, so the moment is now.
    const pid = await shell.evaluate("process.pid");
    await shell.evaluate(`(async () => {
      const { BrowserWindow, powerMonitor, app } = require("electron");
      // The app's own module (require of an ES module: the inspector has no dynamic import).
      const hook = require(require("node:path").join(process.resourcesPath, "app", "dist", "desktop", "shell-window.js")).handOverHook;
      const window = BrowserWindow.getAllWindows().find((one) => one.webContents.getURL().includes("desktop=1"));
      return hook({ window, userData: app.getPath("userData"), power: powerMonitor })({ version: ${JSON.stringify(to)}, stillWanted: () => true });
    })()`);
    // What the updater writes (updater.ts writeSwitchScript), and the hidden start the hand-over falls back to.
    const pointers = await pointerFiles(root, { folder: fromFolder, version: from }, { folder: toFolder, version: to });
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, `${failureName}.draft`), JSON.stringify({ kept: from, tried: to, commit: null, at: new Date().toISOString(), message: `Version ${to} did not open its window, so Branch went back to ${from} by itself.` }));
    const script = join(scratch, `switch-${to}.cmd`);
    await writeFile(script, windowsSwitchScript({ root, next: pointers.next, rollback: pointers.rollback, newExe: join(root, toFolder, exe), oldExe: join(root, fromFolder, exe),
      marker: shellUpMarker(scratch, to), failureDraft: join(scratch, `${failureName}.draft`), failure: join(scratch, failureName), log: join(scratch, "apply-update.log"),
      minimized: true, upSeconds, args: [inspect(port)] }));
    await writeFile(`${script}.launch.vbs`, hiddenLauncher(script, pid));
    spawn(`${process.env.SystemRoot}\\System32\\wscript.exe`, ["//B", "//Nologo", `${script}.launch.vbs`], { env: env(port), detached: true, stdio: "ignore", windowsHide: true }).unref();
    started.add(pid);
    void listen(port, `shell ${to}`);
    await shell.evaluate(`require("electron").app.quit()`).catch(() => undefined);
    shell.close();
    return draft;
  };

  progress("update 1");
  // ---- update 1: 0.99.1 -> 0.99.2 ----
  let draft = await switchTo(versions[0], `app-${versions[0]}`, versions[1], `app-${versions[1]}`, 9402);
  let up = JSON.parse(await until("0.99.2's window", () => readFile(shellUpMarker(scratch, versions[1]), "utf8"), 180_000, 500));
  started.add(up.pid);
  assert.equal(up.restored, true, "the new window put back what the old one had open before saying it was up");
  shell = await inspector(9402); shells.push(shell);
  assert.equal(await shell.evaluate("require('electron').app.getVersion()"), versions[1]);
  assert.equal(await shell.evaluate("process.execPath"), join(b, exe), "it runs from its own folder");
  // The typed words come back whole. (The caret is put back too, but the page's later redraw of the composer, once the
  // engine answers, puts it at the end: the switch only happens out of sight, so that is where the owner finds it.)
  const kept1 = await until("the draft", () => inPage(shell, `const box = document.getElementById("prompt");
    return box?.value ? [box.value, box.selectionStart, box.selectionEnd] : null;`));
  assert.equal(kept1[0], draft);
  progress(`draft back: ${JSON.stringify(kept1)}`);
  assert.equal((await readPointer(root))?.folder, `app-${versions[1]}`);

  progress("update 2");
  // ---- update 2: 0.99.2 -> 0.99.3, the task still held ----
  draft = await switchTo(versions[1], `app-${versions[1]}`, versions[2], `app-${versions[2]}`, 9403);
  up = JSON.parse(await until("0.99.3's window", () => readFile(shellUpMarker(scratch, versions[2]), "utf8"), 180_000, 500));
  started.add(up.pid);
  assert.equal(up.restored, true);
  shell = await inspector(9403); shells.push(shell);
  // The typed words come back whole. (The caret is put back too, but the page's later redraw of the composer, once the
  // engine answers, puts it at the end: the switch only happens out of sight, so that is where the owner finds it.)
  const kept2 = await until("the draft", () => inPage(shell, `const box = document.getElementById("prompt");
    return box?.value ? [box.value, box.selectionStart, box.selectionEnd] : null;`));
  assert.equal(kept2[0], draft);
  progress(`draft back: ${JSON.stringify(kept2)}`);
  const previous = (await readPointer(root))?.previous;
  assert.deepEqual(previous, { folder: `app-${versions[1]}`, version: versions[1] }, "the version before is kept for going back");

  progress("releasing the task");
  // The task that worked through both switches finishes once, in the gateway's own engine.
  model.release(1);
  const runs = await until("the task to finish", async () => {
    const found = await inPage(shell, `return (await (await fetch("/api/state")).json()).runs.filter((run) => run.prompt === "Work through two updates").map((run) => run.status);`);
    return found?.[0] === "completed" ? found : null;
  });
  assert.deepEqual(runs, ["completed"]);
  assert.equal(model.asked.length, 2, "the model was asked once per message: nothing was dropped or asked again");
  assert.equal((await (await fetch(`${running.url}/gateway/health`)).json()).gateway.pid, gateway, "the same gateway process all the way through");
  asking = false; await client;
  assert.ok(asked > 20, `the gateway client kept asking (${asked})`);
  assert.equal(failed, 0, "no request to the gateway failed during either switch");

  progress("update 3");
  // ---- update 3: a broken 0.99.4 never opens its window; 0.99.3 comes back by itself and says why ----
  await switchTo(versions[2], `app-${versions[2]}`, versions[3], `app-${versions[3]}`, 9404, { upSeconds: 30 });
  await until("0.99.3 back", async () => {
    const log = await readFile(join(scratch, "apply-update.log"), "utf8");
    return /the version there was is back; starting it/.test(log);
  }, 180_000, 500);
  shell = await inspector(9404); shells.push(shell);
  assert.equal(await shell.evaluate("require('electron').app.getVersion()"), versions[2]);
  assert.equal((await readPointer(root))?.folder, `app-${versions[2]}`, "the pointer went back");
  const status = await until("the failure to be said", () => inPage(shell, `const status = await window.branchDesktop.updateStatus(); return status.phase === "error" ? status : null;`));
  assert.match(status.message, /0\.99\.4 did not open its window, so Branch went back to 0\.99\.3/);
  assert.equal((await (await fetch(`${running.url}/gateway/health`)).json()).gateway.pid, gateway, "the gateway kept running through the failed one too");

  progress("checking programs");
  // ---- no program was made: every program in the install is Electron's own stock file ----
  const programs = (await files(root)).filter((name) => /\.exe$/i.test(name));
  assert.equal(programs.length, versions.length, programs.join(", "));
  for (const name of programs) assert.equal(await sha256(join(root, name)), stockHash, `${name} is byte for byte Electron's own`);
  const stock = await stat(join(dist, "electron.exe"));
  const linked = (await Promise.all(programs.map((name) => stat(join(root, name))))).every((one) => one.ino === stock.ino);
  const summary = JSON.stringify({ programs: programs.length, sameFileAsStock: linked, gatewayPid: gateway, gatewayRequests: asked, gatewayFailures: failed });
  progress(`PASSED ${summary}`);
  console.log("versioned proof", summary);
  }
});
