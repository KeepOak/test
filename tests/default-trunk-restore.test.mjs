import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { exportBackup, importBackup, setupTrunks } from "../dist/backup.js";

test("a quietly created default Trunk does not make untouched setup count as user work", async (t) => {
  const { app } = await newWindow(t);
  await app.trunks.introduced();
  const db = app.store.sqlite;
  const trunk = app.trunks.defaultTrunk();
  assert.ok(trunk, "window setup quietly created its default Trunk");
  assert.deepEqual(app.store.messages(trunk.chatSessionId).map((m) => m.role), ["assistant"], "only its written greeting: no introduction was asked of a model, no owner message");
  const setup = setupTrunks(db);
  assert.notEqual(setup, null, "untouched engine setup should restore");
  const { app: source } = await newWindow(t);
  const result = importBackup(db, exportBackup(source.store.sqlite, "test"));
  assert.ok(result.replaced.length > 0);
  assert.equal(app.store.get("governance", app.runtime.owner, `trunk-files:${trunk.id}`), undefined, "retired setup personality files leave no orphan");
  assert.equal(db.prepare("SELECT count(*) AS n FROM trunk_threads").get().n, 0, "retired setup associations are removed");
});

test("an explicitly chosen or foreign thread association still blocks replacement", async (t) => {
  const { app } = await newWindow(t);
  await app.trunks.introduced();
  const db = app.store.sqlite;
  const trunk = app.trunks.defaultTrunk();
  app.trunks.threads.set(trunk.chatSessionId, trunk.id, "chosen");
  const row = db.prepare("SELECT * FROM trunk_threads LIMIT 1").get();
  assert.ok(row);
  db.prepare("UPDATE trunk_threads SET how='chosen' WHERE session_id=?").run(row.session_id);
  assert.equal(setupTrunks(db), null, "the owner's choice is work");
  db.prepare("UPDATE trunk_threads SET how=?, owner='foreign' WHERE session_id=?").run(row.how, row.session_id);
  assert.equal(setupTrunks(db), null, "another owner's association is not setup");
});

test("a message or a noncanonical opening never qualifies as untouched quiet setup", async (t) => {
  const { app } = await newWindow(t);
  const db = app.store.sqlite, trunk = app.trunks.defaultTrunk();
  db.prepare("UPDATE tasks SET prompt='Owner work' WHERE session_id=?").run(trunk.chatSessionId);
  assert.equal(setupTrunks(db), null, "an arbitrary empty conversation is still work");
  db.prepare("UPDATE tasks SET prompt=? WHERE session_id=?").run(`Trunk: ${trunk.name}`, trunk.chatSessionId);
  app.store.message(trunk.chatSessionId, { role: "user", content: "Keep my work." });
  assert.equal(setupTrunks(db), null, "the owner's first word protects the install");
});
