import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, readPolicy, savePolicy } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, tool, change) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-conversation-"));
  let calls = 0;
  const provider = {
    name: "scripted",
    async complete() {
      return calls++ === 0
        ? { content: "", toolCalls: [{ id: "settings-call", name: tool, arguments: JSON.stringify({ changes: [change] }) }] }
        : { content: "Finished the requested change.", toolCalls: [] };
    },
  };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  // The learning core ships when needed (the ship-on rule); these tests move it from off, so the owner switches it off first.
  app.learningCore.configure({ mode: "off" });
  t.after(async () => { await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  return { app, ask: (sessionId) => {
    calls = 0;
    return app.runtime.run({ prompt: "Change this Branch setting", ...(sessionId ? { sessionId } : {}) });
  } };
}

test("a conversation changes a supported setting only after the owner approves", async (t) => {
  const { app, ask } = await fixture(t, "settings.change", { setting: "fly-core.mode", value: "on" });
  const paused = await ask();
  assert.equal(paused.status, "needs_input", paused.output);
  assert.equal(app.learningCore.settings().mode, "off");
  assert.equal(app.runtime.approvals.questionFor(paused.sessionId).tool, "settings.change");
  app.runtime.approve(paused.sessionId, "allow", "session");
  const done = await ask(paused.sessionId);
  assert.equal(done.status, "completed", done.output);
  assert.equal(app.learningCore.settings().mode, "on");
});

test("denying a conversational settings request leaves its setting unchanged", async (t) => {
  const { app, ask } = await fixture(t, "settings.change", { setting: "fly-core.mode", value: "on" });
  const paused = await ask();
  assert.equal(paused.status, "needs_input", paused.output);
  app.runtime.approve(paused.sessionId, "deny", "session");
  const denied = await ask(paused.sessionId);
  assert.equal(denied.status, "completed", denied.output);
  assert.equal(app.learningCore.settings().mode, "off");
  assert.ok(app.store.events(denied.id).some((event) => event.kind === "policy.denied"));
});

test("a less-careful settings approval cannot become a remembered permission", async (t) => {
  const { app, ask } = await fixture(t, "settings.loosen", { setting: "policy.unmatchedCommands", value: "allow" });
  const paused = await ask();
  assert.equal(paused.status, "needs_input", paused.output);
  const waiting = app.runtime.approvals.questionFor(paused.sessionId);
  assert.equal(waiting.tool, "settings.loosen");
  assert.equal(waiting.remember, "never");
  assert.throws(() => app.runtime.approve(paused.sessionId, "allow", "session"), /once|kept|remember|time/i);
  app.runtime.approve(paused.sessionId, "allow", "never");
  const done = await ask(paused.sessionId);
  assert.equal(done.status, "completed", done.output);
  assert.equal(readPolicy(app.store, app.runtime.owner).unmatchedCommands, "allow");
  savePolicy(app.store, app.runtime.owner, { preset: "off", unmatchedCommands: "ask" });
  const again = await ask(paused.sessionId);
  assert.equal(again.status, "needs_input", again.output);
  assert.equal(readPolicy(app.store, app.runtime.owner).unmatchedCommands, "ask");
});
