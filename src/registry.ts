import { z } from "zod";
import type {
  ToolContext,
  ToolDefinition,
  ToolDescription,
  ToolTarget,
} from "./contracts.js";
import { policyTarget } from "./policy.js";
import { isCommandTool } from "./policy-resources.js";
import { resourceOf, type PolicyResource } from "./policy-resources.js";
import { inferToolGroup, slimTool } from "./catalog.js";
import { underTask } from "./task-scope.js"; // household-followups
import { reachOf, type ToolReach } from "./tool-reach.js"; // Q59

/** Tools `policyTarget` reads a target for by name rather than from a `url` or `path`. */
const targetedByName: ReadonlySet<string> = new Set(["shell.execute", "shell.session.run", "shell.session.open"]);
/**
 * Tools that genuinely touch nothing the rules judge, though an argument's name suggests a place. Each
 * costs a sentence saying why. tests/tool-targets.test.mjs holds every other such tool to declaring a
 * target; Q76 lets only these, and tools that take no arguments at all, keep "Yes, always" on no target.
 */
export const targetlessTools: Readonly<Record<string, string>> = {
  "history.meaning": "`from` and `to` are dates bounding a search of conversations already kept, not places.",
  "learning.journey": "`from` and `to` are dates bounding a timeline, not places.",
  "memory.find": "`from` and `to` are dates bounding a search of facts already kept, not places.",
  "memory.put": "`source` is where a fact came from, written for a person to read; `project` is a name, not a folder.",
  "memory.update": "`source` is where a fact came from, written for a person to read, not a place to read from.",
  "projects.notes": "`project` is a project's name. The project's folder is judged when something opens it.",
  "labels.add": "`target` is a kind — conversation, procedure or document — beside `targetId`. Neither is a path.",
  "labels.list": "`target` is a kind, not a path.",
  "labels.remove": "`target` is a kind, not a path.",
  "knowledge.search": "`filter.files` narrows results inside a knowledge base already built; nothing is read from disk.",
  "context.read": "`file` is one of eight fixed instruction files by name, not a path the caller chooses.",
  "procedures.propose": "Proposing only saves the recipe. `preconditions[].path` is read later, by files.verify, when the recipe is verified or replayed.",
  "specialists.propose": "Proposing only saves the specialist. `evaluation.checks[].path` is read later, by files.verify, when it is evaluated.",
  "specialists.delegate": "`checks.files` is what the specialist's answer must account for. Every tool the specialist itself runs is judged on its own, with fewer permissions.",
  // Ships-on sweep (2026-09-26): these now ship listed, so the target guard reads them on a fresh install.
  "gcal.events": "`from` and `to` are times bounding a read of the owner's own calendar, not places.",
  "outlook.events": "`from` and `to` are times bounding a read of the owner's own calendar, not places.",
  "notebook.read": "`from` and `to` are cell numbers. The notebook itself is `path`, which the rules read as they do for files.read.",
  "project.board": "`project` is a project's name. The project's folder is judged when something opens it.",
  "answer.page": "`sources[].url` are the addresses an answer cites, written into the page for a person to read; nothing is fetched.",
};
/**
 * Q76: a target a kept rule would read as a pattern, so a standing yes on it would cover far more than
 * this call. Rules match with `*` only (`?` and `[` are literal), even when written %2A. A command
 * tool keeps a starred command as one exact command (policy.ts standingRule), so for those only a
 * bare `*` is a pattern; remote.run's computer part stays a pattern, so any `*` there is one.
 */
export const patternTarget = (target: string, tool = ""): boolean => {
  let read = target;
  try { read = decodeURIComponent(target); } catch { /* not encoded: judged as written */ }
  if (tool === "remote.run") {
    // "computer: command": standingRule keeps the computer part as a pattern, and the command as above.
    const at = read.indexOf(": ");
    return (at < 0 ? read : read.slice(0, at)).includes("*") || (at >= 0 && read.slice(at + 2).trim() === "*");
  }
  if (isCommandTool(tool)) return read.trim() === "*";
  return read.includes("*");
};
/** Q76: a JSON schema that accepts only `{}`: nothing listed, nothing else allowed, nothing composed. */
function closedEmptySchema(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || schema.type !== "object" || schema.additionalProperties !== false) return false;
  const opens = ["patternProperties", "anyOf", "oneOf", "allOf", "$ref", "if", "dependentSchemas", "unevaluatedProperties"];
  return Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {}).length === 0 && !opens.some((key) => key in schema);
}
/** Q76: a target of only spaces or invisible characters (a zero-width space, a joiner) names nothing. */
export const blankTarget = (target: string): boolean => !target.replace(/[\p{Cf}\s]/gu, "");

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  private readonly runFinished = new Set<(context: ToolContext) => Promise<void>>();
  /**
   * Integration (hardening-3): the folder of the workspace a tool's paths are read inside right now
   * (the active project's folder or a task's working copy; "" for the workspace itself). Set once at
   * start-up to the same answer the file tools use.
   */
  pathScope: () => string = () => "";
  onRunFinished(listener: (context: ToolContext) => Promise<void>): void {
    this.runFinished.add(listener);
  }
  async finishRun(context: ToolContext): Promise<void> {
    const results = await Promise.allSettled([...this.runFinished].map(listener =>
      Promise.resolve().then(() => listener(context))));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Run cleanup failed");
  }
  private revision = 0;
  /**
   * Goes up whenever a tool is added or removed, so a task that is already running notices that a
   * server has connected and puts its tools in the index without rebuilding everything each round.
   */
  get version(): number {
    return this.revision;
  }
  private readonly toolsChanged = new Set<() => void>();
  /**
   * Told whenever the set of tools changes — a skill, a plugin or an MCP server's tools arriving or
   * going away. Another AI tool connected over MCP is told so its own list stays right.
   */
  onToolsChanged(listener: () => void): () => void {
    this.toolsChanged.add(listener);
    return () => void this.toolsChanged.delete(listener);
  }
  private announceChange(): void {
    for (const listener of this.toolsChanged)
      try { listener(); } catch { /* telling someone must never break registration */ }
  }
  register<T>(tool: ToolDefinition<T>): void {
    if (
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(tool.name) ||
      this.tools.has(tool.name)
    )
      throw new Error("Invalid or duplicate tool name");
    this.tools.set(tool.name, tool as ToolDefinition);
    this.revision++;
    this.announceChange();
  }
  /**
   * The catalog as the model sees it: only the tools this run may use, each put on the schema diet
   * so the one part of the context that is charged every round stays small.
   */
  descriptions(permissions: ReadonlySet<string>, options: { diet?: boolean } = {}): ToolDescription[] {
    return [...this.tools.values()]
      .filter((t) => permissions.has(t.permission))
      .map((t) => {
        const described: ToolDescription = {
          name: t.name,
          description: t.description,
          parameters: wireSafePatterns(t.inputSchema ?? (z.toJSONSchema(t.parameters) as Record<string, unknown>)),
        };
        return options.diet === false ? described : slimTool(described);
      });
  }
  /** Whether a tool came from outside, so its description is read as untrusted text. */
  isExternal(name: string): boolean {
    return this.tools.get(name)?.external === true;
  }
  /** The toolbox a tool belongs to: its own answer, or one worked out from its name. */
  groupOf(name: string): string {
    return this.tools.get(name)?.group ?? inferToolGroup(name);
  }
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) { this.revision++; this.announceChange(); }
    return removed;
  }
  /** Alias for unregister, used by tests. */
  remove(name: string): boolean {
    return this.unregister(name);
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  /**
   * Whether a tool says for itself what a call would touch. `files.read_many` said neither, so the
   * owner's folder rules judged it with an empty target and let through a file the same rules
   * refused to `files.read`. `tests/tool-targets.test.mjs` uses this to insist that every tool whose
   * arguments can name a file, a folder, a site, an account, a device or a person says so.
   */
  declaresTarget(name: string): { target: boolean; targets: boolean } {
    const tool = this.tools.get(name);
    return { target: typeof tool?.target === "function", targets: typeof tool?.targets === "function" };
  }
  /**
   * Q76: whether a call gets no standing yes. A target that is itself a pattern never does: the rule
   * would cover everything. A call with no target keeps one only when its tool takes no arguments at
   * all, or is on `targetlessTools`; any other tool (a plugin's, an outside server's, one whose
   * arguments cannot be read) could have named where it reaches, so a rule on "*" would cover it all.
   */
  noStandingTarget(name: string, target: string): boolean {
    if (patternTarget(target, name)) return true;
    if (!blankTarget(target)) return false;
    const tool = this.tools.get(name);
    if (!tool || tool.target || tool.targets || targetedByName.has(name)) return true;
    const shape = (tool.parameters as { shape?: Record<string, unknown> }).shape;
    if (shape && Object.keys(shape).length === 0) return false;
    // An outside server's tool takes nothing only when its JSON schema closes every door: an object
    // with no properties and no others allowed. Anything else can carry a recipient under any name.
    // A lent tool's schema is only the lender's word: nothing checks a call against it (MCP's Ajv does).
    if (!shape && tool.group !== "client" && closedEmptySchema(tool.inputSchema)) return false;
    return !Object.hasOwn(targetlessTools, name);
  }
  /** Every registered tool with its permission, for the capability inventory. */
  inventory(): { name: string; permission: string; description: string }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, permission: t.permission, description: t.description }));
  }
  /** The permission a tool needs, or "" when no such tool is registered. */
  permissionOf(name: string): string {
    return this.tools.get(name)?.permission ?? "";
  }
  /**
   * What a call would touch, for the approval policy: the tool's own answer, or one read from the
   * arguments. hardening-3: read from the arguments the tool will really run with (`runArgs`), so a
   * name the tool maps (`file_path` for `path`) or a space it trims cannot walk past a rule.
   */
  targetOf(name: string, args: unknown, context: ToolContext): string {
    const seen = this.runArgs(name, args);
    const own = this.tools.get(name)?.target?.(seen, context);
    return (own ?? policyTarget(name, seen)) || "";
  }
  /**
   * mac7/multi-target: every thing a call touches, for a tool that names more than one (or names its
   * one where the rules do not look), read from the arguments it will run with; null for a tool that
   * does not say, whose one target (`targetOf`) is judged exactly as before. Throws when the tool
   * cannot tell what it would touch (a patch that cannot be read): the caller refuses the call.
   */
  targetsOf(name: string, args: unknown, context: ToolContext): ToolTarget[] | null {
    const tool = this.tools.get(name);
    if (!tool?.targets) return null;
    // Arguments that do not fit the tool never run, but they are not waved through here either: what
    // they would touch cannot be told, so the call is refused, saying what does not fit.
    const parsed = tool.parameters.safeParse(args);
    if (!parsed.success)
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || name}: ${issue.message}`).join("; "));
    return tool.targets(parsed.data, context);
  }
  /**
   * hardening-3: the arguments a call will really run with — the tool's own schema applied, with
   * the names it maps, the spaces it trims and the defaults it fills — for everything that judges or
   * shows a call (the rules, the approval card, the second look, the loop guard). The tool itself
   * parses the same arguments with the same schema, so what was judged is what runs. A call whose
   * arguments do not parse is refused by the tool, so it is judged as it was sent.
   */
  runArgs(name: string, args: unknown): unknown {
    const tool = this.tools.get(name);
    if (!tool) return args;
    try {
      const parsed = tool.parameters.safeParse(args);
      return parsed.success ? parsed.data : args;
    } catch { return args; }
  }
  /**
   * Integration (hardening-3): what a call is about, for the rules. A path is also given as written
   * from the workspace when the file tools read paths inside one of its folders, so a folder rule
   * (written about the workspace) holds whichever folder is active.
   */
  resourceOf(name: string, target: string, args: unknown): PolicyResource | null {
    // mac7/residuals: a tool that says which command it runs is judged by that command.
    const command = this.tools.get(name)?.command?.(this.runArgs(name, args));
    if (command) return { kind: "command", value: command.slice(0, 8000), listed: true, ...(command.length > 8000 ? { cut: true } : {}) };
    const resource = resourceOf(name, this.permissionOf(name), target, args);
    const scope = this.pathScope();
    return resource?.kind === "path" && scope ? { ...resource, inWorkspace: `${scope}/${resource.value}` } : resource;
  }
  /** Q59: whether a tool reaches beyond the workspace (src/tool-reach.ts); an unknown tool counts as outbound. */
  reachOf(name: string): ToolReach {
    const tool = this.tools.get(name);
    return tool ? reachOf(tool) : "outbound";
  }
  /** Q59: every registered tool that reaches beyond the workspace, for the conversation modes' questions. */
  outboundTools(): string[] {
    return [...this.tools.values()].filter((tool) => reachOf(tool) === "outbound").map((tool) => tool.name);
  }
  permissions(): string[] {
    return [...new Set([...this.tools.values()].map((t) => t.permission))];
  }
  /**
   * mac7/coding-next: a model's call with keys the tool does not take, with those keys taken out. A
   * small model often adds one (`workspace.checkpoint` with a `path`, `documents.write` with a
   * `format`), and refusing the whole call over it wastes a turn. Only keys the tool's own schema
   * reports as unrecognised are dropped, and only when what is left is a valid call; a wrong type or
   * a missing field is left exactly as sent, so the call is refused as before. Whoever calls this
   * must hand the cleaned arguments to everything after it — the permission check included — so a
   * dropped key can never be seen by one step and not another.
   */
  clean(name: string, args: unknown): { args: unknown; ignored: string[] } {
    const tool = this.tools.get(name);
    if (!tool || !args || typeof args !== "object" || Array.isArray(args)) return { args, ignored: [] };
    let current: unknown = structuredClone(args);
    const ignored: string[] = [];
    for (let round = 0; round < 3; round++) {
      const parsed = tool.parameters.safeParse(current);
      if (parsed.success) return ignored.length ? { args: current, ignored } : { args, ignored: [] };
      const extra = parsed.error.issues.filter((issue) => issue.code === "unrecognized_keys");
      if (!extra.length || extra.length !== parsed.error.issues.length) break;
      if (meantSomething(tool, extra.flatMap((issue) => (issue as { keys: string[] }).keys))) break;
      for (const issue of extra) {
        const holder = valueAt(current, issue.path);
        if (!holder || typeof holder !== "object") return { args, ignored: [] };
        for (const key of (issue as { keys: string[] }).keys) {
          delete (holder as Record<string, unknown>)[key];
          ignored.push([...issue.path, key].join("."));
        }
      }
    }
    return { args, ignored: [] };
  }
  async execute(
    name: string,
    args: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    context.signal.throwIfAborted();
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (!context.permissions.has(tool.permission))
      throw new Error(`Permission denied: ${tool.permission}`);
    context.budget.step(context.signal);
    const parsed = tool.parameters.parse(args);
    // Q12: a call that would change Branch's own source is held to its written contract first. It is
    // judged on the arguments as sent, as the approval policy judged them, and parsed the same way.
    // It may also hold the tool to one folder for this call (a command while Branch's source is checked out).
    const held = this.beforeTool ? await this.beforeTool(name, args, context) : undefined;
    const running = held ? { ...context, ...held } : context;
    let result: unknown;
    try {
      // household-followups: an owner-only guard inside the tool judges by this task's person.
      result = await underTask(context.runId, () => tool.execute(parsed, running), name); // mac7/walk-rules: name
      context.signal.throwIfAborted();
      // ── mac7/r17-d: format and diagnostics after an edit, and a very long answer kept in a file. ──
      if (this.afterTool) result = await this.afterTool(name, parsed, result, context);
    } finally {
      // mac7/coding-next: files this call wrote count as read, as they are once it has finished.
      await this.afterWrites?.(context).catch(() => undefined);
    }
    if (JSON.stringify(result).length > 65536) {
      const kept = this.oversized?.(name, result, context);
      if (kept !== undefined) return kept;
      throw new Error("Tool output exceeds 64 KiB limit");
    }
    // ── end mac7/r17-d ──
    return result;
  }
  /** Q12 (src/self-development-contract.ts): may refuse a call, by throwing, before the tool runs. */
  beforeTool?: (name: string, args: unknown, context: ToolContext) => Promise<Pick<ToolContext, "writesConfinedTo" | "sendsRef" | "sendsCommit"> | void>;
  /** mac7/coding-next (src/coding/read-first.ts): told after every call, so what it wrote counts as read. */
  afterWrites?: (context: ToolContext) => Promise<void>;
  /** mac7/r17-d (src/coding/): looks at a finished call and may add to its answer (format-on-edit). */
  afterTool?: (name: string, args: unknown, result: unknown, context: ToolContext) => Promise<unknown>;
  /** mac7/r17-d (src/coding/large-output.ts): a replacement for an answer over 64 KiB, or undefined to refuse it. */
  oversized?: (name: string, result: unknown, context: ToolContext) => unknown;
  /**
   * FQ-execution.browser: judges one step a tool takes on its own (a `browser.flow` click) as if the
   * model had called `tool` itself, with `target` when the step's target is not the one `targetOf`
   * would read right now. Returns the step fingerprint if a once-only overrule was used to skip an
   * approval question, undefined if the step passed without a question, and throws `PolicyRefusedError`
   * if a rule refused the step. Throws `ApprovalRequiredError` if the step asks a question and no
   * overrule exists (the flow cannot proceed until the question is answered). Set by the app;
   * a bare registry judges no call at all, so it judges no step either.
   */
  judgeStep?: (tool: string, args: unknown, context: ToolContext, target?: string, index?: number) => string | undefined;
  /**
   * FQ-execution.browser: consumes (takes) the one-time overrules used by a flow's steps, after all
   * steps have passed judgment and before any step runs. The runtime implements this to complete the
   * approval lifecycle. If not provided, overrules are not consumed. Called with the fingerprints
   * returned by judgeStep calls.
   */
  takeStepYeses?: (fingerprints: string[], context: ToolContext) => boolean;
}

/**
 * Integration review (mac7/coding-next): an extra key is dropped only when it cannot have meant
 * anything. One that respells a key the tool does take (`dry_run` for `dryRun`, `replace_all` for
 * `replaceAll`), or that asks for nothing to really happen (`preview`, `simulate`), is left in place,
 * so the call is refused as before instead of being carried out for real without it.
 */
const doNothingKeys = new Set(["dryrun", "preview", "simulate", "whatif", "noop", "checkonly", "validateonly"]);
const squashed = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
function meantSomething(tool: ToolDefinition, keys: readonly string[]): boolean {
  const declared = new Set<string>();
  try { collectKeys(z.toJSONSchema(tool.parameters), declared); } catch { /* nothing to compare with */ }
  return keys.some((key) => doNothingKeys.has(squashed(key)) || declared.has(squashed(key)));
}
/** Every property name anywhere in a JSON schema, squashed the same way. */
function collectKeys(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const properties = (node as { properties?: unknown }).properties;
  if (properties && typeof properties === "object") for (const name of Object.keys(properties)) into.add(squashed(name));
  for (const value of Object.values(node)) collectKeys(value, into);
}

/** The value at a zod issue's path inside `root`, or undefined when the path does not lead anywhere. */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let here: unknown = root;
  for (const step of path) {
    if (!here || typeof here !== "object") return undefined;
    here = (here as Record<PropertyKey, unknown>)[step];
  }
  return here;
}

/**
 * ChatGPT's backend gives up on a request, with no tokens used, when a tool's `pattern` holds the
 * `\0` escape. `\x00` means the same character to every regex engine and is accepted, so patterns
 * are rewritten on the way out; the tool itself still validates with its original schema.
 */
export function wireSafePatterns<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(wireSafePatterns) as T;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = key === "pattern" && typeof value === "string"
      ? value.replace(/(?<!\\)((?:\\\\)*)\\0(?![0-9])/g, "$1\\x00")
      : wireSafePatterns(value);
  }
  return out as T;
}
