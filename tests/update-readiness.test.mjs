import test from "node:test";
import assert from "node:assert/strict";
import { confirmedChange, lineOf, updateReadiness } from "../dist/desktop/update-readiness.js";

test("desktop update readiness reads only the authenticated loopback engine", async () => {
  const calls = [];
  const call = async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    return { ok: true, json: async () => ({ channel: "beta", busyTasks: 2 }) };
  };
  assert.deepEqual(await updateReadiness("http://127.0.0.1:3210", "test-token", call),
    { channel: "beta", busyTasks: 2 });
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:3210/api/comfort/update-readiness",
    authorization: "Bearer test-token" }]);
  await assert.rejects(updateReadiness("https://example.com", "test-token", call), /not safe/);
  await assert.rejects(updateReadiness("http://localhost:3210", "test-token", call), /not safe/);
  assert.equal(calls.length, 1, "no credential reaches an untrusted address");
});

test("the Dev line of work comes through only as one of Branch's own lines", async () => {
  const answer = (devLine) => async () => ({ ok: true, json: async () => ({ channel: "dev", busyTasks: 0, devLine }) });
  assert.equal((await updateReadiness("http://127.0.0.1:3210", "t", answer("redesign/window"))).devLine, "redesign/window");
  await assert.rejects(updateReadiness("http://127.0.0.1:3210", "t", answer("--upload-pack=x")), /invalid_value|Invalid option/);
  assert.equal(lineOf({}), "mac/cross-platform", "an engine from before the setting means the main line");
});

test("a confirmed move to another line comes only from the owner's press, naming a whole change", () => {
  const change = "a".repeat(40);
  assert.equal(confirmedChange(false, undefined), null);
  assert.equal(confirmedChange(false, change), change);
  assert.throws(() => confirmedChange(true, change), /Update by itself never moves to another line of work/);
  for (const bad of ["abc", 42, { commit: change }, `${change}\n`]) assert.throws(() => confirmedChange(false, bad), /can be confirmed/);
});

test("a failed or malformed readiness check refuses update installation", async () => {
  await assert.rejects(updateReadiness("http://127.0.0.1:3210", "test-token",
    async () => ({ ok: false })), /could not confirm/);
  await assert.rejects(updateReadiness("http://127.0.0.1:3210", "test-token",
    async () => ({ ok: true, json: async () => ({ channel: "beta", busyTasks: -1 }) })), /too_small/);
});
