import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { practiceRunsEnabled, savePracticeRuns } from "../dist/practice-runs.js";
import { CliAgentProvider } from "../dist/providers/cli-agent.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "practice-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.coding.setMode("read-first", "off");
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const call = (id, name, args = {}) => ({ id, name, arguments: JSON.stringify(args) });
const tools = (...toolCalls) => ({ content: "", toolCalls });
const done = { content: "These are the proposed changes.", toolCalls: [] };

test("availability defaults on, persists by owner, and refuses new practice before any model call", async (t) => {
  let calls = 0;
  const { app, root } = await fixture(t, { name: "scripted", async complete() { calls++; return done; } });
  assert.equal(practiceRunsEnabled(app.store, app.runtime.owner), true);
  assert.equal(savePracticeRuns(app.store, app.runtime.owner, { enabled: false }), false);
  assert.equal(practiceRunsEnabled(app.store, "other-owner"), true);
  assert.throws(() => savePracticeRuns(app.store, app.runtime.owner, { enabled: "false" }));
  await assert.rejects(app.runtime.run({ prompt: "practice", dryRun: true }), /Practice runs are switched off/);
  assert.equal(calls, 0);
  await app.runtime.run({ prompt: "ordinary" });
  assert.equal(calls, 1, "availability does not simulate or disable ordinary tasks");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const response = await fetch(server.url + "/api/practice-runs", { headers: { authorization: `Bearer ${server.token}` } });
  assert.deepEqual(await response.json(), { enabled: false });
});

test("practice reads for real, reports file/send/spend proposals, and changing availability mid-task never permits effects", async (t) => {
  let step = 0, reads = 0, effects = 0;
  const provider = { name: "scripted", async complete(request) {
    assert.match(String(request.messages[0].content), /practice run/);
    if (++step === 1) {
      savePracticeRuns(app.store, app.runtime.owner, { enabled: false });
      return tools(call("r", "practice.read"), call("w", "files.write", { path: "never.txt", content: "no" }),
        call("s", "practice.send"), call("p", "practice.spend"));
    }
    return done;
  } };
  const { app, root } = await fixture(t, provider);
  for (const name of ["read", "send", "spend"]) app.registry.register({
    name: `practice.${name}`, description: "isolated effect probe", parameters: z.object({}).strict(),
    permission: name === "read" ? "files.read" : "files.write", readOnly: name === "read",
    execute: async () => { if (name === "read") reads++; else effects++; return "probe"; },
  });
  const run = await app.runtime.run({ prompt: "read then propose file, message and payment changes", dryRun: true });
  assert.equal(run.status, "completed");
  assert.equal(reads, 1);
  assert.equal(effects, 0);
  await assert.rejects(readFile(join(root, "workspace", "never.txt")), /ENOENT/);
  const report = app.store.events(run.id).find((event) => event.kind === "dryrun.report");
  assert.deepEqual(report.data.actions.map((a) => a.tool).sort(), ["files.write", "practice.send", "practice.spend"]);
  assert.equal(report.data.count, 3);
});

test("an interrupted practice task remains practice after resume while new practice is off", async (t) => {
  let step = 0;
  const { app, root } = await fixture(t, { name: "scripted", async complete() {
    return ++step === 1 ? tools(call("w", "files.write", { path: "resumed.txt", content: "no" })) : done;
  } });
  const old = app.store.createRun(app.runtime.owner, "propose a file");
  app.store.message(old.sessionId, { role: "user", content: old.prompt });
  app.store.event(old.id, "run.started", { source: "owner", dryRun: true, permissions: [app.registry.permissionOf("files.write")],
    deadlineMs: 30_000, depth: 0, delegates: false, ownCopy: false });
  app.store.finish(old.id, "interrupted", "Paused before the proposal.");
  savePracticeRuns(app.store, app.runtime.owner, { enabled: false });
  const resumed = await app.runtime.resume(old.id);
  assert.equal(resumed.status, "completed");
  assert.equal(app.store.events(resumed.id).find((e) => e.kind === "run.started").data.dryRun, true);
  assert.equal(app.store.events(resumed.id).find((e) => e.kind === "dryrun.report").data.count, 1);
  await assert.rejects(readFile(join(root, "workspace", "resumed.txt")), /ENOENT/);
});

test("Practice never spawns an installed coding assistant with tools outside Branch's simulation", async (t) => {
  let spawned = 0;
  const provider = new CliAgentProvider({ id: "isolated", name: "probe", command: "fake", args: [], jsonField: "", note: "test" },
    {}, async () => { spawned++; return { code: 0, stdout: "Finished", stderr: "" }; });
  const { app } = await fixture(t, provider);
  const run = await app.runtime.run({ prompt: "practice file changes", dryRun: true });
  assert.equal(spawned, 0);
  assert.match(run.output, /Practice cannot use an installed coding assistant/);
  assert.equal(run.status, "failed");
});
