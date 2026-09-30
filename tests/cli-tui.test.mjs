import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import {
  completionScript, completionInstallHint, completionShells, completionWords, cliCommands, usageText,
} from "../dist/cli-completion.js";
import { exitCodeFor, parseRunArgs } from "../dist/cli-run.js";
import { resolveStyle, stripAnsi, wrap } from "../dist/terminal-style.js";
import { killProcessGroup, killWindowsTree } from "../dist/integrations/shell-process.js";
import { fixtureModel } from "./fixtures/fixture-model.mjs";

const run = promisify(execFile);
const clean = (text) => stripAnsi(text);

/** The programs each test started, ended before its folder is removed. */
const started = new WeakMap();
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-cli-tui-"));
  const children = [];
  started.set(t, children);
  // One hook, in this order: `after` hooks run first to last and stop at the first that throws, so
  // removing the folder first failed on Windows (the program still had it open) and the program was
  // then never ended.
  t.after(async () => {
    for (const child of children) await endBranch(child);
    await discardTemp(root);
  });
  return {
    root,
    // The tests' scripted model (tests/fixtures/fixture-model.mjs): without a model named, Branch has none and refuses every task.
    env: { ...process.env, ...(await fixtureModel()).env, BRANCH_WORKSPACE: join(root, "ws"), BRANCH_DATA_DIR: join(root, "data"), NO_COLOR: undefined },
  };
}
/**
 * Starts `branch <args>` and ends it, and anything it started, when the test ends — passed, failed or
 * timed out. Killing only the program itself once left a Windows build machine waiting 78 minutes: a
 * process it had started kept this file's pipes open, so the file never finished. On macOS and Linux
 * it gets a process group of its own to end; on Windows its tree is ended while it still runs.
 */
function startBranch(t, args, options) {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], { ...options, detached: process.platform !== "win32" });
  const children = started.get(t);
  if (children) children.push(child); else t.after(() => endBranch(child));
  return child;
}
const running = (child) => child.exitCode === null && child.signalCode === null;
async function endBranch(child) {
  if (process.platform === "win32") { if (running(child)) await killWindowsTree(child.pid); }
  else await killProcessGroup(child.pid);
  if (running(child)) child.kill("SIGKILL");
  // Let go of the pipes too: whatever might still hold their other ends, this file can then finish.
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
}
/** The exit code once the program has ended, however soon it did; a program that never ends fails. */
async function exitOf(child, within = 60_000) {
  if (!running(child)) return child.exitCode;
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the program never ended")), within); });
  try { return await Promise.race([new Promise((resolve) => child.once("exit", (code) => resolve(code))), deadline]); }
  finally { clearTimeout(timer); }
}
/** Runs `branch <args>` and reports stdout, stderr and the exit code rather than throwing. */
async function branch(env, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["dist/cli.js", ...args], { env, maxBuffer: 20e6, timeout: 180_000, killSignal: "SIGKILL" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
/** Reads `branch status --json`, and says what the command printed when it did not succeed. */
function statusJson(result) {
  assert.equal(result.code, 0, `status failed: ${result.stderr || "(nothing on stderr)"}`);
  return JSON.parse(result.stdout);
}
/** Drives the terminal view in a child process that believes it has a terminal. */
function chat(t, env, extra = {}) {
  const child = startBranch(t, ["chat"], {
    env: { ...env, FORCE_TTY: "1", COLUMNS: "70", LINES: "20", ...extra },
  });
  let raw = "";
  child.stdout.on("data", (chunk) => { raw += chunk.toString(); });
  child.stderr.on("data", (chunk) => { raw += chunk.toString(); });
  const view = {
    child,
    raw: () => raw,
    text: () => clean(raw),
    type: (text) => child.stdin.write(text),
    /* Waits for the words themselves. The deadline is only there so a hang ends with the screen
       printed; a loaded build machine can take far longer than a laptop to draw the same thing. */
    async until(pattern) {
      for (const end = Date.now() + 60_000; Date.now() < end;) {
        if (pattern.test(view.text())) return;
        await delay(25);
      }
      assert.fail(`Timed out waiting for ${pattern} in:\n${view.text()}`);
    },
    exit: () => exitOf(child),
  };
  return view;
}

test("the terminal view answers slash commands, streams a task and leaves on Ctrl+D", async (t) => {
  const { env } = await workspace(t);
  const view = chat(t, env);
  await view.until(/Branch Agent/);
  view.type("/help\r");
  await view.until(/Alt\+Enter adds a line/);
  // Help wraps each description to the box rather than cutting it, so the list runs past one screen: page down to it.
  view.type("\x1b[6~\x1b[6~");
  await view.until(/\/dry-run/);
  view.type("/preset\r");
  await view.until(/ask-before-changes — Ask before changes/);
  view.type("write the demo file\r");
  await view.until(/Writing branch-demo\.txt/);
  await view.until(/Demo fixture completed/);
  // The answer streams in as it is written; the task is over once its totals are printed.
  await view.until(/\[this answer:/);
  assert.match(view.text(), /ok Writing branch-demo\.txt/, "each step is one compact row");
  view.type("/history\r");
  await view.until(/you: write the demo file/);
  view.type("/export\r");
  // The path is wrapped to the window, so look for its two ends rather than one unbroken line.
  await view.until(/\[saved to[\s\S]*\.md\]/);
  // Ctrl+C with nothing working stops the task, not the program: the view is still there after it.
  view.type("");
  await view.until(/nothing is working right now/);
  view.type("/skills\r");
  await view.until(/No skills installed/);
  view.type("");
  assert.equal(await view.exit(), 0);
  assert.match(view.text(), /Goodbye/);
  assert.match(view.raw(), /\x1b\]0;/, "the window title is set on a terminal that takes it");
});

test("the terminal view asks for a yes with the exact path, and a y carries the task on", async (t) => {
  const { env } = await workspace(t);
  const view = chat(t, env);
  await view.until(/Branch Agent/);
  view.type("/preset ask-before-changes\r");
  await view.until(/When to check with me: Ask before changes/);
  view.type("write the demo file\r");
  await view.until(/Branch needs your yes/);
  /* The question is drawn a line at a time, so wait for its last line rather than reading the
     screen the moment the first one appears. */
  await view.until(/Exactly: branch-demo\.txt/);
  assert.match(view.text(), /Tool: files\.write/);
  view.type("q\r");
  await view.until(/Please answer y, n, a or s/);
  view.type("y\r");
  await view.until(/noted: go ahead for files\.write/);
  await view.until(/Demo fixture completed/);
  view.type("");
  await view.exit();
});

test("a no in the terminal view refuses the tool and the task says so", async (t) => {
  const { env } = await workspace(t);
  const view = chat(t, env);
  await view.until(/Branch Agent/);
  view.type("/preset ask-before-changes\r");
  await view.until(/When to check with me/);
  view.type("write the demo file\r");
  await view.until(/Branch needs your yes/);
  view.type("n\r");
  await view.until(/noted: do not do that for files\.write/);
  await view.until(/could not verify|task |Branch Agent:/);
  view.type("");
  await view.exit();
});

test("Alt+Enter adds a line and the up arrow brings the last message back", async (t) => {
  const { env } = await workspace(t);
  const view = chat(t, env);
  await view.until(/Branch Agent/);
  view.type("/preset read-only\r");
  await view.until(/When to check with me: Read only/);
  view.type("first line\rsecond line\r");
  await view.until(/Branch Agent:|task /);
  view.type("[A");
  await delay(200);
  assert.match(view.text(), /first line/, "the recalled message is drawn again");
  view.type("");
  await view.exit();
});

test("NO_COLOR keeps every escape sequence out of the terminal view", async (t) => {
  const { env } = await workspace(t);
  const view = chat(t, { ...env, NO_COLOR: "1" });
  await view.until(/Branch Agent/);
  view.type("/help\r");
  await view.until(/Ctrl\+D leaves/);
  view.type("");
  await view.exit();
  assert.ok(!view.raw().includes(""), `NO_COLOR output still had an escape: ${JSON.stringify(view.raw().slice(0, 300))}`);
});

test("branch chat falls back to the plain view when there is no terminal", async (t) => {
  const { env } = await workspace(t);
  const child = startBranch(t, ["chat"], { env: { ...env, FORCE_TTY: "0" } });
  let raw = "";
  child.stdout.on("data", (chunk) => { raw += chunk.toString(); });
  // As long as the terminal view is given to draw itself: a loaded build machine can take far longer
  // than 10 seconds just to start the program.
  for (const end = Date.now() + 60_000; Date.now() < end && !/terminal conversation/.test(raw);) await delay(25);
  assert.match(raw, /Branch Agent terminal conversation/, "the plain streaming view took over");
  child.stdin.end("/exit\n");
  await exitOf(child);
  assert.ok(!raw.includes(""), "the plain view draws nothing");
});

test("run --json writes one event per line and exits with the code that says what happened", async (t) => {
  const { env } = await workspace(t);
  const ok = await branch(env, ["run", "say hello", "--json"]);
  assert.equal(ok.code, 0);
  const lines = ok.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "run.started");
  assert.ok(lines.some((line) => line.type === "event" && line.kind === "tool.started"));
  const last = lines.at(-1);
  assert.equal(last.type, "run");
  assert.equal(last.run.status, "completed");
  assert.equal(last.exitCode, 0);
  assert.ok(last.usage.estimatedInput > 0);
  assert.match(ok.stderr, /Demo fixture completed/, "the words for a person go to stderr, not into the stream");
  assert.doesNotMatch(ok.stdout, /^(?!\{).+$/m, "every stdout line is one JSON object");
});

test("run reports the exit codes scripts rely on: 2 needs you, 3 failed, 4 out of budget", async (t) => {
  const { env } = await workspace(t);
  const asked = await branch(env, ["run", "write something", "--preset", "ask-before-changes", "--json"]);
  assert.equal(asked.code, 2);
  assert.match(asked.stdout, /"kind":"policy\.ask"/);
  const budget = await branch(env, ["run", "write something", "--preset", "off", "--budget", "10", "--json"]);
  assert.equal(budget.code, 4);
  const timedOut = await branch(env, ["run", "write something", "--preset", "off", "--timeout", "1", "--json"]);
  assert.equal(timedOut.code, 3);
  const dry = await branch(env, ["run", "write something", "--dry-run", "--preset", "off", "--json"]);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /"kind":"tool\.simulated"/);
});

test("--preset holds for one task only; --save-preset is the one that keeps the change", async (t) => {
  const { env } = await workspace(t);
  const once = await branch(env, ["run", "write something", "--preset", "ask-before-changes", "--json"]);
  assert.equal(once.code, 2, "the task did stop to ask, so the preset was in force while it ran");
  assert.match(once.stderr, /for this task only/);
  const after = statusJson(await branch(env, ["status", "--json"]));
  assert.equal(after.approvalPreset, "off", "the owner's saved setting was put back");
  const kept = await branch(env, ["run", "write something", "--save-preset", "ask-before-changes", "--json"]);
  assert.equal(kept.code, 2);
  const later = statusJson(await branch(env, ["status", "--json"]));
  assert.equal(later.approvalPreset, "ask-before-changes", "--save-preset left the change in place");
});

test("--attach sends a text file with the request", async (t) => {
  const { env, root } = await workspace(t);
  const note = join(root, "note.txt");
  await writeFile(note, "REMEMBER THE MILK");
  const attached = await branch(env, ["run", "read my note", "--attach", note, "--json"]);
  assert.equal(attached.code, 0);
  assert.match(attached.stdout, /REMEMBER THE MILK/, "the file's words went into the message");
});

test("status, logs and approve give scripts the same picture the app shows", async (t) => {
  const { env } = await workspace(t);
  const asked = await branch(env, ["run", "write something", "--save-preset", "ask-before-changes", "--json"]);
  assert.equal(asked.code, 2);
  assert.match(asked.stderr, /saved setting .+ now "ask-before-changes"/, "--save-preset says the saved setting changed");
  const runId = JSON.parse(asked.stdout.trim().split("\n").at(-1)).run.id;
  const status = await branch(env, ["status", "--json"]);
  assert.equal(status.code, 0);
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.approvalPreset, "ask-before-changes");
  assert.equal(snapshot.waitingForYou[0].id, runId);
  assert.ok(snapshot.health.items.length > 0);
  const logs = await branch(env, ["logs", runId]);
  assert.equal(logs.code, 0);
  assert.match(logs.stdout, /tool.started files.write/);
  assert.match(logs.stdout, /\[finished: needs_input\]/);
  const approved = await branch(env, ["approve", runId, "yes", "--json"]);
  assert.equal(approved.code, 0);
  assert.deepEqual(JSON.parse(approved.stdout).tool, "files.write");
  const spoken = await branch(env, ["approve", runId, "yes"]);
  assert.match(spoken.stdout, /standing rule/, "the person is told plainly that a rule was saved");
  assert.match(spoken.stdout, /every future task/);
  const second = await branch(env, ["run", "write something", "--json"]);
  assert.equal(second.code, 0, "the remembered yes lets the same task through");
  const refused = await branch(env, ["approve", "not-a-task", "yes"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /No task with that id/);
});

test("completion writes a script for bash, zsh, fish and PowerShell and refuses anything else", async (t) => {
  const { env } = await workspace(t);
  const bash = await branch(env, ["completion", "bash"]);
  assert.equal(bash.code, 0);
  assert.match(bash.stdout, /complete -F _branch_complete branch/);
  assert.match(bash.stdout, /run\) options=".*--json.*"/);
  const powershell = await branch(env, ["completion", "powershell"]);
  assert.equal(powershell.code, 0);
  assert.match(powershell.stdout, /Register-ArgumentCompleter -Native -CommandName branch/);
  assert.match(powershell.stdout, /'run' = @\('--json'/);
  const zsh = await branch(env, ["completion", "zsh"]);
  assert.equal(zsh.code, 0);
  assert.match(zsh.stdout, /^#compdef branch/);
  assert.match(zsh.stdout, /compdef _branch branch/);
  const fish = await branch(env, ["completion", "fish"]);
  assert.equal(fish.code, 0);
  assert.match(fish.stdout, /complete -c branch -n "__fish_seen_subcommand_from run" -l json/);
  const wrong = await branch(env, ["completion", "tcsh"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Completion is available for: bash, zsh, fish, powershell/);
  for (const shell of completionShells) {
    const script = completionScript(shell);
    for (const command of cliCommands) assert.match(script, new RegExp(`\\b${command.name}\\b`), `${shell} offers ${command.name}`);
    for (const option of new Set(cliCommands.flatMap((command) => command.options)))
      assert.ok(script.includes(shell === "fish" ? `-l ${option.slice(2)}` : option), `${shell} offers ${option}`);
    assert.match(script, /To load it in every new terminal: /, `${shell} says how to install it`);
    assert.match(completionInstallHint(shell), new RegExp(`branch completion ${shell}`));
  }
  assert.ok(usageText().includes("Exit codes for scripts"));
  assert.throws(() => completionScript("tcsh"), /bash, zsh, fish, powershell/);
});

const hasShell = (name) => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;

test("the bash script suggests commands and only that command's options", { skip: !hasShell("bash") }, () => {
  const probe = `${completionScript("bash")}
COMP_WORDS=(branch ru); COMP_CWORD=1; _branch_complete; echo "one:\${COMPREPLY[*]}"
COMP_WORDS=(branch run --ve); COMP_CWORD=2; _branch_complete; echo "two:\${COMPREPLY[*]}"
COMP_WORDS=(branch completion f); COMP_CWORD=2; _branch_complete; echo "three:\${COMPREPLY[*]}"`;
  const out = spawnSync("bash", ["--norc", "--noprofile", "-c", probe], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^one:run$/m);
  assert.match(out.stdout, /^two:--verify$/m);
  assert.match(out.stdout, /^three:fish$/m);
});

test("the zsh script suggests commands and only that command's options", { skip: !hasShell("zsh") }, () => {
  // compadd and _files are zsh's own completion helpers; stand-ins print what would be offered.
  const probe = `compadd() { local a; if [[ $1 == -a ]]; then a=(\${(P)2}); else a=("$@"); fi; print -r -- "offer:\${a[*]}"; }
_files() { print -r -- "offer:files"; }
compdef() { print -r -- "registered:$*"; }
${completionScript("zsh")}
words=(branch ""); CURRENT=2; PREFIX=""; _branch
words=(branch run --); CURRENT=3; PREFIX="--"; _branch
words=(branch completion ""); CURRENT=3; PREFIX=""; _branch`;
  const out = spawnSync("zsh", ["-f", "-c", probe], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^registered:_branch branch$/m);
  assert.match(out.stdout, new RegExp(`^offer:${completionWords().join(" ")}$`, "m"));
  assert.match(out.stdout, /^offer:--json --attach --plan .*--fork$/m);
  assert.match(out.stdout, /^offer:bash zsh fish powershell$/m);
});

test("the fish script loads in fish", { skip: !hasShell("fish") }, () => {
  const out = spawnSync("fish", ["--no-config", "-c", `${completionScript("fish")}\ncomplete -C "branch ru"`], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^run\t/m);
});

test("the flag reader, the exit code table and the wrapper behave on their own", () => {
  const flags = parseRunArgs(["tidy", "the", "notes", "--json", "--plan", "--verify", "--dry-run", "--budget", "500", "--timeout", "900", "--preset", "workspace", "--attach", "a.txt"]);
  assert.equal(flags.prompt, "tidy the notes");
  assert.deepEqual([flags.json, flags.plan, flags.verify, flags.dryRun], [true, true, true, true]);
  assert.deepEqual([flags.budget, flags.timeoutMs, flags.preset, flags.attach], [500, 900, "workspace", ["a.txt"]]);
  assert.throws(() => parseRunArgs(["x", "--budget", "nope"]), /whole number/);
  assert.throws(() => parseRunArgs(["x", "--attach"]), /needs a file/);
  assert.throws(() => parseRunArgs(["x", "--preset"]), /needs a name/);
  assert.throws(() => parseRunArgs(["x", "--save-preset"]), /needs a name/);
  assert.equal(parseRunArgs(["x"]).preset, undefined, "no --preset leaves the saved setting alone");
  assert.equal(flags.savePreset, false, "--preset on its own does not save the setting");
  assert.deepEqual(
    (({ preset, savePreset }) => ({ preset, savePreset }))(parseRunArgs(["x", "--save-preset", "workspace"])),
    { preset: "workspace", savePreset: true },
  );
  assert.deepEqual(
    ["completed", "needs_input", "budget_exceeded", "failed", "cancelled"].map(exitCodeFor),
    [0, 2, 4, 3, 3],
  );
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrap("supercalifragilistic", 8), ["supercal", "ifragili", "stic"]);
  const plain = resolveStyle({ NO_COLOR: "1" });
  assert.deepEqual([plain.color, plain.cursor, plain.decorations], [false, false, false]);
  const rich = resolveStyle({ COLUMNS: "120" });
  assert.deepEqual([rich.color, rich.cursor, rich.columns], [true, true, 120]);
  assert.equal(stripAnsi("[2mdim[0m]0;titletext"), "dimtext");
});
