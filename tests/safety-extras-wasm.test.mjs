/**
 * mac7/r17-g (R17-062): WebAssembly add-ons in a sealed box. The modules are assembled here byte by
 * byte, so no compiler is needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readWasmShape, wasmRefusal } from "../dist/safety-extras/wasm-check.js";
import { runWasm } from "../dist/safety-extras/wasm-add-ons.js";
import { categoryOf } from "../dist/tool-categories.js";

/* ---------- a tiny assembler ---------- */
const leb = (n) => { const out = []; do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n); return out; };
const str = (text) => [...leb(Buffer.byteLength(text)), ...Buffer.from(text)];
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, body) => [id, ...leb(body.length), ...body];
const I32 = 0x7f;
const fn = (params, results) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
const limits = (min, max) => (max === undefined ? [0x00, ...leb(min)] : [0x01, ...leb(min), ...leb(max)]);
const body = (locals, code) => { const inner = [...vec(locals), ...code, 0x0b]; return [...leb(inner.length), ...inner]; };

function module({ types, imports = [], funcs = [], memory, exports, code }) {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...(imports.length ? section(2, vec(imports)) : []),
    ...section(3, vec(funcs.map((type) => leb(type)))),
    ...(memory ? section(5, vec([memory])) : []),
    ...section(7, vec(exports)),
    ...section(10, vec(code)),
  ]);
}
const imp = (name, kind, desc) => [...str("branch"), ...str(name), kind, ...desc];

/** Echoes its input: input_size, read_input(0), write_output(0, size), return 0. */
const echo = module({
  types: [fn([], [I32]), fn([I32], []), fn([I32, I32], [])],
  imports: [imp("memory", 0x02, limits(1, 2)), imp("input_size", 0x00, [0]), imp("read_input", 0x00, [1]), imp("write_output", 0x00, [2])],
  funcs: [0],
  exports: [[...str("run"), 0x00, 3]],
  code: [body([[1, I32]], [0x10, 0, 0x21, 0, 0x41, 0, 0x10, 1, 0x41, 0, 0x20, 0, 0x10, 2, 0x41, 0])],
});
/** Never finishes. */
const spin = module({
  types: [fn([], [I32])], funcs: [0], memory: limits(1, 1),
  exports: [[...str("run"), 0x00, 0], [...str("memory"), 0x02, 0]],
  code: [body([], [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x41, 0x00])],
});
/** Asks for a file-system call. */
const sneaky = module({
  types: [fn([], [I32])], imports: [imp("memory", 0x02, limits(1)), [...str("wasi_snapshot_preview1"), ...str("fd_write"), 0x00, 0]],
  funcs: [0], exports: [[...str("run"), 0x00, 1]], code: [body([], [0x41, 0x00])],
});
/** Its own memory, with no ceiling. */
const unbounded = module({
  types: [fn([], [I32])], funcs: [0], memory: limits(1),
  exports: [[...str("run"), 0x00, 0], [...str("memory"), 0x02, 0]], code: [body([], [0x41, 0x00])],
});
/** Tries to grow its memory by four pages, past its own ceiling of four. */
const greedy = module({
  types: [fn([], [I32])], funcs: [0], memory: limits(1, 4),
  exports: [[...str("run"), 0x00, 0], [...str("memory"), 0x02, 0]],
  // memory.grow(4) answers -1 when refused; that is returned.
  code: [body([], [0x41, 0x04, 0x40, 0x00])],
});

test("what a module asks for is read before it runs", () => {
  assert.deepEqual(readWasmShape(echo).imported, { min: 1, max: 2, shared: false, wide: false });
  assert.deepEqual(readWasmShape(spin).own, [{ min: 1, max: 1, shared: false, wide: false }]);
  assert.equal(wasmRefusal(echo, 256), null);
  assert.equal(wasmRefusal(spin, 256), null);
  assert.match(wasmRefusal(sneaky, 256), /wasi_snapshot_preview1\.fd_write, which add-ons are not given/);
  assert.match(wasmRefusal(unbounded, 256), /Build it with a maximum memory size/);
  assert.match(wasmRefusal(greedy, 2), /may grow past the 0\.125 MB allowed/);
  assert.match(wasmRefusal(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 256), /not a valid WebAssembly file/);
  assert.throws(() => readWasmShape(new Uint8Array([1, 2])), /not a WebAssembly file/);
});

test("it runs sealed: the answer comes back, and a module that never stops is stopped", async () => {
  const run = await runWasm(echo, "hello, sealed box", { maxMemoryMb: 16, timeoutMs: 5000 });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.output, "hello, sealed box");
  const started = Date.now();
  const stuck = await runWasm(spin, "", { maxMemoryMb: 16, timeoutMs: 300 });
  assert.equal(stuck.ok, false);
  assert.match(stuck.error, /ran longer than 300 ms/);
  assert.ok(Date.now() - started < 3000);
  const held = await runWasm(greedy, "", { maxMemoryMb: 16, timeoutMs: 2000 });
  assert.equal(held.code, -1, "its own ceiling of four pages holds");
  const big = "x".repeat(100_000);
  const tooBig = await runWasm(echo, big, { maxMemoryMb: 16, timeoutMs: 2000 });
  assert.equal(tooBig.ok, false, "an input larger than the memory it was given fails inside the box");
});

test("installing, running as a tool through the gate, and refusing changed bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-wasm-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(server.url + path, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal(app.registry.names().includes("wasm.run"), false, "off: the tool is not offered");
  const installed = await api("/api/safety-extras/wasm", { name: "echo", description: "says it back", wasm: Buffer.from(echo).toString("base64") });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.equal((await api("/api/safety-extras/wasm", { name: "sneaky", wasm: Buffer.from(sneaky).toString("base64") })).status >= 400, true);
  assert.deepEqual((await api("/api/safety-extras")).body.wasm.map((entry) => entry.name), ["echo"]);
  const off = await api("/api/safety-extras/wasm/run", { name: "echo", input: "hi" });
  assert.ok(off.status >= 400);
  await api("/api/safety-extras/switch", { part: "wasm-add-ons", mode: "when-needed" });
  assert.equal(app.registry.names().includes("wasm.run"), true);
  const ran = await api("/api/safety-extras/wasm/run", { name: "echo", input: "hi there" });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.run.output, "hi there");
  const file = join(root, "data", "wasm-add-ons", "echo.wasm");
  const bytes = await readFile(file);
  bytes[bytes.length - 2] ^= 0x01;
  await writeFile(file, bytes);
  const changed = await api("/api/safety-extras/wasm/run", { name: "echo", input: "hi" });
  assert.match(changed.body.error, /not what it was when it was installed/);
  assert.equal((await api("/api/safety-extras/wasm/remove", { name: "echo" })).body.removed, true);
  assert.ok(app.store.audit.list(app.runtime.owner).some((entry) => entry.subject === "WebAssembly add-on echo"));
  await api("/api/safety-extras/switch", { part: "wasm-add-ons", mode: "off" });
  assert.equal(app.registry.names().includes("wasm.run"), false);
});

test("the model can use an add-on inside a task, it counts as a change, and only an install may send a big body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-wasm-task-"));
  let turn = 0;
  const steps = [
    { content: "", toolCalls: [{ id: "w1", name: "wasm.run", arguments: JSON.stringify({ name: "echo", input: "from a task" }) }] },
    { content: "Done.", toolCalls: [] },
  ];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return steps[Math.min(turn++, steps.length - 1)]; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const post = async (path, body) => {
    const response = await fetch(server.url + path, { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal(categoryOf("wasm.run", "addons.wasm"), "settings", "not grouped with the looking tools");
  assert.equal((await post("/api/safety-extras/wasm", { name: "echo", wasm: Buffer.from(echo).toString("base64") })).status, 200);
  await post("/api/safety-extras/switch", { part: "wasm-add-ons", mode: "on" });
  await post("/api/policy", { preset: "off", unmatchedCommands: "allow", confirmLoosening: true }); // Q257: a loosening needs the owner's yes
  const run = await post("/api/run", { prompt: "use the add-on" });
  assert.equal(run.body.status, "completed", run.body.output);
  const done = app.store.events(run.body.id).find((event) => event.kind === "tool.completed" && event.data.name === "wasm.run");
  assert.ok(done, "wasm.run ran as a tool in the task");
  assert.match(JSON.stringify(done.data), /from a task/);
  const big = await post("/api/safety-extras/scan", { command: "x".repeat(200_000) });
  assert.equal(big.status, 413);
});

/* ---------- integration review (adversarial pass) ---------- */

async function wasmApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-wasm-review-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.store.save("settings", app.runtime.owner, "safety-wasm-add-ons", { mode: "on" });
  return { app, root, folder: join(root, "data", "wasm-add-ons") };
}

test("review: a module and its note rewritten together are still refused, since the fingerprint is also kept in the database", async (t) => {
  const { app, folder } = await wasmApp(t);
  await app.safetyExtras.wasm.install({ name: "echo", wasm: Buffer.from(echo).toString("base64") });
  const swapped = Buffer.from(spin);
  await writeFile(join(folder, "echo.wasm"), swapped);
  const note = JSON.parse(await readFile(join(folder, "echo.json"), "utf8"));
  const { createHash } = await import("node:crypto");
  await writeFile(join(folder, "echo.json"), JSON.stringify({ ...note, sha256: createHash("sha256").update(swapped).digest("hex"), bytes: swapped.length }));
  await assert.rejects(app.safetyExtras.wasm.run({ name: "echo", input: "x" }), /not what it was when it was installed/);
});

test("review: only two add-ons run at once, so the model cannot fill the memory with parallel runs", async (t) => {
  const { app } = await wasmApp(t);
  await app.safetyExtras.wasm.install({ name: "spin", wasm: Buffer.from(spin).toString("base64"), timeoutMs: 1500 });
  const runs = [0, 1, 2].map(() => app.safetyExtras.wasm.run({ name: "spin" }).then((run) => run.error ?? "ran", (error) => error.message));
  const answers = await Promise.all(runs);
  assert.equal(answers.filter((answer) => /longer than 1500 ms/.test(answer)).length, 2, JSON.stringify(answers));
  assert.equal(answers.filter((answer) => /already running/.test(answer)).length, 1, JSON.stringify(answers));
});

test("review: a damaged note leaves the card and the other add-ons working, and removing one is written in the record", async (t) => {
  const { app, folder } = await wasmApp(t);
  await app.safetyExtras.wasm.install({ name: "echo", wasm: Buffer.from(echo).toString("base64") });
  await writeFile(join(folder, "broken.json"), "{ not json");
  assert.deepEqual((await app.safetyExtras.wasm.list()).map((entry) => entry.name), ["echo"]);
  assert.equal((await app.safetyExtras.wasm.run({ name: "echo", input: "still here" })).output, "still here");
  assert.equal(await app.safetyExtras.wasm.remove("echo"), true);
  assert.ok(app.store.audit.list(app.runtime.owner).some((entry) => entry.subject === "WebAssembly add-on echo" && /Removed/.test(entry.reason)));
  await assert.rejects(app.safetyExtras.wasm.run({ name: "echo" }), /no WebAssembly add-on called echo/);
});
