/* RES-193: portable typed tool macros (src/tool-macro.ts): checked before import, typed values kept as they are,
   imported as immutable graph flows (src/flows.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { compileToolMacro, macroArgument } from "../dist/tool-macro.js";

const pkg = (steps, extra = {}) => ({ format: "branch-tool-macro/1", name: "Note it", input: { words: "text", times: "number" }, steps, ...extra });

test("a macro is checked before anything is saved: tools must exist and values must be known first", () => {
  const tools = ["files.write", "files.read"];
  const ok = compileToolMacro(pkg([{ name: "Write", tool: "files.write", args: { path: "note.txt", content: { $value: "words" } } }]), tools);
  assert.equal(ok.nodes.length, 1);
  assert.throws(() => compileToolMacro(pkg([{ name: "Nope", tool: "shell.run", args: {} }]), tools), /not registered/);
  assert.throws(() => compileToolMacro(pkg([{ name: "Read", tool: "files.read", args: { path: { $value: "later" } } }]), tools), /unknown value later/);
  assert.throws(() => compileToolMacro(pkg([{ name: "Write", tool: "files.write", args: {}, output: { words: "text" } }]), tools), /overwrites value words/);
  assert.throws(() => compileToolMacro({ ...pkg([]), format: "branch-tool-macro/2" }, tools));
});

test("a reference keeps its type and literal braces stay literal", () => {
  assert.deepEqual(macroArgument({ $value: "times" }, { times: 3 }), { matched: true, value: 3 });
  assert.deepEqual(macroArgument({ $literal: "{times}" }, { times: 3 }), { matched: true, value: "{times}" });
  assert.throws(() => macroArgument({ $value: "missing" }, {}), /unavailable/);
  assert.deepEqual(macroArgument("plain", {}), { matched: false, value: "plain" });
});

test("an imported macro is listed, cannot be changed in place, and at most 20 are kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-tool-macro-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const imported = app.flows.saveMacro(pkg([{ name: "Write", tool: "files.write", args: { path: "note.txt", content: { $value: "words" } } }]));
  assert.deepEqual(app.flows.macros().map((flow) => flow.id), [imported.id]);
  const definition = app.store.get("flow_graphs", app.runtime.owner, imported.id).data;
  assert.throws(() => app.flows.saveGraph({ ...definition, name: "Changed" }), /immutable/);
  for (let i = 1; i < 20; i++) app.flows.saveMacro(pkg([{ name: "Write", tool: "files.write", args: { path: `n${i}.txt`, content: "x" } }], { name: `M${i}` }));
  assert.throws(() => app.flows.saveMacro(pkg([{ name: "Write", tool: "files.write", args: { path: "x.txt", content: "x" } }])), /At most 20/);
  assert.deepEqual(app.flows.remove(imported.id), { removed: true });
  assert.equal(app.flows.macros().length, 19);
});
