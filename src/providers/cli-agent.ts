import { spawn } from "node:child_process";
import { z } from "zod";
import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { refuseSignInForTrunk } from "../accounts/context.js"; // mac7/lockdown-fix
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
    args: ["-p", "--output-format", "json"], jsonField: "result",
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
  if (!row.jsonField) return text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const said = parsed[row.jsonField];
    if (typeof said === "string") return said.trim();
  } catch { /* a tool that did not print JSON this time still said something useful */ }
  return text;
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

export const runCliAgent: SpawnAgent = (row, prompt, signal, limits, home) =>
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
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < limits.maxOutputChars) stdout += chunk.toString("utf8");
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
  private readonly limits: Required<CliAgentLimits>;
  /** mac6/accounts: say plainly when the program reports a plan limit (set for accounts in a list). */
  detectLimits = false;
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
    const outcome = this.home
      ? await this.spawnAgent(this.row, agentPromptFrom(request), request.signal, this.limits, this.home)
      : await this.spawnAgent(this.row, agentPromptFrom(request), request.signal, this.limits);
    if (outcome.missing)
      throw new Error(`"${this.row.command}" is not on this computer, so Branch cannot use ${this.row.name}. Install it, or pick another model.`);
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
  /** It publishes no list of models of its own: the tool decides what it is using. */
  modelsList(): null { return null; }
}

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
  models.register({ id, name: row.name, provider: new CliAgentProvider(row, limits, spawnAgent), model: row.command });
  return { id, name: row.name, note: row.note, terms: row.terms };
}
