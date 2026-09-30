/**
 * SELF-202 (nightly create-file, 0/10 with qwen2.5:7b): every try wrote "- \n- \n- ", three lines each starting with "- "
 * as the prompt asks, and every try failed as "3 lines": the check trimmed both ends of a line before looking for "- ",
 * so a bare bullet lost its space. The check now reads a line as written, setting aside only leading space.
 * Mutation: evals/tasks/work.mjs create-file: back to `l.trim().startsWith("- ")`: the first case here turns red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workTasks } from "../evals/tasks/work.mjs";

const task = workTasks.find((one) => one.id === "create-file");
/** Runs the task's own check against a file with this content (null: no file). */
async function verdict(content) {
  const ctx = { ask: async () => ({ answer: "" }), read: async (path) => (path === "TODO.txt" ? content : null) };
  const { checks } = await task.run(ctx);
  return checks.every((one) => one.ok);
}

test("create-file: three lines each starting with \"- \" pass, as written by the model; anything else does not", async () => {
  assert.equal(await verdict("- \n- \n- "), true, "qwen2.5:7b's own file: three bare bullets");
  assert.equal(await verdict("- buy milk\n- call Sam\n- file taxes\n"), true);
  assert.equal(await verdict("- a\r\n- b\r\n- c\r\n"), true, "Windows line ends");
  assert.equal(await verdict("  - a\n  - b\n  - c"), true, "leading space is set aside");
  assert.equal(await verdict("- a\n- b"), false, "two lines");
  assert.equal(await verdict("* a\n* b\n* c"), false, "another bullet");
  assert.equal(await verdict("-a\n-b\n-c"), false, "no space after the dash");
  assert.equal(await verdict(null), false, "no file");
});
