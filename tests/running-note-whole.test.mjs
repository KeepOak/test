/**
 * The "engine is running here" note (src/install/running.ts) is read by a window starting while the engine writes it.
 * Written in place, a read at that moment found an empty file: the window took it for no engine, and a test waiting for
 * the engine's note (tests/desktop-joined-engine.test.mjs) failed there. Every read sees no note or a whole one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { readRunning, runningFileName, writeRunning } from "../dist/install/running.js";

test("a note being written is never read half-written, and leaves nothing beside it", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-running-note-"));
  t.after(() => discardTemp(dataDir));
  const note = (pid) => ({ port: 43210, pid, url: "http://127.0.0.1:43210", mode: "daemon", version: "0.0.0" });
  await writeRunning(dataDir, note(1));
  let writing = true, reads = 0;
  const torn = [];
  const reader = (async () => {
    while (writing) {
      const text = await readFile(join(dataDir, runningFileName), "utf8").catch(() => null);
      reads += 1;
      if (text !== null) { try { JSON.parse(text); } catch { torn.push(text.length); } }
    }
  })();
  for (let pid = 2; pid <= 300; pid += 1) await writeRunning(dataDir, note(pid));
  writing = false;
  await reader;
  assert.ok(reads > 0);
  assert.deepEqual(torn, [], `every read was whole (${torn.length} of ${reads} were not)`);
  assert.equal((await readRunning(dataDir))?.pid, 300);
  assert.deepEqual(await readdir(dataDir), [runningFileName], "no copy is left beside the note");
});
