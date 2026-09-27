import test from "node:test";
import assert from "node:assert/strict";
import { launchDesktopGateway, desktopGatewayFlag } from "../dist/desktop/gateway-launch.js";
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

test("a failed broker launch refuses a second foreground engine instead of silently losing the gateway", async () => {
  await assert.rejects(launchDesktopGateway({ ...options, join: async () => null,
    spawn: () => ({ once: (_event, listener) => { listener(new Error("owned launch failed")); }, unref: () => undefined }) }), /owned launch failed/);
});

test("an installed runtime launches its packaged program without an extra application argument", async () => {
  let calls = 0, args;
  await launchDesktopGateway({ ...options, packaged: true, join: async () => ++calls === 1 ? null : attached,
    spawn: (_file, launchArgs) => { args = launchArgs; return { once: () => undefined, unref: () => undefined }; } });
  assert.deepEqual(args, [desktopGatewayFlag]);
});
