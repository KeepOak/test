import { spawn } from "node:child_process";
import { z } from "zod";
import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { currentAccountCall, refuseSignInForTrunk } from "../accounts/context.js"; // mac7/lockdown-fix
import { startCall } from "../windows-command.js";

/**
 * Batch 20 (wave 8): using a coding assistant already installed on this computer as a model.
 *
 * Claude Code, Codex and GitHub Copilot all have a command line that answers one question and
 * prints the answer. Where the owner already pays for one of those, this lets Branch ask it instead
 * of a model service: nothing is sent to an address of Branch's choosing, no key is stored, and the
 * tool's own sign-in is the only sign-in there is.
 *
 * What this shape deliberately does not do:
 *   - it does not hold a conversation of its own. Branch's transcript is flattened into one prompt.
 *   - it does not ask the tool to call Branch's tools. The tool answers in words; Branch decides.
 *   - it opens no address itself. Whatever the tool reaches is the tool's business and the owner's,
 *     which is why the catalog row says "uses your installed tool and its own sign-in".
 *
 * The command is one of the rows below, or one the owner typed themselves. Nothing here is ever
 * built out of what the model said: the arguments are fixed and the prompt goes in on stdin.
 */
export const cliAgentShape = "cli-agent";

export const CliAgentRowSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/).max(64),
  name: z.string().trim().min(1).max(80),
  /** The program to run. Looked up on this computer's path; never run through a shell. */
  command: z.string().trim().min(1).max(200),
  /** Fixed words before the prompt. The prompt itself always goes in on standard input. */
  args: z.array(z.string().max(120)).max(12).default([]),
  /** The tool prints JSON and the answer is one field of it, rather than plain words. */
  jsonField: z.string().trim().max(40).default(""),
  /** Shown beside the row, so nobody thinks Branch is signing in to anything. */
  note: z.string().trim().max(200).default("Uses your installed tool and its own sign-in."),
  /** The Terms line: which route this is, where the maker's terms are, and anything to know first. */
  terms: z.object({
    route: z.string().min(1).max(200),
    url: z.string().regex(/^https:\/\//).max(2048),
    standing: z.enum(["official", "unofficial"]),
    warning: z.string().max(400).optional(),
  }).strict().optional(),
}).strict();
export type CliAgentRow = z.infer<typeof CliAgentRowSchema>;

/** What an owner's own command is told: Branch cannot know its maker's terms. */
const ownCommandTerms = {
  route: "A program you named, with its own sign-in",
  url: "https://github.com/stabrea/Branch-Agent/blob/main/docs/configuration.md",
  standing: "unofficial" as const,
  warning: "Branch cannot know this program's terms. Check that its maker allows it to be run by another app.",
};

/** The coding assistants Branch knows the command line of. Data, not code: correct it and move on. */
export const cliAgentCatalog: CliAgentRow[] = [
  // Anthropic lets a person sign in to its unmodified Claude Code program with their own plan, and
  // forbids other apps from handling Claude.ai sign-ins; Branch only runs the program and never
  // touches its sign-in (https://code.claude.com/docs/en/legal-and-compliance).
  { id: "claude-code", name: "Claude Code (installed on this computer)", command: "claude",
    // stream-json (which -p requires --verbose for) also prints the program's rate_limit_event lines: its plan windows.
    args: ["-p", "--output-format", "stream-json", "--verbose"], jsonField: "result",
    note: "Runs Anthropic's own Claude Code with your own sign-in. Branch never sees or keeps that sign-in.",
    terms: {
      route: "Anthropic's unmodified claude program, run with -p, signed in by you",
      url: "https://code.claude.com/docs/en/legal-and-compliance",
      standing: "official",
      warning: "Use through claude -p counts against your Claude plan's usage limits (https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Plan limits assume ordinary individual use.",
    } },
  { id: "codex", name: "Codex (installed on this computer)", command: "codex",
    args: ["exec", "--json", "-"], jsonField: "",
    note: "Runs OpenAI's own Codex with your own sign-in. Branch never sees or keeps that sign-in.",
    terms: {
      route: "OpenAI's codex program, run with exec, signed in by you",
      url: "https://learn.chatgpt.com/docs/auth",
      standing: "official",
      warning: "Use through a ChatGPT plan counts against that plan's limits.",
    } },
  // `copilot -p` takes the prompt as its value, which would put the whole conversation on the
  // command line where any program can read it; Copilot also accepts the prompt piped in on
  // standard input (github/copilot-cli changelog), which is how every row here is given it.
  { id: "copilot", name: "GitHub Copilot CLI (installed on this computer)", command: "copilot",
    args: [], jsonField: "",
    note: "Runs GitHub's own Copilot command line with your own sign-in. Branch never sees or keeps that sign-in.",
    terms: {
      route: "GitHub's copilot program, with the question piped in, signed in by you",
      url: "https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli",
      standing: "official",
      warning: "Requests count against your Copilot plan's premium requests.",
    } },
  // Google says using Gemini CLI's sign-in from other software breaks its terms
  // (https://geminicli.com/docs/resources/tos-privacy/), so Branch runs the program itself in its
  // documented headless mode (docs/cli/headless.md: JSON output with a "response" field).
  { id: "gemini-cli", name: "Gemini CLI (installed on this computer)", command: "gemini",
    args: ["--output-format", "json"], jsonField: "response",
    note: "Runs Google's own Gemini CLI with your own sign-in. Branch never sees or keeps that sign-in.",
    terms: {
      route: "Google's gemini program in its headless mode, signed in by you",
      url: "https://geminicli.com/docs/resources/tos-privacy/",
      standing: "official",
      warning: "Google forbids other apps from reusing Gemini CLI's sign-in, so Branch only runs the program. Use counts against your Google plan's limits.",
    } },
];

/** Only what a program needs to find itself and its own sign-in; nothing else of the owner's. */
const passedThrough = ["PATH", "PATHEXT", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"];
export function strippedEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of passedThrough) if (process.env[name]) result[name] = process.env[name];
  return result;
}

export interface CliAgentLimits {
  /** How long the tool may take over one answer. */
  timeoutMs?: number;
  /** Most characters of answer kept; anything past this is dropped rather than held in memory. */
  maxOutputChars?: number;
}
export type SpawnAgent = (
  row: CliAgentRow, prompt: string, signal: AbortSignal, limits: Required<CliAgentLimits>,
  /** mac6/accounts: the one extra variable naming this account's own folder (CLAUDE_CONFIG_DIR, ...). */
  home?: AccountHome,
  /** Live steps: each whole line the program prints, as it prints it (stream-json is one event a line). */
  onLine?: (line: string) => void,
) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;

/** Branch's whole transcript as the one question the tool is asked. */
export function agentPromptFrom(request: CompletionRequest): string {
  return request.messages
    .filter((message) => message.content?.trim())
    .map((message) => `${message.role}: ${message.content.trim()}`)
    .join("\n\n")
    .slice(0, 100_000);
}

/** The answer out of whatever the tool printed: one JSON field where it offers one, else the words. */
export function answerFrom(row: CliAgentRow, stdout: string): string {
  const text = stdout.trim();
  // Codex's exec --json prints one event a line; its answer is its last agent_message (see codexJsonSteps).
  if (printsCodexEvents(row)) return codexAnswer(text) ?? ""; // no message: "answered with nothing", never the raw events
  if (!row.jsonField) return text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const said = parsed[row.jsonField];
    if (typeof said === "string") return said.trim();
  } catch { /* one JSON object per line (stream-json), or not JSON at all */ }
  const streamed = streamedAnswer(row.jsonField, text);
  return streamed ?? text;
}
/** stream-json: the field on the last `"type":"result"` line, else the text of the last assistant message. */
function streamedAnswer(field: string, text: string): string | null {
  let result: string | null = null, assistant: string | null = null;
  for (const line of text.split("\n")) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (parsed.type === "result" && typeof parsed[field] === "string") result = (parsed[field] as string).trim();
    const content = parsed.type === "assistant" ? (parsed.message as { content?: unknown } | undefined)?.content : undefined;
    if (Array.isArray(content)) assistant = content.map((part: { type?: string; text?: string }) => part?.type === "text" ? part.text ?? "" : "").join("").trim();
  }
  return result ?? assistant;
}

// ---- mac6/accounts: several sign-ins of one program, each in the folder its maker documents ----
/** The environment variable each program officially reads for a folder of its own, sign-in included. */
export const accountHomeVariables: Record<string, string> = {
  // https://code.claude.com/docs/en/claude-directory ("If you set CLAUDE_CONFIG_DIR ...")
  "claude-code": "CLAUDE_CONFIG_DIR",
  // https://learn.chatgpt.com/docs/config-file/environment-variables ("Sets the root for Codex state ... auth")
  codex: "CODEX_HOME",
  // https://geminicli.com/docs/cli/enterprise/ (GEMINI_CLI_HOME)
  "gemini-cli": "GEMINI_CLI_HOME",
  // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference (COPILOT_HOME)
  copilot: "COPILOT_HOME",
};
export interface AccountHome { name: string; path: string }
/** The program said it has reached its plan's limit. */
export class ProgramLimitError extends Error { override name = "ProgramLimitError"; }
const limitWords = /usage limit|rate limit|limit reached|quota exceeded|exceeded your (?:current )?quota|too many requests/i;
// ---- end mac6/accounts ----

export const runCliAgent: SpawnAgent = (row, prompt, signal, limits, home, onLine) =>
  new Promise((resolve) => {
    const env = home ? { ...strippedEnvironment(), [home.name]: home.path } : strippedEnvironment();
    // An npm-installed program is a .cmd launcher on Windows, which cannot be started without a shell (src/windows-command.ts).
    const start = startCall(row.command, row.args, env);
    const child = spawn(start.command, start.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, env });
    let stdout = "", stderr = "", settled = false;
    const finish = (code: number | null, missing?: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr, ...(missing ? { missing: true } : {}) });
    };
    const stop = (): void => { child.kill(); finish(null); };
    const timer = setTimeout(stop, limits.timeoutMs);
    timer.unref?.();
    signal.addEventListener("abort", stop, { once: true });
    let partial = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdout.length < limits.maxOutputChars) stdout += text;
      if (!onLine) return;
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      if (partial.length > 1_000_000) partial = ""; // one line that never ends is not an event
      for (const line of lines) { try { onLine(line); } catch { /* a step not shown never stops the program */ } }
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
    child.on("error", (error: NodeJS.ErrnoException) => finish(1, error.code === "ENOENT"));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
  });

/**
 * One installed coding assistant, answering as if it were a model service. It never asks for tool
 * calls, so Branch's own loop simply gets words back and carries on with them.
 */
export class CliAgentProvider implements Provider {
  readonly name: string;
  /** Its own timeout (limits.timeoutMs) decides when it has taken too long, never the silence watchdog. */
  readonly keepsOwnTime = true;
  private readonly limits: Required<CliAgentLimits>;
  /** mac6/accounts: say plainly when the program reports a plan limit (set for accounts in a list). */
  detectLimits = false;
  /** Handed everything the program printed, so the plan windows it reported can be kept (src/plan-windows.ts). */
  onOutput: ((stdout: string) => void) | null = null;
  constructor(
    private readonly row: CliAgentRow,
    limits: CliAgentLimits = {},
    private readonly spawnAgent: SpawnAgent = runCliAgent,
    /** mac6/accounts: which account's folder the program uses; absent means its usual one. */
    private readonly home?: AccountHome,
  ) {
    this.name = `${cliAgentShape}:${row.id}`;
    this.limits = { timeoutMs: limits.timeoutMs ?? 180_000, maxOutputChars: limits.maxOutputChars ?? 200_000 };
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    refuseSignInForTrunk(); // mac7/lockdown-fix: an installed program's sign-in answers a Trunk only for work the owner is behind
    const row = this.rowFor();
    // Live steps: Claude Code's stream-json and Codex's exec --json say its thinking and each tool as it goes; the window
    // shows them live.
    const wanted = Boolean(request.onReasoningDelta || request.onToolActivity);
    const onLine = !wanted ? undefined : row.args.includes("stream-json") ? (line: string) => streamJsonStep(line, request)
      : printsCodexEvents(row) ? codexJsonSteps(request) : undefined;
    const outcome = this.home || onLine
      ? await this.spawnAgent(row, agentPromptFrom(request), request.signal, this.limits, this.home, onLine)
      : await this.spawnAgent(row, agentPromptFrom(request), request.signal, this.limits);
    if (outcome.missing)
      throw new Error(`"${this.row.command}" is not on this computer, so Branch cannot use ${this.row.name}. Install it, or pick another model.`);
    if (outcome.stdout) this.onOutput?.(outcome.stdout);
    if (outcome.code === null)
      throw new Error(`${this.row.name} took too long and was stopped. Ask again, or pick another model.`);
    // mac6/accounts: only when an account folder is in use, so a single sign-in behaves as before.
    if (outcome.code !== 0 && (this.home || this.detectLimits) && limitWords.test(`${outcome.stderr}\n${outcome.stdout.slice(0, 4000)}`))
      throw new ProgramLimitError(`${this.row.name} says this account has reached its plan limit.`);
    if (outcome.code !== 0)
      throw new Error(`${this.row.name} stopped with an error and said nothing Branch can pass on. Run it yourself to see why.`);
    const content = answerFrom(this.row, outcome.stdout);
    if (!content) throw new Error(`${this.row.name} answered with nothing at all.`);
    request.onTextDelta?.(content);
    return { content, toolCalls: [] };
  }
  /**
   * trunks-use-subscriptions: Claude Code answering a Trunk runs with none of its own tools (`--tools ""`), so it
   * only writes words and cannot read past the Trunk's permissions; Branch's tools do the work under them.
   */
  private rowFor(): CliAgentRow {
    if (this.row.id !== "claude-code" || !currentAccountCall()?.trunk) return this.row;
    return { ...this.row, args: [...this.row.args, "--tools", ""] };
  }
  /** It publishes no list of models of its own: the tool decides what it is using. */
  modelsList(): null { return null; }
}

/* ---- live steps: Claude Code's stream-json, one event a line ----
   Shapes from the Agent SDK's message types (https://code.claude.com/docs/en/sdk/sdk-typescript, SDKAssistantMessage and
   SDKUserMessage, whose `message` is an Anthropic Messages API message): an assistant message's content holds `thinking`
   and `tool_use` blocks ({ id, name, input }); a user message's content holds `tool_result` blocks ({ tool_use_id,
   is_error }). Each tool is said as the Branch tool of the same kind, so its line has the same words and emoji.
   Words and inputs are passed on whole: the runtime hides secrets first and only then shortens them (runtime.programStep),
   so no cut leaves part of a secret that the scrub would no longer recognise. */
const programTools: Record<string, string> = {
  Bash: "shell.execute", Read: "files.read", Write: "files.write", Edit: "files.edit", MultiEdit: "files.edit", NotebookEdit: "files.edit",
  Grep: "files.grep", Glob: "files.glob", LS: "files.list", WebSearch: "web.search", WebFetch: "web.fetch", Task: "delegate.task",
  Agent: "delegate.task", TodoWrite: "todos.write",
};
const said = (value: unknown): string => String(value ?? "");
/** A tool_result's content: its text, or the text parts of its blocks. */
const resultText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: { type?: unknown; text?: unknown }) => (part?.type === "text" ? said(part.text) : "")).join("\n").trim() : "";
function programLabel(name: string, input: Record<string, unknown>): string {
  const host = (url: unknown) => { try { return new URL(String(url)).host; } catch { return said(url); } }; // not an address: its words
  switch (name) {
    case "Bash": return `Running ${said(input.command)}`;
    case "Read": return `Reading ${said(input.file_path)}`;
    case "Write": return `Writing ${said(input.file_path)}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `Changing ${said(input.file_path ?? input.notebook_path)}`;
    case "Grep": return `Searching files for “${said(input.pattern)}”`;
    case "Glob": return `Listing files like ${said(input.pattern)}`;
    case "LS": return `Looking through ${said(input.path)}`;
    case "WebSearch": return `Searching the web for “${said(input.query)}”`;
    case "WebFetch": return `Reading ${host(input.url)}`;
    case "Task": case "Agent": return `Asking a helper: ${said(input.description ?? input.prompt)}`;
    case "TodoWrite": return "Updating its checklist";
    default: return `Using ${name}`;
  }
}
export function streamJsonStep(line: string, request: Pick<CompletionRequest, "onReasoningDelta" | "onToolActivity">): void {
  let event: { type?: unknown; message?: { content?: unknown } };
  try { event = JSON.parse(line) as typeof event; } catch { return; } // not an event line
  const content = Array.isArray(event.message?.content) ? event.message.content as Record<string, unknown>[] : [];
  for (const block of content) {
    if (event.type === "assistant" && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
      request.onReasoningDelta?.(`${block.thinking.trim()}\n`);
    else if (event.type === "assistant" && block.type === "tool_use" && typeof block.name === "string") {
      const input = block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {};
      request.onToolActivity?.({ id: String(block.id ?? ""), name: programTools[block.name] ?? `program.${block.name}`,
        label: programLabel(block.name, input), input: JSON.stringify(input) });
    } else if (event.type === "user" && block.type === "tool_result") {
      const output = resultText(block.content);
      request.onToolActivity?.({ id: String(block.tool_use_id ?? ""), name: "", label: "", done: true, ...(output ? { output } : {}),
        ...(block.is_error ? { error: output || "The step went wrong" } : {}) });
    }
  }
}

/* ---- live steps: Codex's `exec --json`, one event a line ----
   Shapes from Codex's own documentation (https://learn.chatgpt.com/docs/non-interactive-mode, "JSON output"): a
   `thread.started` line with the thread's id, then `item.started` / `item.completed` lines whose `item` is one of
   `reasoning` ({ text }), `command_execution` ({ command, exit_code, status }), `file_change` ({ changes: [{ path }],
   status }), `mcp_tool_call` ({ server, tool, arguments, status }), `web_search` ({ query }), `todo_list` ({ items }) or
   `agent_message` ({ text }, the answer). Item ids ("item_1") start again in each run of the program, so each step's id
   carries the thread's. An item said only once it is done is started and finished together, so it still has its line. */
interface CodexItem {
  id?: unknown; type?: unknown; text?: unknown; command?: unknown; exit_code?: unknown; status?: unknown; changes?: unknown; aggregated_output?: unknown;
  server?: unknown; tool?: unknown; arguments?: unknown; query?: unknown; items?: unknown; error?: unknown;
}
function codexStep(item: CodexItem): { name: string; label: string; input: string } | null {
  switch (item.type) {
    case "command_execution": return { name: "shell.execute", label: `Running ${said(item.command)}`, input: said(item.command) };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes as { path?: unknown }[] : [];
      return { name: "files.edit", label: `Changing ${changes.map((c) => said(c.path)).filter(Boolean).join(", ")}`.trim(), input: JSON.stringify(changes) };
    }
    case "mcp_tool_call": return { name: `program.${said(item.server)}.${said(item.tool)}`, label: `Using ${said(item.tool)}`,
      input: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) };
    case "web_search": return { name: "web.search", label: `Searching the web for “${said(item.query)}”`, input: said(item.query) };
    case "todo_list": return { name: "todos.write", label: "Updating its checklist", input: JSON.stringify(item.items ?? []) };
    default: return null;
  }
}
function codexError(item: CodexItem): string | undefined {
  if (item.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0) return `Stopped with exit code ${item.exit_code}`;
  if (item.status === "failed" || item.status === "declined") {
    const error = item.error as { message?: unknown } | string | undefined;
    return (typeof error === "string" ? error : said(error?.message)) || "The step went wrong";
  }
  return undefined;
}
/** One run of `codex exec --json`: a reader for its lines that remembers the thread and which steps have started. */
export function codexJsonSteps(request: Pick<CompletionRequest, "onReasoningDelta" | "onToolActivity">): (line: string) => void {
  let thread = "";
  const started = new Set<string>();
  return (line) => {
    let event: { type?: unknown; thread_id?: unknown; item?: CodexItem };
    try { event = JSON.parse(line) as typeof event; } catch { return; } // not an event line
    if (event.type === "thread.started") { thread = said(event.thread_id); return; }
    const item = event.item;
    if (!item || (event.type !== "item.started" && event.type !== "item.completed")) return;
    if (item.type === "reasoning") {
      if (event.type === "item.completed" && typeof item.text === "string" && item.text.trim()) request.onReasoningDelta?.(`${item.text.trim()}\n`);
      return;
    }
    const step = codexStep(item);
    if (!step) return;
    const id = `${thread || "codex"}:${said(item.id)}`;
    if (!started.has(id)) { started.add(id); request.onToolActivity?.({ id, ...step }); }
    if (event.type !== "item.completed") return;
    const error = codexError(item), output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    request.onToolActivity?.({ id, name: "", label: "", done: true, ...(output ? { output } : {}), ...(error ? { error } : {}) });
  };
}
/** Codex's `exec --json`: the text of its last `agent_message`, or null when it printed none. */
function codexAnswer(text: string): string | null {
  let answer: string | null = null;
  for (const line of text.split("\n")) {
    let parsed: { type?: unknown; item?: CodexItem };
    try { parsed = JSON.parse(line) as typeof parsed; } catch { continue; }
    if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") answer = parsed.item.text.trim();
  }
  return answer;
}
function printsCodexEvents(row: CliAgentRow): boolean { return (row.id === "codex" || row.command === "codex") && row.args.includes("exec") && row.args.includes("--json"); }

/** A row of the catalog, with the one sentence the settings screen shows beside it. */
export function cliAgentRows(): (CliAgentRow & { shape: string; installed: null })[] {
  return cliAgentCatalog.map((row) => ({ ...row, shape: cliAgentShape, installed: null }));
}

export const CliAgentChoiceSchema = z.object({
  /** One of the rows above, or "custom" with the owner's own command. */
  id: z.string().min(1).max(64),
  command: z.string().trim().max(200).optional(),
  args: z.array(z.string().max(120)).max(12).optional(),
  jsonField: z.string().trim().max(40).optional(),
  name: z.string().trim().max(80).optional(),
}).strict();

/** The row for a choice: one Branch knows, or one the owner typed out in full. */
export function rowFor(input: unknown): CliAgentRow {
  const asked = CliAgentChoiceSchema.parse(input ?? {});
  const known = cliAgentCatalog.find((row) => row.id === asked.id);
  if (known) return CliAgentRowSchema.parse({ ...known, ...(asked.name ? { name: asked.name } : {}) });
  if (!asked.command)
    throw new Error(`Branch does not know a coding assistant called "${asked.id}". Give the command to run as well.`);
  return CliAgentRowSchema.parse({
    id: asked.id, name: asked.name ?? asked.id, command: asked.command,
    args: asked.args ?? [], jsonField: asked.jsonField ?? "", terms: ownCommandTerms,
  });
}

/**
 * Makes the chosen coding assistant available in the model list under its own name. It is only
 * offered, never made the one in use: the owner picks it the same way as any other connection.
 */
export function registerCliAgent(
  models: { register(preset: { id: string; name: string; provider: Provider; model: string }): void },
  input: unknown, limits: CliAgentLimits = {}, spawnAgent: SpawnAgent = runCliAgent,
): { id: string; name: string; note: string; terms: CliAgentRow["terms"] } {
  const row = rowFor(input);
  const id = `cli-${row.id}`;
  models.register({ id, name: row.name, provider: new CliAgentProvider(row, limits, spawnAgent), model: row.id === "claude-code" ? "sonnet" : row.command });
  return { id, name: row.name, note: row.note, terms: row.terms };
}
