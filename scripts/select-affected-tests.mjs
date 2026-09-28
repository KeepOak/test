// The plan for one Checks run: which test files each system runs, from what the change touches.
//
// Every push (redesign/window, mac/cross-platform, release branches), the nightly run, a run by hand, and a pull
// request into anything but redesign/window run the whole suite on every system. A pull request into redesign/window
// runs what its change can reach, measured against the commit it is merged onto (the merge ref's first parent):
//   docs     documentation only: whitespace and documentation references are checked here; no test runs.
//   partial  tests, test helpers and public/ only: the changed tests, the tests that use a changed helper or page file,
//            every browser test when public/ changed, the reviewed mappings in tests/test-impact.json, and `always`.
//   full     anything in src/ or any other product, build or workflow file: the whole Linux lane.
// A static import graph cannot narrow a src/ change: 663 of 871 test files import dist/index.js, which imports nearly
// all of src/ (measured 2026-09-28). Windows and macOS run on a pull request only when it touches their own code
// (tests/test-impact.json `platforms`, and the src/ files their own tests use directly) or their own test files.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lanes, testGroups } from "./run-tests.mjs";
import { buildGraph, isTest, reachedTests, usersOf } from "./test-graph.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (file) => file.replace(/\\/g, "/");

/** The whole suite: eight Linux shares, two Windows, one macOS (the shares are packed by tests/shard-weights.json). */
export const FULL_MATRIX = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) => ({ lane: "linux", os: "ubuntu-latest", shard, total: 8, concurrency: "2,2" })),
  ...[1, 2].map((shard) => ({ lane: "windows", os: "windows-latest", shard, total: 2, concurrency: "3,1" })),
  { lane: "macos", os: "macos-latest", shard: 1, total: 1, concurrency: "3,2" },
];

function glob(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

const matches = (file, patterns = []) => patterns.some((pattern) => glob(pattern).test(file));

function safePath(file) {
  return typeof file === "string" && file.length > 0 && !file.includes("\\") && !file.startsWith("/")
    && !file.split("/").includes("..");
}

/** Parse `git diff --name-status -z` without treating file names as shell text. */
export function parseNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^(?:[ACDMRTUXB]|R\d{1,3}|C\d{1,3})$/.test(status)) throw new Error(`Unsupported git status: ${status || "<empty>"}`);
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (index + count > fields.length) throw new Error(`Incomplete git status record: ${status}`);
    changes.push({ status, paths: fields.slice(index, index + count) });
    index += count;
  }
  return changes;
}

const TESTS_OR_PUBLIC = /^(?:tests|packages\/sdk\/test|public)\//;

/** One changed file's part of the plan: `full` with a reason, or the tests it adds (none for documentation). */
function inspectChange(change, config, state) {
  if (!change?.paths?.length || change.paths.some((file) => !safePath(file))) return full(state, "The diff contains an invalid or unsafe path.");
  const file = change.paths.at(-1);
  const rules = config.mappings.filter((rule) => matches(file, rule.paths));
  const docs = !rules.length && change.paths.every((one) => matches(one, config.ignored));
  if (docs) return;
  if (/^D/.test(change.status) && isTest(file)) return void (state.product = true);
  if (/^[DRC]/.test(change.status) && !change.paths.every(isTest)) return full(state, `${change.status}: ${change.paths.join(" -> ")}`);
  if (matches(file, config.fullRequired)) return full(state, `Whole-suite path changed: ${file}`);
  if (file.startsWith("src/")) return full(state, `Product change: ${file}`);
  if (!TESTS_OR_PUBLIC.test(file) && !rules.length) return void state.other.push(file);
  state.product = true;
  for (const rule of rules) for (const test of rule.tests) state.selected.add(test);
  if (file.startsWith("public/")) state.browser = true;
  if (TESTS_OR_PUBLIC.test(file)) state.graph.push(file);
}

/**
 * The tests the graph reaches. A test, helper or page file nothing names is unknown, so the whole lane runs. Any
 * other file (a design tool, an evaluation) is the product's when src/ or public/ uses it (the whole lane runs), a
 * test's when only tests and scripts do, and cannot change a test's result when nothing names it.
 */
function followGraph(graph, state) {
  for (const file of state.other) {
    const product = [...usersOf(graph, file)].find((user) => /^(?:src|public)\//.test(user));
    if (product) full(state, `${product} uses ${file}`);
  }
  if (state.full) return;
  const reached = reachedTests(graph, [...state.graph, ...state.other]);
  for (const test of reached.tests) state.selected.add(test);
  const unused = new Set(reached.unreached);
  for (const file of state.graph) if (unused.has(file) && !isTest(file)) full(state, `Nothing names this file: ${file}`);
  for (const file of state.other) {
    if (unused.has(file)) state.notes.push(`No code or test uses ${file}.`);
    else state.product = true;
  }
}

function full(state, reason) {
  state.full = true;
  state.reasons.push(reason);
}

/** Whether a pull request's change needs Windows or macOS: their own code, the files their tests use, or those tests. */
export function platformLanes(files, config, laneTests = { windows: new Set(), macos: new Set() }, laneSources = {}) {
  const need = {};
  for (const lane of ["windows", "macos"]) {
    need[lane] = files.some((file) => matches(file, config.platforms?.[lane])
      || laneTests[lane]?.has(file) || laneSources[lane]?.has(file));
  }
  return need;
}

/**
 * The plan for a pull request's changes. `groups` are the discovered Linux-lane test files (shared, browser), `graph`
 * the test graph, `weights` the Linux seconds per file. Returns { mode, reasons, tests, predictedSeconds }.
 */
export function selectImpact(changes, { config, graph, groups, weights = {} }) {
  const state = { reasons: [], notes: [], selected: new Set(), graph: [], other: [], full: false, product: false, browser: false };
  if (!changes.length) full(state, "No changed files were found; refusing an empty green result.");
  for (const change of changes) inspectChange(change, config, state);
  if (!state.full && (state.graph.length || state.other.length)) followGraph(graph, state);
  if (state.browser) for (const test of groups.browser) state.selected.add(posix(test));
  if (state.product) for (const test of config.always) state.selected.add(test);
  const linux = new Set([...groups.shared, ...groups.browser].map(posix));
  const tests = [...state.selected].filter((test) => linux.has(test)).sort();
  const seconds = (list) => list.reduce((total, file) => total + (weights[file] ?? 0), 0);
  const predictedSeconds = Math.round(seconds(tests));
  const whole = seconds([...linux]);
  if (!state.full && predictedSeconds > config.partialCeiling * whole) {
    full(state, `The selection is ${Math.round((100 * predictedSeconds) / whole)}% of the Linux lane; running all of it.`);
  }
  const mode = state.full ? "full" : !state.product ? "docs" : tests.length ? "partial" : "full";
  if (mode === "full" && !state.full) state.reasons.push("The change reaches no Linux test file; running all of them.");
  const reasons = [...new Set([...state.reasons, ...state.notes])].sort();
  return { mode, reasons, tests: mode === "partial" ? tests : [], predictedSeconds };
}

/** The matrix rows for a plan: the Linux shares (fewer for a partial run), then Windows and macOS when needed. */
export function planMatrix(mode, { tests = [], predictedSeconds = 0, wholeSeconds = 1, platforms = { windows: true, macos: true } }) {
  if (mode === "docs") return [];
  const linux = FULL_MATRIX.filter((row) => row.lane === "linux");
  let rows = linux;
  if (mode === "partial") {
    const total = Math.max(1, Math.min(linux.length, tests.length, Math.ceil((linux.length * predictedSeconds) / wholeSeconds)));
    rows = Array.from({ length: total }, (_, index) => ({ ...linux[0], shard: index + 1, total, selected: true }));
  }
  return [...rows, ...FULL_MATRIX.filter((row) => row.lane !== "linux" && platforms[row.lane])];
}

/** The src/ files a lane's own test files import directly, less the ones most tests import (dist/index.js and such). */
export function laneSources(graph, laneTests, hubLimit) {
  const sources = new Set();
  for (const [target, importers] of graph.importers) {
    if (!target.startsWith("src/")) continue;
    const tests = [...importers].filter(isTest);
    if (tests.length <= hubLimit && tests.some((test) => laneTests.has(test))) sources.add(target);
  }
  return sources;
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** A pull request into redesign/window: its plan from the merge ref's own diff. Anything else: the whole suite. */
export function plan(event, baseRef, from = "HEAD^1", to = "HEAD") {
  const config = JSON.parse(readFileSync(join(root, "tests", "test-impact.json"), "utf8"));
  const weights = JSON.parse(readFileSync(join(root, "tests", "shard-weights.json"), "utf8")).linux ?? {};
  const all = lanes(testGroups());
  const flat = (lane) => new Set([...lane.shared, ...lane.browser, ...lane.desktop].map(posix));
  const wholeSeconds = [...flat(all.linux)].reduce((total, file) => total + (weights[file] ?? 0), 0);
  if (event !== "pull_request" || !config.partialBases.includes(baseRef)) {
    return { mode: "full", reasons: [`A ${event} run${baseRef ? ` into ${baseRef}` : ""} runs the whole suite.`], tests: [],
      platforms: { windows: true, macos: true }, wholeSeconds, predictedSeconds: wholeSeconds };
  }
  const changes = parseNameStatus(git("diff", "--name-status", "-z", "--find-renames", from, to));
  const graph = buildGraph(git("ls-files", "-z").split("\0").filter(Boolean), (file) => readFileSync(join(root, file), "utf8"));
  const groups = { shared: all.linux.shared.map(posix), browser: all.linux.browser.map(posix) };
  const result = selectImpact(changes, { config, graph, groups, weights });
  const laneTests = { windows: flat(all.windows), macos: flat(all.macos) };
  const sources = Object.fromEntries(["windows", "macos"].map((lane) => [lane, laneSources(graph, laneTests[lane], config.hubTests)]));
  const files = changes.flatMap((change) => change.paths);
  return { ...result, platforms: platformLanes(files, config, laneTests, sources), wholeSeconds, changed: files.length };
}

/** What green means for this run, in words: printed, and written to the run's summary. */
export function describe(result, total) {
  const lines = [`Mode: ${result.mode}`];
  if (result.mode === "partial") lines.push(`PARTIAL: ${result.tests.length} of ${total} Linux test files (predicted ${result.predictedSeconds} s of ${Math.round(result.wholeSeconds)} s). The whole suite runs on the merge into redesign/window.`);
  if (result.mode === "docs") lines.push("Documentation only: whitespace and documentation references are checked; no test file runs.");
  lines.push(`Windows: ${result.platforms.windows ? "runs" : "skipped (no Windows code or Windows test changed)"}`);
  lines.push(`macOS: ${result.platforms.macos ? "runs" : "skipped (no macOS code or macOS test changed)"}`);
  for (const reason of result.reasons) lines.push(`- ${reason}`);
  return lines;
}

function runCli() {
  const result = plan(argument("event") ?? "", argument("base-ref") ?? "");
  const total = lanes(testGroups()).linux;
  const lines = describe(result, total.shared.length + total.browser.length);
  const matrix = planMatrix(result.mode, result);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nmatrix=${JSON.stringify({ include: matrix })}\n`
      + `selected=${JSON.stringify(result.tests)}\nsummary=${JSON.stringify(lines)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Checks plan\n${lines.map((line) => `${line}\n`).join("")}`);
  console.log(lines.join("\n"));
  console.log(`Jobs: ${matrix.map((row) => `${row.lane} ${row.shard}/${row.total}`).join(", ") || "none"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
