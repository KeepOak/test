import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { applyHunks, parsePatch } from "../dist/patch.js";
import { replaceText } from "../dist/text-replace.js";

/* mac7/coding-gap: the edit tools place a model's change where it belongs, not only where it said. */
const apply = (patch, before) => parsePatch(patch).map((file) => applyHunks(file, before))[0];
const source = "import x from 'y';\n\nfunction add(a, b) {\n  return a - b;\n}\n\nexport { add };\n";

test("a hunk whose line number is wrong is placed by its lines", () => {
  const patch = ["--- a/m.js", "+++ b/m.js", "@@ -40,3 +40,3 @@", " function add(a, b) {", "-  return a - b;", "+  return a + b;", " }", ""].join("\n");
  assert.equal(apply(patch, source), source.replace("a - b", "a + b"));
});

test("wrong declared counts and a header with no numbers still apply", () => {
  const wrongCounts = ["--- a/m.js", "+++ b/m.js", "@@ -3,9 +3,9 @@", "-  return a - b;", "+  return a + b;", ""].join("\n");
  assert.equal(apply(wrongCounts, source), source.replace("a - b", "a + b"));
  const bare = ["--- a/m.js", "+++ b/m.js", "@@", "-  return a - b;", "+  return a + b;"].join("\n");
  assert.equal(apply(bare, source), source.replace("a - b", "a + b"));
});

test("context that differs only in whitespace matches, and the file keeps its own context lines", () => {
  const tabbed = "if (x) {\n\treturn 1;\n}\n";
  const patch = ["--- a/t.js", "+++ b/t.js", "@@ -1,3 +1,3 @@", " if (x) {  ", "-    return 1;", "+\treturn 2;", " }", ""].join("\n");
  assert.equal(apply(patch, tabbed), "if (x) {\n\treturn 2;\n}\n");
});

test("the *** Begin Patch form updates and adds files", () => {
  const patch = [
    "*** Begin Patch", "*** Update File: m.js", "@@ function add(a, b) {", "-  return a - b;", "+  return a + b;",
    "*** Add File: new.js", "+export const one = 1;", "*** End Patch",
  ].join("\n");
  const files = parsePatch(patch);
  assert.deepEqual(files.map((file) => [file.path, file.created]), [["m.js", false], ["new.js", true]]);
  assert.equal(applyHunks(files[0], source), source.replace("a - b", "a + b"));
  assert.equal(applyHunks(files[1], null), "export const one = 1;\n");
});

test("lines that are nowhere in the file are still refused, and the refusal says what to do", () => {
  const patch = ["--- a/m.js", "+++ b/m.js", "@@ -1,1 +1,1 @@", "-this is not in the file", "+x", ""].join("\n");
  assert.throws(() => apply(patch, source), /does not match the file at line 1; nothing was changed\. .*Read the file again/);
});

test("replaceText: exact first, then trailing whitespace, then indentation (re-indented)", () => {
  assert.deepEqual(replaceText("a = 1\n", "a = 1", "a = 2", 1, "x"), { after: "a = 2\n", found: 1, tolerant: null });
  assert.equal(replaceText("a = 1   \nb\n", "a = 1\nb", "a = 2\nb", 1, "x").after, "a = 2\nb\n");
  const nested = "class A {\n    run() {\n        go();\n    }\n}\n";
  const result = replaceText(nested, "run() {\n    go();\n}", "run() {\n    stop();\n}", 1, "x");
  assert.equal(result.tolerant, "indentation");
  assert.equal(result.after, "class A {\n    run() {\n        stop();\n    }\n}\n");
});

test("replaceText refusals say how many there are, or show the closest line", () => {
  assert.throws(() => replaceText("v = 1\nv = 1\n", "v = 1", "v = 2", 1, "Edit refused: \"c\""),
    /contains that text 2 time\(s\), but 1 was expected\. Include more of the surrounding lines.*expectedOccurrences to 2/);
  assert.throws(() => replaceText("const total = items.length;\n", "const total = item.length;", "x", 1, "Edit refused: \"c\""),
    /0 time\(s\).*closest line is 1: "const total = items.length;".*read exactly:\nconst total = items.length;/s);
  assert.equal(replaceText("v = 1\nv = 1\n", "v = 1", "v = 2", "all", "x").after, "v = 2\nv = 2\n");
});

test("files.edit takes other agents' argument names and replaceAll, through the real tool", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ dataDir: join(root, "data"), workspace });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about editing, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  await writeFile(join(workspace, "c.txt"), "n = 1\nn = 1\n");
  await app.runtime.executeTool("files.edit", { file_path: "c.txt", old_string: "n = 1", new_string: "n = 2", replace_all: true });
  assert.equal(await readFile(join(workspace, "c.txt"), "utf8"), "n = 2\nn = 2\n");
  await writeFile(join(workspace, "d.js"), "function f() {\n\treturn 1;\n}\n");
  const change = await app.runtime.executeTool("files.edit", { path: "d.js", find: "function f() {\n    return 1;\n}", replace: "function f() {\n    return 2;\n}" });
  assert.equal(change.matched, "ignoring indentation");
  assert.equal(await readFile(join(workspace, "d.js"), "utf8"), "function f() {\n\treturn 2;\n}\n");
});

test("a task's deadline is the caller's when given, so a longer --timeout really is longer", async (t) => {
  const { runDeadline } = await import("../dist/runtime.js");
  assert.equal(runDeadline(undefined), 120000);
  assert.equal(runDeadline(600000), 600000, "ten minutes asked, ten minutes given — not capped at two");
  assert.equal(runDeadline(10 ** 12), 24 * 60 * 60 * 1000);
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const slow = { name: "scripted", async complete(request) {
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 300); request.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(request.signal.reason); }); });
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider: slow });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const cut = await app.runtime.run({ prompt: "hi", timeoutMs: 50 });
  assert.equal(cut.status, "cancelled", "the run's own deadline comes from timeoutMs");
  /* ci-flakes-4: a whole run (setup, the model's 300 ms, the record) took more than 5 s on a Windows
     build machine that was crawling, so this arm was cancelled too. The contrast with the 50 ms arm
     above is what proves a longer deadline really is longer, and that contrast is untouched. */
  const whole = await app.runtime.run({ prompt: "hi", timeoutMs: 120000 });
  assert.equal(whole.status, "completed");
});

test("a reply that is all thinking is nudged to act, twice at most, before the task counts as empty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  let calls = 0;
  const seen = [];
  const thinker = (answerOn) => ({ name: "scripted", async complete(request) {
    calls++;
    seen.push(request.messages.at(-1)?.content ?? "");
    return calls === answerOn ? { content: "Done.", toolCalls: [] } : { content: "", toolCalls: [], reasoningChars: 900 };
  } });
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider: thinker(2) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "fix it" });
  assert.equal(run.status, "completed");
  assert.equal(calls, 2);
  assert.match(seen[1], /thinking but no answer and no tool call/);
  assert.equal(app.runtime.store.events(run.id).filter((e) => e.kind === "model.empty_reply").length, 1);

  const root2 = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  calls = 0;
  const never = await createBranch({ dataDir: join(root2, "data"), workspace: join(root2, "w"), provider: thinker(99) });
  t.after(async () => { await never.close(); await discardTemp(root2); });
  const empty = await never.runtime.run({ prompt: "fix it" });
  assert.equal(empty.status, "failed", "still judged to have produced nothing");
  assert.equal(calls, 3, "one reply and two nudges, no more");
});

test("code.check with nothing set up says the task can go on; with scripts on it runs node --test", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(workspace, "test", "a.test.mjs"), "import test from 'node:test'; import assert from 'node:assert'; test('x', () => assert.equal(1, 2));\n");
  const app = await createBranch({ dataDir: join(root, "data"), workspace });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const off = await app.runtime.executeTool("code.check", {});
  assert.equal(off.ran, false);
  assert.match(off.note, /does not block the task: read the test files/);
  app.store.save("settings", app.runtime.owner, "code-run", { enabled: true });
  const on = await app.runtime.executeTool("code.check", {});
  assert.equal(on.ran, true);
  assert.equal(on.ok, false);
  assert.match(on.note, /node --test/);
  assert.match(on.output, /fail 1/);
});

test("a reply cut off while thinking raises that run's reply ceiling, twice at most", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const asked = [];
  const cramped = (enough) => ({ name: "scripted", async complete(request) {
    asked.push(request.maxTokens);
    if (request.maxTokens < enough) throw new Error("The model used its whole reply allowance thinking (9,000 characters) and was cut off before it answered. Try a larger model, or ask for one step at a time.");
    return { content: "Done.", toolCalls: [] };
  } });
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider: cramped(4096) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "think hard" });
  assert.equal(run.status, "completed");
  assert.deepEqual(asked, [2048, 4096]);
  const next = await app.runtime.run({ prompt: "again" });
  assert.equal(next.status, "completed");
  assert.deepEqual(asked.slice(2), [2048, 4096], "the next run starts at 2,048 again");
});

test("the ceiling stops at 8,192: a model that never fits still fails with the same sentence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const asked = [];
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider: { name: "scripted", async complete(request) {
    asked.push(request.maxTokens);
    throw new Error("The model used its whole reply allowance thinking (9,000 characters) and was cut off before it answered. Try a larger model, or ask for one step at a time.");
  } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "think hard" });
  assert.equal(run.status, "failed");
  assert.match(run.output, /whole reply allowance thinking/);
  assert.deepEqual(asked.slice(0, 3), [2048, 4096, 8192]);
});

test("a refused edit shows the file's real lines, and an empty find appends or creates", async (t) => {
  const file = "function formatPrice(cents) {\n  return \"$\" + (cents / 100).toFixed(2);\n}\n\nexport const x = 1;\n";
  assert.throws(() => replaceText(file, "function formatPrice(price) {\n  return `$${price.toFixed(2)}`;\n}", "x", 1, "Edit refused: \"c\""),
    (error) => error.message.includes("read exactly:\nfunction formatPrice(cents) {\n  return \"$\" + (cents / 100).toFixed(2);\n}"));
  assert.equal(replaceText("a\n", "", "b\n", 1, "x").after, "a\nb\n");
  assert.equal(replaceText("a", "", "b", 1, "x").after, "a\nb");
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ dataDir: join(root, "data"), workspace });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about editing, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  const made = await app.runtime.executeTool("files.edit", { path: "src/new.js", find: "", replace: "export const one = 1;\n" });
  assert.equal(made.created, true);
  assert.equal(await readFile(join(workspace, "src/new.js"), "utf8"), "export const one = 1;\n");
  await app.runtime.executeTool("files.edit", { path: "src/new.js", find: "", replace: "export const two = 2;\n" });
  assert.equal(await readFile(join(workspace, "src/new.js"), "utf8"), "export const one = 1;\nexport const two = 2;\n");
  await assert.rejects(app.runtime.executeTool("files.edit", { path: "missing.js", find: "x", replace: "y" }), /does not exist/);
});

/* ---------------------------------------------------------------- integration review: never guess, keep the file's own shape */

const patchFor = (path, header, ...body) => ["--- a/" + path, "+++ b/" + path, header, ...body, ""].join("\n");
const refusedAsUnclear = /fits the file in \d+ places .*not clear; nothing was changed/;

test("review: a part that fits two places with no line number is refused, never placed on the first", () => {
  const twice = "function a() {\n  return x;\n}\nfunction b() {\n  return x;\n}\n";
  assert.throws(() => apply(patchFor("m.js", "@@", "-  return x;", "+  return y;"), twice), refusedAsUnclear);
  const envelope = ["*** Begin Patch", "*** Update File: m.js", "@@", "-  return x;", "+  return y;", "*** End Patch"].join("\n");
  assert.throws(() => applyHunks(parsePatch(envelope)[0], twice), refusedAsUnclear);
});

test("review: with a line number, the named place wins, a strictly nearer exact match is taken, a tie is refused", () => {
  const file = "a\nDUP\nb\nc\nd\nDUP\ne\n";
  assert.equal(apply(patchFor("f", "@@ -6,1 +6,1 @@", "-DUP", "+NEW"), file), "a\nDUP\nb\nc\nd\nNEW\ne\n", "named line fits: taken");
  assert.equal(apply(patchFor("f", "@@ -3,1 +3,1 @@", "-DUP", "+NEW"), file), "a\nNEW\nb\nc\nd\nDUP\ne\n", "one line off: nearest");
  assert.throws(() => apply(patchFor("f", "@@ -4,1 +4,1 @@", "-DUP", "+NEW"), file), refusedAsUnclear, "equally far both ways");
});

test("review: a loose (whitespace-only) match must be the only one; the named line still decides when it fits", () => {
  const file = "\tfoo();\n\tbar();\n\tfoo();\n";
  assert.throws(() => apply(patchFor("f", "@@ -9,1 +9,1 @@", "-    foo();", "+    baz();"), file), refusedAsUnclear);
  assert.equal(apply(patchFor("f", "@@ -3,1 +3,1 @@", "-    foo();", "+    baz();"), file), "\tfoo();\n\tbar();\n\tbaz();\n",
    "matched ignoring indentation at the named line, and the new line takes the file's tab");
});

test("review: @@ anchors in the *** Begin Patch form say which of two identical blocks is meant", () => {
  const twice = "class A {\n  run() {\n    return 1;\n  }\n}\nclass B {\n  run() {\n    return 1;\n  }\n}\n";
  const envelope = (...head) => ["*** Begin Patch", "*** Update File: m.js", ...head, "-    return 1;", "+    return 2;", "*** End Patch"].join("\n");
  const [file] = parsePatch(envelope("@@ class B {"));
  assert.deepEqual(file.hunks[0].anchors, ["class B {"]);
  assert.equal(applyHunks(file, twice), twice.replace(/(class B[\s\S]*?)return 1/, "$1return 2"));
  assert.equal(applyHunks(parsePatch(envelope("@@ class B {", "@@   run() {"))[0], twice), twice.replace(/(class B[\s\S]*?)return 1/, "$1return 2"), "stacked anchors");
  assert.throws(() => applyHunks(parsePatch(envelope("@@ class C {"))[0], twice), /names the line "class C \{", which is not in the file/);
});

test("review: a part that only adds lines goes after its line number, or at the end; never guessed", () => {
  const file = "one\ntwo\nthree\n";
  assert.equal(apply(patchFor("f", "@@ -2,0 +3,1 @@", "+inserted"), file), "one\ntwo\ninserted\nthree\n");
  assert.throws(() => apply(patchFor("f", "@@ -40,0 +41,1 @@", "+late"), file), /adds lines after line 40.*nothing was changed/);
  const add = (...head) => ["*** Begin Patch", "*** Update File: f", ...head, "+tail", "*** End Patch"].join("\n");
  assert.equal(applyHunks(parsePatch(add("@@"))[0], file), "one\ntwo\nthree\ntail\n", "no line named: the end, as the *** form means");
  assert.throws(() => applyHunks(parsePatch(add("@@ two"))[0], file), /only adds lines, so where they go is not clear/);
});

test("review: a Windows (CRLF) file stays CRLF through a patch, and a mixed file keeps each line's own ending", () => {
  const crlf = "a\r\nb\r\nc\r\n";
  const out = apply(patchFor("f", "@@ -2,1 +2,2 @@", "-b", "+B", "+B2"), crlf);
  assert.equal(out, "a\r\nB\r\nB2\r\nc\r\n");
  const mixed = "a\r\nb\nc\r\nd\n";
  assert.equal(apply(patchFor("f", "@@ -3,1 +3,1 @@", "-c", "+C"), mixed), "a\r\nb\nC\r\nd\n", "untouched lines keep theirs");
  assert.equal(apply(patchFor("f", "@@ -1,1 +1,1 @@", "-x", "+y"), "x"), "y", "no final newline stays that way");
});

test("review: *** Update File paths are taken as written, so a folder named b is not stripped", () => {
  const [file] = parsePatch(["*** Begin Patch", "*** Add File: b/new.js", "+x", "*** End Patch"].join("\n"));
  assert.equal(file.path, "b/new.js");
  assert.equal(applyHunks(file, null), "x\n");
  assert.throws(() => parsePatch(["*** Begin Patch", "*** Update File: ../out.js", "@@", "-a", "+b", "*** End Patch"].join("\n")), /not a workspace path/);
});

test("review: replaceText keeps a CRLF file CRLF, exact or tolerant, and a mixed file's other lines untouched", () => {
  const crlf = "function f() {\r\n\treturn 1;\r\n}\r\n";
  const exact = replaceText(crlf, "function f() {\n\treturn 1;\n}", "function f() {\n\treturn 2;\n}", 1, "x");
  assert.equal(exact.tolerant, null, "plain newlines against a CRLF file are an exact match, not a whitespace slip");
  assert.equal(exact.after, "function f() {\r\n\treturn 2;\r\n}\r\n");
  const loose = replaceText(crlf, "function f() {\n    return 1;\n}", "function f() {\n    return 3;\n    // done\n}", 1, "x");
  assert.equal(loose.tolerant, "indentation");
  assert.equal(loose.after, "function f() {\r\n\treturn 3;\r\n\t// done\r\n}\r\n");
  const mixed = "a\r\nkeep\n  x = 1\r\nz\n";
  assert.equal(replaceText(mixed, "x = 1   ", "x = 2", 1, "x").after, "a\r\nkeep\n  x = 2\r\nz\n");
  assert.equal(replaceText("a\r\nb", "", "c", 1, "x").after, "a\r\nb\r\nc", "appending to a CRLF file uses CRLF");
});

test("review: writing files never runs them — after code.patch or code.change_set only the owner's own check runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(workspace, "notes.txt"), "one\r\ntwo\r\n");
  const app = await createBranch({ dataDir: join(root, "data"), workspace });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about editing, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.store.save("settings", app.runtime.owner, "code-run", { enabled: true });
  // A test file the patch itself writes: if writing ran the tests, this would run and leave a mark.
  const marker = join(workspace, "ran.txt").replace(/\\/g, "/");
  const body = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`;
  const patched = await app.runtime.executeTool("code.patch", { patch: ["--- /dev/null", "+++ b/test/a.test.mjs", "@@ -0,0 +1,1 @@", `+${body}`, ""].join("\n") });
  assert.equal(patched.check.ran, false, "a files.write tool does not run the project's tests");
  const changed = await app.runtime.executeTool("code.change_set", { reason: "add a line", edits: [{ path: "notes.txt", find: "", replace: "three\n" }] });
  assert.equal(changed.check.ran, false);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "one\r\ntwo\r\nthree\r\n", "an empty find appends, in the file's own line ending");
  await assert.rejects(app.runtime.executeTool("code.change_set", { reason: "x", edits: [{ path: "missing.txt", find: "", replace: "x" }] }), /does not exist/);
  await assert.rejects(readFile(marker, "utf8"), "nothing ran the test file");
  const asked = await app.runtime.executeTool("code.check", {});
  assert.equal(asked.ran, true, "code.check, asked for by name, does run them");
  assert.equal(await readFile(marker, "utf8"), "ran");
});
