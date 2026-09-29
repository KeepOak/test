/* An isolated install laid out as versioned app folders (src/desktop/app-folders.ts), and the ways a test reaches the
   shells running from it: Electron's own stock folder, linked (never a program made), each version's app, the Node
   inspector a packaged app takes on its command line, and a progress file outside the test's own folder. */
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isJunk } from "junk";
import { assembleApp } from "../../scripts/assemble-app.mjs";
import { includedInApp } from "../../scripts/package-desktop.mjs";
import { linkOrCopy } from "../../dist/desktop/app-folders.js";

export const exe = "Branch Agent.exe";
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Each step, outside the test's own folder, so a run that fails or hangs still says how far it got. */
export const progressFile = join(tmpdir(), "branch-versioned-progress.log");
export const progress = (line) => { try { appendFileSync(progressFile, `[${new Date().toISOString()}] ${line}\n`); } catch { /* best effort */ } };
export const wait = (ms) => new Promise((done) => setTimeout(done, ms));
export async function until(what, check, ms = 120_000, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(every);
  }
}
export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function files(dir, root = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await files(path, root, out); else out.push(relative(root, path));
  }
  return out;
}

/** Electron's own stock folder: the one a build machine's install put in place, or the one named for this computer. */
export function stockDist() {
  if (process.env.BRANCH_TEST_ELECTRON) return dirname(process.env.BRANCH_TEST_ELECTRON);
  return process.env.CI ? join(repoRoot, "node_modules", "electron", "dist") : null;
}

/** One version's folder: the stock runtime (links where possible), and the app with its own version. */
export async function versionFolder(root, version, { from = null, dist, broken = false }) {
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

/** The main process of a shell, through the Node inspector this run gave it (on its command line). */
export async function inspector(port) {
  const list = await until(`the inspector on ${port}`, async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json(), 60_000);
  const socket = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0; const waiting = new Map();
  socket.onmessage = (event) => { const message = JSON.parse(event.data); waiting.get(message.id)?.(message); waiting.delete(message.id); };
  // A shell that ends answers nothing more: whatever was asked fails at once instead of waiting for ever.
  socket.onclose = () => { for (const answer of waiting.values()) answer({ error: { message: "the shell ended" } }); waiting.clear(); };
  const evaluate = (expression) => new Promise((done, fail) => {
    const at = ++id;
    waiting.set(at, (message) => {
      const details = message.result?.exceptionDetails;
      if (message.error || details) fail(new Error(message.error?.message ?? details.exception?.description ?? details.text)); else done(message.result.result.value);
    });
    if (socket.readyState !== WebSocket.OPEN) { waiting.delete(at); fail(new Error("the shell ended")); return; }
    socket.send(JSON.stringify({ id: at, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
  });
  return { evaluate, close: () => socket.close() };
}

/**
 * What a shell's main process says on its console, into the progress file, from the moment its inspector answers.
 * Answers a close: a program started with an inspector waits, as it ends, for every inspector to let go of it.
 */
export function listen(port, tag) {
  let socket = null, closed = false;
  void follow();
  return { close: () => { closed = true; socket?.close(); } };
  async function follow() {
  const list = await until(`the inspector on ${port}`, async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json(), 180_000, 100).catch(() => null);
  if (!list || closed) { if (!list) progress(`${tag}: no inspector answered`); return; }
  socket = new WebSocket(list[0].webSocketDebuggerUrl);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled") progress(`${tag} console.${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 600)}`);
    if (message.method === "Runtime.exceptionThrown") progress(`${tag} exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
  };
  socket.onopen = () => { progress(`${tag}: inspector connected`); socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" })); };
  socket.onclose = () => progress(`${tag}: inspector closed`);
  }
}

/** Runs `code` in the shell's page (its own window, the one opened on the engine with ?desktop=1). */
export const inPage = (shell, code) => shell.evaluate(`(async () => {
  const { BrowserWindow } = require("electron");
  const window = BrowserWindow.getAllWindows().find((one) => !one.isDestroyed() && one.webContents.getURL().includes("desktop=1"));
  return window ? await window.webContents.executeJavaScript(${JSON.stringify(`(async () => { ${code} })()`)}, true) : undefined;
})()`);
export const connected = async (shell) => {
  let looks = 0;
  return until("the window to connect", async () => {
    // Every half minute, what the window shows instead, so a wait that never ends says why.
    if (++looks % 60 === 0) progress(`waiting to connect; the window shows: ${await inPage(shell, `return JSON.stringify({ href: location.href, ready: document.readyState, body: (document.body?.innerText ?? "").slice(0, 400), ob: !!document.querySelector(".ob9"), errors: window.__chaosErrors ?? null, desktop: typeof window.branchDesktop, state: await fetch("/api/state").then(async (r) => r.status + " " + (await r.text()).slice(0, 200), (e) => "fetch failed: " + e.message), health: await fetch("/gateway/health").then(async (r) => r.status + " " + (await r.text()).slice(0, 300), (e) => "fetch failed: " + e.message) });`).catch((error) => error.message)}`);
    return inPage(shell, `
  const machines = document.querySelector('#statusbar [data-act="machines"]');
  return !!document.querySelector('#statusbar [data-act="updmenu"]') && /^Connected/.test(machines?.textContent ?? "");`);
  }, 180_000, 500);
};

/**
 * A tray start keeps the window unpainted until it is first shown (main.ts paintWhenInitiallyHidden), so its page draws
 * nothing. To read and type in it without ever showing it, the page is told it is in use, the way Playwright's desktop
 * tests are (CDP page lifecycle and focus emulation). Only for reading: a switch's "up" is proved before this is done.
 */
export const drawn = (shell) => shell.evaluate(`(async () => {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 150 && !BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("desktop=1")); i++) await new Promise((r) => setTimeout(r, 200));
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("desktop=1"));
  if (!win) throw new Error("no window");
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await dbg.sendCommand("Page.enable");
  await dbg.sendCommand("Page.setWebLifecycleState", { state: "active" });
  return win.isVisible();
})()`);
