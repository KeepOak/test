import { z } from "zod";

/**
 * eng-trunk-controls: how Trunks and specialists work together on a room or a big task. The owner
 * picks a default in Customize › Specialists (saved with the orchestration settings); a room may
 * override it. "auto" is the default and means Branch picks per job, as it always has: the model
 * chooses between the ways below. Once the owner picks one, a multi-worker tool of another way is
 * only used after the owner's own yes (an approval card, asked once per conversation; src/runtime.ts).
 *
 * The labels and descriptions are the design's words (design/redesign/prototype.html PATTERNS15).
 * "Teams" (small groups, each with its own lead) has no engine form yet, so it is not one of them.
 */
export const teamPatterns = ["auto", "one", "super", "swarm", "router", "parallel"] as const;
export type TeamPattern = (typeof teamPatterns)[number];
export const TeamPatternSchema = z.enum(teamPatterns);

const patternWords: Record<Exclude<TeamPattern, "auto">, { label: string; means: string; tools: string }> = {
  one: { label: "One at a time", means: "A Trunk calls a specialist, waits, carries on.", tools: "specialists.delegate, one at a time" },
  super: { label: "A lead and helpers", means: "One Trunk plans and hands out the parts.", tools: "delegate.supervise" },
  swarm: { label: "Swarm", means: "Equals pass the work to whoever fits best.", tools: "delegate.swarm" },
  router: { label: "Router", means: "Sends each request to the one Trunk that matches.", tools: "delegate.route" },
  parallel: { label: "In parallel", means: "The same job split up, then gathered.", tools: "delegate.parallel or specialists.fanout" },
};

/**
 * The multi-worker tools and the way each one works. Handing one job to one specialist
 * (specialists.delegate, delegate.handoff) fits every way, and a debate between models is not
 * Trunks working together, so neither is listed.
 */
const toolPatterns: Record<string, Exclude<TeamPattern, "auto" | "one">> = {
  "delegate.supervise": "super",
  "delegate.swarm": "swarm",
  "delegate.route": "router",
  "delegate.parallel": "parallel",
  "specialists.fanout": "parallel",
};

export function patternOfTool(tool: string): Exclude<TeamPattern, "auto" | "one"> | null {
  return toolPatterns[tool] ?? null;
}

/**
 * The question the owner is asked when a tool would work another way than the one they chose, or
 * null when it fits (or the owner left it to Branch).
 */
export function patternQuestion(chosen: TeamPattern, tool: string): string | null {
  const used = patternOfTool(tool);
  if (chosen === "auto" || !used || used === chosen) return null;
  return `You chose "${patternWords[chosen].label}" for how Trunks work together. This job would use "${patternWords[used].label}" instead (${patternWords[used].means})`;
}

/** The sentence a task is told when the owner picked a way; nothing while it is left to Branch. */
export function patternNote(chosen: TeamPattern): string {
  if (chosen === "auto") return "";
  const words = patternWords[chosen];
  return `\n\nWhen several Trunks or specialists work on one job, the owner wants them to work this way: ${words.label} (${words.means}) Use ${words.tools} for it. Another way needs the owner's yes first.\n`;
}
