import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { writeWhole } from "../dist/integrations/browser-profiles.js";

test("a saved sign-in that fails part-way leaves the earlier one whole and nothing half-written", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-profile-write-"));
  t.after(() => discardTemp(root));
  const file = join(root, "work.bin");
  await writeFile(file, "the earlier sign-in");
  async function* failing() { yield Buffer.from("half of a new sign-in"); throw new Error("disk full"); }
  await assert.rejects(writeWhole(file, failing()), /disk full/);
  assert.equal(await readFile(file, "utf8"), "the earlier sign-in");
  assert.deepEqual(await readdir(root), ["work.bin"], "no partial file is left behind");
  await writeWhole(file, Buffer.from("the new sign-in"));
  assert.equal(await readFile(file, "utf8"), "the new sign-in");
});
