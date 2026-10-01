import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { alone, laneGroups, lanes, loadWeights, onlyGroups, onlyOn, parseFilesFrom, parseShard, RETRY_AT_MOST, retryFailed, runFile, runPool,
  shareFiles, shards, testGroups, testProcessStatus } from "../scripts/run-tests.mjs";
import { mergeWeights, readTimings } from "../scripts/test-weights.mjs";
import { FULL_MATRIX, planMatrix } from "../scripts/select-affected-tests.mjs";

test("npm test isolates browser and desktop files while keeping ordinary tests together", () => {
  const listing = {
    tests: ["desktop.test.mjs", "desktop-export.test.mjs", "memory-ui.test.mjs", "places.mjs", "mac2-desktop-ui.test.mjs"],
    [join("packages", "sdk", "test")]: ["client.test.mjs"],
  };
  const groups = testGroups((folder) => listing[folder], (file) =>
    /(?:mac2-desktop-ui|memory-ui)/.test(file) ? 'import { chromium } from "playwright";' : "");
  assert.deepEqual(groups.desktop, [join("tests", "desktop-export.test.mjs"), join("tests", "desktop.test.mjs")]);
  assert.deepEqual(groups.browser, [join("tests", "mac2-desktop-ui.test.mjs"), join("tests", "memory-ui.test.mjs")]);
  assert.deepEqual(groups.shared, [join("packages", "sdk", "test", "client.test.mjs")]);
  // The real folders: the desktop app's files, and none of them among the rest.
  const real = testGroups();
  assert.deepEqual(real.desktop.map((file) => file.replace(/\\/g, "/")),
    ["tests/desktop-beta-smoke.test.mjs", "tests/desktop-close.test.mjs", "tests/desktop-detached-gateway.test.mjs",
     "tests/desktop-engine-power.test.mjs", "tests/desktop-export.test.mjs",
     "tests/desktop-gateway-control.test.mjs", "tests/desktop-gateway-hot.test.mjs",
     "tests/desktop-gateway-launch.test.mjs", "tests/desktop-gateway-live.test.mjs",
     "tests/desktop-gateway-mode.test.mjs", "tests/desktop-gateway-power.test.mjs",
     "tests/desktop-gateway-presence.test.mjs", "tests/desktop-gateway-preview.test.mjs",
     "tests/desktop-gateway-runtime.test.mjs", "tests/desktop-gateway-worker.test.mjs",
     "tests/desktop-hot-update.test.mjs", "tests/desktop-identity.test.mjs", "tests/desktop-joined-engine.test.mjs",
     "tests/desktop-old-engine.test.mjs", "tests/desktop-responsive.test.mjs", "tests/desktop-settings.test.mjs",
     "tests/desktop-shell-lock-liveness.test.mjs", "tests/desktop-update-chaos.test.mjs",
     "tests/desktop-window.test.mjs", "tests/desktop.test.mjs"]);
  assert.equal(real.shared.some((file) => /^tests[\\/]desktop/.test(file)), false);
  assert.ok(real.browser.includes(join("tests", "glass-select.test.mjs")));
  assert.ok(real.browser.includes(join("tests", "settings-grown-1.test.mjs")));
  assert.equal(real.shared.some((file) => real.browser.includes(file)), false);
  assert.ok(real.shared.includes(join("tests", "run-tests.test.mjs")));
});

test("the shares the build machines run cover every test file exactly once, for any number of shares", () => {
  const groups = testGroups(), { shared, browser, desktop } = groups;
  const all = [...shared, ...browser, ...desktop];
  for (const platform of ["win32", "darwin", "linux", "unmeasured"]) {
    for (const total of [1, 2, 3, 4, 5, 6, 8]) {
      const shares = Array.from({ length: total }, (_, index) => shareFiles(groups, index, total, loadWeights(platform)));
      assert.equal(shares.length, total);
      const seen = shares.flat();
      assert.equal(seen.length, all.length, `${platform} ${total}: a file ran twice or not at all`);
      assert.deepEqual([...seen].sort(), [...all].sort());
    }
  }
});

test("every share gets an even part of the one-at-a-time files, not whatever the three-at-a-time ones leave (Q38)", () => {
  const file = (name) => join("tests", `${name}.test.mjs`);
  // One long three-at-a-time file fills one share, so packed together both browser files land on the other.
  const groups = { shared: ["heavy", "s2", "s3", "s4"].map(file), browser: ["b1", "b2"].map(file), desktop: [] };
  const weight = { heavy: 300, s2: 100, s3: 100, s4: 100, b1: 100, b2: 100 };
  const weights = Object.fromEntries(Object.entries(weight).map(([name, seconds]) => [`tests/${name}.test.mjs`, seconds]));
  const browsersIn = (share) => share.filter((f) => groups.browser.includes(f)).length;
  assert.deepEqual([0, 1].map((index) => browsersIn(shareFiles(groups, index, 2, weights))), [1, 1]);
  // The control: packed together, one share draws both, and their minutes run end to end.
  assert.deepEqual(shards([...groups.shared, ...groups.browser], 2, weights).map(browsersIn).sort(), [0, 2]);
});

test("shares are packed by measured time, not by counting files", () => {
  const files = ["a", "b", "c", "d", "e"].map((name) => join("tests", `${name}.test.mjs`));
  const weights = { "tests/a.test.mjs": 400, "tests/b.test.mjs": 100, "tests/c.test.mjs": 100, "tests/d.test.mjs": 100, "tests/e.test.mjs": 100 };
  const shares = shards(files, 2, weights);
  assert.deepEqual(shares[0], [files[0]]);
  assert.deepEqual(shares[1], files.slice(1));
  // A file never measured counts as the median, and the order stays the same from run to run.
  assert.deepEqual(shards([...files, join("tests", "new.test.mjs")], 2, weights), shards([...files, join("tests", "new.test.mjs")], 2, weights));
});

test("--shard names one share of the whole, and anything else is refused", () => {
  assert.deepEqual(parseShard([]), { index: 0, total: 1 });
  assert.deepEqual(parseShard(["--shard=2/5"]), { index: 1, total: 5 });
  for (const bad of ["--shard=0/5", "--shard=6/5", "--shard=1/0", "--shard=x"]) assert.throws(() => parseShard([bad]));
});

test("--files-from selects an explicit discovered subset and rejects stale or duplicate entries", () => {
  const groups = { shared: [join("tests", "a.test.mjs")], browser: [join("tests", "b.test.mjs")], desktop: [] };
  const read = () => JSON.stringify(["tests/b.test.mjs"]);
  assert.deepEqual(parseFilesFrom(["--files-from=selected.json"], groups, read),
    { shared: [], browser: [join("tests", "b.test.mjs")], desktop: [] });
  assert.throws(() => parseFilesFrom(["--files-from=selected.json"], groups, () => "[]"), /empty run/);
  assert.throws(() => parseFilesFrom(["--files-from=selected.json"], groups,
    () => JSON.stringify(["tests/missing.test.mjs"])), /not discovered/);
  assert.throws(() => parseFilesFrom(["--files-from=selected.json"], groups,
    () => JSON.stringify(["tests/a.test.mjs", "tests/a.test.mjs"])), /duplicate/);
  assert.throws(() => parseFilesFrom(["--files-from=selected.json"], groups, () => "{}"), /JSON array/);
});

test("a renamed or new file still runs, and a weight for a file that is gone changes nothing", () => {
  // The weights are only ever a guide to packing. A file renamed since they were measured is simply
  // unmeasured, so it counts as the median and lands in a share like any other; the old name is
  // never looked up. So stale weights cannot drop a file, and nobody has to refresh them to stay green.
  const files = ["a", "renamed", "c"].map((name) => join("tests", `${name}.test.mjs`));
  const weights = { "tests/a.test.mjs": 300, "tests/old-name.test.mjs": 900, "tests/c.test.mjs": 10 };
  for (const total of [1, 2, 3, 4]) {
    const shares = shards(files, total, weights);
    assert.deepEqual(shares.flat().sort(), [...files].sort(), `${total}: every file once, the stale name nowhere`);
  }
});

test("a test worker killed without an exit code names its signal and assigned files", () => {
  const messages = [];
  assert.equal(testProcessStatus({ status: null, signal: "SIGKILL" }, [join("tests", "slow.test.mjs")],
    (message) => messages.push(message)), 1);
  assert.match(messages[0], /terminated by SIGKILL/);
  assert.match(messages[0], /tests\/slow\.test\.mjs/);
  assert.equal(testProcessStatus({ status: 7, signal: null }, [], () => assert.fail("ordinary exits are silent")), 7);
});

test("only the named test groups run, the rest left empty, and a misspelt group is refused", () => {
  const groups = { shared: ["tests/a.test.mjs"], browser: ["tests/b.test.mjs"], desktop: ["tests/desktop.test.mjs"] };
  assert.equal(onlyGroups(groups, undefined), groups);
  assert.deepEqual(onlyGroups(groups, "shared,desktop"), { shared: ["tests/a.test.mjs"], browser: [], desktop: ["tests/desktop.test.mjs"] });
  assert.throws(() => onlyGroups(groups, "shared,screens"), /Unknown test group "screens"/);
});

test("a test only one system can run is found however it is gated, and one that only skips there is not", () => {
  assert.equal(onlyOn('test("x", { skip: process.platform !== "win32" && "cmd.exe" }, () => {});', "win32"), true);
  assert.equal(onlyOn("if (process.platform != 'darwin') return;", "darwin"), true);
  assert.equal(onlyOn('const windows = process.platform === "win32";\ntest("x", { skip: !windows }, () => {});', "win32"), true);
  assert.equal(onlyOn('const onMac = process.platform === "darwin";\nif (! onMac) return;', "darwin"), true);
  // Skipped only ON that system: every other system, Linux included, runs it.
  assert.equal(onlyOn('test("x", { skip: process.platform === "win32" }, () => {});', "win32"), false);
  assert.equal(onlyOn('const windows = process.platform === "win32";\ntest("x", { skip: windows && "POSIX" }, () => {});', "win32"), false);
  assert.equal(onlyOn('const posixOnly = process.platform === "win32" && "shell scripts";\ntest("x", { skip: !posixOnly }, () => {});', "win32"), false);
  assert.equal(onlyOn('test("x", { skip: process.platform !== "darwin" }, () => {});', "win32"), false);
});

test("the three lanes run every file between them, and Linux runs everything but the desktop app's", () => {
  const groups = testGroups();
  const all = [...groups.shared, ...groups.browser, ...groups.desktop];
  const byLane = lanes(groups);
  const flat = (lane) => [...lane.shared, ...lane.browser, ...lane.desktop];
  const covered = new Set(Object.values(byLane).flatMap(flat));
  assert.deepEqual([...covered].sort(), [...all].sort(), "a file no lane runs");
  assert.deepEqual(flat(byLane.linux).sort(), all.filter((file) => !groups.desktop.includes(file)).sort());
  const windows = flat(byLane.windows).map((file) => file.replace(/\\/g, "/"));
  for (const file of ["tests/desktop.test.mjs", "tests/windows-hidden-helpers.test.mjs", "tests/uninstall-last-step.test.mjs",
    "tests/clean-uninstall.test.mjs", "tests/real-update.test.mjs", "tests/secrets-sandbox.test.mjs", "tests/updater.test.mjs"])
    assert.ok(windows.includes(file), `${file} runs on Windows`);
  const macos = flat(byLane.macos).map((file) => file.replace(/\\/g, "/"));
  for (const file of ["tests/os-sandbox.test.mjs", "tests/install-boring.test.mjs", "tests/packaging.test.mjs"])
    assert.ok(macos.includes(file), `${file} runs on macOS`);
  assert.ok(windows.length < all.length / 5 && macos.length < all.length / 5, "the other systems run their own tests, not the suite again");
  assert.throws(() => laneGroups(["--lane=freebsd"], groups), /expected --lane=linux, windows or macos/);
  // A selected subset is split by lane and share like the whole suite: the Linux lane of it, then one share of that.
  const picked = parseFilesFrom(["--files-from=x.json", "--lane=linux"], byLane.linux,
    () => JSON.stringify(["tests/desktop.test.mjs", "tests/leak-guard.test.mjs"]), groups);
  assert.deepEqual(flat(picked).map((file) => file.replace(/\\/g, "/")), ["tests/leak-guard.test.mjs"], "the desktop file is Windows'");
});

test("the whole suite runs every share of every lane, and each lane's shares cover it exactly once", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8"));
  // Without a plan (every push) the workflow's own rows run; they are the planner's whole suite.
  const expression = workflow.jobs.test.strategy.matrix;
  assert.match(expression, /needs\.plan\.result == 'success' && needs\.plan\.outputs\.matrix/);
  const rows = JSON.parse(/'(\{"include".*\})'/s.exec(expression)[1]).include;
  assert.deepEqual(rows, FULL_MATRIX);
  assert.deepEqual(planMatrix("full", {}), FULL_MATRIX);
  const byLane = lanes(testGroups());
  assert.deepEqual([...new Set(rows.map((row) => row.lane))].sort(), ["linux", "macos", "windows"]);
  for (const lane of ["linux", "windows", "macos"]) {
    const shares = rows.filter((row) => row.lane === lane);
    const total = shares[0].total;
    assert.ok(shares.every((row) => row.total === total), `${lane}: every share names the same total`);
    assert.deepEqual(shares.map((row) => row.shard).sort((a, b) => a - b), Array.from({ length: total }, (_, i) => i + 1));
    const platform = { linux: "linux", windows: "win32", macos: "darwin" }[lane];
    const seen = Array.from({ length: total }, (_, index) => shareFiles(byLane[lane], index, total, loadWeights(platform))).flat();
    const expected = [...byLane[lane].shared, ...byLane[lane].browser, ...byLane[lane].desktop];
    assert.equal(seen.length, expected.length, `${lane}: a file ran twice or not at all`);
    assert.deepEqual([...seen].sort(), [...expected].sort());
  }
});

test("files run side by side within each kind's limit, the longest first", async () => {
  const kinds = { a: "shared", b: "shared", c: "shared", d: "browser", e: "browser", f: "desktop", g: "desktop" };
  const cost = { a: 1, b: 9, c: 5, d: 2, e: 8, f: 1, g: 3 };
  const running = { shared: 0, browser: 0, desktop: 0 }, most = { shared: 0, browser: 0, desktop: 0 }, started = [];
  const runOne = async (file) => {
    started.push(file);
    running[kinds[file]]++;
    most[kinds[file]] = Math.max(most[kinds[file]], running[kinds[file]]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running[kinds[file]]--;
    return { file, status: 0 };
  };
  const results = await runPool(Object.keys(kinds), { kindOf: (file) => kinds[file], limits: { shared: 2, browser: 1, desktop: 1 },
    cost: (file) => cost[file], runOne });
  assert.deepEqual(results.map((result) => result.file).sort(), Object.keys(kinds));
  assert.deepEqual(most, { shared: 2, browser: 1, desktop: 1 });
  assert.deepEqual(started.slice(0, 4), ["b", "e", "c", "g"], "the longest of each kind starts first");
  assert.deepEqual(await runPool([], { kindOf: () => "shared", limits: { shared: 1 }, runOne: () => assert.fail("nothing to run") }), []);
});

test("a file timed against a budget runs with nothing beside it, and nothing starts while it runs (#1199)", async () => {
  const kinds = { a: "shared", b: "shared", c: "shared", timed: "browser", d: "browser", e: "desktop" };
  const cost = { a: 1, b: 9, c: 5, timed: 20, d: 2, e: 3 };
  let running = 0;
  const beside = [], log = [];
  const runOne = async (file) => {
    running++;
    log.push(`start ${file}`);
    if (file === "timed") beside.push(running - 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (file === "timed") beside.push(running - 1);
    log.push(`end ${file}`);
    running--;
    return { file, status: 0 };
  };
  const results = await runPool(Object.keys(kinds), { kindOf: (file) => kinds[file], limits: { shared: 2, browser: 1, desktop: 1 },
    cost: (file) => cost[file], solo: (file) => file === "timed", runOne });
  assert.deepEqual(results.map((result) => result.file).sort(), Object.keys(kinds).sort());
  assert.deepEqual(beside, [0, 0], "nothing ran beside it, at its start or its end");
  const at = log.indexOf("start timed");
  assert.equal(log[at + 1], "end timed", "nothing started while it ran");
  // The real suite: owner-browser-speed is the one file timed against a budget.
  assert.deepEqual(testGroups().browser.filter(alone).map((file) => file.replace(/\\/g, "/")), ["tests/owner-browser-speed.test.mjs"]);
});

test("a file that never exits is ended at its limit and named, and a passing file reports its seconds", async () => {
  const folder = mkdtempSync(join(tmpdir(), "branch-runner-"));
  const stuck = join(folder, "stuck.test.mjs"), fine = join(folder, "fine.test.mjs");
  writeFileSync(stuck, 'import test from "node:test";\ntest("waits forever", () => new Promise(() => setInterval(() => {}, 1000)));\n');
  writeFileSync(fine, 'import test from "node:test";\ntest("passes", () => {});\n');
  const ended = await runFile(stuck, { limit: 2 });
  assert.equal(ended.status, null);
  assert.equal(ended.timedOut, 2);
  assert.ok(ended.seconds >= 2 && ended.seconds < 20, `${ended.seconds}`);
  const messages = [];
  assert.equal(testProcessStatus(ended, [stuck], (message) => messages.push(message)), 1);
  assert.match(messages[0], /ran past its 2 s limit/);
  assert.match(messages[0], /stuck\.test\.mjs/);
  const passed = await runFile(fine, { limit: 60 });
  assert.equal(passed.status, 0, passed.output);
  assert.match(passed.output, /passes/);
  assert.equal(passed.timedOut, 0);
});

test("the weights are refreshed per system from a run's timings, and a file that is gone is dropped", () => {
  const folder = mkdtempSync(join(tmpdir(), "branch-weights-"));
  const part = (name, timings) => {
    mkdirSync(join(folder, name));
    writeFileSync(join(folder, name, "test-timings.json"), JSON.stringify(timings));
  };
  part("test-timings-linux-1", { "tests/a.test.mjs": 3 });
  part("test-timings-linux-2", { "tests/b.test.mjs": 4 });
  part("test-timings-windows-1", { "tests/a.test.mjs": 30 });
  part("download-Linux", {});
  const measured = readTimings(folder);
  assert.deepEqual(Object.keys(measured).sort(), ["linux", "windows"]);
  const old = { linux: { "tests/a.test.mjs": 1, "tests/gone.test.mjs": 9, "tests/c.test.mjs": 2 }, win32: {}, darwin: { "tests/c.test.mjs": 5 } };
  const merged = mergeWeights(old, measured, (file) => file !== "tests/gone.test.mjs");
  assert.deepEqual(merged, {
    linux: { "tests/a.test.mjs": 3, "tests/b.test.mjs": 4, "tests/c.test.mjs": 2 },
    win32: { "tests/a.test.mjs": 30 },
    darwin: { "tests/c.test.mjs": 5 },
  });
});

test("a merge-queue share runs a failed file once more alone: a pass there is named flaky, a second failure still fails", async () => {
  const runs = [];
  const second = { "tests/flaky.test.mjs": 0, "tests/broken.test.mjs": 1 };
  const runOne = async (file) => { runs.push(file); return { file, status: second[file], timedOut: 0 }; };
  const failed = [{ file: "tests/flaky.test.mjs", status: 1, timedOut: 0 }, { file: "tests/broken.test.mjs", status: 1, timedOut: 0 }];
  const { stillFailed, flaky } = await retryFailed(failed, { runOne });
  assert.deepEqual(runs, ["tests/flaky.test.mjs", "tests/broken.test.mjs"], "each failed file runs once more, one at a time");
  assert.deepEqual(flaky.map((r) => r.file), ["tests/flaky.test.mjs"]);
  assert.deepEqual(stillFailed.map((r) => r.file), ["tests/broken.test.mjs"], "a file that fails twice still fails the share");
});

test("no second run when more files failed than a flake explains, or one ran past its limit", async () => {
  const runOne = async () => assert.fail("nothing runs again");
  const many = Array.from({ length: RETRY_AT_MOST + 1 }, (_, n) => ({ file: `tests/f${n}.test.mjs`, status: 1, timedOut: 0 }));
  assert.equal((await retryFailed(many, { runOne })).stillFailed.length, many.length);
  const stuck = [{ file: "tests/stuck.test.mjs", status: null, timedOut: 360 }];
  assert.deepEqual((await retryFailed(stuck, { runOne })).stillFailed, stuck);
});

test("only merge-queue groups and pushes rerun failed files; a pull request's own run does not", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8"));
  const step = workflow.jobs.test.steps.find((one) => String(one.run ?? "").includes("scripts/run-tests.mjs"));
  assert.match(step.run, /github\.event_name != 'pull_request' && ' --retry-failed'/);
});
