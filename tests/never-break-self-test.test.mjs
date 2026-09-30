/**
 * The update check a new version must pass (src/never-break/self-test.ts), run on data shaped like a real
 * install. On 2026-09-28 every Beta change failed it on the owner's copy: the owner had switched the progress
 * check on in a conversation, and the test stand-in said the same words at each of its three steps, which that
 * check reads as a stuck model. The owner's model choice and saved connections are on the copy too, and must
 * never answer the check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { DemoProvider } from "../dist/demo.js";
import { selfTest } from "../dist/never-break/self-test.js";

/** An install whose owner turned the strict guards on, chose a model of their own, has Trunks and a paired chat app. */
async function ownerInstall(t, progressJudge) {
  const root = await mkdtemp(join(tmpdir(), "branch-self-test-"));
  t.after(() => discardTemp(root));
  const dataDir = join(root, "data");
  const app = await createBranch({ dataDir, workspace: join(root, "workspace"), provider: new DemoProvider() });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "safety-progress-judge", { mode: progressJudge });
  app.store.save("settings", owner, "loop_guard", { mode: "on" });
  // The owner's own model: a local service at an address where nothing answers, so a check it answered fails.
  app.store.save("settings", owner, "model-connections", { connections: [
    { id: "owner-ollama", name: "Owner's model", catalogId: "ollama", model: "llama2", extras: { baseUrl: "http://127.0.0.1:9" } },
  ] });
  app.store.save("settings", owner, "models", { activePreset: "owner-ollama", fallbackOrder: ["owner-ollama"], cooldownMs: 60000, reasoning: null });
  // Trunks, one answering with the owner's model and assigned to look after updates, and a paired chat app sender.
  const keeper = app.trunks.create({ name: "Update keeper" }, { model: "owner-ollama" });
  app.trunks.create({ name: "Scout" });
  app.store.save("settings", owner, "update-keeper", { trunkId: keeper.id });
  const at = new Date().toISOString();
  app.store.save("settings", owner, "channel-pair:telegram:1234567", { status: "approved", code: "123456", name: "Owner", requestedAt: at, approvedAt: at });
  await app.close();
  // Opened again as the install would be: every part of the fixture really loads.
  const again = await createBranch({ dataDir, workspace: join(root, "workspace"), provider: new DemoProvider() });
  try {
    assert.equal(again.trunks.records.list().length, 2);
    assert.equal(again.trunks.records.find(keeper.id)?.model, "owner-ollama");
    assert.equal(again.channels.summary().approved.length, 1);
    assert.equal(again.runtime.models.settings(owner).activePreset, "owner-ollama", "the owner's own model is chosen");
    assert.deepEqual(again.runtime.models.settings(owner).fallbackOrder, ["owner-ollama"]);
  } finally { await again.close(); }
  return { dataDir, workspace: join(root, "check-workspace") };
}

for (const mode of ["when-needed", "on"]) {
  test(`the update check passes on an install with the progress check ${mode} and the owner's own model chosen`, async (t) => {
    const install = await ownerInstall(t, mode);
    const report = await selfTest({ ...install, version: "9.9.9-test" });
    const failed = report.checks.filter((one) => !one.ok).map((one) => `${one.name}: ${one.detail}`);
    assert.deepEqual(failed, []);
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((one) => one.name === "runs a task on a copy of your data")?.detail, "a task wrote, read and verified a file");
  });
}

test("the test stand-in never says the same words at two of its steps", async () => {
  const demo = new DemoProvider();
  const messages = [{ role: "user", content: "Self-test: say hello." }];
  const said = [];
  for (let step = 0; step < 4; step++) {
    const answer = await demo.complete({ messages, tools: [], signal: new AbortController().signal });
    said.push(answer.content);
    const call = answer.toolCalls[0];
    if (!call) break;
    messages.push({ role: "assistant", content: answer.content, toolCalls: [call] });
    messages.push({ role: "tool", toolCallId: call.id, content: call.name === "files.verify" ? '{"verified":true}' : "{}" });
  }
  assert.equal(said.length, 4);
  assert.equal(new Set(said).size, said.length, said.join(" | "));
  assert.match(said.at(-1), /verified branch-demo\.txt/);
});
