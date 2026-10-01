import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture() {
  const source = await readFile(new URL("../public/app/places/overview-todos.js", import.meta.url), "utf8");
  const S = { signedIn: true, view: "overview", chat: null, setPage: "general" }, E = { profiles: { who: "owner" }, state: {} };
  let key = "first-token", revision = 0, locked = false, draw, observer, renders = 0;
  const requests = [], messages = [], actions = new Map(), app = { classList: { contains: () => locked } };
  const sandbox = { S, E, ownerHere: () => E.profiles.who === "owner", sessionPrincipal: profiles => profiles.who,
    token: { get: () => key }, api: () => requests.shift(), esc: String, language: () => "en", t: text => text,
    lockdownOn: () => false, dialogRevision: () => revision, dialog: () => null, openDlg() {}, closeDlg() {},
    renderNow: () => { renders++; }, afterDraw: callback => { draw = callback; }, on: (name, callback) => actions.set(name, callback),
    markLive() {}, toast: text => messages.push(text), document: { getElementById: () => app },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} takeRecords() { return []; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") + "; globalThis.todoState = T;", sandbox);
  sandbox.initOwnerTodos();
  return { sandbox, S, E, requests, messages, actions, get renders() { return renders; },
    lock: () => { locked = true; draw(); }, navigate: () => { S.view = "chat"; draw(); },
    replaceDialog: () => { revision++; }, newGeneration: () => { key = "second-token"; sandbox.ownerTodosTile(); },
    transientLock: () => observer([{ oldValue: "app locked-b17" }]) };
}
for (const transition of ["lock", "navigate", "replaceDialog", "transientLock"]) {
  for (const outcome of ["success", "error"]) {
    test(`To-do GET drops late ${outcome} after ${transition}`, async () => {
      const f = await fixture(), response = deferred(); f.requests.push(response.promise);
      const pending = f.sandbox.loadOwnerTodos(true); f[transition]();
      if (outcome === "success") response.resolve({ todos: [{ id: "private", text: "old owner data" }] }); else response.reject(new Error("old owner error"));
      assert.equal(await pending, false); assert.equal(f.sandbox.todoState.rows, null); assert.equal(f.sandbox.todoState.error, null);
    });
  }
}
test("old mutation completion cannot clear a newer generation's busy key or toast its error", async () => {
  const f = await fixture(), item = { id: "same", text: "Task", done: false };
  f.requests.push(Promise.resolve({ todos: [item] })); await f.sandbox.loadOwnerTodos(true);
  const old = deferred(); f.requests.push(old.promise);
  const oldChange = f.actions.get("owner-todo-done")({ dataset: { id: "same" }, closest: () => null });
  const oldBusy = f.sandbox.todoState.busy;
  f.newGeneration(); f.requests.push(Promise.resolve({ todos: [item] })); await f.sandbox.loadOwnerTodos(true);
  const newer = deferred(); f.requests.push(newer.promise);
  const newChange = f.actions.get("owner-todo-done")({ dataset: { id: "same" }, closest: () => null });
  const newBusy = f.sandbox.todoState.busy;
  assert.notEqual(oldBusy, newBusy); assert.equal(newBusy.has("same"), true);
  old.reject(new Error("old generation failure")); await oldChange;
  assert.equal(newBusy.has("same"), true); assert.deepEqual(f.messages, []);
  newer.reject(new Error("current generation failure")); await newChange;
  assert.equal(newBusy.has("same"), false); assert.deepEqual(f.messages, ["current generation failure"]);
});
