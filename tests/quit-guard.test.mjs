/* Redesign phase 1: asking before a Quit that would stop work. Only the decision is tested here, on its
   own: the desktop window that shows the question cannot be opened by an agent on the owner's computer
   (tests/desktop*.test.mjs are never run here), so src/desktop/main.ts's wiring is checked by reading it. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { asksBeforeQuit, quitButtons, quitChoice, quitQuestion, runningTaskCount } from "../dist/desktop/quit-guard.js";

test("it asks only when a person quits while work runs and nothing in the background would carry it on", () => {
  const base = { reason: "person", runningTasks: 1, engineInBackground: false };
  assert.equal(asksBeforeQuit(base), true);
  assert.equal(asksBeforeQuit({ ...base, runningTasks: 0 }), false, "nothing running, nothing to lose");
  assert.equal(asksBeforeQuit({ ...base, engineInBackground: true }), false, "the background engine carries on");
  for (const reason of ["update", "restart", "command", "system"])
    assert.equal(asksBeforeQuit({ ...base, reason }), false, `${reason} was already decided`);
});

test("the question is in plain words, with Keep running first and Cancel as the way out", () => {
  const one = quitQuestion(1), two = quitQuestion(2);
  assert.match(one.message, /^A task is still working\. Quitting now stops it\.$/);
  assert.match(two.message, /^2 tasks are still working\. Quitting now stops them\.$/);
  assert.deepEqual(one.buttons, ["Keep running in the background", "Quit anyway", "Cancel"]);
  assert.deepEqual(one.buttons, [...quitButtons]);
  assert.equal(one.defaultId, 0, "pressing Enter keeps the work going");
  assert.equal(one.cancelId, 2, "closing the question cancels");
  assert.deepEqual([0, 1, 2, 9].map(quitChoice), ["keep", "quit", "cancel", "cancel"]);
});

test("only tasks working right now count; one waiting for an answer is kept and does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-quit-guard-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(runningTaskCount(app.store), 0);
  const run = app.store.createRun(app.runtime.owner, "sort my files");
  app.store.sqlite.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(run.id);
  assert.equal(runningTaskCount(app.store), 1);
  app.store.sqlite.prepare("UPDATE tasks SET status = 'needs_input' WHERE id = ?").run(run.id);
  assert.equal(runningTaskCount(app.store), 0);
});

test("the window marks an update, a restart and `branch quit` so none of them asks", async () => {
  const main = await readFile(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  assert.match(main, /registerUpdaterIpc\(openWindow, url, app\.getVersion\(\), \(\) => \{ quitReason = "update"; app\.quit\(\); \}/);
  assert.match(main, /app\.relaunch\([\s\S]{0,120}quitReason = "restart";\s*app\.quit\(\);/);
  assert.match(main, /quit: \(\) => \{ quitReason = "command"; app\.quit\(\); \}/);
  // The engine runs in a process of its own, so the count of working tasks is its answer (or the last count it told).
  assert.match(main, /runningNow = \(\) => host\.call<number>\("running-count", undefined, 5000\)/);
  assert.match(main, /asksBeforeQuit\(\{ reason: quitReason, runningTasks, engineInBackground: joinedBackground \}\)/);
});

test("integration review: the computer shutting down or signing out never waits for the question, nor does an update while it shows", async () => {
  const main = await readFile(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  assert.match(main, /powerMonitor\.on\("shutdown", \(\) => \{ quitReason = "system"; \}\)/, "macOS and Linux shutdown");
  assert.match(main, /window\.on\("query-session-end", \(\) => \{ quitReason = "system"; \}\)/, "Windows ending the session");
  assert.match(main, /window\.on\("session-end", \(\) => \{ quitReason = "system"; \}\)/);
  const beforeQuit = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf("powerMonitor.on("));
  assert.doesNotMatch(beforeQuit, /if \(askingToQuit\) return;/, "a quit that was already decided is never swallowed by an open question");
  assert.match(beforeQuit, /if \(quitReason !== "person" \|\| joinedBackground\) return shutDown\(\);/, "a decided quit never waits for the count");
  assert.match(beforeQuit, /if \(!askingToQuit\) void askThenQuit\(runningTasks\);\s*return;\s*\}\s*shutDown\(\);/);
  assert.match(main, /if \(quitting\) return; \/\/ an update/, "an answer that arrives after the quit already began does nothing");
});
