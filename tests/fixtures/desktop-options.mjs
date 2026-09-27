import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function desktopOptions() {
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
  return {
    home,
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
