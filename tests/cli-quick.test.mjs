// `branch --help`, `branch <command> --help` and completion scripts are answered by the entry (src/cli.ts,
// src/cli-quick.ts) without loading the program or the engine, with the program's own words. Mutations that go red
// here: answering a command's help with another text, answering `report --help` (its usage lives with the
// diagnostics), answering anything but help and completion, not applying the Hermes and OpenClaw aliases, and an
// entry that loads the engine to print help.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { cliCommands, commandHelp, completionScript, usageText } from "../dist/cli-completion.js";
import { quickAnswer } from "../dist/cli-quick.js";
import { TERMINAL_ALIASES } from "../dist/terminal-parity.js";

const run = promisify(execFile);

test("help for every command, `branch help` and completion scripts are the program's own texts", () => {
  for (const { name } of cliCommands) {
    const expected = name === "report" ? null : commandHelp(name);
    for (const ask of ["--help", "-h", "help"]) assert.equal(quickAnswer([name, ask]), expected, `${name} ${ask}`);
    assert.equal(quickAnswer([name, "--json", "--help"]), expected, `${name}: the ask may come after other words`);
  }
  for (const ask of ["help", "--help", "-h"]) assert.equal(quickAnswer([ask]), usageText());
  for (const shell of ["bash", "zsh", "fish"]) assert.equal(quickAnswer(["completion", shell]), completionScript(shell));
});

test("a name brought from Hermes or OpenClaw asks for the help of the Branch command it means", () => {
  const [alias, meaning] = Object.entries(TERMINAL_ALIASES).find(([name, [target]]) =>
    !name.startsWith("-") && target !== "report" && cliCommands.some((command) => command.name === target));
  assert.equal(quickAnswer([alias, "--help"]), commandHelp(meaning[0]));
});

test("everything else is the program's to answer", () => {
  for (const argv of [[], ["start"], ["status"], ["run", "hello"], ["version"], ["no-such-command", "--help"], ["report", "--help"],
    ["completion"], ["completion", "tcsh"]])
    assert.equal(quickAnswer(argv), null, argv.join(" ") || "no arguments");
});

test("`branch <command> --help` prints its help without loading the engine", async () => {
  // Counts the built modules the process loads, and whether the engine (dist/index.js) is one of them.
  const hook = `import { registerHooks } from "node:module";
let count = 0, engine = false;
registerHooks({ load(url, context, next) {
  if (url.includes("/dist/")) { count += 1; if (url.endsWith("/dist/index.js")) engine = true; }
  return next(url, context);
} });
process.on("exit", () => process.stderr.write("LOADED " + count + " " + engine + "\\n"));`;
  const preload = `data:text/javascript,${encodeURIComponent(hook)}`;
  const quick = await run(process.execPath, ["--import", preload, "dist/cli.js", "status", "--help"]);
  assert.match(quick.stdout, /^branch status/);
  const [, count, engine] = /LOADED (\d+) (\w+)/.exec(quick.stderr);
  assert.equal(engine, "false", "the engine is not loaded to print help");
  assert.ok(Number(count) < 20, `${count} built modules loaded to print help`);
  const full = await run(process.execPath, ["--import", preload, "dist/cli.js", "no-such-command"]).catch((error) => error);
  assert.match(full.stderr, /I do not know the command "no-such-command"/, "anything else reaches the program");
  assert.match(full.stderr, /LOADED \d+ true/, "which loads the engine");
  // A shell with no completion script is refused by the program in plain words, not with a stack trace.
  const refused = await run(process.execPath, ["dist/cli.js", "completion", "tcsh"]).catch((error) => error);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Completion is available for: /);
  assert.doesNotMatch(refused.stderr, /\n\s+at /, "no stack trace");
});
