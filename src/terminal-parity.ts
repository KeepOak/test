/**
 * What `branch` answers to, set beside Hermes Agent's `hermes` and OpenClaw's `openclaw` (both MIT;
 * only their command names were read, see THIRD_PARTY_NOTICES.md). Each row says whether the Branch
 * command was built in wave mac3, already existed, lives in the window at a named home (and is
 * reachable from the terminal view by that name), or does not apply, and why. The table is data so
 * `docs/configuration.md`, the tests and the coming command catalog can all read the same rows.
 */
export type ParityStatus = "built" | "existed" | "window" | "not applicable";
export interface ParityRow { what: string; hermes: string; openclaw: string; branch: string; status: ParityStatus; note: string }

const row = (what: string, hermes: string, openclaw: string, branch: string, status: ParityStatus, note = ""): ParityRow =>
  ({ what, hermes, openclaw, branch, status, note });

export const PARITY: ParityRow[] = [
  row("Interactive view", "hermes", "openclaw", "branch", "built", "In a terminal it opens the designed view; anywhere else it runs `branch start` as before."),
  row("Conversation", "hermes chat", "openclaw tui | terminal | chat", "branch chat", "existed", "Redrawn in the window's design; `--plain` keeps the streaming view."),
  row("One request, printed", "hermes -z | chat -q", "openclaw agent", "branch run", "existed"),
  row("A scripted job", "hermes chat --query-file", "openclaw agent exec", "branch headless", "existed"),
  row("Carry on a conversation", "hermes --resume | -c", "openclaw resume", "branch resume [id]", "built", "`latest` or the first letters of a conversation's number."),
  row("Earlier conversations", "hermes sessions", "openclaw sessions | transcripts", "branch sessions [show <id>]", "built", "Removing one lives in Settings › Data & usage."),
  row("Which model answers", "hermes model", "openclaw models list | set | status", "branch model [list | use <id>]", "built"),
  row("Fallback models", "hermes fallback", "openclaw models fallbacks", "branch settings models defaults", "window", "settings:models:defaults"),
  row("Several models together", "hermes moa", "-", "branch settings models second", "window", "settings:models:second"),
  row("Signing in to a model service", "hermes auth | login | logout | portal", "openclaw models auth | onboard", "branch login | logout", "existed", "Keys for other services: settings:models:connection."),
  row("Setting up", "hermes setup", "openclaw setup | onboard | configure", "branch setup", "built", "Opens Settings › Models › Connection; prints the health check when not in a terminal."),
  row("Settings", "hermes config", "openclaw config get | set", "branch settings [page] (also `config`)", "built", "Reads every page; changes are made on the page itself."),
  row("Status", "hermes status", "openclaw status | health", "branch status", "existed"),
  row("Checking and repairing", "hermes doctor | dump | debug", "openclaw doctor | triage", "branch doctor [--fix]", "existed"),
  row("What a task did", "hermes logs", "openclaw logs", "branch logs <task>", "existed"),
  row("Emergency stop", "hermes pause | resume", "openclaw gateway suspend | resume", "branch lockdown [on | off] (also `pause`)", "built", "Works beside an open Branch; turning it off is the owner's alone."),
  row("When to ask first", "hermes approvals", "openclaw approvals | exec-policy", "branch permissions [preset]; branch approve", "built", "Beside an open Branch, `approve` answers the exact question waiting, once, by the window's rules."),
  row("Schedules", "hermes cron", "openclaw cron", "branch schedule (also `cron`); branch trigger", "existed"),
  row("Webhooks and hooks", "hermes webhook | hooks", "openclaw hooks | webhooks", "branch automations triggers", "built", "Listed; edited at automations:triggers."),
  row("Skills", "hermes skills | bundles | curator | sync", "openclaw skills", "branch skills; branch skill pack | install", "built", "`skill` already existed; the rest is customize:tools."),
  row("Plugins", "hermes plugins", "openclaw plugins", "branch plugin (also `plugins`)", "existed", "On its own it lists them."),
  row("Tools", "hermes tools", "-", "branch tools", "built", "Listed by toolbox; what may run without asking is settings:permissions."),
  row("MCP servers", "hermes mcp", "openclaw mcp", "branch mcp; branch mcp-serve (also `mcp serve`)", "built", "`mcp-serve` already existed."),
  row("Code editors (ACP)", "hermes acp", "openclaw acp", "branch acp-serve (also `acp`)", "existed"),
  row("Chat apps", "hermes gateway | whatsapp | slack | pairing | peer", "openclaw channels | pairing | directory", "branch channels", "built", "Listed; connecting and pairing are customize:channels."),
  row("Sending a message out", "hermes send", "openclaw message", "branch send <chat app> <chat> [words]", "existed", "Goes out through the running engine's own connections, after Lockdown and approval checks."),
  row("Memory", "hermes memory | journey", "openclaw memory | wiki", "branch memory [words]", "built"),
  row("Documents", "-", "-", "branch library documents", "built"),
  row("Backups", "hermes backup | import", "openclaw backup", "branch backup | restore", "existed"),
  row("Moving in from another assistant", "hermes import-agent | claw migrate", "openclaw migrate", "branch import-agent", "existed", "Branch's own file; bringing in other assistants is mac2/move-in at settings:usage."),
  row("Separate assistants", "hermes profile", "openclaw agents", "branch export-agent | import-agent", "window", "People on this computer: settings:general."),
  row("Projects", "hermes project", "-", "branch projects", "built"),
  row("Updating", "hermes update", "openclaw update", "branch update", "existed"),
  row("Removing", "hermes uninstall", "openclaw uninstall | reset", "branch uninstall", "existed", "Conversations and files stay unless --delete-data."),
  row("Working with the window closed", "hermes gateway install | start | stop", "openclaw daemon | node", "branch daemon install | uninstall | status", "existed"),
  row("The gateway", "hermes gateway", "openclaw gateway", "branch gateway [on | off]", "built", "The same switch as Settings › Gateway: it keeps Branch running and starts it again if it stops."),
  row("The web app", "hermes dashboard | serve", "openclaw dashboard | gateway run", "branch start (also `serve`, `dashboard`)", "existed"),
  row("Shell completion", "hermes completion", "openclaw completion", "branch completion", "existed"),
  row("Version", "hermes --version", "openclaw --version", "branch version (also `--version`, `-v`)", "built"),
  row("Theme", "hermes skin", "-", "branch theme [name | list | light | dark | follow] (also `skin`)", "built", "The same setting as Settings › Appearance."),
  row("Usage and cost", "hermes insights", "openclaw gateway usage-cost", "branch usage (also `insights`)", "built"),
  row("Checkpoints", "hermes checkpoints", "openclaw backup git", "branch snapshots (also `checkpoints`)", "built", "Putting one back is settings:usage."),
  row("Worktrees", "hermes worktree", "openclaw worktrees", "branch settings general", "window", "A project's line of work is switched at settings:general."),
  row("Task board", "hermes kanban", "openclaw tasks", "branch inbox [needs | finished | history]", "built"),
  row("Security audit", "hermes security audit", "openclaw security audit", "branch security audit", "existed", "`doctor` checks what Branch relies on."),
  row("Secrets", "hermes secrets | vault", "openclaw secrets", "branch settings secrets", "window", "settings:secrets; values are never printed."),
  row("Browser and screen", "hermes browser | computer-use", "openclaw browser | nodes | sandbox", "branch settings computer", "window", "settings:computer."),
  row("Language servers", "hermes lsp", "-", "branch settings advanced", "window", "settings:advanced, Help with code."),
  row("Network reach", "hermes egress | proxy", "openclaw proxy | dns", "branch settings computer", "window", "settings:computer."),
  row("Telemetry", "-", "openclaw telemetry", "-", "not applicable", "Branch sends none."),
  row("Pets", "hermes pets", "-", "branch switch oak", "not applicable", "Branch has its own oak: `/switch oak` in the view."),
  row("Evaluations", "-", "openclaw qa", "branch eval | study; branch qa", "existed", "`qa` runs plain-language page test scenarios."),
  row("Short-lived keys", "-", "openclaw devices | gateway auth-token", "branch token", "existed"),
  row("Pairing a phone", "-", "openclaw qr", "branch phone", "existed", "Shows the code to install the Branch app; pairing it is done in the window."),
  row("Prompt size", "hermes prompt-size", "-", "branch settings advanced", "window", "settings:advanced, How the assistant finds its tools."),
  row("Help", "hermes --help", "openclaw docs", "branch help; branch <command> --help", "existed"),
  row("Every place by name", "-", "-", "branch places; branch inbox | automations | library | customize | team", "built", "Every home in docs/places.md."),
];

/** The commands this wave adds to `branch`, for the command list, help and completion. */
export const TERMINAL_CLI_COMMANDS: { name: string; summary: string; options: string[] }[] = [
  { name: "inbox", summary: "What needs you, what finished, and the history: inbox [needs|finished|history]", options: ["--json"] },
  { name: "automations", summary: "Schedules, procedures and triggers: automations [scheduled|procedures|triggers]", options: ["--json"] },
  { name: "library", summary: "Memory, documents and what it made: library [memory|documents|made]", options: ["--json"] },
  { name: "customize", summary: "Trunks, tools, specialists, channels and everywhere: customize [trunks|tools|specialists|channels|everywhere]", options: ["--json"] },
  { name: "overview", summary: "What this computer or a Trunk is doing: overview [here]", options: ["--json"] },
  { name: "team", summary: "Who uses Branch, and what their Trunks are doing now: team [live|people]", options: ["--json"] },
  { name: "household", summary: "People who use Branch here (Team › People): household [people]", options: ["--json"] },
  { name: "settings", summary: "The Settings pages by name: settings [page] [tab]", options: ["--json"] },
  { name: "places", summary: "Every place, tab and Settings page the terminal can open", options: ["--json"] },
  { name: "theme", summary: "The theme, shared with the window: theme [name|list|light|dark|follow|contrast|language]", options: ["--json"] },
  { name: "sessions", summary: "Earlier conversations: sessions [list | show <id>]", options: ["--json"] },
  { name: "resume", summary: "Carry on a conversation in the terminal view: resume [id|latest]", options: [] },
  { name: "model", summary: "Which model answers: model [list | use <id>]", options: ["--json"] },
  { name: "memory", summary: "What it remembers: memory [words]", options: ["--json"] },
  { name: "skills", summary: "Skills installed here", options: ["--json"] },
  { name: "tools", summary: "Every tool, by toolbox", options: ["--json"] },
  { name: "channels", summary: "Chat apps connected to Branch", options: ["--json"] },
  { name: "mcp", summary: "Other programs' tools Branch can use; mcp serve offers Branch's own", options: ["--json"] },
  { name: "projects", summary: "Your projects, with the one in use marked", options: ["--json"] },
  { name: "lockdown", summary: "The one switch that refuses commands and makes everything else wait for your yes: lockdown [on|off]", options: ["--json"] },
  { name: "permissions", summary: "When Branch checks with you: permissions [preset] [confirm]", options: ["--json"] },
  { name: "usage", summary: "What this month has used and cost", options: ["--json"] },
  { name: "snapshots", summary: "Kept points the workspace can be put back to", options: ["--json"] },
  { name: "setup", summary: "Open Settings › Models to connect a model, or print the checks", options: [] },
  { name: "version", summary: "Print the version", options: ["--json"] }, // --json: bucket 22 (src/install/manage-cli.ts)
];

/** Other names people bring from Hermes and OpenClaw, and the Branch command each one means. */
export const TERMINAL_ALIASES: Record<string, string[]> = {
  config: ["settings"], skin: ["theme"], models: ["model"], plugins: ["plugin"], cron: ["schedule"],
  approvals: ["permissions"], insights: ["usage"], checkpoints: ["snapshots"], pause: ["lockdown", "on"],
  serve: ["start"], dashboard: ["start"], acp: ["acp-serve"], "--version": ["version"], "-v": ["version"], "-V": ["version"],
  kanban: ["inbox"], tasks: ["inbox"], webhooks: ["automations", "triggers"], hooks: ["automations", "triggers"],
  documents: ["library", "documents"], specialists: ["customize", "specialists"], connections: ["customize", "connections"],
};

/**
 * The command line as Branch reads it: nothing at all opens the view in a terminal (and starts the
 * web app anywhere else, as it always has), and a name brought from Hermes or OpenClaw becomes the
 * Branch command it means.
 */
export function terminalArgv(args: string[], interactive: boolean): string[] {
  if (!args.length) return [interactive ? "chat" : "start"];
  const [first = "", ...rest] = args;
  if (first === "mcp" && rest[0] === "serve") return ["mcp-serve", ...rest.slice(1)];
  const alias = TERMINAL_ALIASES[first];
  return alias ? [...alias, ...rest] : args;
}
