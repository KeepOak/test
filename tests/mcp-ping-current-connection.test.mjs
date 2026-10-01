/* Exercise the private restart wrapper itself, without opening an MCP transport. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/integrations/mcp.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("mcp.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const restartingNode = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "restarting");
assert.ok(restartingNode, "the actual private restarting function is present");
const extracted = ts.transpileModule(restartingNode.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function fixture() {
  const entered = deferred(), released = deferred(), checks = [], calls = [], pauses = [], crashes = [];
  let reopens = 0;
  function connection(name, check) {
    let alive = true, closes = 0;
    return {
      alive: () => alive,
      die: () => { alive = false; },
      close: async () => { closes++; alive = false; },
      closed: () => closes,
      call: async (tool, args, context) => { calls.push({ name, tool, args, context }); return name; },
      check: async signal => { checks.push({ name, signal }); await check?.(); },
    };
  }
  const first = connection("first", async () => { entered.resolve(); await released.promise; });
  const second = connection("second");
  const restarting = runInNewContext(extracted + "\nrestarting;", {
    nextCrashCount: (count, last) => { crashes.push({ count, last }); return count + 1; },
    restartBackoffMs: count => count,
    pause: async ms => { pauses.push(ms); },
  });
  const live = restarting(first, async () => { reopens++; return second; });
  return { first, second, live, entered, released, checks, calls, pauses, crashes, reopens: () => reopens };
}

for (const transition of ["close", "death", "replacement"]) {
  test(`an MCP ping rejects when its checked connection changes by ${transition}`, async () => {
    const f = fixture(), pending = f.live.check();
    const rejected = assert.rejects(pending, /checked MCP connection closed or changed/);
    await f.entered.promise;
    if (transition === "close") await f.live.close();
    else {
      f.first.die();
      if (transition === "replacement") {
        assert.equal(await f.live.call("existing-tool", { fixture: true }, {}), "second");
        assert.deepEqual(f.pauses, [1], "the existing call uses the injected backoff");
        assert.equal(f.crashes.length, 1);
      }
    }
    f.released.resolve();
    await rejected;
    assert.equal(f.checks.length, 1);
    assert.equal(f.checks[0].name, "first", "only the originally checked connection was pinged");
    assert.equal(f.reopens(), transition === "replacement" ? 1 : 0,
      "only an existing tool call may reopen; checking never opens a connection");
    if (transition === "replacement") {
      assert.equal(f.calls.length, 1);
      await f.live.check();
      assert.equal(f.checks.at(-1).name, "second", "a fresh check uses the replacement");
      assert.equal(f.reopens(), 1);
    } else assert.deepEqual(f.calls, []);
  });
}

test("an unchanged live MCP connection passes its pending ping without reopening", async () => {
  const f = fixture(), controller = new AbortController(), pending = f.live.check(controller.signal);
  await f.entered.promise;
  assert.equal(f.checks[0].signal, controller.signal);
  f.released.resolve(); await pending;
  assert.equal(f.reopens(), 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.pauses, []);
});

for (const transition of ["close", "death"]) {
  test(`an MCP check begun after ${transition} does not ping or reopen`, async () => {
    const f = fixture();
    if (transition === "close") await f.live.close(); else f.first.die();
    await assert.rejects(f.live.check(), /connection is not open/);
    assert.deepEqual(f.checks, []); assert.deepEqual(f.calls, []); assert.equal(f.reopens(), 0);
  });
}

test("an aborted pending MCP ping does not report success or reopen", async () => {
  const f = fixture(), controller = new AbortController(), pending = f.live.check(controller.signal);
  const rejected = assert.rejects(pending, error => error.name === "AbortError");
  await f.entered.promise;
  controller.abort(); f.released.resolve(); await rejected;
  assert.equal(f.reopens(), 0); assert.deepEqual(f.calls, []);
});
