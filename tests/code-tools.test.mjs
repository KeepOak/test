import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ignoreMatcher, scorePath } from "../dist/index.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-code-tools-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ dataDir, workspace });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about the edit and patch tools, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, workspace };
}
const put = async (workspace, path, content) => {
  await mkdir(join(workspace, path, ".."), { recursive: true });
  await writeFile(join(workspace, path), content);
};
const read = (workspace, path) => readFile(join(workspace, path), "utf8");
const readOnly = (app) => app.runtime.context({ permissions: ["files.read"] });

test("files.glob lists matching files and honours the ignore file", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/alpha.ts", "export const alpha = 1;\n");
  await put(workspace, "src/beta.ts", "export const beta = 2;\n");
  await put(workspace, "src/notes.md", "# Notes\n");
  await put(workspace, "build/generated.ts", "export const generated = 3;\n");
  await put(workspace, ".branchignore", "build/\n*.md\n");

  const all = await app.runtime.executeTool("files.glob", { patterns: ["**/*.ts"] });
  assert.deepEqual(all.files.map((f) => f.path).sort(), ["src/alpha.ts", "src/beta.ts"]);
  assert.equal(all.moreAvailable, false);
  assert.ok(all.files.every((f) => f.bytes > 0));

  const markdown = await app.runtime.executeTool("files.glob", { patterns: ["**/*.md"] });
  assert.deepEqual(markdown.files, [], "an ignored pattern hides the file");
});

test("the ignore matcher understands anchors, directories and negation", () => {
  const match = ignoreMatcher("# comment\nbuild/\n*.log\n!keep.log\n/root-only.txt\ndocs/**/draft.md\n").ignores;
  assert.equal(match("build/x.js"), true);
  assert.equal(match("build", true), true);
  assert.equal(match("build", false), false, "a file named like a directory rule stays");
  assert.equal(match("deep/a.log"), true);
  assert.equal(match("deep/keep.log"), false);
  assert.equal(match("root-only.txt"), true);
  assert.equal(match("sub/root-only.txt"), false);
  assert.equal(match("docs/a/b/draft.md"), true);
});

test("files.grep reports context lines, filters by pattern and skips files that are not text", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/server.ts", "const port = 8080;\nstart(port);\nconsole.log('ready');\n");
  await put(workspace, "src/readme.md", "start(port);\n");
  await put(workspace, "src/image.bin", Buffer.from([0x50, 0x00, 0x51, 0x52]));

  const found = await app.runtime.executeTool("files.grep", { query: "start(", context: 1, glob: ["**/*.ts"] });
  assert.equal(found.matches.length, 1);
  assert.deepEqual(found.matches[0], {
    path: "src/server.ts", line: 2, text: "start(port);",
    before: ["const port = 8080;"], after: ["console.log('ready');"],
  });
  assert.equal(found.filesSkipped, 0, "the pattern filters before the file is opened");

  const everywhere = await app.runtime.executeTool("files.grep", { query: "START(", regex: false });
  assert.equal(everywhere.matches.length, 2, "the search ignores capitals by default");
  assert.equal(everywhere.filesSkipped, 1, "the file that is not text is skipped");
  assert.equal(everywhere.filesSearched, 2);

  const expression = await app.runtime.executeTool("files.grep", { query: "port\\s*=\\s*\\d+", regex: true });
  assert.equal(expression.matches[0].line, 1);
  const capitals = await app.runtime.executeTool("files.grep", { query: "START(", caseSensitive: true });
  assert.deepEqual(capitals.matches, []);
});

test("files.patch changes several files at once and every change can be undone", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "a.txt", "one\ntwo\nthree\n");
  await put(workspace, "b.txt", "alpha\nbeta\n");

  const result = await app.runtime.executeTool("files.patch", {
    patch: [
      "--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three",
      "--- a/b.txt", "+++ b/b.txt", "@@ -2,1 +2,2 @@", "-beta", "+BETA", "+gamma",
      "--- /dev/null", "+++ b/c.txt", "@@ -0,0 +1,1 @@", "+new file", "",
    ].join("\n"),
  });
  assert.deepEqual(result.files.map((f) => f.path), ["a.txt", "b.txt", "c.txt"]);
  assert.equal(result.files[2].created, true);
  assert.equal(result.files[0].added, 1);
  assert.equal(result.files[0].removed, 1);
  assert.match(result.files[0].diff, /-two/);
  assert.equal(await read(workspace, "a.txt"), "one\nTWO\nthree\n");
  assert.equal(await read(workspace, "b.txt"), "alpha\nBETA\ngamma\n");
  assert.equal(await read(workspace, "c.txt"), "new file\n");

  const versions = await app.runtime.executeTool("files.history", { path: "a.txt" });
  await app.runtime.executeTool("files.restore", { versionId: versions[0].id });
  assert.equal(await read(workspace, "a.txt"), "one\ntwo\nthree\n", "the change before the patch comes back");
});

test("a patch that does not fit is refused by name and leaves every file untouched", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "first.txt", "keep\nchange me\n");
  await put(workspace, "second.txt", "unrelated\n");

  await assert.rejects(app.runtime.executeTool("files.patch", {
    patch: [
      "--- a/first.txt", "+++ b/first.txt", "@@ -1,2 +1,2 @@", " keep", "-change me", "+changed",
      "--- a/second.txt", "+++ b/second.txt", "@@ -1,1 +1,1 @@", "-this is not what the file says", "+replacement", "",
    ].join("\n"),
  }), /part 1 of the patch for "second.txt" does not match the file at line 1/);

  assert.equal(await read(workspace, "first.txt"), "keep\nchange me\n", "the first file was never written");
  assert.equal(await read(workspace, "second.txt"), "unrelated\n");
  assert.deepEqual(await app.runtime.executeTool("files.history", { path: "first.txt" }), []);
});

test("a patch keeps Windows line endings and refuses a file it cannot change", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "windows.txt", "one\r\ntwo\r\n");
  await app.runtime.executeTool("files.patch", {
    patch: ["--- a/windows.txt", "+++ b/windows.txt", "@@ -1,2 +1,2 @@", " one", "-two", "+TWO", ""].join("\n"),
  });
  assert.equal(await read(workspace, "windows.txt"), "one\r\nTWO\r\n");

  await put(workspace, "big.txt", "x".repeat(40000));
  await assert.rejects(app.runtime.executeTool("files.patch", {
    patch: ["--- a/big.txt", "+++ b/big.txt", "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"),
  }), /larger than 32 KiB/);
});

test("files.edit refuses an ambiguous replacement and records the change it does make", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "config.txt", "level = 1\nlevel = 1\n");

  await assert.rejects(
    app.runtime.executeTool("files.edit", { path: "config.txt", find: "level = 1", replace: "level = 2" }),
    /contains that text 2 time\(s\), but 1 was expected/,
  );
  assert.equal(await read(workspace, "config.txt"), "level = 1\nlevel = 1\n");

  const change = await app.runtime.executeTool("files.edit", {
    path: "config.txt", find: "level = 1", replace: "level = 2", expectedOccurrences: 2,
  });
  assert.equal(change.added, 2);
  assert.equal(await read(workspace, "config.txt"), "level = 2\nlevel = 2\n");
  const versions = await app.runtime.executeTool("files.history", { path: "config.txt" });
  await app.runtime.executeTool("files.restore", { versionId: versions[0].id });
  assert.equal(await read(workspace, "config.txt"), "level = 1\nlevel = 1\n");
});

test("files.validate reports problems as data, not as a failure", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "good.json", '{ "a": 1 }');
  await put(workspace, "broken.json", '{ "a": 1,\n');
  await put(workspace, "good.mjs", "export const a = 1;\n");
  await put(workspace, "broken.mjs", "export const a = ;\n");
  await put(workspace, "typed.ts", "export const a: number = 1;\n");

  assert.deepEqual(await app.runtime.executeTool("files.validate", { path: "good.json" }),
    { path: "good.json", language: "JSON", checked: true, ok: true, problems: [] });
  const bad = await app.runtime.executeTool("files.validate", { path: "broken.json" });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 1);
  assert.ok(bad.problems[0].message.length > 0);

  assert.equal((await app.runtime.executeTool("files.validate", { path: "good.mjs" })).ok, true);
  const script = await app.runtime.executeTool("files.validate", { path: "broken.mjs" });
  assert.equal(script.ok, false);
  assert.match(script.problems[0].message, /SyntaxError/);
  assert.equal(script.problems[0].line, 1);

  // bucket-18 (A0537): TypeScript is now read by Node's own type stripper; TSX gets the bracket check only.
  const typed = await app.runtime.executeTool("files.validate", { path: "typed.ts" });
  assert.equal(typed.checked, true);
  assert.equal(typed.ok, true);
  await put(workspace, "view.tsx", "export const a = <b />;\n");
  const tsx = await app.runtime.executeTool("files.validate", { path: "view.tsx" });
  assert.equal(tsx.checked, true);
  assert.match(tsx.note, /Only brackets.*TypeScript compiler/);
  await put(workspace, "notes.txt", "hello\n");
  assert.equal((await app.runtime.executeTool("files.validate", { path: "notes.txt" })).checked, false);
});

test("workspace.map shows what each file holds and reads a file again only when it changes", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/app.ts", "export class Engine {}\nexport function start() {}\nconst hidden = 1;\n");
  await put(workspace, "notes/guide.md", "# Guide\n## Setup\ntext\n");
  await put(workspace, "tool.py", "class Robot:\n    def go(self):\n        pass\ndef main():\n    pass\n");

  const first = await app.runtime.executeTool("workspace.map", {});
  assert.equal(first.cacheHits, 0);
  const byPath = Object.fromEntries(first.files.map((f) => [f.path, f]));
  assert.deepEqual(byPath["src/app.ts"].symbols, ["Engine", "start", "hidden"]);
  assert.equal(byPath["src/app.ts"].language, "TypeScript");
  assert.deepEqual(byPath["notes/guide.md"].symbols, ["# Guide", "## Setup"]);
  assert.deepEqual(byPath["tool.py"].symbols, ["Robot", "main"]);
  assert.ok(first.folders.includes("src") && first.folders.includes("notes"));

  const second = await app.runtime.executeTool("workspace.map", {});
  assert.equal(second.cacheHits, 3, "unchanged files are answered from the cache");
  await put(workspace, "src/app.ts", "export class Engine {}\nexport function stop() {}\n");
  const third = await app.runtime.executeTool("workspace.map", {});
  assert.equal(third.cacheHits, 2, "the changed file is read again");
  assert.deepEqual(third.files.find((f) => f.path === "src/app.ts").symbols, ["Engine", "stop"]);
});

test("files.find puts the closest file names first", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/user-profile.ts", "x\n");
  await put(workspace, "src/nested/deeply/unrelated-serialiser.ts", "x\n");
  await put(workspace, "docs/profile.md", "x\n");

  const found = await app.runtime.executeTool("files.find", { query: "profile" });
  assert.equal(found.files[0].path, "docs/profile.md");
  assert.equal(found.files[1].path, "src/user-profile.ts");
  assert.equal(found.files.length, 2, "a file with no match in order is left out");
  assert.ok(scorePath("docs/profile.md", "profile") > scorePath("src/user-profile.ts", "profile"));
  assert.equal(scorePath("src/app.ts", "zzz"), 0);
  assert.equal((await app.runtime.executeTool("files.find", { query: "prof", limit: 1 })).files.length, 1);
});

test("a big workspace comes back bounded and says there is more, instead of failing", async (t) => {
  const { app, workspace } = await fixture(t);
  await mkdir(join(workspace, "bulk"), { recursive: true });
  const name = "a_rather_long_generated_name_so_each_answer_entry_costs_real_bytes";
  for (let i = 0; i < 500; i++)
    await writeFile(join(workspace, "bulk", `${name}-${String(i).padStart(4, "0")}.ts`),
      `export const ${name}_${i} = ${i};\n`);
  await put(workspace, "many-matches.ts", Array.from({ length: 300 }, (_, i) => `const marker${i} = "look here";`).join("\n"));

  const listed = await app.runtime.executeTool("files.glob", { patterns: ["bulk/*.ts"] });
  assert.equal(listed.moreAvailable, true, "the answer is cut short rather than overflowing");
  assert.ok(listed.files.length > 0 && listed.files.length < 500);
  const mapped = await app.runtime.executeTool("workspace.map", { path: "bulk", limit: 400 });
  assert.equal(mapped.moreAvailable, true);
  assert.ok(mapped.files.length < 400);
  const found = await app.runtime.executeTool("files.grep", {
    query: "look here", context: 2, maxResults: 200, glob: ["many-matches.ts"],
  });
  assert.equal(found.moreAvailable, true);
  assert.ok(found.matches.length > 0 && found.matches.length <= 200);
  for (const answer of [listed, mapped, found])
    assert.ok(JSON.stringify(answer).length < 65536, "every answer fits the tool output limit");
});

test("every tool stays inside the workspace and the write tools need permission", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "inside.txt", "line\n");
  const outside = "../outside.txt";
  const calls = [
    ["files.glob", { patterns: ["*"], path: outside }],
    ["files.grep", { query: "line", path: outside }],
    ["workspace.map", { path: outside }],
    ["files.validate", { path: outside }],
    ["files.edit", { path: outside, find: "line", replace: "x" }],
  ];
  for (const [name, args] of calls)
    await assert.rejects(app.runtime.executeTool(name, args), /Path denied|outside workspace/, name);
  await assert.rejects(app.runtime.executeTool("files.patch", {
    patch: ["--- a/../outside.txt", "+++ b/../outside.txt", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n"),
  }), /not a workspace path/);
  await assert.rejects(app.runtime.executeTool("files.grep", { query: "x", path: "C:/Windows" }), /Path denied/);

  for (const [name, args] of [["files.patch", { patch: "x" }], ["files.edit", { path: "inside.txt", find: "line", replace: "x" }]])
    await assert.rejects(app.registry.execute(name, args, readOnly(app)), /Permission denied: files.write/, name);
  const listed = app.registry.descriptions(new Set(["files.read"])).map((tool) => tool.name);
  for (const name of ["files.glob", "files.grep", "files.find", "workspace.map", "files.validate"])
    assert.ok(listed.includes(name), `${name} is offered with read permission`);
  for (const name of ["files.patch", "files.edit"]) assert.ok(!listed.includes(name), `${name} needs write permission`);
});
