/* SCREEN-050: after a watched text change, the task offers its exact browser page to the owner: the task stops driving
   and waits, no owner input grant is made until the owner really takes over, and Hand back returns it to the task.
   The browser control alone and the condition's bounds; no page is opened. */
import test from "node:test";
import assert from "node:assert/strict";
import { BrowserControls } from "../dist/browser-control.js";
import { WatchConditionSchema } from "../dist/integrations/browser-watch-condition.js";

const binding = { owner: "o", conversation: "c", profile: null };

test("SCREEN-050: an offered page waits for the owner, grants nothing until Take over, and Hand back returns it", async () => {
  const controls = new BrowserControls();
  const control = controls.adopt(binding, "", "run-1", 1);
  assert.deepEqual([control.view().state, control.view().writer], ["agent", { kind: "agent", id: "run-1" }]);
  let checks = 0;
  const offered = await control.offerToOwner(control.view().epoch, "run-1", () => { checks++; });
  assert.equal(checks, 2, "who may see it is checked before and after the task's last step drains");
  assert.deepEqual([offered.state, offered.writer, offered.paused], ["owner", null, "run-1"], "kept for the owner; no one holds input yet");
  const turn = control.agentTurn("run-1", new AbortController().signal, 300);
  await assert.rejects(turn, /./, "the task does not drive while the page is offered");
  const taken = await control.takeOver(control.view().epoch, "window-a");
  assert.deepEqual(taken.writer, { kind: "owner", id: "window-a" });
  const back = await control.handBack(control.view().epoch, "window-a", "run-1");
  assert.deepEqual([back.state, back.writer], ["agent", { kind: "agent", id: "run-1" }]);
  await control.agentTurn("run-1", new AbortController().signal, 300);
});

test("SCREEN-050: a refused check leaves the page with nobody, and a watch is one bounded text condition", async () => {
  const control = new BrowserControls().adopt(binding, "", "run-2", 1);
  await assert.rejects(control.offerToOwner(control.view().epoch, "run-2", () => { throw new Error("no longer the owner's"); }), /no longer/);
  assert.equal(control.view().writer?.kind === "owner", false, "no owner grant on a refusal");
  assert.equal(WatchConditionSchema.parse({ text: "Sold out", state: "disappears" }).timeoutMs, 10000);
  for (const bad of [{ text: "", state: "appears" }, { text: "x", state: "changes" }, { text: "x", state: "appears", timeoutMs: 120000 }, { text: "x", state: "appears", every: "day" }])
    assert.equal(WatchConditionSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
