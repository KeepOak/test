import type { Store } from "../store.js";
import { currentPerson } from "../people/context.js";
import { profileScope } from "../profiles.js";

function refused(): never {
  throw new Error("The task's recorded person and conversation ownership are missing or conflicting. Reconcile its original identity before continuing.");
}

/** Establish person identity from this conversation's immutable continuation records, never the window's profile. */
export function recordedRecoveryPerson(store: Store, runId: string, owner: string): string | null {
  const root = store.run(runId);
  if (!root || !root.project || !store.ownsSession(root.owner, root.sessionId)) refused();
  const visiting = new Set<string>(), visited = new Set<string>();
  let person: string | null | undefined;
  let lent: string | undefined;
  const visit = (id: string): void => {
    if (visiting.has(id)) refused();
    if (visited.has(id)) return;
    if (visiting.size + visited.size >= 100) refused();
    const run = store.run(id);
    if (!run || run.owner !== root.owner || run.sessionId !== root.sessionId || run.project !== root.project) refused();
    const events = store.events(id);
    if (events.length >= 2000) refused();
    const starts = events.filter((event) => event.kind === "run.started");
    if (starts.length !== 1) refused();
    const start = starts[0]!.data;
    const recorded = start.personProfileId;
    if (recorded !== undefined && (typeof recorded !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(recorded))) refused();
    const identity = typeof recorded === "string" ? recorded : null;
    if (person !== undefined && person !== identity) refused();
    person = identity;
    if (start.lentTo !== undefined) {
      if (!identity || typeof start.lentTo !== "string" || start.lentTo !== profileScope(identity)
        || (lent !== undefined && lent !== start.lentTo)) refused();
      lent = start.lentTo;
    }
    visiting.add(id);
    for (const field of ["resumedFrom", "originFrom"] as const) {
      const link = start[field];
      if (link === undefined || link === null) continue;
      if (typeof link !== "string" || !link) refused();
      const prior = store.run(link);
      if (!prior) refused();
      if (prior.sessionId !== root.sessionId) {
        // A wake-up's provenance is not authority to adopt another conversation's person.
        if (field === "resumedFrom") refused();
        continue;
      }
      visit(link);
    }
    visiting.delete(id);
    visited.add(id);
  };
  visit(runId);
  const identity = person ?? null;
  const caller = currentPerson()?.profileId;
  if (caller && caller !== identity) refused();
  if (!identity) {
    if (root.owner !== owner || lent !== undefined) refused();
    return null;
  }
  if (!store.profiles.list().some((profile) => profile.id === identity)) refused();
  const scope = profileScope(identity);
  if (root.owner !== owner && (root.owner !== scope || lent !== scope)) refused();
  return identity;
}
