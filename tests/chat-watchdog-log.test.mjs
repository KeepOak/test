import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { newWindow, openSettings } from "./new-window-places.mjs";

/* CHAT-256: one line per stall of a chat app, updated as the restart goes, kept to the newest 100, shown in Settings ›
   Chat apps for the technical level. */
function watched() {
  return { id: "wd", kind: "telegram", botName: () => "Branch", contact: 0, restarts: 0, fail: null, async start() {}, async stop() {},
    async send() { return "1"; }, lastContact() { return this.contact; },
    async restart() { this.restarts++; if (this.fail) throw new Error(this.fail); } };
}

test("each stall is one line whose outcome follows the restart; a recovery ends the episode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-watchdog-log-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const adapter = watched();
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  const log = () => app.channels.summary().watchdogLog.map((row) => [row.kind, row.outcome]);
  const T = 10_000_000;
  adapter.contact = T;
  await app.channels.checkStalled(T + 60_000);
  assert.deepEqual(log(), [], "a quiet minute is not a stall");
  await app.channels.checkStalled(T + 120_000);
  await app.channels.checkStalled(T + 150_000);
  assert.deepEqual(log(), [["telegram", "stalled"]], "one line for the stall, not one per look");
  await app.channels.checkStalled(T + 271_000);
  assert.deepEqual(log(), [["telegram", "restarted"]]);
  adapter.contact = T + 280_000;
  await app.channels.checkStalled(T + 290_000);
  adapter.fail = "the token was refused";
  await app.channels.checkStalled(T + 280_000 + 91_000);
  await app.channels.checkStalled(T + 280_000 + 400_000);
  assert.deepEqual(log(), [["telegram", "restarted"], ["telegram", "failed"]], "a new stall after recovery is a new line");
});

test("Settings › Chat apps opens the watchdog log for the technical level", async (t) => {
  const { page, errors } = await newWindow(t);
  await openSettings(page);
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator('[data-act="setpage"][data-v="chatapps"]').first().click();
  const open = page.locator('[data-act="ca-watchdog-log"]');
  await open.waitFor();
  assert.equal(await open.getAttribute("aria-disabled"), null, "the button is live, not greyed");
  await open.click();
  await page.locator(".dlg").getByText("No chat app stalls recorded since Branch started.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
