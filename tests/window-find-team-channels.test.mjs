/**
 * CHAT-187: the terminal's /team, /find and /channels in the window's "/" menu too. /team and /channels open their
 * places; /find puts the words in the sidebar's search, as if typed there. Headless browser only; no window opens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { lookup } from "../dist/commands/catalog.js";

test("the table: /team, /find and /channels on the window and the phone as well as the terminal", () => {
  for (const name of ["team", "find", "channels"]) assert.deepEqual(lookup(name).surfaces, ["window", "phone", "terminal"], name);
  assert.equal(lookup("find").level, "owner", "searching every conversation stays the owner's");
  assert.equal(lookup("channels").level, "owner");
});

test("in the window, /channels and /team open their places and /find searches, without reaching the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-window-find-"));
  const provider = { name: "find-ui", calls: 0, complete: async () => { provider.calls += 1; return { content: "Done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const errors = [];
  /** A fresh window at the conversation view for each command, since a place command leaves the conversation. */
  const windowWith = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    return page;
  };
  const type = async (page, line) => { await page.locator("#prompt").fill(line); await page.locator("#send").click(); };

  const channels = await windowWith();
  await type(channels, "/channels");
  await channels.locator('#main [data-act="ptab"][data-place="customize"][data-v="channels"][aria-selected="true"]').waitFor({ timeout: 15000 });
  const team = await windowWith();
  await type(team, "/team");
  await team.locator('#side [data-act="view"][data-v="team"][aria-current="true"]').waitFor({ timeout: 15000 });
  const find = await windowWith();
  await type(find, "/find quarterly figures");
  await find.waitForFunction(() => document.querySelector("#side-q")?.value === "quarterly figures", null, { timeout: 15000 });
  assert.equal(provider.calls, 0, "no command reached the model");
  assert.deepEqual(errors, []);
});
