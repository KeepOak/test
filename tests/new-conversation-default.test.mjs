/* Q59/Q60: the owner's default for a new window conversation may be Ask first, Plan first, Auto, No approvals
   or "follow my rules". These drive the real window route (read the default, send it with the first message)
   against a real runtime with a scripted model, and check each guard still holds over the wider default. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readConversationMode } from "../dist/conversation-mode.js";
import { conversationModeApi } from "../dist/conversation-mode-api.js";
import { underShortLivedKey } from "../dist/key-context.js";

/** A model that writes the file named after "write" in the newest message, then says done. */
function writerModel() {
  return { name: "scripted", async complete(request) {
    const last = request.messages[request.messages.length - 1];
    const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    const file = /write (\S+)/.exec(asked)?.[1];
    if (last?.role === "tool" || !file) return { content: "done", toolCalls: [] };
    return { content: "", toolCalls: [{ id: `w${Math.random().toString(36).slice(2, 8)}`, name: "files.write",
      arguments: JSON.stringify({ path: file, content: "x" }) }] };
  } };
}

/** A real Branch with its server, and a helper that calls it the way the window does. */
async function realBranch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-new-conversation-"));
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "ws"), provider: writerModel() });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, call, server };
}

/** The run once it has stopped working. */
async function settled(app, id) {
  for (let i = 0; i < 200; i += 1) {
    const run = app.store.run(id);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${id} did not settle`);
}

/** What the window does: read the default it may start on, and send it with the first message. */
async function startInWindow(f, prompt) {
  const view = await f.call("/api/conversation-mode");
  assert.equal(view.status, 200);
  const mode = view.body.newConversation;
  const started = await f.call("/api/run", { prompt, ...(mode ? { mode } : {}) });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return { mode, run: await settled(f.app, started.body.id) };
}
const setDefault = async (f, value) => {
  const saved = await f.call("/api/conversation-mode/settings", { newConversation: value, confirmLoosening: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.newConversation, value);
};
const decision = (f, run, tool, args) => f.app.runtime.checkPolicy(tool, args, f.app.runtime.context({ runId: run.id })).decision;
const written = (f, file) => existsSync(join(f.app.runtime.workspace, file));
const git = { executable: "git", args: ["status"] };

test("Ask first stays the default, and every new choice is accepted", async (t) => {
  const f = await realBranch(t);
  assert.equal((await f.call("/api/conversation-mode")).body.settings.newConversation, "ask");
  for (const value of ["plan", "auto", "full", "follow", "ask"]) await setDefault(f, value);
  assert.equal((await f.call("/api/conversation-mode/settings", { newConversation: "anything" })).status, 400);
});

test("default Plan first: a new window conversation's write is refused, not asked about", async (t) => {
  const f = await realBranch(t);
  await setDefault(f, "plan");
  const { mode, run } = await startInWindow(f, "write plan.txt");
  assert.equal(mode, "plan");
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, run.sessionId).mode, "plan");
  assert.equal(written(f, "plan.txt"), false, "nothing was written");
  assert.notEqual(run.status, "needs_input", "the change was not asked about");
  assert.equal(decision(f, run, "files.write", { path: "plan.txt", content: "x" }), "deny", "a change is refused");
  assert.equal(decision(f, run, "files.read", { path: "plan.txt" }), "allow", "reading is free");
});

test("default Auto: a workspace write goes ahead and a command asks", async (t) => {
  const f = await realBranch(t);
  savePolicy(f.app.store, f.app.runtime.owner, { unmatchedCommands: "allow" });
  await setDefault(f, "auto");
  const { mode, run } = await startInWindow(f, "write auto.txt");
  assert.equal(mode, "auto");
  assert.equal(run.status, "completed");
  assert.equal(written(f, "auto.txt"), true, "the write inside the workspace went ahead");
  assert.equal(decision(f, run, "shell.execute", git), "ask", "a command asks, even with commands let through");
});

test("default No approvals: commands no rule covers still ask", async (t) => {
  const f = await realBranch(t);
  await setDefault(f, "full");
  const { mode, run } = await startInWindow(f, "write full.txt");
  assert.equal(mode, "full");
  assert.equal(written(f, "full.txt"), true, "the owner's own write goes ahead");
  assert.equal(decision(f, run, "shell.execute", git), "ask");
});

test("default Auto or No approvals: work started from outside is still held to Ask first", async (t) => {
  for (const value of ["auto", "full"]) {
    const f = await realBranch(t);
    await setDefault(f, value);
    const { run } = await startInWindow(f, `write ${value}-own.txt`);
    assert.equal(written(f, `${value}-own.txt`), true, `${value}: the owner's own task goes ahead`);
    const chat = await f.app.runtime.run({ prompt: `write ${value}-chat.txt`, sessionId: run.sessionId, source: "channel" });
    assert.equal((await settled(f.app, chat.id)).status, "needs_input", `${value}: a chat app's task in that conversation asks`);
    assert.equal(written(f, `${value}-chat.txt`), false);
    const trigger = await f.app.runtime.run({ prompt: `write ${value}-trigger.txt`, source: "trigger" });
    assert.equal((await settled(f.app, trigger.id)).status, "needs_input", `${value}: a trigger's new conversation asks`);
    assert.equal(written(f, `${value}-trigger.txt`), false);
  }
});

test("default No approvals: somebody else in the house gets the owner's setting, not No approvals", async (t) => {
  const f = await realBranch(t);
  savePolicy(f.app.store, f.app.runtime.owner, { preset: "ask-before-changes" });
  await setDefault(f, "full");
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => f.app.store.profiles.switch({ profileId: null }));
  const { mode, run } = await startInWindow(f, "write sam.txt");
  assert.equal(mode, null, "the window does not start their conversation on No approvals");
  assert.equal(run.status, "needs_input", "their write asks, as the owner's setting says");
  assert.equal(written(f, "sam.txt"), false);
  assert.equal((await f.call("/api/run", { prompt: "hello", mode: "full" })).status, 403, "nor can they send it themselves");
});

test("Lockdown on with default No approvals: a new conversation is still gated", async (t) => {
  const f = await realBranch(t);
  await setDefault(f, "full");
  assert.equal((await f.call("/api/lockdown", { on: true })).status, 200);
  const { mode, run } = await startInWindow(f, "write locked.txt");
  assert.notEqual(mode, "full", "the window does not start on No approvals under Lockdown");
  assert.equal(written(f, "locked.txt"), false, "nothing was written");
  assert.notEqual(run.status, "completed");
  assert.notEqual(decision(f, run, "files.write", { path: "locked.txt", content: "x" }), "allow");
  assert.notEqual(decision(f, run, "shell.execute", git), "allow");
});

test("Lockdown blocking the default starts on Ask first, so the conversation is not looser once Lockdown ends", async (t) => {
  /* NAS review of Q59: with the owner's setting at No approvals and the default Auto, a conversation started
     under Lockdown followed the owner's setting, and once Lockdown ended it browsed without asking. */
  const f = await realBranch(t);
  savePolicy(f.app.store, f.app.runtime.owner, { preset: "off" });
  await setDefault(f, "auto");
  assert.equal((await f.call("/api/lockdown", { on: true })).status, 200);
  const { mode, run } = await startInWindow(f, "hello");
  assert.equal(mode, "ask", "the window starts it on Ask first");
  assert.equal((await f.call("/api/lockdown", { on: false })).status, 200);
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, run.sessionId)?.mode, "ask");
  // Under the owner's No approvals these are allowed; on Ask first they still ask once Lockdown has ended.
  assert.equal(decision(f, run, "browser.click", { selector: "a" }), "ask", "a click still asks after Lockdown ends");
  assert.equal(decision(f, run, "files.write", { path: "x.txt", content: "x" }), "ask", "a write still asks after Lockdown ends");
});

test("Lockdown on: a window still showing the old default cannot start or pick No approvals or Auto", async (t) => {
  /* NAS adversarial check of DG-187: a window opened before Lockdown still offers the old default, and sends it. */
  const f = await realBranch(t);
  await setDefault(f, "full");
  const room = await startInWindow(f, "hello");
  assert.equal((await f.call("/api/lockdown", { on: true })).status, 200);
  for (const mode of ["full", "auto"]) {
    assert.equal((await f.call("/api/run", { prompt: "write stale.txt", mode })).status, 403, `a new ${mode} conversation is refused`);
    assert.equal((await f.call("/api/conversation-mode", { sessionId: room.run.sessionId, mode })).status, 403, `picking ${mode} is refused`);
  }
  assert.equal(written(f, "stale.txt"), false, "nothing was written");
});

test("an older conversation with no mode keeps following the owner's setting after the default changes", async (t) => {
  const f = await realBranch(t);
  await setDefault(f, "follow");
  const { mode, run } = await startInWindow(f, "write old.txt");
  assert.equal(mode, null);
  assert.equal(written(f, "old.txt"), true, "the owner's setting (No approvals) lets it write");
  await setDefault(f, "plan");
  const again = await f.call("/api/run", { prompt: "write old-again.txt", sessionId: run.sessionId });
  assert.equal(again.status, 200);
  assert.equal((await settled(f.app, again.body.id)).status, "completed");
  assert.equal(written(f, "old-again.txt"), true, "it still follows the owner's setting, not Plan first");
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, run.sessionId), null);
});

test("only the owner at this computer may save what new conversations start on", async (t) => {
  const f = await realBranch(t);
  const saved = async () => (await f.call("/api/conversation-mode")).body.settings.newConversation;
  const settingsUrl = new URL("/api/conversation-mode/settings", f.server.url);
  const post = (key) => fetch(settingsUrl, { method: "POST", body: JSON.stringify({ newConversation: "full", confirmLoosening: true }),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
  // The route's own check (src/conversation-mode-api.ts, `ownerHere`), with the server's doors out of the way:
  // a household profile and a short-lived key are each refused, and nothing is saved.
  const direct = () => conversationModeApi(f.app, "POST", new URL("http://local/api/conversation-mode/settings"),
    async () => ({ newConversation: "full" }));
  await assert.rejects(underShortLivedKey(direct), (error) => error.status === 403 && /Only the owner/.test(error.message),
    "a short-lived key is refused by the route itself");
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  await assert.rejects(direct(), (error) => error.status === 403 && /Only the owner/.test(error.message),
    "a household profile is refused by the route itself");
  // And over HTTP, where the server's doors answer first: the household door, then the short-lived key's.
  const byPerson = await post(f.server.token);
  assert.equal(byPerson.status, 400, "the household door refuses a household profile's save");
  f.app.store.profiles.switch({ profileId: null });
  const key = f.app.sessionTokens.create(f.app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const byKey = await post(key);
  assert.equal(byKey.status, 401, "a short-lived key's save is refused at the door");
  assert.equal(await saved(), "ask", "the default is unchanged by every refused save");
  assert.equal((await post(f.server.token)).status, 200, "the owner at this computer may save it");
  assert.equal(await saved(), "full");
});
