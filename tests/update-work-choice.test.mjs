/* PLAT-048: "Let them finish first" keeps the owner's update waiting for that exact release and channel, installs it
   once every task is done, and calls it off if the release or channel changes. The question names three choices.
   Fake timers and a scripted engine state only; nothing is installed. */
import test from "node:test";
import assert from "node:assert/strict";
import { OwnerUpdateQueue, updateWorkQuestion } from "../dist/desktop/update-work-choice.js";

function queueWith(states) {
  const said = { installed: [], cancelled: [], failed: [] };
  const queue = new OwnerUpdateQueue({
    state: async () => { const next = states.length > 1 ? states.shift() : states[0]; if (next instanceof Error) throw next; return next; },
    install: async (request) => { said.installed.push(request); },
    cancelled: (words) => said.cancelled.push(words),
    failed: (words) => said.failed.push(words),
  });
  return { queue, said };
}
async function tick(t, times = 1) {
  for (let i = 0; i < times; i++) { t.mock.timers.tick(10_000); for (let j = 0; j < 5; j++) await Promise.resolve(); }
}
const request = { tag: "v2.0.0", channel: "stable", confirmed: null };
const state = (busyTasks, extra = {}) => ({ tag: "v2.0.0", channel: "stable", busyTasks, installing: false, ...extra });

test("PLAT-048: the waiting update installs once, only after every task is done", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, said } = queueWith([state(2), state(1), state(0)]);
  queue.start(request);
  assert.equal(queue.pending, true);
  await tick(t, 2);
  assert.deepEqual(said.installed, [], "tasks are still working");
  await tick(t);
  assert.deepEqual(said.installed, [request]);
  assert.equal(queue.pending, false);
  await tick(t, 3);
  assert.equal(said.installed.length, 1, "and never again");
});

test("PLAT-048: a changed release or channel calls the waiting update off instead of installing something else", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const changed of [state(0, { tag: "v2.1.0" }), state(0, { channel: "beta" })]) {
    const { queue, said } = queueWith([changed]);
    queue.start(request);
    await tick(t);
    assert.deepEqual(said.installed, []);
    assert.match(said.cancelled[0], /release or channel changed/);
    assert.equal(queue.pending, false);
  }
});

test("PLAT-048: a failed check is said once and the update keeps waiting; stopping it ends the wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, said } = queueWith([new Error("engine asleep"), new Error("engine asleep"), state(1)]);
  queue.start(request);
  await tick(t, 3);
  assert.equal(said.failed.length, 1);
  assert.match(said.failed[0], /engine asleep/);
  assert.equal(queue.pending, true);
  queue.stop();
  await tick(t, 3);
  assert.deepEqual(said.installed, []);
});

test("PLAT-048: the question offers wait, install now and cancel, waiting first", () => {
  const asked = updateWorkQuestion(3, false);
  assert.deepEqual(asked.buttons, ["Let them finish first", "Install now", "Cancel update"]);
  assert.equal(asked.defaultId, 0);
  assert.equal(asked.cancelId, 2);
  assert.match(asked.message, /3 tasks/);
  assert.match(updateWorkQuestion(1, true).message, /already|waiting for your tasks/);
});
