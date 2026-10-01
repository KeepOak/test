/**
 * Overview › Weekly recap: completed work of the last seven days, grouped by the Trunk that did it. Helpers, temporary
 * chats and unfinished tasks are not counted, and the time estimate appears only once the owner gives their own minutes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../dist/store.js";
import { weeklyRecap } from "../dist/weekly-recap.js";

test("weekly recap counts finished Trunk work, leaves helpers and temporary chats out, and estimates only on the owner's word", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const owner = "local";
  const done = (prompt, temporary = false) => {
    const run = store.createRun(owner, prompt, undefined, temporary);
    store.finish(run.id, "completed", "done");
    return run;
  };
  const trunkRun = done("trunk work");
  store.event(trunkRun.id, "trunk.turn", { trunkId: "t1" });
  done("plain task");
  const helper = done("helper");
  store.event(helper.id, "run.started", { parentRunId: trunkRun.id });
  done("temporary chat", true);
  store.createRun(owner, "still running");
  const names = (id) => (id === "t1" ? "Research" : null);

  const recap = weeklyRecap(store, owner, names, new Date(Date.now() + 1000));
  assert.equal(recap.completed, 2, "the Trunk task and the plain task; not the helper, the temporary chat or the running one");
  assert.equal(recap.trunkTasks, 1);
  assert.deepEqual(recap.groups.map((group) => [group.trunkId ?? "", group.name, group.completed]).sort(),
    [["", "Other tasks", 1], ["t1", "Research", 1]]);
  assert.equal(recap.estimatedMinutesSaved, null, "no estimate until the owner says how long a task takes by hand");

  store.save("settings", owner, "weekly_recap", { manualMinutesPerTask: 30 });
  assert.equal(weeklyRecap(store, owner, names, new Date(Date.now() + 1000)).estimatedMinutesSaved, 30,
    "only Trunk tasks count toward the estimate");
  assert.equal(weeklyRecap(store, owner, names, new Date(Date.now() + 8 * 86_400_000)).completed, 0, "a week later it is gone");
});
