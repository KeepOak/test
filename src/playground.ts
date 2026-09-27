/**
 * "Try a tool": run one tool by hand, on its own, through exactly the same approval rules a task
 * would go through. Nothing here bypasses the gate — a tool the settings say to ask about comes
 * back as a question the owner must answer before it is run at all.
 */
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import { evaluatePolicy, isReadOnlyPermission, policyTarget, readPolicy } from "./policy.js";
import { everyTargetDecision } from "./policy-targets.js"; // mac7/multi-target
import { manualVerdict, type ManualVerdict } from "./tool-gate.js";
import { argumentFingerprint } from "./runtime.js";
import type { createBranch } from "./index.js";

export const TryToolSchema = z
  .object({
    name: z.string().min(1).max(100),
    arguments: z.record(z.string(), z.unknown()).default({}),
    /** Set after the owner has answered the question this call raised the first time round. */
    confirm: z.boolean().default(false),
    /**
     * unhold-control: the conversation whose terminal this was typed into, for a tool that runs in a
     * run of its own (`runsByHand`). Only ever a place to keep the record: it gives no permission.
     */
    sessionId: z.string().uuid().optional(),
  })
  .strict();

/** Every tool with the shape of the form to fill in, so the page can draw one without guessing. */
export function toolForms(registry: ToolRegistry): { name: string; description: string; permission: string; readOnly: boolean; schema: Record<string, unknown> }[] {
  const byName = new Map(registry.descriptions(new Set(registry.permissions())).map((description) => [description.name, description.parameters] as const));
  return registry.inventory().map((tool) => ({
    name: tool.name,
    description: tool.description,
    permission: tool.permission,
    readOnly: isReadOnlyPermission(tool.permission),
    schema: (byName.get(tool.name) ?? {}) as Record<string, unknown>,
  }));
}

export type TryOutcome =
  | { status: "asked"; question: string; tool: string; target: string }
  | { status: "refused"; reason: string; tool: string; target: string }
  | { status: "ran"; tool: string; target: string; milliseconds: number; result: unknown }
  | { status: "failed"; tool: string; target: string; milliseconds: number; error: string };

/**
 * Checks the approval policy, then runs the tool. "ask" comes back as a question the first time and
 * only goes ahead when the caller sends the same request again with `confirm`.
 */
export async function tryTool(
  registry: ToolRegistry,
  store: Store,
  owner: string,
  context: ToolContext,
  input: z.infer<typeof TryToolSchema>,
  /** Why the person at the keyboard may not have this done, from their profile's role. */
  personRefusal: (tool: string, permission: string) => string | null = () => null,
  /**
   * mac5/manual-actions: the runtime's hand-pressed gate (src/tool-gate.ts) — Branch's own files,
   * Lockdown, folder trust and the sandbox wall on top of the rules. Without it only the rules apply.
   */
  gate?: (tool: string, args: unknown, context: ToolContext) => ManualVerdict,
  /**
   * unhold-control: a real run of its own for a tool that will only run inside one (a command on this
   * computer). Asked for only once the call is allowed, or the person has confirmed it, so a refused
   * or unanswered call leaves nothing behind; the run is finished with how the call went.
   */
  ownRun?: (tool: string, target: string, sessionId?: string) => HandRun | null,
): Promise<TryOutcome> {
  const permission = registry.permissionOf(input.name);
  if (!permission) return { status: "refused", reason: `There is no tool called ${input.name}.`, tool: input.name, target: "" };
  // Somebody else in the house is held to their role here as well; running a tool by hand from the
  // developer screen must not be a way round what the owner said they may have Branch do.
  const held = personRefusal(input.name, permission);
  if (held) return { status: "refused", reason: held, tool: input.name, target: "" };
  // hardening-3: judged as the tool will run it, with the names it maps and the spaces it trims.
  const seen = registry.runArgs(input.name, input.arguments);
  const target = registry.targetOf(input.name, seen, context) || policyTarget(input.name, seen);
  // What the call is about goes in too, so trying a command by hand is decided exactly as a
  // command the assistant asked for would be — a command nobody has ruled on is asked about.
  const resource = registry.resourceOf(input.name, target, seen);
  const verdict = gate?.(input.name, seen, context);
  const policy = readPolicy(store, owner);
  // mac7/multi-target: without the runtime's gate, every file the call touches is still weighed.
  const decision = verdict?.decision ?? everyTargetDecision(registry, policy, { tool: input.name, permission, callTarget: target, args: seen }, context,
    evaluatePolicy(policy, { tool: input.name, target, readOnly: isReadOnlyPermission(permission), resource }).decision).decision;
  if (decision === "deny")
    return { status: "refused", reason: verdict?.reason ?? `Your settings do not allow ${input.name}${target ? ` on ${target}` : ""}.`, tool: input.name, target };
  if (decision === "ask" && !input.confirm)
    return { status: "asked", question: `Before I go ahead: run ${input.name}${target ? ` on ${target}` : ""}. Is that all right?`, tool: input.name, target };
  const started = Date.now();
  const run = ownRun?.(input.name, target, input.sessionId) ?? null;
  try {
    const result = await registry.execute(input.name, input.arguments, { ...context, ...verdict?.scope, ...(run ? { runId: run.id, scratchRoot: run.id } : {}) });
    run?.done(true, JSON.stringify(result ?? null));
    return { status: "ran", tool: input.name, target, milliseconds: Date.now() - started, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run?.done(false, message);
    return { status: "failed", tool: input.name, target, milliseconds: Date.now() - started, error: message };
  }
}

/** A run made for one call pressed by hand, and how to finish it. */
export interface HandRun { id: string; done(ok: boolean, output: string): void }

/**
 * unhold-control: the tools that only run inside a run of their own. A command on this computer is
 * tied to a run so it can be stopped with it (src/integrations/shell.ts refuses one without); pressed
 * by hand from the window it gets a real one, recorded as the owner's, from the window.
 */
export const runsByHand: ReadonlySet<string> = new Set(["shell.execute"]);

type HandStore = Pick<Store, "createRun" | "finish" | "createSession" | "ownsSession" | "sessionRuns" | "get" | "save">;

/** A task in one of these states may be mid tool call, so nothing else is written into its conversation meanwhile. */
const busyStates: ReadonlySet<string> = new Set(["running", "queued", "needs_input", "waiting", "interrupted"]);
const terminalKey = "window-terminal-session";

/**
 * Where the run is kept, so the side list never fills with empty conversations: the conversation the
 * terminal belongs to, when it is this person's and nothing is working or waiting in it; otherwise one
 * "Terminal" conversation per person, made once and used again.
 */
export function handSession(store: HandStore, owner: string, wanted: string | undefined): string {
  if (wanted && store.ownsSession(owner, wanted) && !store.sessionRuns(owner, wanted).some((run) => busyStates.has(run.status))) return wanted;
  const kept = (store.get("settings", owner, terminalKey)?.data as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof kept === "string" && store.ownsSession(owner, kept)) return kept;
  const made = store.createSession(owner);
  store.save("settings", owner, terminalKey, { sessionId: made });
  return made;
}

/** That run: made in the store, so everything the tool writes down lands on a real row, and finished after. */
export function handRun(store: HandStore, owner: string, tool: string, target: string, sessionId?: string): HandRun | null {
  if (!runsByHand.has(tool)) return null;
  const run = store.createRun(owner, `${tool}${target ? `: ${target}` : ""}`.slice(0, 2000), handSession(store, owner, sessionId), false, "window");
  // Finished without mending the conversation's transcript: a task started there meanwhile may be mid tool call.
  return { id: run.id, done: (ok, output) => { store.finish(run.id, ok ? "completed" : "failed", output.slice(0, 4000), { mend: false }); } };
}

/**
 * One tool pressed by hand, the way `/api/tools/try` runs it: the person's role, the runtime's
 * hand-pressed gate (Lockdown, the owner's rules, the safety extras; a short-lived key meets the
 * full rules and cannot confirm), a two-minute ceiling, and the answer scrubbed of secrets on the
 * way out exactly as the runtime scrubs a tool result before it records one. Every door that runs a
 * tool by hand goes through here, so none of them can skip a step the others take.
 */
export async function tryToolByHand(
  app: Awaited<ReturnType<typeof createBranch>>, input: z.infer<typeof TryToolSchema>,
): Promise<TryOutcome> {
  return app.runtime.hideSecrets(
    await tryTool(app.registry, app.store, app.runtime.owner,
      app.runtime.context({ signal: AbortSignal.timeout(120000) }), input,
      (tool, permission) => app.runtime.roleRefusal(tool, permission),
      (tool, args, context) => manualVerdict(app.runtime, tool, args, context, argumentFingerprint(tool, JSON.stringify(args))),
      // Kept under whoever is at the window: the owner's own runs, or a household person's (their role already allowed it).
      (tool, target, sessionId) => handRun(app.store, app.store.profiles.scope(), tool, target, sessionId)));
}
