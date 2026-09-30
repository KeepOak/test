import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { LearningLoop } from "./loop.js";

/**
 * The "when needed" side of writing new skills: one short tool the assistant calls when the owner
 * asks for what was just done to become a skill. It only starts a draft; the draft is tried and
 * then waits for the owner. It exists only while writing new skills is not switched off.
 */
export const learnToolName = "skills.learn";
const LearnSchema = z.object({
  /** Anything the owner said about the skill they want ("call it…", "leave out…"). */
  notes: z.string().trim().max(2000).optional(),
  /** A completed media.watch/media.captions/web.fetch/files.read call in this task to learn from. */
  sourceCallId: z.string().trim().min(1).max(200).optional(),
}).strict();

export function syncLearnTool(registry: ToolRegistry, loop: LearningLoop): void {
  registry.unregister(learnToolName);
  if (loop.settings().newSkills === "off") return;
  registry.register({
    name: learnToolName, group: "skills", permission: "skills.manage", parameters: LearnSchema,
    description: "Start a skill draft when asked (/learn); the owner approves it. To make one from a video or tutorial already read, pass that completed media.watch/media.captions/web.fetch/files.read call's id as sourceCallId.",
    execute: async (value, context) => {
      const sessionId = loop.sessionOf(context.runId);
      if (!sessionId) throw new Error("This task has no conversation to learn from");
      loop.learn({ sessionId, notes: value.notes ?? "", runId: context.runId, ...(value.sourceCallId ? { sourceCallId: value.sourceCallId } : {}) });
      return { started: true, next: "A draft is being written and tried. It waits for the owner's yes under Customize, Skills." };
    },
  });
}
