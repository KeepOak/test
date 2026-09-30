import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerNamedAlive, GatewayLaunchError, joinedEngineVerdict, launchDesktopGateway, desktopGatewayFlag } from "../dist/desktop/gateway-launch.js";
const attached = { url: "http://127.0.0.1:48931", version: "1.2.3" };
const options = { executable: "C:/runtime/electron.exe", appRoot: "C:/program", packaged: false,
  base: "C:/test/home", dataDir: "C:/test/data", workspace: "C:/test/work" };

test("an already proved background engine is joined without launching a second owner", async () => {
  let launched = false;
  assert.equal(await launchDesktopGateway({ ...options, join: async () => attached,
    spawn: () => { launched = true; throw new Error("must join"); } }), attached);
  assert.equal(launched, false);
});

test("the broker uses the existing stock runtime, a separate launch flag and the same isolated data", async () => {
  let calls = 0, unref = false, observed;
  const value = await launchDesktopGateway({ ...options, join: async () => ++calls === 1 ? null : attached,
    spawn: (file, args, env) => {
      observed = { file, args, env }; return { once: () => undefined, unref: () => { unref = true; } };
    } });
  assert.equal(value, attached); assert.equal(unref, true);
  assert.equal(observed.file, options.executable); assert.deepEqual(observed.args, [options.appRoot, desktopGatewayFlag]);
  assert.equal(observed.env.BRANCH_DESKTOP_HOME, options.base); assert.equal(observed.env.BRANCH_DATA_DIR, options.dataDir);
  assert.equal(observed.env.BRANCH_WORKSPACE, options.workspace); assert.equal(observed.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("a launch that failed with no broker alive is proved over, so the window may run its own engine", async () => {
  const error = await launchDesktopGateway({ ...options, join: async () => null, brokerAlive: async () => false,
    spawn: () => ({ once: (event, listener) => { if (event === "error") listener(new Error("owned launch failed")); }, unref: () => undefined }) })
    .then(() => null, (failure) => failure);
  assert.ok(error instanceof GatewayLaunchError); assert.match(error.message, /owned launch failed/);
  assert.equal(error.brokerMayRun, false);
});

test("a launch that ended while another broker is named alive waits for it and never offers a second writer", async () => {
  let calls = 0;
  const joined = await launchDesktopGateway({ ...options, waitMs: 5000, brokerAlive: async () => true,
    join: async () => ++calls >= 4 ? attached : null,
    spawn: () => ({ once: (event, listener) => { if (event === "exit") listener(); }, unref: () => undefined }) });
  assert.equal(joined, attached, "the live broker that held the lock is joined once it proves itself");
  const timedOut = await launchDesktopGateway({ ...options, waitMs: 300, brokerAlive: async () => true, join: async () => null,
    spawn: () => ({ once: (event, listener) => { if (event === "exit") listener(); }, unref: () => undefined }) }).then(() => null, (failure) => failure);
  assert.ok(timedOut instanceof GatewayLaunchError); assert.equal(timedOut.brokerMayRun, true);
});

test("a broker still starting when the wait ends is never raced by a second engine", async () => {
  const error = await launchDesktopGateway({ ...options, waitMs: 300, brokerAlive: async () => false, join: async () => null,
    spawn: () => ({ once: () => undefined, unref: () => undefined }) }).then(() => null, (failure) => failure);
  assert.ok(error instanceof GatewayLaunchError);
  assert.equal(error.brokerMayRun, true, "its own launched process has not ended, so it may still become the writer");
});

test("a broker named in a stale or unreadable authority note is not alive", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-gateway-authority-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.equal(await brokerNamedAlive(dataDir), false);
  await mkdir(join(dataDir, "desktop-control"));
  const note = (pid) => writeFile(join(dataDir, "desktop-control", "authority.json"), JSON.stringify({ pid, address: "x", key: "0".repeat(64) }));
  await note(process.pid); assert.equal(await brokerNamedAlive(dataDir), true);
  await note(2 ** 31 - 2); assert.equal(await brokerNamedAlive(dataDir), false);
  await note("1"); assert.equal(await brokerNamedAlive(dataDir), false);
});

test("a joined window starts again only when nothing is named running, and waits through a restart", () => {
  const url = "http://127.0.0.1:48931", alive = (pid) => pid === 7;
  assert.equal(joinedEngineVerdict(null, url, alive), "gone", "the owner turned the gateway off: its note was cleared");
  assert.equal(joinedEngineVerdict({ pid: 8, url }, url, alive), "gone", "the broker ended without clearing its note");
  assert.equal(joinedEngineVerdict({ pid: 7, url }, url, alive), "wait", "a restart or a resume from sleep is waited for");
  assert.equal(joinedEngineVerdict({ pid: 7, url: "http://127.0.0.1:48932" }, url, alive), "moved");
});

test("an installed runtime launches its packaged program without an extra application argument", async () => {
  let calls = 0, args;
  await launchDesktopGateway({ ...options, packaged: true, join: async () => ++calls === 1 ? null : attached,
    spawn: (_file, launchArgs) => { args = launchArgs; return { once: () => undefined, unref: () => undefined }; } });
  assert.deepEqual(args, [desktopGatewayFlag]);
});
