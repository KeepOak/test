import { z } from "zod";
import type { Store } from "./store.js";
import type { ModelRouter } from "./models.js";
import type { ApprovalGate, SessionGrant } from "./approvals.js";
import { placeTask } from "./dispatch-fallback.js";
import { defaultProjectId } from "./projects.js"; // dogfood-ux-2

/**
 * What a conversation is carrying, written down so it survives the app being closed: the model it
 * was set to, how hard it was asked to think, the project it belongs to, the toolboxes it had open
 * and the standing yeses given in it.
 *
 * The point of writing it down separately from the live settings is honesty. Asking the model
 * settings for a preset that has since been removed quietly answers "none", and asking for a
 * project that has been deleted quietly answers "default". A conversation that comes back after a
 * restart with a different model and a different project, saying nothing, is the thing this is
 * built to stop: the names are kept here, compared on the way back, and anything that could not be
 * put back is named in plain words rather than papered over.
 *
 * This is checkpoint-and-resume for a conversation and its tasks. A graph flow keeps its own place
 * in its own way (see src/flows.ts, built separately); nothing here touches it.
 */
const grantSchema = z.object({
  tool: z.string().max(200), target: z.string().max(500),
  decision: z.enum(["allow", "deny"]), fingerprint: z.string().max(200).nullable().default(null),
  grantedAt: z.string().max(40), expiresAt: z.string().max(40), label: z.string().max(300),
}).strict();
export const SessionCarrySchema = z.object({
  /** The model preset this conversation was set to, by name, or null for the workspace default. */
  preset: z.string().max(64).nullable().default(null),
  reasoning: z.enum(["low", "medium", "high"]).nullable().default(null),
  /** The project the last task in it ran under. */
  projectId: z.string().max(64).default("default"),
  /** The toolboxes that were open, newest choice first; only a few are carried back. */
  toolboxes: z.array(z.string().max(40)).max(8).default([]),
  grants: z.array(grantSchema).max(50).default([]),
  savedAt: z.string().max(40).default(""),
}).strict();
export type SessionCarry = z.infer<typeof SessionCarrySchema>;

/** The most toolboxes a conversation carries back, so a restart cannot bloat the first round. */
export const carriedToolboxLimit = 3;
const recordId = (sessionId: string): string => `session-carry:${sessionId}`;

export interface CarryDeps {
  store: Store;
  models: ModelRouter;
  approvals: ApprovalGate;
  /** The toolboxes this launch actually has; one that is gone is named rather than pretended. */
  toolboxes: () => readonly string[];
}
/** What a conversation was carrying, or nothing at all when it has never been written down. */
export function readSessionCarry(store: Store, owner: string, sessionId: string): SessionCarry | null {
  const saved = store.get("settings", owner, recordId(sessionId))?.data;
  if (!saved) return null;
  const parsed = SessionCarrySchema.safeParse(saved);
  return parsed.success ? parsed.data : null;
}

/**
 * phase2/rooms (integration review): forgets the answers a conversation carries into a restart, and
 * nothing else it carries (its model, project and toolboxes stay as they were written).
 */
export function dropCarriedGrants(store: Store, owner: string, sessionId: string): void {
  const carried = readSessionCarry(store, owner, sessionId);
  if (carried?.grants.length) store.save("settings", owner, recordId(sessionId), { ...carried, grants: [] });
}

/** Writes down what a conversation is carrying, at the end of a task. Never throws. */
export function rememberSessionCarry(
  deps: CarryDeps, owner: string, sessionId: string, opened: readonly string[] = [],
): SessionCarry | null {
  try {
    const model = deps.models.session(owner, sessionId);
    const value = SessionCarrySchema.parse({
      preset: model.preset ?? null, reasoning: model.reasoning ?? null,
      projectId: deps.store.sessionProject(sessionId) ?? deps.store.projects.active(owner).id, // dogfood D14: its own
      toolboxes: [...new Set(opened)].slice(0, carriedToolboxLimit),
      grants: deps.approvals.grants(sessionId).slice(0, 50),
      savedAt: new Date().toISOString(),
    });
    deps.store.save("settings", owner, recordId(sessionId), value);
    return value;
  } catch { return null; }
}

export interface CarryLoss { what: string; why: string }
export interface RestoredSession {
  sessionId: string;
  /** True when there was something written down to come back to at all. */
  found: boolean;
  preset: string | null;
  reasoning: "low" | "medium" | "high" | null;
  projectId: string;
  toolboxes: string[];
  permissions: SessionGrant[];
  /** Everything that could not be put back, each in one plain sentence. */
  notRestored: CarryLoss[];
}
const empty = (sessionId: string): RestoredSession => ({
  sessionId, found: false, preset: null, reasoning: null, projectId: "default",
  toolboxes: [], permissions: [], notRestored: [],
});

/**
 * Puts a conversation back the way it was after a restart, and says what it could not put back.
 * Nothing here throws: a conversation that comes back short is still a conversation.
 */
export function restoreSessionCarry(deps: CarryDeps, owner: string, sessionId: string): RestoredSession {
  const carried = readSessionCarry(deps.store, owner, sessionId);
  if (!carried) return empty(sessionId);
  const notRestored: CarryLoss[] = [];
  const preset = restoreModel(deps, owner, sessionId, carried, notRestored);
  const projectId = restoreProject(deps, owner, carried, notRestored);
  const toolboxes = restoreToolboxes(deps, carried, notRestored);
  const permissions = restoreGrants(deps, sessionId, carried, notRestored);
  return { sessionId, found: true, preset, reasoning: carried.reasoning, projectId, toolboxes, permissions, notRestored };
}

/**
 * The model the conversation was set to, where that connection is still set up. A choice made since
 * the note was written is newer than the note and is left exactly as it is: coming back must never
 * undo something the owner did afterwards.
 */
function restoreModel(
  deps: CarryDeps, owner: string, sessionId: string, carried: SessionCarry, lost: CarryLoss[],
): string | null {
  if (!carried.preset) return null;
  const live = deps.models.session(owner, sessionId);
  if (live.preset && live.preset !== carried.preset) return live.preset;
  try {
    deps.models.configureSession(owner, sessionId, { preset: carried.preset, reasoning: carried.reasoning });
    return carried.preset;
  } catch {
    // The same words a task gets when what it needs is not there: what is missing, and what instead.
    const now = deps.models.plan(owner, sessionId).choice;
    const moved = placeTask({ atOnce: 1, running: 0, missingPreset: carried.preset, fallbackPreset: now.presetName });
    lost.push({ what: `the model "${carried.preset}"`,
      why: `it is no longer set up on this computer. ${moved.alternative}` });
    return null;
  }
}

/** The project the conversation belongs to, where it still exists. It is not switched back to. */
function restoreProject(deps: CarryDeps, owner: string, carried: SessionCarry, lost: CarryLoss[]): string {
  const known = deps.store.projects.list(owner).some((project) => project.id === carried.projectId);
  if (known) return carried.projectId;
  // dogfood-ux-2: the default project, never whichever one the owner picked since, so its secrets are never lent.
  const active = deps.store.projects.of(owner, defaultProjectId);
  lost.push({ what: `the project "${carried.projectId}"`,
    why: `it has been removed, so this conversation is in "${active.name}" instead.` });
  return active.id;
}

function restoreToolboxes(deps: CarryDeps, carried: SessionCarry, lost: CarryLoss[]): string[] {
  const here = new Set(deps.toolboxes());
  const kept = carried.toolboxes.filter((group) => here.has(group)).slice(0, carriedToolboxLimit);
  for (const group of carried.toolboxes)
    if (!here.has(group))
      lost.push({ what: `the "${group}" toolbox`, why: "nothing in this launch offers it any more." });
  return kept;
}

/** Standing yeses, each with the moment it was always going to run out; an old one is not renewed. */
function restoreGrants(deps: CarryDeps, sessionId: string, carried: SessionCarry, lost: CarryLoss[]): SessionGrant[] {
  const back: SessionGrant[] = [];
  for (const grant of carried.grants) {
    if (deps.approvals.restoreGrant(sessionId, grant)) { back.push(grant); continue; }
    lost.push({ what: `permission for ${grant.label}`,
      why: "it had already run out while the app was closed, so it will be asked for again." });
  }
  return back;
}

/** One plain paragraph for the owner: what came back, and what did not. */
export function carrySentences(restored: RestoredSession): string[] {
  if (!restored.found) return ["This conversation had nothing written down to come back to."];
  const lines = [
    `This conversation came back with ${restored.preset ? `the model "${restored.preset}"` : "the model you usually use"}`
    + `, the project "${restored.projectId}", ${restored.permissions.length} standing permission`
    + `${restored.permissions.length === 1 ? "" : "s"} and ${restored.toolboxes.length} open toolbox`
    + `${restored.toolboxes.length === 1 ? "" : "es"}.`,
  ];
  for (const loss of restored.notRestored) lines.push(`I could not bring back ${loss.what}: ${loss.why}`);
  return lines;
}
