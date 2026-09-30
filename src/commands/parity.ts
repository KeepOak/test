/**
 * The slash commands of other agents, each set beside what Branch does for it (wave mac3,
 * commands). Studied from the clones in ~/Code/agent-refs on 2026-09-17: Hermes Agent
 * (`hermes_cli/commands.py`, MIT), OpenClaw (`src/auto-reply/commands-registry.shared.ts`, MIT),
 * Codex (`codex-rs/tui/src/slash_command.rs`, Apache-2.0), Gemini CLI (`packages/cli/src/ui/commands`,
 * Apache-2.0), OpenCode (`packages/app` slash entries, MIT), Aider (`aider/commands.py`,
 * Apache-2.0), and OpenHands (study only). Claude Code's list is from its public documentation.
 * No code was taken from any of them; the names are listed so the owner can see the match.
 *
 * `branch` is the Branch command, or "—" when there is none; `status` says why.
 */
export type ParityStatus = "built" | "existed" | "elsewhere" | "not applicable";
export interface ParityRow { what: string; theirs: string; branch: string; status: ParityStatus; note: string }

const row = (what: string, theirs: string, branch: string, status: ParityStatus, note = ""): ParityRow => ({ what, theirs, branch, status, note });

export const PARITY: readonly ParityRow[] = [
  row("List the commands", "/help (all), /commands (OpenClaw, Hermes)", "/help", "existed", "Now written from the one table, per surface."),
  row("Ask about the agent itself", "/help <question> (Aider), /docs (Gemini)", "/help <question>", "built", "Answers from Branch's own handbook."),
  row("Change the model", "/model (all), /models (OpenClaw)", "/model", "existed", "Now also in chat apps, for that chat's conversation."),
  row("How hard it thinks", "/think, /reasoning (OpenClaw, Hermes), /reasoning_effort (Aider)", "/think", "built", "Was terminal only."),
  row("Start afresh", "/new, /clear, /reset (all)", "/new", "existed", "Window, phone, terminal and chat."),
  row("Earlier conversations", "/resume, /sessions (Hermes, Codex, Gemini, Claude Code)", "/sessions", "existed"),
  row("Fold the conversation", "/compact (Codex, Claude Code, OpenCode, OpenClaw), /compress (Hermes, Gemini)", "/compact", "built", "Was chat only."),
  row("Stop the task", "/stop (Hermes, OpenClaw, Codex), Esc (Claude Code)", "/stop", "built", "Was chat only."),
  row("What is happening", "/status (Hermes, OpenClaw, Codex, Claude Code), /stats (Gemini)", "/status", "built", "Was chat only."),
  row("Tokens and cost", "/usage (Hermes, OpenClaw, Codex), /cost (Claude Code), /stats (Gemini)", "/usage", "built", "Chat keeps its footer switch."),
  row("What fills the next request", "/tokens (Aider), /context (Hermes, OpenClaw, Claude Code)", "/tokens", "built"),
  row("A question on the side", "/btw (Hermes, OpenClaw, Codex), /side (Codex)", "/btw", "built", "Was chat only. The OpenHands version was only studied."),
  row("Work until a goal is met", "/goal (Hermes, OpenClaw, Codex, OpenHands)", "/goal", "built", "Uses goal mode from mac2/goal-undo when that is in this copy."),
  row("Who am I, what may I do", "/whoami (Hermes, OpenClaw)", "/whoami", "built"),
  row("Version", "/version (Hermes), /about (Gemini)", "/version", "built"),
  row("Health check", "/doctor (Claude Code), /diagnostics (OpenClaw), /debug (Hermes)", "/health", "built", "The same check as `branch doctor`."),
  row("Approval mode", "/permissions (Codex, Gemini, Claude Code), /approvals (Hermes), /yolo (Hermes)", "/preset", "existed", "Changing it needs the key of this computer; never from a chat."),
  row("Emergency stop for everything", "/pause (Hermes), /elevated (OpenClaw)", "/lockdown", "existed", "Owner only; ends earlier yeses as the route does."),
  row("Memory", "/memory (Hermes, Gemini, Claude Code, Codex)", "/memory", "existed"),
  row("Skills", "/skills (Hermes, Codex, Gemini)", "/skills", "existed"),
  row("Use a skill", "/skill (OpenClaw), /<skill-name> (Hermes)", "/skill", "built", "Pins one to the conversation, as the window's skill pin does; it grants nothing. /<skill-name> is not taken: a skill's name could shadow a command."),
  row("Plan first", "/plan (Hermes, Codex, Gemini), /architect (Aider)", "/plan", "existed"),
  row("Practice without changes", "/ask (Aider)", "/dry-run", "existed"),
  row("Private conversation", "incognito (OpenClaw)", "/temporary", "existed"),
  row("Attach a file or picture", "/image, /paste (Hermes, Aider), /add (Aider), @file (Codex, Gemini)", "/attach", "existed"),
  row("Save the conversation", "/export (Codex, Claude Code, OpenCode), /save (Hermes, Aider), /export-session (OpenClaw)", "/export", "existed"),
  row("Theme", "/theme (Codex, Gemini, Claude Code), /skin (Hermes)", "/theme", "existed"),
  row("Settings", "/config (Hermes, OpenClaw, Claude Code), /settings (Gemini, Aider)", "/settings", "existed"),
  row("Tools and connections", "/tools (Hermes, Gemini), /mcp (Codex, Gemini, OpenCode, OpenClaw), /plugins", "/customize", "existed", "Opens Customize; adding one stays a screen."),
  row("Scheduled work", "/cron (Hermes), /loop (OpenClaw, Hermes)", "/automations", "existed"),
  row("Steer the working task", "/steer (Hermes, OpenClaw), /queue (Hermes)", "/steer", "built", "Also typing while it works (window's follow-up, chat notes); from a chat the note names who sent it."),
  row("Keyboard help", "/keymap (Codex), /shortcuts (Gemini)", "/keys", "existed", "Terminal only; the window shows keys in its own help."),
  row("Leave", "/quit, /exit (all)", "/exit", "existed", "Terminal only."),
  row("Take back a turn or files", "/undo (Hermes, Aider, OpenCode), /rewind (Gemini), /rollback (Hermes)", "—", "elsewhere", "mac2/goal-undo builds it as a message action; a command can follow it."),
  row("Branch or fork a conversation", "/branch (Hermes), /fork (Codex, OpenCode)", "—", "elsewhere", "The window's branch action (session tree); not a typed command yet."),
  row("Show the changes", "/diff (Hermes, Codex, Aider)", "—", "elsewhere", "Receipts in the side pane's Files tab."),
  row("Review the work", "/review (Hermes, Codex)", "—", "elsewhere", "/verify (terminal) and the reviewer switch."),
  row("Write project instructions", "/init (Hermes, Codex, Gemini, Claude Code)", "/init", "built", "mac7/r17-d: the model writes AGENTS.md through the context-file loader's writer; follows the \"Writing the project's instruction file\" switch."),
  row("Copy the last answer", "/copy (Hermes, Codex, Gemini, Aider)", "—", "not applicable", "The window has a copy button on each answer; a terminal copies with the mouse."),
  row("Sign in or out", "/login, /logout (Hermes, Codex, OpenClaw), /auth (Gemini)", "—", "not applicable", "Signing in is a Settings screen; a typed command would carry secrets."),
  row("Run a shell command", "/run, /bash, ! (Aider, OpenClaw, Gemini)", "—", "not applicable", "Programs run only as tool calls under the approval rules."),
  row("Change directory", "/cd (Codex), /directory (Gemini)", "—", "not applicable", "The workspace is set per project in Settings."),
  row("Mascots and pets", "/pet, /hatch (Hermes), /pets (Codex), /corgi (Gemini)", "—", "not applicable", "Branch draws its own oak instead."),
  row("Vendor account and billing", "/subscription, /topup (Hermes), /upgrade (Gemini)", "—", "not applicable", "Branch has no account of its own."),
  row("Report a bug", "/bug (Gemini), /feedback (Codex), /debug upload (Hermes)", "—", "not applicable", "Nothing is sent anywhere; Settings › Advanced has diagnostics."),
  // bucket 12
  row("Your own commands", "custom commands (Claude Code, Gemini CLI, OpenCode, Kilo Code), prompt groups with a command (LibreChat)", "/prompts", "built", "Saved prompts with a command of their own, on every surface with a message box; /prompts lists them and the saved procedures."),
  row("Restart or update", "/restart, /update (Hermes, OpenClaw)", "—", "elsewhere", "The dashboard's restart control and Settings › About."),
  // r17-b
  row("Repeat in this conversation", "/loop, /proactive (Hermes), /loop (OpenClaw)", "/loop", "built", "Owner only; one per conversation, at most 100 turns, a minute apart at least."),
  row("A quiet check on this conversation", "/heartbeat, /hb (Hermes)", "/heartbeat", "built", "Speaks up only with news; five minutes apart at least."),
  row("More to a goal", "/subgoal (Hermes)", "/subgoal", "built", "The judge counts the goal done only when every sub-goal holds."),
  row("A task on the side, in its own conversation", "/bg (Hermes)", "/bg", "built", "At most three at once."),
  row("Carry on elsewhere", "/handoff (Hermes)", "/handoff", "built", "An exact admitted Telegram owner DM from the Share chooser, a terminal command, or a named assistant."),
  row("Suggested automations", "/suggestions, /suggest (Hermes)", "/suggestions", "built", "A no is kept for good."),
  row("Automation blueprints", "/blueprint, /bp (Hermes)", "/blueprint", "built", "The blanks are checked; the owner's own command is the yes."),
  // r17-i
  row("Pause a chat app", "/platform (Hermes)", "/platform", "built", "Owner only; in a chat app, only from the owner's own account in a direct chat."),
  // r17-h
  row("The waiting line", "/queue (Hermes)", "/queue", "built", "Reword, move or take out a message before it starts."),
  row("Typing while it works", "/busy (Hermes); queue, steer or interrupt (Cline)", "/busy", "built", "Owner only; steering uses the same trusted note as the Steer button."),
  row("Focus view", "/focus (Hermes)", "/focus", "built", "Only the prompt and the final answer; the steps are still one click away with /focus off."),
  row("Asking for packages and tool servers", "self-modification requests (NanoClaw)", "/installs", "built", "The malware list is asked first; approving works only in the app or the owner's terminal, and nothing installs itself."),
];
