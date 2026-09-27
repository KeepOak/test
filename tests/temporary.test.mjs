import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

function scripted(steps) {
  const provider = { name: "scripted", calls: [], async complete(request) {
    provider.calls.push(request);
    const step = steps.shift();
    return step ?? { content: "done", toolCalls: [] };
  } };
  return provider;
}
const call = (name, args, id = "c1") => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-temp-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider };
  const app = await createBranch(options);
  t.after(async () => { await app.close().catch(() => undefined); await discardTemp(root); });
  return { app, root, options };
}

test("temporary conversations stay out of history, the library, branches and long-term memory, and vanish on discard", async (t) => {
  const provider = scripted([
    call("memory.put", { text: "The owner's cat is called Miso", source: "chat" }),
    { content: "Noted the cat name in this conversation only.", toolCalls: [] },
    { content: "Saved conversation reply about the tulip garden.", toolCalls: [] },
  ]);
  const { app, root, options } = await fixture(t, provider);
  const temp = await app.runtime.run({ prompt: "remember my cat Miso", temporary: true });
  assert.equal(temp.status, "completed");
  const events = app.store.events(temp.id);
  assert.ok(events.some((e) => e.kind === "session.temporary"), "run is marked temporary");
  const toolResult = JSON.parse(app.store.messages(temp.sessionId).find((m) => m.role === "tool").content);
  assert.match(JSON.stringify(toolResult), /[Pp]ermission/, "memory.put is denied in a temporary conversation");
  assert.equal(app.store.list("memory", "local").length, 0, "nothing reached long-term memory");
  const saved = await app.runtime.run({ prompt: "tell me about the tulip garden" });
  assert.equal(app.store.searchHistory("local", { query: "Miso" }).length, 0, "temporary text is not searchable");
  assert.equal(app.store.searchHistory("local", { query: "tulip" }).length > 0, true, "ordinary conversations still are");
  const listed = app.store.searchSessions("local", { query: "" }).sessions.map((s) => s.sessionId);
  assert.ok(listed.includes(saved.sessionId));
  assert.ok(!listed.includes(temp.sessionId), "temporary conversation is not listed");
  assert.throws(() => app.store.exportSession("local", temp.sessionId), /Temporary conversations cannot be exported/);
  await assert.rejects(app.store.duplicateSession("local", temp.sessionId), /Temporary conversations cannot be exported/);
  const firstUser = app.store.sessionView("local", temp.sessionId);
  assert.equal(firstUser.temporary, true);
  await assert.rejects(app.store.branchSession("local", { sessionId: temp.sessionId, messageId: firstUser.messages[0].messageId }), /cannot be branched/);
  assert.throws(() => app.store.discardSession("local", saved.sessionId), /Only temporary/);
  const result = app.store.discardSession("local", temp.sessionId);
  assert.equal(result.discarded, true);
  assert.ok(result.messages >= 3);
  assert.equal(app.store.messages(temp.sessionId).length, 0);
  assert.equal(app.store.run(temp.id), undefined, "the run record is gone too");
  assert.throws(() => app.store.sessionView("local", temp.sessionId), /not found/);
  // A leftover temporary conversation (for example after a crash) is purged on the next start.
  const leftover = await app.runtime.run({ prompt: "temporary leftover", temporary: true });
  await app.close();
  const reopened = await createBranch(options);
  assert.throws(() => reopened.store.sessionView("local", leftover.sessionId), /not found/);
  assert.equal(reopened.store.sessionView("local", saved.sessionId).messages.length >= 2, true, "saved conversation survives restart");
  await reopened.close();
  void root;
});

test("HTTP API starts a temporary conversation and discards it", async (t) => {
  const { app, root } = await fixture(t, scripted([{ content: "quick answer", toolCalls: [] }]));
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const run = (await post("run", { prompt: "hello", temporary: true })).data;
  assert.equal(run.status, "completed");
  assert.equal((await post("sessions/search", { query: "" })).data.sessions.length, 0);
  assert.equal((await post(`sessions/${run.sessionId}/export`, {})).status, 404, "export route is GET; POST is not an endpoint");
  const discarded = await post(`sessions/${run.sessionId}/discard`, {});
  assert.equal(discarded.status, 200);
  assert.equal(discarded.data.discarded, true);
  assert.equal((await post(`sessions/${run.sessionId}/discard`, {})).status, 400);
});
