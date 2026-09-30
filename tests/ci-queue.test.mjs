// The pull-request CI queue (scripts/ci-queue.mjs): at most `prSlots` pull-request runs hold runners, oldest first.
// Mutations that go red here: admitting a run past the limit, letting a new run jump older waiting ones, holding a
// rerun the queue started, admitting a rerun a person started without a slot, ignoring or misplacing ci-priority,
// counting a replaced (superseded) run or a draft or `hold` pull request as waiting, counting finished or push runs as
// holding a slot, and missing an admitted run whose shares wait for runners (it reports `queued`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activeRuns, QUEUE_ACTOR, schedule, waitingRuns, waitingWords } from "../scripts/ci-queue.mjs";

const wait = (pr, created, priority = false) => ({ pr, runId: pr * 10, created, priority });

test("a first run takes a free slot, and waits at the end of the line when there is none", () => {
  assert.deepEqual(schedule({ slots: 3, active: 2, waiting: [], self: {} }),
    { admitSelf: true, rerun: [], position: null, queued: 0 });
  assert.deepEqual(schedule({ slots: 3, active: 3, waiting: [wait(1, "a")], self: {} }),
    { admitSelf: false, rerun: [], position: 2, queued: 2 });
});

test("older waiting runs go first: a new run never jumps them", () => {
  const decision = schedule({ slots: 3, active: 2, waiting: [wait(1, "a"), wait(2, "b")], self: {} });
  assert.deepEqual(decision.rerun.map((one) => one.pr), [1], "the one free slot goes to the oldest");
  assert.equal(decision.admitSelf, false);
  assert.equal(decision.position, 2, "behind #2");
});

test("a rerun the queue started takes its slot; a finished run hands every free slot to the oldest", () => {
  assert.equal(schedule({ slots: 3, active: 3, waiting: [], self: { started: true } }).admitSelf, true);
  // A rerun a person started (the Rerun button, or a hand rerun of a parked run) waits like any other run.
  assert.equal(schedule({ slots: 3, active: 3, waiting: [], self: { started: false } }).admitSelf, false);
  assert.equal(QUEUE_ACTOR, "github-actions[bot]", "the actor of a rerun made with the workflow's own token");
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

/* The regression of 2026-09-29: an admitted run whose shares all wait for runners is `queued`, not `in_progress`, and
   counting only `in_progress` runs let about 29 pull-request runs start their shares while each plan logged "1 of 3".
   Mutation: count `status === "in_progress"` again → the first assertion goes red. */
test("a slot is held by every other unfinished pull-request run, its shares queued or running", () => {
  const runs = [
    { id: 1, event: "pull_request", status: "in_progress" },
    { id: 2, event: "pull_request", status: "queued" },
    { id: 3, event: "push", status: "in_progress" },
    { id: 4, event: "pull_request", status: "completed" },
    { id: 5, event: "pull_request", status: "in_progress" },
    { id: 6, event: "pull_request", status: "waiting" },
    { id: 7, event: "merge_group", status: "queued" },
  ];
  assert.equal(activeRuns(runs, 5), 3, "runs 1, 2 and 6; never push, merge-queue or finished runs, never itself");
  const saturated = Array.from({ length: 29 }, (_, index) => ({ id: index + 1, event: "pull_request", status: "queued",
    run_started_at: `2026-09-29T21:${String(index).padStart(2, "0")}:00Z` }));
  const self = { id: 99, event: "pull_request", status: "in_progress", run_started_at: "2026-09-29T22:00:00Z" };
  const decision = schedule({ slots: 3, active: activeRuns([...saturated, self], 99, self), waiting: [], self: {} });
  assert.equal(decision.admitSelf, false, "29 admitted runs waiting for runners hold every slot");
});

/* Runs that plan at the same moment each count only the unfinished runs that started before them, so they agree:
   the oldest are admitted and the rest wait, and nobody is left holding with no run to hand a slot on. Mutations:
   count every unfinished run (four simultaneous plans all hold) or none (all four go) → red. */
test("runs that plan at once agree on the order: exactly the free slots are taken, oldest first", () => {
  const at = (id, minute, extra = {}) => ({ id, event: "pull_request", status: "in_progress", run_started_at: `2026-09-29T21:0${minute}:00Z`, ...extra });
  const runs = [at(40, 4), at(10, 1), at(30, 3), at(20, 2)];
  const admitted = runs.filter((run) => schedule({ slots: 3, active: activeRuns(runs, run.id, run), waiting: [], self: {} }).admitSelf);
  assert.deepEqual(admitted.map((run) => run.id).sort(), [10, 20, 30]);
  // The oldest unfinished run is always admitted, however many others are unfinished.
  const crowd = Array.from({ length: 12 }, (_, index) => at(100 + index, 5));
  assert.equal(schedule({ slots: 1, active: activeRuns(crowd, 100, crowd[0]), waiting: [], self: {} }).admitSelf, true);
  // A rerun moves run_started_at: an old run started again by a person lines up behind the runs already going.
  const rerun = at(5, 9, { run_attempt: 2, created_at: "2026-09-29T20:00:00Z" });
  assert.equal(activeRuns([...runs, rerun], 5, rerun), 4);
  assert.equal(activeRuns([...runs, rerun], 10, runs[1]), 0, "the older run does not count a rerun started after it");
  // The same second: the lower id is first.
  assert.equal(activeRuns([at(1, 1), at(2, 1)], 2, at(2, 1)), 1);
  assert.equal(activeRuns([at(1, 1), at(2, 1)], 1, at(1, 1)), 0);
});

test("a waiting run says it is waiting, where it is in line, and that it did not fail", () => {
  const words = waitingWords(2, 4, 3);
  assert.match(words, /^Waiting for a CI slot, position 2 of 4/);
  assert.match(words, /cancelled to wait, not failed/);
  const config = JSON.parse(readFileSync(new URL("test-impact.json", import.meta.url), "utf8"));
  assert.ok(Number.isInteger(config.prSlots) && config.prSlots >= 1);
});

test("ci-priority pull requests are first in line, and a priority run passes the others", () => {
  const pull = (number, sha, labels = []) => ({ number, head: { sha }, labels: labels.map((name) => ({ name })), draft: false });
  const run = (id, sha, created) => ({ id, head_sha: sha, event: "pull_request", status: "completed", conclusion: "cancelled", created_at: created });
  const line = waitingRuns([pull(1, "a"), pull(2, "b", ["ci-priority"]), pull(3, "c"), pull(4, "d", ["ci-priority"])],
    [run(11, "a", "2026-09-28T01:00:00Z"), run(21, "b", "2026-09-28T04:00:00Z"), run(31, "c", "2026-09-28T02:00:00Z"), run(41, "d", "2026-09-28T03:00:00Z")], 0);
  assert.deepEqual(line.map((one) => one.pr), [4, 2, 1, 3], "priority first, each part oldest first");
  const handOn = schedule({ slots: 3, active: 2, waiting: line });
  assert.deepEqual(handOn.rerun.map((one) => one.pr), [4], "a freed slot goes to the oldest priority pull request");
  const waiting = [wait(1, "a"), wait(2, "b")];
  const mine = schedule({ slots: 3, active: 2, waiting, self: { priority: true } });
  assert.equal(mine.admitSelf, true, "a priority run takes the free slot ahead of ordinary waiting runs");
  assert.deepEqual(mine.rerun, []);
  const behindPriority = schedule({ slots: 3, active: 3, waiting: [wait(5, "a", true), ...waiting], self: { priority: true } });
  assert.equal(behindPriority.position, 2, "behind the other priority run only");
});

/* A decision to wait is written before any write is tried: rerunning another run (which a second plan or verify may
   have rerun first), a label or the cancel can fail, and must never let a held run go ahead. Mutation: write held=true
   after the reruns again → red. */
test("a run that must wait is marked waiting before the queue tries any write", () => {
  const source = readFileSync(new URL("../scripts/ci-queue.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main()"));
  assert.ok(main.indexOf("held=true") > 0);
  assert.ok(main.indexOf("held=true") < main.indexOf("await rerun(api, decision.rerun)"));
  assert.match(source, /async function attempt\(what, call\) \{\n  try \{/, "each write is caught on its own");
  assert.doesNotMatch(main, /await api\("POST"/, "every write in main goes through attempt()");
});
