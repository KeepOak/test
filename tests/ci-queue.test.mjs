// The pull-request CI queue (scripts/ci-queue.mjs): at most `prSlots` pull-request runs hold runners, oldest first.
// Mutations that go red here: admitting a first attempt past the limit, letting a new run jump older waiting ones,
// holding a rerun the queue started, counting a replaced (superseded) run or a draft or `hold` pull request as waiting,
// and counting finished or push runs as holding a slot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activeRuns, schedule, waitingRuns, waitingWords } from "../scripts/ci-queue.mjs";

const wait = (pr, created) => ({ pr, runId: pr * 10, created });

test("a first run takes a free slot, and waits at the end of the line when there is none", () => {
  assert.deepEqual(schedule({ slots: 3, active: 2, waiting: [], self: { attempt: 1 } }),
    { admitSelf: true, rerun: [], position: null, queued: 0 });
  assert.deepEqual(schedule({ slots: 3, active: 3, waiting: [wait(1, "a")], self: { attempt: 1 } }),
    { admitSelf: false, rerun: [], position: 2, queued: 2 });
});

test("older waiting runs go first: a new run never jumps them", () => {
  const decision = schedule({ slots: 3, active: 2, waiting: [wait(1, "a"), wait(2, "b")], self: { attempt: 1 } });
  assert.deepEqual(decision.rerun.map((one) => one.pr), [1], "the one free slot goes to the oldest");
  assert.equal(decision.admitSelf, false);
  assert.equal(decision.position, 2, "behind #2");
});

test("a rerun the queue started takes its slot; a finished run hands every free slot to the oldest", () => {
  assert.equal(schedule({ slots: 3, active: 3, waiting: [], self: { attempt: 2 } }).admitSelf, true);
  const handOn = schedule({ slots: 3, active: 1, waiting: [wait(1, "a"), wait(2, "b"), wait(3, "c")] });
  assert.deepEqual(handOn.rerun.map((one) => one.pr), [1, 2]);
  assert.equal(handOn.position, null);
  assert.deepEqual(schedule({ slots: 3, active: 5, waiting: [wait(1, "a")] }).rerun, [], "over the limit, nothing starts");
});

test("waiting means: the newest run for the pull request's own head was cancelled", () => {
  const pull = (number, sha, extra = {}) => ({ number, head: { sha }, labels: [], draft: false, ...extra });
  const run = (id, sha, status, conclusion, created) => ({ id, head_sha: sha, event: "pull_request", status, conclusion, created_at: created });
  const pulls = [pull(1, "a1"), pull(2, "b2"), pull(3, "c3", { draft: true }), pull(4, "d4", { labels: [{ name: "hold" }] }), pull(5, "e5"), pull(6, "f6")];
  const runs = [
    run(11, "a1", "completed", "cancelled", "2026-09-28T10:00:00Z"), // parked by hand: waiting
    run(12, "a0", "completed", "cancelled", "2026-09-28T09:00:00Z"), // replaced by a newer push: not this head
    run(21, "b2", "completed", "cancelled", "2026-09-28T09:30:00Z"),
    run(22, "b2", "completed", "success", "2026-09-28T11:00:00Z"), // started again and passed: not waiting
    run(31, "c3", "completed", "cancelled", "2026-09-28T08:00:00Z"), // draft
    run(41, "d4", "completed", "cancelled", "2026-09-28T08:00:00Z"), // held by the owner
    run(51, "e5", "completed", "cancelled", "2026-09-28T09:45:00Z"),
    run(61, "f6", "completed", "failure", "2026-09-28T09:00:00Z"), // red, not waiting
  ];
  assert.deepEqual(waitingRuns(pulls, runs, 0).map((one) => one.pr), [5, 1], "oldest first");
  assert.deepEqual(waitingRuns(pulls, runs, 51).map((one) => one.pr), [1], "this run is never waiting on itself");
});

test("a slot is held only by another pull-request run that is running now", () => {
  const runs = [
    { id: 1, event: "pull_request", status: "in_progress" },
    { id: 2, event: "pull_request", status: "queued" },
    { id: 3, event: "push", status: "in_progress" },
    { id: 4, event: "pull_request", status: "completed" },
    { id: 5, event: "pull_request", status: "in_progress" },
  ];
  assert.equal(activeRuns(runs, 5), 1);
});

test("a waiting run says it is waiting, where it is in line, and that it did not fail", () => {
  const words = waitingWords(2, 4, 3);
  assert.match(words, /^Waiting for a CI slot, position 2 of 4/);
  assert.match(words, /cancelled to wait, not failed/);
  const config = JSON.parse(readFileSync(new URL("test-impact.json", import.meta.url), "utf8"));
  assert.ok(Number.isInteger(config.prSlots) && config.prSlots >= 1);
});
