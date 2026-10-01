/**
 * CHAT-188: /history in the window reads the open conversation, secrets hidden, and a conversation id
 * that is not the person's own is "not found", never read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";

test("CHAT-188: /history works in the window for the open conversation only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-window-history-"));
  const provider = { name: "scripted", async complete() { return { content: "Noted the plan.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  const run = await app.runtime.run({ prompt: "Remember the garden plan" });
  const host = commandHost(app.runtime, app);
  const mine = await executeCommand(host, { surface: "window", line: "/history", access: "full", sessionId: run.sessionId });
  assert.match(mine.text, /Remember the garden plan/);
  assert.match(mine.text, /Noted the plan\./);
  const other = await executeCommand(host, { surface: "window", line: "/history", access: "full", sessionId: "not-a-conversation" });
  assert.match(other.text, /not found/);
});
