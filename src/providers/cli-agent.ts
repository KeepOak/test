import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { currentAccountCall, refuseSignInForTrunk } from "../accounts/context.js"; // mac7/lockdown-fix
import { startCall } from "../windows-command.js";
import { killWindowsTree } from "../integrations/shell-process.js";
import { assertRealAgentAllowed } from "./real-agent-guard.js"; // owner-dm-signin: never the real program from a test
import { codexDefaultModel, codexVerified, codexModelsFor, type CodexModels, type CodexProbe, type CodexTry } from "../codex-models.js";
import { closeWarmCodex, startCodexAppServer, warmCodexTurn, type StartAppServer } from "../asks/codex-app-server.js";
import { codexTransportEnvironment } from "./codex-environment.js";
import { claudeSubscriptionModels } from "./claude-models.js";
import { closeNativeSubscriptions } from "./claude-subscription-continuation.js";

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

/**
 * models-ui (owner, DOGFOOD C2): what a Claude subscription answers with when nothing else was chosen: Opus 5.5 at
 * medium effort. Only Branch's own default moves; a model the connection names, and an effort the owner picked (per
 * conversation, per connection in Settings › Models, or Branch-wide), still come first (src/models.ts plan).
 */
export const claudeDefaultModel = "claude-opus-5-5";
export const claudeDefaultEffort = "medium" as const;

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

/**
 * QA 2026-09-28: Branch never leans on the owner's own Codex settings (~/.codex/config.toml, which it never reads or
 * edits). The owner's said `model = "gpt-6-sol"`, which Codex refuses with a ChatGPT sign-in, so every task through
 * Codex failed. Each call now names its model (`-c model=...`): the one chosen in Settings › Models for Codex, else the
 * most capable one Codex takes (src/codex-models.ts).
 */
export { codexDefaultModel };
/** Reject a custom invocation that could override the model provider's fixed read-only policy. */
function checkCodexPolicy(args: readonly string[]): void {
  const flags = /^(?:--(?:sandbox|permissions|ask-for-approval|full-auto|approve-for-me|yolo|dangerously-bypass-approvals-and-sandbox)|-[sa])(?:=|$)/;
  const settings = /^(?:sandbox_mode|sandbox_workspace_write|approval_policy|approvals_reviewer|default_permissions|permissions)(?:\.|$)/;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const config = arg === "-c" || arg === "--config" ? args[i + 1]
      : arg.startsWith("--config=") ? arg.slice(9) : arg.startsWith("-c") ? arg.slice(2) : undefined;
    const key = config?.split("=", 1)[0]?.replace(/[\s"']/g, "");
    if (flags.test(arg) || /^-[sa][^\s]/.test(arg) || key && settings.test(key))
      throw new Error("Codex used as a model requires read-only access and no approvals. Remove sandbox or approval overrides from this connection's arguments.");
  }
}
/** Codex as a model: one-call model, read-only sandbox and no approval escalation, independent of saved defaults. */
export function codexArgs(args: readonly string[], model: string, workDir: string | null = null): string[] {
  const at = args.findIndex((arg) => arg === "exec" || arg === "e");
  checkCodexPolicy(args);
  if (at < 0 || args.slice(0, at).includes("--")) throw new Error("Codex used as a model requires an exec invocation with read-only access and no approvals.");
  // QA 2026-09-28: Codex answering as a model works in Branch's own empty folder, which Branch made and nothing else
  // uses, so the git-repository trust check is skipped for that one folder only; any other folder keeps it.
  const where = workDir ? ["-C", workDir, "--skip-git-repo-check"] : [];
  const policy = ["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'];
  return [...args.slice(0, at), "exec", "-c", `model=${model}`, ...policy, ...where, ...args.slice(at + 1)];
}
/** Codex programs found to have no app-server this run; they answer through exec. */
const noAppServer = new Set<string>();
/** OpenAI's own `codex` program as Branch knows it (not a command the owner typed), which alone gets Branch's folder. */
const ownCodex = (row: CliAgentRow): boolean => row.id === "codex" && row.command === "codex";
/** Branch's own working folder for Codex: empty, private to this user, made on first use. */
export function codexWorkDir(): string {
  const dir = join(tmpdir(), "branch-codex-work");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

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
  /** QA 2026-09-28: how long the program may print nothing at all before it is stopped as stuck. */
  firstOutputMs?: number;
}
type SpawnLimits = Required<Pick<CliAgentLimits, "timeoutMs" | "maxOutputChars">> & Pick<CliAgentLimits, "firstOutputMs">;
export type SpawnAgent = (
  row: CliAgentRow, prompt: string, signal: AbortSignal, limits: SpawnLimits,
  /** mac6/accounts: the one extra variable naming this account's own folder (CLAUDE_CONFIG_DIR, ...). */
  home?: AccountHome,
  /** Live steps: each whole line the program prints, as it prints it (stream-json is one event a line). */
  onLine?: (line: string) => void,
) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean; silent?: boolean }>;

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
// QA retest 2026-09-28 pass 2: Claude Code at its weekly cap says "You've hit your weekly limit · resets 5am (America/New_York)",
// which none of these words matched, so the owner was told to check the program's setup and no other account was tried.
const limitWords = /usage limit|rate limit|limit reached|quota exceeded|exceeded your (?:current )?quota|too many requests|hit your (?:[\w-]+ )?limit|\b(?:weekly|daily|monthly|session|5-hour) limit/i;
/** When the program said its limit resets, in the only shape repeated back: a clock time and, if given, a time zone name. */
const resetsAt = (evidence: string): string | null =>
  /\bresets? (?:at )?(\d{1,2}(?::\d{2})?\s?(?:am|pm)(?: \([A-Za-z_]+(?:\/[A-Za-z_]+){0,2}\))?)/i.exec(evidence)?.[1] ?? null;

/** Explicit failed protocol events, never ordinary answer text discussing an error. */
function failedResult(row: CliAgentRow, stdout: string): string | null {
  if (!row.jsonField && !printsCodexEvents(row)) return null;
  const failures: string[] = [];
  for (const line of stdout.split("\n")) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!event || typeof event !== "object") continue;
    const failed = event.type === "result" && event.is_error === true
      || printsCodexEvents(row) && (event.type === "turn.failed" || event.type === "error");
    if (!failed) continue;
    const error = event.error as { message?: unknown } | undefined;
    failures.push([event.result, event.message, error?.message].filter((value) => typeof value === "string").join("\n"));
  }
  return failures.length ? failures.join("\n") : null;
}

/** Fixed explanations: arbitrary stderr may contain credentials or private file contents. */
const modelRefusal = /\bmodel\b[^\n]{0,80}\b(?:is not supported|not supported|is not available|does not exist)|model_not_found|unsupported model/i;
function programFailure(row: CliAgentRow, code: number, evidence: string, model: string | null = null, offered: readonly string[] = codexVerified): string {
  if (/not inside a trusted directory|untrusted (?:directory|folder)|directory.*not trusted/i.test(evidence))
    return `${row.name} refused the current folder because it is not trusted. Open that folder in ${row.command} and approve it there, then try again. Branch keeps the program's trust checks enabled.`;
  // QA retest 2026-09-28: Codex set (in its own settings) to a model its ChatGPT sign-in cannot use says so in its failed turn.
  if (modelRefusal.test(evidence))
    return model && row.id === "codex"
      ? `${row.name} cannot use ${model} with this sign-in. Choose one it takes (${offered.filter((one) => one !== model).join(", ")}) in Settings › Models › Connections, then retry the task.`
      : `${row.name} is set to use a model this sign-in cannot use. Choose another model in ${row.command}'s own settings, then retry the task.`;
  if (/\b401\b|unauthori[sz]ed|authentication (?:required|failed)|not (?:logged|signed) in|(?:oauth|access|refresh) token.*(?:expired|invalid)|invalid.*(?:oauth|access|refresh) token/i.test(evidence))
    return `${row.name} could not use its saved sign-in. Open Settings → Accounts and sign in again to ${row.name}, then retry the task.`;
  if (limitWords.test(evidence)) {
    const when = resetsAt(evidence);
    return `${row.name} has reached its plan limit${when ? `; it resets at ${when}` : ""}. Wait for the limit to reset or choose another account or model.`;
  }
  return `${row.name} could not finish the task (exit code ${code}). Run ${row.command} in a terminal to check its setup, then retry or choose another model.`;
}
// ---- end mac6/accounts ----

/* ---- speed: a chat's answer through Claude Code (measured 2026-09-27, owner's PC) ----
   Almost all of a short answer's time was Claude Code starting, not the model: the owner's SessionStart hooks, 13 MCP
   servers, 10 plugins and 239 tools were loaded for a call that may use none of them, and the program took seconds to
   exit after printing its result. A call with no tools of its own therefore also skips the owner's hooks, MCP servers,
   skills and saved sessions; its prompt goes in as one stream-json message so a copy of the program can be started
   ahead of time and wait, ready, for the next question; its words stream as they are written; and the answer is taken
   from the result line without waiting for the program to exit. */
/** Claude Code with none of its own tools needs none of the owner's hooks, MCP servers, skills or saved sessions. */
export const leanClaudeArgs = ["--input-format", "stream-json", "--include-partial-messages", "--strict-mcp-config",
  "--disable-slash-commands", "--no-session-persistence", "--settings", "{\"disableAllHooks\":true}"];
/** The program reads its question as one stream-json message (and so can be started before the question exists). */
const readsStreamJson = (args: readonly string[]): boolean => args.some((arg, i) => arg === "--input-format" && args[i + 1] === "stream-json");
const printsStreamJson = (args: readonly string[]): boolean => args.some((arg, i) => arg === "--output-format" && args[i + 1] === "stream-json");
/** A question as the one user message a stream-json reader takes. */
export function streamJsonQuestion(prompt: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`;
}
type Child = ReturnType<typeof spawn>;
/**
 * P0 (self-build): on Windows an npm-installed program (Codex) is Node running its launcher, which starts the real
 * program and only passes signals on. Ending Node takes the real program with it but not what that had started, so
 * the whole tree is ended instead. Elsewhere the launcher passes the signal on, and the program is not in a group of
 * its own, so the plain kill stays.
 */
function endTree(child: Child): void {
  if (process.platform === "win32" && child.pid && child.exitCode === null)
    void killWindowsTree(child.pid).then((ended) => { if (!ended) child.kill(); }, () => child.kill());
  else child.kill();
}
/** Whether a program (its process and its pipes) keeps Branch's own process running, as a task waiting on it must. */
function holdOpen(child: Child, hold: boolean): void {
  for (const handle of [child, child.stdin, child.stdout, child.stderr] as unknown as ({ ref?: () => void; unref?: () => void } | null)[])
    if (hold) handle?.ref?.(); else handle?.unref?.();
}
/**
 * One copy of a program started ahead of time, per command, arguments and account folder, waiting on its standard
 * input. Only for programs that read stream-json (so nothing is asked until the question is written). It goes away
 * after `spareIdleMs` unused, when Branch closes, and by itself if Branch stops (its standard input closes).
 */
const spares = new Map<string, { child: Child; exited: boolean; timer: ReturnType<typeof setTimeout> }>();
export const spareIdleMs = 30 * 60_000;
function startProgram(row: CliAgentRow, env: NodeJS.ProcessEnv): Child {
  assertRealAgentAllowed(row.command, env);
  // An npm-installed program is a .cmd launcher on Windows, which cannot be started without a shell (src/windows-command.ts).
  const start = startCall(row.command, row.args, env);
  return spawn(start.command, start.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, env });
}
function spareFor(key: string): Child | null {
  const spare = spares.get(key);
  if (!spare) return null;
  spares.delete(key);
  clearTimeout(spare.timer);
  if (spare.exited) return null;
  holdOpen(spare.child, true);
  return spare.child;
}
function prepareSpare(key: string, row: CliAgentRow, env: NodeJS.ProcessEnv): void {
  if (spares.has(key)) return;
  let child: Child;
  try { child = startProgram(row, env); } catch { return; }
  const spare = { child, exited: false, timer: setTimeout(() => { if (spares.get(key) === spare) spares.delete(key); child.kill(); }, spareIdleMs) };
  spare.timer.unref?.();
  child.on("error", () => { spare.exited = true; });
  child.on("exit", () => { spare.exited = true; if (spares.get(key) === spare) spares.delete(key); });
  child.stdin?.on("error", () => undefined);
  holdOpen(child, false); // a copy waiting for a question never keeps Branch running
  spares.set(key, spare);
}
/** Stops every program started ahead of time (Branch closing). */
export function closeSpareAgents(): void {
  closeNativeSubscriptions();
  closeWarmCodex(); // QA 2026-09-28: the warm Codex app-servers too
  for (const [key, spare] of spares) { clearTimeout(spare.timer); spare.child.kill(); spares.delete(key); }
}

export const runCliAgent: SpawnAgent = (row, prompt, signal, limits, home, onLine) =>
  new Promise((resolve) => {
    const base = { ...strippedEnvironment(), ...(row.id === "codex" ? codexTransportEnvironment() : {}) };
    const env = home ? { ...base, [home.name]: home.path } : base;
    const warm = readsStreamJson(row.args), key = JSON.stringify([row.command, row.args, home?.name ?? "", home?.path ?? ""]);
    const child = (warm ? spareFor(key) : null) ?? startProgram(row, env);
    let stdout = "", stderr = "", settled = false;
    const finish = (code: number | null, missing?: boolean, silent?: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(quiet);
      signal.removeEventListener("abort", stop);
      // The next question finds a copy already started, as long as this one worked.
      if (warm && code === 0) prepareSpare(key, row, env);
      resolve({ code, stdout, stderr, ...(missing ? { missing: true } : {}), ...(silent ? { silent: true } : {}) });
    };
    const stop = (): void => { endTree(child); finish(null); };
    const timer = setTimeout(stop, limits.timeoutMs);
    timer.unref?.();
    // A program that prints nothing at all is stuck (a prompt nobody will answer, a model it hangs on): stopped early.
    const quiet = limits.firstOutputMs ? setTimeout(() => { endTree(child); finish(null, false, true); }, limits.firstOutputMs) : undefined;
    quiet?.unref?.();
    signal.addEventListener("abort", stop, { once: true });
    // stream-json ends with its result line; the program may take seconds more to exit, which nobody needs to wait for.
    // QA 2026-09-28: Codex's exec --json ends its turn with turn.completed (or turn.failed), then may take 40 seconds more
    // shutting its own tool servers down; the answer is whole at that line, so nobody waits for the exit either.
    const settlesOnResult = printsStreamJson(row.args) || printsCodexEvents(row);
    let partial = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      clearTimeout(quiet);
      const text = chunk.toString("utf8");
      if (stdout.length < limits.maxOutputChars) stdout += text;
      if (!onLine && !settlesOnResult) return;
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      if (partial.length > 1_000_000) partial = ""; // one line that never ends is not an event
      for (const line of lines) {
        if (onLine) { try { onLine(line); } catch { /* a step not shown never stops the program */ } }
        const ended = line.startsWith("{\"type\":\"result\"") || line.startsWith("{\"type\":\"turn.completed\"") ? 0
          : line.startsWith("{\"type\":\"turn.failed\"") ? 1 : null;
        if (settlesOnResult && ended !== null) {
          finish(ended);
          // Left to exit by itself, without keeping Branch running; one that hangs on is stopped a little later.
          holdOpen(child, false);
          // Codex is left to close its own tool servers (stopping it would leave them running); anything else is stopped.
          if (!printsCodexEvents(row)) setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15_000).unref?.();
        }
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
    child.on("error", (error: NodeJS.ErrnoException) => finish(1, error.code === "ENOENT"));
    child.on("close", (code) => finish(code));
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(warm ? streamJsonQuestion(prompt) : prompt);
  });

/**
 * One installed coding assistant, answering as if it were a model service. It never asks for tool
 * calls, so Branch's own loop simply gets words back and carries on with them.
 */
export class CliAgentProvider implements Provider {
  readonly name: string;
  /** Its own timeout (limits.timeoutMs) decides when it has taken too long, never the silence watchdog. */
  readonly keepsOwnTime = true;
  private readonly limits: SpawnLimits;
  /** mac6/accounts: say plainly when the program reports a plan limit (set for accounts in a list). */
  detectLimits = false;
  /** Handed everything the program printed, so the plan windows it reported can be kept (src/plan-windows.ts). */
  onOutput: ((stdout: string) => void) | null = null;
  /** QA 2026-09-28: a model fixed for this connection; without one, Codex's choice in Settings › Models is read on every call. */
  model?: string;
  /** Codex's choice and which models it takes (src/codex-models.ts), shared by every account of the connection. */
  codexModels: CodexModels | null = null;
  /**
   * QA 2026-09-28: Codex answers word by word over its app-server protocol (src/asks/codex-app-server.ts); `codex exec`
   * only hands the whole answer back at the end. Null keeps exec. A Codex without app-server falls back to exec.
   */
  appServer: StartAppServer | null = null;
  constructor(
    private readonly row: CliAgentRow,
    limits: CliAgentLimits = {},
    private readonly spawnAgent: SpawnAgent = runCliAgent,
    /** mac6/accounts: which account's folder the program uses; absent means its usual one. */
    private readonly home?: AccountHome,
  ) {
    this.name = `${cliAgentShape}:${row.id}`;
    this.limits = { timeoutMs: limits.timeoutMs ?? 180_000, maxOutputChars: limits.maxOutputChars ?? 200_000, firstOutputMs: limits.firstOutputMs ?? 60_000 };
    if (ownCodex(row) && spawnAgent === runCliAgent) this.appServer = startCodexAppServer;
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    refuseSignInForTrunk(); // mac7/lockdown-fix: an installed program's sign-in answers a Trunk only for work the owner is behind
    if (this.appServer && this.row.id === "codex" && !noAppServer.has(this.row.command)) {
      const streamed = await this.viaAppServer(request, this.appServer);
      if (streamed) return streamed;
    }
    const row = this.withModel(this.rowFor(request));
    // A new Codex may take models the last one refused: checked in the background, never on the owner's time.
    if (this.row.id === "codex" && this.codexModels && this.spawnAgent === runCliAgent) this.codexModels.refreshIfUpdated(this.probe());
    // Live steps: Claude Code's stream-json and Codex's exec --json say its thinking and each tool as it goes; the window
    // shows them live. A lean call (no tools of its own) also streams its words as they are written.
    const streams = row.args.includes("--include-partial-messages");
    let streamed = false;
    const words = streams && request.onTextDelta ? (text: string) => { streamed = true; request.onTextDelta!(text); } : undefined;
    const wanted = Boolean(request.onReasoningDelta || request.onToolActivity || words);
    const onLine = !wanted ? undefined
      : row.args.includes("stream-json") ? (line: string) => { streamJsonStep(line, request); if (words) streamJsonWords(line, words, request.onReasoningDelta); }
        : printsCodexEvents(row) ? codexJsonSteps(request) : undefined;
    const outcome = this.home || onLine
      ? await this.spawnAgent(row, agentPromptFrom(request), request.signal, this.limits, this.home, onLine)
      : await this.spawnAgent(row, agentPromptFrom(request), request.signal, this.limits);
    if (outcome.missing)
      throw new Error(`"${this.row.command}" is not on this computer, so Branch cannot use ${this.row.name}. Install it, or pick another model.`);
    if (outcome.stdout) this.onOutput?.(outcome.stdout);
    if (outcome.code === null && outcome.silent)
      throw new Error(`${this.row.name} said nothing at all for ${Math.round((this.limits.firstOutputMs ?? 0) / 1000)} seconds, so it was stopped. Run ${this.row.command} in a terminal to check it starts, then retry or pick another model.`);
    if (outcome.code === null)
      throw new Error(`${this.row.name} took too long and was stopped. Ask again, or pick another model.`);
    const failed = failedResult(this.row, outcome.stdout);
    // What the program itself said failed decides: its error output also carries warnings about other things (one of
    // Codex's own MCP servers failing to refresh its OAuth token) that must never read as this sign-in failing.
    const evidence = failed ?? `${outcome.stderr}\n${outcome.code !== 0 ? outcome.stdout : ""}`;
    if ((outcome.code !== 0 || failed !== null) && (this.home || this.detectLimits) && limitWords.test(evidence))
      throw new ProgramLimitError(`${this.row.name} says this account has reached its plan limit.`);
    if (outcome.code !== 0 || failed !== null)
      throw new Error(programFailure(this.row, outcome.code, evidence, this.row.id === "codex" ? this.codexModel() : null, this.codexOffered()));
    const content = answerFrom(this.row, outcome.stdout);
    if (!content) throw new Error(`${this.row.name} answered with nothing at all.`);
    if (!streamed) request.onTextDelta?.(content); // streamed words were the preview already; the answer is `content`
    return { content, toolCalls: [] };
  }
  /**
   * trunks-use-subscriptions: Claude Code answering a Trunk runs with none of its own tools (`--tools ""`), so it
   * only writes words and cannot read past the Trunk's permissions; Branch's tools do the work under them.
   */
  private rowFor(request: Pick<CompletionRequest, "programTools">): CliAgentRow {
    // Not the owner's own work (a chat app's, another program's): no tools of its own either (CompletionRequest.programTools).
    if (this.row.id !== "claude-code" || (!currentAccountCall()?.trunk && request.programTools !== false)) return this.row;
    // With no tools the owner's hooks, MCP servers and skills have nothing to do, so they are not loaded (leanClaudeArgs).
    const lean = this.row.args.includes("stream-json") ? leanClaudeArgs : [];
    return { ...this.row, args: [...this.row.args, ...lean, "--tools", ""] };
  }
  /** Codex's chosen model, refused in plain words before the program starts when Codex cannot use it with a ChatGPT sign-in. */
  /**
   * One turn over Codex's app-server, its words streamed as they come. Null when this Codex has no app-server (it exits
   * before the handshake), which is remembered so later calls go straight to exec. Codex's own failure is said as exec's is.
   */
  private async viaAppServer(request: CompletionRequest, start: StartAppServer): Promise<Completion | null> {
    const model = this.codexModel();
    const base = { ...strippedEnvironment(), ...codexTransportEnvironment() };
    const env = this.home ? { ...base, [this.home.name]: this.home.path } : base;
    const thread = { model, ...(ownCodex(this.row) ? { cwd: codexWorkDir() } : {}), env, ...(this.home ? { home: this.home.path } : {}),
      ...(this.limits.firstOutputMs ? { silenceMs: this.limits.firstOutputMs } : {}) };
    try {
      return await warmCodexTurn(this.row.command, start, request, thread, this.limits.timeoutMs);
    } catch (error) {
      if ((error as { appServerUnavailable?: boolean }).appServerUnavailable) { noAppServer.add(this.row.command); return null; }
      const said = error instanceof Error ? error.message : String(error);
      if (/said nothing at all|is not on this computer|took too long|request was stopped/.test(said)) throw error;
      if ((this.home || this.detectLimits) && limitWords.test(said)) throw new ProgramLimitError(`${this.row.name} says this account has reached its plan limit.`);
      throw new Error(programFailure(this.row, 1, said, model, this.codexOffered()));
    }
  }
  private codexOffered(): readonly string[] { return this.codexModels?.offered() ?? codexVerified; }
  private codexModel(): string {
    const model = this.model ?? this.codexModels?.chosen() ?? codexDefaultModel;
    if (!this.codexOffered().includes(model))
      throw new Error(`${this.row.name} cannot use ${model} with a ChatGPT sign-in. Choose one it takes: ${this.codexOffered().join(", ")}.`);
    return model;
  }
  /** The model check (src/codex-models.ts): Codex's version, and one tiny call per model, read as accepted or refused. */
  probe(): CodexProbe {
    const at = this.row.args.findIndex((arg) => arg === "exec" || arg === "e"), limits = { timeoutMs: 90_000, maxOutputChars: 20_000 };
    const run = (row: CliAgentRow, prompt: string) => this.home
      ? this.spawnAgent(row, prompt, AbortSignal.timeout(limits.timeoutMs), limits, this.home)
      : this.spawnAgent(row, prompt, AbortSignal.timeout(limits.timeoutMs), limits);
    return {
      version: async () => {
        const said = await run({ ...this.row, args: [...this.row.args.slice(0, Math.max(at, 0)), "--version"] }, "");
        return said.code === 0 && !said.missing ? said.stdout.trim().slice(0, 200) || null : null;
      },
      tryModel: async (model: string): Promise<CodexTry> => {
        const row = { ...this.row, args: codexArgs(this.row.args, model, ownCodex(this.row) ? codexWorkDir() : null) };
        const said = await run(row, "Reply with the word OK.");
        const failed = failedResult(row, said.stdout);
        if (said.code === 0 && failed === null && answerFrom(row, said.stdout)) return "accepted";
        return modelRefusal.test(failed ?? said.stderr) ? "refused" : "unknown";
      },
    };
  }
  private withModel(row: CliAgentRow): CliAgentRow {
    return row.id === "codex" ? { ...row, args: codexArgs(row.args, this.codexModel(), ownCodex(this.row) ? codexWorkDir() : null) } : row;
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
/** --include-partial-messages: the answer's words and its thinking as they are written, one stream_event a line. */
export function streamJsonWords(line: string, onText: (text: string) => void, onThinking?: (text: string) => void): void {
  if (!line.startsWith("{\"type\":\"stream_event\"")) return;
  let event: { event?: { type?: unknown; delta?: { type?: unknown; text?: unknown; thinking?: unknown } }; parent_tool_use_id?: unknown };
  try { event = JSON.parse(line) as typeof event; } catch { return; }
  if (event.parent_tool_use_id || event.event?.type !== "content_block_delta") return; // a helper's words are not the answer
  const delta = event.event.delta;
  if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) onText(delta.text);
  else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) onThinking?.(delta.thinking);
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
  models: { register(preset: { id: string; name: string; provider: Provider; model: string; reasoning?: typeof claudeDefaultEffort }): void },
  input: unknown, limits: CliAgentLimits = {}, spawnAgent: SpawnAgent = runCliAgent,
): { id: string; name: string; note: string; terms: CliAgentRow["terms"] } {
  const row = rowFor(input);
  const id = `cli-${row.id}`;
  if (row.id === "claude-code") {
    // The default connection is Branch's default model and effort (Opus 5.5, medium); the others are the owner's choices.
    for (const model of claudeSubscriptionModels) models.register({ id: model.presetId,
      name: model.presetId === `cli-${row.id}` ? row.name : model.label, model: model.id,
      ...(model.id === claudeDefaultModel ? { reasoning: claudeDefaultEffort } : {}),
      provider: new CliAgentProvider({ ...row, args: [...row.args, "--model", model.id] }, limits, spawnAgent) });
  } else {
    const provider = new CliAgentProvider(row, limits, spawnAgent);
    // QA 2026-09-28: Codex answers with Branch's choice (Settings › Models), never whatever the owner's own Codex settings name.
    if (row.id === "codex") provider.codexModels = codexModelsFor(models);
    models.register({ id, name: row.name, provider, model: row.id === "codex" ? codexDefaultModel : row.command });
  }
  return { id, name: row.name, note: row.note, terms: row.terms };
}
