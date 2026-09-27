import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, locateGit, NetworkPolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { MemoryHistory, describeMemoryChange, MemoryHistorySettingsSchema, readNote } from "../dist/memory-git.js";
import { GitRunner } from "../dist/integrations/git-run.js";
import { discardTemp } from "./temp-dir.mjs";

/* bucket-18 (A2317): what is remembered, versioned with Git in the data folder. Real Git, temp folders only. */
const git = await locateGit();
const skip = git ? false : "Git is not installed";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-memory-history-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir, provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const first = [];
  t.after(async () => { for (const close of first) await close(); await app.close(); await discardTemp(root); });
  return { app, workspace, dataDir, owner: app.runtime.owner, first };
}
const remember = (app, text, kind = "preference") => app.runtime.executeTool("memory.put", { text, source: "a test", kind });

test("A2317 ships when needed; switched off, nothing is written and the tools refuse", { skip }, async (t) => {
  const { app, dataDir, owner } = await fixture(t);
  // The ship-on rule: memory history ships "when needed" (src/memory-git.ts); the owner switches it off.
  assert.equal(app.memoryHistory.settings(owner).mode, "when-needed");
  app.memoryHistory.configure(owner, { mode: "off" });
  assert.equal(app.memoryHistory.settings(owner).mode, "off");
  await remember(app, "Likes tea");
  assert.equal(await app.memoryHistory.record(owner), null);
  assert.equal(existsSync(join(dataDir, "memory-history")), false);
  await assert.rejects(app.runtime.executeTool("memory.versions", {}), /switched off/);
});

test("A2317 on: one version per change, with a plain message, readable at any version, never in the workspace", { skip }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  app.memoryHistory.configure(owner, { mode: "on" });
  // Saving a fact is itself a small task, and its end records a version; record() waits its turn behind it.
  await remember(app, "Likes tea");
  await app.memoryHistory.record(owner);
  const [first] = await app.memoryHistory.versions();
  assert.match(first.message, /^Remembered 1 fact: \d+ lines added, 0 removed, in 1 note$/);
  assert.equal(await app.memoryHistory.record(owner), null, "nothing changed, so no new version");

  await remember(app, "Works on the Branch project", "fact-about-person");
  await app.memoryHistory.record(owner);
  const [second] = await app.memoryHistory.versions();
  assert.match(second.message, /^Remembered 2 facts: \d+ lines added, 0 removed, in 1 note$/);

  const listed = await app.runtime.executeTool("memory.versions", {});
  assert.deepEqual(listed.versions.map((version) => version.commit), [second.commit, first.commit], "one version per change");
  assert.equal(listed.versions[1].files, 1);
  assert.ok(listed.lastRecorded);

  const then = await app.runtime.executeTool("memory.version_note", { version: first.commit, kind: "preference" });
  assert.match(then.text, /- Likes tea/);
  await assert.rejects(app.runtime.executeTool("memory.version_note", { version: first.commit, kind: "fact-about-person" }), /no note of that kind/);
  const now = await app.runtime.executeTool("memory.version_note", { version: second.commit, kind: "fact-about-person" });
  assert.match(now.text, /Works on the Branch project/);

  assert.deepEqual(await readdir(workspace), [], "the workspace grew nothing, and no repository was made in it");
});

test("A2317 a finished task records a version by itself", { skip }, async (t) => {
  const { app, owner } = await fixture(t);
  app.memoryHistory.configure(owner, { mode: "when-needed" });
  app.store.save("memory", owner, "fact-1", { text: "Prefers short answers", source: "a test", kind: "preference" });
  assert.equal((await app.memoryHistory.versions()).length, 0);
  await app.runtime.run({ prompt: "say hello" });
  for (let waited = 0; waited < 100 && !(await app.memoryHistory.versions()).length; waited++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await app.memoryHistory.versions()).length, 1);
});

test("A2317 a copy goes only where the owner and the network rules allow, and a problem is kept, not hidden", { skip }, async (t) => {
  assert.equal(MemoryHistorySettingsSchema.safeParse({ remote: "https://user:pw@example.com/x.git" }).success, false);
  assert.equal(MemoryHistorySettingsSchema.safeParse({ remote: "https://token@example.com/x.git" }).success, false);
  assert.equal(MemoryHistorySettingsSchema.safeParse({ remote: "file:///tmp/x" }).success, false);
  assert.equal(MemoryHistorySettingsSchema.safeParse({ remote: "git@github.com:me/memory.git" }).success, true);

  const { app, dataDir, owner, first } = await fixture(t);
  const calls = [];
  const fakeGit = async (options) => {
    calls.push(options.args);
    return { status: "completed", stdout: options.args[0] === "diff" ? "3\t0\tpreference.md\n" : "", stderr: "", exitCode: 0, command: "git" };
  };
  const blocked = new NetworkPolicy({ allowPrivateAddresses: true, blockedHosts: ["example.com"] });
  const history = new MemoryHistory(join(dataDir, "other"), app.store, { grouped: () => new Map() }, fakeGit, blocked);
  history.configure(owner, { mode: "on", remote: "https://example.com/me/memory.git" });
  await history.record(owner);
  assert.equal(calls.some((args) => args[0] === "push"), false, "nothing was sent to a blocked address");
  assert.match(history.status(owner).lastProblem, /blocked list/);

  const server = await startServer(app, { dataDir, port: 0 });
  first.push(() => server.close());
  const key = app.sessionTokens.create(owner, { scope: "run", minutes: 5 }).token;
  const refused = await fetch(`${server.url}/api/memory/history`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ remote: "https://attacker.example/steal.git" }),
  });
  assert.equal(refused.status, 401, "a script's key cannot name where the history goes");
});

test("A2317 a task that changes nothing remembered runs no Git; a change, or a version that failed, still records", { skip }, async (t) => {
  // It ships on and every finished task records, so a task that remembers nothing must not wait on Git processes.
  const { app, dataDir, owner } = await fixture(t);
  const runner = new GitRunner();
  const calls = [];
  let failCommit = false;
  const counted = async (options, signal) => {
    calls.push(options.args.find((arg) => !arg.startsWith("-") && !arg.includes("=")));
    if (failCommit && options.args.includes("commit")) return { status: "failed", stdout: "", stderr: "disk full", exitCode: 1, command: "git" };
    return runner.run(options, signal);
  };
  const history = new MemoryHistory(join(dataDir, "counted"), app.store, app.memoryMirror, counted);
  history.configure(owner, { mode: "on" });
  app.store.save("memory", owner, "fact-1", { text: "Likes tea", source: "a test", kind: "preference" });
  assert.ok(await history.record(owner), "the first version");
  calls.length = 0;
  assert.equal(await history.record(owner), null);
  assert.deepEqual(calls, [], "nothing changed: no Git at all");

  app.store.save("memory", owner, "fact-2", { text: "Works late", source: "a test", kind: "preference" });
  failCommit = true;
  assert.equal(await history.record(owner), null, "the commit failed");
  assert.match(history.status(owner).lastProblem, /disk full/);
  failCommit = false;
  const retried = await history.record(owner);
  assert.ok(retried, "the notes on disk already changed, and the failed version is recorded on the next try");
  assert.match(retried.message, /^Remembered 2 facts/);
});

test("A2317 the change message counts lines and facts", () => {
  const counts = new Map([["preference", 2], ["project-note", 1]]);
  assert.equal(describeMemoryChange("2\t1\tpreference.md\n1\t0\tproject-note.md\n", counts), "Remembered 3 facts: 3 lines added, 1 removed, in 2 notes");
});

test("A2317 review: a key someone asked to be remembered is never committed, and a copy can be switched off again", { skip }, async (t) => {
  const { app, owner } = await fixture(t);
  app.memoryHistory.configure(owner, { mode: "on", remote: "git@github.com:me/memory.git" });
  const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
  app.store.save("memory", owner, "fact-key", { text: `The deploy token is ${secret}`, source: "a test", kind: "preference" });
  app.memoryHistory.configure(owner, { remote: null });
  assert.equal(app.memoryHistory.settings(owner).remote, undefined, "null clears the copy");
  await app.memoryHistory.record(owner);
  const [version] = await app.memoryHistory.versions();
  assert.ok(version, "a version was recorded");
  const note = await readNote(app.memoryHistory, "preference");
  assert.match(note, /The deploy token is/);
  assert.equal(note.includes(secret), false, "the key itself is not in the note");
  const then = await app.runtime.executeTool("memory.version_note", { version: version.commit, kind: "preference" });
  assert.equal(then.text.includes(secret), false, "nor in the history");
  for (const remote of ["ssh://-oProxyCommand=touch%20x/y", "git@-oProxyCommand:x"])
    assert.equal(MemoryHistorySettingsSchema.safeParse({ remote }).success, false, remote);
});
