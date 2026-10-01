/* Actual engine-recovery modules, with no process signals or real endpoints. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discardTemp } from "./temp-dir.mjs";
import { attachToRunning, readRunning, writeRunning } from "../dist/install/running.js";
import { closeOldEngine } from "../dist/install/old-engine.js";

const pid = 999002;
function probe(t, state, { error, unknown = false, platform = "linux" } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  t.mock.method(process, "kill", (target, signal) => {
    assert.equal(target, pid); assert.equal(signal, 0, "only mocked liveness probes");
    if (error) throw Object.assign(new Error(error), { code: error });
    return true;
  });
  t.mock.method(fs, "readFileSync", (path, encoding) => {
    assert.equal(path, `/proc/${pid}/stat`); assert.equal(encoding, "utf8");
    if (unknown) throw Object.assign(new Error("restricted"), { code: "EACCES" });
    return `${pid} (Branch worker) ${state()} 1 0 0\n`;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
  });
}
async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-engine-zombie-recovery-"));
  t.after(() => discardTemp(root));
  await writeFile(join(root, "session-token"), "d".repeat(64));
  await writeRunning(root, { pid, port: 3211, url: "http://127.0.0.1:3211", mode: "daemon", version: "1.0.0" });
  return root;
}
for (const state of ["Z", "X"]) {
  test(`attachment removes a positively exited Linux ${state} note before any proof or request`, async (t) => {
    const root = await folder(t); probe(t, () => state);
    assert.equal(await attachToRunning(root, {
      prove: async () => assert.fail("an exited PID cannot authorize a request"),
      fetch: async () => assert.fail("no request to stale note"),
    }), null);
    assert.equal(await readRunning(root), null);
  });
  test(`acknowledged old engine entering Linux ${state} closes without polling or signals`, async (t) => {
    const root = await folder(t); let current = "S"; probe(t, () => current);
    const report = await closeOldEngine(root, {
      listener: async () => pid,
      fetch: async () => { current = state; return new Response("{}"); },
      sleep: async () => assert.fail("an exited PID needs no polling"),
      kill: () => assert.fail("never force an exited engine"), waitMs: 0,
    });
    assert.equal(report.closed, true); assert.equal(report.forced, false);
  });
}
for (const options of [{}, { unknown: true }, { error: "EPERM" }, { platform: "darwin" }, { platform: "win32" }]) {
  test(`attachment preserves existing proof and permission semantics: ${JSON.stringify(options)}`, async (t) => {
    const root = await folder(t); probe(t, () => "S", options);
    let proofs = 0, requests = 0;
    const result = await attachToRunning(root, {
      prove: async () => { proofs++; return "fixture-proof"; },
      fetch: async (_url, init) => { requests++; assert.equal(init.headers.authorization, "Bearer fixture-proof"); return Response.json({ version: "2.0.0" }); },
    });
    if (options.error === "EPERM") {
      assert.equal(result, null); assert.equal(proofs, 0); assert.equal(requests, 0);
    } else {
      assert.equal(result.version, "2.0.0"); assert.equal(proofs, 1); assert.equal(requests, 1);
    }
  });
}
test("old engine cannot signal a live PID after losing checked port ownership", async (t) => {
  const root = await folder(t); probe(t, () => "S");
  let checks = 0;
  const result = await closeOldEngine(root, {
    listener: async () => ++checks <= 2 ? pid : pid + 1,
    fetch: async () => new Response("{}"), waitMs: 0,
    kill: () => assert.fail("port ownership changed before force"),
  });
  assert.equal(result.closed, false);
  assert.match(result.why, /did not close/);
});
test("an unproved live note never sends the master key", async (t) => {
  const root = await folder(t); probe(t, () => "S");
  assert.equal(await attachToRunning(root, {
    prove: async () => null, fetch: async () => assert.fail("proof refused"),
  }), null);
  assert.equal((await readRunning(root)).pid, pid);
});
for (const options of [{ unknown: true }, { error: "EPERM" }, { error: "ESRCH" }]) {
  test(`old-engine liveness preserves conservative and permission semantics: ${JSON.stringify(options)}`, async (t) => {
    const root = await folder(t); probe(t, () => "S", options);
    let checked = 0;
    const result = await closeOldEngine(root, {
      listener: async () => { checked++; return null; },
      fetch: async () => assert.fail("no request without checked port ownership"),
      kill: () => assert.fail("no signal without checked port ownership"),
    });
    assert.equal(result.closed, false);
    if (options.error === "ESRCH") {
      assert.equal(checked, 0); assert.match(result.why, /not running/);
    } else {
      assert.equal(checked, 1); assert.match(result.why, /port is not held/);
    }
  });
}
test("attachment preserves original missing-PID refusal without proof or request", async (t) => {
  const root = await folder(t); probe(t, () => "S", { error: "ESRCH" });
  assert.equal(await attachToRunning(root, {
    prove: async () => assert.fail("missing PID cannot prove"),
    fetch: async () => assert.fail("missing PID cannot request"),
  }), null);
  assert.equal(await readRunning(root), null);
});
