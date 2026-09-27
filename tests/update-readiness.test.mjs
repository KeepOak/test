import test from "node:test";
import assert from "node:assert/strict";
import { confirmedChange, updateReadiness } from "../dist/desktop/update-readiness.js";

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

test("two channels come through: an engine from before Beta became the source build says Dev, which is Beta", async () => {
  const answer = (channel) => async () => ({ ok: true, json: async () => ({ channel, busyTasks: 0 }) });
  assert.equal((await updateReadiness("http://127.0.0.1:3210", "t", answer("stable"))).channel, "stable");
  assert.equal((await updateReadiness("http://127.0.0.1:3210", "t", answer("beta"))).channel, "beta");
  assert.equal((await updateReadiness("http://127.0.0.1:3210", "t", answer("dev"))).channel, "beta");
  await assert.rejects(updateReadiness("http://127.0.0.1:3210", "t", answer("nightly")), /invalid_value|Invalid option|could not confirm/);
});

test("a confirmed move to another line comes only from the owner's press, naming a whole change", () => {
  const change = "a".repeat(40);
  assert.equal(confirmedChange(false, undefined), null);
  assert.equal(confirmedChange(false, change), change);
  assert.throws(() => confirmedChange(true, change), /Update by itself never moves to a change that does not contain this copy's/);
  for (const bad of ["abc", 42, { commit: change }, `${change}\n`]) assert.throws(() => confirmedChange(false, bad), /can be confirmed/);
});

test("a failed or malformed readiness check refuses update installation", async () => {
  await assert.rejects(updateReadiness("http://127.0.0.1:3210", "test-token",
    async () => ({ ok: false })), /could not confirm/);
  await assert.rejects(updateReadiness("http://127.0.0.1:3210", "test-token",
    async () => ({ ok: true, json: async () => ({ channel: "beta", busyTasks: -1 }) })), /too_small/);
});
