import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { Autonomy } from "./index.js";
import { catalogue } from "./blueprints.js";
import { OrderSchema } from "./orders.js";
import { ProcedureSchema, ProcedureSuggestionSchema } from "./procedures.js";
import { ownersOwnTask } from "./origin.js";
import type { AutonomyPart } from "./settings.js";

/**
 * R17-B: the assistant's side. Every tool here only reads, or puts a question to the owner; none of
 * them makes a schedule, an order, a procedure or an instruction. That takes the owner's yes in
 * Inbox › Needs you. The questions are capped (src/autonomy/ledger.ts) and a "no" is never re-asked.
 */
const read = "automations.read";
const propose = "automations.propose";
const values = z.record(z.string().regex(/^[a-z]{1,20}$/), z.string().max(300)).default({});

type Registrar = (registry: ToolRegistry, autonomy: Autonomy) => void;

/**
 * A proposal is put to the owner only from the owner's own conversation: never from a task a chat
 * message, a short-lived key, a household person, a schedule or another program started.
 */
function ownersOnly<T>(autonomy: Autonomy, work: (args: T) => unknown): (args: T, context: ToolContext) => Promise<unknown> {
  return async (args, context) => {
    if ((context.source ?? "owner") !== "owner" || !ownersOwnTask(autonomy.store, context.runId))
      throw new Error("Only the owner's own conversation can propose an automation; ask the owner to do it in Branch.");
    return work(args);
  };
}

const suggestions: Registrar = (registry, autonomy) => {
  registry.register({ name: "automation.ideas", permission: read, group: "automations",
    description: "The automation catalogue (blueprints with blanks) and the automations suggested for the owner right now. Reading only.",
    parameters: z.object({ starters: z.boolean().default(false) }).strict(),
    execute: async (args) => ({ catalogue: catalogue(), suggestions: autonomy.suggestions(args.starters) }) });
  registry.register({ name: "automation.propose", permission: propose, group: "automations",
    description: "Ask the owner whether to make an automation from a catalogue blueprint with its blanks filled. Nothing is scheduled until the owner says yes.",
    parameters: z.object({ blueprint: z.string().min(1).max(60), values, timezone: z.string().min(1).max(64).optional() }).strict(),
    execute: ownersOnly(autonomy, (args: { blueprint: string; values: Record<string, string>; timezone?: string | undefined }) => autonomy.proposeBlueprint(args)) });
};

const orders: Registrar = (registry, autonomy) => {
  registry.register({ name: "orders.list", permission: read, group: "automations",
    description: "The owner's standing orders: what each may do, when it runs, and how it last went.",
    parameters: z.object({}).strict(),
    execute: async () => autonomy.orders.list().map(({ id, order, status, pausedBecause, lastRun }) => ({ id, order, status, pausedBecause, lastRun })) });
  registry.register({ name: "orders.propose", permission: propose, group: "automations",
    description: "Ask the owner to hand over a standing order (a named programme with its authority, start, approval gate and escalation rules). It is made only on the owner's yes.",
    parameters: OrderSchema,
    execute: ownersOnly(autonomy, (args) => autonomy.orders.propose(args)) });
};

const procedures: Registrar = (registry, autonomy) => {
  registry.register({ name: "procedures.auto.list", permission: read, group: "automations",
    description: "The procedures that start themselves: their steps, level of autonomy, start and success rate.",
    parameters: z.object({}).strict(),
    execute: async () => autonomy.procedures.list() });
  registry.register({ name: "procedures.auto.propose", permission: propose, group: "automations",
    description: "Ask the owner to keep a procedure that starts itself (steps, start, and whether it asks before each step, before it starts, or runs on its own). It is kept only on the owner's yes.",
    parameters: ProcedureSchema,
    execute: ownersOnly(autonomy, (args) => autonomy.procedures.propose(args)) });
  registry.register({ name: "procedures.auto.suggest_change", permission: propose, group: "automations",
    description: "Suggest a change to one of the owner's procedures that start themselves (procedures.auto.list gives the id and the steps now): the whole new list of steps, the start if that changes too, and in one sentence why it would help. Nothing changes until the owner says yes; a change they said no to is never suggested again.",
    parameters: ProcedureSuggestionSchema,
    execute: async (args, context) => ownersOnly(autonomy, (input) => autonomy.procedures.suggestChange(input, context.trunk))(args, context) });
};

const readiness: Registrar = (registry, autonomy) => {
  registry.register({ name: "skills.readiness", permission: read, group: "skills",
    description: "Whether each installed skill that says what it needs has it on this computer (programs, keys, system), and how the owner could add what is missing.",
    parameters: z.object({}).strict(),
    execute: async () => autonomy.readiness() });
};

const instructions: Registrar = (registry, autonomy) => {
  registry.register({ name: "instructions.list", permission: read, group: "automations",
    description: "The standing instructions the owner has kept (\"from now on, ...\") and who each is for.",
    parameters: z.object({}).strict(),
    execute: async () => autonomy.instructions.list() });
  registry.register({ name: "instructions.propose", permission: propose, group: "automations",
    description: "When the owner asks you to always work a certain way from now on, ask them to keep it as a standing instruction (one short sentence in their words). It is kept only on their yes.",
    parameters: z.object({ text: z.string().trim().min(3).max(300), scope: z.string().max(100).default("assistant") }).strict(),
    execute: ownersOnly(autonomy, (args) => autonomy.instructions.propose(args, "assistant")) });
};

const registrars: Partial<Record<AutonomyPart, Registrar>> = { suggestions, orders, procedures, readiness, instructions };

export function registerAutonomyTools(registry: ToolRegistry, autonomy: Autonomy, part: AutonomyPart): void {
  registrars[part]?.(registry, autonomy);
}
