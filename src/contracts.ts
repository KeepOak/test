import { z } from "zod";
import { errorText } from "./request-errors.js";
import type { SandboxChoice, WallContext } from "./sandbox.js";
import type { SandboxBackendName } from "./sandbox-backends.js";

export const ToolCallSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(100),
    arguments: z.string().max(65536),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;
/** A picture shown to the model, such as a screenshot of a web page. Base64, under the size cap. */
export interface MessageImage {
  mediaType: string;
  /** A short label such as the file name, when there is one. */
  name?: string | undefined;
  /** Base64 bytes; never written to the conversation store, so it is not replayed later. */
  data: string;
}
/** The most a single picture may weigh once encoded, so one screenshot cannot fill a request. */
export const maxImageBytes = 4 * 1024 * 1024;
/** Pictures a model can be asked to look at. Kept for one request only and never written down. */
export const maximumImageBytes = 5 * 1024 * 1024;
export const maximumImagesPerTurn = 4;
export const ImagePartSchema = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  /** The picture's bytes, base64 encoded; a data: prefix is accepted and stripped. */
  data: z.string().min(1).max(Math.ceil(maximumImageBytes / 3) * 4 + 1024),
  name: z.string().trim().max(200).optional(),
}).strict();
export type ImagePart = z.infer<typeof ImagePartSchema>;
/** Checks the pictures attached to a turn: how many there are, and how big each one really is. */
export function parseImages(input: unknown): ImagePart[] {
  const parts = z.array(ImagePartSchema).max(maximumImagesPerTurn).parse(input);
  return parts.map((part) => {
    const data = part.data.replace(/^data:[^,]*,/, "");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) throw new Error("That picture came through empty");
    if (bytes.length > maximumImageBytes) throw new Error(`Pictures up to ${maximumImageBytes / 1048576} MB can be attached`);
    return { ...part, data };
  });
}
/**
 * A media type as it is actually written: two tokens and optional parameters, nothing else. This ends
 * up in a `content-type` header, so a control character or a stray newline in it must be refused here
 * rather than turning header writing into a server error later.
 */
export const mediaTypeToken = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:\s*;\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/,
    "Give the file's kind as a plain media type, such as image/png");
/** The kinds of file a person can attach to a message. */
export const attachmentKinds = ["picture", "sound", "video", "document", "file"] as const;
export type AttachmentKind = (typeof attachmentKinds)[number];
/** The largest any one attachment may be, whatever its kind; each kind's own limit is lower. */
export const maxAttachmentBytes = 32 * 1024 * 1024;
/**
 * Everything attached to one message, added up once decoded. One budget for the turn rather than six
 * times the largest file: the point is what a single request may carry, not how it is divided.
 */
export const maxAttachmentsBytesPerTurn = 32 * 1024 * 1024;
export const maximumAttachmentsPerTurn = 6;
/**
 * How much JSON `/api/run` will read: room for one full turn of attachments once base64 has made them
 * a third larger, plus the message itself. Without this the ordinary 64 KiB ceiling refuses anything
 * bigger than a small picture, and every limit above it is decoration.
 */
export const runBodyLimit = Math.ceil(maxAttachmentsBytesPerTurn / 3) * 4 + 128 * 1024;
/**
 * A file sent ahead of its message (POST /api/attachments/upload) is streamed to disk as it arrives, never
 * held whole in memory, so it can be far larger than one that rides inside the message as base64.
 */
export const maximumUploadBytes = 2 * 1024 * 1024 * 1024;
/** How many files sent ahead can go with one message, and what they may add up to. */
export const maximumUploadsPerTurn = 20;
export const maxUploadsBytesPerTurn = 4 * 1024 * 1024 * 1024;
/** The name a file sent ahead is known by until its message takes it: 24 plain hex characters. */
export const UploadIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
/**
 * What a message keeps about a file that was attached to it. The bytes are kept beside the private
 * database, not here, so a conversation can be read back cheaply and still say what it was given.
 */
export const AttachmentRefSchema = z.object({
  /** Names the file inside its conversation's folder; the only thing a page ever sends back. */
  id: z.string().regex(/^[a-f0-9]{16}$/),
  kind: z.enum(attachmentKinds),
  /** The file's own type, kept as it arrived, and always a real media type. */
  mediaType: mediaTypeToken,
  /** What the person calls it, for reading; never used as a path. */
  name: z.string().trim().min(1).max(200),
  bytes: z.number().int().nonnegative(),
}).strict();
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
/** What the page sends when a file is attached. */
export const AttachmentInputSchema = z.object({
  mediaType: mediaTypeToken,
  name: z.string().trim().min(1).max(200),
  /** The file's bytes, base64 encoded; a data: prefix is accepted and stripped. */
  data: z.string().min(1).max(Math.ceil(maxAttachmentBytes / 3) * 4 + 1024),
}).strict();
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /**
   * Q206: written by Branch itself (a nudge to the model after an empty reply, or a failed check), not by the owner.
   * It goes to the model as a user turn like any other, but the conversation never shows it as the owner's words.
   */
  from?: "branch";
  /** Pictures that travel with this message; only user messages carry them. */
  images?: MessageImage[];
  /**
   * Files attached to this message, as references to the kept originals. Unlike a picture's bytes,
   * these are written down with the conversation, so it can still show what it was given.
   */
  attachments?: AttachmentRef[];
  /**
   * A message the engine wrote itself rather than the person: "trunk-intro" is the ask that has a new
   * Trunk introduce itself in its own conversation, which the window does not draw as the owner's words.
   */
  system?: "trunk-intro";
  /**
   * chatlook: in a room's own conversation, the household person who wrote this message (the owner's carry none), so
   * the room still shows who said it once its record has let older events go.
   */
  person?: { id: string; name: string };
  /**
   * a2a-rooms: in a room's own conversation, Branch's note quoting what an outside agent said (`from: "branch"`, its words
   * as quoted data), so the room can still draw it as that agent's once its record has let older events go.
   */
  outsideAgent?: { id: string; name: string };
}
export interface Usage {
  input: number;
  output: number;
  /** Input tokens the provider served from its own prompt cache, when it reports them. Part of `input`. */
  cachedInput?: number | undefined;
  /** Input tokens written to the provider's prompt cache (Anthropic's cache_creation_input_tokens). Part of `input`. */
  cacheWrite?: number | undefined;
  /** Of `cacheWrite`, the tokens written to the one-hour cache, when the provider says (charged at its own rate). */
  cacheWrite1h?: number | undefined;
}
export const UsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
  cacheWrite1h: z.number().int().nonnegative().optional(),
});
export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CompletionRequest {
  messages: Message[];
  tools: ToolDescription[];
  signal: AbortSignal;
  maxTokens: number;
  /** Requested reasoning effort; adapters map it to their own parameter or ignore it. */
  reasoning?: "low" | "medium" | "high";
  /** R17-S12: a faster or cheaper service tier, where the service offers one; absent asks for the usual. */
  serviceTier?: "priority" | "flex";
  /** R17-046: OpenRouter's company preferences; only a connection whose address is openrouter.ai sends them. */
  providerRouting?: import("./model-savings/openrouter.js").OpenRouterRouting;
  /** Live provider text only; partial text is not a committed completion. */
  onTextDelta?: (text: string) => void;
  /**
   * mac7/empty-completion: live *thinking* from a reasoning model, which arrives in a field of its
   * own (`reasoning_content`, `reasoning`, `thinking`) rather than in the answer. It is not the
   * answer and never reaches the page, but a model that is visibly thinking is a model that is
   * working, so whatever watches for silence needs to hear it.
   */
  onReasoningDelta?: (text: string) => void;
  /**
   * Live steps: a program that does its own work (Claude Code, src/providers/cli-agent.ts) says each step it takes as it
   * takes it: a tool starting (`done` absent) and the same `id` finishing. Branch shows these on the task's live step
   * list; they are the program's own tools, never Branch's, and nothing is run because of them.
   */
  onToolActivity?: (step: ProgramStep) => void;
  /**
   * The exact shape the reply must take. An adapter with a setting of its own for this uses it;
   * one without simply ignores the field, and whatever asked falls back to saying so in the words
   * of the question and checking the reply afterwards. See src/answer-shape.ts.
   */
  responseFormat?: { name: string; schema: Record<string, unknown> };
  /**
   * False when the task is not the owner's own (a chat app's, another program's, a schedule's): an installed program
   * answering as a model (src/providers/cli-agent.ts) then gets none of its own tools, so it cannot do past Branch's
   * permissions what Branch's own tools may not. Absent means the program keeps its tools.
   */
  programTools?: boolean;
}
export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage | undefined;
  /**
   * mac7/empty-completion: how many characters of thinking the model produced that are not part of
   * the answer. Kept so a round that thought and said nothing can be told apart from one that was
   * never answered at all; the thinking itself is not kept.
   */
  reasoningChars?: number | undefined;
}
/** Usage observed before a provider stream failed; content remains uncommitted. */
export class ProviderStreamError extends Error {
  override name = "ProviderStreamError";
  constructor(
    cause: unknown,
    readonly estimatedOutput: number,
    readonly usage?: Usage,
  ) {
    super(errorText(cause), { cause });
  }
}
export interface Provider {
  readonly name: string;
  /** True when this model can be shown a picture; otherwise the text snapshot is used instead. */
  readonly acceptsImages?: boolean;
  /**
   * True for a program on this computer that keeps its own time limit and may print nothing for minutes while one of
   * its steps runs (src/providers/cli-agent.ts): the runtime's silence watchdog is not put on it.
   */
  readonly keepsOwnTime?: boolean;
  /** The model this connection asks for, when it names one; a preset made from the connection alone takes this name. */
  readonly model?: string;
  complete(request: CompletionRequest): Promise<Completion>;
  /**
   * How many tokens of conversation this connection really holds, when it can say (a model on this computer, whose room
   * Branch sets). The task's context budget is kept under it, so nothing is cut off out of sight.
   */
  contextTokens?(): Promise<number | null>;
  /** Optional audio endpoints (OpenAI-compatible transcription and speech); null if unavailable. */
  audio?(): { endpoint: string; apiKey: string } | null;
  /** Whether this connection can be shown a picture; absent means it cannot. */
  supportsImages?(): boolean;
  /**
   * Where this connection lists its models, when it offers a list. Adapters whose address does not
   * follow the OpenAI pattern say so here rather than having it guessed from their other routes.
   */
  modelsList?(): { url: string; headers: Record<string, string> } | null;
  /**
   * Sending many questions at once and collecting the answers later, where the service offers it
   * (OpenAI and Anthropic both do, at about half price). A connection that does not offer it simply
   * leaves this out, and whatever asked falls back to one ordinary call per question. See
   * src/batch-inference.ts.
   */
  batch?(): BatchApi | null;
}
/** What a service that takes many questions at once must be able to do. */
export interface BatchApi {
  /** Hands the whole set over and gives back the service's own id for it. */
  submit(requests: BatchRequest[], signal: AbortSignal): Promise<{ batchId: string }>;
  /** Where the set has got to; `completed` means the answers can be collected. */
  poll(batchId: string, signal: AbortSignal): Promise<{ status: "working" | "completed" | "failed"; error?: string }>;
  /** The answers, each carrying back the id it was sent with. */
  collect(batchId: string, signal: AbortSignal): Promise<BatchAnswer[]>;
}
export interface BatchRequest {
  /** The caller's own id for this question, handed straight back with the answer. */
  id: string;
  messages: Message[];
  maxTokens: number;
}
export interface BatchAnswer {
  id: string;
  content: string;
  usage?: Usage;
  error?: string;
}
export const CompletionSchema = z.object({
  content: z.string().max(65536),
  toolCalls: z.array(ToolCallSchema).max(16),
  usage: UsageSchema.optional(),
  reasoningChars: z.number().int().nonnegative().optional(),
});
export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded"
  | "needs_input"
  | "interrupted";
export interface Run {
  id: string;
  sessionId: string;
  owner: string;
  prompt: string;
  status: RunStatus;
  output: string;
  createdAt: string;
  updatedAt: string;
  /** The project this task was done under, so what it cost can be counted against that project. */
  project?: string;
}
/** Live steps: one step a program working on its own reported (see CompletionRequest.onToolActivity). */
export interface ProgramStep { id: string; name: string; label: string; input?: string; done?: boolean; error?: string; output?: string }
export interface Event {
  id: number;
  runId: string;
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
}
/** A task's step and token limits. `Infinity` is "no limit" (the owner's choice, or auto on a connection that is not billed). */
export interface BudgetLimits {
  maxSteps: number;
  maxTokens: number;
}
export interface BudgetOptions extends BudgetLimits {
  /**
   * The limits that hold while a connection billed per token (an API key) answers. The owner's "auto" is no limit on a
   * sign-in or a model on this computer, which cost nothing more per token, and these finite figures on a key, which
   * does; they count only the steps and tokens spent while such a connection answered.
   */
  billed?: BudgetLimits;
}
export class BudgetError extends Error {
  override name = "BudgetError";
}
/** Raised by the user.ask tool: the task stops and waits for the person's answer. */
export class NeedsInputError extends Error {
  override name = "NeedsInputError";
  /** The tool call that asked, when a tool asked; a question from anywhere else (a stuck model, a plan to approve) has none. */
  callId?: string;
  /** Dogfood B21: the assistant's own question (user.ask), which belongs in the conversation as its message. */
  spoken?: boolean;
  constructor(readonly question: string) { super(question); }
}
const validLimit = (value: number): boolean => value === Infinity || (Number.isInteger(value) && value >= 1);
export class Budget {
  steps = 0;
  tokens = 0;
  /** Steps and tokens spent while a connection billed per token answered (see BudgetOptions.billed). */
  billedSteps = 0;
  billedTokens = 0;
  private billedNow = false;
  constructor(
    // The whole prompt (tool catalog included) is charged every round, so a task with several tool
    // calls needs room; the per-run and delegated budgets can still be set lower.
    private readonly options: BudgetOptions = { maxSteps: 60, maxTokens: 200000 },
  ) {
    const all = [options, ...(options.billed ? [options.billed] : [])];
    if (!all.every((limits) => validLimit(limits.maxSteps) && validLimit(limits.maxTokens)))
      throw new Error("Invalid budget");
  }
  /** The limits in force now: the billed ones too while a billed connection answers. */
  get limits(): BudgetLimits {
    const billed = this.billedNow ? this.options.billed : undefined;
    if (!billed) return { maxSteps: this.options.maxSteps, maxTokens: this.options.maxTokens };
    return {
      maxSteps: Math.min(this.options.maxSteps, this.steps + billed.maxSteps - this.billedSteps),
      maxTokens: Math.min(this.options.maxTokens, this.tokens + billed.maxTokens - this.billedTokens),
    };
  }
  /** Says whether the connection answering the next request is billed per token, before it is stepped or charged. */
  answeredBy(billed: boolean): void {
    this.billedNow = billed;
  }
  step(signal: AbortSignal): void {
    signal.throwIfAborted();
    const limit = this.limits.maxSteps;
    this.steps++;
    if (this.billedNow) this.billedSteps++;
    if (this.steps > limit)
      throw new BudgetError("Step budget exhausted");
  }
  charge(tokens: number): void {
    const limit = this.limits.maxTokens;
    this.tokens += tokens;
    if (this.billedNow) this.billedTokens += tokens;
    if (this.tokens > limit)
      throw new BudgetError("Token budget exhausted");
  }
  remaining(): number {
    return Math.max(0, this.limits.maxTokens - this.tokens);
  }
  /**
   * One of `parts` equal shares of what is left, for work handed to several helpers at once; `steps` fixes each share's
   * steps instead. No limit stays no limit, and the billed limits are shared the same way.
   */
  share(parts: number, steps?: number): BudgetOptions {
    const part = (left: number, least: number): number => left === Infinity ? Infinity : Math.max(least, Math.floor(left / parts));
    const billed = this.options.billed;
    return {
      maxSteps: steps ?? part(this.options.maxSteps - this.steps, 2),
      maxTokens: part(this.options.maxTokens - this.tokens, 1),
      ...(billed ? { billed: { maxSteps: steps ?? part(billed.maxSteps - this.billedSteps, 2), maxTokens: part(billed.maxTokens - this.billedTokens, 1) } } : {}),
    };
  }
}
export interface ToolContext {
  owner: string;
  workspace: string;
  runId: string;
  signal: AbortSignal;
  budget: Budget;
  permissions: ReadonlySet<string>;
  depth: number;
  /** workbench (SELF-302): this helper's lead asked for it to work in its own copy of the project (a git worktree). */
  ownCopy?: boolean;
  /** helper-lifecycle: this helper's lead let it hand work on (start helpers of its own); src/helper-tree.ts. */
  delegates?: boolean;
  /** Set for delegated specialists: memory reads are limited to shared facts and this agent's own. */
  agent?: string;
  /** FQ-routing.isolated-agents: the Trunk this work is for, set on a Trunk's turn and carried through every
   *  delegation, so a specialist it hands work to remembers under that Trunk (`memoryAgent`). */
  trunk?: string;
  /** Q109: set by the self-development guard for a push from Branch's source: the ref it walked and the one
   *  commit it walked there, which the push sends exactly (`<commit>:<ref>`). */
  sendsRef?: string;
  sendsCommit?: string;
  /** The task whose shared scratch area this run and all of its sub-tasks read and write. */
  scratchRoot?: string;
  /** Practice run: tools that would change something report what they would have done instead. */
  dryRun?: boolean;
  /**
   * Q12: set only by the self-development contract check (src/self-development-contract.ts) for a
   * command it let run while Branch's own source is checked out: the one folder the command may
   * write to. The shell runs it behind the OS sandbox with writes held to this folder, or refuses.
   */
  writesConfinedTo?: string;
  /**
   * selfdev: set only by the runtime, for a command in the owner's selected Full Access (src/runtime.ts
   * `ownerFullAccessFor`): a command held to the self-development worktree may then reach the network (npm
   * install, downloads) while its writes stay held to that folder. Never set for anyone else.
   */
  ownerFullAccess?: boolean;
  /**
   * mac7/eval-honesty: a question asked in isolation — a grader marking work Branch itself did.
   * Nothing the owner has remembered, written down, installed or asked for standing reaches it, and
   * nothing it does is learned from. See `RunOptions.isolated`.
   */
  isolated?: boolean;
  /** Who started this task; anything but the owner is held to the "Ask before changes" policy. */
  source?: "owner" | "trigger" | "schedule" | "mcp" | "a2a" | "acp" | "channel";
  /**
   * Where answers already given are remembered when there is no conversation to remember them
   * against: a saved workflow uses its own name here, so a yes given to one of its steps still
   * counts when that step is tried again.
   */
  approvalKey?: string;
  /**
   * mac7/coding-next: set on a model's own tool call in a task, where a tool may stop to ask the
   * person (ApprovalRequiredError) and the question is put in the conversation. A tool run by hand
   * has nowhere to put one, so a tool that would ask answers there as it did before.
   */
  askable?: boolean;
  /**
   * Q250: a step Branch runs as it was saved or asked for, not a model's own call: a verified recipe's
   * step, or a manual action (a workflow's or flow's step, a button in the window). Its arguments were
   * fixed before it ran, and a manual action is a task of its own, so nothing it could read first would
   * count. The read-before-edit guard (src/coding/read-first.ts) does not hold it.
   */
  readFirstExempt?: boolean;
  /**
   * mac7/tests-unattended: nobody can answer a question while this task runs — a script's
   * `branch run` or `branch headless` with no terminal to ask in. Only the "Let Branch run this
   * project's tests?" question reads it: the tests are skipped and the task carries on, instead of
   * the task ending on a question nobody will see. Every other question still stops the task.
   */
  unattended?: boolean;
  /**
   * mac7/tests-unattended: `branch run --allow-tests`. The project's tests may run in this one task,
   * as if the owner had answered Once each time; nothing is saved. Honoured only for the owner's own
   * task (src/coding/project-tests.ts), and never under Lockdown.
   */
  allowProjectTests?: boolean;
  /**
   * How tightly a program this call starts is to be held, when an approval rule said so. It is set
   * by the runtime just before the tool runs; a tool no rule says anything about never sees it and
   * behaves exactly as it did before rules could say.
   */
  sandbox?: SandboxChoice;
  /**
   * Where a program this call starts is to run, when an approval rule named somewhere other than
   * this computer, and which folders of the workspace it may see there. Both are set by the
   * runtime just before the tool runs, exactly as `sandbox` is.
   */
  sandboxBackend?: SandboxBackendName;
  sandboxPaths?: readonly string[];
  /**
   * Wave mac3 (os-sandbox): the wall a program this call starts goes behind (macOS's own sandbox or
   * bubblewrap), set by the runtime from the owner's settings. Never set from a tool's arguments.
   */
  osSandbox?: WallContext;
  /**
   * mac7/lockdown-fix: set on a Trunk's turn (and carried into its sub-tasks and side jobs): the keys
   * it may use. A sign-in account never answers for it (src/accounts/trunk-guard.ts).
   */
  trunkKeys?: { copyFromOwner: boolean; accounts: Record<string, string>; next?: Record<string, string[]> | undefined };
}
export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<T>;
  inputSchema?: Record<string, unknown>;
  /** The toolbox this tool belongs to; worked out from its name when it does not say. */
  group?: string;
  /** From a connected server, a plugin or a skill package: its description is somebody else's text. */
  external?: boolean;
  /** Where it came from ("plugin:<id>"; a server's tools are known by their names), for the owner's context modes. */
  source?: string;
  /**
   * Dogfood follow-up: true when the tool reaches the owner's own screen, keyboard, mouse or clipboard, whatever it is
   * called, so it gets the screen guard (src/screen-guard.ts). A tool from outside is also read by `describesScreen`.
   */
  screen?: boolean;
  permission: string;
  /**
   * Q59: "outbound" when the tool sends a request over the network or acts on a web page or another
   * program's window, "local" when it does not. Left out, its permission decides (src/tool-reach.ts);
   * a tool whose permission does not say enough declares it here.
   */
  reach?: "local" | "outbound";
  /**
   * selfdev (SELF-022): a tool that mostly waits, each of its own steps bounded, may run this long in one call even past
   * the owner's tool time limit: github.wait_for_checks (it only looks), so a long CI run or merge queue is waited on in
   * a few calls rather than dozens the loop guard would refuse, and branch.finish_source_change, whose independent
   * review and ready-then-merge must not be cut off half-way. The task can still be stopped at any moment.
   */
  waitsUpToMs?: number;
  execute: (args: T, context: ToolContext) => Promise<unknown>;
  /** What this call would touch, for the approval policy, when the arguments alone do not say. */
  target?: (args: T, context: ToolContext) => string | null;
  /**
   * mac7/residuals: the command line a tool that starts a program really runs (`process.start`: the
   * program the owner listed under a short name, its listed arguments, then the call's), so command
   * rules judge it like a shell command. Null when it cannot say; the target is judged as before.
   */
  command?: (args: T) => string | null;
  /**
   * mac7/multi-target: every file, folder or address a call touches, when it touches more than one
   * (a patch, two documents compared, a list of sources) or when its one path is not where the rules
   * look (a repository `folder`). Each is judged by the rules on its own and the call goes ahead only
   * when every one is allowed. Throws when they cannot be worked out, and the call is then refused.
   */
  targets?: (args: T, context: ToolContext) => ToolTarget[];
}
/** mac7/multi-target: one thing a call touches, and whether it only reads it, changes it or deletes it. */
export interface ToolTarget {
  kind: "read" | "write" | "delete";
  /** A workspace path, as the tool will use it. */
  path?: string;
  /** A web address. */
  url?: string;
  /**
   * Integration (multi-target): the call reaches everything inside this folder (a repository's whole
   * working copy, a folder a knowledge base reads), so a rule about a folder inside it counts too.
   */
  folder?: boolean;
}
/**
 * attach-followups: a message is words, files, or both. With no words it must carry a file (sent ahead, attached, or a
 * picture); with neither it is refused in the same words an empty message always was ("prompt" cannot be empty).
 */
function wordsOrFiles(input: { prompt: string; files: boolean }, ctx: z.RefinementCtx): void {
  if (input.prompt || input.files) return;
  ctx.addIssue({ code: "too_small", origin: "string", minimum: 1, inclusive: true, path: ["prompt"],
    message: "Too small: expected string to have >=1 characters", input: input.prompt });
}
/** The runtime's own check of a message it is about to start (src/runtime.ts prepareRun): its words, or its files. */
export const RunWordsSchema = z.object({
  prompt: z.string().trim().max(16000),
  sessionId: z.string().uuid().optional(),
  files: z.boolean(),
}).superRefine(wordsOrFiles);
export const RunInputSchema = z
  .object({
    prompt: z.string().trim().max(16000),
    sessionId: z.string().uuid().optional(),
    /** Start a conversation that is never searchable and is discarded when closed. */
    temporary: z.boolean().optional(),
    /** Conditions the final answer must meet (phrases, a pattern, a JSON shape, files that must exist). */
    checks: z.record(z.string(), z.unknown()).optional(),
    /** Practice run: nothing is really changed, and the report lists what would have happened. */
    dryRun: z.boolean().optional(),
    /** Pictures to show the model with this message; text-only models say so plainly. */
    images: z.array(ImagePartSchema).max(maximumImagesPerTurn).optional(),
    /** Files attached to this message: the originals are kept and the message keeps their references. */
    attachments: z.array(AttachmentInputSchema).max(maximumAttachmentsPerTurn).optional(),
    /** Files already sent ahead (POST /api/attachments/upload), named by the id each upload answered. */
    uploads: z.array(UploadIdSchema).max(maximumUploadsPerTurn).optional(),
    /** Ask for a short plan first and work through it step by step. */
    plan: z.boolean().optional(),
    /** Have a reviewer check the finished answer before it is given. */
    verify: z.boolean().optional(),
    /** Redesign phase 1: how much it may do in a conversation this message starts (src/conversation-mode.ts). */
    mode: z.enum(["ask", "plan", "auto", "full"]).optional(),
    /** Dogfood B26: how hard a conversation this message starts thinks (its own level, kept with it; src/models.ts). */
    reasoning: z.enum(["low", "medium", "high"]).optional(),
    /** QA retest 2026-09-28 (m10): the model a conversation this message starts answers with (its own, kept with it). */
    preset: z.string().min(1).max(64).optional(),
    /** Dogfood D14: the project a conversation this message starts is filed under (a project's id); absent, the active one. */
    project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Project ids use lowercase letters, digits and dashes").optional(),
  })
  .strict()
  .superRefine((input, ctx) => wordsOrFiles({ prompt: input.prompt,
    files: !!(input.uploads?.length || input.attachments?.length || input.images?.length) }, ctx));
/** The same message without its pictures, for storing and for measuring how full the context is. */
export function textOnly(message: Message): Message {
  if (!message.images?.length) return message;
  const { images: _images, ...rest } = message;
  return rest;
}
/* Words for any failure; a validation failure reads as plain sentences (request-errors.ts), never as Zod's dump. */
export { errorText } from "./request-errors.js";
export const estimateTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value).length / 4);
