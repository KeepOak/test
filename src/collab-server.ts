import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";
import type { Run } from "./contracts.js";
import type { RunOptions } from "./runtime.js";
import { ShareRequestSchema, ShareLinkSchema } from "./conversation-share.js";
import { audit } from "./audit.js";
import { labelTargets } from "./labels.js";
import { PolicyRememberSchema } from "./policy.js";
import { roleLabels } from "./profile-roles.js";
import { ownerMember, publishGitPatch, reservedKinds } from "./collab-events.js";

/**
 * The web routes for sharing, labels and notes, saved workflows, the waiting line for tasks, days
 * off and quiet hours, and the household's profiles. They live here so the main server file only
 * gains one line. Everything reads and writes under whichever profile is in use: the owner's own
 * secrets and projects are refused while somebody else's profile is switched on.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
type ReadBody = (maximumBytes?: number) => Promise<unknown>;
/** Marks a path this file does not serve, so the main server can carry on looking. */
export const notCollab = Symbol("not a collaboration route");

const idPattern = "[a-f0-9-]{36}";
const projectId = z.object({ project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/) }).strict();

/** Everything the Sharing, Workflows, Waiting line, Days off and People panels show. */
export function collabState(app: Branch): unknown {
  const owner = app.runtime.owner, profiles = app.store.profiles, scope = profiles.scope();
  // Q75: each card says what Branch really holds that person to (their groups narrow it). The owner
  // sees everyone's; somebody else sees only their own.
  const held = app.runtime.roles.all(profiles.list().map((profile) => profile.id));
  const roles = profiles.isOwner() ? held : held.filter((entry) => entry.profileId === profiles.active()?.id);
  const person = { active: profiles.active(), all: profiles.list(), isOwner: profiles.isOwner(), ownerPin: profiles.ownerPinOn(), roles, roleLabels };
  // Shared copies, saved workflows, the waiting line and days off are the owner's, so a screen
  // opened under somebody else's profile shows their labels and nothing of the owner's. Q258: that includes the
  // owner's days off, time zone and quiet hours (GET /api/state collab.calendar).
  if (!profiles.isOwner())
    return { profile: person, labels: app.store.labels.catalog(scope), shares: [], workflows: [],
      queue: { waiting: [], recent: [], settings: app.runQueue.settings(owner) },
      calendar: { settings: null, countries: [] } };
  return {
    profile: person,
    labels: app.store.labels.catalog(scope),
    shares: app.store.shares.list(owner),
    workflows: app.workflows.list(owner),
    queue: { waiting: app.runQueue.list(owner), recent: app.runQueue.recent(owner), settings: app.runQueue.settings(owner) },
    calendar: { settings: app.calendar.settings(owner), countries: app.calendar.countries() },
  };
}

export async function collabApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody):
  Promise<unknown | typeof notCollab> {
  const get = request.method === "GET", post = request.method === "POST";
  if (get && path === "/api/collab") return collabState(app);
  const shared = await sharingApi(app, request, path, body);
  if (shared !== notCollab) return shared;
  const labelled = await labelsApi(app, request, path, body);
  if (labelled !== notCollab) return labelled;
  const flow = await workflowsApi(app, request, path, body);
  if (flow !== notCollab) return flow;
  const queued = await queueApi(app, request, path, body);
  if (queued !== notCollab) return queued;
  const events = await eventsApi(app, request, path, body);
  if (events !== notCollab) return events;
  // Days off and quiet hours are the owner's settings and affect everything the app sends.
  if (get && path === "/api/calendar") {
    app.store.profiles.requireOwner("Days off and quiet hours");
    return { settings: app.calendar.settings(app.runtime.owner), countries: app.calendar.countries() };
  }
  if (post && path === "/api/calendar") {
    app.store.profiles.requireOwner("Days off and quiet hours");
    return app.calendar.configure(app.runtime.owner, await body());
  }
  return profilesApi(app, request, path, body);
}

/** A conversation as a page: the file itself, or a read-only link with a code and an expiry. */
async function sharingApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  // Shared copies belong to whoever is using the app: somebody else's profile must not be able to
  // mint a link to a conversation of the owner's, nor see the links the owner has handed out.
  const owner = app.store.profiles.scope();
  const share = new RegExp(`^/api/sessions/(${idPattern})/share$`).exec(path);
  if (share && request.method === "POST") {
    const input = ShareLinkSchema.parse({ ...(await body() as object), sessionId: share[1]! });
    if (!app.store.ownsSession(owner, input.sessionId)) throw new Error("Conversation not found");
    return app.store.shares.create(owner, input, app.store.messages(input.sessionId));
  }
  if (request.method === "GET" && path === "/api/shares") return { shares: app.store.shares.list(owner) };
  const revoke = new RegExp(`^/api/shares/(${idPattern})/revoke$`).exec(path);
  if (revoke && request.method === "POST") { await body(); return app.store.shares.revoke(owner, revoke[1]!); }
  return notCollab;
}

async function labelsApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const scope = app.store.profiles.scope(), labels = app.store.labels;
  const get = request.method === "GET", post = request.method === "POST";
  if (get && path === "/api/labels") {
    const target = new URL(request.url ?? "/", "http://local").searchParams.get("target");
    const chosen = labelTargets.find((kind) => kind === target);
    return { catalog: labels.catalog(scope, chosen), labels: labels.list(scope, chosen) };
  }
  if (post && path === "/api/labels") return labels.add(scope, await body());
  if (post && path === "/api/labels/remove") return labels.remove(scope, await body());
  if (get && path === "/api/projects/notes") {
    const { project } = projectId.parse({ project: new URL(request.url ?? "/", "http://local").searchParams.get("project") ?? "default" });
    return { project, notes: labels.comments(scope, project) };
  }
  if (post && path === "/api/projects/notes") return labels.comment(scope, await body());
  const remove = new RegExp(`^/api/projects/notes/(${idPattern})/remove$`).exec(path);
  if (remove && post) { await body(); return labels.removeComment(scope, remove[1]!); }
  return notCollab;
}

async function workflowsApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const owner = app.runtime.owner, workflows = app.workflows;
  if (!path.startsWith("/api/workflows")) return notCollab;
  // A workflow's steps use tools with the owner's full run of the app, so only the owner may see
  // one or set one going.
  app.store.profiles.requireOwner("Saved workflows");
  if (request.method === "GET" && path === "/api/workflows") return { workflows: workflows.list(owner) };
  if (request.method === "POST" && path === "/api/workflows") return workflows.create(owner, await body());
  const match = new RegExp(`^/api/workflows/(${idPattern})(?:/(run|pause|resume|remove))?$`).exec(path);
  if (!match) return notCollab;
  if (request.method === "GET" && !match[2]) return workflows.view(owner, match[1]!);
  if (request.method !== "POST") return notCollab;
  const sent = await body();
  if (match[2] === "run") return workflows.run(owner, match[1]!);
  if (match[2] === "pause") return workflows.pause(owner, match[1]!);
  if (match[2] === "resume") {
    // Carrying on a workflow that stopped to ask is the owner saying yes, from their own screen.
    // They may say it just for this workflow (the default) or keep it as a standing rule.
    const remember = PolicyRememberSchema.safeParse((sent as { remember?: unknown } | null)?.remember);
    return workflows.resume(owner, match[1]!, remember.success ? { remember: remember.data } : {});
  }
  if (match[2] === "remove") return workflows.remove(owner, match[1]!);
  return notCollab;
}

async function queueApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const owner = app.runtime.owner, queue = app.runQueue;
  if (!path.startsWith("/api/queue")) return notCollab;
  // A task from the waiting line runs with the owner's own run of the app, so somebody else's
  // profile may not put one in it. They can still start a task the ordinary way.
  app.store.profiles.requireOwner("The waiting line");
  if (request.method === "GET" && path === "/api/queue")
    return { waiting: queue.list(owner), recent: queue.recent(owner), settings: queue.settings(owner) };
  if (request.method === "POST" && path === "/api/queue") return queue.submit(owner, await body());
  if (request.method === "POST" && path === "/api/queue/settings") return queue.configure(owner, await body());
  const cancel = new RegExp(`^/api/queue/(${idPattern})/cancel$`).exec(path);
  if (cancel && request.method === "POST") { await body(); return queue.cancel(owner, cancel[1]!); }
  return notCollab;
}

/**
 * Signed collaboration events. A new event is always published under whoever is using the app,
 * never under a member named in the request; a received event is kept only if its signature holds.
 * Every household member may read and publish; taking in a relay's event and publishing a git patch
 * are the owner's alone, and src/server.ts refuses them to a household profile before this runs
 * (src/household-routes.ts). A household profile's listing leaves the owner-only kinds out.
 */
async function eventsApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const owner = app.runtime.owner, events = app.store.collabEvents;
  if (request.method === "GET" && path === "/api/collab/events") {
    const query = new URL(request.url ?? "/", "http://local").searchParams;
    return events.list(owner, { kind: query.get("kind") ?? undefined, text: query.get("q") ?? undefined,
      repository: query.get("repository") ?? undefined }, { ownerView: app.store.profiles.isOwner() });
  }
  if (request.method !== "POST") return notCollab;
  if (path === "/api/collab/events") {
    const input = z.object({ kind: z.string(), payload: z.record(z.string(), z.unknown()) }).strict().parse(await body());
    // One path per kind: a patch here would skip its own checks, so it is sent to its route instead.
    const reserved = reservedKinds.get(input.kind);
    if (reserved) throw new Error(`A ${input.kind} event is published through ${reserved.route}`);
    return events.publish(owner, app.store.profiles.active()?.id ?? ownerMember, input.kind, input.payload);
  }
  const known = (repository: string) => app.store.projects.list(owner).some((project) => project.id === repository);
  if (path === "/api/collab/events/receive") return events.receive(owner, await body(), known);
  if (path === "/api/collab/git-patches") {
    return publishGitPatch(events, owner, app.store.profiles.active()?.id ?? ownerMember, await body(), known);
  }
  return notCollab;
}

/** The role somebody new may be given as they are added; the owner's own is not one of them. */
const NewPersonRoleSchema = z.enum(["adult", "child"]).default("adult");

async function profilesApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const profiles = app.store.profiles;
  if (request.method === "GET" && path === "/api/profiles") {
    const allRoles = app.runtime.roles.all(profiles.list().map((profile) => profile.id));
    // When a household person (not the owner) calls this, they see effective and categories only for their own entry
    const roles = !profiles.isOwner() && profiles.active()
      ? allRoles.map((entry) => entry.profileId === profiles.active()!.id
          ? entry
          : { profileId: entry.profileId, grant: entry.grant })
      : allRoles;
    return { profiles: profiles.list(), active: profiles.active(), isOwner: profiles.isOwner(), ownerPin: profiles.ownerPinOn(),
      // Batch 26 (wave 8): what each person may have Branch do, for the card beside their name.
      roles, roleLabels };
  }
  if (request.method === "POST" && path === "/api/profiles") {
    profiles.requireOwner("Adding somebody to this computer");
    // The role comes with the name and PIN, and is checked before anybody is added, so a Child is
    // never left behind as an Adult by a second call that failed.
    const { role, ...person } = (await body() ?? {}) as { role?: unknown };
    const chosen = NewPersonRoleSchema.parse(role);
    const made = profiles.create(person);
    if (chosen !== "adult") app.runtime.roles.save(made.id, { role: chosen });
    // unhold/people: who was added and as what is written down; the PIN never is.
    audit(app.store, app.runtime.owner, {
      action: "policy.changed", actor: app.runtime.owner, subject: `${made.name}'s profile`,
      reason: `The owner added somebody to this computer as ${roleLabels[chosen].label}`, outcome: "added",
    });
    return made;
  }
  if (request.method === "POST" && path === "/api/profiles/switch") {
    const switched = profiles.switch(await body());
    // Batch 20 (wave 8): who is using the computer decides whose records are reachable, so every
    // switch is written down — the move back to the owner included.
    audit(app.store, app.runtime.owner, {
      action: "profile.switched", actor: switched.active?.name ?? app.runtime.owner,
      subject: switched.active ? `${switched.active.name}'s profile` : "back to you",
      reason: "Somebody switched who is using this computer", outcome: "switched",
    });
    return switched;
  }
  // household-followups: the owner's PIN for switching back (off until the owner sets one).
  if (request.method === "POST" && path === "/api/profiles/owner-pin") {
    const saved = profiles.setOwnerPin(await body());
    audit(app.store, app.runtime.owner, {
      action: "policy.changed", actor: app.runtime.owner, subject: "switching back to you",
      reason: saved.ownerPin ? "The owner set a PIN for switching back" : "The owner switched the PIN for switching back off",
      outcome: saved.ownerPin ? "on" : "off",
    });
    return saved;
  }
  // The role and grant on one profile. Only the owner may set what anybody else is allowed to do.
  const role = new RegExp(`^/api/profiles/(${idPattern})/role$`).exec(path);
  if (role && request.method === "POST") {
    profiles.requireOwner("Deciding what somebody here may do");
    const saved = app.runtime.roles.save(role[1]!, await body());
    // unhold/people: what somebody here may do is written down each time the owner changes it.
    const name = profiles.list().find((profile) => profile.id === role[1])?.name ?? "somebody";
    audit(app.store, app.runtime.owner, {
      action: "policy.changed", actor: app.runtime.owner, subject: `${name}'s role`,
      reason: `The owner set what ${name} may do: ${roleLabels[saved.role].label}`, outcome: "saved",
    });
    return saved;
  }
  if (role && request.method === "GET") return app.runtime.roles.get(role[1]!);
  const remove = new RegExp(`^/api/profiles/(${idPattern})/remove$`).exec(path);
  if (remove && request.method === "POST") {
    profiles.requireOwner("Removing somebody from this computer");
    await body();
    const name = profiles.list().find((profile) => profile.id === remove[1])?.name;
    const removed = profiles.remove(remove[1]!);
    if (removed.removed) audit(app.store, app.runtime.owner, { // unhold/people
      action: "policy.changed", actor: app.runtime.owner, subject: `${name}'s profile`,
      reason: "The owner removed somebody from this computer", outcome: "removed",
    });
    if (removed.removed) app.people.forgetProfile(remove[1]!); // bucket 19: their sign-ins, passkeys and shares go too
    return removed;
  }
  return notCollab;
}

/** Everything the assistant's share request needs checked before a page is written. */
export const shareRequest = ShareRequestSchema;

/**
 * Runs a task for whoever is using the app. The assistant always works as the owner, so a second
 * person's conversation is lent to it for the length of the task and handed straight back, and the
 * finished conversation stays in their list rather than the owner's.
 */
export async function runForCurrentPerson(app: Branch, options: RunOptions): Promise<Run> {
  const profiles = app.store.profiles;
  if (profiles.isOwner()) return app.runtime.run(options);
  const scope = profiles.scope();
  if (options.sessionId && !app.store.ownsSession(scope, options.sessionId))
    throw new Error("Conversation not found");
  if (options.sessionId) app.store.reassignSession(options.sessionId, app.runtime.owner);
  try {
    // bucket 19 (integration review): the task writes down whose conversation is lent (src/people/lending.ts).
    const run = await app.runtime.run({ ...options, lentTo: scope });
    app.store.reassignSession(run.sessionId, scope);
    return run;
  } catch (error) {
    if (options.sessionId) app.store.reassignSession(options.sessionId, scope);
    throw error;
  }
}
