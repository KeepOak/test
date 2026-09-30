/**
 * Dogfood F1, NAS's check: a Dev install builds for many minutes, and the owner may change their mind meanwhile.
 * The last gate before Branch closes reads the owner's choice again: leaving the channel stops any install, and
 * turning "update by itself" off stops one it started. The Update button still works with it off. Node only.
 */
import test from "node:test";
import { saveComfort } from "../dist/comfort/settings.js";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { changedMind, updateReadiness } from "../dist/desktop/update-readiness.js";

const idle = (channel, autoUpdate) => ({ channel, busyTasks: 0, ...(autoUpdate ? { autoUpdate } : {}) });

test("turning update by itself off, or leaving the channel, stops an install it started", () => {
  const automatic = { channel: "beta", automatic: true };
  assert.equal(changedMind(idle("beta", "install"), automatic), null, "control: nothing changed, it goes on");
  assert.match(changedMind(idle("beta", "check"), automatic) ?? "", /Update by itself was turned off/);
  assert.match(changedMind(idle("beta", "off"), automatic) ?? "", /Update by itself was turned off/);
  assert.match(changedMind(idle("stable", "install"), automatic) ?? "", /channel was changed/);
  assert.match(changedMind(idle("beta"), automatic) ?? "", /turned off/, "an engine that does not say leaves it waiting");
});

test("the Update button's install goes on with update by itself off, but not onto another channel", () => {
  const pressed = { channel: "beta", automatic: false };
  assert.equal(changedMind(idle("beta", "off"), pressed), null);
  assert.match(changedMind(idle("stable", "off"), pressed) ?? "", /channel was changed/);
  assert.equal(changedMind(idle("beta", "off"), null), null, "no install under way: nothing to stop");
});

test("the engine's readiness carries the owner's update-by-itself choice, read fresh each time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-changed-mind-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const url = new URL(server.url);
  const loopback = `http://127.0.0.1:${url.port}`;
  app.store.save("settings", app.runtime.owner, "comfort-notify", { autoUpdate: "install", releaseChannel: "dev" });
  const first = await updateReadiness(loopback, server.token);
  // A Dev choice saved before Beta became the source build is Beta.
  assert.deepEqual(first, { channel: "beta", busyTasks: 0, workingTasks: 0, autoUpdate: "install" });
  assert.equal(changedMind(first, { channel: "beta", automatic: true }), null);
  // The owner switches it off in Settings: their own choice, kept on Beta too.
  saveComfort(app.store, app.runtime.owner, "notify", { autoUpdate: "off" });
  const later = await updateReadiness(loopback, server.token);
  assert.match(changedMind(later, { channel: "beta", automatic: true }) ?? "", /turned off/);
});

test("an automatic install that finds the channel just changed only switches it, so the next turn looks first (NAS 2e3ead6)", async () => {
  // src/desktop/updater-ipc.ts is Electron code, so its order is read here, as tests/update-install-claim.test.mjs does.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/desktop/updater-ipc.ts", import.meta.url), "utf8");
  // One install for the Update button and the app's own loop (updater-ipc.ts installNow).
  const handler = source.slice(source.indexOf("const installNow = "));
  const moved = handler.indexOf("const moved = updater.selectedChannel !== readiness.channel;");
  const setChannel = handler.indexOf("updater.setChannel(readiness.channel);");
  const goesBack = handler.indexOf("if (automatic === true && moved) throw new UpdateDeferredError(");
  const install = handler.indexOf("updater.install(");
  assert.ok(moved >= 0 && moved < setChannel, "the channel it was on is read before it is switched");
  assert.ok(goesBack > setChannel && goesBack < install, "and an automatic install goes back before installing anything");
  const { Updater } = await import("../dist/desktop/updater.js");
  assert.equal(typeof Object.getOwnPropertyDescriptor(Updater.prototype, "selectedChannel")?.get, "function", "the updater says which channel it is on");
});

test("a deferral gives the install claim back, so Check and Update work again (NAS 1f61d43)", async () => {
  const { UpdateInstallClaim } = await import("../dist/desktop/update-install-claim.js");
  const { UpdateDeferredError } = await import("../dist/desktop/updater.js");
  const claim = new UpdateInstallClaim();
  // The handler's shape: a switch-only automatic install defers.
  await assert.rejects(claim.run(() => "idle", () => false, async () => { throw new UpdateDeferredError("The update channel was just changed"); }), /just changed/);
  assert.equal(claim.active, false, "the claim is given back");
  let looked = 0;
  await claim.run(() => "idle", () => false, async () => { looked += 1; return "installed"; });
  assert.equal(looked, 1, "the next install runs");
  // Control: a plain return keeps the claim until hand-over, which is why the switch-only case must throw.
  const kept = new UpdateInstallClaim();
  await kept.run(() => "idle", () => false, async () => "switched");
  assert.equal(kept.active, true);
});
