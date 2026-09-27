/**
 * Changing a kept procedure's steps (and start) goes through the same owner's yes as making one
 * (src/autonomy/procedures.ts proposeChange/applyChange, POST /api/autonomy/procedures/<id>/propose).
 * After the yes it is the same procedure: the same id, its runs, record and level. Temporary folders
 * and a scripted model only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-procedure-change-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const api = async (path, body) => {
    const answer = await call(path, body);
    if (answer.status !== 200) throw new Error(`${answer.status} ${answer.body.error}`);
    return answer.body;
  };
  return { app, call, api };
}

const steps = [{ title: "Gather", prompt: "List merged changes." }, { title: "Publish", prompt: "Post the notes.", confirm: true }];

test("changed steps wait for the owner's yes, then replace the steps under the same id with the record kept", async (t) => {
  const { app, call, api } = await fixture(t);
  const refused = await call("/api/autonomy/procedures/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/propose", { steps });
  assert.equal(refused.status, 409, "the part is off, so it is refused in one sentence");
  await api("/api/autonomy/switch", { part: "procedures", mode: "on" });
  const { procedure } = await api("/api/autonomy/procedures", { name: "Release notes", level: "auto", start: { kind: "manual" }, steps: steps.map((s) => ({ ...s, confirm: false })) });
  app.autonomy.procedures.trigger(procedure.id, "a test");
  await app.autonomy.idle();
  const before = (await api("/api/autonomy/procedures")).procedures.find((p) => p.id === procedure.id);
  assert.equal(before.starts, "only when you start it");

  const changed = [{ title: "Gather", prompt: "List merged changes." }, { title: "Check", prompt: "Read the list back to me.", confirm: true }, { title: "Publish", prompt: "Post the notes." }];
  const asked = await api(`/api/autonomy/procedures/${procedure.id}/propose`, { steps: changed, start: { kind: "every", minutes: 60 } });
  assert.equal(asked.waiting, true);
  assert.match(asked.said, /Nothing about the procedure changes until you say yes/);
  const still = (await api("/api/autonomy/procedures")).procedures.find((p) => p.id === procedure.id);
  assert.deepEqual(still.procedure.steps, before.procedure.steps, "nothing changes before the yes");
  const again = await api(`/api/autonomy/procedures/${procedure.id}/propose`, { steps: changed, start: { kind: "every", minutes: 60 } });
  assert.deepEqual([again.waiting, again.id, again.said], [true, asked.id, "This exact change already waits for your answer."], "asked again, it names the question already waiting");

  const { entries } = await api("/api/autonomy/ledger");
  const entry = entries.find((e) => e.id === asked.id);
  assert.deepEqual([entry.kind, entry.from, entry.status], ["procedure", "owner", "pending"]);
  assert.match(entry.detail, /Step 2 \(asks you first\), Check: Read the list back to me\./);
  const { made } = await api("/api/autonomy/decide", { id: asked.id, yes: true });
  assert.equal(made.id, procedure.id);
  const after = (await api("/api/autonomy/procedures")).procedures;
  assert.equal(after.length, 1, "changed in place, never a second procedure");
  assert.equal(after[0].id, procedure.id);
  assert.deepEqual(after[0].procedure.steps, changed.map((s) => ({ confirm: false, ...s })));
  assert.deepEqual(after[0].procedure.start, { kind: "every", minutes: 60 });
  assert.equal(after[0].starts, "every 60 minutes");
  assert.ok(after[0].nextDueAt, "a new clock start is due");
  assert.deepEqual([after[0].stats, after[0].recent, after[0].createdAt, after[0].procedure.level, after[0].procedure.name],
    [before.stats, before.recent, before.createdAt, "auto", "Release notes"], "its runs, record, level and name are kept");
  assert.equal(after[0].version, 2);
  assert.deepEqual(after[0].history, [{ version: 1, steps: before.procedure.steps, start: { kind: "manual" }, from: before.createdAt }], "the version before is kept");
});

test("a change asked from steps that moved since, or while it runs, is refused and keeps waiting; a no blocks only that change", async (t) => {
  const { app, call, api } = await fixture(t);
  await api("/api/autonomy/switch", { part: "procedures", mode: "on" });
  const { procedure } = await api("/api/autonomy/procedures", { name: "Notes", level: "ask-to-start", start: { kind: "manual" }, steps });
  const one = [{ title: "One", prompt: "Do one thing." }], two = [{ title: "Two", prompt: "Do two things." }];
  assert.equal((await call(`/api/autonomy/procedures/${procedure.id}/propose`, { steps })).status, 400, "no change is refused");
  assert.equal((await call(`/api/autonomy/procedures/${procedure.id}/propose`, { steps: one, name: "Other" })).status, 400, "only steps and start");
  const first = await api(`/api/autonomy/procedures/${procedure.id}/propose`, { steps: one });
  const second = await api(`/api/autonomy/procedures/${procedure.id}/propose`, { steps: two });
  await api("/api/autonomy/decide", { id: first.id, yes: true });
  const stale = await call("/api/autonomy/decide", { id: second.id, yes: true });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /changed after this was asked/);
  assert.equal((await api("/api/autonomy/ledger")).entries.find((e) => e.id === second.id).status, "pending", "it keeps waiting with the reason");
  await api("/api/autonomy/decide", { id: second.id, yes: false });

  const back = await api(`/api/autonomy/procedures/${procedure.id}/propose`, { steps: two });
  assert.equal(back.waiting, true, "the same words from the new steps are a new question, not the one said no to");
  const state = app.autonomy.procedures.get(procedure.id);
  app.store.save("settings", app.runtime.owner, `autonomy-procedure:${procedure.id}`, { ...state, running: { step: 0, sessionId: null, startedAt: new Date().toISOString() } });
  const running = await call("/api/autonomy/decide", { id: back.id, yes: true });
  assert.match(running.body.error, /running now/);
  app.store.save("settings", app.runtime.owner, `autonomy-procedure:${procedure.id}`, state);
  await api("/api/autonomy/decide", { id: back.id, yes: true });
  assert.deepEqual(app.autonomy.procedures.get(procedure.id).procedure.steps, [{ ...two[0], confirm: false }]);

  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call(`/api/autonomy/procedures/${procedure.id}/propose`, { steps: one }, key)).status, 401);
  await api(`/api/autonomy/procedures/${procedure.id}/propose`, { steps: one });
  await api(`/api/autonomy/procedures/${procedure.id}/remove`, {});
  assert.equal((await api("/api/autonomy/ledger")).entries.filter((e) => e.payload.procedureId === procedure.id).length, 0, "removing it withdraws its waiting change");
});
