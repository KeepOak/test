/* MODEL-023: Codex's startup (the app-server handshake and opening a thread) counts against the request's time budget,
   so a Codex that never finishes starting is stopped instead of holding the task forever. A stopped request or a
   refused thread ends only that turn: another conversation on the same warm server keeps going.
   Stand-in app-server children only. */
import test from "node:test";
import assert from "node:assert/strict";
import { closeWarmCodex, warmCodexTurn } from "../dist/asks/codex-app-server.js";

test.afterEach(() => closeWarmCodex());

const ask = (signal = AbortSignal.timeout(10000)) => ({ messages: [{ role: "user", content: "Say hello" }], signal });

/** A stand-in app-server. `greet` false: the handshake is never answered. `threads(n)`: how thread n answers. */
function appServer({ greet = true, threads = () => "open" } = {}) {
  const told = [], listeners = [], finishers = [];
  let opened = 0, stops = 0;
  const reply = (message) => setImmediate(() => { for (const fn of listeners) fn(message); });
  const child = {
    send(message) {
      told.push(message);
      if (message.method === "initialize" && greet) reply({ id: message.id, result: { userAgent: "codex/1" } });
      if (message.method === "thread/start") {
        const how = threads(++opened);
        if (how === "open") reply({ id: message.id, result: { thread: { id: `thr${opened}` } } });
        if (how === "refuse") reply({ id: message.id, error: { message: "no such model" } });
      }
      if (message.method === "turn/start") {
        const threadId = message.params.threadId;
        reply({ id: message.id, result: { turn: { id: "turn", status: "inProgress" } } });
        finishers.push(() => {
          reply({ method: "item/agentMessage/delta", params: { threadId, delta: "Hello" } });
          reply({ method: "turn/completed", params: { threadId, turn: { status: "completed" } } });
        });
      }
    },
    onMessage: (fn) => listeners.push(fn), onExit: () => {}, stop() { stops++; },
  };
  return { told, finishers, get stops() { return stops; }, start: () => child };
}

async function until(check) {
  for (let i = 0; i < 2000 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), "the stand-in never got there");
}

const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms).unref())]);

test("MODEL-023: a Codex that never finishes starting is stopped within the request's budget", async () => {
  const fake = appServer({ greet: false });
  await assert.rejects(within(warmCodexTurn("codex", fake.start, ask(), {}, 150), 3000), /took too long to start a conversation/);
  assert.equal(fake.stops, 1, "the unresponsive server is stopped");
});

for (const [name, second] of [["a request stopped while its thread opens", "hang"], ["a thread Codex refuses", "refuse"]]) {
  test(`MODEL-023: ${name} ends only that turn, not another conversation on the same server`, async () => {
    const fake = appServer({ threads: (n) => (n === 1 ? "open" : second) });
    const first = warmCodexTurn("codex", fake.start, ask(), {}, 5000);
    await until(() => fake.finishers.length === 1);
    const stop = new AbortController();
    const other = warmCodexTurn("codex", fake.start, ask(stop.signal), {}, 5000);
    await until(() => fake.told.filter((m) => m.method === "thread/start").length === 2);
    if (second === "hang") stop.abort();
    await assert.rejects(other, second === "hang" ? /request was stopped/ : /did not open a conversation/);
    fake.finishers[0]();
    assert.equal((await within(first, 3000)).content, "Hello");
    assert.equal(fake.stops, 0, "the shared server keeps running");
  });
}
