/**
 * Stopping the wake word (or any caller) aborts a faster-whisper request at once, whether it is still waiting its turn,
 * waiting for the worker to start, or in flight, and no request is written after its abort. A stand-in worker only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LocalWhisper } from "../dist/voice-whisper.js";

function fakeWorker() {
  const spawned = [];
  const start = () => {
    const child = new EventEmitter();
    child.written = []; child.killed = false;
    child.stdin = Object.assign(new EventEmitter(), { write: (line) => child.written.push(JSON.parse(line)), end() {} });
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() { return this; } });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() { return this; } });
    child.kill = () => { child.killed = true; };
    child.say = (value) => child.stdout.emit("data", `${JSON.stringify(value)}\n`);
    spawned.push(child);
    return child;
  };
  return { start, spawned };
}
const found = { available: true, python: "python3", model: "base", how: "" };
const sound = new Uint8Array([1, 2, 3]);
const settle = () => new Promise((done) => setImmediate(done));

test("an abort while the worker is starting ends the request at once and writes nothing", async () => {
  const worker = fakeWorker();
  const whisper = new LocalWhisper({}, worker.start);
  const stop = new AbortController();
  const asked = whisper.transcribe(found, sound, {}, stop.signal);
  await settle();
  assert.equal(worker.spawned.length, 1, "the worker is starting");
  const started = Date.now();
  stop.abort();
  await assert.rejects(asked, /cancelled/);
  assert.ok(Date.now() - started < 1000, "it did not wait for the startup limit");
  worker.spawned[0].say({ ready: true, vad: "none" });
  await settle();
  assert.deepEqual(worker.spawned[0].written, [], "no request reached the worker after its abort");
  whisper.stop();
});

test("an abort while waiting its turn behind another request writes nothing", async () => {
  const worker = fakeWorker();
  const whisper = new LocalWhisper({}, worker.start);
  const first = whisper.transcribe(found, sound, {});
  await settle();
  worker.spawned[0].say({ ready: true, vad: "none" });
  await settle();
  const stop = new AbortController();
  const queued = whisper.transcribe(found, sound, {}, stop.signal);
  stop.abort();
  worker.spawned[0].say({ id: worker.spawned[0].written[0].id, text: "first" });
  assert.equal((await first).text, "first");
  await assert.rejects(queued, /cancelled/);
  assert.equal(worker.spawned[0].written.length, 1, "only the first request was written");
  whisper.stop();
});

test("aborting a request that has already finished never ends the worker serving the next one", async () => {
  const worker = fakeWorker();
  const whisper = new LocalWhisper({}, worker.start);
  const stopA = new AbortController();
  const a = whisper.transcribe(found, sound, {}, stopA.signal);
  await settle();
  const child = worker.spawned[0];
  child.say({ ready: true, vad: "none" });
  await settle();
  child.say({ id: child.written[0].id, text: "A" });
  assert.equal((await a).text, "A");
  const b = whisper.transcribe(found, sound, {});
  await settle();
  stopA.abort(); // late, for a request that is done
  await settle();
  assert.equal(child.killed, false, "the worker serving B is left running");
  child.say({ id: child.written[1].id, text: "B" });
  assert.equal((await b).text, "B");
  assert.equal(worker.spawned.length, 1, "the same worker served both");
  whisper.stop();
});
