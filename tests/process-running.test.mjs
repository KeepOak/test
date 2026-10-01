import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { processRunning } from "./process-running.mjs";

for (const [state, expected] of [["Z", false], ["X", false], ["S", true]]) {
  test(`positive Linux ${state} liveness`, (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    t.mock.method(process, "kill", (pid, signal) => { assert.equal(pid, 991234); assert.equal(signal, 0); return true; });
    t.mock.method(fs, "readFileSync", () => `991234 (worker) ${state} 1 0`);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", descriptor); });
    assert.equal(processRunning(991234), expected);
  });
}
test("a process group is never classified from its leader", () => {
  assert.throws(() => processRunning(-991234, () => assert.fail("never probe a group")), RangeError);
});
test("caller refusal and unexpected signal errors retain their semantics", () => {
  assert.equal(processRunning(991234, () => false), false);
  const error = Object.assign(new Error("denied"), { code: "EPERM" });
  assert.throws(() => processRunning(991234, () => { throw error; }), (actual) => actual === error);
});
for (const raw of [null, "malformed", "7 (other) Z 1"]) {
  test(`unknown Linux state remains live: ${JSON.stringify(raw)}`, (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    t.mock.method(process, "kill", () => true);
    t.mock.method(fs, "readFileSync", () => { if (raw === null) throw new Error("restricted procfs"); return raw; });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", descriptor); });
    assert.equal(processRunning(991234), true);
  });
}
