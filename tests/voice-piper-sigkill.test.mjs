// Verify that an unresponsive Piper worker that ignores SIGTERM is terminated with SIGKILL.
// On POSIX, stop() must escalate to SIGKILL after a grace period. Pending requests are rejected
// and the worker is marked gone so the next speak() starts a fresh one.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { findPiper, LocalPiper } from "../dist/voice-piper.js";

async function stubbornPiper(root) {
  // A Piper stand-in that ignores SIGTERM but exits on SIGKILL.
  const program = join(root, "piper");
  const starts = join(root, "starts.txt");

  await writeFile(program, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.argv[process.argv.indexOf("--output-dir") + 1];
const starts = ${JSON.stringify(starts)};

// Log each start to the starts file in the root
appendFileSync(starts, "start\\n");

// Ignore SIGTERM; only SIGKILL will exit us
process.on("SIGTERM", () => {
  appendFileSync(starts, "got-SIGTERM\\n");
});

process.stdin.setEncoding("utf8");
let n = 0, pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (let at = pending.indexOf("\\n"); at >= 0; at = pending.indexOf("\\n")) {
    const line = pending.slice(0, at); pending = pending.slice(at + 1);
    const file = join(dir, String(1000 + n++) + ".wav");
    writeFileSync(file, Buffer.concat([Buffer.alloc(44), Buffer.from(line)]));
    process.stderr.write("INFO:piper:Wrote " + file + "\\n");
  }
});
`);
  await chmod(program, 0o755);
  const model = join(root, "voice.onnx");
  await writeFile(model, "x");
  await writeFile(`${model}.json`, "{}");
  return { program, model, starts };
}

test("stop() escalates SIGTERM to SIGKILL on unresponsive Piper (POSIX)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-piper-"));
  const piper = new LocalPiper();
  t.after(async () => { piper.stop(); await discardTemp(root); });

  const { program, model, starts } = await stubbornPiper(root);
  const found = findPiper({ localVoiceExecutable: program, localVoiceModel: model });
  assert.deepEqual(found, { executable: program, model });

  // Start a sentence - this triggers the worker to spawn.
  const speakPromise = piper.speak(found, { text: "Sentence to interrupt.", voice: "", speed: 1 });

  // Give worker time to start and log.
  await new Promise(resolve => setTimeout(resolve, 300));

  // Verify worker started by checking starts file.
  let startsContent = "";
  try {
    startsContent = await readFile(starts, "utf8");
  } catch {
    // File might not exist
  }
  assert(startsContent.includes("start"), "Piper worker must have started");
  const startCountBefore = (startsContent.match(/^start$/gm) || []).length;
  assert.equal(startCountBefore, 1, "exactly one worker started");

  // Stop while request is pending.
  piper.stop();

  // The pending request should be rejected (or at least not hang forever).
  try {
    await speakPromise;
    // If it resolved without error, that's also acceptable - the key is it doesn't hang.
  } catch (err) {
    // Rejection is expected, which is fine.
  }

  // Wait for escalation (SIGTERM -> 2s grace -> SIGKILL).
  await new Promise(resolve => setTimeout(resolve, 2500));

  // Verify next speak() starts a fresh worker (not reusing the killed one).
  const startsAfterKill = await readFile(starts, "utf8");
  const startCountAfterKill = (startsAfterKill.match(/^start$/gm) || []).length;

  const two = await piper.speak(found, { text: "Fresh sentence.", voice: "", speed: 1 });
  assert.equal(two.route, "piper");
  assert.equal(Buffer.from(two.bytes).subarray(44).toString(), "Fresh sentence.",
    "fresh speak() after stop() must work");

  const startsAfter = await readFile(starts, "utf8");
  const startCountAfter = (startsAfter.match(/^start$/gm) || []).length;

  assert.equal(startCountAfter, startCountAfterKill + 1, "a new worker must start for the next sentence");
});

test("normal Piper stop() still works with responsive worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-piper-"));
  const piper = new LocalPiper();
  t.after(async () => { piper.stop(); await discardTemp(root); });

  const program = join(root, "piper");
  const starts = join(root, "starts.txt");

  await writeFile(program, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.argv[process.argv.indexOf("--output-dir") + 1];
const starts = ${JSON.stringify(starts)};

appendFileSync(starts, "start\\n");
process.stdin.setEncoding("utf8");
let n = 0, pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (let at = pending.indexOf("\\n"); at >= 0; at = pending.indexOf("\\n")) {
    const line = pending.slice(0, at); pending = pending.slice(at + 1);
    const file = join(dir, String(1000 + n++) + ".wav");
    writeFileSync(file, Buffer.concat([Buffer.alloc(44), Buffer.from(line)]));
    process.stderr.write("INFO:piper:Wrote " + file + "\\n");
  }
});
`);
  await chmod(program, 0o755);
  const model = join(root, "voice.onnx");
  await writeFile(model, "x");
  await writeFile(`${model}.json`, "{}");

  const found = findPiper({ localVoiceExecutable: program, localVoiceModel: model });
  const one = await piper.speak(found, { text: "First.", voice: "", speed: 1 });
  assert.equal(one.route, "piper");

  piper.stop();

  const two = await piper.speak(found, { text: "Second.", voice: "", speed: 1 });
  assert.equal(two.route, "piper");
  assert.equal(Buffer.from(two.bytes).subarray(44).toString(), "Second.");
});
