import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `hidden`: the window never shows on the screen of the computer running the tests (an owner's working desktop must
 * not see windows flash or change colour). It opens un-maximised (maximising would show it) and the way autostart
 * opens it, in the tray (--start-minimized); its page still draws, so it can be read and photographed. Hidden unless
 * the run is a build machine's (CI), where a case that needs a window on the screen may ask for one.
 */
export async function desktopOptions({ hidden = !process.env.CI } = {}) {
  const base =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA, "Temp", "Codex-session-files")
      : tmpdir();
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, "branch-agent-desktop-"));
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
/** Keep hosted startup failures useful without copying Electron logs, paths, or page contents into CI. */
export function desktopStartupFailure(phase, startedAt, error, now = Date.now()) {
  const elapsedMs = Math.max(0, Math.min(360000, now - startedAt));
  const timedOut = error?.name === "TimeoutError";
  return new Error(`desktop ${phase} ${timedOut ? "timed out" : "failed"} after ${elapsedMs} ms (limit ${STARTUP_MS} ms)`);
}
export async function launchDesktop(electronDriver, options) {
  const startedAt = Date.now();
  try { return await electronDriver.launch(options); }
  catch (error) { throw desktopStartupFailure("launch", startedAt, error); }
}
export async function firstDesktopWindow(electron) {
  const startedAt = Date.now();
  try { return await electron.firstWindow({ timeout: STARTUP_MS }); }
  catch (error) { throw desktopStartupFailure("firstWindow", startedAt, error); }
}
/** A failed connection reports only booleans and an HTTP status, never page text, URLs, or data. */
export async function desktopConnectionState(page) {
  const unavailable = { page: "unavailable" };
  if (page.isClosed()) return unavailable;
  const read = page.evaluate(async () => {
    const status = document.querySelector("#statusbar");
    const machine = status?.querySelector('[data-act="machines"]');
    let apiStatus = 0;
    try { apiStatus = (await fetch("/api/state", { signal: AbortSignal.timeout(2000) })).status; }
    catch { /* unreachable, recorded as zero */ }
    return { ready: document.readyState, app: !!document.querySelector("#app"), status: !!status,
      machine: !!machine, connected: /^Connected/.test(machine?.textContent ?? ""),
      version: !!status?.querySelector('[data-act="updmenu"]'), offline: !!document.querySelector("#app.offline18-on"), apiStatus };
  }).catch(() => unavailable);
  let timer;
  try { return await Promise.race([read, new Promise((resolve) => { timer = setTimeout(() => resolve(unavailable), 3000); })]); }
  finally { clearTimeout(timer); }
}
/* Redesign: the new window (public/app) has no #connection pill. Its status bar reads "Connected · <computer>" from
   the link state (core/api.js), which starts as up before anything has loaded, so the version button beside it is
   waited for too: the status bar draws that only from the engine's answered state (shell/shell.js status()). */
export async function connected(page) {
  const startedAt = Date.now();
  const status = page.locator("#statusbar");
  try {
    await status.locator('[data-act="machines"]').filter({ hasText: /^Connected/ }).waitFor({ state: "attached", timeout: STARTUP_MS });
    await status.locator('[data-act="updmenu"]').waitFor({ state: "attached", timeout: STARTUP_MS });
  } catch {
    const state = await desktopConnectionState(page);
    throw new Error(`desktop connected phase failed after ${Math.min(360000, Date.now() - startedAt)} ms: ${JSON.stringify(state)}`);
  }
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

/** A hidden launch's windows are none of them on the screen (`when` names the step, for the message). */
export async function offScreen(electron, when) {
  const shown = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.isVisible()).length);
  assert.equal(shown, 0, `no window of the test's is on the screen (${when})`);
}
