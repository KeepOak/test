/**
 * QA retest 2026-09-28 (m14): after the gateway started a stopped engine again, nothing in the window said so: Settings ›
 * Gateway's "What it has been doing" stayed empty. It now lists the gateway's own notes (GET /gateway/health), newest
 * first, and says there is nothing to report while there is none. Node only: the real dist/ and public/, a real
 * `branch start` with the gateway switched on, no model, headless Chromium, temporary folders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { signIn } from "./new-window-places.mjs";
import { openSettingsPage } from "./settings-window.mjs";
import { discardTemp } from "./temp-dir.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const until = async (check, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

test("Settings › Gateway says when the gateway started the engine again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-shown-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "gateway.json"), JSON.stringify({ mode: "when-needed" }));
  const env = { ...process.env, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_PORT: "0" };
  const gateway = spawn(process.execPath, [cli, "start"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  gateway.stdout.on("data", (chunk) => { out += chunk; });
  gateway.stderr.on("data", (chunk) => { out += chunk; });
  const ended = new Promise((resolve) => gateway.once("exit", resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); if (gateway.exitCode === null) gateway.kill(); await ended; await discardTemp(root); });

  assert.ok(await until(async () => /Branch gateway listening at (\S+)/.test(out)), out);
  const url = /Branch gateway listening at (\S+)/.exec(out)[1];
  const health = async () => (await fetch(`${url}/gateway/health`)).json();
  assert.ok(await until(async () => (await health()).ok === true), "the engine came up");
  const server = { url, token: (await readFile(join(dataDir, "session-token"), "utf8")).trim() };
  await fetch(`${url}/api/onboarding`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });

  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  await openSettingsPage(page, "gateway");
  const timeline = page.locator(".set-col .sec", { hasText: "What it has been doing" }).locator("ol.tl");
  await timeline.getByText("Nothing to report", { exact: false }).waitFor({ timeout: 20000 });

  process.kill((await health()).worker.pid, "SIGKILL");
  assert.ok(await until(async () => { const now = await health(); return now.restarts >= 1 && now.ok === true; }), "the gateway started it again");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingsPage(page, "gateway");
  await timeline.getByText("The engine stopped unexpectedly", { exact: false }).waitFor({ timeout: 20000 });
  assert.equal(await timeline.getByText("Nothing to report", { exact: false }).count(), 0);
  assert.match(await timeline.locator("li").first().locator("time").getAttribute("datetime"), /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(errors, []);
});
