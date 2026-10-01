/** Scoped lock notifications use only a scripted store and clock; no accounts or processes. */
import test from "node:test";
import assert from "node:assert/strict";
import { SessionLock } from "../dist/session-lock.js";

function fixture() {
  let clock = 1_000;
  const settings = new Map();
  const store = {
    get(_table, _owner, key) { return settings.get(key); },
    save(_table, _owner, key, data) { settings.set(key, { data }); },
    sqlite: {
      exec() {},
      prepare(sql) {
        if (sql === "PRAGMA table_info(app_lock_pin)") return { all: () => [{ name: "locked_at" }] };
        if (sql.startsWith("SELECT salt, pin_hash")) return { get: () => undefined };
        throw new Error(`Unexpected fixture SQL: ${sql}`);
      },
    },
  };
  return { lock: new SessionLock(store, "fixture-owner", () => clock), step: (ms) => { clock += ms; } };
}

for (const trigger of ["manual", "idle"]) {
  test(`a scoped subscriber and existing cleanup each fire once on ${trigger} lock`, () => {
    const { lock, step } = fixture();
    let notifications = 0, cleanup = 0;
    lock.onLock = () => { cleanup++; };
    const dispose = lock.onLocked(() => { notifications++; assert.equal(lock.locked(), true); });
    try {
      if (trigger === "idle") { lock.configure({ idleMinutes: 1 }); step(60_000); }
      assert.equal(trigger === "manual" ? lock.lock().locked : lock.locked(), true);
      lock.lock(); lock.locked(); lock.state();
      assert.equal(notifications, 1);
      assert.equal(cleanup, 1);
    } finally { dispose(); }
  });
}

test("an operation stays aborted after lock followed immediately by unlock", () => {
  const { lock } = fixture();
  const operation = new AbortController();
  let unlocks = 0;
  lock.onUnlock = () => { unlocks++; };
  const dispose = lock.onLocked(() => operation.abort());
  try {
    lock.lock();
    lock.unlock();
    assert.equal(lock.locked(), false);
    assert.equal(unlocks, 1);
    assert.equal(operation.signal.aborted, true, "unlock cannot restore authority to an existing operation");
  } finally { dispose(); }
});

test("disposing a subscriber is idempotent and prevents future notifications without removing others", () => {
  const { lock } = fixture();
  let released = 0, retained = 0, cleanup = 0;
  lock.onLock = () => { cleanup++; };
  const dispose = lock.onLocked(() => { released++; });
  const disposeRetained = lock.onLocked(() => { retained++; });
  try {
    lock.lock(); lock.unlock();
    dispose(); dispose();
    lock.lock();
    assert.equal(released, 1);
    assert.equal(retained, 2);
    assert.equal(cleanup, 2);
  } finally { dispose(); disposeRetained(); }
});

test("a throwing scoped listener cannot prevent another listener or existing cleanup", () => {
  const { lock } = fixture();
  const events = [];
  lock.onLock = () => { events.push("cleanup"); };
  const disposeThrowing = lock.onLocked(() => { events.push("throwing"); throw new Error("fixture listener"); });
  const disposeOther = lock.onLocked(() => { events.push("other"); });
  try {
    assert.doesNotThrow(() => lock.lock());
    assert.deepEqual(events, ["throwing", "other", "cleanup"]);
    assert.equal(lock.locked(), true);
  } finally { disposeThrowing(); disposeOther(); }
});
