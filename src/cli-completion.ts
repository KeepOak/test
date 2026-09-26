import { TERMINAL_CLI_COMMANDS } from "./terminal-parity.js";
/**
 * Shell completion scripts for the `branch` command. They are plain text generated here, so the
 * person can write one to a file and load it from their shell profile; nothing is installed for
 * them and no script here ever runs a Branch command to work out its suggestions.
 */
export const completionShells = ["bash", "zsh", "fish", "powershell"] as const;
export type CompletionShell = (typeof completionShells)[number];

/** mac7/tests-unattended: what `--allow-tests` does, in `branch run --help` and `branch headless --help`. */
const allowTestsHelp = "--allow-tests lets this one task run the project's tests without asking, as if you answered Once each time. "
  + "Nothing is saved, only the owner can use it, and Lockdown refuses it. Without it, a task with nobody to ask skips the tests and carries on.";

/** mac7/smoke-fixes (B5): what `--plan` does, and what it does not do, in `branch run --help`. */
const planHelp = "--plan works out a numbered plan before the task starts and then carries it out. "
  + "To be shown the plan and asked before anything changes, set the conversation to \"Show me the plan first\" "
  + "(the Plan chip in the window, or Settings). A task with nobody to ask then finishes with the plan as its answer "
  + "and changes nothing.";

/**
 * Every subcommand, with the options that belong to it. Also drives `branch help`. `notes` are extra
 * lines `branch <command> --help` prints under the options, for an option that needs a sentence.
 */
export const cliCommands: { name: string; summary: string; options: string[]; notes?: string[] }[] = [
  { name: "start", summary: "Run the local web app", options: [] },
  { name: "chat", summary: "Talk to the assistant in this terminal", options: ["--plain", "--attach", "--session", "--watch"] },
  { name: "run", summary: "Carry out one task and print the result", options: ["--json", "--attach", "--plan", "--verify", "--dry-run", "--allow-tests", "--preset", "--save-preset", "--confirm", "--budget", "--timeout", "--session", "--resume", "--fork"],
    notes: [planHelp, allowTestsHelp] },
  { name: "headless", summary: "Run a scripted job with no window at all, one request per line", options: ["--script", "--stop-early", "--json", "--budget", "--timeout", "--session", "--preset", "--allow-tests"],
    notes: [allowTestsHelp] },
  { name: "status", summary: "Tasks working now, questions waiting, and a health summary", options: ["--json"] },
  { name: "logs", summary: "Print what happened during one task", options: ["--json"] },
  { name: "approve", summary: "Answer a task that stopped to ask: approve <task id> yes|no", options: ["--json"] },
  { name: "completion", summary: "Print a completion script for bash, zsh, fish or PowerShell", options: [] },
  { name: "doctor", summary: "Check that everything works", options: ["--probe", "--fix"] },
  // mac7/diagnostics: nothing is sent; it shows, saves a zip, or prints a GitHub issue link.
  { name: "report", summary: "Report a problem: show what a report holds, save it as a zip, or print a GitHub issue link", options: ["log", "--save", "--without", "--issue", "--json"] },
  // mac7/nodes: lend this computer's camera, screen, notifications and more to Branch elsewhere (src/devices/node/cli.ts).
  { name: "node", summary: "Lend this computer to your Branch elsewhere: node pair | run | status | never | forget", options: ["--name"] },
  { name: "daemon", summary: "Keep Branch working with the window closed: daemon install | uninstall | status", options: [] },
  { name: "login", summary: "Sign in to a ChatGPT account", options: [] },
  { name: "logout", summary: "Sign out of the ChatGPT account", options: [] },
  { name: "trigger", summary: "Run a schedule now", options: [] },
  { name: "watch", summary: "Run a saved procedure whenever a folder changes: watch <folder> <procedure-id>", options: ["--settle", "--once"] },
  { name: "backup", summary: "Write a backup file", options: [] },
  { name: "export-agent", summary: "Write the assistant itself to one file you can hand on", options: ["--memory", "--redact"] },
  { name: "import-agent", summary: "Read an assistant file: it shows what is inside, then --sections says what to bring in", options: ["--sections"] },
  { name: "restore", summary: "Read a backup file back in", options: [] },
  { name: "eval", summary: "Run the built-in evaluation set, or eval tools to check every tool", options: ["--suite", "--preset", "--compare", "--gate", "--json"] },
  { name: "study", summary: "Run a written-down experiment: study list | run <id> | compare <a> <b> | replay <id>", options: ["--fresh", "--json"] },
  { name: "mcp-serve", summary: "Offer Branch's tools to another AI tool", options: [] },
  { name: "acp-serve", summary: "Let a code editor talk to Branch", options: [] },
  { name: "app-server", summary: "Let an editor drive Branch over the app-server protocol (switch it on first)", options: [] },
  { name: "skill", summary: "Pack a skill folder, or install a skill file: skill pack | skill install", options: ["--author", "--package-version", "--approve"] },
  { name: "plugin", summary: "See and switch plugins on or off: plugin list | enable | disable", options: [] },
  { name: "update", summary: "Update a copy installed from Git, or check an installed copy and install the newest release with --yes", options: ["--yes"] },
  // bucket 22: closing and removing an installed Branch from a script (src/install/manage-cli.ts).
  { name: "quit", summary: "Close the running Branch and wait until it has gone", options: [] },
  { name: "uninstall", summary: "Remove the installed Branch; conversations and files stay unless --delete-data", options: ["--delete-data"] },
  // mac7/safe-rollback
  { name: "rollback", summary: "Go back to the version before the last update, or say plainly why that would lose your work; --yes does it", options: ["--yes"] },
  // mac7/phone-qr: the "Get Branch on your phone" code in the terminal (src/phone-app/cli.ts).
  { name: "phone", summary: "Show a code to scan with your phone to install the Branch app", options: ["--address", "--minutes"] },
  // Batch 20 (wave 8): short-lived keys, schedules over the running engine, and one task's trace.
  { name: "token", summary: "Short-lived keys for a script: token create | list | revoke <id>", options: ["--scope", "--minutes", "--name", "--json"] },
  { name: "schedule", summary: "Schedules on the engine already running: schedule add | list | remove <id>", options: ["--prompt", "--at", "--every", "--kind", "--json"] },
  // r17-i: a script's words into a chat that already talks to Branch (src/reach/send-cli.ts).
  { name: "send", summary: "Send words, or what is piped in, to a chat: send <chat app> <chat> [words]", options: ["--json"] },
  { name: "trace", summary: "The trace number for one task, and whether it was sent anywhere", options: ["--json"] },
  // mac7/r17-g: the tamper-evident activity chain.
  { name: "activity", summary: "Check that the tamper-evident activity record is unbroken: activity verify", options: ["--tip"] },
  // mac3/security-check: the security self-check.
  { name: "security", summary: "Check this computer's Branch setup for security problems: security audit", options: ["--fix", "--json"] },
  // mac7/connect: getting a chat app, making its bot and saving its token (src/channel-setup/).
  { name: "connect", summary: "Set up a chat app: connect <app> installs the official app, opens the bot page and saves the token", options: [] },
  // Wave mac3 (terminal): every place by name and the everyday commands (src/terminal-parity.ts).
  ...TERMINAL_CLI_COMMANDS,
];

const commandNames = (): string => cliCommands.map((command) => command.name).join(" ");
const optionsFor = (name: string): string[] => cliCommands.find((c) => c.name === name)?.options ?? [];

/** One `case` arm per subcommand, so bash suggests only that command's options. */
function bashOptionCases(): string {
  return cliCommands
    .filter((command) => command.options.length > 0)
    .map((command) => `    ${command.name}) options="${optionsFor(command.name).join(" ")}" ;;`)
    .join("\n");
}

function bashScript(): string {
  return `# Branch Agent completion for bash. Load it with: source branch-completion.bash
# ${completionInstallHint("bash")}
_branch_complete() {
  local commands="${commandNames()}"
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local command="\${COMP_WORDS[1]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$commands" -- "\$current") )
    return
  fi
  if [ "\$command" = "completion" ] && [ "\$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( \$(compgen -W "${completionShells.join(" ")}" -- "\$current") )
    return
  fi
  if [ "\$command" = "approve" ] && [ "\$COMP_CWORD" -eq 3 ]; then
    COMPREPLY=( \$(compgen -W "yes no" -- "\$current") )
    return
  fi
  local options=""
  case "\$command" in
${bashOptionCases()}
  esac
  if [ "\${current:0:1}" = "-" ]; then
    COMPREPLY=( \$(compgen -W "\$options" -- "\$current") )
  else
    COMPREPLY=( \$(compgen -f -- "\$current") )
  fi
}
complete -F _branch_complete branch
`;
}

/** One hashtable entry per subcommand, so PowerShell suggests only that command's options. */
function powershellOptionMap(): string {
  return cliCommands
    .filter((command) => command.options.length > 0)
    .map((command) => `    '${command.name}' = @(${command.options.map((option) => `'${option}'`).join(", ")})`)
    .join("\n");
}

function powershellScript(): string {
  return `# Branch Agent completion for PowerShell. Load it with: . .\\branch-completion.ps1
# ${completionInstallHint("powershell")}
Register-ArgumentCompleter -Native -CommandName branch -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(${cliCommands.map((command) => `'${command.name}'`).join(", ")})
  $options = @{
${powershellOptionMap()}
  }
  $words = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($words.Count -le 1 -or ($words.Count -eq 2 -and $wordToComplete)) {
    return $commands | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
  $command = $words[1]
  if ($command -eq 'completion') {
    return @(${completionShells.map((shell) => `'${shell}'`).join(", ")}) | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
  if ($command -eq 'approve') {
    return @('yes', 'no') | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
  return $options[$command] | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
}

/** One `case` arm per subcommand for zsh, listing that command's options. */
function zshOptionCases(): string {
  return cliCommands
    .filter((command) => command.options.length > 0)
    .map((command) => `      ${command.name}) options=(${command.options.join(" ")}) ;;`)
    .join("\n");
}

function zshScript(): string {
  return `#compdef branch
# Branch Agent completion for zsh.
# ${completionInstallHint("zsh")}
_branch() {
  local -a commands options
  commands=(${commandNames()})
  if (( CURRENT == 2 )); then
    compadd -a commands
    return
  fi
  case "\$words[2]" in
    completion) (( CURRENT == 3 )) && compadd ${completionShells.join(" ")} && return ;;
    approve) (( CURRENT == 4 )) && compadd yes no && return ;;
  esac
  options=()
  case "\$words[2]" in
${zshOptionCases()}
  esac
  if [[ "\$PREFIX" == -* ]]; then
    compadd -a options
  else
    _files
  fi
}
if [[ "\$funcstack[1]" == "_branch" ]]; then
  _branch "\$@"
else
  compdef _branch branch
fi
`;
}

/** One `complete` line per option, shown only after the subcommand it belongs to. */
function fishOptionLines(): string {
  return cliCommands
    .flatMap((command) => command.options.map((option) =>
      `complete -c branch -n "__fish_seen_subcommand_from ${command.name}" -l ${option.replace(/^--/, "")}`))
    .join("\n");
}

function fishScript(): string {
  const commandLines = cliCommands
    .map((command) => `complete -c branch -n "__fish_use_subcommand" -a ${command.name} -d ${fishQuote(command.summary)}`)
    .join("\n");
  return `# Branch Agent completion for fish.
# ${completionInstallHint("fish")}
complete -c branch -f
${commandLines}
complete -c branch -n "__fish_seen_subcommand_from completion" -a "${completionShells.join(" ")}"
complete -c branch -n "__fish_seen_subcommand_from approve" -a "yes no"
${fishOptionLines()}
`;
}

/** A description for fish, in single quotes, with the two characters fish treats specially escaped. */
function fishQuote(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Where each shell's script goes so it loads by itself in every new terminal, in one line. */
export function completionInstallHint(shell: CompletionShell): string {
  switch (shell) {
    case "bash": return "To load it in every new terminal: branch completion bash > ~/.branch-completion.bash && echo 'source ~/.branch-completion.bash' >> ~/.bashrc";
    case "zsh": return "To load it in every new terminal: mkdir -p ~/.zfunc && branch completion zsh > ~/.zfunc/_branch, then add 'fpath=(~/.zfunc $fpath); autoload -Uz compinit; compinit' to ~/.zshrc";
    case "fish": return "To load it in every new terminal: branch completion fish > ~/.config/fish/completions/branch.fish";
    case "powershell": return "To load it in every new terminal: branch completion powershell >> $PROFILE";
  }
}

/** The completion script for one shell, or a clear error naming the shells that are supported. */
export function completionScript(shell: string): string {
  if (shell === "bash") return bashScript();
  if (shell === "zsh") return zshScript();
  if (shell === "fish") return fishScript();
  if (shell === "powershell" || shell === "pwsh") return powershellScript();
  throw new Error(`Completion is available for: ${completionShells.join(", ")}. Try: branch completion zsh`);
}

/**
 * Batch 20 (wave 8): the help for one subcommand. `branch <command> --help` answers this and stops,
 * so asking what a command does never runs it, never opens the database and never reaches a model.
 */
export function commandHelp(name: string): string | null {
  const command = cliCommands.find((entry) => entry.name === name);
  if (!command) return null;
  return [
    `branch ${command.name}${command.options.length ? " [options]" : ""}`,
    "",
    `  ${command.summary}`,
    ...(command.options.length ? ["", "Options:", ...command.options.map((option) => `  ${option}`)] : []),
    ...(command.notes?.length ? ["", ...command.notes] : []),
  ].join("\n");
}
/** Whether the words after a command are asking what it does rather than telling it to work. */
export const asksForHelp = (words: readonly string[]): boolean =>
  words.some((word) => word === "--help" || word === "-h" || word === "help");

/** The usage text for `branch` with no arguments it understands. */
export function usageText(): string {
  const width = Math.max(...cliCommands.map((command) => command.name.length));
  return ["Usage: branch <command> [options]", "", ...cliCommands.map(
    (command) => `  ${command.name.padEnd(width)}  ${command.summary}`,
  ), "", "Exit codes for scripts: 0 finished, 2 stopped to ask you something, 3 failed, 4 ran out of budget."].join("\n");
}
