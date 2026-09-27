/**
 * Dogfood E2 ("too technical everywhere"): the owner's own questions on Legion read "Before I go ahead: Using
 * device.run (default: pwd)" and "Using settings.change: Code editor, Switch: off → on; … (workspace-editor.mode →
 * on; …)". A question now says what the step does, and a settings change says each setting once, in words.
 * A scripted model on its own data folder; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { describeToolCall } from "../dist/activity.js";

async function paused(t, call) {
  const root = await mkdtemp(join(tmpdir(), "branch-approval-words-"));
  let round = 0;
  const provider = { name: "scripted", async complete() {
    return ++round === 1 ? { content: "", toolCalls: [{ id: "c1", ...call }] } : { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "please do it" });
  assert.equal(run.status, "needs_input");
  return app.store.events(run.id).find((event) => event.kind === "policy.ask").data;
}

test("a settings change is asked about in words, each setting once, with no setting ids", async (t) => {
  const ask = await paused(t, { name: "settings.change", arguments: JSON.stringify({ changes: [{ setting: "fly-core.mode", value: "on" }] }) });
  assert.match(ask.question, /^Before I go ahead: Changing Branch's own settings: .*Switch: off → on/);
  assert.doesNotMatch(ask.question, /fly-core\.mode|settings\.change/, ask.question);
  assert.match(ask.target, /fly-core\.mode/, "the ids stay where rules and the record need them");
});

test("steps the owner met as tool names say what they do", () => {
  assert.equal(describeToolCall("device.run", { executable: "pwd", device: "default" }), "Running pwd on default");
  assert.equal(describeToolCall("device.run", { executable: "pwd", device: "" }), "Running pwd on your paired device");
  assert.equal(describeToolCall("settings.loosen", {}), "Making Branch less careful in its own settings");
  assert.equal(describeToolCall("tools.search", { query: "x" }), "Looking for the right tool");
});

test("the words say the change once: the ordinary reason is not repeated after them (Mac mini's E2 review)", async (t) => {
  const ask = await paused(t, { name: "settings.change", arguments: JSON.stringify({ changes: [{ setting: "fly-core.mode", value: "on" }] }) });
  assert.doesNotMatch(ask.question, /Branch asks before it changes its own settings/, ask.question);
});

test("a settings question whose words do not name the change keeps saying what it is about (Mac mini's E2 review)", async (t) => {
  const unknown = await paused(t, { name: "settings.change", arguments: JSON.stringify({ changes: [{ setting: "no-such.thing", value: "on" }] }) });
  assert.match(unknown.question, /no-such\.thing/, unknown.question);
  const undo = await paused(t, { name: "settings.undo", arguments: JSON.stringify({ record: "3f1c0a52-0000-4000-8000-000000000001" }) });
  assert.match(undo.question, /3f1c0a52/, undo.question);
});
