/* PLAT-026: a checked live build's Gateway methods replace the resident gateway's in place, keeping its listener
   address and worker, and can be rolled back; a tampered build is refused. Where no retained gateway can take the code
   (the window's own engine), a gateway change goes the packaged way. A Gateway object that is never started, and a
   live build of this checkout staged in a temporary folder; nothing listens and no window opens. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { stageLive } from "../dist/hot-update/live-folder.js";
import { Gateway } from "../dist/never-break/gateway.js";
import { prepareGatewayCode } from "../dist/desktop/gateway-code.js";
import { residentGatewayOutcome } from "../dist/desktop/hot-apply.js";

const NEW = "c".repeat(40);
const resident = () => new Gateway({ dataDir: "/nowhere", script: "/nowhere/worker.js", port: 0, version: "1.0.0" });

async function staged(t) {
  const appRoot = await mkdtemp(join(process.cwd(), ".gateway-code-test-"));
  t.after(() => discardTemp(appRoot));
  const built = await stageLive({ source: process.cwd(), appRoot, commit: NEW, version: "1.0.1" });
  return { appRoot, built, inUse: { commit: NEW, digest: built.digest, version: "1.0.1", at: new Date().toISOString() } };
}

test("PLAT-026: the checked gateway code goes in place and comes back out, keeping the resident's address", async (t) => {
  const { appRoot, inUse } = await staged(t);
  const gateway = resident();
  gateway.url = "http://127.0.0.1:4321";
  const prepared = await prepareGatewayCode(appRoot, gateway, inUse);
  assert.equal(Object.hasOwn(gateway, "health"), false, "nothing changes until it is applied");
  prepared.apply();
  assert.equal(Object.hasOwn(gateway, "health"), true, "the live build's methods now answer");
  assert.equal(Object.hasOwn(gateway, "stop"), false, "the owner's stop entry is never replaced");
  assert.equal(gateway.health().gateway.version, "1.0.1");
  assert.equal(gateway.url, "http://127.0.0.1:4321");
  assert.throws(() => prepared.apply(), /already in use/);
  prepared.rollback();
  assert.equal(Object.hasOwn(gateway, "health"), false);
  assert.equal(gateway.health().gateway.version, "1.0.0");
});

test("PLAT-026: a live build changed after it was checked is not loaded into the resident gateway", async (t) => {
  const { appRoot, built, inUse } = await staged(t);
  await appendFile(join(built.dir, "dist", "never-break", "gateway.js"), "\n// changed after the check\n");
  await assert.rejects(prepareGatewayCode(appRoot, resident(), inUse));
});

test("PLAT-026: with no retained gateway to take it, a gateway change goes the packaged way", () => {
  const outcome = { tier: "gateway", version: "1.0.1", parts: new Set(["gateway"]), dir: "/x", manifest: {}, digest: "d", changed: [] };
  assert.equal(residentGatewayOutcome(outcome, {}).tier, "shell");
  assert.equal(residentGatewayOutcome(outcome, { gateway: { ready() {}, checking() {}, packagedVersion: "1.0.0" } }).tier, "shell");
  const withCode = { gateway: { ready() {}, checking() {}, packagedVersion: "1.0.0", prepareCode: async () => ({ apply() {}, rollback() {} }) } };
  assert.equal(residentGatewayOutcome(outcome, withCode), outcome);
  assert.equal(residentGatewayOutcome({ tier: "engine", version: "1" }, {}).tier, "engine");
});
