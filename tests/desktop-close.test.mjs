import test from "node:test";
import assert from "node:assert/strict";
import { closeOwnedDesktop } from "./fixtures/desktop-close.mjs";

function fixture({ owned = true, running = false } = {}) {
  const calls = [];
  const home = "isolated-test-home";
  const electron = {
    process: () => ({ exitCode: null }),
    async evaluate(fn, expected) {
      const original = { home: process.env.BRANCH_DESKTOP_HOME, hooks: process.env.BRANCH_TEST_ENGINE_HOOKS,
        host: globalThis.branchEngineForTests };
      process.env.BRANCH_DESKTOP_HOME = owned ? home : "another-home";
      process.env.BRANCH_TEST_ENGINE_HOOKS = "1";
      globalThis.branchEngineForTests = { running, end: async (timeout) => calls.push(["end", timeout]) };
      try { await fn(undefined, expected); }
      finally {
        for (const [key, value] of [["BRANCH_DESKTOP_HOME", original.home], ["BRANCH_TEST_ENGINE_HOOKS", original.hooks]])
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        globalThis.branchEngineForTests = original.host;
      }
    },
    close: async () => calls.push(["close"]),
  };
  return { electron, home, calls };
}

test("desktop cleanup ends its owned engine before closing the shell", async () => {
  const f = fixture();
  await closeOwnedDesktop(f.electron, f.home);
  assert.deepEqual(f.calls, [["end", 7000], ["close"]]);
});
test("desktop cleanup refuses another home's process", async () => {
  const f = fixture({ owned: false });
  await assert.rejects(closeOwnedDesktop(f.electron, f.home), /outside the isolated test home/);
  assert.deepEqual(f.calls, []);
});
test("desktop cleanup never asks the shell to quit while its engine still runs", async () => {
  const f = fixture({ running: true });
  await assert.rejects(closeOwnedDesktop(f.electron, f.home), /engine did not stop/);
  assert.deepEqual(f.calls, [["end", 7000]]);
});
