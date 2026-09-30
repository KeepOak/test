import test from "node:test";
import { saveTroubleshootSettings } from "../dist/troubleshoot.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, parallelGroups, parallelLimit } from "../dist/index.js";
import { saveLoopGuardSettings } from "../dist/loop-guard.js";
/* The ceiling tests ask for the same call every round on purpose; the loop guard (on as Branch ships) would stop that
   first, and it has tests of its own (tests/loop-guard.test.mjs), so these switch it off to reach the ceiling. */
const noLoopGuard = (app) => saveLoopGuardSettings(app.store, app.runtime.owner, { mode: "off" });

/** A provider driven by a script, keeping the whole tool section of every request it was sent. */
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push({
      names: request.tools.map((tool) => tool.name),
      bytes: JSON.stringify(request.tools),
      system: request.messages.filter((m) => m.role === "system").map((m) => m.content).join(" "),
    });
    const step = steps[Math.min(provider.requests.length - 1, steps.length - 1)];
    return typeof step === "function" ? step(request) : step;
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const calls = (...wanted) => () => ({ content: "", toolCalls: wanted.map(([name, args], at) =>
  ({ id: `c${at}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) })) });

async function fixture(t, steps, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-speed-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "range.js"), "export function range(a, b) {\n  const out = [];\n  for (let n = a; n < b; n += 1) out.push(n);\n  return out;\n}\n");
  await writeFile(join(workspace, "src", "sum.js"), "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n");
  await writeFile(join(workspace, "README.md"), "# demo\n");
  const provider = scripted(steps);
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace, provider };
}

test("D: a tool arriving mid-task is added to the list, and nothing already sent is taken away", async (t) => {
  // The task reads for a few rounds, edits, then checks the file. The check brings files.validate into the list for
  // the first time (files.edit now travels from the start, QA Q065); before this fix a newly used tool took the last
  // place under the count and pushed whichever tool scored lowest out, so a provider holding the front of the request
  // had to read it all again.
  const { app, provider } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }]),
    calls(["files.read", { path: "src/range.js" }]),
    calls(["files.read", { path: "README.md" }]),
    calls(["files.list", { path: "src" }]),
    calls(["files.edit", { path: "src/sum.js", find: "export const sum", replace: "export const total" }]),
    calls(["files.validate", { path: "src/sum.js" }]),
    calls(["files.read", { path: "src/sum.js" }]),
    say("Done."),
  ]);
  app.coding.setMode("fewer-rounds", "off"); // it ships when needed, which loads files.edit from the first round
  const run = await app.runtime.run({ prompt: "Rename the helper in src/sum.js from sum to total everywhere it is used." });
  assert.equal(run.status, "completed", run.output);
  assert.ok(provider.requests.length >= 5, `${provider.requests.length} rounds`);

  const sent = new Set();
  const lost = [];
  for (const [at, request] of provider.requests.entries()) {
    for (const name of sent) if (!request.names.includes(name)) lost.push(`${name} was gone by round ${at + 1}`);
    for (const name of request.names) sent.add(name);
  }
  assert.deepEqual(lost, [], `tools were taken away mid-task: ${lost.join("; ")}`);

  const edited = provider.requests.findIndex((request) => request.names.includes("files.validate"));
  assert.ok(edited > 0, "files.validate arrived part-way through, which is what this test is about");
  // The round it arrived in is longer than the one before, not the same length with a swap in it.
  assert.ok(provider.requests[edited].names.length > provider.requests[edited - 1].names.length,
    "the list grew when the tool arrived rather than trading one tool for another");
});

test("D: the tool section still respects its token budget once tools are kept", async (t) => {
  const { app, provider } = await fixture(t, [
    calls(["files.read", { path: "src/range.js" }]),
    calls(["files.edit", { path: "src/range.js", find: "n < b", replace: "n <= b" }]),
    calls(["files.write", { path: "src/new.js", content: "export const x = 1;\n" }]),
    calls(["files.list", { path: "src" }]),
    say("Done."),
  ]);
  const run = await app.runtime.run({ prompt: "fix the range helper and add a file" });
  assert.equal(run.status, "completed", run.output);
  const sizes = app.store.events(run.id).filter((e) => e.kind === "catalog.size").map((e) => e.data);
  assert.ok(sizes.length >= 4);
  for (const size of sizes)
    assert.ok(size.estimatedTokens < 2500, `a round sent ~${size.estimatedTokens} tokens of tools, over the 2500 budget`);
  assert.ok(provider.requests.every((request) => request.names.includes("tools.search")),
    "every round still offers the search, so nothing became unreachable");
});

test("E: with fewer rounds on, a coding task starts with the tools it needs", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  // The request the measurement found worst: it opens the code and documents toolboxes, the words
  // shout "document" and "README", and every place went to documents tools.
  const prompt = "Add a --verbose flag to the command line and document it in the README.";
  const working = ["files.read", "files.grep", "files.list", "files.glob", "files.edit", "files.write"];

  app.coding.setMode("fewer-rounds", "off");
  await app.runtime.run({ prompt });
  const shipped = provider.requests.at(-1).names;
  assert.ok(working.some((name) => !shipped.includes(name)),
    "switched off, at least one of the working set is a search away (this is what the part is for)");

  app.coding.setMode("fewer-rounds", "on");
  await app.runtime.run({ prompt });
  const now = provider.requests.at(-1).names;
  for (const name of working)
    assert.ok(now.includes(name), `${name} was still not described in full; the task would have to search for it`);
  assert.ok(now.includes("tools.search"), "searching is still offered, so nothing became unreachable");
});

test("E: switched off, the part changes nothing and its tool is not registered", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  assert.equal(app.coding.modes()["fewer-rounds"], "when-needed", "it ships when needed (the owner's ships-on rule)");
  app.coding.setMode("fewer-rounds", "off");
  assert.equal(app.coding.modes()["fewer-rounds"], "off");
  assert.ok(!app.registry.names().includes("files.read_many"));
  const run = await app.runtime.run({ prompt: "Rename the helper in src/sum.js from sum to total." });
  assert.equal(run.status, "completed");
  const system = provider.requests.length;
  assert.ok(system > 0);
});

test("B: the line about asking for several things at once is there only when the part is on", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  app.coding.setMode("fewer-rounds", "off");
  await app.runtime.run({ prompt: "tidy up src/sum.js" });
  assert.ok(!provider.requests.at(-1).system.includes("ask for them all in one go"), "off: the line is not sent");
  app.coding.setMode("fewer-rounds", "on");
  await app.runtime.run({ prompt: "tidy up src/sum.js" });
  assert.ok(provider.requests.at(-1).system.includes("ask for them all in one go"), "on: the line is sent");
});

test("C: read_many reads several files in one call, and a path it may not read is named", async (t) => {
  const { app, workspace, provider } = await fixture(t, [
    calls(["files.read_many", { paths: ["src/sum.js", "../outside.txt", "src/range.js", "src/.env", "src/missing.js"] }]),
    say("Read them."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  await writeFile(join(workspace, "src", ".env"), "SECRET=1\n");
  const run = await app.runtime.run({ prompt: "read the source files" });
  assert.equal(run.status, "completed", run.output);
  const [done] = app.store.events(run.id).filter((e) => e.kind === "tool.completed").map((e) => e.data);
  const result = done.result;
  assert.equal(result.read, 2, "the two readable files came back");
  assert.equal(result.refused, 3, "the three that may not be read were refused");
  const by = Object.fromEntries(result.files.map((one) => [one.path, one]));
  assert.ok(by["src/sum.js"].content.includes("reduce"), "a file that was read carries its text");
  assert.ok(by["src/range.js"].content.includes("const out"));
  for (const bad of ["../outside.txt", "src/.env", "src/missing.js"]) {
    assert.ok(by[bad], `${bad} is named in the answer rather than quietly dropped`);
    assert.ok(by[bad].error, `${bad} says why it could not be read`);
    assert.ok(!by[bad].error.includes(workspace), `${bad}'s reason names this computer's folders`);
    assert.ok(!by[bad].content, `${bad} handed back no text`);
  }
  assert.ok(provider.requests.length >= 2, "the task carried on after the partial refusal");
});

test("C: reading through read_many counts as reading, per file, for the read-before-edit guard", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.read_many", { paths: ["src/sum.js", "src/range.js"] }]),
    calls(["files.edit", { path: "src/range.js", find: "n < b", replace: "n <= b" }]),
    calls(["files.edit", { path: "src/sum.js", find: "export const sum", replace: "export const total" }]),
    say("Changed both."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  app.coding.setMode("read-first", "on");
  const run = await app.runtime.run({ prompt: "fix the range helper and rename sum" });
  assert.equal(run.status, "completed", run.output);
  const edits = app.store.events(run.id).filter((e) => e.kind === "tool.completed")
    .map((e) => e.data).filter((data) => data.name === "files.edit");
  assert.equal(edits.length, 2, "both edits ran");
  for (const edit of edits)
    assert.ok(edit.result.ok !== false, `an edit was refused after read_many had read the file: ${JSON.stringify(edit.result).slice(0, 200)}`);
});

test("C: a file the task never read is still refused when reading first is on", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.read_many", { paths: ["src/sum.js"] }]),
    calls(["files.edit", { path: "src/range.js", find: "n < b", replace: "n <= b" }]),
    say("Tried."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  app.coding.setMode("read-first", "on");
  const run = await app.runtime.run({ prompt: "fix the range helper" });
  assert.equal(run.status, "completed", run.output);
  const [edit] = app.store.events(run.id).filter((e) => e.kind === "tool.failed")
    .map((e) => e.data).filter((data) => data.name === "files.edit");
  assert.ok(edit, "reading one file does not unlock editing another: the edit was refused");
  assert.match(edit.error, /read "src\/range\.js" with files\.read first/, "the refusal says to read it first, in plain words");
});

/* ---------- A: calls that only look at things may run together ---------- */

test("A: only look-only calls about different things share a group, and order is kept", () => {
  const rules = {
    readOnly: (name) => name.startsWith("files.read") || name === "files.grep" || name === "user.ask",
    targetOf: (call) => JSON.parse(call.arguments).path ?? "",
    decisionOf: (call) => (JSON.parse(call.arguments).path === "e" ? "ask" : "allow"),
    alone: ["tools.search", "user.ask"],
  };
  const call = (name, path) => ({ id: name + path, name, arguments: JSON.stringify({ path }) });
  const groups = parallelGroups([
    call("files.read", "a"), call("files.read", "b"), call("files.grep", "c"),
    call("files.write", "d"),
    call("files.read", "e"), call("files.read", "e"),
    call("user.ask", "f"),
    call("files.read", "g"),
  ], rules);
  assert.deepEqual(groups.map((group) => group.map((one) => one.name + ":" + JSON.parse(one.arguments).path)), [
    ["files.read:a", "files.read:b", "files.grep:c"],
    ["files.write:d"],
    ["files.read:e"],
    ["files.read:e"],
    ["user.ask:f"],
    ["files.read:g"],
  ], "a change runs alone; two calls about the same thing never share; asking runs alone; order never moves");
  assert.deepEqual(groups.flat().map((one) => one.id), [
    "files.reada", "files.readb", "files.grepc", "files.writed", "files.reade", "files.reade", "user.askf", "files.readg",
  ], "every call is still there, exactly once, in the order the model asked");
});

test("A: no group is bigger than the limit", () => {
  const rules = { readOnly: () => true, targetOf: (call) => call.id, decisionOf: () => "allow", alone: [] };
  const many = Array.from({ length: 20 }, (_, n) => ({ id: `c${n}`, name: "files.read", arguments: "{}" }));
  const groups = parallelGroups(many, rules);
  assert.ok(groups.every((group) => group.length <= parallelLimit), "a reply cannot open more than the limit at once");
  assert.equal(groups.flat().length, 20, "and nothing is lost");
});

test("A: with the part on, reads of different files run together and the transcript order is unchanged", async (t) => {
  const paths = ["src/sum.js", "src/range.js", "README.md"];
  const { app } = await fixture(t, [
    calls(...paths.map((path) => ["files.read", { path }])),
    say("Read them."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  const run = await app.runtime.run({ prompt: "read the three files" });
  assert.equal(run.status, "completed", run.output);
  const together = app.store.events(run.id).filter((e) => e.kind === "tools.together").map((e) => e.data);
  assert.equal(together.length, 1, "the three reads were one group");
  assert.deepEqual(together[0].calls, ["files.read", "files.read", "files.read"]);
  // Every call still has its own record and its own receipt.
  const done = app.store.events(run.id).filter((e) => e.kind === "tool.completed").map((e) => e.data);
  assert.equal(done.length, 3, "three calls, three receipts");
  assert.equal(new Set(done.map((one) => one.receipt.hash)).size, 3, "each call was signed for on its own");
  // The conversation itself reads exactly as it would have one call at a time: the answers are in
  // the order the model asked for them, whatever order they actually finished in.
  const answers = app.store.messages(run.sessionId).filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content).result.path);
  assert.deepEqual(answers, paths, "the transcript is in the order the model asked, not the order they finished");
  // The timeline, by contrast, is allowed to say when each one really finished.
  assert.equal(new Set(done.map((one) => one.result.path)).size, 3, "all three were read");
});

test("A: a change in the same reply is not run beside the reads, and reading first still holds", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "src/range.js" }],
      ["files.edit", { path: "README.md", find: "# demo", replace: "# demonstration" }]),
    say("Tried."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  app.coding.setMode("read-first", "on");
  const run = await app.runtime.run({ prompt: "read the source and retitle the readme" });
  assert.equal(run.status, "completed", run.output);
  const together = app.store.events(run.id).filter((e) => e.kind === "tools.together").map((e) => e.data);
  assert.equal(together.length, 1, "only the two reads ran together");
  assert.deepEqual(together[0].calls, ["files.read", "files.read"]);
  const [refused] = app.store.events(run.id).filter((e) => e.kind === "tool.failed").map((e) => e.data);
  assert.ok(refused && refused.name === "files.edit", "the change was still held to reading the file first");
  assert.match(refused.error, /files\.read first/);
});

test("A: a rule that refuses one call in a group still refuses it, and the others still run", async (t) => {
  const { app, workspace } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "keep.txt" }],
      ["files.read", { path: "src/range.js" }]),
    say("Done."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  await writeFile(join(workspace, "keep.txt"), "private\n");
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "files.read", match: "keep.txt", decision: "deny", remember: "always" });
  const run = await app.runtime.run({ prompt: "read the files" });
  assert.equal(run.status, "completed", run.output);
  const together = app.store.events(run.id).filter((e) => e.kind === "tools.together").map((e) => e.data);
  assert.equal(together.length, 1, "they were still one group");
  const denied = app.store.events(run.id).filter((e) => e.kind === "policy.denied").map((e) => e.data);
  assert.equal(denied.length, 1, "the rule fired for exactly the one call it names");
  assert.equal(denied[0].name, "files.read");
  const done = app.store.events(run.id).filter((e) => e.kind === "tool.completed").map((e) => e.data);
  assert.equal(done.length, 2, "the other two calls still ran");
});

test("A: switched off, calls run one after another exactly as before", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "src/range.js" }]),
    say("Done."),
  ]);
  app.coding.setMode("fewer-rounds", "off");
  const run = await app.runtime.run({ prompt: "read the two files" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(app.store.events(run.id).filter((e) => e.kind === "tools.together").length, 0,
    "nothing ran together while the part is off");
  assert.equal(app.store.events(run.id).filter((e) => e.kind === "tool.completed").length, 2);
});

test("A: a call that would be asked about runs on its own", () => {
  const asks = new Set(["ask-me", "ask-too"]);
  const rules = {
    readOnly: () => true,
    targetOf: (call) => JSON.parse(call.arguments).path,
    decisionOf: (call) => (asks.has(JSON.parse(call.arguments).path) ? "ask" : "allow"),
    alone: [],
  };
  const grep = (path, n) => ({ id: `g${n}`, name: "files.grep", arguments: JSON.stringify({ path }) });
  // Four searches of one allowed folder: nothing would be asked, so there is no yes to spend.
  assert.deepEqual(parallelGroups([grep("src", 1), grep("src", 2), grep("src", 3), grep("src", 4)], rules)
    .map((group) => group.length), [4], "four searches of an allowed folder run together");
  // The same folder, but it would raise a question: one at a time, so one yes covers one call.
  assert.deepEqual(parallelGroups([grep("ask-me", 1), grep("ask-me", 2)], rules)
    .map((group) => group.length), [1, 1], "two calls that would need the same yes run one at a time");
  // Integration: a call that would put a question to the person runs on its own even beside calls
  // about other things. Two of them in one run each registered a question, only one of them could
  // stop the task, and the other was left waiting to be answered for a call that was not running.
  assert.deepEqual(parallelGroups([grep("src", 1), grep("ask-me", 2), grep("other", 3)], rules)
    .map((group) => group.map((one) => JSON.parse(one.arguments).path)),
    [["src"], ["ask-me"], ["other"]], "asking runs alone, and the order never moves");
  assert.deepEqual(parallelGroups([grep("ask-me", 1), grep("ask-too", 2)], rules)
    .map((group) => group.length), [1, 1], "never two questions from one run");
});

test("A: four searches of the same allowed folder really do run together", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.grep", { query: "export", path: "src" }], ["files.grep", { query: "const", path: "src" }],
      ["files.grep", { query: "range", path: "src" }], ["files.grep", { query: "sum", path: "src" }]),
    say("Found them."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  const run = await app.runtime.run({ prompt: "search the project for four things" });
  assert.equal(run.status, "completed", run.output);
  const together = app.store.events(run.id).filter((e) => e.kind === "tools.together").map((e) => e.data);
  assert.equal(together.length, 1, "one group");
  assert.equal(together[0].calls.length, 4, "all four searches of the one folder ran together");
});

test("E: every toolbox a task opens puts at least one tool into that task's list", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  // Several requests that open more than one toolbox between them. None may leave a box empty.
  const prompts = [
    "Add a --verbose flag to the command line and document it in the README.",
    "The docs describe an option that no longer exists. Update them from the code.",
    "Chart the numbers in the spreadsheet and write the findings into the report.",
    "Search the web for the library's changelog and update our notes and the code.",
  ];
  for (const prompt of prompts) {
    const run = await app.runtime.run({ prompt });
    const [pre] = app.store.events(run.id).filter((e) => e.kind === "catalog.preselected").map((e) => e.data);
    const shown = provider.requests.at(-1).names;
    for (const group of pre.guessed) {
      const fromBox = shown.filter((name) => app.registry.groupOf(name) === group);
      assert.ok(fromBox.length > 0,
        `"${prompt.slice(0, 40)}…" opened the ${group} toolbox and was shown none of its tools`);
    }
  }
});

test("E: nothing leaves the index — every tool is still reachable in one step", async (t) => {
  const { app } = await fixture(t, [say("Done.")]);
  app.coding.setMode("fewer-rounds", "on");
  const { ToolLoader } = await import("../dist/index.js");
  const all = app.registry.descriptions(new Set(app.registry.permissions()));
  const loader = new ToolLoader(all, { groupOf: (name) => app.registry.groupOf(name), signals: { prompt: "fix the code" } });
  // Every registered tool can be found by its own name and is then described in full.
  const missing = [];
  for (const tool of all) {
    const found = loader.describe([tool.name]);
    if (found.unknown.length) missing.push(tool.name);
  }
  assert.deepEqual(missing, [], "a tool that cannot be found by name has left the index");
  assert.equal(loader.stats().tools, all.length, "the index still holds every tool");
});

/* ---------- the round ceiling ---------- */

test("the ceiling: a task that runs out of rounds gives its best answer and says what happened", async (t) => {
  let asked = "";
  let turn = 0;
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "user" && /^What you were asked to do:/.test(last.content)) {
      asked = String(request.tools.length);
      return { content: "I read src/sum.js and src/range.js. The off-by-one is in range.js; I did not get to fix it.", toolCalls: [] };
    }
    turn += 1;
    return { content: "", toolCalls: [{ id: `c${turn}`, name: "files.read", arguments: JSON.stringify({ path: "src/sum.js" }) }] };
  } };
  const { app } = await fixture(t, [], { provider });
  noLoopGuard(app);
  const run = await app.runtime.run({ prompt: "fix the off-by-one" });
  assert.notEqual(run.status, "completed", "the record still says it stopped at its limit");
  assert.equal(asked, "0", "the last question is asked with no tools at all");
  assert.match(run.output, /I read src\/sum\.js/, "the person is given the work, not just a limit");
  assert.match(run.output, /went back to the model 12 times/, "and a plain sentence saying why it stopped");
  assert.match(run.output, /in Settings, under Advanced/, "which says where the limit can be raised");
  assert.doesNotMatch(run.output, /^Maximum \d+ model rounds reached$/, "never the bare old sentence");
  // The real problem is named: it asked for the same thing every round.
  assert.match(run.output, /It asked for files\.read 12 times/, run.output);
  const [note] = app.store.events(run.id).filter((e) => e.kind === "rounds.exhausted").map((e) => e.data);
  assert.equal(note.limit, 12);
  assert.equal(note.answered, true);
});

test("the ceiling: a task whose tool calls all failed is told that, not just the limit", async (t) => {
  let turn = 0;
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "user" && /^What you were asked to do:/.test(last.content))
      return { content: "Nothing worked.", toolCalls: [] };
    turn += 1;
    // A different missing file each round, so it is not "the same thing again and again".
    return { content: "", toolCalls: [{ id: `c${turn}`, name: turn % 2 ? "files.read" : "files.list",
      arguments: JSON.stringify({ path: `nowhere/${turn}.js` }) }] };
  } };
  const { app } = await fixture(t, [], { provider });
  const run = await app.runtime.run({ prompt: "look at the files" });
  assert.match(run.output, /tool calls failed/, run.output);
});

test("the ceiling: the owner can raise it, and the default is still 12", async (t) => {
  let turn = 0;
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "user" && /^What you were asked to do:/.test(last.content))
      return { content: "Out of rounds.", toolCalls: [] };
    turn += 1;
    return { content: "", toolCalls: [{ id: `c${turn}`, name: "files.read", arguments: JSON.stringify({ path: "src/sum.js" }) }] };
  } };
  const { app } = await fixture(t, [], { provider });
  noLoopGuard(app);
  assert.equal(app.runtime.reliability.maxModelRounds, 12, "the shipped figure has not moved");
  const { saveKnobs, readKnobs } = await import("../dist/index.js");
  saveKnobs(app.store, "local", "limits", { maxModelRounds: 20 });
  assert.equal(readKnobs(app.store, "local", "limits").maxModelRounds, 20);
  const run = await app.runtime.run({ prompt: "read it over and over" });
  assert.match(run.output, /went back to the model 20 times/, run.output);
});

test("A: a call that pauses the task leaves none of its group still running", async (t) => {
  // A group of three reads; the middle one needs a yes, so the task stops there. The two that
  // could run still ran (they only looked at things), the first is written down, and the task is
  // waiting on the question rather than on anything of its own still going.
  const { app, workspace } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "ask.txt" }],
      ["files.read", { path: "src/range.js" }]),
    say("Done."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  await writeFile(join(workspace, "ask.txt"), "private\n");
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "files.read", match: "ask.txt", decision: "ask", remember: "always" });
  const run = await app.runtime.run({ prompt: "read the three files" });
  assert.equal(run.status, "needs_input", run.output);
  assert.match(run.output, /ask\.txt/, "it is waiting on the file it must ask about");
  // Nothing is left half-written: every call that got as far as a result has a receipt.
  const started = app.store.events(run.id).filter((e) => e.kind === "tool.started").length;
  const finished = app.store.events(run.id).filter((e) => e.kind === "tool.completed" || e.kind === "tool.failed").length;
  assert.ok(finished >= started - 1, `${started} started, ${finished} finished — a call was left in the air`);
});

test("the ceiling: a long task still gets its answer, not silence", async (t) => {
  // The task that most needs this sentence is a long one. Asking the model with the whole
  // transcript would be charged against the task's own budget and come back empty for exactly
  // those tasks, quietly. The last question is asked about a short digest instead.
  const huge = "x".repeat(40000);
  let sentToLastWord = null;
  let turn = 0;
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "user" && /^What you were asked to do:/.test(last.content)) {
      sentToLastWord = request.messages.map((m) => m.content).join("").length;
      return { content: "I looked through a lot of output and found nothing conclusive.", toolCalls: [] };
    }
    turn += 1;
    return { content: "", toolCalls: [{ id: `c${turn}`, name: "files.read", arguments: JSON.stringify({ path: "src/sum.js" }) }] };
  } };
  const { app, workspace } = await fixture(t, [], { provider });
  noLoopGuard(app);
  // The round ceiling is what this is about. Work on files gets 40 rounds by default, and at 60 steps the
  // step limit would come first; a task out of steps is not asked the last question.
  const { saveKnobs } = await import("../dist/index.js");
  // selfdev: a 40 KB file is now read (its first part) every round, so the tokens are raised to keep the rounds the limit.
  saveKnobs(app.store, "local", "limits", { maxModelRounds: 12, maxTaskTokens: 2_000_000 });
  await writeFile(join(workspace, "src", "sum.js"), huge);
  const run = await app.runtime.run({ prompt: "read it and tell me what is in it" });
  assert.match(run.output, /found nothing conclusive/, `no answer came back: ${run.output.slice(0, 200)}`);
  assert.ok(sentToLastWord !== null, "the last question was actually asked");
  assert.ok(sentToLastWord < 20000, `the last question carried ${sentToLastWord} characters; it is meant to be a digest`);
  const [note] = app.store.events(run.id).filter((e) => e.kind === "rounds.exhausted").map((e) => e.data);
  assert.equal(note.answered, true);
});

test("the digest shown to the last question is bounded whatever the task did", async () => {
  const { lastWordMessages } = await import("../dist/index.js");
  const messages = Array.from({ length: 60 }, (_, n) => ({ role: n % 2 ? "tool" : "assistant", content: `#${n} ` + "y".repeat(5000) }));
  const asked = lastWordMessages("z".repeat(9000), messages);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].role, "system");
  const size = asked.map((m) => m.content).join("").length;
  assert.ok(size < 14000, `the digest was ${size} characters; it is meant to stay small`);
  assert.match(asked[1].content, /The last of what happened:/);
  assert.match(asked[1].content, /a tool answered:/);
  assert.match(asked[1].content, /you said:/);
  // Only the end of the conversation, and only the start of each message.
  assert.ok(asked[1].content.includes("#59 "), "the last message is in it");
  assert.ok(!asked[1].content.includes("#0 "), "and the oldest ones are not");
  assert.ok(!asked[1].content.includes("y".repeat(900)), "and no one message is carried whole");
});

test("A: the rules are read once for each call and never twice", () => {
  // Integration: every call is now weighed, because one that would put a question to the person
  // must run on its own. It is a read of the saved rules, so what matters is that it happens once
  // a call however many times the grouping needs the answer.
  const asked = [];
  const rules = {
    readOnly: () => true,
    targetOf: (call) => JSON.parse(call.arguments).path,
    decisionOf: (call) => { asked.push(call.id); return "allow"; },
    alone: [],
  };
  const read = (path, n) => ({ id: `r${n}`, name: "files.read", arguments: JSON.stringify({ path }) });
  parallelGroups([read("a", 1), read("b", 2), read("c", 3), read("d", 4)], rules);
  assert.deepEqual(asked, ["r1", "r2", "r3", "r4"], "once for each call");
  asked.length = 0;
  parallelGroups([read("a", 1), read("a", 2)], rules);
  assert.deepEqual(asked, ["r1", "r2"], "the same thing twice still costs one read each, not two");
});

test("C: a many-file read never hands back more than the task will keep, and names what it left", async (t) => {
  // Ten files of 4,000 characters each: each one fits in an answer on its own, all ten together do
  // not (the task keeps 12,000 characters of a tool's answer). Returning all ten would have the end
  // simply cut off — worse than reading them one at a time, and silently. What should happen is
  // that the ones with no room are named instead.
  const { app, workspace } = await fixture(t, [
    calls(["files.read_many", { paths: Array.from({ length: 10 }, (_, n) => `src/big${n}.js`) }]),
    say("Read what I could."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  for (let n = 0; n < 10; n++) await writeFile(join(workspace, "src", `big${n}.js`), `// ${n}\n` + "y".repeat(4000));
  const run = await app.runtime.run({ prompt: "read the big files" });
  assert.equal(run.status, "completed", run.output);
  const [done] = app.store.events(run.id).filter((e) => e.kind === "tool.completed").map((e) => e.data);
  const result = done.result;
  assert.ok(result.read >= 1, "at least one file came back whole");
  assert.ok(result.skipped >= 1, `${result.skipped} were left for another call; ten 4k files cannot fit in 12k`);
  assert.equal(result.read + result.skipped + result.refused, 10, "every path is accounted for");
  assert.match(result.note, /ask for those on their own/, "and the assistant is told what to do about it");
  // Every file that did come back came back whole.
  const { readFile } = await import("node:fs/promises");
  for (const one of result.files.filter((f) => f.content !== undefined))
    assert.equal(one.content, await readFile(join(workspace, one.path), "utf8"), `${one.path} was cut short`);
  // Nothing was clipped away behind the model's back.
  assert.equal(app.store.events(run.id).filter((e) => e.kind === "tool.result_clipped").length, 0,
    "the answer fitted, so nothing had to be cut off");
});

test("Lockdown holds on both new paths: reading many files, and calls that would run together", async (t) => {
  // Lockdown makes every tool wait for a yes, reading included. So the right thing to prove is not
  // that a write is refused but that nothing at all slips past: the task stops on the first call,
  // and a group that would have run together does not run.
  const { app, workspace } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "src/range.js" }],
      ["files.write", { path: "src/new.js", content: "export const x = 1;" }]),
    say("Tried."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  app.store.save("settings", "local", "lockdown", { on: true });
  const run = await app.runtime.run({ prompt: "read them and write a file" });
  app.store.save("settings", "local", "lockdown", { on: false });
  assert.equal(run.status, "needs_input", `Lockdown let the task carry on: ${run.output}`);
  assert.equal(app.store.events(run.id).filter((e) => e.kind === "tool.completed").length, 0,
    "no tool ran while Lockdown was on");
  const { readFile } = await import("node:fs/promises");
  await assert.rejects(readFile(join(workspace, "src", "new.js"), "utf8"), "nothing was written");
});

test("Lockdown asks about reading many files exactly as it asks about reading one", async (t) => {
  const asked = async (call) => {
    const { app } = await fixture(t, [calls(call), say("Tried.")]);
    app.coding.setMode("fewer-rounds", "on");
    app.store.save("settings", "local", "lockdown", { on: true });
    const run = await app.runtime.run({ prompt: "read" });
    app.store.save("settings", "local", "lockdown", { on: false });
    return { status: run.status, asks: app.store.events(run.id).filter((e) => e.kind === "policy.ask").length };
  };
  const one = await asked(["files.read", { path: "src/sum.js" }]);
  const many = await asked(["files.read_many", { paths: ["src/sum.js", "src/range.js"] }]);
  assert.deepEqual(many, one, "the new tool is treated exactly as the one it stands in for");
  assert.equal(one.status, "needs_input");
  assert.equal(one.asks, 1);
});

/* ---------- what the service's own prompt cache served ---------- */

test("the ChatGPT route records the cached tokens the service reports", async () => {
  const { ResponsesStream } = await import("../dist/index.js");
  // What the endpoint actually sends back. Every other provider in this product reads
  // input_tokens_details.cached_tokens; this one dropped it, so a whole five-way window recorded
  // "no cache" when what it meant was "nobody looked".
  const withCache = new ResponsesStream(() => {});
  withCache.consume(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
  withCache.consume(JSON.stringify({ type: "response.completed", response: { usage: {
    input_tokens: 91292, output_tokens: 669, input_tokens_details: { cached_tokens: 77312 },
  } } }));
  assert.deepEqual(withCache.result().usage, { input: 91292, output: 669, cachedInput: 77312 });

  // A service that says nothing about caching still parses, and says nothing rather than zero:
  // "we do not know" and "nothing was cached" are different facts and must not be confused.
  const without = new ResponsesStream(() => {});
  without.consume(JSON.stringify({ type: "response.completed", response: { usage: {
    input_tokens: 100, output_tokens: 10,
  } } }));
  assert.deepEqual(without.result().usage, { input: 100, output: 10 });
  assert.equal("cachedInput" in without.result().usage, false, "absent, not zero");

  // Nothing cached this round is a real zero and is recorded as one.
  const cold = new ResponsesStream(() => {});
  cold.consume(JSON.stringify({ type: "response.completed", response: { usage: {
    input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 },
  } } }));
  assert.equal(cold.result().usage.cachedInput, 0);
});

/* ---------- finding a tool should cost one round, not three ---------- */

test("a tool found by searching comes with its inputs, so the next step can be the call", async (t) => {
  const { app } = await fixture(t, [
    calls(["tools.search", { query: "run a shell command in the workspace" }]),
    say("Found it."),
  ]);
  const run = await app.runtime.run({ prompt: "run the tests" });
  assert.equal(run.status, "completed", run.output);
  const [done] = app.store.events(run.id).filter((e) => e.kind === "tool.completed")
    .map((e) => e.data).filter((d) => d.name === "tools.search");
  // The event records only a count; the model's own answer carries the matches. Read it from the
  // conversation, which is what the model actually saw.
  const answer = app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content))
    .find((one) => one.result?.matches);
  assert.ok(answer, "the search answered");
  const withInputs = answer.result.matches.filter((one) => one.inputs !== undefined);
  assert.ok(withInputs.length >= 1 && withInputs.length <= 3,
    `${withInputs.length} matches carried their inputs; the best few should, not all twenty`);
  for (const match of withInputs) {
    assert.equal(typeof match.inputs, "object", `${match.name} carried no usable inputs`);
    assert.match(match.use, /call it now|Call .* now|^[A-Z]/, `${match.name} says what to do with it`);
  }
  assert.match(answer.result.note, /call the one you want now/);
  assert.doesNotMatch(JSON.stringify(answer.result), /from your next step; their inputs are in the tool list/);
  assert.ok(done);
});

test("a tool asked for by name comes with its inputs too", async (t) => {
  const { app } = await fixture(t, [
    calls(["tools.describe", { names: ["code.run", "not.a.tool"] }]),
    say("Loaded."),
  ]);
  const run = await app.runtime.run({ prompt: "get ready to run something" });
  assert.equal(run.status, "completed", run.output);
  const answer = app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content))
    .find((one) => one.result?.loaded);
  assert.ok(answer, "describe answered");
  const [first] = answer.result.loaded;
  assert.equal(first.name, "code.run");
  assert.equal(typeof first.inputs, "object", "the tool it asked for by name carries its inputs");
  assert.deepEqual(answer.result.unknown, ["not.a.tool"], "a name that is not a tool still reads as unknown");
});

test("a tool asked for by the name another assistant uses is found, and says what it is called here", async (t) => {
  const { app } = await fixture(t, [
    calls(["tools.describe", { names: ["shell.execute", "bash", "read_file", "genuinely.not.a.tool"] }]),
    say("Loaded."),
  ]);
  const run = await app.runtime.run({ prompt: "get ready" });
  assert.equal(run.status, "completed", run.output);
  const answer = app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content))
    .find((one) => one.result?.loaded);
  const by = Object.fromEntries(answer.result.loaded.map((one) => [one.name, one]));
  assert.ok(by["code.run"], `shell.execute and bash should both reach code.run: ${JSON.stringify(answer.result)}`);
  assert.match(by["code.run"].use, /is called code\.run here/, "and it says so, so the next call uses the right name");
  assert.ok(by["files.read"], "read_file reaches files.read");
  assert.deepEqual(answer.result.unknown, ["genuinely.not.a.tool"], "a name that is nothing still reads as unknown");
  assert.ok(by["code.run"].inputs, "and it comes with its inputs, so the next step is the call");
});

test("an outside name never shadows a real tool of that name", async () => {
  const { nameUsedElsewhere } = await import("../dist/index.js");
  // "read" and "write" are names other assistants use; Branch has no tools called that, so they
  // are free to point somewhere. If one ever becomes a real tool name, the real one must win —
  // which is what the lookup order in describe() does, and this is the reminder of why.
  assert.equal(nameUsedElsewhere("bash"), "code.run");
  assert.equal(nameUsedElsewhere("SHELL.EXECUTE"), "code.run", "the name is matched however it is typed");
  assert.equal(nameUsedElsewhere("code.run"), undefined, "a real Branch name is not in the table at all");
  assert.equal(nameUsedElsewhere("files.read"), undefined);
});

/* ---------- a task never ends on a raw provider error ---------- */

test("a model service that refuses is explained in plain words, with what the task got done", async (t) => {
  const { ProviderHttpError } = await import("../dist/index.js");
  let turn = 0;
  const provider = { name: "scripted", async complete() {
    turn += 1;
    if (turn === 1) return { content: "", toolCalls: [{ id: "c1", name: "files.read", arguments: JSON.stringify({ path: "src/sum.js" }) }] };
    throw new ProviderHttpError(400);
  } };
  const { app } = await fixture(t, [], { provider });
  const run = await app.runtime.run({ prompt: "read it and tell me about it" });
  assert.notEqual(run.status, "completed");
  assert.doesNotMatch(run.output, /^Provider HTTP/, "the person is not left with the status line as the whole answer");
  assert.match(run.output, /The model service refused this request \(400\)/);
  assert.match(run.output, /Settings, under Models/, "and is told where to look");
  assert.match(run.output, /tool call/, "and what the task did manage before it stopped");
  // The technical text is still in the record, where it belongs.
  const [noted] = app.store.events(run.id).filter((e) => e.kind === "provider.refused").map((e) => e.data);
  assert.match(noted.error, /Provider HTTP 400/);
});

test("each kind of refusal says the right thing, and anything else is left alone", async () => {
  const { providerRefusal, ProviderHttpError } = await import("../dist/index.js");
  assert.match(providerRefusal(new ProviderHttpError(401)), /would not accept this connection's sign-in/);
  assert.match(providerRefusal(new ProviderHttpError(404)), /does not know the model/);
  assert.match(providerRefusal(new ProviderHttpError(429)), /left alone for a while/);
  assert.match(providerRefusal(new ProviderHttpError(503)), /problem at its end/);
  assert.match(providerRefusal(new ProviderHttpError(422)), /refused this request \(422\)/);
  assert.equal(providerRefusal(new Error("something else")), null, "an ordinary failure is not dressed up");
  assert.equal(providerRefusal(new ProviderHttpError(302)), null, "and neither is anything that is not a refusal");
});

test("a refusal that arrives mid-stream is explained too, not just one raised before it", async () => {
  const { providerRefusal, ProviderHttpError, ProviderStreamError } = await import("../dist/index.js");
  // The plan's own lost task failed this way: the status came back while the reply was streaming,
  // so the refusal reached the task wrapped. Unwrapped, it reads the same as any other.
  const wrapped = new ProviderStreamError(new ProviderHttpError(400), 0);
  assert.match(providerRefusal(wrapped), /refused this request \(400\)/);
  assert.equal(providerRefusal(new ProviderStreamError(new Error("socket hang up"), 0)), null,
    "an ordinary mid-stream failure is still left alone");
});

/* ---------- saying once, up front, what cannot be done ---------- */

test("a task is told at the start that nothing can be run here, and only when that is true", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  await app.runtime.run({ prompt: "fix the off-by-one in src/range.js" });
  const off = provider.requests.at(-1).system;
  assert.match(off, /Running commands and scripts is switched off/,
    "as it ships, nothing can be run and the task is told so before its first round");
  // Integration: it must not say the project's tests are off. They are a separate yes
  // (src/coding/project-tests.ts) and work with scripts switched off, so saying so told an
  // assistant not to try something the owner had allowed.
  assert.doesNotMatch(off, /tests/, "it speaks only for the switch it actually reads");
  assert.match(off, /say plainly what you would have run/, "and told what to do instead");

  // With the owner's scripts switch on, the line is not there: it would be untrue.
  app.store.save("settings", "local", "code-run", { enabled: true });
  await app.runtime.run({ prompt: "fix the off-by-one in src/range.js" });
  assert.doesNotMatch(provider.requests.at(-1).system, /switched off on this computer/,
    "a task that can run things is not told it cannot");
});

test("the line is not sent for a request that is not about the project's files", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  await app.runtime.run({ prompt: "remind me to buy milk on the way home" });
  assert.doesNotMatch(provider.requests.at(-1).system, /switched off on this computer/,
    "an ordinary request is not told about commands it was never going to run");
});

test("the request itself is still the last thing the model is shown", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  const prompt = "fix the off-by-one in src/range.js";
  await app.runtime.run({ prompt });
  // A note after the request would make the last thing the model sees a line from Branch rather
  // than what the person asked for, which is how this broke a sub-task test the first time.
  const spy = { name: "spy", last: "", async complete(request) {
    spy.last = request.messages.at(-1);
    return { content: "Done.", toolCalls: [] };
  } };
  const { app: second } = await fixture(t, [], { provider: spy });
  await second.runtime.run({ prompt });
  assert.equal(spy.last.role, "user");
  assert.equal(spy.last.content, prompt);
  assert.ok(provider.requests.length > 0);
});

test("the line is said once, not every round", async (t) => {
  const { app, provider } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }]),
    calls(["files.read", { path: "src/range.js" }]),
    say("Done."),
  ]);
  const run = await app.runtime.run({ prompt: "read src/sum.js and src/range.js" });
  assert.equal(run.status, "completed", run.output);
  assert.ok(provider.requests.length >= 3, `${provider.requests.length} rounds`);
  const said = provider.requests.map((one) => (one.system.match(/switched off on this computer/g) ?? []).length);
  assert.deepEqual([...new Set(said)], [1], `it should be in the instructions once a round, never twice: ${JSON.stringify(said)}`);
});

test("a switched-off feature's tools are not offered by a search, and saying their name says why", async (t) => {
  const { app } = await fixture(t, [
    calls(["tools.search", { query: "run a shell command in the workspace" }]),
    calls(["tools.describe", { names: ["troubleshoot.run"] }]),
    say("Understood."),
  ]);
  // "Fixing failed commands" switched off by the owner (it ships when needed since the defaults audit), so
  // troubleshoot.run would only refuse. On the plan it came first in all three of one task's shell searches, ahead of
  // code.run, which is the actual shell.
  saveTroubleshootSettings(app.store, app.runtime.owner, { mode: "off" });
  const run = await app.runtime.run({ prompt: "run the tests" });
  assert.equal(run.status, "completed", run.output);
  const answers = app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  const searched = answers.find((one) => one.result?.matches);
  const names = searched.result.matches.map((one) => one.name);
  assert.ok(!names.includes("troubleshoot.run"), `a switched-off tool was offered: ${names.join(", ")}`);
  assert.ok(names.includes("code.run"), `the real shell should be there: ${names.join(", ")}`);
  // Not offered, but not hidden either: "off" must not read as "Branch cannot do this at all".
  assert.ok(searched.result.switchedOff?.includes("troubleshoot.run"),
    `the assistant should know it exists and is off: ${JSON.stringify(searched.result.switchedOff)}`);
  assert.match(searched.result.aboutThose, /switched off in Settings/);
  assert.match(searched.result.aboutThose, /Do not call them/, "and is told not to try");
  const described = answers.find((one) => one.result?.loaded !== undefined);
  assert.deepEqual(described.result.switchedOff, ["troubleshoot.run"],
    "asking for it by name says it is switched off rather than that it does not exist");
  assert.deepEqual(described.result.loaded, []);
});

test("switching the feature on puts its tool back in reach", async (t) => {
  const { app } = await fixture(t, [
    calls(["tools.search", { query: "fix a command that failed and try it again" }]),
    say("Found it."),
  ]);
  app.store.save("settings", "local", "troubleshoot", { mode: "when-needed" });
  const run = await app.runtime.run({ prompt: "sort out the failing command" });
  assert.equal(run.status, "completed", run.output);
  const searched = app.store.messages(run.sessionId).filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content)).find((one) => one.result?.matches);
  assert.ok(searched.result.matches.some((one) => one.name === "troubleshoot.run"),
    `switched on, it must be findable again: ${searched.result.matches.map((o) => o.name).join(", ")}`);
});

test("E: a request that names a file is coding work, whatever toolbox the words opened", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  app.coding.setMode("fewer-rounds", "on");
  // The plan's worst task, word for word in shape: "Document" wins the guess and the code toolbox
  // is never opened at all, so the old test — is the code or files box open — said no.
  const prompt = "Add a --shout flag to cli.mjs, and document the flag in README.md.";
  const run = await app.runtime.run({ prompt });
  assert.equal(run.status, "completed", run.output);
  const [pre] = app.store.events(run.id).filter((e) => e.kind === "catalog.preselected").map((e) => e.data);
  const shown = provider.requests.at(-1).names;
  for (const name of ["files.read", "files.write", "files.edit", "files.grep"])
    assert.ok(shown.includes(name), `${name} was missing though the request names two files; guessed ${JSON.stringify(pre.guessed)}`);
});

test("E: a request about nothing in particular is not handed coding tools", async () => {
  const { looksLikeCodingWork } = await import("../dist/index.js");
  assert.equal(looksLikeCodingWork("what did I ask you yesterday?", []), false);
  assert.equal(looksLikeCodingWork("remind me to buy milk", []), false);
  assert.equal(looksLikeCodingWork("summarise the meeting for me", ["documents"]), false,
    "a sentence about documents is not work on the project's files");
  assert.equal(looksLikeCodingWork("tidy up the README.", []), false, "a sentence ending in a word is not a file");
  assert.equal(looksLikeCodingWork("fix cli.mjs", []), true);
  assert.equal(looksLikeCodingWork("document the flag in README.md", []), true);
  assert.equal(looksLikeCodingWork("anything at all", ["code"]), true, "an open code box still counts");
});

/* ---------- integration review (mac7/speed): what the merge found and fixed ---------- */

test("C: the owner's rules judge every path in a many-file read, not the call as a whole", async (t) => {
  // Found at integration: `files.read_many` named no target, so `policyTarget` judged it with an
  // empty one. A rule refusing files.* in a folder refused files.read of a file there and let
  // files.read_many of the very same file straight through.
  const rules = [
    { tool: "files.*", match: "private/**", applies: "any", decision: "deny", remember: "never" },
    { tool: "*", match: "*", applies: "any", decision: "allow", remember: "never" },
  ];
  const { app, workspace } = await fixture(t, [
    calls(["files.read_many", { paths: ["private/pay.js", "src/sum.js"] }]), say("Done."),
  ]);
  await mkdir(join(workspace, "private"), { recursive: true });
  await writeFile(join(workspace, "private", "pay.js"), "export const pay = 3;\n");
  app.coding.setMode("fewer-rounds", "on");
  app.store.save("settings", "local", "policy", { preset: "custom", rules });
  const run = await app.runtime.run({ prompt: "read them" });
  const denied = app.store.events(run.id).filter((e) => e.kind === "policy.denied").map((e) => e.data);
  assert.equal(denied.length, 1, `the rule fired: ${run.output}`);
  assert.match(String(denied[0].reason ?? ""), /private\/pay\.js/, "and it says which path it was about");
  assert.equal(app.store.events(run.id).filter((e) => e.kind === "tool.completed").length, 0,
    "nothing was read, so the refused file's content never reached the model");
});

test("C: a file longer than one answer is handed back and said to be shortened", async (t) => {
  const { app, workspace } = await fixture(t, [calls(["files.read_many", { paths: ["big.js"] }]), say("Done.")]);
  await writeFile(join(workspace, "big.js"), `export const big = "${"x".repeat(30000)}";\n`);
  app.coding.setMode("fewer-rounds", "on");
  const run = await app.runtime.run({ prompt: "read the big one" });
  assert.equal(run.status, "completed", run.output);
  const answer = app.store.messages(run.sessionId).filter((m) => m.role === "tool").at(0).content;
  assert.match(answer, /longer than a single answer holds/, "the answer says the end was left out");
});

test("off: a call that never ran is not written down as work the task did", async (t) => {
  // Found at integration: the working line, the catalog's "just used" and the record of what a
  // task reached for were written for the whole reply before any of it ran — with the part off.
  const { app } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "src/range.js" }]), say("Done."),
  ]);
  app.store.save("settings", "local", "lockdown", { on: true }); // the first call stops the task
  const run = await app.runtime.run({ prompt: "read them both" });
  app.store.save("settings", "local", "lockdown", { on: false });
  assert.equal(run.status, "needs_input", run.output);
  const line = app.store.working.line(run.sessionId);
  assert.equal(line.file, "src/sum.js", `the live row names the call that really started, not ${line.file}`);
});

test("under Lockdown a switched-off tool reads as absent, not as one to ask the owner about", async (t) => {
  // Found at integration: Lockdown switches the same features off that the owner's own switch does,
  // so their tools landed in the hidden set and a search then named them with "tell the person they
  // can be switched on". Under Lockdown that is both the wrong advice and something it is there not
  // to say. The tools stay unoffered either way; only whether they are named changes.
  const search = async (lockdown) => {
    const { app } = await fixture(t, [
      calls(["tools.search", { query: "fix a failed command" }]), say("Understood."),
    ]);
    saveTroubleshootSettings(app.store, app.runtime.owner, { mode: "off" }); // the owner's off (it ships when needed)
    if (lockdown) app.store.save("settings", "local", "lockdown", { on: true });
    const run = await app.runtime.run({ prompt: "the build command failed, sort it out" });
    if (lockdown) app.store.save("settings", "local", "lockdown", { on: false });
    const answers = app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
    return answers.find((one) => one.result?.matches)?.result ?? {};
  };
  const open = await search(false);
  assert.ok((open.switchedOff ?? []).includes("troubleshoot.run"),
    `the owner's own switch still says what is there: ${JSON.stringify(open.switchedOff)}`);
  const locked = await search(true);
  assert.equal(locked.switchedOff, undefined, "Lockdown names nothing");
  assert.ok(!(locked.matches ?? []).some((one) => one.name === "troubleshoot.run"), "and offers nothing");
});

test("A: cancelling a task leaves no call in a group still running", async (t) => {
  // The brief's question: can a group outlive the task that started it? Two slow look-only calls
  // and a read go together; the task is cancelled while they are in flight.
  const settled = [];
  const { app } = await fixture(t, [
    calls(["files.slow", { path: "a" }], ["files.slow", { path: "b" }], ["files.read", { path: "src/sum.js" }]),
    say("Done."),
  ]);
  const { z } = await import("zod");
  app.registry.register({
    name: "files.slow", permission: "files.read", group: "files",
    description: "A file read that takes its time, for testing only.",
    parameters: z.object({ path: z.string() }).strict(),
    execute: async (input, context) => new Promise((resolve, reject) => {
      const done = (how) => { settled.push(`${input.path}:${how}`); };
      const timer = setTimeout(() => { done("finished"); resolve({ path: input.path }); }, 30000);
      context.signal.addEventListener("abort", () => {
        clearTimeout(timer); done("stopped"); reject(new Error("Cancelled"));
      }, { once: true });
    }),
  });
  app.coding.setMode("fewer-rounds", "on");
  const running = app.runtime.run({ prompt: "look at a and b" });
  // The run id is not to hand until the promise settles, so it is read from the record. The task is
  // cancelled as soon as both slow calls are in flight.
  const started = () => app.store.runs("local").find((one) => one.status === "running");
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const live = started();
      if (!live) return;
      const going = app.store.events(live.id).filter((e) => e.kind === "tool.started").length;
      if (going < 2) return;
      clearInterval(tick); app.runtime.cancel(live.id); resolve();
    }, 5);
  });
  const run = await running;
  assert.notEqual(run.status, "completed", `the task should not have finished: ${run.output}`);
  assert.equal(settled.length, 2, `both slow calls settled before the task unwound: ${settled.join(", ")}`);
  assert.ok(settled.every((one) => one.endsWith(":stopped")), `nothing was left to finish later: ${settled.join(", ")}`);
});

test("defaults audit: with fixing failed commands on, a search to run something finds the real shell first", async (t) => {
  const { app } = await fixture(t, []);
  const { ToolIndex } = await import("../dist/tool-index.js");
  const tools = app.registry.descriptions(new Set(app.registry.permissions()));
  const index = new ToolIndex(tools);
  const first = (query) => index.search(query, 3)[0]?.entry.name;
  assert.notEqual(first("run a shell command in the workspace"), "troubleshoot.run", "a first attempt is not a repair");
  assert.notEqual(first("run the tests"), "troubleshoot.run");
  assert.equal(first("fix a failed command"), "troubleshoot.run", "a failure still finds it");
});
