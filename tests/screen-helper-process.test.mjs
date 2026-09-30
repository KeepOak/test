/**
 * computer-control: the resident helper that runs Windows screen actions (DesktopHelper in
 * src/integrations/desktop-script.ts), driven here with a stand-in program written in Node, so nothing reaches a
 * screen. One program answers many actions in turn; a stray line is passed over; a refusal comes back word for word;
 * an action that never answers ends the program and the next starts a fresh one; one stopped while it waits never
 * reaches the program.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DesktopHelper } from "../dist/integrations/desktop-script.js";

const standIn = String.raw`
const seen = [];
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdout.write('{"id":0,"ok":true,"result":{"ready":true}}\n');
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const [id, action, body] = buffer.slice(0, at).split(" ");
    buffer = buffer.slice(at + 1);
    seen.push(action);
    const payload = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
    if (action === "read") continue; // never answers
    if (action === "click") process.stdout.write("a line a step printed by itself\n");
    const answer = action === "key" ? { id: Number(id), ok: false, error: "That spot is not on any screen, so nothing was done." }
      : { id: Number(id), ok: true, result: { action, payload, pid: process.pid, seen } };
    process.stdout.write(JSON.stringify(answer) + "\r\n");
  }
});
`;

const helper = (limitMs = 5000) => new DesktopHelper(async () => ({ executable: process.execPath, args: ["-e", standIn] }), limitMs);

test("one program answers every action in turn, passing over stray lines and giving back refusals word for word", async (t) => {
  const resident = helper();
  t.after(() => resident.close());
  const signal = () => AbortSignal.timeout(20000);
  const [first, second] = await Promise.all([resident.run("windows", { a: "ü" }, signal()), resident.run("click", { name: "Stop" }, signal())]);
  assert.deepEqual(first.payload, { a: "ü" }, "the request's body travels whole");
  assert.equal(second.action, "click", "a stray line before the answer is passed over");
  assert.equal(first.pid, second.pid, "one program for both");
  assert.deepEqual(second.seen, ["windows", "click"], "one at a time, in order");
  await assert.rejects(resident.run("key", {}, signal()), /^Error: That spot is not on any screen, so nothing was done\.$/);
  assert.equal((await resident.run("windows", {}, signal())).pid, first.pid, "a refusal leaves the program running");
});

test("an action that never answers ends the program, the next starts afresh, and one stopped while waiting is never sent", async (t) => {
  const resident = helper(1500);
  t.after(() => resident.close());
  const before = await resident.run("windows", {}, AbortSignal.timeout(20000));
  const stopped = new AbortController();
  const hung = resident.run("read", {}, AbortSignal.timeout(20000));
  const queued = resident.run("zoom", {}, stopped.signal);
  stopped.abort();
  await assert.rejects(hung, /did not answer in time/);
  await assert.rejects(queued, /stopped before it finished/);
  const after = await resident.run("windows", {}, AbortSignal.timeout(20000));
  assert.notEqual(after.pid, before.pid, "a fresh program");
  assert.deepEqual(after.seen, ["windows"], "the stopped action never reached any program");
  resident.close();
  await assert.rejects(resident.run("windows", {}, AbortSignal.timeout(1000)), /closed/);
});
