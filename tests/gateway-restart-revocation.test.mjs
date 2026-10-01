import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { dashboardApi } from "../dist/dashboard-api.js";
import vm from "node:vm";
import { discardTemp } from "./temp-dir.mjs";

for (const transition of ["person", "lock"]) {
  for (const phase of ["body", "idle", "signal"]) {
    test(`restart stays revoked after ${transition} returns to owner/unlocked during ${phase}`, async t => {
      const root = await mkdtemp(join(tmpdir(), "branch-restart-revocation-"));
      const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
        provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
      t.after(async () => { await app.close(); await discardTemp(root); });
      const person = app.store.profiles.create({ name: "Guest", pin: "2468" });
      const revoke = () => {
        if (transition === "person") {
          app.store.profiles.switch({ profileId: person.id, pin: "2468" });
          app.store.profiles.switch({ profileId: null });
        } else { app.sessionLock.lock(); app.sessionLock.unlock(); }
      };
      const sent = [];
      const deps = { platform: "linux", env: { INVOCATION_ID: "fixture" }, pid: 4242,
        running: async () => ({ mode: "daemon", pid: 4242, port: 1, url: "", version: "1", startedAt: "2026-01-01T00:00:00Z" }),
        signal: (pid, signal) => sent.push([pid, signal]), setExitCode: code => sent.push(code), idleCheckMs: 10 };
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
      const run = phase === "idle" ? app.store.createRun(app.runtime.owner, "working fixture") : null;
      if (run) app.store.event(run.id, "run.started", { source: "owner", parentRunId: null });
      const call = () => dashboardApi(app, { method: "POST", headers: {} }, "/api/dashboard/restart", {
        dataDir: join(root, "data"), access: "full", deps,
        readBody: async () => { if (phase === "body") revoke(); return { whenIdle: phase === "idle" }; },
      });
      if (phase === "body") await assert.rejects(call(), /cancelled/);
      else {
        const result = await call();
        assert.equal(result.waiting ?? false, phase === "idle");
        revoke();
      }
      t.mock.timers.tick(1000);
      assert.deepEqual(sent, [], "neither exit code nor fake SIGTERM is issued after revocation");
      if (run) app.store.finish(run.id, "cancelled", "fixture cleanup");
      t.mock.timers.reset();
    });
  }
}

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function windowFixture() {
  const source = await readFile(new URL("../public/app/shell/gateway-restart.js", import.meta.url), "utf8");
  const state = { signedIn: true, view: "chat", chat: "one", setPage: "general", drafts: {} };
  let person = "owner", currentDialog = null, revision = 0, redraw, observer;
  const handlers = new Map(), messages = [], answers = [];
  const app = { classList: { contains: () => false } };
  const sandbox = { S: state, E: { state: { lock: { locked: false } } },
    activeId: () => person, ownerHere: () => person === "owner", esc: String, hasFiles: () => false,
    api: () => { const answer = answers.shift(); return typeof answer === "function" ? answer() : answer; }, toast: text => messages.push(text), closePop() {},
    dialog: () => currentDialog, dialogRevision: () => revision,
    openDlg: () => { currentDialog = { isConnected: true, contains: () => true }; revision++; return currentDialog; },
    closeDlg: () => { if (currentDialog) currentDialog.isConnected = false; currentDialog = null; revision++; },
    document: { getElementById: () => app }, afterDraw: callback => { redraw = callback; },
    on: (name, handler) => handlers.set(name, handler), markLive() {},
    MutationObserver: class { constructor(callback) { this.callback = callback; this.records = []; observer = this; } observe() {} takeRecords() { return this.records.splice(0); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), sandbox);
  sandbox.initGatewayRestart();
  return { sandbox, state, messages, answers, handlers, get observer() { return observer; },
    switchAwayAndBack() { person = "guest"; redraw(); person = "owner"; redraw(); },
    replaceDialog() { sandbox.closeDlg(); sandbox.openDlg(); },
    button: () => ({ isConnected: true, disabled: false }) };
}

test("restart preparation ignores late errors after navigation away and back", async () => {
  const f = await windowFixture(), response = deferred(); f.answers.push(response.promise);
  const preparing = f.sandbox.prepareGatewayRestart();
  f.switchAwayAndBack(); response.reject(new Error("late readiness failure")); await preparing;
  assert.deepEqual(f.messages, []);
});
for (const outcome of ["success", "error"]) {
  test(`restart confirmation ignores stale ${outcome} after its dialog is replaced`, async () => {
    const f = await windowFixture(); f.answers.push(Promise.resolve({ workingTasks: 0, busyTasks: 0 }));
    await f.sandbox.prepareGatewayRestart();
    const result = deferred(), requested = deferred(); f.answers.push(Promise.resolve({}), () => { requested.resolve(); return result.promise; });
    const button = f.button(), confirming = f.handlers.get("gwpop-restart-confirm")(button);
    await requested.promise;
    f.replaceDialog();
    if (outcome === "success") result.resolve({ waiting: true }); else result.reject(new Error("late restart refusal"));
    await confirming;
    assert.deepEqual(f.messages, []); assert.equal(button.disabled, true, "stale button is not modified");
    assert.ok(f.sandbox.dialog()?.isConnected, "replacement dialog stays open");
  });
}
test("queued lock-then-unlock mutations cancel restart preparation before its answer", async () => {
  const f = await windowFixture(), response = deferred(); f.answers.push(response.promise);
  const preparing = f.sandbox.prepareGatewayRestart();
  f.observer.records.push({ oldValue: "app" }, { oldValue: "app locked-b17" });
  response.resolve({ workingTasks: 0, busyTasks: 0 }); await preparing;
  assert.equal(f.sandbox.dialog(), null); assert.deepEqual(f.messages, []);
});
