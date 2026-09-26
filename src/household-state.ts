import type { createBranch } from "./index.js";
import { auditActions, auditLabel, type AuditEntry, type AuditQuery } from "./audit.js";
import { assistantIdentity } from "./identity.js";
import { mayAnswerHere } from "./household-approvals.js";
import { orchestrationSettings } from "./orchestration.js";
import { secondOpinionSettings } from "./second-opinion.js";
import { askFirstSettings } from "./ask-first.js";
import { decisionsFromRules } from "./tool-categories.js";
import { readPolicy } from "./policy.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;

/**
 * Q258: the parts of GET /api/state that are the owner's own: their record of what was allowed, their approval
 * categories, their settings (learning, ask-first, practice, ordering, orchestration, second opinion, network, privacy),
 * their projects and workspace folder, their automations, skills, add-ons and secret reminders, and the instructions
 * they gave the assistant. The owner reads them as they are. A household person at the window gets the same keys,
 * each either narrowed to their own tasks (what was allowed, suggested memories, background results) or empty, so
 * the window draws exactly as before and nothing of the owner's is sent.
 */
export function ownerStateParts(app: Branch) {
  const owner = app.runtime.owner, store = app.store;
  return {
    project: { active: store.projects.active(owner) as unknown, all: store.projects.list(owner) as unknown[] },
    workspace: app.runtime.workspace as string | null,
    identity: assistantIdentity(store, owner),
    learning: store.review.settings(owner) as unknown,
    // Batch 19 (wave 6)
    allowed: { counts: store.audit.counts(owner), recent: store.audit.list(owner, { limit: 20 }) },
    approvalCategories: decisionsFromRules(app.registry, readPolicy(store, owner).rules) as unknown[],
    askFirst: askFirstSettings(store, owner) as unknown,
    practice: app.practice.state(owner) as unknown,
    reranking: app.retrieval.view(owner) as unknown,
    providerPlugins: app.providerPlugins.list() as unknown[],
    issueTrackers: (app.issues?.available() ?? []) as unknown[],
    orchestration: orchestrationSettings(store, owner) as unknown,
    secondOpinion: secondOpinionSettings(store, owner) as unknown,
    background: app.runtime.backgroundResults as unknown[],
    hooks: app.hooks.list() as unknown[],
    setAside: store.governance.exclusions() as unknown[],
    consolidation: store.review.cursor(owner) as unknown,
    network: app.web.policy.settings() as unknown,
    memoryProposals: store.review.proposals(owner) as unknown[],
    memoryCheckpoints: store.review.checkpoints(owner) as unknown[],
    snapshots: store.workspaceHistory.snapshots() as unknown[],
    skills: store.skills.list(owner) as unknown[],
    skillPolicy: store.skills.policy(owner) as unknown,
    specialists: store.list("specialists", owner) as unknown[],
    procedures: store.list("procedures", owner) as unknown[],
    schedules: store.list("schedules", owner) as unknown[],
    triggers: app.triggers.list(owner) as unknown[],
    webhooks: app.webhooks.list(owner) as unknown[],
    privacy: app.privacy.settings() as unknown,
    secretReminders: store.secrets.reminders(owner, store.projects.list(owner).map((p) => p.id)) as unknown[],
  };
}
export type OwnerStateParts = ReturnType<typeof ownerStateParts>;

/** The ids of the tasks that are the household person's own: in their conversations, and started for them. */
export function ownRunIds(app: Branch): Set<string> {
  const store = app.store;
  return new Set(store.runs(store.profiles.scope())
    .filter((run) => mayAnswerHere(store, { runId: run.id, sessionId: run.sessionId })).map((run) => run.id));
}

/**
 * The owner's record narrowed to the person's own tasks (filtered as asked, then cut to `limit`), and counted from
 * what is left. Q259: GET /api/audit and its spreadsheet read it too, not only GET /api/state.
 */
function ownRecord(app: Branch, own: Set<string>, query: Partial<AuditQuery>, limit: number) {
  const mine = app.store.audit.list(app.runtime.owner, { ...query, limit: 1000 }).filter((entry) => entry.runId !== null && own.has(entry.runId));
  const counts = auditActions.map((action) => ({ action, label: auditLabel(action), count: mine.filter((entry) => entry.action === action).length }));
  return { entries: mine.slice(0, limit), counts };
}

/** What was allowed for the person's own tasks only: the owner's record narrowed to them, and counted from that. */
function ownAllowed(app: Branch, own: Set<string>): OwnerStateParts["allowed"] {
  const { entries, counts } = ownRecord(app, own, {}, 20);
  return { counts, recent: entries };
}

/** Q259: GET /api/audit and its spreadsheet for a household person at the window. */
export function ownAudit(app: Branch, query: AuditQuery): { entries: AuditEntry[]; counts: OwnerStateParts["allowed"]["counts"] } {
  return ownRecord(app, ownRunIds(app), query, query.limit);
}

/** The same keys for a household person at the window: their own, or empty. */
export function householdStateParts(app: Branch): OwnerStateParts {
  const store = app.store, own = ownRunIds(app);
  const identity = assistantIdentity(store, app.runtime.owner);
  return {
    project: { active: null, all: [] },
    workspace: null,
    // The assistant's name is drawn on every reply; the instructions the owner gave it are theirs.
    identity: { ...identity, instructions: "" },
    learning: null,
    allowed: ownAllowed(app, own),
    approvalCategories: [],
    askFirst: null,
    practice: null,
    reranking: null,
    providerPlugins: [],
    issueTrackers: [],
    orchestration: null,
    secondOpinion: null,
    background: app.runtime.backgroundResults.filter((result) => own.has(result.parentRunId)),
    hooks: [],
    setAside: [],
    consolidation: null,
    network: null,
    memoryProposals: store.review.proposals(app.runtime.owner).filter((proposal) => own.has(proposal.runId)),
    memoryCheckpoints: [],
    snapshots: [],
    skills: [],
    skillPolicy: null,
    specialists: [],
    procedures: [],
    schedules: [],
    triggers: [],
    webhooks: [],
    privacy: null,
    secretReminders: [],
  };
}
