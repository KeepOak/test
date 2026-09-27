import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, lineDiff } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args, id = "c1") => () => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-history-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(steps) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
async function served(t, app, root) {
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  return async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? response.status);
    return json;
  };
}

test("every file change keeps the bytes before it, shows a diff, and can be undone", async (t) => {
  const { app, root } = await fixture(t, [call("files.write", { path: "notes.md", content: "one\ntwo\nthree\n" }), call("files.write", { path: "notes.md", content: "one\n2\nthree\nfour\n" }, "c2"), say("edited")]);
  const api = await served(t, app, root);
  const run = await app.runtime.run({ prompt: "edit my notes" });
  assert.equal(run.status, "completed");
  const changes = app.store.events(run.id).filter((e) => e.kind === "file.changed").map((e) => e.data);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].existed, false, "the first write created the file");
  assert.deepEqual([changes[1].added, changes[1].removed], [2, 1]);
  for (const line of ["+2", "-two", " three", "+four"]) assert.ok(changes[1].diff.split("\n").includes(line), `diff shows ${line}`);
  const state = await api("state");
  const shown = state.runs.find((r) => r.id === run.id).changes;
  assert.equal(shown.length, 2);
  assert.equal(shown[1].path, "notes.md");
  const versions = await app.registry.execute("files.history", { path: "notes.md" }, app.runtime.context());
  assert.equal(versions.length, 2);
  assert.equal(versions[0].existed, true);
  assert.equal(versions[0].bytes, "one\ntwo\nthree\n".length);
  const restored = await api("history/restore", { versionId: changes[1].versionId });
  assert.deepEqual(restored, { path: "notes.md", bytes: 14, restored: true });
  assert.equal(await readFile(join(root, "workspace", "notes.md"), "utf8"), "one\ntwo\nthree\n");
  const nothing = await app.registry.execute("files.restore", { versionId: changes[0].versionId }, app.runtime.context());
  assert.equal(nothing.restored, false, "a version of a file that did not exist is not written");
  assert.equal(lineDiff("a\nb\nc", "a\nc").removed, 1);
  assert.deepEqual(lineDiff("", "x\ny"), { added: 2, removed: 0, diff: "+x\n+y" });
});

test("a workspace snapshot restores every file to its exact previous bytes and skips secrets", async (t) => {
  const { app, root } = await fixture(t, [say("ok")]);
  const api = await served(t, app, root);
  const ws = join(root, "workspace");
  const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0xc3, 0x28]);
  await mkdir(join(ws, "deep", "node_modules", "pkg"), { recursive: true });
  await writeFile(join(ws, "binary.bin"), bytes);
  await writeFile(join(ws, "deep", "text.txt"), "hello\r\nworld");
  await writeFile(join(ws, "deep", "node_modules", "pkg", "index.js"), "skip me");
  await writeFile(join(ws, ".env"), "SECRET=1");
  const snapshot = await api("history/snapshots", { label: "before the change" });
  assert.equal(snapshot.files, 2, "node_modules and secret names are not part of a snapshot");
  await writeFile(join(ws, "binary.bin"), Buffer.from([1, 2, 3]));
  await writeFile(join(ws, "deep", "text.txt"), "changed");
  await writeFile(join(ws, "new.txt"), "created after the snapshot");
  const listed = await api("history/snapshots");
  assert.equal(listed.snapshots[0].id, snapshot.id);
  assert.equal(listed.snapshots[0].label, "before the change");
  const result = await api(`history/snapshots/${snapshot.id}/restore`, {});
  const { kept, ...put } = result;
  assert.deepEqual(put, { id: snapshot.id, restored: 2 });
  // Redesign security review: what those two files held a moment ago is kept first, as a snapshot of its own.
  assert.equal((await api("history/snapshots")).snapshots.find((one) => one.id === kept)?.label, "Before putting back before the change");
  assert.ok(Buffer.from(await readFile(join(ws, "binary.bin"))).equals(bytes), "exact bytes came back");
  assert.equal(await readFile(join(ws, "deep", "text.txt"), "utf8"), "hello\r\nworld");
  assert.equal(await readFile(join(ws, "new.txt"), "utf8"), "created after the snapshot", "files created later are left alone");
  const viaTool = await app.registry.execute("workspace.snapshot", { label: "by the assistant" }, app.runtime.context());
  assert.equal(viaTool.files, 3);
  await assert.rejects(api("history/snapshots/00000000-0000-4000-8000-000000000000/restore", {}), /not kept/);
});
