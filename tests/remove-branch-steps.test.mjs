/* Settings › Remove Branch, in plain steps: the engine names the exact line to paste with the real path of what the
   installer left (GET /api/deployment `uninstall`), the window copies exactly that line, the line that deletes
   conversations and files appears only in the second choice, and the desktop app may open Windows' own Add or remove
   programs page and nothing near it. Nothing here runs an uninstaller: the stand-ins are never started. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { uninstallCommands, windowsUninstallerName } from "../dist/install/uninstall-commands.js";
import { openableSettingsPages, windowsAppsLink } from "../dist/os-permissions.js";
import { uninstallRoot } from "../dist/deployment-api.js";

const present = (paths) => async (path) => paths.includes(path);

test("Windows: the line runs the uninstaller in the program's folder, through cmd /c, by its full path", async () => {
  const root = "C:\\Users\\Ana Lima\\AppData\\Local\\Programs\\Branch Agent";
  const file = `${root}\\${windowsUninstallerName}`;
  const lines = await uninstallCommands("win32", root, { exists: present([file]) });
  assert.deepEqual(lines, {
    keep: `cmd /c "${file}" /quiet`,
    deleteData: `cmd /c "${file}" /quiet --delete-data`,
    settingsLink: "ms-settings:appsfeatures",
  });
  assert.ok(!lines.keep.includes("--delete-data"), "keeping is the line without --delete-data");
  assert.equal(await uninstallCommands("win32", root, { exists: present([]) }), null, "no uninstaller there: no line");
  assert.equal(await uninstallCommands("win32", null, { exists: present([file]) }), null, "not installed: no line");
  const odd = "C:\\Users\\Tom&Jerry\\Programs\\Branch Agent";
  assert.equal(await uninstallCommands("win32", odd, { exists: async () => true }), null, "a path cmd would split is never offered");
  assert.equal(await uninstallCommands("win32", "C:\\100%\\Branch Agent", { exists: async () => true }), null);
});

test("Windows: the background engine, which is not told its folder, looks beside the app's own program", () => {
  const folder = "C:\\Users\\Ana Lima\\AppData\\Local\\Programs\\Branch Agent", program = `${folder}\\Branch Agent.exe`;
  const context = (installRoot, executable = null) => ({ installRoot, executable });
  assert.equal(uninstallRoot(context(null), "win32", { appRuntime: program }), folder);
  assert.equal(uninstallRoot(context(null, program), "win32", { appRuntime: null }), folder);
  assert.equal(uninstallRoot(context("D:\\Told"), "win32", { appRuntime: program }), "D:\\Told", "the folder it was told comes first");
  assert.equal(uninstallRoot(context(null), "win32", { appRuntime: null }), null, "a source checkout has no program of its own");
  assert.equal(uninstallRoot(context(null), "darwin", { appRuntime: program }), null, "a Mac or Linux line never comes from here");
});

test("macOS and Linux: the line is the branch command the installer wrote, by its full path", async () => {
  for (const platform of ["darwin", "linux"]) {
    const launcher = "/home/ana lima/.local/bin/branch";
    const lines = await uninstallCommands(platform, null, { env: { HOME: "/home/ana lima" }, exists: present([launcher]) });
    assert.deepEqual(lines, { keep: `'${launcher}' uninstall`, deleteData: `'${launcher}' uninstall --delete-data`, settingsLink: "" });
    assert.equal(await uninstallCommands(platform, null, { env: { HOME: "/home/ana lima" }, exists: present([]) }), null);
    assert.equal(await uninstallCommands(platform, null, { env: { HOME: "/home/o'neil" }, exists: async () => true }), null);
  }
  assert.equal(await uninstallCommands("freebsd", "/x", { exists: async () => true }), null);
});

test("the desktop app may open Add or remove programs on Windows, by its exact address only", async () => {
  // The desktop's open-external answers from this set, matched whole (src/desktop/updater-ipc.ts imports Electron, so
  // its source is read rather than run).
  const ipc = await readFile(new URL("../src/desktop/updater-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /const settingsPages = openableSettingsPages\(process\.platform\);/);
  assert.match(ipc, /externalAllowed\.some\(\(prefix\) => url\.startsWith\(prefix\)\) \|\| settingsPages\.has\(url\)/);
  assert.ok(!/ms-settings/.test(ipc.replace(/\/\/.*$/gm, "")), "no Windows Settings address is written into the desktop's list by hand");
  const windows = openableSettingsPages("win32");
  assert.equal(windowsAppsLink, "ms-settings:appsfeatures");
  assert.ok(windows.has("ms-settings:appsfeatures"));
  for (const near of ["ms-settings:appsfeatures?x=1", "ms-settings:appsfeatures/", "ms-settings:apps", "MS-SETTINGS:APPSFEATURES",
    "ms-settings:appsfeatures-app", " ms-settings:appsfeatures", "ms-settings:", "ms-settings:defaultapps"])
    assert.equal(windows.has(near), false, near);
  // What was there before is still there, and nothing else was added.
  assert.deepEqual([...windows].sort(), ["ms-settings:appsfeatures", "ms-settings:notifications", "ms-settings:privacy-graphicscaptureprogrammatic",
    "ms-settings:privacy-microphone", "ms-settings:privacy-webcam"]);
  for (const platform of ["darwin", "linux"]) assert.equal(openableSettingsPages(platform).has("ms-settings:appsfeatures"), false, platform);
  assert.ok(openableSettingsPages("darwin").has("x-apple.systempreferences:com.apple.LoginItems-Settings.extension"));
  assert.equal(openableSettingsPages("linux").size, 0);
});

/* A stand-in for what the installer leaves on this computer (never run): the uninstaller in the program's folder on
   Windows, the `branch` command on a Mac or Linux. */
async function standIn(root) {
  if (process.platform === "win32") {
    const installRoot = join(root, "Programs", "Branch Agent");
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, windowsUninstallerName), "@echo off\r\nexit /b 1\r\n");
    return { installRoot, restore: () => {} };
  }
  const home = join(root, "home"), before = process.env.HOME;
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(join(home, ".local", "bin", "branch"), "#!/bin/sh\nexit 1\n");
  process.env.HOME = home;
  return { installRoot: null, restore: () => { process.env.HOME = before; } };
}

test("the window shows both lines with the real path, copies exactly them, and keeps --delete-data to the second", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-remove-steps-"));
  const { installRoot, restore } = await standIn(root);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1", installRoot });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { restore(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const { uninstall, platform } = await call("/api/deployment");
  assert.ok(uninstall, "the engine names the lines for this computer");
  const real = process.platform === "win32" ? join(installRoot, windowsUninstallerName) : join(process.env.HOME, ".local", "bin", "branch");
  assert.ok(uninstall.keep.includes(real) && uninstall.deleteData.includes(real), "the real path, in full");

  const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.__copied = [];
    globalThis.__opened = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { globalThis.__copied.push(text); } } });
    globalThis.branchDesktop = { openExternal: async (url) => { globalThis.__opened.push(url); return true; } };
  });
  await page.goto(new URL("/?desktop", server.url).href);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator('[data-act="setpage"][data-v="updates"]').click();
  const cards = page.locator(".danger8 .rm-choice");
  await cards.nth(1).waitFor();

  assert.equal(await cards.count(), 2);
  assert.equal(await cards.nth(0).locator("b").first().textContent(), "Keep my conversations and settings", "the safe choice first");
  assert.equal(await cards.nth(1).locator("b").first().textContent(), "Also delete my conversations and files");
  assert.ok(await cards.nth(1).evaluate((el) => el.classList.contains("rm-danger")), "the second in the warning style");
  assert.match(await cards.nth(1).innerText(), /This can’t be undone\./);
  assert.equal(await cards.nth(0).locator(".rm-cmd code").textContent(), uninstall.keep);
  assert.equal(await cards.nth(1).locator(".rm-cmd code").textContent(), uninstall.deleteData);
  assert.ok(!(await cards.nth(0).innerText()).includes("--delete-data"), "the first choice never shows --delete-data");
  assert.equal((await page.locator(".danger8").innerText()).split("--delete-data").length, 2, "--delete-data appears once");
  assert.ok(!(await page.locator(".danger8").innerText()).includes("`"), "no backticks in the words");
  assert.equal(await page.locator(".danger8 #dz-go, .danger8 #dz-confirm, .danger8 [data-act=\"uninstall\"]").count(), 0, "nothing in the window removes Branch");

  await cards.nth(0).locator('[data-act="rmcopy"]').click();
  await page.locator(".toast").filter({ hasText: "Copied." }).first().waitFor();
  await cards.nth(1).locator('[data-act="rmcopy"]').click();
  await page.waitForFunction(() => globalThis.__copied.length === 2);
  assert.deepEqual(await page.evaluate(() => globalThis.__copied), [uninstall.keep, uninstall.deleteData], "Copy puts exactly the engine's line");

  if (platform === "win32") {
    await page.locator('.danger8 [data-act="rmapps"]').click();
    await page.waitForFunction(() => globalThis.__opened.length === 1);
    assert.deepEqual(await page.evaluate(() => globalThis.__opened), ["ms-settings:appsfeatures"]);
  } else assert.equal(await page.locator('.danger8 [data-act="rmapps"]').count(), 0);
  assert.deepEqual(errors, []);
});
