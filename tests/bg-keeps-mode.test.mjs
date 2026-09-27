/**
 * Redesign security review: a /bg task is held to the conversation it was started from. With the owner's rules on
 * No approvals and the conversation on Ask first, the background task stops before its first write, as the conversation
 * would. From the window with no conversation it takes the owner's choice for a new one; from another surface with none it
 * follows the owner's rules, as before. A scripted model; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readConversationMode } from "../dist/conversation-mode.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-bg-mode-"));
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { content: "Written.", toolCalls: [] };
    if (last?.role === "user" && /write the note/.test(String(last.content)))
      return { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(server.url + path, { method: "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = await response.json();
    if (response.status !== 200) throw new Error(`${response.status} ${answer.error}`);
    return answer;
  };
  await api("/api/commands/settings", { mode: "on" });
  await api("/api/autonomy/switch", { part: "session-commands", mode: "on" });
  await api("/api/policy", { preset: "off" });
  return { app, api, workspace };
}
async function backgroundRun(app, prompt) {
  for (let tries = 0; tries < 100; tries++) {
    const run = app.store.runs(app.runtime.owner).find((one) => one.prompt === prompt);
    if (run && run.status !== "running" && run.status !== "queued") return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the background task never settled");
}

test("a /bg task from an Ask first conversation stops before its first write, though the rules are No approvals", async (t) => {
  const { app, api, workspace } = await fixture(t);
  const first = await api("/api/run", { prompt: "Hello", mode: "ask" });
  const said = await api("/api/commands/run", { surface: "window", line: "/bg write the note", sessionId: first.sessionId });
  assert.match(said.text, /separate conversation/);
  const run = await backgroundRun(app, "write the note");
  assert.notEqual(run.sessionId, first.sessionId);
  assert.equal(readConversationMode(app.store, app.runtime.owner, run.sessionId)?.mode, "ask", "held to the conversation it came from");
  assert.equal(run.status, "needs_input", "it stopped to ask");
  assert.equal(existsSync(join(workspace, "note.txt")), false, "nothing was written");
});

test("from the window with no conversation it takes the owner's choice for a new one; from the phone it follows the rules, as before", async (t) => {
  const { app, api } = await fixture(t);
  await api("/api/commands/run", { surface: "window", line: "/bg write the note" });
  const fromWindow = await backgroundRun(app, "write the note");
  assert.equal(readConversationMode(app.store, app.runtime.owner, fromWindow.sessionId)?.mode, "ask");
  await api("/api/commands/run", { surface: "phone", line: "/bg say hello" });
  const fromPhone = await backgroundRun(app, "say hello");
  assert.equal(readConversationMode(app.store, app.runtime.owner, fromPhone.sessionId), null, "another surface follows the owner's rules, as before");
});
