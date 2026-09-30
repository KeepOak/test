// What `branch` can answer without loading the whole program (src/cli.ts): help for a command, `branch help` and a
// completion script. The answers are the program's own: the same command list, help texts and aliases, checked in
// the same order src/cli-program.ts checks them.
import { asksForHelp, cliCommands, commandHelp, completionScript, usageText } from "./cli-completion.js";
import { terminalArgv } from "./terminal-parity.js";

/**
 * What `branch` prints for these arguments without loading the program, or null when the program must answer.
 * `report --help` also lists the report's own usage, which lives with the diagnostics, so the program answers it.
 */
export function quickAnswer(argv: readonly string[]): string | null {
  if (!argv.length) return null;
  // With arguments, how they are read does not depend on whether this is a terminal (see terminalArgv).
  const [command = "", ...rest] = terminalArgv([...argv], false);
  if (command === "report") return null;
  if (cliCommands.some((entry) => entry.name === command) && asksForHelp(rest)) return commandHelp(command) ?? null;
  // A shell it has no script for is the program's to refuse, in its plain words and with its exit code.
  if (command === "completion") {
    try { return completionScript(rest[0] ?? ""); } catch { return null; }
  }
  if (["help", "--help", "-h"].includes(command)) return usageText();
  return null;
}
