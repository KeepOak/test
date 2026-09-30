/* UP-UI-012: the folded steps line says what was done in plain words ("Edited 2 files, searched 1 time, ran 1 command")
   from each step's recorded outcome; while any outcome is unknown it keeps "Worked for …". The window's own module,
   run in a headless window. Mutation: return "" from stepSummary: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("UP-UI-012: completed steps are summed up by what they did", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  const said = await page.evaluate(async () => {
    const { stepSummary } = await import("/app/chat/step-summary.js");
    const call = (id, name, args = {}) => ({ id, name, arguments: JSON.stringify(args) });
    const calls = [call("a", "files.write", { path: "notes/a.md" }), call("b", "files.edit", { path: "./notes/a.md" }),
      call("c", "code.change_set"), call("d", "files.grep"), call("e", "shell.execute"), call("f", "shell.execute"), call("g", "web.fetch")];
    const steps = new Map([
      ["a", { toolStatus: "done", happened: JSON.stringify({ path: "notes/a.md", added: 3, removed: 0 }) }],
      ["b", { toolStatus: "done", happened: JSON.stringify({ path: "notes/a.md", added: 1, removed: 1 }) }],
      ["c", { toolStatus: "done", happened: JSON.stringify({ files: [{ path: "src/x.ts", added: 2, removed: 0 }, { path: "src/y.ts", added: 0, removed: 0 }] }) }],
      ["d", { toolStatus: "done", happened: "3 matches" }],
      ["e", { toolStatus: "done", happened: "ok" }],
      ["f", { toolStatus: "failed", happened: "exit 1" }],
      ["g", { toolStatus: "done", happened: "<html>" }],
    ]);
    const unknown = new Map(steps); unknown.set("g", { happened: "<html>" });
    return { all: stepSummary(calls, steps), unknown: stepSummary(calls, unknown),
      practice: stepSummary([call("p", "files.write", { path: "x", dryRun: true })], new Map([["p", { toolStatus: "done", happened: JSON.stringify({ dryRun: true }) }]])) };
  });
  assert.equal(said.all, "Edited 2 files, searched 1 time, read 1 item, ran 1 command, 1 failed step");
  assert.equal(said.unknown, "", "a step whose outcome is not recorded keeps the time-and-steps line");
  assert.equal(said.practice, "1 practice step", "a practice edit is not counted as an edited file");
  assert.deepEqual(errors, []);
});
