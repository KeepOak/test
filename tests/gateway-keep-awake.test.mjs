import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { defaultGatewayConfig, saveGatewayConfig, loadGatewayConfig, proposeConfig, acceptProposal, rollbackAccepted } from "../dist/never-break/gateway-config.js";

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
