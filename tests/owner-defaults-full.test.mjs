/**
 * Owner ruling (2026-09-30): the owner's new conversations start on Full access, as Hermes Agent's CLI and OpenClaw's main
 * session give their owner, and the owner's own schedules and check-ins run as Hermes Agent's cron jobs do: the owner's
 * tools and approval setting, with sending, asking and scheduling left out. Somebody else in the house, a short-lived key
 * and a chat keep their questions. Every model here is a scripted fake and no command really runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { discardTemp } from "./temp-dir.mjs";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-defaults-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "run a command (fake)",
    parameters: z.object({ executable: z.string(), args: z.array(z.string()).default([]) }).strict(), execute: async () => ({ ok: true }) });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const decide = (runId, tool, args) => app.runtime.checkPolicy(tool, args, app.runtime.context({ runId })).decision;
  return { app, call, decide };
}
const dueAt = () => new Date(Date.now() + 86400000).toISOString();
const shell = (line) => { const [executable, ...args] = line.split(" "); return { executable, args }; };
const started = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started").data;

test("the owner's new conversation starts on Full access; somebody else in the house cannot start on it", async (t) => {
  const { app, call } = await served(t);
  const view = (await call("/api/conversation-mode")).body;
  assert.equal(view.newConversation, "full");
  assert.equal(view.settings.newConversation, "full");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const theirs = (await call("/api/conversation-mode")).body;
  assert.equal(theirs.choices.find((choice) => choice.mode === "full").available, false, "Full access is the owner's alone");
  assert.notEqual(theirs.newConversation, "full", "a household person's new conversation does not start on it");
  assert.equal((await call("/api/run", { prompt: "hello", mode: "full" })).status, 403, "and cannot ask for it");
});

test("the owner's own schedule writes and runs commands without asking; a dangerous command still asks", async (t) => {
  const { app, decide } = await served(t);
  const owners = await app.runtime.run({ prompt: "hello" });
  const made = app.scheduler.create(app.runtime.context({ runId: owners.id }), { prompt: "tidy the notes folder every hour", kind: "task", dueAt: dueAt() });
  const record = app.store.get("schedules", app.runtime.owner, made.id);
  assert.equal(record.data.ownerMade, true);
  assert.ok(record.data.permissions.includes("files.write") && record.data.permissions.includes("shell.execute"), "the owner's tools");
  assert.ok(!record.data.permissions.includes("channels.send") && !record.data.permissions.includes("user.ask"), "less sending and asking, as Hermes's cron jobs");
  const run = await app.scheduler.trigger(app.runtime.owner, made.id, undefined, "local");
  assert.equal(started(app, run.id).source, "schedule");
  assert.equal(started(app, run.id).ownerSchedule, true);
  assert.equal(decide(run.id, "files.write", { path: "notes/a.txt", content: "x" }), "allow", "a change goes ahead");
  assert.equal(decide(run.id, "shell.execute", shell("npm test")), "allow", "an ordinary command goes ahead");
  assert.equal(decide(run.id, "shell.execute", shell("rm -rf ~/notes")), "ask", "a dangerous command waits for the owner");
});

test("a short-lived key's schedule stays held to Ask before changes", async (t) => {
  const { app, decide } = await served(t);
  const keyed = await underShortLivedKey(() => app.runtime.run({ prompt: "hello" }));
  const made = underShortLivedKey(() => app.scheduler.create(app.runtime.context({ runId: keyed.id }),
    { prompt: "tidy the notes folder every hour", kind: "task", dueAt: dueAt() }));
  const record = app.store.get("schedules", app.runtime.owner, made.id);
  assert.notEqual(record.data.ownerMade, true);
  assert.ok(!record.data.permissions.includes("shell.execute"), "the least its words need");
  const run = await app.scheduler.trigger(app.runtime.owner, made.id, undefined, "local");
  assert.notEqual(started(app, run.id).ownerSchedule, true);
  assert.equal(decide(run.id, "files.write", { path: "notes/a.txt", content: "x" }), "ask");
});

test("a task started from a chat asks before a change, and a schedule record cannot be passed off as the owner's", async (t) => {
  const { app, decide } = await served(t);
  const chat = await app.runtime.run({ prompt: "from a chat", source: "channel" });
  assert.equal(decide(chat.id, "files.write", { path: "a.txt", content: "x" }), "ask", "a stranger's chat asks");
  const outside = await app.runtime.run({ prompt: "from a trigger", source: "trigger", ownerSchedule: true });
  assert.notEqual(started(app, outside.id).ownerSchedule, true, "only a schedule's source can carry the mark");
  assert.equal(decide(outside.id, "files.write", { path: "a.txt", content: "x" }), "ask");
});
