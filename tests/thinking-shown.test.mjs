/**
 * Dogfood B1 ("no thought process shown while it works"): while "show reasoning" is on (its default), the newest part
 * of what a task's model is thinking is on the task's live activity (`thinkingOf`, GET /api/activity), from memory only.
 * It is never written to the record, and it goes when the model call ends; with it off, nothing is shown.
 * A scripted model that thinks before it answers; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveKnobs } from "../dist/knobs/settings.js";

async function thinker(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-thinking-shown-"));
  const seen = [];
  let app;
  const provider = { name: "scripted", async complete(request) {
    request.onReasoningDelta?.("Looking at what was asked. ");
    request.onReasoningDelta?.("The answer is short.");
    const running = app.store.runs(app.runtime.owner).find((run) => run.status === "running");
    seen.push(running ? app.runtime.thinkingOf(running.id) : "no running task");
    request.onTextDelta?.("Done.");
    return { content: "Done.", toolCalls: [] };
  } };
  app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, seen };
}

test("with show reasoning on, the thinking is on the live task while the model thinks, and never in the record", async (t) => {
  const { app, seen } = await thinker(t);
  const run = await app.runtime.run({ prompt: "hi", onTextDelta: () => {} });
  assert.match(seen[0] ?? "", /Looking at what was asked\. The answer is short\./, "shown while the model thinks");
  assert.equal(app.runtime.thinkingOf(run.id), undefined, "gone once the model call ends");
  assert.equal(JSON.stringify(app.store.events(run.id)).includes("Looking at what was asked"), false, "never in the record");
  assert.equal(run.output, "Done.", "the thinking never becomes the answer");
});

test("with show reasoning off, it is only heard, as before", async (t) => {
  const { app, seen } = await thinker(t);
  saveKnobs(app.store, app.runtime.owner, "reasoning", { showReasoning: false });
  await app.runtime.run({ prompt: "hi", onTextDelta: () => {} });
  assert.equal(seen[0], undefined);
});
