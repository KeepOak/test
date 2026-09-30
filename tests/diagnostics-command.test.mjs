// CHAT-199: /diagnostics (or /debug) saves a local metadata report in the data home and says only its file name; the
// report holds no messages, and a second one within the minute is refused. A plain chat app is never offered it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { lookup } from "../dist/commands/catalog.js";

test("/debug saves a metadata-only report, names only its file, and waits a minute before another", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-diagnostics-"));
  const provider = { name: "scripted", async complete() { return { content: "secret-looking answer words", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  await app.runtime.run({ prompt: "a private question about my taxes" });
  const host = commandHost(app.runtime, app);
  const made = await executeCommand(host, { surface: "terminal", line: "/debug", access: "full" });
  const name = /branch-diagnostics-[\w-]+\.json/.exec(made.text)?.[0];
  assert.ok(name, made.text);
  const folder = join(app.runtime.store.folder, "diagnostics");
  assert.deepEqual(await readdir(folder), [name]);
  const text = await readFile(join(folder, name), "utf8"), report = JSON.parse(text);
  assert.equal(report.checksRun, false);
  assert.equal(report.tasks.sampled, 1);
  assert.doesNotMatch(text, /taxes|secret-looking/, "no prompt or answer words");
  const again = await executeCommand(host, { surface: "terminal", line: "/diagnostics about", access: "full" });
  assert.match(again.text, /Wait one minute/);
  assert.equal((await readdir(folder)).length, 1);
  assert.ok(!lookup("diagnostics").surfaces.includes("chat"), "only the owner's own DM reaches it from chat");
});
