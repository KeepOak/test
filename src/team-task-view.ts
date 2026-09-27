import type { Store } from "./store.js";
import { taskState, type TaskState } from "./activity.js";
import type { Team } from "./teams.js";
import { TeamTasks, type TeamTask } from "./team-tasks.js";
import { TeamHandoffs } from "./team-handoff.js";
import { dispatchHeld, latestCarryOn, memberRuns, type TeamMemberRun } from "./team-reconcile.js";

/**
 * Q64: the owner's view of a team's recent tasks, read from the records Q61 to Q66 keep and nothing
 * else. Each task says its state in Q51's words (the same `TaskState` the Activity pane reads, so there
 * is no second progress store), who holds it, each member's role, run, status and batch, an open
 * handoff, what blocks it, and its result. Reading it never settles, claims or runs anything: a claim
 * whose turn is gone is shown as blocked until somebody asks about it (Teams.run settles it then).
 *
 * A member whose role names a reviewer says which members it answers after. That comes only from the
 * batches the turn really started ("team.batch.started"): a member in a later batch starts after the
 * earlier batches have finished, while one in the same batch runs alongside the others and waits for
 * nobody. Either way it is given the task, not the other members' answers.
 */
export interface Party { kind: "branch" | "window" | "profile" | "person" | "key" | "member" | "unknown"; name: string | null }
export interface MemberView extends TeamMemberRun {
  /** The member run's own state in Q51's words (activity.ts `taskState`); null while it has no run. */
  task: TaskState | null;
  /** Only for a reviewer whose batch is known: the roles it answers after, and those it runs alongside. */
  after?: string[]; alongside?: string[];
}
export type ResultView =
  | { answers: { role: string; status: string; runId: string; output: string; cut: boolean }[] }
  | { truncated: true; roomSessionId: string | null }
  | { deleted: true };
export interface TeamTaskView {
  taskId: string; requestId: string; createdAt: string; updatedAt: string;
  task: TaskState; askedBy: Party; heldBy: Party | null; members: MemberView[];
  handoff: { to: Party; since: string; until: string; reason: string } | null;
  blocker: string | null; result: ResultView | null;
}

const answerChars = 600;
const reviewerRole = /review|relect/i;

/** The team's newest tasks, newest first, each as the owner sees it. */
export function teamTaskViews(store: Store, owner: string, team: Team, limit = 10): TeamTaskView[] {
  const tasks = new TeamTasks(store), handoffs = new TeamHandoffs(store);
  return tasks.recent(owner, team.id, limit).map((task) => {
    const offer = task.state === "claimed" ? handoffs.pendingFor({ owner, source: task.source }, task.taskId) : null;
    const party = (id: string) => partyOf(store, team, id);
    return {
      taskId: task.taskId, requestId: task.requestId, createdAt: task.createdAt, updatedAt: task.updatedAt,
      task: stateOf(store, tasks, task, offer !== null),
      askedBy: party(task.source),
      heldBy: task.state !== "claimed" ? null : task.bootId === null && task.claimant ? party(task.claimant) : { kind: "branch", name: null },
      members: withReviewOrder(namedWhileWorking(store, team, memberRuns(store, task.parentRunId)).map((member) => ({ ...member, task: memberState(store, member.runId) }))),
      handoff: offer ? { to: party(offer.offeredTo), since: offer.offeredAt, until: offer.expiresAt, reason: offer.reason } : null,
      blocker: blockerOf(task),
      result: resultOf(task),
    };
  });
}

/**
 * The task's state in Q51's words. A turn running here is working; one handed to a person is held by
 * them; a claim whose turn is gone waits for a handoff to be accepted, or else for its outcome to be checked.
 */
function stateOf(store: Store, tasks: TeamTasks, task: TeamTask, offered: boolean): TaskState {
  const at = (state: TaskState["state"], why: string): TaskState => ({ state, why, reason: "", lastUpdate: task.updatedAt, stale: false });
  switch (task.state) {
    case "pending": return at("queued", "run.queued");
    case "completed": return at("finished", "completed");
    // A failed team task is one that stopped before anything was done (src/team-tasks.ts), not a run that failed.
    case "failed": return at("finished", "nothing-done");
    case "waiting_owner": return at("waiting-owner", "attention.needed");
    case "needs_reconciliation": return at("blocked", "reconciliation.required");
    case "claimed":
      if (task.bootId === null) return at("working", "handoff.accepted");
      // An open offer waits on its recipient. It is never orphaned (src/team-tasks.ts), and a turn running
      // here cannot be offered away (src/team-handoff.ts), so it is checked before "is it working".
      if (offered) return at("blocked", "handoff.offered");
      if (!tasks.orphaned(task, dispatchHeld(store, task.taskId))) return at("working", "run.started");
      return at("blocked", "reconciliation.required");
  }
}
/**
 * Pass 18b: while a turn works, the fan-out record that names each member's run is not written yet, so its runs are
 * listed apart from the planned members. A run started as a member's specialist (run.started `agent`) is that member's
 * when exactly one planned member without a run has that specialist: the view names it, as the record will. Only the
 * view: reconcile reads the record as before.
 */
function namedWhileWorking(store: Store, team: Team, members: TeamMemberRun[]): TeamMemberRun[] {
  const specialistOf = (member: string | null) => (member?.startsWith("m") ? team.members[Number(member.slice(1))]?.specialistId ?? null : null);
  const waiting = members.filter((member) => member.member !== null && member.runId === null);
  const named = new Map<string, TeamMemberRun>();
  for (const lone of members.filter((member) => member.member === null && member.runId)) {
    const agent = store.events(lone.runId!).find((event) => event.kind === "run.started")?.data.agent;
    const mine = waiting.filter((member) => typeof agent === "string" && specialistOf(member.member) === agent && !named.has(member.member!));
    if (mine.length === 1 && waiting.filter((member) => specialistOf(member.member) === agent).length === 1) named.set(mine[0]!.member!, lone);
  }
  if (!named.size) return members;
  const taken = new Set([...named.values()]);
  return members.filter((member) => !taken.has(member)).map((member) => {
    const lone = member.member ? named.get(member.member) : undefined;
    return lone ? { ...member, runId: lone.runId, status: lone.status, batch: member.batch ?? lone.batch } : member;
  });
}
/** A member run's state, told by Q51 from its own record (the run that carried it on after a restart speaks for it, as in memberRuns). */
function memberState(store: Store, runId: string | null): TaskState | null {
  const run = runId ? store.run(latestCarryOn(store, runId)) : undefined;
  return run ? taskState(run, store.events(run.id)) : null;
}

/** What stops the task: the question it asked the owner, or why it failed or needs a person. */
function blockerOf(task: TeamTask): string | null {
  if (task.state === "waiting_owner") return task.question;
  if (task.state === "needs_reconciliation" || task.state === "failed") return task.error;
  return null;
}

/** A finished task's result: its answers (each cut to a few hundred characters), or that they were too large to keep, or deleted. */
function resultOf(task: TeamTask): ResultView | null {
  if (task.state !== "completed") return null;
  const result = task.result as { deleted?: boolean; truncated?: boolean; roomSessionId?: string; answers?: { role: string; status: string; runId: string; output?: string }[] } | null;
  if (result?.deleted) return { deleted: true };
  if (result?.truncated) return { truncated: true, roomSessionId: result.roomSessionId ?? null };
  return { answers: (result?.answers ?? []).map(({ role, status, runId, output = "" }) =>
    ({ role, status, runId, output: output.slice(0, answerChars), cut: output.length > answerChars })) };
}

/**
 * Adds, for each reviewer that ran in a known batch, the roles in earlier batches and those in its own.
 * One that never got a run is given no order: it did not answer after anybody.
 */
function withReviewOrder(members: MemberView[]): MemberView[] {
  return members.map((member) => {
    if (!member.role || !reviewerRole.test(member.role) || member.batch === null || !member.runId) return member;
    const others = members.filter((other) => other !== member && other.batch !== null && other.role);
    return { ...member,
      after: others.filter((other) => other.batch! < member.batch!).map((other) => other.role!),
      alongside: others.filter((other) => other.batch === member.batch).map((other) => other.role!) };
  });
}

/** Who a source or claimant is: the window, a household profile or person by name, a key, a team member by role. */
function partyOf(store: Store, team: Team, id: string): Party {
  if (id === "window") return { kind: "window", name: null };
  const [kind, rest] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  const profileName = () => store.profiles.list().find((profile) => profile.id === rest)?.name ?? null;
  if (kind === "profile" || kind === "person") return { kind, name: profileName() };
  if (kind === "key") return { kind: "key", name: null };
  if (kind === "member") return { kind: "member", name: team.members.find((member) => member.specialistId === rest)?.role ?? null };
  return { kind: "unknown", name: null };
}
