import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { defaultGatewayConfig, saveGatewayConfig, loadGatewayConfig, proposeConfig, acceptProposal, rollbackAccepted } from "../dist/never-break/gateway-config.js";
import { neverBreakApi, neverBreakView } from "../dist/never-break/api.js";

test("keep awake starts off, persists, and is not controlled by proposed timing changes or rollback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-gateway-power-choice-"));
  t.after(() => discardTemp(dir));
  assert.equal(defaultGatewayConfig().keepAwake, false);
  await saveGatewayConfig(dir, { ...defaultGatewayConfig(), mode: "on", keepAwake: true });
  assert.equal((await loadGatewayConfig(dir)).config.keepAwake, true);
  const proposal = await proposeConfig(dir, { startSeconds: 45, keepAwake: false }, "timings only", async () => ({ ok: true, detail: "fixture" }));
  assert.equal(proposal.config.keepAwake, true, "model suggestions cannot change the owner's power choice");
  const accepted = await acceptProposal(dir);
  assert.equal(accepted.keepAwake, true);
  await saveGatewayConfig(dir, { ...accepted, keepAwake: false });
  const restored = await rollbackAccepted(dir);
  assert.equal(restored.keepAwake, false, "rolling back timings preserves the latest owner power choice");
  assert.equal(restored.startSeconds, defaultGatewayConfig().startSeconds);
});

test("API saves only the owner preference and reports trusted broker state separately", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-gateway-power-api-"));
  t.after(() => discardTemp(dir));
  const post = (body, extras = {}) => neverBreakApi(dir, { method: "POST" }, "/api/never-break", async () => body, extras);
  const saved = await post({ keepAwake: true });
  assert.equal(saved.config.keepAwake, true);
  assert.equal(saved.mode, "off", "saving power choice does not start the gateway");
  assert.equal(saved.keepAwakeRuntime, null, "a preference cannot claim an active blocker");
  const runtime = { requested: true, active: true, suspended: false, error: null };
  assert.deepEqual((await neverBreakView(dir, async () => runtime)).keepAwakeRuntime, runtime);
  assert.equal((await neverBreakView(dir, async () => { throw new Error("unavailable"); })).keepAwakeRuntime, null);
  for (const body of [{}, { keepAwake: "yes" }, { active: true }, { mode: "on", keepAwakeRuntime: runtime }])
    await assert.rejects(post(body), /Choose off/);
  assert.equal((await post({ mode: "on" })).config.keepAwake, true, "gateway changes preserve the owner power choice");
  assert.equal((await post({ keepAwake: false }, { gatewayPower: async () => ({ ...runtime, requested: false, active: false }) })).keepAwakeRuntime.active, false);
});

test("an owner OFF promises an immediate stop only under the retained desktop broker", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-gateway-off-claim-"));
  const saved = { child: process.env.BRANCH_GATEWAY_CHILD, desktop: process.env.BRANCH_DESKTOP_GATEWAY };
  t.after(async () => {
    for (const [name, value] of [["BRANCH_GATEWAY_CHILD", saved.child], ["BRANCH_DESKTOP_GATEWAY", saved.desktop]])
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await discardTemp(dir);
  });
  const off = () => neverBreakApi(dir, { method: "POST" }, "/api/never-break", async () => ({ mode: "off" }));
  process.env.BRANCH_GATEWAY_CHILD = "1"; delete process.env.BRANCH_DESKTOP_GATEWAY;
  const node = await off();
  assert.equal(node.underGateway, true);
  assert.equal(node.stopsWhenOff, false, "a Node gateway has no owner-OFF stop, so the page must not say stopping");
  assert.doesNotMatch(node.note, /stop after this response/);
  process.env.BRANCH_DESKTOP_GATEWAY = "1";
  const desktop = await off();
  assert.equal(desktop.stopsWhenOff, true);
  assert.match(desktop.note, /stop after this response/);
});
