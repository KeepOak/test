import test from "node:test";
import assert from "node:assert/strict";
import { ScriptLines } from "../dist/safety-extras/script-lines.js";

test("script frames are bounded across chunks and preserve split UTF-8", () => {
  const lines = []; let overflow = 0;
  const parser = new ScriptLines(line => lines.push(line), () => overflow++);
  const unicode = Buffer.from("hello 🌳\n");
  parser.push(unicode.subarray(0, 8)); parser.push(unicode.subarray(8));
  assert.deepEqual(lines, ["hello 🌳"]);
  parser.push(Buffer.alloc(40000, 97)); parser.push(Buffer.alloc(40000, 97));
  parser.push(Buffer.from("\nignored\n"));
  assert.equal(overflow, 1);
  assert.equal(lines.length, 1);
});
