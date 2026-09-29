// Why update by itself waits with a ready update is written to the activity log, once per reason (src/comfort/auto-update.ts
// noteUpdateWait), through the real POST /api/comfort/update-plan route, at the log's shipped "when needed" mode.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { activeDiagnosticLog, DiagnosticLog, DiagnosticLogSettingsSchema, setDiagnosticLog } from "../dist/diagnostic-log.js";
import { noteUpdateWait } from "../dist/comfort/auto-update.js";
import { setLockdown } from "../dist/lockdown.js";

const waits = (log) => log.read({ component: "updater" }).filter((line) => line.message.startsWith("Update by itself waits:")).reverse();

test("the plan route writes why a ready update waits: the same reason once, a changed reason again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-update-wait-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "comfort-notify", { autoUpdate: "install", releaseChannel: "stable" });
  const plan = async (body) => {
    const response = await fetch(new URL("/api/comfort/update-plan", server.url), { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const log = activeDiagnosticLog();
  assert.ok(log, "the engine set its log up");
  // The release that did not install here: held until a newer one lands. Asked three times, as the window's poll does.
  const failed = { updaterPhase: "available", updaterTag: "v0.3.0", failedTag: "v0.3.0", checked: true };
  assert.equal((await plan(failed)).until, "a newer version lands");
  await plan({ updaterPhase: "available", updaterTag: "v0.3.0", checked: true });
  await plan({ updaterPhase: "available", updaterTag: "v0.3.0", checked: true });
  let lines = waits(log);
  assert.equal(lines.length, 1, "the same reason, asked again and again, is one line");
  assert.equal(lines[0].level, "warn", "kept at the shipped 'when needed' mode");
  assert.match(lines[0].message, /did not install here last time/);
  assert.equal(lines[0].fields.version, "v0.3.0");
  assert.equal(lines[0].fields.channel, "stable");
  assert.equal(lines[0].fields.until, "a newer version lands");
  // Lockdown on: another reason for the same version, so a new line.
  setLockdown(app.store, owner, { on: true });
  const locked = await plan({ updaterPhase: "available", updaterTag: "v0.3.1", checked: true });
  assert.equal(locked.until, "Lockdown is off");
  await plan({ updaterPhase: "available", updaterTag: "v0.3.1", checked: true });
  lines = waits(log);
  assert.equal(lines.length, 2, "a changed reason is a new line, and only one");
  assert.match(lines[1].message, /Lockdown/);
  assert.equal(lines[1].fields.version, "v0.3.1");
});

test("a wait names what it is waiting for: busy tasks by id, how long it has been held, the channel", (t) => {
  // Mode off: nothing reaches a disk; each line is still seen as it is written.
  const seen = [];
  const watching = new DiagnosticLog({ dir: join(tmpdir(), "branch-wait-never-written"), settings: () => DiagnosticLogSettingsSchema.parse({ mode: "off" }), onLine: (line) => seen.push(line) });
  setDiagnosticLog(watching);
  t.after(() => setDiagnosticLog(null));
  const plan = { mode: "install", step: "nothing", reason: "A newer version is ready; it installs once no task is working.", lastCheckedAt: null, until: "no task is working" };
  const facts = { channel: "beta", version: "0.19.5-dev.1-gabc", busyTasks: 2, workingTasks: 1, askingTasks: 1, overdueTasks: 0,
    holding: [{ id: "task-1", sessionId: "s1", state: "working" }, { id: "task-2", sessionId: "s2", state: "asking" }], heldSince: "2026-09-29T10:00:00.000Z" };
  assert.equal(noteUpdateWait("someone", plan, facts), true);
  assert.equal(noteUpdateWait("someone", plan, { ...facts, busyTasks: 3 }), false, "more tasks is the same wait");
  const [line] = seen;
  assert.equal(line.fields.tasks, "task-1 (working), task-2 (asking)");
  assert.equal(line.fields.heldSince, "2026-09-29T10:00:00.000Z");
  assert.equal(line.fields.channel, "beta");
  assert.equal(line.fields.busyTasks, 2);
  // The update goes in (no wait); the next wait, even for the same reason, is new again.
  assert.equal(noteUpdateWait("someone", { ...plan, step: "install", until: undefined }, facts), false);
  assert.equal(noteUpdateWait("someone", plan, facts), true);
  assert.equal(seen.length, 2);
});
