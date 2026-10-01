/**
 * UP-RESEARCH-063: the Piper picker lists one folder the owner chose: folders and files for the program, folders and
 * .onnx files for a voice. It reads no file's contents and runs nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { piperFiles } from "../dist/voice-piper-files.js";

test("UP-RESEARCH-063: the Piper picker lists folders first, only .onnx voices for a model, and refuses a relative folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-piper-files-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "voices"));
  await writeFile(join(root, "piper"), "");
  await writeFile(join(root, "en_GB-alba.onnx"), "");
  await writeFile(join(root, "en_GB-alba.onnx.json"), "{}");
  const models = await piperFiles({ directory: root, kind: "model" });
  assert.deepEqual(models.entries.map((entry) => [entry.name, entry.directory]), [["voices", true], ["en_GB-alba.onnx", false]]);
  const programs = await piperFiles({ directory: root, kind: "executable" });
  assert.deepEqual(programs.entries.map((entry) => entry.name), ["voices", "en_GB-alba.onnx", "en_GB-alba.onnx.json", "piper"]);
  await assert.rejects(piperFiles({ directory: "voices", kind: "model" }), /absolute/);
  await assert.rejects(piperFiles({ directory: join(root, "missing"), kind: "model" }), /cannot be listed/);
});
