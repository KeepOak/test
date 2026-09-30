// One command for a pull request's review: the four window checks, the build, the four redesign gates and the Inbox
// refresh test, plus any test files named on the command line (each file the PR adds or changes).
//
//   node scripts/review.mjs [--jobs N] [tests/<file>.test.mjs ...]
//
// The checks run alongside the build (they read public/ and src/, never dist/). The test files run once the build is
// clean, each as its own `node --test --test-concurrency=1 <file>` process, N at a time (default 5): every one of them
// starts its engines on port 0 in its own temporary folder. The checks never run alongside the test files, because
// tests/window-files.test.mjs adds probe files to public/app while it runs.
// Never runs `npm test`, never the clean-uninstall, uninstall-last-step or console-calibration tests, never `node --test`
// with no file, never a test that drives the real screen (marked "// real-screen-test"), and refuses a test file that
// names the installed app's or the preview's ports.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const CHECKS = ["check-imports", "check-routes", "check-live", "check-fakes"];
const GATES = ["tests/redesign-gate-ui.test.mjs", "tests/redesign-approvals-exact-ui.test.mjs", "tests/static-assets.test.mjs",
  "tests/window-files.test.mjs", "tests/inbox-live-refresh.test.mjs"];
const BANNED = /clean-uninstall|uninstall-last-step|console-calibration/i;
const OWNER_PORTS = /\b(3210|3299|3300)\b/;
// A test that drives this computer's real screen, keyboard or windows starts with this line (tests/real-screen.mjs).
const REAL_SCREEN = "// real-screen-test";

let logs = "";
const children = new Set();

function fail(message) {
  console.error(`review: ${message}`);
  process.exit(2);
}

/** The command line: `--jobs N` and test files, each an existing file under tests/ that is safe to run here. */
function parseArgs(argv) {
  let jobs = 5;
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--jobs") { jobs = Number(argv[++i]); continue; }
    if (arg.startsWith("-")) fail(`unknown option ${arg}`);
    if (/[*?[\]{}]/.test(arg)) fail(`${arg}: name each test file exactly, no patterns`);
    const file = relative(process.cwd(), resolve(arg)).replaceAll("\\", "/");
    if (!file.startsWith("tests/") || !existsSync(file) || !statSync(file).isFile()) fail(`${arg} is not a file under tests/`);
    if (BANNED.test(file)) fail(`${file} is never run on this machine`);
    const source = readFileSync(file, "utf8");
    if (source.split(/\r?\n/).some((text) => text.trim() === REAL_SCREEN)) fail(`${file} drives this computer's real screen; it is never run from here`);
    const line = source.split("\n").findIndex((text) => OWNER_PORTS.test(text));
    if (line >= 0) fail(`${file}:${line + 1} names port 3210, 3299 or 3300; run it by hand if it is safe`);
    if (!GATES.includes(file) && !extra.includes(file)) extra.push(file);
  }
  if (!Number.isInteger(jobs) || jobs < 1) fail("--jobs needs a whole number of at least 1");
  return { jobs, files: [...GATES, ...extra] };
}

/** Runs one step with its output in its own log; resolves with how it went. */
function run(name, command, args, options = {}) {
  const started = Date.now();
  const log = join(logs, `${name.replace(/[^\w.-]+/g, "_")}.log`);
  const out = createWriteStream(log);
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    children.add(child);
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", (error) => out.write(`\n${error.stack}\n`));
    child.on("close", (code) => {
      children.delete(child);
      out.end(() => done({ name, ok: code === 0, seconds: (Date.now() - started) / 1000, log }));
    });
  });
}

/** Runs the test files, `jobs` at a time, one file per `node --test` process. */
async function runTests(files, jobs) {
  const queue = [...files];
  const results = [];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift())
      results.push(await run(file, process.execPath, ["--test", "--test-concurrency=1", file]));
  };
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  return files.map((file) => results.find((result) => result.name === file));
}

/** "6/6" from a node --test log's own summary lines. */
function counts(log) {
  const text = readFileSync(log, "utf8");
  const read = (label) => Number(new RegExp(`^\\S*\\s*${label} (\\d+)\\r?$`, "m").exec(text)?.[1] ?? NaN);
  const [tests, pass] = [read("tests"), read("pass")];
  return Number.isNaN(tests) ? "" : `${pass}/${tests} passed`;
}

function report(results, started) {
  console.log("");
  for (const r of results) {
    const detail = r.name.startsWith("tests/") && r.log ? counts(r.log) : "";
    console.log(`${r.ok ? "PASS" : r.skipped ? "SKIP" : "FAIL"}  ${r.name.padEnd(46)} ${r.skipped ? "" : `${r.seconds.toFixed(1)}s`.padStart(7)}  ${detail}`);
  }
  for (const r of results.filter((one) => !one.ok && !one.skipped)) {
    const tail = readFileSync(r.log, "utf8").trimEnd().split("\n").slice(-40).join("\n");
    console.log(`\n--- ${r.name} (last lines of ${r.log})\n${tail}`);
  }
  const failed = results.filter((one) => !one.ok && !one.skipped).length;
  const skipped = results.filter((one) => one.skipped).length;
  const verdict = failed ? `${failed} failed${skipped ? `, ${skipped} not run` : ""}` : "all steps passed";
  console.log(`\n${verdict} in ${((Date.now() - started) / 1000).toFixed(1)}s (logs: ${logs})`);
  return failed + skipped;
}

function stopChildren() {
  for (const child of children) {
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
}
process.on("SIGINT", () => { stopChildren(); process.exit(130); });

async function main() {
  const { jobs, files } = parseArgs(process.argv.slice(2));
  logs = mkdtempSync(join(tmpdir(), "branch-review-"));
  const started = Date.now();
  console.log(`review: checks and build, then ${files.length} test files ${jobs} at a time`);
  const first = await Promise.all([
    ...CHECKS.map((check) => run(check, process.execPath, [`design/redesign/tools/${check}.mjs`])),
    run("npm run build", "npm run build", [], { shell: true }),
  ]);
  const built = first.at(-1).ok;
  const tests = built ? await runTests(files, jobs) : files.map((name) => ({ name, ok: false, skipped: true }));
  process.exitCode = report([...first, ...tests], started) ? 1 : 0;
}

main().catch((error) => { stopChildren(); console.error(error); process.exit(1); });
