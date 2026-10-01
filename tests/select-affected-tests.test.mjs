import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { describe, FULL_LABEL, FULL_MATRIX, laneSources, lightRun, lightSelection, nearTests, parseNameStatus, plan as planRun, planMatrix,
  platformLanes, selectImpact, VOICE_TEST } from "../scripts/select-affected-tests.mjs";
import { buildGraph, reachedTests } from "../scripts/test-graph.mjs";

const checkedIn = JSON.parse(readFileSync(new URL("test-impact.json", import.meta.url), "utf8"));

// A small repository: a page, a helper, the tests that use them, and the product the page is served by.
const sources = {
  "src/index.ts": 'import { a } from "./a.js";',
  "src/a.ts": "export const a = 1;",
  "src/server.ts": 'const page = "public/app.js"; readdir("public");',
  "public/index.html": '<script type="module" src="/app.js"></script>',
  "public/app.js": 'import "./app/state.js";',
  "public/app/state.js": "export const state = {};",
  "public/locales/en.json": "{}",
  "public/i18n.js": "fetch(`/locales/${lang}.json`);",
  "tests/helper.mjs": 'export const root = "x";',
  "tests/uses-helper.test.mjs": 'import { root } from "./helper.mjs";',
  "tests/state.test.mjs": 'import { state } from "../public/app/state.js";',
  "tests/words.test.mjs": 'import "../public/i18n.js";',
  "tests/index.test.mjs": 'import "../dist/index.js";',
  "tests/leak-guard.test.mjs": "",
  "design/tools/check.mjs": "",
  "design/tools/used.mjs": "",
  "tests/runs-tool.test.mjs": 'spawn(node, ["design/tools/used.mjs"]);',
};
const graph = buildGraph(Object.keys(sources), (file) => sources[file]);
const groups = {
  shared: ["tests/uses-helper.test.mjs", "tests/state.test.mjs", "tests/words.test.mjs", "tests/index.test.mjs",
    "tests/leak-guard.test.mjs", "tests/runs-tool.test.mjs"],
  browser: ["tests/browser.test.mjs"],
};
const weights = Object.fromEntries([...groups.shared, ...groups.browser].map((file) => [file, 10]));
const config = { ...checkedIn, partialCeiling: 0.75, mappings: [] };
const plan = (...files) => selectImpact(files.map((file) => ({ status: "M", paths: [file] })), { config, graph, groups, weights });

test("name-status parsing preserves rename pairs and paths with spaces", () => {
  assert.deepEqual(parseNameStatus("M\0docs/a file.md\0R100\0old name.ts\0new name.ts\0D\0gone.ts\0"), [
    { status: "M", paths: ["docs/a file.md"] },
    { status: "R100", paths: ["old name.ts", "new name.ts"] },
    { status: "D", paths: ["gone.ts"] },
  ]);
});

test("documentation alone runs no test, and says so", () => {
  const result = plan("docs/testing.md", "README.md");
  assert.equal(result.mode, "docs");
  assert.deepEqual(result.tests, []);
  assert.deepEqual(planMatrix(result.mode, result), []);
});

test("a changed test runs itself and the always-on files; a changed helper runs the tests that import it", () => {
  assert.deepEqual(plan("tests/state.test.mjs").tests, ["tests/leak-guard.test.mjs", "tests/state.test.mjs"]);
  assert.deepEqual(plan("tests/helper.mjs").tests, ["tests/leak-guard.test.mjs", "tests/uses-helper.test.mjs"]);
  assert.equal(plan("tests/helper.mjs").mode, "partial");
});

test("a page file runs its importers and every browser test, never the tests that only start the server", () => {
  const result = plan("public/app/state.js");
  assert.equal(result.mode, "partial");
  assert.deepEqual(result.tests, ["tests/browser.test.mjs", "tests/leak-guard.test.mjs", "tests/state.test.mjs"]);
  assert.ok(!result.tests.includes("tests/index.test.mjs"), "src/server.ts serves it; it does not run it");
});

test("a file reached only through a path built at run time is still reached", () => {
  assert.ok(plan("public/locales/en.json").tests.includes("tests/words.test.mjs"));
});

test("anything in src/, a rename or delete outside tests, the build and the workflows run the whole Linux lane", () => {
  for (const changes of [
    [{ status: "M", paths: ["src/a.ts"] }],
    [{ status: "D", paths: ["src/a.ts"] }],
    [{ status: "R100", paths: ["public/app.js", "public/main.js"] }],
    [{ status: "M", paths: [".github/workflows/checks.yml"] }],
    [{ status: "M", paths: ["package-lock.json"] }],
    [],
  ]) {
    const result = selectImpact(changes, { config, graph, groups, weights });
    assert.equal(result.mode, "full", JSON.stringify(changes));
    assert.ok(result.reasons.length > 0);
  }
});

test("a test, helper or page file nothing names fails closed; a design tool nothing names runs nothing", () => {
  const unnamed = { ...sources, "public/orphan.css": "" };
  const withOrphan = buildGraph(Object.keys(unnamed), (file) => unnamed[file]);
  const orphan = selectImpact([{ status: "A", paths: ["public/orphan.css"] }], { config, graph: withOrphan, groups, weights });
  assert.equal(orphan.mode, "full");
  assert.match(orphan.reasons.join("\n"), /Nothing names this file: public\/orphan\.css/);
  assert.equal(plan("design/tools/check.mjs").mode, "docs");
  assert.deepEqual(plan("design/tools/used.mjs").tests, ["tests/leak-guard.test.mjs", "tests/runs-tool.test.mjs"]);
});

test("a selection above the ceiling runs the whole lane rather than most of it", () => {
  const result = selectImpact([{ status: "M", paths: ["public/app/state.js"] }],
    { config: { ...config, partialCeiling: 0.2 }, graph, groups, weights });
  assert.equal(result.mode, "full");
  assert.match(result.reasons.join("\n"), /% of the Linux lane/);
});

test("the graph never walks from a test or page file into the product", () => {
  // src/server.ts names public/app.js, and every test imports the product: a page change must not reach them all.
  assert.deepEqual(reachedTests(graph, ["public/app.js"]).tests, []);
  assert.deepEqual(reachedTests(graph, ["src/a.ts"]).tests, ["tests/index.test.mjs"]);
});

test("a partial run packs fewer Linux shares, never more files than it has, and adds Windows and macOS only when asked", () => {
  const partial = planMatrix("partial", { tests: ["a", "b", "c"], predictedSeconds: 50, wholeSeconds: 100, platforms: { windows: false, macos: false } });
  assert.deepEqual(partial.map((row) => `${row.lane} ${row.shard}/${row.total} ${row.selected}`), ["linux 1/3 true", "linux 2/3 true", "linux 3/3 true"]);
  const one = planMatrix("partial", { tests: ["a"], predictedSeconds: 90, wholeSeconds: 100, platforms: { windows: true, macos: false } });
  assert.deepEqual(one.map((row) => `${row.lane} ${row.shard}/${row.total}`), ["linux 1/1", "windows 1/2", "windows 2/2"]);
  assert.deepEqual(planMatrix("full", {}), FULL_MATRIX);
  assert.equal(planMatrix("full", { platforms: { windows: false, macos: false } }).length, 8);
});

test("Windows and macOS run for their own code, the files their own tests use, and their own tests", () => {
  const laneTests = { windows: new Set(["tests/windows-helpers.test.mjs"]), macos: new Set() };
  const lanesFor = (...files) => platformLanes(files, checkedIn, laneTests, { windows: new Set(["src/win-only.ts"]), macos: new Set() });
  assert.deepEqual(lanesFor("src/desktop/main.ts"), { windows: true, macos: true });
  assert.deepEqual(lanesFor("packaging/termux/build.sh"), { windows: true, macos: true });
  assert.deepEqual(lanesFor("scripts/tray.ps1"), { windows: true, macos: false });
  assert.deepEqual(lanesFor("tests/windows-helpers.test.mjs"), { windows: true, macos: false });
  assert.deepEqual(lanesFor("src/win-only.ts"), { windows: true, macos: false });
  assert.deepEqual(lanesFor("src/a.ts", "public/app.js", "docs/x.md"), { windows: false, macos: false });
  // A change to how the suite is built or run (workflows, packages, the runner) runs every system's lane.
  for (const file of [".github/workflows/checks.yml", "package-lock.json", "package.json", "scripts/run-tests.mjs"])
    assert.deepEqual(lanesFor(file), { windows: true, macos: true }, file);
  // The window's own buttons are drawn by the page and proved on Windows by tests/desktop-window.test.mjs.
  assert.deepEqual(lanesFor("public/app/shell/controls.js"), { windows: true, macos: false });
});

test("a lane's own sources leave out the files most tests import", () => {
  const files = { "src/hub.ts": "", "src/own.ts": "", "tests/windows-a.test.mjs": 'import "../dist/own.js"; import "../dist/hub.js";' };
  for (let index = 0; index < 3; index += 1) files[`tests/t${index}.test.mjs`] = 'import "../dist/hub.js";';
  const small = buildGraph(Object.keys(files), (file) => files[file]);
  assert.deepEqual([...laneSources(small, new Set(["tests/windows-a.test.mjs"]), 2)], ["src/own.ts"]);
});

test("verify-suite and the plan say plainly when a run was partial", () => {
  const lines = describe({ mode: "partial", tests: ["a", "b"], predictedSeconds: 30, wholeSeconds: 6000, reasons: [],
    platforms: { windows: false, macos: true } }, 885);
  assert.match(lines.join("\n"), /PARTIAL: 2 of 885 Linux test files/);
  assert.match(lines.join("\n"), /Windows: skipped/);
  assert.match(lines.join("\n"), /macOS: runs/);
});

test("the checked-in impact map names only tests that still exist", () => {
  for (const file of [...checkedIn.always, ...checkedIn.mappings.flatMap((rule) => rule.tests)]) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), true, file);
  }
  assert.ok(checkedIn.partialCeiling > 0 && checkedIn.partialCeiling < 1);
  // Only redesign/window: its every push runs the whole suite. A pull request into mac/cross-platform or a release
  // branch runs the whole suite itself (beta's fast proof reads a green pull-request run as the whole suite).
  assert.deepEqual(checkedIn.partialBases, ["redesign/window"]);
});

/**
 * The ledger's guard reads docs/features.json, which `docs/**` would otherwise ignore: a reviewed mapping names it,
 * so a change to the ledger runs the guard rather than nothing.
 */
test("a change to the ledger picks up the guard that reads it", () => {
  for (const path of ["docs/features.json", "docs/features.md"]) {
    const result = selectImpact([{ status: "M", paths: [path] }], { config: checkedIn, graph, groups: {
      shared: ["tests/leak-guard.test.mjs", "tests/settings-page-count.test.mjs"], browser: [] }, weights: {} });
    assert.equal(result.mode, "partial", path);
    assert.deepEqual(result.tests, ["tests/leak-guard.test.mjs", "tests/settings-page-count.test.mjs"], path);
  }
});

test("a pull request labelled ci-full runs the whole suite on every system; without it, the diff decides", () => {
  const full = planRun("pull_request", "redesign/window", "HEAD", "HEAD", ["ui", FULL_LABEL]);
  assert.equal(full.mode, "full");
  assert.deepEqual(full.tests, []);
  assert.deepEqual(full.platforms, { windows: true, macos: true });
  assert.match(full.reasons.join(" "), /ci-full/);
  // The same pull request without the label: an empty diff (HEAD..HEAD) is not planned as the whole suite for that reason.
  const plain = planRun("pull_request", "redesign/window", "HEAD", "HEAD", ["ui"]);
  assert.doesNotMatch(plain.reasons.join(" "), /ci-full/);
});

/* A pull request's light run: `always`, then the changed tests, what the change reaches, the tests near a src/ change
   and browser tests, lightest first within each group, while two shares' time fits. Mutations: drop `always`, skip the
   budget, or reorder the groups → red. */
test("a light run keeps always, fills groups in order, lightest first, and names what it left for the merge queue", () => {
  const weights = { a: 50, b: 10, c: 30, d: 5, keep: 20 };
  const pick = lightSelection([["c", "b"], ["a", "d", "b"]], ["keep"], weights, 70);
  assert.deepEqual(pick.tests, ["b", "c", "d", "keep"], "keep 20 + b 10 + c 30 + d 5 = 65; a (50) does not fit");
  assert.deepEqual(pick.dropped, ["a"]);
  assert.equal(pick.predictedSeconds, 65);
  assert.deepEqual(lightSelection([["a"]], ["keep"], weights, 0).tests, ["keep"], "always runs even past the budget");
});

test("the tests near a src/ change skip hub files, which reach nearly every test", () => {
  const files = {
    "src/leaf.ts": "", "src/mid.ts": 'import "./leaf.js";', "src/hub.ts": 'import "./leaf.js";',
    "tests/mid.test.mjs": 'import "../dist/mid.js";', "tests/leaf.test.mjs": 'import "../dist/leaf.js";',
  };
  for (let index = 0; index < 3; index += 1) files[`tests/h${index}.test.mjs`] = 'import "../dist/hub.js";';
  const small = buildGraph(Object.keys(files), (file) => files[file]);
  assert.deepEqual([...nearTests(small, ["src/leaf.ts"], 2)].sort(), ["tests/leaf.test.mjs", "tests/mid.test.mjs"]);
  assert.deepEqual([...nearTests(small, ["src/hub.ts"], 2)], [], "a changed hub adds nothing of its own");
  assert.deepEqual([...nearTests(small, ["src/leaf.ts"], 2, 1)], ["tests/leaf.test.mjs"], "one step out: direct users only");
});

/* The regression: a pull request touching src/ ran eight Linux shares, two Windows, one macOS and voice. Mutations:
   run the whole lane for a src/ change, or plan more than prLinuxShards Linux shares → red. */
test("a pull request's src/ change runs the tests near it on at most two Linux shares, never the whole lane", () => {
  const change = [{ status: "M", paths: ["src/a.ts"] }];
  const result = selectImpact(change, { config, graph, groups, weights });
  assert.equal(result.mode, "full");
  const light = lightRun(result, { config: { ...config, prLinuxShards: 2 }, graph, groups, weights, files: ["src/a.ts"], wholeSeconds: 80 });
  assert.equal(light.mode, "partial");
  assert.deepEqual(light.tests, ["tests/index.test.mjs", "tests/leak-guard.test.mjs"]);
  assert.match(light.reasons.join("\n"), /merge queue runs the whole suite/);
  assert.equal(light.voice, false);
  const rows = planMatrix(light.mode, { ...light, wholeSeconds: 80, platforms: { windows: false, macos: false } });
  assert.ok(rows.length >= 1 && rows.length <= 2, "at least one share, so the build (the type-check) always runs");
  assert.ok(rows.every((row) => row.lane === "linux" && row.selected));
  // A big selection is cut to two shares' time, and what is left is said.
  const heavy = Object.fromEntries(Object.keys(weights).map((file) => [file, 40]));
  const cut = lightRun(selectImpact([{ status: "M", paths: ["public/app/state.js"] }], { config, graph, groups, weights: heavy }),
    { config: { ...config, prLinuxShards: 2 }, graph, groups, weights: heavy, files: ["public/app/state.js"], wholeSeconds: 280 });
  assert.ok(cut.predictedSeconds <= 70, `two of eight shares of 280 s: ${cut.predictedSeconds}`);
  assert.ok(cut.left > 0);
  assert.match(cut.reasons.join("\n"), /left for the merge queue/);
  assert.equal(planMatrix("partial", { tests: ["a", "b", "c", "d"], predictedSeconds: 100, wholeSeconds: 100, maxLinux: 2,
    platforms: { windows: false, macos: false } }).length, 2);
  const docs = lightRun(selectImpact([{ status: "M", paths: ["docs/x.md"] }], { config, graph, groups, weights }), { config, graph, groups, weights, files: ["docs/x.md"], wholeSeconds: 70 });
  assert.equal(docs.mode, "docs");
  assert.equal(docs.voice, false);
});

test("local voice runs on a pull request only when its light run reaches the voice test", () => {
  const files = { "src/voice.ts": "", [VOICE_TEST]: 'import "../dist/voice.js";', "tests/leak-guard.test.mjs": "" };
  const small = buildGraph(Object.keys(files), (file) => files[file]);
  const smallGroups = { shared: [VOICE_TEST, "tests/leak-guard.test.mjs"], browser: [] };
  const result = selectImpact([{ status: "M", paths: ["src/voice.ts"] }], { config, graph: small, groups: smallGroups, weights: {} });
  const light = lightRun(result, { config, graph: small, groups: smallGroups, weights: {}, files: ["src/voice.ts"], wholeSeconds: 1 });
  assert.equal(light.voice, true);
  assert.equal(planRun("push", "redesign/window").voice, true, "off a pull request the voice proof always runs");
});

/* Windows computer control (src/computer/windows*, src/integrations/desktop-script*.ts, tests/windows-computer-* and
   their helper tests/windows-proof-kit.mjs) keeps its Windows shares on a pull request, while a central file that one
   Windows test happens to import (src/runtime.ts: 15 test importers) no longer turns Windows on. */
test("Windows computer control runs Windows on a pull request; a file most tests share does not", () => {
  const files = {
    "tests/windows-proof-kit.mjs": "export const kit = 1;",
    "tests/windows-computer-proof.test.mjs": 'import "./windows-proof-kit.mjs";',
  };
  const small = buildGraph(Object.keys(files), (file) => files[file]);
  const laneTests = { windows: new Set(["tests/windows-computer-proof.test.mjs"]), macos: new Set() };
  const helperOnly = reachedTests(small, ["tests/windows-proof-kit.mjs"]).tests;
  assert.deepEqual(platformLanes(["tests/windows-proof-kit.mjs"], checkedIn, laneTests, {}, helperOnly), { windows: true, macos: false });
  assert.deepEqual(platformLanes(["tests/windows-proof-kit.mjs"], checkedIn, laneTests, {}, []), { windows: false, macos: false });
  for (const file of ["src/computer/windows-capture.ts", "src/integrations/desktop-script.ts", "src/integrations/desktop-script-posix.ts"])
    assert.equal(platformLanes([file], checkedIn).windows, true, file);
  assert.deepEqual(platformLanes(["tests/windows-computer-proof.test.mjs"], checkedIn, laneTests), { windows: true, macos: false });
  assert.ok(checkedIn.platformSourceTests >= 1 && checkedIn.platformSourceTests < checkedIn.hubTests);
  assert.equal(checkedIn.prLinuxShards, 4);
});

/* A script sends the whole lane in selectImpact, so its own tests were missing from a pull request's light run
   (scripts/run-tests.mjs ran only leak-guard). Mutation: drop the script reach group → red. */
test("a changed script runs the tests that import or run it on a pull request", () => {
  const files = {
    "scripts/run-tests.mjs": "export const lanes = 1;",
    "tests/run-tests.test.mjs": 'import { lanes } from "../scripts/run-tests.mjs";',
    "tests/other.test.mjs": "",
    "tests/leak-guard.test.mjs": "",
  };
  const small = buildGraph(Object.keys(files), (file) => files[file]);
  const smallGroups = { shared: ["tests/run-tests.test.mjs", "tests/other.test.mjs", "tests/leak-guard.test.mjs"], browser: [] };
  const result = selectImpact([{ status: "M", paths: ["scripts/run-tests.mjs"] }], { config, graph: small, groups: smallGroups, weights: {} });
  assert.equal(result.mode, "full");
  const light = lightRun(result, { config, graph: small, groups: smallGroups, weights: {}, files: ["scripts/run-tests.mjs"], wholeSeconds: 1 });
  assert.deepEqual(light.tests, ["tests/leak-guard.test.mjs", "tests/run-tests.test.mjs"]);
});
