import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UpdateInstallClaim } from "../dist/desktop/update-install-claim.js";

test("a second install while hand-over is pending returns status without installing twice", async () => {
  const claim = new UpdateInstallClaim();
  const status = { state: "ready" };
  let releaseHandOver;
  const handOver = new Promise((resolve) => { releaseHandOver = resolve; });
  let installs = 0;
  const install = async () => {
    installs++;
    await handOver;
    return { state: "applying" };
  };

  const first = claim.run(() => status, () => false, install);
  assert.equal(claim.active, true);
  assert.strictEqual(await claim.run(() => status, () => false, install), status);
  assert.equal(installs, 1);
  releaseHandOver();
  assert.deepEqual(await first, { state: "applying" });
  assert.equal(claim.active, true);
});

test("a failed install releases the claim for a retry", async () => {
  const claim = new UpdateInstallClaim();
  await assert.rejects(claim.run(() => ({}), () => false, async () => { throw new Error("failed"); }), /failed/);
  assert.equal(claim.active, false);
  assert.deepEqual(await claim.run(() => ({}), () => false, async () => ({ state: "applying" })), { state: "applying" });
});

test("the updater IPC and the app's own update loop route installs through the claim", () => {
  const source = readFileSync(new URL("../src/desktop/updater-ipc.ts", import.meta.url), "utf8");
  assert.match(source, /const installNow = [\s\S]*?installClaim\.run\(/);
  assert.match(source, /ipcMain\.handle\("branch:update-install"[\s\S]*?return installNow\(/);
  assert.match(source, /install: async \(\) => \{ await installNow\(true, null\); \}/);
  assert.match(source, /ipcMain\.handle\("branch:update-check"[\s\S]*?installClaim\.active/);
});
