/**
 * Bucket 21 (sdk-react): the React hooks in packages/sdk-react.
 *
 * React is not installed in this repository and is not added for this: the hooks are built on
 * whatever React the page hands in, so the tests hand in a small React of their own that keeps
 * hook slots, runs effects after each render and renders again when state changes. The last test
 * drives the hooks against a real Branch Agent over the network through the plain client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { BranchClient } from "../packages/sdk/client.mjs";
import { createBranchHooks, createRunStore } from "../packages/sdk-react/hooks.mjs";
import { discardTemp } from "./temp-dir.mjs";

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/** Just enough React to run hooks in one component: slots, effects, context and re-rendering. */
function smallReact() {
  const slots = [];
  const context = new Map();
  let index = 0;
  let pending = [];
  let scheduled = false;
  let draw = () => {};
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; draw(); }); } };
  const slot = () => (slots[index] ??= {}, slots[index++]);
  const React = {
    createContext: (fallback) => { const made = { fallback }; made.Provider = { context: made }; return made; },
    createElement: (type, props, ...children) => ({ type, props, children }),
    useContext: (made) => (context.has(made) ? context.get(made) : made.fallback),
    useState(initial) {
      const s = slot();
      if (!("value" in s)) s.value = typeof initial === "function" ? initial() : initial;
      s.set ??= (next) => {
        const value = typeof next === "function" ? next(s.value) : next;
        if (!Object.is(value, s.value)) { s.value = value; schedule(); }
      };
      return [s.value, s.set];
    },
    useMemo(make, deps) {
      const s = slot();
      if (!("value" in s) || !same(s.deps, deps)) { s.value = make(); s.deps = deps; }
      return s.value;
    },
    useCallback: (fn, deps) => React.useMemo(() => fn, deps),
    useEffect(effect, deps) {
      const s = slot();
      if (s.ran && same(s.deps, deps)) return;
      pending.push(() => { s.cleanup?.(); s.cleanup = effect(); s.deps = deps; s.ran = true; });
    },
    useSyncExternalStore(subscribe, snapshot) {
      const s = slot();
      s.unsubscribe ??= subscribe(schedule);
      return snapshot();
    },
  };
  function render(hook, provided) {
    const result = { current: undefined, error: undefined, renders: 0 };
    draw = () => {
      index = 0;
      for (const [made, value] of provided) context.set(made, value);
      try { result.current = hook(); result.error = undefined; } catch (error) { result.error = error; }
      result.renders++;
      const run = pending;
      pending = [];
      for (const effect of run) effect();
    };
    draw();
    const unmount = () => { for (const s of slots) { s.cleanup?.(); s.unsubscribe?.(); } };
    return { result, unmount };
  }
  return { React, render };
}

async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A client that answers from a script, and remembers what it was asked. */
function scriptedClient({ events = [{ kind: "tool.started" }, { kind: "end", status: "completed" }], output = "Done.", fail } = {}) {
  const calls = [];
  return {
    calls,
    get: async (path) => { calls.push(["get", path]); if (fail) throw fail; return { path, count: calls.length }; },
    runs: {
      start: async (input) => { calls.push(["start", input]); if (fail) throw fail; return { id: "run-1" }; },
      async *stream(runId) { calls.push(["stream", runId]); for (const event of events) { await null; yield event; } },
      get: async (runId) => { calls.push(["read", runId]); return { run: { status: "completed", output } }; },
      steer: async (runId, text) => { calls.push(["steer", runId, text]); return {}; },
      cancel: async (runId) => { calls.push(["cancel", runId]); return {}; },
    },
  };
}

test("the run store follows a task from start to answer, and says when it failed", async () => {
  const client = scriptedClient();
  const store = createRunStore(client);
  const seen = [];
  store.subscribe(() => seen.push(store.snapshot().status));
  assert.equal(store.snapshot().status, "idle");
  await store.start("Summarise", { temporary: true });
  const done = store.snapshot();
  assert.equal(done.status, "completed");
  assert.equal(done.output, "Done.");
  assert.deepEqual(done.events.map((event) => event.kind), ["tool.started", "end"]);
  assert.deepEqual(client.calls[0], ["start", { temporary: true, prompt: "Summarise" }], "the prompt is always the one given");
  assert.deepEqual([...new Set(seen)], ["starting", "running", "completed"]);
  assert.ok(Object.isFrozen(done) && Object.isFrozen(done.events), "a snapshot never changes under a component");
  await store.steer("shorter");
  assert.deepEqual(client.calls.at(-1), ["steer", "run-1", "shorter"]);

  const refused = new Error("Branch Agent could not be reached");
  const failing = createRunStore(scriptedClient({ fail: refused }));
  assert.equal(await failing.start("Hello"), null);
  assert.equal(failing.snapshot().status, "failed");
  assert.equal(failing.snapshot().error, refused);
  assert.equal(await createRunStore(scriptedClient()).steer("nothing started"), null);
});

test("the hooks need a provider, read an address, and follow a task", async () => {
  const { React, render } = smallReact();
  const hooks = createBranchHooks(React);
  const client = scriptedClient();

  const lonely = render(() => hooks.useBranch(), []);
  assert.match(String(lonely.result.error), /BranchProvider/);

  const element = hooks.BranchProvider({ client, children: "page" });
  assert.equal(element.type, hooks.BranchContext.Provider);
  assert.equal(element.props.value, client);

  const reading = render(() => hooks.useBranchGet("/api/state"), [[hooks.BranchContext, client]]);
  assert.equal(reading.result.current.loading, true);
  await until(() => reading.result.current.data, "the first read");
  assert.equal(reading.result.current.data.path, "/api/state");
  reading.result.current.refresh();
  await until(() => client.calls.filter(([kind]) => kind === "get").length === 2, "the second read");
  reading.unmount();

  const nothing = render(() => hooks.useBranchGet(null), [[hooks.BranchContext, client]]);
  assert.equal(nothing.result.current.loading, false);
  assert.equal(client.calls.filter(([kind]) => kind === "get").length, 2, "a null path reads nothing");
});

test("a failed read keeps the last answer, and a run can be cancelled", async () => {
  const { React, render } = smallReact();
  const hooks = createBranchHooks(React);
  const refused = Object.assign(new Error("The session key was missing or wrong."), { status: 401 });
  const reading = render(() => hooks.useBranchGet("/api/state"), [[hooks.BranchContext, scriptedClient({ fail: refused })]]);
  await until(() => reading.result.current.loading === false, "the refusal");
  assert.equal(reading.result.current.error, refused);
  assert.equal(reading.result.current.data, null);

  const client = scriptedClient({ events: [] });
  const running = render(() => hooks.useBranchRun(), [[hooks.BranchContext, client]]);
  assert.equal(running.result.current.status, "idle");
  await running.result.current.start("Tidy the notes");
  await until(() => running.result.current.status === "completed", "the answer");
  await running.result.current.cancel();
  await until(() => running.result.current.status === "cancelled", "the cancel");
  assert.deepEqual(client.calls.at(-1), ["cancel", "run-1"]);
  running.unmount();
});

test("the package entry hands React to the hooks and exports the same names, with no dependency of its own", async () => {
  const folder = join(import.meta.dirname, "..", "packages", "sdk-react");
  const entry = await readFile(join(folder, "index.mjs"), "utf8");
  assert.match(entry, /import \* as React from "react";/);
  for (const name of ["BranchProvider", "useBranch", "useBranchGet", "useBranchRun", "createBranchHooks", "createRunStore"])
    assert.match(entry, new RegExp(`\\b${name}\\b`));
  const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
  assert.equal(manifest.private, true, "nothing is published");
  assert.equal(manifest.dependencies, undefined, "React is the page's own, never installed by this package");
  assert.ok(manifest.peerDependencies.react);
  const hooks = await readFile(join(folder, "hooks.mjs"), "utf8");
  assert.doesNotMatch(hooks, /^import /m, "the hooks import nothing");
});

test("the hooks drive a real Branch Agent: a task started from React finishes with its answer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-sdk-react-"));
  const provider = { name: "scripted", async complete() { return { content: "Three lines about the meeting.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const client = new BranchClient({ url: server.url, token: server.token });
  const { React, render } = smallReact();
  const hooks = createBranchHooks(React);

  const running = render(() => ({ run: hooks.useBranchRun(), kit: hooks.useBranchGet("/api/sdk-kit") }), [[hooks.BranchContext, client]]);
  await running.result.current.run.start("Summarise the meeting notes");
  await until(() => running.result.current.run.status === "completed", "the real task");
  assert.equal(running.result.current.run.output, "Three lines about the meeting.");
  assert.equal(running.result.current.run.events.at(-1).kind, "end");
  await until(() => running.result.current.kit.data, "the switch");
  assert.equal(running.result.current.kit.data.settings.mode, "when-needed", "building on Branch ships when needed (defaults audit)");
  running.unmount();
});
