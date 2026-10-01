import { createHash } from "node:crypto";
import type { StoredPlan } from "./orchestration.js";

export interface PlanProgress {
  goalId: string; actionIds: string[]; phase: "steps" | "wrap" | "review";
  retried: boolean; reviews: number; fixes: string[];
}
const identity = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Stable identities are attribution only, never proof that an in-flight action is safe to replay. */
export function planProgress(plan: StoredPlan): PlanProgress {
  const saved = plan.progress;
  const goalId = saved && /^[0-9a-f]{64}$/.test(saved.goalId) ? saved.goalId
    : identity([plan.sessionId, plan.createdAt, plan.prompt]);
  const unfinished = plan.steps.some((step) => step.status !== "done");
  return { goalId, actionIds: plan.steps.map((step, index) =>
    identity([goalId, index, step.title, step.touches ?? null, step.changes, step.check ?? null])),
    phase: unfinished ? "steps" : saved?.phase === "review" ? "review" : "wrap",
    retried: saved?.retried === true,
    reviews: saved && Number.isInteger(saved.reviews) ? Math.max(0, Math.min(2, saved.reviews)) : 0,
    fixes: Array.isArray(saved?.fixes) ? saved.fixes.filter((fix) => typeof fix === "string").slice(0, 3).map((fix) => fix.slice(0, 500)) : [] };
}
