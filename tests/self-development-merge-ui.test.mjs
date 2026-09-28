import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("source merge UI retains a rejected request and separates reading, approval and merge", async (t) => {
  const worktree = "branch-agent-source/.branch-worktrees/self-fix", head = "a".repeat(40), base = "b".repeat(40);
  const seen = [], state = { reject: true, approved: false };
  const { page, errors } = await newWindow(t, { seed(app) {
    // Explicit stand-in controller responses: this proves the UI sequence, not a live GitHub merge.
    app.sourceMerges.list = () => ({ changes: [{ worktree, revision: 1, repositories: ["owner/Branch-Agent"], evidence: { passed: 2 } }] });
    app.sourceMerges.review = async (input) => {
      seen.push(["read", input]);
      if (state.reject) throw new Error("Required check tests has not passed. Review again.");
      return { id: "review-fixture", definition: "Remove an unused button", rollback: "Revert the merge",
        github: { repo: input.repo, number: input.number, headSha: head, baseSha: base, base: "redesign/window", required: [{ context: "tests", appId: 123 }] },
        tests: { passed: 2, command: ["node", "scripts/review.mjs", "--jobs", "1", "tests/fixture.test.mjs"] },
        diff: { files: [{ path: "src/button.ts", lines: [{ m: "-", t: "<unsafe-html>" }, { m: "+", t: "fixed" }] }] } };
    };
    app.sourceMerges.approve = (input) => { seen.push(["approve", input]); state.approved = true; return { approved: true }; };
    app.sourceMerges.merge = async (input) => { assert.equal(state.approved, true); seen.push(["merge", input]); return { sha: "c".repeat(40), merged: true }; };
  } });
  await openPlace(page, "inbox", "needs");
  await page.locator('[data-act="self-merge-open"]').click();
  await page.locator("#self-merge-number").fill("7");
  await page.locator('[data-act="self-merge-read"]').click();
  await page.getByText("Required check tests has not passed. Review again.", { exact: true }).waitFor();
  assert.equal(await page.locator("#self-merge-number").inputValue(), "7");
  assert.deepEqual(seen.map(([name]) => name), ["read"]);
  state.reject = false;
  await page.locator('[data-act="self-merge-read"]').click();
  await page.locator('[data-act="self-merge-approve"]').waitFor();
  assert.equal(await page.locator('[data-act="self-merge-finish"]').count(), 0);
  assert.equal(await page.locator("unsafe-html").count(), 0, "diff text is escaped");
  assert.ok(await page.locator('[role="dialog"]').innerText().then((text) => text.includes(head)));
  await page.locator('[data-act="self-merge-approve"]').click();
  await page.locator('[data-act="self-merge-finish"]').waitFor();
  assert.deepEqual(seen.map(([name]) => name), ["read", "read", "approve"]);
  await page.locator('[data-act="self-merge-finish"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-act="self-merge-finish"]'));
  assert.deepEqual(seen.map(([name]) => name), ["read", "read", "approve", "merge"]);
  assert.deepEqual(errors, []);
});
