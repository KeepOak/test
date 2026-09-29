import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveHooks } from "../dist/desktop/hot-apply.js";
import { stageLive, readLiveState } from "../dist/hot-update/live-folder.js";
import { WindowUpdateDeferred } from "../dist/desktop/live-window-ipc.js";
import { discardTemp } from "./temp-dir.mjs";
async function fixture(t, tellWindow) {
  const root = await mkdtemp(join(tmpdir(), "branch-hot-ack-")); t.after(() => discardTemp(root));
  const source = join(root, "source"), appRoot = join(root, "app"), calls = []; let recovered = 0;
  await mkdir(join(source, "public"), { recursive: true }); await writeFile(join(source, "public", "app.js"), "export {};\n");
  const built = await stageLive({ source, appRoot, commit: "b".repeat(40), version: "1.0.1", withEngine: false });
  const outcome = { tier: "window", ...built, version: "1.0.1", changed: [{ path: "public/app.js", part: "window" }] };
  const host = { running: true, call: async (method, args) => { calls.push({ method, args }); return { changed: ["app.js"], ms: 0 }; } };
  const hooks = liveHooks({ appRoot, dataDir: join(root, "data"), repo: "branch-test/live", buildDir: join(root, "build"), packaged: "a".repeat(40),
    host: () => host, tellWindow, recoverWindow: async () => { recovered++; }, runtime: process.execPath,
    forkLive: () => { throw new Error("unused"); }, snapshot: async () => "unused", backup: async () => {} });
  return { appRoot, outcome, hooks, calls, recovered: () => recovered };
}
test("current state is not advanced until the renderer confirms the checked window", async (t) => {
  let acknowledge, asked;
  const called = new Promise((resolve) => { asked = resolve; });
  const f = await fixture(t, async () => { asked(); await new Promise((resolve) => { acknowledge = resolve; }); });
  const applying = f.hooks.apply(f.outcome, { onStage: () => {} }); await called;
  let settled = false; void applying.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "applying stays pending until the renderer paints");
  assert.equal((await readLiveState(f.appRoot)).window, null);
  acknowledge(); await applying;
  assert.equal((await readLiveState(f.appRoot)).window.commit, "b".repeat(40)); assert.equal(f.recovered(), 0);
});
test("refused renderer restores the previous served page and leaves saved state unchanged", async (t) => {
  const f = await fixture(t, async () => { throw new WindowUpdateDeferred("draft storage is full"); });
  await assert.rejects(f.hooks.apply(f.outcome, { onStage: () => {} }), { name: "UpdateDeferredError", message: "draft storage is full" });
  assert.equal((await readLiveState(f.appRoot)).window, null);
  assert.equal(f.calls.at(-1).method, "use-window"); assert.equal(f.calls.at(-1).args.inUse, null);
  assert.equal(f.recovered(), 1);
});
