/** Same-build settings continuity. Direct registry calls here exercise the writer, not runtime approval. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { readComfort, saveComfort } from "../dist/comfort/settings.js";
import { updatePlan } from "../dist/comfort/auto-update.js";
import { discardTemp } from "./temp-dir.mjs";

for (const releaseChannel of ["stable", "beta", "dev"]) {
  test(`${releaseChannel} keeps update choices through a sound change and restart`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `branch-update-continuity-${releaseChannel}-`));
    const options = { workspace: join(root, "workspace"), dataDir: join(root, "data") };
    let app;
    t.after(async () => { await app?.close(); await discardTemp(root); });
    app = await createBranch(options);
    const owner = app.runtime.owner;
    // Dev also keeps the line of work it follows (src/dev-lines.ts); the others keep the main line's default.
    const devLine = releaseChannel === "dev" ? "redesign/window" : "mac/cross-platform";
    const saved = saveComfort(app.store, owner, "notify", {
      method: "window", sound: "chime", autoUpdate: "install", releaseChannel, ...(releaseChannel === "dev" ? { devLine } : {}),
    });
    assert.deepEqual(saved, { method: "window", sound: "chime", autoUpdate: "install", releaseChannel, devLine });

    const run = app.store.createRun(owner, "change notification sound");
    app.store.event(run.id, "run.started", { source: "owner" });
    const context = app.runtime.context({ runId: run.id, source: "owner" });
    const changed = await app.registry.execute("settings.change", {
      changes: [{ setting: "comfort-notify.sound", value: "knock" }],
    }, context);
    assert.equal(changed.changed.length, 1);
    const expected = { method: "window", sound: "knock", autoUpdate: "install", releaseChannel, devLine };
    assert.deepEqual(readComfort(app.store, owner, "notify"), expected);

    await app.close();
    app = undefined;
    app = await createBranch(options);
    assert.deepEqual(readComfort(app.store, app.runtime.owner, "notify"), expected);

    const facts = { now: new Date("2026-09-23T12:00:00.000Z"), updaterPhase: "available" };
    const busy = updatePlan(app.store, app.runtime.owner, { ...facts, busyTasks: 1 });
    const idle = updatePlan(app.store, app.runtime.owner, { ...facts, busyTasks: 0 });
    const unchecked = updatePlan(app.store, app.runtime.owner, { ...facts, busyTasks: 0, updaterPhase: "idle" });
    assert.equal(busy.mode, "install");
    assert.notEqual(busy.step, "install", "a working task prevents installation");
    assert.equal(unchecked.step, "check", "an idle updater must first find an available update");
    // Dogfood F1: Dev installs by itself too, once nothing is working.
    assert.equal(idle.step, "install");
  });
}
