import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, bindInputs, substitute } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => () => ({ content, toolCalls: [] });
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, steps = [say("ok")]) {
  const root = await mkdtemp(join(tmpdir(), "branch-recipes-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about recipes, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider, context: app.runtime.context() };
}

test("recipes bind declared inputs before running and refuse missing, wrong or unknown ones", async (t) => {
  const { app, root, context } = await fixture(t);
  const recipe = {
    name: "greeting file", preconditions: [],
    parameters: { who: { type: "string", description: "Who to greet" }, count: { type: "number", required: false, default: 1 } },
    steps: [
      { tool: "files.write", args: { path: "hello-{{who}}.txt", content: "hello {{who}} x{{count}}" }, expected: { path: "hello-{{who}}.txt", bytes: "{{count}}" } },
    ],
  };
  await assert.rejects(app.registry.execute("procedures.propose", { ...recipe, steps: [{ tool: "files.write", args: { path: "{{nope}}", content: "x" }, expected: {} }] }, context), /does not declare: nope/);
  // "bytes" cannot be a placeholder for a number that depends on the text length, so make the expectation concrete.
  recipe.steps[0].expected = { path: "hello-{{who}}.txt", bytes: 12 };
  const proposed = await app.registry.execute("procedures.propose", recipe, context);
  assert.deepEqual(Object.keys(proposed.data.definition.parameters), ["who", "count"]);
  await assert.rejects(app.registry.execute("procedures.verify", { id: proposed.id }, context), /"who" is required/);
  await assert.rejects(app.registry.execute("procedures.verify", { id: proposed.id, inputs: { who: 42 } }, context), /"who" must be a string/);
  await assert.rejects(app.registry.execute("procedures.verify", { id: proposed.id, inputs: { who: "ann", extra: true } }, context), /"extra" is not an input/);
  assert.equal(await stat(join(root, "workspace", "hello-ann.txt")).catch(() => null), null, "nothing ran before the inputs were accepted");
  const verified = await app.registry.execute("procedures.verify", { id: proposed.id, inputs: { who: "ann" } }, context);
  assert.equal(verified.data.status, "verified");
  assert.equal(await readFile(join(root, "workspace", "hello-ann.txt"), "utf8"), "hello ann x1");
  const replay = await app.registry.execute("procedures.replay", { id: proposed.id, inputs: { who: "bob", count: 2 } }, context);
  assert.deepEqual(replay.results, [{ path: "hello-bob.txt", bytes: 12 }]);
  assert.equal(await readFile(join(root, "workspace", "hello-bob.txt"), "utf8"), "hello bob x2");
  const bound = app.store.runs("local").flatMap((r) => app.store.events(r.id)).find((e) => e.kind === "procedure.inputs_bound");
  assert.deepEqual(bound.data.names, ["who", "count"]);
  assert.deepEqual(bindInputs({ a: { type: "boolean", required: false } }, {}), {});
  assert.deepEqual(substitute({ n: "{{count}}", s: "n={{count}}", list: ["{{count}}"] }, { count: 3 }), { n: 3, s: "n=3", list: [3] });
});

test("a recipe with a declared result shape rejects a result that does not fit", async (t) => {
  const { app, context } = await fixture(t);
  const shaped = {
    name: "shaped", preconditions: [], parameters: {},
    steps: [{ tool: "files.write", args: { path: "s.txt", content: "abc" }, expected: { path: "s.txt", bytes: 3 } }],
    resultSchema: { type: "object", required: ["path", "bytes"], properties: { bytes: { type: "integer", minimum: 10 } } },
  };
  const proposed = await app.registry.execute("procedures.propose", shaped, context);
  await assert.rejects(app.registry.execute("procedures.verify", { id: proposed.id }, context), /did not match its declared shape: result\.bytes is below 10/);
  assert.equal(app.store.get("procedures", "local", proposed.id).data.status, "proposed");
  const rejected = app.store.runs("local").flatMap((r) => app.store.events(r.id)).find((e) => e.kind === "procedure.result_rejected");
  assert.match(rejected.data.reason, /below 10/);
  const relaxed = await app.registry.execute("procedures.propose", { ...shaped, id: proposed.id, resultSchema: { type: "object", required: ["path", "bytes"] } }, context);
  assert.equal((await app.registry.execute("procedures.verify", { id: relaxed.id }, context)).data.status, "verified");
});

test("templates carry a definition between installs without ids, evidence or secrets", async (t) => {
  const source = await fixture(t);
  const specialist = await source.app.registry.execute("specialists.propose", {
    name: "note taker", instructions: "Write tidy notes.", permissions: ["files.write", "files.read"],
    evaluation: { prompt: "write hello", checks: [{ path: "hello.txt", expected: "hello" }] },
  }, source.context);
  const server = await startServer(source.app, { dataDir: join(source.root, "data"), port: 0 });
  t.after(() => server.close());
  const headers = { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" };
  const exported = await (await fetch(`${server.url}/api/templates/specialist/${specialist.id}`, { headers })).json();
  assert.equal(exported.format, "branch-agent-template");
  assert.equal(exported.kind, "specialist");
  assert.equal(exported.definition.id, undefined);
  assert.equal(exported.definition.evidence, undefined);
  assert.deepEqual(exported.definition.permissions, ["files.write", "files.read"]);
  const leaky = await source.app.registry.execute("specialists.propose", {
    name: "leaky", instructions: "Use token sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 for the API.", permissions: ["files.read"],  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
    evaluation: { prompt: "x", checks: [{ path: "a", expected: "a" }] },
  }, source.context);
  await assert.rejects(source.app.registry.execute("templates.export", { kind: "specialist", id: leaky.id }, source.context), /Templates never carry secrets/);
  const target = await fixture(t);
  const imported = await target.app.registry.execute("templates.import", { template: exported }, target.context);
  assert.notEqual(imported.id, specialist.id);
  assert.equal(imported.data.definition.name, "note taker");
  assert.equal(imported.data.evaluationPassed, false, "an imported specialist still has to be evaluated here");
  assert.equal(imported.data.activeVersion, null);
  const narrow = { ...target.context, permissions: new Set(["files.read", "procedures.manage", "specialists.manage"]) };
  await assert.rejects(target.app.registry.execute("templates.import", { template: exported }, narrow), /escalation denied/);
  const badImport = { ...exported, definition: { ...exported.definition, instructions: "key sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" } };  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  await assert.rejects(fetch(`${server.url}/api/templates/import`, { method: "POST", headers, body: JSON.stringify(badImport) }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); }), /never carry secrets/);
});

test("a project folder scopes every file action to that folder inside the workspace", async (t) => {
  const { app, root, context } = await fixture(t);
  await app.registry.execute("files.write", { path: "top.txt", content: "root level" }, context);
  const project = app.store.projects.save("local", { id: "acme", name: "Acme", folder: "clients/acme/" });
  assert.equal(project.folder, "clients/acme");
  await assert.rejects(Promise.resolve().then(() => app.store.projects.save("local", { id: "bad", name: "Bad", folder: "../escape" })), /relative folder name/);
  app.store.projects.setActive("local", { active: "acme" });
  await app.registry.execute("files.write", { path: "brief.md", content: "acme brief" }, context);
  assert.equal(await readFile(join(root, "workspace", "clients", "acme", "brief.md"), "utf8"), "acme brief");
  const listed = await app.registry.execute("files.list", { path: "." }, context);
  assert.deepEqual(listed.entries.map((e) => e.name), ["brief.md"], "the root file is out of sight inside the project");
  await assert.rejects(app.registry.execute("files.read", { path: "../../top.txt" }, context), /Path denied|outside/);
  await assert.rejects(app.registry.execute("files.read", { path: "top.txt" }, context), /ENOENT|no such file/i);
  app.store.projects.setActive("local", { active: "default" });
  assert.equal((await app.registry.execute("files.read", { path: "top.txt" }, context)).content, "root level");
  assert.equal((await app.registry.execute("files.read", { path: "clients/acme/brief.md" }, context)).content, "acme brief");
});

test("a delegated child granted exactly one tool succeeds with it and is refused another", async (t) => {
  const steps = [
    () => ({ content: "", toolCalls: [{ id: "r1", name: "files.read", arguments: JSON.stringify({ path: "note.txt" }) }] }),
    () => ({ content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "changed" }) }] }),
    say("child done"),
  ];
  const { app, root, context } = await fixture(t, steps);
  await app.registry.execute("files.write", { path: "note.txt", content: "original" }, context);
  const parent = app.store.createRun("local", "parent");
  const child = await app.runtime.delegate("read then try to write", app.runtime.context({ runId: parent.id }), ["files.read"], "You may only read.");
  assert.equal(child.status, "completed");
  const events = app.store.events(child.id);
  assert.ok(events.some((e) => e.kind === "tool.completed" && e.data.name === "files.read"));
  const refused = events.find((e) => e.kind === "tool.failed" && e.data.name === "files.write");
  assert.match(refused.data.error, /^Permission denied: files\.write/);
  assert.equal(await readFile(join(root, "workspace", "note.txt"), "utf8"), "original", "the refused write changed nothing");
  await assert.rejects(app.runtime.delegate("x", app.runtime.context({ runId: parent.id, permissions: ["files.read"] }), ["files.write"], ""), /escalation denied/);
});
