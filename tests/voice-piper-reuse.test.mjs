// An installed Piper voice is loaded once and reused for each sentence. The "Piper" here is a
// stand-in script speaking Piper's stdin/stderr protocol; no sound is played.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { findPiper, LocalPiper } from "../dist/voice-piper.js";

async function fakePiper(root) {
  const program = join(root, "piper"), starts = join(root, "starts.txt");
  await writeFile(program, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.argv[process.argv.indexOf("--output-dir") + 1];
appendFileSync(${JSON.stringify(starts)}, "start\\n");
let n = 0, pending = "";
process.stdin.setEncoding("utf8");
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
  await writeFile(model, "x"); await writeFile(`${model}.json`, "{}");
  return { program, model, starts };
}

test("one installed voice answers every sentence without starting again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-piper-"));
  const piper = new LocalPiper();
  t.after(async () => { piper.stop(); await discardTemp(root); });
  const { program, model, starts } = await fakePiper(root);
  assert.equal(findPiper({ localVoiceExecutable: program, localVoiceModel: join(root, "missing.onnx") }), null,
    "a voice model that is not there is not offered");
  const found = findPiper({ localVoiceExecutable: program, localVoiceModel: model });
  assert.deepEqual(found, { executable: program, model });

  const one = await piper.speak(found, { text: "First sentence.", voice: "", speed: 1 });
  const two = await piper.speak(found, { text: "Second\nsentence.", voice: "", speed: 1 });
  assert.equal(one.route, "piper");
  assert.equal(one.cost.amount, 0);
  assert.equal(Buffer.from(one.bytes).subarray(44).toString(), "First sentence.");
  assert.equal(Buffer.from(two.bytes).subarray(44).toString(), "Second sentence.", "a line break never splits a request");
  assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 1, "the voice was loaded once");
});
