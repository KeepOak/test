/** Real app/profile/lock/To-do APIs, isolated data and scripted model; no accounts or sockets. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { orchestrationApi } from "../dist/orchestration-api.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-todos-authority-"));
  const app = await createBranch({ workspace: join(root, "work"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "fixture", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const original = app.todos.add(owner, { text: "Keep unchanged" }, "owner");
  const request = Object.assign(new EventEmitter(), { method: "POST", aborted: false });
  const person = app.store.profiles.create({ name: "Fixture person", pin: "284719" });
  let profileSubscriptions = 0, lockSubscriptions = 0;
  for (const [object, name, count] of [[app.store.profiles, "onSwitched", "profile"], [app.sessionLock, "onLocked", "lock"]]) {
    const originalSubscribe = object[name].bind(object);
    object[name] = callback => {
      if (count === "profile") profileSubscriptions++; else lockSubscriptions++;
      const dispose = originalSubscribe(callback);
      return () => { dispose(); if (count === "profile") profileSubscriptions--; else lockSubscriptions--; };
    };
  }
  const transition = kind => {
    if (kind === "profile" || kind === "profile roundtrip") {
      app.store.profiles.switch({ profileId: person.id, pin: "284719" });
      if (kind === "profile roundtrip") app.store.profiles.switch({ profileId: null });
    } else if (kind === "lock" || kind === "lock roundtrip") {
      app.sessionLock.lock(); if (kind === "lock roundtrip") app.sessionLock.unlock();
    } else { request.aborted = true; request.emit("aborted"); }
  };
  const settled = () => {
    assert.equal(profileSubscriptions, 0); assert.equal(lockSubscriptions, 0);
    assert.equal(request.listenerCount("aborted"), 0);
  };
  return { app, owner, original, request, transition, settled };
}

for (const action of ["add", "done"]) for (const change of ["profile", "profile roundtrip", "lock", "lock roundtrip", "abort"]) {
  test(`To-do ${action} refuses ${change} while reading its body`, async t => {
    const f = await fixture(t);
    let deliver;
    const body = new Promise(resolve => { deliver = resolve; });
    const path = action === "add" ? "/api/todos" : `/api/todos/${f.original.id}/done`;
    const pending = orchestrationApi(f.app, f.request, path, () => body);
    f.transition(change); deliver(action === "add" ? { text: "Do not add" } : { done: true });
    await assert.rejects(pending, error => error.status === 403);
    assert.deepEqual(f.app.todos.list(f.owner, { includeDone: true }), [f.original]);
    f.settled();
  });
}

test("To-do done cannot swallow revocation as a rejected-body default", async t => {
  const f = await fixture(t);
  let reject;
  const body = new Promise((_resolve, no) => { reject = no; });
  const pending = orchestrationApi(f.app, f.request, `/api/todos/${f.original.id}/done`, () => body);
  f.transition("lock roundtrip"); reject(new Error("body unavailable"));
  await assert.rejects(pending, error => error.status === 403);
  assert.deepEqual(f.app.todos.list(f.owner, { includeDone: true }), [f.original]); f.settled();
});

test("current owner To-do reads and mutations remain usable and release listeners", async t => {
  const f = await fixture(t);
  const added = await orchestrationApi(f.app, f.request, "/api/todos", async () => ({ text: "Valid item" })); f.settled();
  assert.equal(added.text, "Valid item");
  const done = await orchestrationApi(f.app, f.request, `/api/todos/${added.id}/done`, async () => ({ done: true })); f.settled();
  assert.equal(done.done, true);
  f.request.method = "GET";
  const listed = await orchestrationApi(f.app, f.request, "/api/todos", async () => { throw new Error("GET must not read a body"); });
  assert.equal(listed.todos.length, 2); f.settled();
  f.request.method = "DELETE";
  assert.deepEqual(await orchestrationApi(f.app, f.request, `/api/todos/${added.id}`, async () => ({})), { removed: added.id });
  f.settled();
});

test("an already locked owner cannot read or change the To-do list", async t => {
  const f = await fixture(t); f.app.sessionLock.lock();
  for (const method of ["GET", "POST", "DELETE"]) {
    f.request.method = method;
    await assert.rejects(orchestrationApi(f.app, f.request, method === "DELETE" ? `/api/todos/${f.original.id}` : "/api/todos",
      async () => { assert.fail("locked request must not read its body"); }), error => error.status === 403);
    f.settled();
  }
  assert.deepEqual(f.app.todos.list(f.owner, { includeDone: true }), [f.original]);
});
