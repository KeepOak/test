/**
 * SELF-207: the nightly "add a knob" task passes only on the four real file edits, never on the assistant's report,
 * and the task is in the nightly suite. A stand-in context plays the engine: it keeps the files in memory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { selfDevelopmentTasks } from "../evals/tasks/self-development-knob.mjs";
import { allTasks } from "../evals/tasks/index.mjs";

const task = selfDevelopmentTasks[0];
const fixture = (name) => readFile(new URL(`../evals/fixtures/self-development-knob/${name}`, import.meta.url), "utf8");

async function verdict(edit) {
  const files = new Map();
  const ctx = { write: async (path, text) => { files.set(path, text); }, read: async (path) => files.get(path) ?? null,
    ask: async () => { await edit(files); return { status: "completed", answer: "Done, I added the knob." }; } };
  const { checks } = await task.run(ctx);
  return checks.filter((one) => !one.ok).map((one) => one.name ?? one.label ?? JSON.stringify(one));
}

test("SELF-207: the knob task passes on the real four-file change and fails when the files were not changed", async () => {
  assert.ok(allTasks().some((one) => one.id === "self-development-add-knob"), "in the nightly suite");
  const settingsMjs = await fixture("settings.mjs");
  const right = async (files) => {
    files.set("knob-app/settings.json", JSON.stringify({ showTimestamp: true, compactMode: false }));
    files.set("knob-app/settings.schema.json", JSON.stringify({ type: "object", additionalProperties: false, required: ["showTimestamp", "compactMode"],
      properties: { showTimestamp: { type: "boolean", default: true }, compactMode: { type: "boolean", default: false } } }));
    files.set("knob-app/controls.json", JSON.stringify([{ key: "showTimestamp", type: "toggle", label: "Show timestamp" },
      { key: "compactMode", type: "toggle", label: "Compact mode" }]));
    files.set("knob-app/settings.mjs", settingsMjs + "\nexport function compactModeEnabled(settings) {\n  return settings.compactMode === true;\n}\n");
  };
  assert.deepEqual(await verdict(right), []);
  assert.equal((await verdict(async () => {})).length, 4, "a claim with no edits fails every file check");
});
