import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { FanoutTaskSchema, ResultSchemaSchema, type FanoutTask } from "./delegation.js";
import { CompletionCheckSchema, type CompletionCheck } from "./reliability.js";
import { InputsSchema, ParametersSchema, bindInputs, placeholders, substitute, type InputValue } from "./recipes.js";
import { mismatch } from "./delegation.js";
import { TemplateSchema, exportTemplate, importTemplate } from "./templates.js";
import type { ToolContext, Run } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import { argumentFingerprint, type PolicyCheck, type Runtime } from "./runtime.js";
import { outsideRecipeRefusal, outsideTask, scopeOf } from "./tool-gate.js"; // mac5/manual-actions
import { executeTracedTool, type ToolSource } from "./tool-trace.js";
import { ApprovalRequiredError, PolicyRefusedError } from "./approvals.js";
import { SpecialistStyleSchema, styleShape, styledPermissions, type SpecialistStyle } from "./specialist-styles.js";
import { insideModelCall } from "./task-scope.js"; // Q250

export const CheckSchema = z
  .object({ path: z.string().min(1).max(500), expected: z.string().max(32768) })
  .strict();
export const ProcedureSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(100),
    preconditions: z.array(CheckSchema).max(12),
    steps: z
      .array(
        z
          .object({
            tool: z.string().max(100),
            args: z.record(z.string(), z.unknown()),
            expected: z
              .unknown()
              .refine(
                (v) => v !== undefined,
                "An explicit expected result is required",
              ),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    /** Named inputs bound before any step runs; {{name}} placeholders take their values. */
    parameters: ParametersSchema.default({}),
    /** The final step's result must match this shape (JSON-Schema subset) or the recipe fails. */
    resultSchema: ResultSchemaSchema.optional(),
  })
  .strict();
export const SpecialistSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(100),
    instructions: z.string().min(1).max(8000),
    /** How this specialist works: think out loud, plan first, review only, look things up, or write code. */
    style: SpecialistStyleSchema.default("default"),
    permissions: z.array(z.string().max(100)).max(50),
    evaluation: z
      .object({
        prompt: z.string().min(1).max(8000),
        checks: z.array(CheckSchema).min(1).max(12),
      })
      .strict(),
  })
  .strict();
type Procedure = z.infer<typeof ProcedureSchema>;
type Specialist = z.infer<typeof SpecialistSchema>;
interface ProcedureVersion {
  version: number;
  definition: Procedure;
  status: "proposed" | "verified";
  verifiedAt?: string;
}
interface ProcedureState extends ProcedureVersion {
  history: ProcedureVersion[];
}
interface SpecialistVersion {
  version: number;
  definition: Specialist;
  evaluationPassed: boolean;
  evidence?: { runId: string; sourceRunId: string; checkedAt: string };
}
interface SpecialistState extends SpecialistVersion {
  activeVersion: number | null;
  previousActive: number | null;
  history: SpecialistVersion[];
}
const idArgs = z.object({ id: z.string().uuid() }).strict();

export class Knowledge {
  constructor(
    readonly store: Store,
    readonly registry: ToolRegistry,
    readonly runtime: Runtime,
  ) {}
  proposeProcedure(context: ToolContext, input: unknown): SavedRecord {
    this.require(context, "procedures.manage");
    const definition = ProcedureSchema.parse(input),
      id = definition.id ?? randomUUID();
    if (
      definition.steps.some(
        (s) =>
          s.tool.startsWith("procedures.") ||
          s.tool.startsWith("specialists.") ||
          s.tool.startsWith("schedules."),
      )
    )
      throw new Error("Recipes cannot invoke orchestration tools");
    const undeclared = [...placeholders({ steps: definition.steps, preconditions: definition.preconditions })].filter((name) => !Object.hasOwn(definition.parameters, name));
    if (undeclared.length) throw new Error(`Recipe uses inputs it does not declare: ${undeclared.join(", ")}`);
    const old = this.store.get("procedures", context.owner, id)
      ?.data as unknown as ProcedureState | undefined;
    const history = old
      ? [
          ...old.history,
          {
            version: old.version,
            definition: old.definition,
            status: old.status,
            ...(old.verifiedAt ? { verifiedAt: old.verifiedAt } : {}),
          },
        ]
      : [];
    return this.store.save("procedures", context.owner, id, {
      version: (old?.version ?? 0) + 1,
      definition,
      status: "proposed",
      history,
    });
  }
  async verifyProcedure(
    context: ToolContext,
    id: string,
    inputs: Record<string, InputValue> = {},
  ): Promise<SavedRecord> {
    this.require(context, "procedures.manage");
    return this.runtime.auditOperation(context, "Verify procedure", (scoped) =>
      this.verifyCandidateProcedure(scoped, id, inputs),
    );
  }
  private async verifyCandidateProcedure(
    context: ToolContext,
    id: string,
    inputs: Record<string, InputValue>,
  ): Promise<SavedRecord> {
    const record = this.required("procedures", context.owner, id),
      state = record.data as unknown as ProcedureState;
    await this.executeProcedure(context, this.bound(context, state.definition, inputs), {
      kind: "procedure",
      id,
      version: state.version,
      phase: "step",
    });
    if (
      this.required("procedures", context.owner, id).data.version !==
      state.version
    )
      throw new Error("Procedure changed during verification");
    return this.store.save("procedures", context.owner, id, {
      ...state,
      status: "verified",
      verifiedAt: new Date().toISOString(),
    });
  }
  async replayProcedure(
    context: ToolContext,
    id: string,
    inputs: Record<string, InputValue> = {},
  ): Promise<{ version: number; results: unknown[] }> {
    this.require(context, "procedures.use");
    return this.runtime.auditOperation(context, "Replay procedure", (scoped) =>
      this.replayVerifiedProcedure(scoped, id, inputs),
    );
  }
  private async replayVerifiedProcedure(
    context: ToolContext,
    id: string,
    inputs: Record<string, InputValue>,
  ): Promise<{ version: number; results: unknown[] }> {
    const state = this.required("procedures", context.owner, id)
      .data as unknown as ProcedureState;
    if (state.status !== "verified")
      throw new Error("Only verified procedures can replay");
    return {
      version: state.version,
      results: await this.executeProcedure(context, this.bound(context, state.definition, inputs), {
        kind: "procedure",
        id,
        version: state.version,
        phase: "step",
      }),
    };
  }
  /** Binds the run's inputs to the recipe's parameters and fills every placeholder before anything executes. */
  private bound(context: ToolContext, definition: Procedure, inputs: Record<string, InputValue>): Procedure {
    const values = bindInputs(definition.parameters, inputs);
    if (Object.keys(definition.parameters).length)
      this.store.event(context.runId, "procedure.inputs_bound", { names: Object.keys(values), recipe: definition.name });
    return { ...definition, preconditions: substitute(definition.preconditions, values), steps: substitute(definition.steps, values) };
  }
  /**
   * The owner's approval policy, checked over every step before the first one runs. A recipe is
   * replayed as a whole, so the question has to come before anything happens: when the owner says
   * yes and the recipe is tried again, no step is done twice.
   */
  private gateSteps(context: ToolContext, definition: Procedure, source: ToolSource): PolicyCheck[] {
    const checks: PolicyCheck[] = [];
    for (const [index, step] of definition.steps.entries()) {
      // The yes is bound to this step's exact arguments, as it is for a tool the model calls itself.
      const fingerprint = argumentFingerprint(step.tool, JSON.stringify(step.args ?? {}));
      // A step outside what the asking task may use is refused in words, before any question is put.
      if (outsideTask(this.registry, step.tool, context)) {
        this.store.event(context.runId, "policy.denied", { name: step.tool, label: step.tool, source: { ...source, index } });
        throw Object.assign(new PolicyRefusedError(step.tool, step.tool), { message: outsideRecipeRefusal(step.tool) });
      }
      const check = this.runtime.checkPolicy(step.tool, step.args, context, fingerprint);
      checks.push(check);
      if (check.decision === "allow") continue;
      this.store.event(context.runId, check.decision === "deny" ? "policy.denied" : "policy.ask",
        { name: step.tool, label: check.label, target: check.target, source: { ...source, index } });
      if (check.decision === "deny") throw new PolicyRefusedError(step.tool, check.label);
      throw new ApprovalRequiredError(step.tool, check.target, check.label, check.remember, fingerprint);
    }
    return checks;
  }
  private async executeProcedure(
    context: ToolContext,
    definition: Procedure,
    source: ToolSource,
  ): Promise<unknown[]> {
    const checks = this.gateSteps(context, definition, source);
    await this.checkFiles(
      context,
      definition.preconditions,
      "Procedure precondition",
      { ...source, phase: "precondition" },
    );
    const results: unknown[] = [];
    for (const [index, step] of definition.steps.entries()) {
      // mac5/manual-actions: each step runs where its own rule and the owner's wall say, as a task's call does.
      const { osSandbox: _outer, ...unwalled } = context;
      const result = await executeTracedTool(
        this.registry,
        this.store,
        { ...unwalled, ...scopeOf(this.runtime, step.tool, step.args, context, checks[index]!), readFirstExempt: !insideModelCall() }, // Q250: held when a model's own call replays it
        step.tool,
        step.args,
        { ...source, index },
      );
      results.push(result);
      if (!isDeepStrictEqual(result, step.expected)) {
        this.store.event(context.runId, "procedure.expectation_failed", {
          source: { ...source, index },
          expected: step.expected,
          actual: result,
        });
        throw new Error(
          `Procedure expected output mismatch for ${step.tool}; previous side effects were not undone`,
        );
      }
    }
    if (definition.resultSchema) {
      const problem = mismatch(results.at(-1), definition.resultSchema, "result");
      if (problem) {
        this.store.event(context.runId, "procedure.result_rejected", { source, reason: problem, actual: results.at(-1) });
        throw new Error(`Recipe result did not match its declared shape: ${problem}`);
      }
    }
    return results;
  }
  proposeSpecialist(context: ToolContext, input: unknown): SavedRecord {
    this.require(context, "specialists.manage");
    const definition = SpecialistSchema.parse(input),
      id = definition.id ?? randomUUID();
    if (definition.permissions.some((p) => !context.permissions.has(p)))
      throw new Error("Specialist permission escalation denied");
    const old = this.store.get("specialists", context.owner, id)
      ?.data as unknown as SpecialistState | undefined;
    const history = old
      ? [
          ...old.history,
          {
            version: old.version,
            definition: old.definition,
            evaluationPassed: old.evaluationPassed,
            ...(old.evidence ? { evidence: old.evidence } : {}),
          },
        ]
      : [];
    return this.store.save("specialists", context.owner, id, {
      version: (old?.version ?? 0) + 1,
      definition,
      evaluationPassed: false,
      activeVersion: old?.activeVersion ?? null,
      previousActive: old?.previousActive ?? null,
      history,
    });
  }
  async evaluateSpecialist(
    context: ToolContext,
    id: string,
  ): Promise<SavedRecord> {
    this.require(context, "specialists.manage");
    return this.runtime.auditOperation(
      context,
      "Evaluate specialist",
      (scoped) => this.evaluateCandidateSpecialist(scoped, id),
    );
  }
  private async evaluateCandidateSpecialist(
    context: ToolContext,
    id: string,
  ): Promise<SavedRecord> {
    const state = this.required("specialists", context.owner, id)
      .data as unknown as SpecialistState;
    const run = await this.runtime.delegate(
      state.definition.evaluation.prompt,
      context,
      state.definition.permissions,
      state.definition.instructions,
    );
    let passed = run.status === "completed";
    try {
      await this.checkFiles(
        context,
        state.definition.evaluation.checks,
        "Specialist evaluation",
        {
          kind: "specialist",
          id,
          version: state.version,
          phase: "evaluation",
          childRunId: run.id,
        },
      );
    } catch {
      passed = false;
    }
    const current = this.required("specialists", context.owner, id)
      .data as unknown as SpecialistState;
    if (
      current.version !== state.version ||
      !isDeepStrictEqual(current.definition, state.definition)
    )
      throw new Error("Specialist changed during evaluation");
    return this.store.save("specialists", context.owner, id, {
      ...current,
      evaluationPassed: passed,
      evidence: {
        runId: run.id,
        sourceRunId: context.runId,
        checkedAt: new Date().toISOString(),
      },
    });
  }
  promoteSpecialist(context: ToolContext, id: string): SavedRecord {
    this.require(context, "specialists.manage");
    const record = this.required("specialists", context.owner, id);
    const state = record.data as unknown as SpecialistState;
    if (!state.evaluationPassed || !state.evidence)
      throw new Error("A passing measured evaluation is required");
    if (state.activeVersion === state.version) return record;
    return this.store.save("specialists", context.owner, id, {
      ...state,
      previousActive: state.activeVersion,
      activeVersion: state.version,
    });
  }
  rollbackSpecialist(context: ToolContext, id: string): SavedRecord {
    this.require(context, "specialists.manage");
    const state = this.required("specialists", context.owner, id)
      .data as unknown as SpecialistState;
    if (state.previousActive === null)
      throw new Error("No previous active specialist version");
    return this.store.save("specialists", context.owner, id, {
      ...state,
      activeVersion: state.previousActive,
      previousActive: state.activeVersion,
    });
  }
  /** The evaluated active version of a specialist, or an error the caller can show. */
  activeSpecialist(owner: string, id: string) {
    const state = this.required("specialists", owner, id).data as unknown as SpecialistState;
    const version = state.activeVersion === state.version ? state : state.history.find((v) => v.version === state.activeVersion);
    if (!version || !version.evaluationPassed) throw new Error(`Specialist ${id} has no evaluated active version`);
    // The style narrows what the specialist may do and adds to what it is told; it never widens either.
    const style = (version.definition.style ?? "default") as SpecialistStyle, shape = styleShape(style);
    return { permissions: styledPermissions(style, version.definition.permissions),
      instructions: version.definition.instructions + shape.instructions, agent: id, style };
  }
  async delegate(context: ToolContext, id: string, prompt: string, options: { timeoutMs?: number; resultSchema?: Record<string, unknown>; checks?: CompletionCheck; background?: boolean } = {}) {
    this.require(context, "specialists.use");
    const spec = this.activeSpecialist(context.owner, id);
    const scoped = { ...options, agent: id, style: spec.style };
    if (options.background) return this.runtime.delegateBackground(prompt, context, spec.permissions, spec.instructions, scoped);
    return this.runtime.delegateChecked(prompt, context, spec.permissions, spec.instructions, scoped);
  }
  async fanout(context: ToolContext, tasks: (FanoutTask & { specialist: string })[]) {
    this.require(context, "specialists.use");
    const specs = new Map(tasks.map((task) => [task.id, this.activeSpecialist(context.owner, task.specialist)]));
    return this.runtime.fanout(context, tasks, (id) => specs.get(id)!);
  }
  private async checkFiles(
    context: ToolContext,
    checks: z.infer<typeof CheckSchema>[],
    label: string,
    source: ToolSource,
  ): Promise<void> {
    for (const [index, check] of checks.entries()) {
      const result = (await executeTracedTool(
        this.registry,
        this.store,
        context,
        "files.verify",
        check,
        { ...source, index },
      )) as { verified: boolean };
      if (!result.verified) throw new Error(`${label} failed: ${check.path}`);
    }
  }
  private required(
    table: "procedures" | "specialists",
    owner: string,
    id: string,
  ): SavedRecord {
    const record = this.store.get(table, owner, id);
    if (!record) throw new Error(`${table} record not found`);
    return record;
  }
  private require(context: ToolContext, permission: string): void {
    context.signal.throwIfAborted();
    if (!context.permissions.has(permission))
      throw new Error(`Permission denied: ${permission}`);
  }
}

function registerProcedures(
  registry: ToolRegistry,
  knowledge: Knowledge,
): void {
  registry.register({
    name: "procedures.propose",
    description:
      "Propose a versioned recipe with exact expected tool results and file preconditions.",
    permission: "procedures.manage",
    parameters: ProcedureSchema,
    execute: async (a, c) => knowledge.proposeProcedure(c, a),
  });
  registry.register({
    name: "procedures.verify",
    description:
      "Execute the proposed recipe and compare actual results. This performs its side effects. Recipes with parameters need inputs.",
    permission: "procedures.manage",
    parameters: idArgs.extend({ inputs: InputsSchema.optional() }),
    execute: async (a, c) => knowledge.verifyProcedure(c, a.id, a.inputs ?? {}),
  });
  registry.register({
    name: "procedures.replay",
    description: "Execute a verified recipe after checking all preconditions. Recipes with parameters need inputs; wrong or missing inputs are refused before any step runs.",
    permission: "procedures.use",
    parameters: idArgs.extend({ inputs: InputsSchema.optional() }),
    execute: async (a, c) => knowledge.replayProcedure(c, a.id, a.inputs ?? {}),
  });
}
function registerSpecialists(
  registry: ToolRegistry,
  knowledge: Knowledge,
): void {
  registry.register({
    name: "specialists.propose",
    description:
      "Create or revise a specialist with subset permissions and an explicit file evaluation.",
    permission: "specialists.manage",
    parameters: SpecialistSchema,
    execute: async (a, c) => knowledge.proposeSpecialist(c, a),
  });
  registry.register({
    name: "specialists.evaluate",
    description:
      "Run the candidate specialist and independently compare expected file contents.",
    permission: "specialists.manage",
    parameters: idArgs,
    execute: async (a, c) => knowledge.evaluateSpecialist(c, a.id),
  });
  registry.register({
    name: "specialists.promote",
    description: "Activate a candidate version only after passing evaluation.",
    permission: "specialists.manage",
    parameters: idArgs,
    execute: async (a, c) => knowledge.promoteSpecialist(c, a.id),
  });
  registry.register({
    name: "specialists.rollback",
    description: "Restore the previous active specialist version.",
    permission: "specialists.manage",
    parameters: idArgs,
    execute: async (a, c) => knowledge.rollbackSpecialist(c, a.id),
  });
  registry.register({
    name: "specialists.delegate",
    description:
      "Hand part of this task to a specialist with fewer permissions and a share of the same budget.",
    permission: "specialists.use",
    parameters: idArgs.extend({ prompt: z.string().min(1).max(8000), timeoutMs: z.number().int().min(1000).max(120000).optional(), resultSchema: ResultSchemaSchema.optional(), checks: CompletionCheckSchema.optional(),
      background: z.boolean().optional().describe("Let the specialist keep working after this task finishes; its result is recorded on this task when it arrives.") }),
    execute: async (a, c) => knowledge.delegate(c, a.id, a.prompt, { ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}), ...(a.resultSchema ? { resultSchema: a.resultSchema } : {}), ...(a.checks ? { checks: a.checks } : {}), ...(a.background ? { background: true } : {}) }),
  });
  registry.register({
    name: "specialists.fanout",
    description:
      "Run several specialist tasks: independent tasks run at the same time, tasks with dependsOn wait for those results and receive them. Results are merged under this task.",
    permission: "specialists.use",
    parameters: z.object({ tasks: z.array(FanoutTaskSchema.extend({ specialist: z.string().min(1).max(200) })).min(1).max(8) }).strict(),
    execute: async (a, c) => knowledge.fanout(c, a.tasks),
  });
}
export function registerKnowledge(
  registry: ToolRegistry,
  knowledge: Knowledge,
): void {
  registerProcedures(registry, knowledge);
  registerSpecialists(registry, knowledge);
  registry.register({
    name: "templates.export",
    description: "Export a specialist or recipe as a template (definition only: no ids, evidence, history or secrets).",
    permission: "memory.read",
    parameters: z.object({ kind: z.enum(["specialist", "procedure"]), id: z.string().uuid(), description: z.string().max(500).optional() }).strict(),
    execute: async (a, c) => exportTemplate(knowledge.store, c.owner, a.kind, a.id, a.description ?? ""),
  });
  registry.register({
    name: "templates.import",
    description: "Create a new proposed specialist or recipe from a template. It still has to be evaluated or verified here before use.",
    permission: "procedures.manage",
    parameters: z.object({ template: TemplateSchema }).strict(),
    execute: async (a, c) => importTemplate(knowledge, c, a.template),
  });
  registry.register({
    name: "knowledge.list",
    description:
      "List stored procedures and specialists for the current owner.",
    permission: "memory.read",
    parameters: z.object({}).strict(),
    execute: async (_a, c) => ({
      procedures: knowledge.store.list("procedures", c.owner),
      specialists: knowledge.store.list("specialists", c.owner),
    }),
  });
}
