import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { Knowledge } from "./knowledge.js";
import { decomposeGoal, runSupervised } from "./orchestration-modes.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";
import type { Team, Teams } from "./teams.js";

/**
 * RES-721: Teams, the design's "Small groups, each with its own lead" (Customize › Specialists, how Trunks work
 * together). The groups are the owner's saved teams (Team › Teams of specialists): each team's lead is its member whose
 * role says "lead" (else its first member), and the rest are its helpers. A head splits the job between the teams, each
 * team's lead splits its part between its own helpers and writes that part's answer (the same "A lead and helpers" as
 * delegate.supervise), the teams work at the same time, and the head writes the one answer. Nothing new runs: every
 * part is an ordinary delegated task under the same budget, approval rules and record.
 */
const teamRef = z.string().trim().min(1).max(80);
export const TeamsRunSchema = z.object({
  /** Two to four of the owner's saved teams, by name or id. */
  teams: z.array(teamRef).min(2).max(4),
  goal: z.string().trim().min(1).max(8000),
  /** The specialist (by id) who splits the job between the teams and writes the answer; the first team's lead when left out. */
  head: z.string().trim().min(1).max(200).optional(),
}).strict();

export interface TeamShape { name: string; lead: string; helpers: string[] }

/** A saved team as a group: its lead (the member whose role says "lead", else the first) and its other members. */
export function shapeOf(team: Pick<Team, "name" | "members">): TeamShape {
  const lead = team.members.find((member) => /\blead\b/i.test(member.role)) ?? team.members[0]!;
  return { name: team.name, lead: lead.specialistId, helpers: team.members.filter((member) => member !== lead).map((member) => member.specialistId) };
}

function findTeams(teams: Pick<Teams, "list">, refs: readonly string[]): TeamShape[] {
  const saved = teams.list();
  const found = refs.map((ref) => saved.find((team) => team.id === ref || team.name.toLowerCase() === ref.toLowerCase()));
  const missing = refs.filter((_, index) => !found[index]);
  if (missing.length) throw new Error(`There is no saved team called ${missing.join(", ")}. Make one under Team › Teams of specialists.`);
  const shapes = found.map((team) => shapeOf(team!));
  if (new Set(shapes.map((shape) => shape.name)).size !== shapes.length) throw new Error("Name each team once.");
  return shapes;
}

export async function runTeams(runtime: Runtime, knowledge: Knowledge, teams: Pick<Teams, "list">, context: ToolContext, input: unknown) {
  const { teams: refs, goal, head: chosenHead } = TeamsRunSchema.parse(input);
  const shapes = findTeams(teams, refs);
  const head = chosenHead ?? shapes[0]!.lead;
  const ask = async (prompt: string): Promise<string> => {
    const spec = knowledge.activeSpecialist(context.owner, head);
    const { run } = await runtime.delegateChecked(prompt, context, spec.permissions, spec.instructions, { agent: head });
    return run.output;
  };
  // The head's split is by team: each team's name is the "person" a part goes to.
  const parts = await decomposeGoal(ask, goal, shapes.map((shape) => shape.name));
  const byTeam = new Map<string, string[]>();
  for (const part of parts) byTeam.set(part.specialist, [...(byTeam.get(part.specialist) ?? []), part.prompt]);
  const results = await Promise.all([...byTeam].map(async ([name, prompts]) => {
    const shape = shapes.find((one) => one.name === name)!;
    const part = prompts.join("\n\n");
    try {
      const done = await runSupervised(runtime, knowledge, context, { supervisor: shape.lead, workers: shape.helpers.length ? shape.helpers : [shape.lead], goal: part });
      return { team: name, lead: shape.lead, part, status: "completed", output: done.output };
    } catch (error) { return { team: name, lead: shape.lead, part, status: "failed", output: (error as Error).message }; }
  }));
  const output = await ask(`You split this job between teams and each team's lead has sent back its part. Write the one answer for the person, saying plainly where a part failed or where two parts disagree.\n\nThe job: ${goal}\n\n${
    results.map((result) => `[${result.team}] ${result.status === "completed" ? result.output : `(nothing: ${result.output})`}`).join("\n\n")}`);
  if (context.runId)
    runtime.store.event(context.runId, "orchestration.teams", { head, teams: results.map((result) => ({ team: result.team, lead: result.lead, status: result.status })) });
  return { head, teams: results, output };
}

export function registerTeamGroups(registry: ToolRegistry, runtime: Runtime, knowledge: Knowledge, teams: Pick<Teams, "list">): void {
  registry.register({
    name: "delegate.teams",
    description: "Small groups, each with its own lead: a head splits the job between the owner's saved teams, each team's lead shares its part among its members, then the head writes the answer.",
    permission: "specialists.use",
    parameters: TeamsRunSchema,
    execute: async (a, c) => runTeams(runtime, knowledge, teams, c, a),
  });
}
