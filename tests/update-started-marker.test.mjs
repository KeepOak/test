/* A Beta update keeps the new version only once that version says it started (src/desktop/updater.ts startedMarker,
   written by markStarted); the hand-over script puts the old one back after 90 s otherwise. main.ts is Electron code,
   so its start paths are read here: each one that opens a window must say so, the joined one too. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("every start path that opens the window marks the new version started, including joining a background engine", async () => {
  const main = await readFile(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  const start = main.slice(main.indexOf("async function start("), main.indexOf("\n}\n", main.indexOf("async function start(")));
  const joined = start.slice(start.indexOf("if (running && runningKey) {"), start.indexOf("    return;\n  }"));
  assert.ok(joined.includes("await createWindow(running.url"), "the joined path opens the window");
  assert.match(joined, /await createWindow\(running\.url[\s\S]*void markStarted\(updateScratchDir\(\), app\.getVersion\(\)\)/,
    "joined to the background engine, the new version says it started after its window is up");
  const own = start.slice(start.indexOf("    return;\n  }"));
  assert.match(own, /await createWindow\(url[\s\S]*void markStarted\(updateScratchDir\(\), app\.getVersion\(\)\)/, "its own engine too");
  assert.equal((start.match(/void markStarted\(/g) ?? []).length, 2);
});
