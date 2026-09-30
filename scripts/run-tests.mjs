// `npm test`: every test file, each in its own `node --test` process, several at a time.
//
// Each file runs as `node --test --test-concurrency=1 <file>` (as scripts/review.mjs does since #412): the browser
// and engine tests start their servers on port 0 in their own temporary folders, so files do not share a port or a
// data folder. Ordinary files run BRANCH_TEST_CONCURRENCY's first number at a time (default 3), browser files its
// second (default 1) beside them, and desktop-app files one at a time: three Electron windows at once on a
// four-processor build machine once took over two minutes just to say "Connected". The longest files start first.
//
// `--lane=linux|windows|macos` picks one system's part of the suite (see lanes() below): each file runs once, on
// Linux, unless it holds tests only another system can run. `--shard=2/6` then runs the second of six shares of
// that part, packed by how long each file took in the last measured Checks run (tests/shard-weights.json). Every file of a lane
// lands in exactly one share; tests/run-tests.test.mjs holds that. With neither flag every file runs here.
//
// BRANCH_TEST_FILE_TIMEOUT=<seconds> ends a file that runs longer, and everything it started, and names it: one file
// that never exited once held a build machine for an hour. BRANCH_TEST_TIMINGS=<file> writes each file's seconds,
// which is where the weights come from (scripts/test-weights.mjs). `--list` prints the files and runs nothing.
// `--files-from=selected-tests.json` runs an explicit selector-produced subset and refuses any path that is not part
// of the discovered suite, and an empty subset. With --lane and --shard it is split like the whole suite.
// `--retry-failed` (merge-queue and push runs only) runs a failed file once more, alone, after the share has finished,
// when at most RETRY_AT_MOST files failed and none ran past its limit; a file that passes then is named flaky, not
// hidden. On 2026-09-30 load-driven browser flakes ejected four merge-queue groups in an hour.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const folders = ["tests", join("packages", "sdk", "test")];
const desktop = (file) => /^tests[\\/]desktop[^\\/]*\.test\.mjs$/.test(file);
const browserImport = /^\s*(?:import\b[^\n]*from\s+["']playwright["']|(?:const|let|var)\b[^\n]*import\(["']playwright["']\))/m;
const here = fileURLToPath(new URL(".", import.meta.url));
const weightsFile = join(here, "..", "tests", "shard-weights.json");
const posix = (file) => file.replace(/\\/g, "/");
export const LANES = { linux: "linux", windows: "win32", macos: "darwin" };

/** Test files in a stable order, split by how much real browser machinery each starts. */
export function testGroups(list = (folder) => readdirSync(folder), read = (file) => readFileSync(file, "utf8")) {
  const files = folders.flatMap((folder) =>
    list(folder).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join(folder, name)));
  const desktopFiles = files.filter(desktop);
  const browser = files.filter((file) => !desktop(file) && browserImport.test(read(file)));
  return { shared: files.filter((file) => !desktop(file) && !browser.includes(file)), browser, desktop: desktopFiles };
}

/**
 * Only the named groups ("shared,browser,desktop"), the others left empty, so the shares are packed from what runs.
 * No list means every group.
 */
export function onlyGroups(groups, list) {
  if (!list) return groups;
  const wanted = new Set(list.split(",").map((name) => name.trim()).filter(Boolean));
  for (const name of wanted) if (!(name in groups)) throw new Error(`Unknown test group "${name}": expected shared, browser or desktop`);
  return Object.fromEntries(Object.entries(groups).map(([name, files]) => [name, wanted.has(name) ? files : []]));
}

/**
 * Whether a file holds a test only this system (`win32` or `darwin`) runs: one that skips or returns everywhere
 * else. Written `process.platform !== "win32"`, or through a name given to `process.platform === "win32"` and then
 * negated (`const windows = process.platform === "win32"; … skip: !windows`). A file that only skips ON that system
 * is not counted: Linux runs those tests.
 */
export function onlyOn(source, platform) {
  const quoted = `["']${platform}["']`;
  if (new RegExp(`process\\.platform\\s*!==?\\s*${quoted}`).test(source)) return true;
  const alias = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*process\\.platform\\s*===?\\s*${quoted}\\s*;`, "g");
  return [...source.matchAll(alias)].some(([, name]) => new RegExp(`!\\s*${name.replace(/\$/g, "\\$")}\\b`).test(source));
}

/**
 * Which files each system's lane runs. Linux runs every file but the desktop app's; Windows runs the desktop app's,
 * the Windows helpers, the uninstall and console files and every file with a Windows-only test; macOS every file
 * with a macOS-only test. So a test runs on each system that can run it at most once, and every test somewhere.
 */
export function lanes(groups, read = (file) => readFileSync(file, "utf8")) {
  const windowsByName = /^tests\/(?:windows-[^/]*|[^/]*uninstall[^/]*|[^/]*console[^/]*)\.test\.mjs$/;
  const pick = (test) => Object.fromEntries(Object.entries(groups).map(([name, files]) => [name, files.filter(test)]));
  return {
    linux: pick((file) => !desktop(file)),
    windows: pick((file) => desktop(file) || windowsByName.test(posix(file)) || onlyOn(read(file), "win32")),
    macos: pick((file) => onlyOn(read(file), "darwin")),
  };
}

/** `--lane=windows` → that lane's groups; no flag → every file. */
export function laneGroups(argv, groups, read) {
  const flag = argv.find((arg) => arg.startsWith("--lane="));
  if (!flag) return { lane: null, groups };
  const lane = flag.slice("--lane=".length);
  if (!(lane in LANES)) throw new Error(`Bad ${flag}: expected --lane=linux, windows or macos`);
  return { lane, groups: lanes(groups, read)[lane] };
}

/** The measured seconds per file for this kind of computer, or an empty map. */
export function loadWeights(platform = process.platform, read = () => readFileSync(weightsFile, "utf8")) {
  try {
    return JSON.parse(read())[platform] ?? {};
  } catch {
    return {};
  }
}

/** A file's measured seconds, or the median of the measured ones for a file never measured (a new one). */
function costOf(weights) {
  const known = Object.values(weights).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  return (file) => weights[posix(file)] ?? fallback;
}

/** Pack the files into `total` shares of about equal time: longest first, each to the lightest share. */
export function shards(files, total, weights = {}) {
  const cost = costOf(weights);
  const order = [...files].sort((a, b) => cost(b) - cost(a) || (posix(a) < posix(b) ? -1 : 1));
  const shares = Array.from({ length: total }, () => ({ files: [], load: 0 }));
  for (const file of order) {
    const lightest = shares.reduce((best, share) => (share.load < best.load ? share : best));
    lightest.files.push(file);
    lightest.load += cost(file);
  }
  // Keep each share in the usual file order, so its list reads like a normal run.
  return shares.map((share) => files.filter((file) => share.files.includes(file)));
}

/**
 * One build machine's files. The ordinary files and the one-at-a-time ones are packed apart, so every share gets an
 * even part of each: packed together, one share drew most of the browser files and ran past its limit (Q38).
 */
export function shareFiles(groups, index, total, weights = {}) {
  return [...shards(groups.shared, total, weights)[index], ...shards([...groups.browser, ...groups.desktop], total, weights)[index]];
}

/** `--shard=2/5` → { index: 1, total: 5 }; no flag → the whole suite as one share. */
export function parseShard(argv) {
  const flag = argv.find((arg) => arg.startsWith("--shard="));
  if (!flag) return { index: 0, total: 1 };
  const match = /^--shard=(\d+)\/(\d+)$/.exec(flag);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || total < 1 || index < 1 || index > total) throw new Error(`Bad ${flag}: expected --shard=<n>/<total>`);
  return { index: index - 1, total };
}

/**
 * Read an explicit selector-produced subset, prove every entry belongs to the discovered suite (`all`), and keep only
 * those files in `groups` (a lane's, when --lane is given), so --lane and --shard then split the subset. An empty
 * subset is refused: a run of nothing must never read as green.
 */
export function parseFilesFrom(argv, groups, read = (file) => readFileSync(file, "utf8"), all = groups) {
  const flag = argv.find((arg) => arg.startsWith("--files-from="));
  if (!flag) return null;
  const file = flag.slice("--files-from=".length);
  const parsed = JSON.parse(read(file));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("--files-from must contain a JSON array of test paths");
  }
  if (!parsed.length) throw new Error("--files-from names no test files; refusing an empty run");
  const normalized = parsed.map(posix);
  if (new Set(normalized).size !== normalized.length) throw new Error("--files-from contains a duplicate test");
  const discovered = new Set([...all.shared, ...all.browser, ...all.desktop].map(posix));
  for (const entry of normalized) if (!discovered.has(entry)) throw new Error(`Selected test was not discovered: ${entry}`);
  const wanted = new Set(normalized);
  return Object.fromEntries(Object.entries(groups).map(([name, files]) => [name, files.filter((one) => wanted.has(posix(one)))]));
}

/** Turn an otherwise silent worker death into a named, actionable CI failure. */
export function testProcessStatus(result, files, report = console.error) {
  if (typeof result.status === "number") return result.status;
  const reason = result.error
    ? `could not start: ${result.error.message}`
    : result.timedOut
      ? `ran past its ${result.timedOut} s limit and was ended, with everything it started`
      : result.signal
        ? `was terminated by ${result.signal}`
        : "ended without an exit status or signal";
  report(`[test-runner] The test worker ${reason}. Assigned files:\n${files.map(posix).join("\n")}`);
  return 1;
}

const live = new Set();

/**
 * End a file's process and everything it started. On macOS and Linux each file leads its own process group, so the
 * group is ended even after the file itself has exited. On Windows the tree is found through the running process
 * only, so it is ended only while that process still runs (a finished process's number may already be another's).
 */
function endTree(child, running) {
  if (process.platform !== "win32") try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
  else if (running) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
}


/** This process's environment without the marker `node --test` leaves for its own workers, so a file run from inside
 * a test still runs as a test file of its own. */
function ownEnv() {
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  return env;
}

/**
 * Run one file in its own `node --test` process and resolve with its status, output and seconds. The output is held
 * and printed whole, so files running side by side do not interleave. It resolves when the file's own process exits,
 * not when every program it started lets go of the output: whatever it left running is ended then.
 */
export function runFile(file, { limit = 0, spawnTest = spawn, now = Date.now } = {}) {
  const started = now();
  const child = spawnTest(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", file],
    { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", env: ownEnv() });
  const chunks = [];
  live.add(child);
  child.stdout?.on("data", (chunk) => chunks.push(chunk));
  child.stderr?.on("data", (chunk) => chunks.push(chunk));
  return new Promise((done) => {
    let timedOut = 0, finished = false;
    const timer = limit ? setTimeout(() => { timedOut = limit; endTree(child, true); }, limit * 1000) : null;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      live.delete(child);
      endTree(child, false);
      const status = timedOut ? null : result.status;
      done({ file, ...result, status, timedOut, output: Buffer.concat(chunks).toString("utf8"), seconds: (now() - started) / 1000 });
    };
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    // Give the output a moment to drain after the exit, but never wait on a pipe a left-behind program still holds.
    child.on("exit", (status, signal) => setTimeout(() => finish({ status, signal }), 2000));
    child.on("close", (status, signal) => finish({ status, signal }));
  });
}

/**
 * Run files side by side: up to `limits[kind]` of each kind at once, the longest first. `kindOf` names a file's kind
 * (shared, browser or desktop). Resolves with every file's result in the order they finished.
 */
export async function runPool(files, { kindOf, limits, cost = () => 0, runOne = runFile, onDone = () => {} }) {
  const waiting = [...files].sort((a, b) => cost(b) - cost(a));
  const running = new Map(Object.keys(limits).map((kind) => [kind, 0]));
  const results = [];
  await new Promise((allDone) => {
    const next = () => {
      if (!waiting.length && [...running.values()].every((count) => count === 0)) return allDone();
      for (let index = 0; index < waiting.length; index++) {
        const kind = kindOf(waiting[index]);
        if (running.get(kind) >= limits[kind]) continue;
        const [file] = waiting.splice(index--, 1);
        running.set(kind, running.get(kind) + 1);
        runOne(file).then((result) => {
          running.set(kind, running.get(kind) - 1);
          results.push(result);
          onDone(result);
          next();
        });
      }
    };
    next();
  });
  return results;
}

export const RETRY_AT_MOST = 2;

/**
 * Run each failed file once more, one at a time, and resolve with the files that still fail and the ones that passed
 * on the second run (flaky). No retry when more than RETRY_AT_MOST failed (that is a real break) or a file ran past its
 * limit (a second run would not fit the job's time).
 */
export async function retryFailed(failed, { runOne = runFile, onDone = () => {}, passed = (result) => result.status === 0 } = {}) {
  if (!failed.length || failed.length > RETRY_AT_MOST || failed.some((result) => result.timedOut))
    return { stillFailed: failed, flaky: [] };
  const stillFailed = [], flaky = [];
  for (const first of failed) {
    const second = await runOne(first.file);
    onDone(second);
    if (passed(second)) flaky.push(second);
    else stillFailed.push(first);
  }
  return { stillFailed, flaky };
}

/** Print one finished file's output under a header, and name it again if it failed. */
function report(result) {
  const status = testProcessStatus(result, [result.file], () => {});
  console.log(`\n── ${posix(result.file)} · ${result.seconds.toFixed(1)} s · ${status === 0 ? "passed" : "FAILED"}`);
  process.stdout.write(result.output);
  if (status !== 0) testProcessStatus(result, [result.file]);
}

/** Say a file passed only on its second run: a warning in the log and a line in the job's summary, so it gets fixed. */
function nameFlaky(file) {
  const words = `${posix(file)} failed, then passed when run again alone (flaky).`;
  console.log(`::warning file=${posix(file)}::${words}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${words}\n`, { flag: "a" });
}

function chooseFiles(argv) {
  const all = testGroups();
  const { lane, groups: laned } = laneGroups(argv, all);
  const explicit = parseFilesFrom(argv, laned, undefined, all);
  const groups = onlyGroups(explicit ?? laned, process.env.BRANCH_TEST_GROUPS);
  const { index, total } = parseShard(argv);
  const weights = loadWeights(lane ? LANES[lane] : process.platform);
  const chosen = Object.fromEntries(Object.entries(groups).map(([name]) => [name, []]));
  const mine = new Set(shareFiles(groups, index, total, weights));
  for (const [name, list] of Object.entries(groups)) chosen[name] = list.filter((file) => mine.has(file));
  const count = chosen.shared.length + chosen.browser.length + chosen.desktop.length;
  const everything = all.shared.length + all.browser.length + all.desktop.length;
  console.log(`${explicit ? "Selected subset, " : ""}${lane ? `lane ${lane}, ` : ""}share ${index + 1} of ${total}: ${count} of ${everything} test files.`);
  if (explicit && !count) throw new Error("This share of the selected subset has no test files; refusing an empty run");
  return { chosen, weights };
}

async function main() {
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    for (const child of live) endTree(child, true);
    process.exit(130);
  });
  const argv = process.argv.slice(2);
  const { chosen, weights } = chooseFiles(argv);
  const files = [...chosen.shared, ...chosen.browser, ...chosen.desktop];
  if (argv.includes("--list")) return void console.log(files.map(posix).join("\n"));
  const kind = new Map(Object.entries(chosen).flatMap(([name, list]) => list.map((file) => [file, name])));
  const [shared, browser] = (process.env.BRANCH_TEST_CONCURRENCY ?? "3,1").split(",").map(Number);
  const limit = Number(process.env.BRANCH_TEST_FILE_TIMEOUT) || 0;
  const results = await runPool(files, {
    kindOf: (file) => kind.get(file), limits: { shared: shared || 3, browser: browser || 1, desktop: 1 },
    cost: costOf(weights), runOne: (file) => runFile(file, { limit }), onDone: report,
  });
  let failed = results.filter((result) => testProcessStatus(result, [result.file], () => {}) !== 0);
  if (argv.includes("--retry-failed") && failed.length) {
    console.log(`\nRunning ${failed.length} failed file(s) once more, alone.`);
    const retried = await retryFailed(failed, { runOne: (file) => runFile(file, { limit }), onDone: report,
      passed: (result) => testProcessStatus(result, [result.file], () => {}) === 0 });
    failed = retried.stillFailed;
    for (const result of retried.flaky) nameFlaky(result.file);
  }
  if (process.env.BRANCH_TEST_TIMINGS) {
    const timings = Object.fromEntries(results.map((r) => [posix(r.file), Math.round(r.seconds * 1000) / 1000]).sort());
    writeFileSync(process.env.BRANCH_TEST_TIMINGS, `${JSON.stringify(timings, null, 2)}\n`);
  }
  console.log(`\n${results.length - failed.length} of ${results.length} test files passed.`);
  if (failed.length) console.log(`Failed:\n${failed.map((r) => `  ${posix(r.file)}${r.timedOut ? " (ran past its limit)" : ""}`).join("\n")}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
