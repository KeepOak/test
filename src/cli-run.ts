import type { Run, RunStatus } from "./contracts.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";
import { keepPolicyRule, nextPolicy, readPolicy, savePolicy, policyPresets, type PolicyPresetName } from "./policy.js";
import { lockdownSettingsRefusal, policyChangeRefusal } from "./policy-change-guard.js"; // Q259
import type { ToolLister } from "./preset-moves.js";
import { recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import { readAttachment, type Attachment, attachedText } from "./terminal-commands.js";
import { progressLine } from "./terminal.js";
import { allowTestsRefusal } from "./coding/project-tests.js";
import { allowTestsIdleNote } from "./code-change.js"; // mac7/smoke-fixes (B6)
import type { ImagePart } from "./contracts.js";
import { unkeyedAlwaysRefusal } from "./runtime.js";
import { lockdownActive } from "./lockdown.js";

/**
 * `branch run` for scripts: what the flags mean, what comes out (a JSON Lines event stream with
 * `--json`, the usual report otherwise), and what the exit code says. The codes are the contract a
 * script relies on, so they are listed in one place and documented.
 */
export const exitCodes = { ok: 0, needsInput: 2, failed: 3, budget: 4 } as const;

/** What a finished task means for the shell: 0 finished, 2 stopped to ask, 3 failed, 4 out of budget. */
export function exitCodeFor(status: RunStatus): number {
  if (status === "completed") return exitCodes.ok;
  if (status === "needs_input") return exitCodes.needsInput;
  if (status === "budget_exceeded") return exitCodes.budget;
  return exitCodes.failed;
}

export interface RunFlags {
  prompt: string;
  json: boolean;
  attach: string[];
  plan: boolean;
  verify: boolean;
  dryRun: boolean;
  preset?: string;
  /** True when `--save-preset` was used: the setting is meant to stay changed after the task. */
  savePreset: boolean;
  /** Q259: `--confirm`, the owner's yes to a `--save-preset` that makes Branch less careful. */
  confirm?: boolean;
  /** Most tokens this one task may use before it stops. */
  budget?: number;
  timeoutMs?: number;
  /**
   * Batch 20 (wave 8): which conversation this task belongs to. `--session` carries on in one that
   * already exists, `--resume` picks up where a task that stopped left off, and `--fork` works in a
   * copy so the conversation it came from is left exactly as it was.
   */
  sessionId?: string;
  resumeRunId?: string;
  forkFrom?: string;
  /**
   * mac7/tests-unattended: `--allow-tests` lets this one task run the project's tests without asking,
   * as if the owner had answered Once each time. Nothing is saved; refused under Lockdown.
   */
  allowTests: boolean;
}
const wholeNumber = (name: string, value: string | undefined): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} needs a whole number greater than zero`);
  return parsed;
};

/** Reads the words and flags after `branch run`. Anything not a known flag is part of the request. */
export function parseRunArgs(argv: string[]): RunFlags {
  const flags: RunFlags = { prompt: "", json: false, attach: [], plan: false, verify: false, dryRun: false, savePreset: false, allowTests: false };
  const words: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--json") flags.json = true;
    else if (word === "--plan") flags.plan = true;
    else if (word === "--verify") flags.verify = true;
    else if (word === "--dry-run") flags.dryRun = true;
    else if (word === "--allow-tests") flags.allowTests = true;
    else if (word === "--attach") flags.attach.push(argv[++at] ?? "");
    else if (word === "--preset") flags.preset = argv[++at] ?? "";
    else if (word === "--save-preset") { flags.preset = argv[++at] ?? ""; flags.savePreset = true; }
    else if (word === "--confirm") flags.confirm = true;
    else if (word === "--budget") flags.budget = wholeNumber("--budget", argv[++at]);
    else if (word === "--timeout") flags.timeoutMs = wholeNumber("--timeout", argv[++at]);
    else if (word === "--session") flags.sessionId = argv[++at] ?? "";
    else if (word === "--resume") flags.resumeRunId = argv[++at] ?? "";
    else if (word === "--fork") flags.forkFrom = argv[++at] ?? "";
    else words.push(word);
  }
  for (const [name, value] of [["--session", flags.sessionId], ["--resume", flags.resumeRunId], ["--fork", flags.forkFrom]] as const)
    if (value === "") throw new Error(`${name} needs a number after it`);
  if (flags.resumeRunId && flags.forkFrom) throw new Error("Choose either --resume or --fork, not both");
  if (flags.attach.some((path) => !path)) throw new Error("--attach needs a file after it");
  if (flags.preset === "") throw new Error(`${flags.savePreset ? "--save-preset" : "--preset"} needs a name after it`);
  if (flags.confirm && !flags.savePreset) throw new Error("--confirm goes with --save-preset");
  flags.prompt = words.join(" ").trim();
  return flags;
}

export interface PresetChange {
  /** A plain line saying what changed, and whether it stays changed. */
  message: string;
  /** Puts the owner's saved setting back; does nothing when they asked to keep the change. */
  restore(): void;
}
/**
 * Applies `--preset` or `--save-preset`. A script flag should not quietly rewrite what the owner
 * saved, so `--preset` holds for this one task and the old setting goes back afterwards;
 * `--save-preset` keeps the change and says so in as many words.
 *
 * Q259: both are held to what `/preset` is held to (src/policy-change-guard.ts). Under Lockdown the saved
 * policy is Lockdown's ask-everything one, so either flag would loosen Lockdown (for the task, or for good)
 * and is refused. `--save-preset` to a preset that makes Branch less careful needs `--confirm` as well.
 */
export function usePreset(store: Store, owner: string, name: string, keep: boolean,
  options: { confirm?: boolean; tools?: ToolLister } = {}): PresetChange {
  const known = policyPresets().map((preset) => preset.id);
  if (!known.includes(name as PolicyPresetName))
    throw new Error(`--preset takes one of: ${known.join(", ")}`);
  if (lockdownActive(store, owner)) throw new Error(lockdownSettingsRefusal);
  const before = readPolicy(store, owner);
  if (keep) {
    const refusal = policyChangeRefusal(store, owner, nextPolicy(before, { preset: name }), options.confirm === true, options.tools,
      `Add --confirm after --save-preset ${name} to go ahead.`);
    if (refusal) throw new Error(refusal);
    // Q48: a change that stays is written down like any other, so "why is this on?" names the command.
    recordedWrite(store, owner, { writer: "owner-by-command", source: "command", detail: `--save-preset ${name}` }, ["policy"],
      () => savePolicy(store, owner, { preset: name }));
    return { message: `[your saved setting for when to check with you is now "${name}", and it stays that way]`, restore: () => {} };
  }
  // For this one task only: the saved setting is put back afterwards and ends where it started, so
  // neither step is recorded as a change of the owner's settings.
  savePolicy(store, owner, { preset: name });
  return {
    message: `[when to check with you, for this task only: "${name}". Your saved setting stays "${before.preset}".]`,
    restore: () => { savePolicy(store, owner, before); },
  };
}

export interface RunWriter {
  /** One JSON object per line for scripts, or a human line on stderr. */
  line(value: unknown): void;
  note(text: string): void;
}
/** Streams a task as JSON Lines while it works, then the run itself, and answers with its status. */
/**
 * Batch 20 (wave 8): which conversation a scripted task joins, and where it picks up from.
 *
 * `--fork` makes a copy of the conversation at its last message and works in that, so the one it
 * came from is left exactly as it was — the safe way to try a different wording. `--resume` carries
 * on the transcript of a task that stopped, in its own conversation. `--session` simply joins one.
 * Anything that is not the owner's own is refused by the store, in its own words.
 */
export function conversationFor(
  store: Store, owner: string, flags: RunFlags,
): { sessionId?: string; resumeFrom?: string; prompt?: string } {
  if (flags.forkFrom) {
    const view = store.sessionView(owner, flags.forkFrom);
    const point = [...view.messages].reverse()
      .find((message) => ["user", "assistant"].includes(message.role) && !message.toolCalls?.length);
    if (!point) throw new Error("There is nothing in that conversation to work from yet");
    return { sessionId: store.branchSession(owner, { sessionId: flags.forkFrom, messageId: point.messageId }).sessionId };
  }
  if (flags.resumeRunId) {
    const previous = store.run(flags.resumeRunId);
    if (!previous || previous.owner !== owner) throw new Error(`There is no task of yours numbered ${flags.resumeRunId}`);
    // Carrying on needs no new words, so an empty `--resume` takes up the task's own request again.
    return { sessionId: previous.sessionId, resumeFrom: previous.id, prompt: previous.prompt };
  }
  return flags.sessionId ? { sessionId: flags.sessionId } : {};
}

export async function runForScripts(
  runtime: Runtime,
  flags: RunFlags,
  writer: RunWriter,
  /** mac7/tests-unattended: whether a person is at a terminal to be asked; false for scripts. */
  attended = false,
): Promise<Run> {
  const allowTests = flags.allowTests ? await allowTestsFor(runtime, writer) : false;
  const attachments: Attachment[] = [];
  for (const path of flags.attach) attachments.push(await readAttachment(path));
  const images = attachments.map((a) => a.image).filter((image): image is ImagePart => !!image);
  const controller = new AbortController();
  const timer = flags.timeoutMs ? setTimeout(() => controller.abort(new Error("Timed out")), flags.timeoutMs) : undefined;
  let seen = 0, runId = "";
  const pump = setInterval(() => { seen = drain(runtime, runId, seen, writer); }, 100);
  const { prompt: carried, ...conversation } = conversationFor(runtime.store, runtime.owner, flags);
  try {
    const run = await runtime.run({
      prompt: (flags.prompt || carried || "") + attachedText(attachments),
      signal: controller.signal,
      ...(flags.timeoutMs ? { timeoutMs: flags.timeoutMs } : {}),
      ...conversation,
      ...(images.length ? { images } : {}),
      ...(flags.plan ? { plan: true } : {}), ...(flags.verify ? { verify: true } : {}),
      ...(flags.dryRun ? { dryRun: true } : {}),
      ...(attended ? {} : { unattended: true }), ...(allowTests ? { allowProjectTests: true } : {}),
      ...(flags.budget ? { budget: { maxSteps: 60, maxTokens: flags.budget } } : {}),
      onStarted: (started) => { runId = started.id; if (flags.json) writer.line({ type: "run.started", runId: started.id, sessionId: started.sessionId }); },
      onTextDelta: (text) => { if (flags.json) writer.line({ type: "text", text }); },
    });
    drain(runtime, run.id, seen, writer);
    return run;
  } finally {
    clearInterval(pump);
    if (timer) clearTimeout(timer);
  }
}
/**
 * `--allow-tests`, refused in plain words when it may not be used, and said out loud when it is.
 * mac7/smoke-fixes (B6): when this workspace has no question for the flag to remove, it says that
 * instead, rather than promising something it cannot do.
 */
async function allowTestsFor(runtime: Runtime, writer: RunWriter): Promise<true> {
  const refusal = allowTestsRefusal(runtime.store, runtime.owner);
  if (refusal) throw new Error(refusal);
  const idle = await allowTestsIdleNote(runtime.store, runtime.owner, runtime.workspace);
  writer.note(idle ? `[${idle}]` : "[this task may run the project's tests without asking; nothing is saved]");
  return true;
}
/** Writes the stored events of a task that have not been written yet; answers with the new mark. */
function drain(runtime: Runtime, runId: string, after: number, writer: RunWriter): number {
  if (!runId) return after;
  let last = after;
  for (const event of runtime.store.events(runId)) {
    if (event.id <= after) continue;
    last = event.id;
    writer.line({ type: "event", id: event.id, kind: event.kind, data: event.data, at: event.createdAt });
  }
  return last;
}

/** The timeline of one task, one plain line per step, for `branch logs`. */
export function timelineLines(store: Store, runId: string): string[] {
  const run = store.run(runId);
  if (!run) throw new Error("No task with that id. `branch status` lists the recent ones.");
  const lines = [`${run.createdAt} task ${run.id} — ${run.prompt.slice(0, 120)}`];
  for (const event of store.events(run.id)) {
    const described = progressLine(event);
    if (described) lines.push(`${event.createdAt} ${described}`);
  }
  lines.push(`${run.updatedAt} [finished: ${run.status}]`);
  return lines;
}

/** What `branch status` shows: tasks working now and questions waiting for an answer. */
export function statusSnapshot(runtime: Runtime) {
  const runs = runtime.store.runs(runtime.owner);
  return {
    running: runs.filter((run) => run.status === "running").map((run) => ({ id: run.id, sessionId: run.sessionId, prompt: run.prompt.slice(0, 120), since: run.createdAt })),
    waitingForYou: runs.filter((run) => run.status === "needs_input").map((run) => ({ id: run.id, sessionId: run.sessionId, question: run.output.slice(0, 300) })),
    approvals: runtime.approvals.waiting().map((entry) => ({ runId: entry.runId, sessionId: entry.sessionId, tool: entry.tool, target: entry.target, label: entry.label })),
    approvalPreset: readPolicy(runtime.store, runtime.owner).preset,
  };
}

export interface ApprovalAnswer {
  runId: string; tool: string; target: string; decision: "allow" | "deny"; rule: string;
  /** Q215: false when the approval rules were full and nothing less careful could make room, so nothing was saved. */
  kept: boolean;
}
/**
 * Answers a task that stopped to ask, from a separate command. The question itself lived in the
 * program run that stopped, which has since ended, so the answer is written into the approval
 * settings as a standing rule — that is what makes it survive to the next `branch run`.
 */
export function answerFromCommand(runtime: Runtime, id: string, answer: string): ApprovalAnswer {
  const decision = /^(y|yes|allow)$/i.test(answer) ? "allow" : /^(n|no|deny)$/i.test(answer) ? "deny" : null;
  if (!decision) throw new Error("Answer yes or no: branch approve <task id> yes");
  const run = runtime.store.run(id) ?? runtime.store.runs(runtime.owner).find((entry) => entry.sessionId === id);
  if (!run || run.owner !== runtime.owner) throw new Error("No task with that id. `branch status` lists the ones waiting.");
  const asked = runtime.store.events(run.id).filter((event) => event.kind === "policy.ask").at(-1);
  if (!asked) throw new Error("That task did not stop to ask permission for anything.");
  const tool = String(asked.data.name ?? ""), target = String(asked.data.target ?? "");
  const noAlways = asked.data.noAlways === true || runtime.registry.noStandingTarget(tool, target);
  // FQ-execution.browser, Q76: the CLI writes no standing rule where the question forbids one, or where
  // the call named no target its tool could have named: it would cover every call of the tool.
  // The CLI path cannot offer "just this once" like an attended UI can, so refuse and ask the user
  // to run the task again where they can choose the right scope.
  if (noAlways) throw new Error(`${unkeyedAlwaysRefusal}. Run the task again and choose your answer when it asks.`);
  // unhold-approvals: this answer is kept for good, and a rule written into Lockdown's list is lost when it ends.
  if (lockdownActive(runtime.store, runtime.owner))
    throw new Error("Lockdown is on, so a yes cannot be kept for good. Answer it in the app window, just now or for this conversation.");
  // The question carried the fingerprint of the exact bytes it was put for, so the answer given
  // here is bound to them: a task that asks for something different next time asks again.
  const fingerprint = String(asked.data.fingerprint ?? "");
  runtime.approvals.remember(run.sessionId, tool, target, decision,
    { ...(fingerprint ? { fingerprint } : {}), label: String(asked.data.label ?? "") });
  // Left with no target only for a tool that can name none, where a rule on "*" is the tool itself.
  const { kept } = keepPolicyRule(runtime.store, runtime.owner, { tool, match: target || "*", decision, remember: "always" });
  return { runId: run.id, tool, target, decision, rule: `${tool} on ${target || "anything"}`, kept };
}
