// The installed keyword spotter stays loaded and reports keywords as numbered JSON on its error
// output, sometimes wrapped across lines. No microphone is opened: the "program" is a stand-in
// script that writes what the real one would.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { wakeSpotter } from "../dist/voice-wake.js";
import { wakeStreamRunner } from "../dist/voice-wake-host.js";

const wake = { mode: "on", word: "hey branch", sureness: 80, keywordModel: "", keywordFile: "", confirmationFrames: 3, windowSeconds: 2 };

test("an owner's keyword model and keyword file choose the loaded keyword spotter", async (t) => {
  const model = await mkdtemp(join(tmpdir(), "branch-kws-"));
  t.after(() => discardTemp(model));
  for (const name of ["encoder-epoch-12.onnx", "decoder-epoch-12.onnx", "joiner-epoch-12.onnx", "tokens.txt"])
    await writeFile(join(model, name), "x");
  await writeFile(join(model, "keywords.txt"), "▁HE Y ▁BR AN CH @HEY_BRANCH\n");
  const voice = { localSpeechModel: model, localSpeechExecutable: "", localSpeechKind: "" };
  const spotter = wakeSpotter(voice, wake, "darwin", false, (file) => file === "sherpa-onnx-keyword-spotter-microphone");
  assert.equal(spotter.kind, "streaming-keyword");
  assert.equal(spotter.command.file, "sherpa-onnx-keyword-spotter-microphone");
  assert.ok(spotter.command.args.includes(`--keywords-file=${join(model, "keywords.txt")}`));
  assert.ok(spotter.command.args.includes("--num-trailing-blanks=3"));
  const without = wakeSpotter(voice, wake, "darwin", false, () => false);
  assert.notEqual(without.kind, "streaming-keyword", "without the program it is not offered");
});

test("keywords wrapped across lines are read once, and diagnostics never become a wake", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-kws-run-"));
  t.after(() => discardTemp(root));
  await mkdir(root, { recursive: true });
  const program = join(root, "fake-kws");
  await writeFile(program, `#!${process.execPath}
process.stderr.write("OnlineKeywordSpotterConfig(tokens=...) {not json}\\n");
process.stderr.write('0:{"start_time":1.2, "keyword": "HEY_');
setTimeout(() => { process.stderr.write('\\nBRANCH", "timestamps":[1.2]}\\n'); }, 20);
setTimeout(() => process.exit(0), 60);
`);
  await chmod(program, 0o755);
  const words = [];
  await wakeStreamRunner()({ file: program, args: [], env: {} }, (word) => words.push(word), new AbortController().signal);
  assert.deepEqual(words, ["HEY_BRANCH"]);
});
