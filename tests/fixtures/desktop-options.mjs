import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `hidden`: the window never shows on the screen of the computer running the tests (an owner's working desktop must
 * not see windows flash or change colour). It opens un-maximised (maximising would show it) and the way autostart
 * opens it, in the tray (--start-minimized); its page still draws, so it can be read and photographed. Hidden unless
 * the run is a build machine's (CI), where a case that needs a window on the screen may ask for one.
 */
export async function desktopOptions({ hidden = !process.env.CI, gateway = false } = {}) {
  const base =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA, "Temp", "Codex-session-files")
      : tmpdir();
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, "branch-agent-desktop-"));
  // Ordinary desktop cases own one EngineHost; gateway cases explicitly own and clean their detached broker.
  await mkdir(join(home, "state"));
  await writeFile(join(home, "state", "gateway.json"), JSON.stringify({ mode: gateway ? "on" : "off" }));
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const env = Object.fromEntries(
    [
      "PATH",
      "SystemRoot",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "HOME",
      "DISPLAY",
      "XAUTHORITY",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  const launch = process.env.BRANCH_PACKAGED_EXECUTABLE
    ? { executablePath: process.env.BRANCH_PACKAGED_EXECUTABLE, args: [] }
    : { args: [root] };
  if (hidden) {
    await writeFile(join(home, "window-state.json"), JSON.stringify({ maximized: false }));
    launch.args.push("--start-minimized");
  }
  return {
    home,
    hidden,
    options: {
      ...launch,
      timeout: 120000,
      chromiumSandbox: true,
      env: {
        ...env,
        BRANCH_PROVIDER: "demo",
        BRANCH_DESKTOP_HOME: home,
        BRANCH_DATA_DIR: join(home, "state"),
        BRANCH_WORKSPACE: join(home, "workspace"),
      },
    },
  };
}


/**
 * Waits for the window to say it is connected. Starting the whole app (its database, its server and
 * the page) is quick on a desktop, but a shared Windows build machine running two other test files
 * at once has taken well over thirty seconds for the same thing, so the allowance is for that.
 */
export const STARTUP_MS = 120000;
/* Redesign: the new window (public/app) has no #connection pill. Its status bar reads "Connected · <computer>" from
   the link state (core/api.js), which starts as up before anything has loaded, so the version button beside it is
   waited for too: the status bar draws that only from the engine's answered state (shell/shell.js status()). */
export async function connected(page) {
  const status = page.locator("#statusbar");
  await status.locator('[data-act="machines"]').filter({ hasText: /^Connected/ }).waitFor({ state: "attached", timeout: STARTUP_MS });
  await status.locator('[data-act="updmenu"]').waitFor({ state: "attached", timeout: STARTUP_MS });
}

/* The page's own fetch goes through the desktop window, which signs every /api/ request itself. */
const post = (page, path, body) => page.evaluate(async ({ path, body }) => {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
}, { path, body });

/**
 * Setup (.ob9, "Set up Branch") opens over a fresh data directory. These tests are not about setup, so they start past
 * it the way the other ported tests do (tests/redesign-approvals-exact-ui.test.mjs), marked done through the engine,
 * then read the window again. A conversation begun in the window starts on Ask first, and the practice run writes a
 * file; these check the desktop app, so a new conversation follows the setting as before (conversation-mode tests
 * cover Ask first). Both are kept by the engine, so a restart on the same home starts past setup too.
 */
export async function onboarded(page) {
  await connected(page);
  await post(page, "/api/onboarding", { done: true });
  await post(page, "/api/conversation-mode/settings", { newConversation: "follow", confirmLoosening: true });
  await page.reload();
  await connected(page);
  assert.equal(await page.locator(".ob9").count(), 0, "setup is not over the window");
}

/**
 * Redesign: the old window kept a stand-in ("desktop-window") under sessionStorage "branch-token"; the new one keeps
 * nothing there in the desktop app (Electron signs the requests). What stays true is that the local session token is
 * never in the page: not in its address, its markup, or anything it stores.
 */
export async function tokenNotExposed(page, home) {
  const token = (await readFile(join(home, "state", "session-token"), "utf8")).trim();
  assert.ok(token.length >= 16, "the desktop app wrote its local session token");
  assert.equal(page.url().includes(token), false);
  assert.equal((await page.content()).includes(token), false);
  const stored = await page.evaluate(() => [sessionStorage, localStorage].flatMap((store) =>
    Object.keys(store).map((key) => `${key}=${store.getItem(key)}`)).join("\n"));
  assert.equal(stored.includes(token), false, "the page stores no copy of the local token");
}

/**
 * Redesign: #send is never disabled in the new window (it becomes Stop while a task works), so a task is finished
 * when the engine says so: the task begun with `prompt` has completed.
 */
export async function taskDone(page, prompt, timeout = 120000) {
  // waitForFunction does not await an async predicate (its Promise is truthy), so the engine is polled from here.
  const status = () => page.evaluate(async (prompt) => {
    const state = await (await fetch("/api/state")).json();
    return state.runs?.find((run) => run.prompt === prompt)?.status;
  }, prompt);
  for (const end = Date.now() + timeout; (await status()) !== "completed"; await page.waitForTimeout(500))
    if (Date.now() > end) throw new Error(`"${prompt}" did not complete in ${timeout} ms`);
  return page.evaluate(async (prompt) => {
    const state = await (await fetch("/api/state")).json();
    const run = state.runs.find((item) => item.prompt === prompt);
    return (await fetch("/api/runs/" + run.id)).json();
  }, prompt);
}

/* Settings is the gear at the foot of the list; a page is its row in Settings' own list. */
export async function openSettingsPage(page, id) {
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator(`.set-nav [data-act="setpage"][data-v="${id}"]`).click();
  await page.locator(`.set-nav [data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
}

/* Back to the conversation from Settings: "Back to <assistant>", the prototype's only way back from there. */
export async function backToConversation(page) {
  await page.locator(".set-nav .set-back").click();
  await page.locator("#prompt").waitFor({ state: "visible" });
}

/* Types into the composer and sends, as a person does. */
export async function send(page, text) {
  await page.locator("#prompt").fill(text, { timeout: STARTUP_MS });
  await page.locator("#send").click();
}

/**
 * A program that takes the engine's port while the engine is starting again. It records what it hears and answers
 * everything as if it were the engine, without anything only the engine could sign.
 */
export async function squatterOn(port) {
  const heard = [];
  const sockets = [];
  const server = createServer((request, response) => {
    const seen = { method: request.method, url: request.url, key: /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null,
      ask: request.headers["x-branch-ask"] ?? null, bytes: 0 };
    heard.push(seen);
    request.on("data", (chunk) => { seen.bytes += chunk.length; });
    request.on("end", () => response.writeHead(200, { "content-type": "application/json" })
      .end(`${JSON.stringify({ proof: "f".repeat(64), boot: "f".repeat(32) })}\n`));
  });
  // A task's socket: it answers as if it were the engine (with no mark it could make) and counts every byte sent after.
  server.on("upgrade", (request, socket) => {
    const seen = { method: "UPGRADE", url: request.url, key: /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null,
      ask: request.headers["x-branch-ask"] ?? null, bytes: 0 };
    heard.push(seen);
    sockets.push(socket);
    socket.on("error", () => undefined);
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: bearer\r\n\r\n`);
    socket.on("data", (chunk) => { seen.bytes += chunk.length; });
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", done); });
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  };
  return { heard, close };
}

/** Main's own lines (what it writes out and its errors), kept from the launch on, so a test can read what main said. */
export function mainLines(electron) {
  const lines = [];
  for (const stream of [electron.process().stdout, electron.process().stderr])
    stream?.on("data", (chunk) => lines.push(...String(chunk).split(/\r?\n/)));
  return lines;
}

/**
 * The program on the port got nothing of use: every http request it heard was the engine's proof asked with no key and
 * no body (main sends nothing else on a connection that has not proved itself). A task's socket it heard, if any,
 * carried a session key the engine now running refuses, never the window's key, and not one byte was sent on it
 * after its answer (main refused that answer, which the engine did not mark). Returns how many sockets it heard.
 */
export async function heardNothingOfUse(heard, { windowKey, origin }) {
  const proof = /^\/api\/engine-proof\?challenge=[a-f0-9]{64}$/;
  assert.ok(heard.every((each) => each.key !== windowKey), "the window's key never reached the program on the port");
  const requests = heard.filter((each) => each.method !== "UPGRADE");
  assert.deepEqual(requests.filter((each) => !(each.method === "GET" && proof.test(each.url) && each.key === null && each.bytes === 0)), [],
    "it was only ever asked for the proof, with no key and no body");
  const opened = heard.filter((each) => each.method === "UPGRADE");
  for (const each of opened) {
    assert.match(each.ask ?? "", /^[a-f0-9]{32}$/, `${each.url} asked for the engine's mark`);
    assert.equal(each.bytes, 0, `nothing was sent on ${each.url} after its unmarked answer`);
  }
  for (const key of new Set(opened.map((each) => each.key).filter(Boolean)))
    assert.equal((await fetch(`${origin}/api/state`, { headers: { authorization: `Bearer ${key}` } })).status, 401, "a key it heard is refused by the engine now running");
  return opened.length;
}

/**
 * Stops every task still working, and waits until none is: quitting with one working asks the owner in a dialog, which
 * would show on the screen of the computer running the tests.
 */
export async function noTaskWorking(electron, timeout = 30000) {
  const page = await electron.firstWindow();
  for (const end = Date.now() + timeout; ;) {
    const working = await page.evaluate(async () => {
      const state = await (await fetch("/api/state")).json();
      const ids = (state.runs ?? []).filter((run) => run.status === "running").map((run) => run.id);
      for (const id of ids) await fetch(`/api/runs/${id}/cancel`, { method: "POST" }).catch(() => undefined);
      return ids.length;
    });
    if (!working) return;
    if (Date.now() > end) throw new Error(`${working} still working`);
    await page.waitForTimeout(200);
  }
}

/** A hidden launch's windows are none of them on the screen (`when` names the step, for the message). */
export async function offScreen(electron, when) {
  const shown = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.isVisible()).length);
  assert.equal(shown, 0, `no window of the test's is on the screen (${when})`);
}
