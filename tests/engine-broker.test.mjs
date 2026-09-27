import test from "node:test";
import assert from "node:assert/strict";
import { engineBroker } from "../dist/desktop/engine-broker.js";

function fixture({ login = true } = {}) {
  const calls = [], windows = [];
  let saved = null;
  const broker = engineBroker({
    vault: { read: async () => saved, write: async (value) => { saved = value; }, clear: async () => { saved = null; } },
    banner: async (closed, notice) => {
      const win = { close: () => { calls.push(["close", notice?.title]); closed(); } };
      windows.push(win);
      return win;
    },
    loginItem: login ? { read: () => ({ enabled: false, needsApproval: false }),
      set: (enabled) => { calls.push(["login", enabled]); return { enabled, needsApproval: false }; } } : null,
    tell: (method) => calls.push(["tell", method]), quit: () => calls.push(["quit"]),
  });
  return { ...broker, calls, windows };
}

test("the retained broker carries vault updates and clear through the original encrypted-vault interface", async () => {
  const f = fixture(), tokens = { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: "2030-01-01" };
  assert.equal(await f.handlers["vault-read"](), null);
  await f.handlers["vault-write"](tokens);
  assert.deepEqual(await f.handlers["vault-read"](), tokens);
  await f.handlers["vault-clear"]();
  assert.equal(await f.handlers["vault-read"](), null);
});

test("the retained Stop notice tells the engine when it closes and the broker closes all owned notices", async () => {
  const f = fixture();
  await f.handlers["banner-open"]({ bannerId: 2, notice: { title: "Stop", text: "Task", button: "Stop" } });
  await f.handlers["banner-open"]({ bannerId: 3 });
  f.handlers["banner-close"]({ bannerId: 2 });
  f.close();
  assert.deepEqual(f.calls, [["close", "Stop"], ["tell", "banner-closed:2"], ["close", undefined], ["tell", "banner-closed:3"]]);
});

test("the retained broker preserves login control and command quit, rejecting malformed engine requests", async () => {
  const f = fixture();
  assert.deepEqual(f.handlers["login-item-set"]({ enabled: true }), { enabled: true, needsApproval: false });
  f.handlers.quit();
  assert.deepEqual(f.calls, [["login", true], ["quit"]]);
  assert.throws(() => f.handlers["login-item-set"]({ enabled: "yes" }));
  assert.throws(() => fixture({ login: false }).handlers["login-item-set"]({ enabled: true }), /Not available/);
  await assert.rejects(f.handlers["banner-open"]({ bannerId: 0 }));
  await assert.rejects(f.handlers["banner-open"]({ bannerId: 1, unexpected: true }));
  assert.throws(() => f.handlers["banner-close"]({ bannerId: "2" }));
  assert.equal(f.windows.length, 0);
});

test("only the private engine link reads the retained gateway's actual blocker state", async () => {
  const status = { requested: true, active: false, suspended: true, error: null };
  const f = fixture(); assert.equal(await f.handlers["gateway-power-status"]({}), null);
  const broker = engineBroker({ vault: { read: async () => null, write: async () => {}, clear: async () => {} },
    banner: async () => ({ close: () => {} }), loginItem: null, tell: () => {}, quit: () => {},
    power: { status: async () => status } });
  assert.deepEqual(await broker.handlers["gateway-power-status"]({}), status);
  assert.throws(() => broker.handlers["gateway-power-status"]({ active: true }), /Unrecognized/);
  broker.close();
});
