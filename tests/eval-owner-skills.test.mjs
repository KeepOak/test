/**
 * The nightly harness can score the owner's own skills from an explicit offline export: each case installs its skill
 * in the evaluation engine, and passes only when the run really read that skill and the answer holds the expected words.
 * A stand-in context plays the engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { ownerSkillTasks } from "../evals/lib/owner-skills.mjs";

test("owner skill cases need the installed skill really read, and a bad export is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-skills-"));
  t.after(() => discardTemp(root));
  const file = join(root, "skills.json");
  await writeFile(file, JSON.stringify({ version: 1, skills: [{ id: "invoice-style", document: "# Invoice style\nAlways write totals in euros.",
    cases: [{ prompt: "Total 3 items at 5 each.", answerContains: ["15 euros"] }] }] }));
  const [task] = await ownerSkillTasks(file);
  assert.equal(task.id, "owner-skill-invoice-style-1");
  const ctx = (readIt) => ({
    api: async (path) => path === "skills/install" ? { activeVersion: 1, name: "Invoice style", id: "skill-123" }
      : { calls: readIt ? [{ name: "skills.read", status: "done", output: "skill-123: Always write totals in euros." }] : [] },
    ask: async () => ({ id: "run-1", status: "completed", answer: "That is 15 euros." }),
  });
  assert.ok((await task.run(ctx(true))).checks.every((one) => one.ok));
  const unread = await task.run(ctx(false));
  assert.equal(unread.checks.find((one) => one.name === "selected skill was read").ok, false, "a right answer without the skill proves nothing");
  assert.deepEqual(await ownerSkillTasks(null), []);
  await writeFile(file, JSON.stringify({ version: 2, skills: [] }));
  await assert.rejects(ownerSkillTasks(file), /version 1/);
});
