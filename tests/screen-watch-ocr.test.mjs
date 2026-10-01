/**
 * SCREEN-177: a screen watch may read the words in its rectangle (opt-in, local OCR) and say what text
 * changed. Without the opt-in no text is read at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { ScreenWatches, saveScreenWatchSettings } from "../dist/screen-watch.js";

test("SCREEN-177: an opted-in watch says which words changed; one without the opt-in reads nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-screen-ocr-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  saveScreenWatchSettings(app.store, owner, { enabled: true });
  let screen = new Uint8Array([1]), words = "Export 40%\nWorking";
  const read = [];
  const watches = new ScreenWatches(app.store, async () => screen, () => true, undefined, undefined,
    async (picture) => { read.push(picture[0]); return words; });
  const region = { x: 0, y: 0, width: 100, height: 40 };
  const plain = await watches.create(owner, { label: "Plain", region });
  const reading = await watches.create(owner, { label: "Export", region, readText: true });
  screen = new Uint8Array([2]); words = "Export 100%\nWorking";
  await watches.check(owner, plain.id);
  const changed = await watches.check(owner, reading.id);
  assert.equal(changed.changed, true);
  assert.match(changed.summary, /Before: Export 40%/);
  assert.match(changed.summary, /After: Export 100%/);
  assert.deepEqual(read, [1, 2], "only the opted-in watch was read, once when made and once when it changed");
});
