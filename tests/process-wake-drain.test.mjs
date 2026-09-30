/**
 * P0 (self-build): a program left running is settled once its output is in, not the moment it exits, so the wake-up
 * carries its last lines; and a last line printed without a newline still wakes the conversation. The program is a
 * stand-in whose exit, output and closing are played in the order under test; nothing is started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { Running } from "../dist/processes.js";

function standIn() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  return child;
}
function program(child, wake = { onExit: true, onText: [], wakes: 0 }) {
  const settled = [], lines = [];
  const running = new Running("the build", "node", "session", "run", child, null, 1_000_000, 5,
    (view) => settled.push({ view, output: running.output(1500).text }), wake, (_view, line) => lines.push(line));
  return { running, settled, lines };
}

test("output that arrives after the exit is in the program's last lines before anyone is told", async () => {
  const child = standIn();
  const { settled } = program(child);
  child.stdout.emit("data", Buffer.from("early line\n"));
  child.emit("exit", 0, null);
  assert.equal(settled.length, 0, "not settled at the exit: its output may still be coming");
  child.stdout.emit("data", Buffer.from("LATE LINE after the exit\n"));
  child.emit("close", 0, null);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].view.status, "finished");
  assert.match(settled[0].output, /early line\nLATE LINE after the exit/);
});

test("a program whose output stays open after it exits is settled a moment later all the same", async () => {
  const child = standIn();
  const { settled } = program(child);
  child.emit("exit", 3, null);
  await wait(400);
  assert.equal(settled.length, 1, "settled without its output closing");
  assert.equal(settled[0].view.status, "failed");
  assert.equal(settled[0].view.exitCode, 3);
});

test("a last line printed without a newline still wakes the conversation", async () => {
  const child = standIn();
  const { lines, settled } = program(child, { onExit: false, onText: ["build done"], wakes: 1 });
  child.stdout.emit("data", Buffer.from("compiling\nBUILD DONE in 1s"));
  assert.deepEqual(lines, [], "not yet: the line may still be going");
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  assert.deepEqual(lines, ["BUILD DONE in 1s"]);
  assert.equal(settled.length, 1);
});
