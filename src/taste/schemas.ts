import { z } from "zod";

export const Domain = z.enum(["writing", "design", "interaction", "decisions"]);
export const Scope = z.object({ memoryOwner: z.string().min(1).max(200), agent: z.string().max(200).nullable(), project: z.string().max(200).nullable() }).strict();
export type TasteScope = z.infer<typeof Scope>;
export const Feedback = z.object({
  sessionId: z.string().uuid(), messageId: z.number().int().positive(),
  outcome: z.enum(["accept", "reject", "edit"]), explanation: z.string().trim().max(2000).default(""),
  replacement: z.string().trim().max(8000).default(""), remember: z.literal(true),
}).strict().refine(value => value.outcome !== "edit" || !!value.replacement, "An edit needs your replacement text.");
export const Extraction = z.object({
  disposition: z.enum(["durable", "factual", "temporary", "insufficient"]),
  preferences: z.array(z.object({ domain: Domain, text: z.string().trim().min(1).max(400),
    evidence: z.string().trim().min(3).max(1000) }).strict()).max(3),
}).strict();
export const Preference = z.object({
  id: z.string().uuid(), scope: Scope, domain: Domain, text: z.string().min(1).max(400),
  revision: z.number().int().positive(), sessionId: z.string().uuid(), messageId: z.number().int().positive(),
  feedbackId: z.string(), evidence: z.string().max(1000), updatedAt: z.string(),
  history: z.array(z.object({ revision: z.number(), text: z.string(), at: z.string() }).strict()).max(10),
}).strict();
export type TastePreference = z.infer<typeof Preference>;
export const Receipt = z.object({ id: z.string(), scope: Scope, disposition: Extraction.shape.disposition,
  preferenceIds: z.array(z.string()), at: z.string() }).strict();
export type TasteReceipt = z.infer<typeof Receipt>;
export const Saved = z.object({ preferences: z.array(Preference).max(120), receipts: z.array(Receipt).max(200) }).strict();
export type TasteState = z.infer<typeof Saved>;
export const sameScope = (left: TasteScope, right: TasteScope): boolean =>
  left.memoryOwner === right.memoryOwner && left.agent === right.agent && left.project === right.project;
