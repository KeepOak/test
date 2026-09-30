// UI-269: Home's ideas come from the owner's own explicitly titled tasks only, cite them, and never read what was said;
// temporary chats are left out, and nothing is sent or started.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { historyIdeas } from "../dist/history-ideas.js";

test("ideas cite titled owner tasks, repeat titles become a checklist, and private words stay out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-ideas-"));
  const provider = { name: "scripted", async complete() { return { content: "the secret answer body", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const titled = async (prompt, title, extra = {}) => {
    const run = await app.runtime.run({ prompt, ...extra });
    app.store.event(run.id, "run.titled", { title });
    return run;
  };
  await titled("private words about the invoice", "Invoice follow-up");
  await titled("more private words", "Invoice follow-up");
  await titled("draft a letter", "Letter to landlord");
  const { ideas } = historyIdeas(app.store, app.runtime.owner, (text) => text);
  assert.deepEqual(ideas.map((i) => i.title), ["Review Letter to landlord", "Make a reusable checklist for Invoice follow-up"], "newest first");
  assert.equal(ideas[1].sources.length, 2);
  assert.doesNotMatch(JSON.stringify(ideas), /private words|secret answer/);
  assert.match(ideas[1].draft, /ask me before taking further action/);
});
