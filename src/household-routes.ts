/**
 * profile-audit: what the app window may still change while it is switched to a household profile.
 *
 * Switching the window to somebody else's profile makes the window that person (src/profiles.ts).
 * The owner's own parts of Branch — settings of every kind, permissions, secrets and sign-ins, the
 * sandbox and network, chat apps and pairing, devices and the phone, integrations, add-ons and
 * skills, backups and restores, updates, the danger zone and the people here — are refused to them
 * in one sentence, at one place in src/server.ts, before any route's own code runs.
 *
 * The rule fails closed, like the short-lived key's (src/short-lived-keys.ts): anything a
 * short-lived key is refused is refused here too, unless it is listed below as something a person
 * does with their own things (their conversations, what is remembered for them, notes, lists), or
 * is one of the two ways out of a profile. A route added later is the owner's until
 * somebody lists it here, and tests/household-profile.test.mjs fails until the table in
 * tests/short-lived-key-routes.mjs and this list agree.
 *
 * Out of the box this is separation on one computer, not a lock: going back to the owner's profile
 * needs no PIN. The owner may set one (src/profiles.ts, household-followups), and then it is a lock
 * against somebody at the keyboard — still not against somebody who can open the data folder.
 *
 * household-followups: clearing old conversations (/api/retention/prune), writing the usage file now,
 * sending the morning brief to the owner's chats, and putting back an older version of a file or a
 * whole snapshot in the owner's workspace (/api/history/restore, /api/history/snapshots/:id/restore)
 * are the owner's: each works on the owner's records or reaches the owner's chats. Importing
 * conversations and remembered facts stays a person's own, because both write only under the
 * profile switched on (profiles.scope()); taking a snapshot changes nothing and stays too.
 *
 * Q262: a route that writes (or searches) one of the owner's own stores is the owner's, whatever else would let it
 * through, a short-lived key's task routes included: householdOwnerStores below, checked first in src/server.ts
 * offLimitsToHousehold. The owner's document library and knowledge bases are what the owner's tasks retrieve, so text a
 * household person put there would steer the owner's tasks; a watch fetches on the owner's network rules and announces
 * to the owner. The engine keeps none of these per person, so they are refused rather than scoped.
 */
import type { TaskRoute } from "./short-lived-keys.js";

const id = "[a-f0-9-]{36}";
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One of a person's own routes, written as the table writes it (":id" for any id). */
const own = (path: string, methods = "POST"): TaskRoute[] => methods.split(",").map((method) => ({
  method: method as TaskRoute["method"],
  pattern: new RegExp(`^${path.split(":id").map(escape).join(id)}$`),
  why: "a household person's own things",
}));

/**
 * The one sentence, the same one `Profiles.requireOwner` says. Two areas already promised to name
 * themselves in it (the chat apps and their Set up panel); everything else is "This".
 */
export const householdRefusal = "This belongs to the owner. Switch back to the owner's profile to use it.";
const areaWords: readonly [RegExp, string][] = [
  [/^\/api\/channels(\/|$)/, "Your chat apps"],
  [/^\/api\/channel-setup(\/|$)/, "Setting up chat apps"],
];
export function householdRefusalFor(path: string): string {
  const what = areaWords.find(([pattern]) => pattern.test(path))?.[1];
  return what ? householdRefusal.replace("This", what) : householdRefusal;
}

/** The routes a household person at the window may change something through, beyond a task's. */
export const householdOwnRoutes: readonly TaskRoute[] = [
  // The two ways out: switching back to the owner (or to somebody else), and locking the window.
  ...own("/api/profiles/switch"),
  ...own("/api/lock"),
  // App lock: and the way back in. While Branch is locked with a PIN nothing else is answered, a
  // switch back to the owner included, so a window left on a household profile would stay shut for
  // good. The PIN is the guard here (src/session-lock.ts); setting or removing it stays the owner's.
  ...own("/api/lock/unlock"),
  // The route itself accepts only the active person's own Trunk, never an owner's or another person's files.
  ...own("/api/trunks/:id/files", "GET,POST"),
  // The table's "other" rows: a person's own conversations, memory, documents, notes and lists.
  ...[
    own("/api/asks/analytics/event"),
    own("/api/asks/answer"),
    own("/api/asks/article"),
    own("/api/asks/blocks/run"),
    own("/api/asks/hindsight/recall"),
    own("/api/asks/intents/decide"),
    own("/api/asks/nodes/ask"),
    own("/api/asks/nodes/check"),
    own("/api/asks/pages"),
    own("/api/asks/pages/:id/remove"),
    own("/api/asks/sources/sync"),
    own("/api/asks/surfaces/:id/refresh"),
    own("/api/batch/run"),
    own("/api/coding/ci"),
    own("/api/collab/events"), // the household's signed events: each person publishes as themselves (reading: householdReads)
    own("/api/conversation-mode"), // redesign phase 1: never looser than the owner's setting (src/conversation-mode-api.ts)
    own("/api/evaluation/tools"),
    own("/api/firewall/test"),
    own("/api/history/snapshots"),
    own("/api/issues/context"),
    own("/api/labels"),
    own("/api/labels/remove"),
    own("/api/learn/cost"),
    own("/api/learn/map"),
    own("/api/learn/tour"),
    own("/api/learning-more/blocks"),
    own("/api/learning-more/blocks/edit"),
    own("/api/learning-more/blocks/remove"),
    own("/api/learning-more/memory/label"),
    // Seasons: a person reads, undoes and vetoes only their own nights of Rings (the scope is always theirs).
    own("/api/seasons/morning/seen"), own("/api/seasons/rings/keep"), own("/api/seasons/rings/undo"), own("/api/seasons/rings/veto"),
    own("/api/local-models/details"),
    own("/api/local-models/offers"),
    own("/api/local-models/routing/preview"),
    own("/api/local-models/search"),
    own("/api/memory/checkpoints"),
    own("/api/memory/checkpoints/:id/restore"),
    own("/api/memory/forget"),
    own("/api/memory/forget/preview"),
    own("/api/memory/hygiene"),
    own("/api/memory/import"),
    own("/api/memory/index"),
    own("/api/memory/learned"),
    own("/api/memory/proposals/:id/accept"),
    own("/api/memory/proposals/:id/reject"),
    own("/api/memory/tidy"),
    own("/api/memory/tidy/all"),
    own("/api/memory/versions/restore"),
    own("/api/models/probe"),
    own("/api/models/profiles/preview"),
    own("/api/models/test"),
    own("/api/move-in/preview"),
    own("/api/obsidian/write"),
    own("/api/people/conversations"),
    own("/api/people/conversations/:id/message"),
    own("/api/people/me/passkeys/begin"),
    own("/api/people/me/passkeys/finish"),
    own("/api/people/me/passkeys/remove"),
    own("/api/people/me/pin"),
    own("/api/people/me/sign-out"),
    own("/api/personal/brief/play"),
    own("/api/personal/chat-files/send"),
    own("/api/personal/google/events"),
    own("/api/personal/home/states"),
    own("/api/personal/mail/search"),
    own("/api/personal/microsoft/events"),
    own("/api/personal/spotify/now"),
    own("/api/personal/x/search"),
    own("/api/profiles/:id/about"), // your-profile: only that person's own (src/person-about.ts)
    own("/api/profiles/:id/picture"),
    own("/api/profiles/:id/picture/remove"),
    own("/api/projects/notes"),
    own("/api/projects/notes/:id/remove"),
    own("/api/reach/notes"),
    own("/api/reach/notes/remove"),
    own("/api/reach/notes/rewrite"),
    own("/api/reflection/batches/:id/accept"),
    own("/api/reflection/batches/:id/reject"),
    own("/api/reflection/learn"),
    own("/api/reflection/look-back"),
    own("/api/reflection/new-skills/reject"),
    own("/api/reflection/new-skills/try"),
    own("/api/reflection/retire"),
    own("/api/reports"),
    own("/api/read-marks"), // pass 17: a person's own read marks
    own("/api/request-cache/clear"),
    own("/api/rules/test"),
    own("/api/runs/:id/recording/flow"),
    own("/api/safety-extras/wasm/run"),
    own("/api/sessions/:id/branch"), // pass 17: named paths, leaving a message out of context
    own("/api/sessions/:id/discard"),
    own("/api/sessions/:id/pin"), // conversations like iMessage: pin, rename, archive, Recently Deleted (their own only)
    own("/api/sessions/:id/rename"),
    own("/api/sessions/:id/archive"),
    own("/api/sessions/:id/delete"),
    own("/api/sessions/:id/restore"),
    own("/api/sessions/:id/delete-now"),
    own("/api/sessions/put-away/empty"),
    own("/api/sessions/:id/duplicate"),
    own("/api/sessions/:id/left-out"),
    own("/api/sessions/:id/merge-note"),
    own("/api/sessions/:id/pins"),
    own("/api/sessions/:id/rewind"),
    own("/api/sessions/:id/skill"),
    own("/api/sessions/:id/unrevert"),
    own("/api/sessions/import"),
    own("/api/skill-revisions/reject"),
    own("/api/skill-revisions/try"),
    own("/api/teams/:id/handoffs/:id/accept"), // Q62: a profile answers a team-task offer addressed to it
    own("/api/teams/:id/handoffs/:id/reject"),
    own("/api/todos"),
    own("/api/todos/:id"),
    own("/api/todos/:id/done"),
    own("/api/todos/:id/remind"),
    own("/api/tools/forget"),
    own("/api/tools/notes/:id", "DELETE"),
    own("/api/trunks/:id/seen"),
    own("/api/trunks/rooms/:id/artifacts"),
    own("/api/trunks/rooms/:id/typing"), // chatlook: a person in a room says they are typing
    // attach-anything: a file sent ahead of the person's own message, staged under profiles.scope() (src/server.ts).
    own("/api/attachments/upload", "POST,DELETE"),
    own("/api/workflows"),
    own("/api/workflows/:id/remove"),
    own("/api/your-data/delete"), // privacy: deletes only the person's own (profiles.scope(), src/your-data.ts)
    own("/api/your-data/export"), // privacy: exports only the person's own
  ].flat(),
  { method: "POST", pattern: /^\/api\/channels\/deliveries\/[^/]{1,220}\/retry$/, why: "a household person's own things" },
  { method: "POST", pattern: /^\/api\/memory\/archive\/[^/]{1,200}\/restore$/, why: "a household person's own things" },
  { method: "POST", pattern: /^\/api\/memory\/[^/]{1,200}\/keep$/, why: "a household person's own things" },
];

/** Q262: routes written as the table writes them (":id" for any id), each refused for the one reason given. */
const owners = (why: string, ...routes: string[]): TaskRoute[] => routes.flatMap((route) => {
  const [path = "", methods = "POST"] = route.split(" ");
  return own(path, methods).map((entry) => ({ ...entry, why }));
});

/**
 * Q262: what a household person at the window could otherwise reach that writes, or searches, the owner's own stores
 * rather than their own. Refused in the one sentence before anything else is asked (src/server.ts offLimitsToHousehold),
 * the task routes a short-lived key may use included: a short-lived key is the owner's, a household person is not.
 * tests/q262-household-writes.test.mjs pins this list, so it cannot shrink without a reviewed change to that test too.
 */
export const householdOwnerStores: readonly TaskRoute[] = [
  ...owners("the owner's document library, which the owner's tasks retrieve (searching it reads the owner's documents)",
    "/api/documents", "/api/documents/:id DELETE", "/api/documents/reindex", "/api/documents/search"),
  ...owners("the owner's knowledge bases, which the owner's tasks retrieve (the searches, exports and maps read them)",
    "/api/knowledge", "/api/knowledge/:id DELETE", "/api/knowledge/ask", "/api/knowledge/attach", "/api/knowledge/export",
    "/api/knowledge/graph", "/api/knowledge/graph/names", "/api/knowledge/import", "/api/knowledge/manage", "/api/knowledge/map",
    "/api/knowledge/pictures", "/api/knowledge/refresh", "/api/knowledge/reindex", "/api/knowledge/retention/check",
    "/api/knowledge/search", "/api/knowledge/source", "/api/knowledge/summarise"),
  ...owners("the owner's retrieval settings and passages (the search reads the owner's passages)",
    "/api/retrieval/context", "/api/retrieval/pipelines", "/api/retrieval/search"),
  ...owners("the owner's watches: each fetches on the owner's network rules and announces to the owner",
    "/api/monitors", "/api/monitors/:id/check"),
  ...owners("the owner's schedules, which run as the owner", "/api/schedules", "/api/schedules/:id/remove", "/api/schedules/:id/trigger"),
  ...owners("the owner's test suites, their history and the live scoring setting; each run is the owner's",
    "/api/evaluation", "/api/evaluation/compare", "/api/evaluation/live", "/api/evaluation/run", "/api/evaluation/suites",
    "/api/evaluation/suites/from-run", "/api/evaluation/suites/remove"),
  ...owners("the owner's studies and their results (comparing reads two of them)", "/api/studies", "/api/studies/compare", "/api/studies/run"),
  ...owners("the owner's skills: a draft, a test, a benchmark or a package is made from and for the owner's skill",
    "/api/skills/:id/benchmark", "/api/skills/:id/draft", "/api/skills/:id/pack", "/api/skills/:id/test", "/api/skills/draft-from-runs"),
  ...owners("the owner's teams, which run as the owner (running one and answering a handoff stay, Q61, Q62)",
    "/api/teams", "/api/teams/:id/remove"),
  ...owners("a template proposed into the owner's procedures and specialists", "/api/templates/import"),
  ...owners("the owner's page test scenarios", "/api/qa/scenarios", "/api/qa/scenarios/:id/accept", "/api/qa/scenarios/:id/reject",
    "/api/qa/scenarios/:id/run"),
  // Saving, removing or checking a flow was already refused by its handler (requireOwner in src/orchestration-api.ts);
  // listed here so a household person meets the one sentence first, like every other owner store.
  ...owners("a flow saved into the owner's flows, which are otherwise the owner's alone",
    "/api/flows", "/api/flows/:id PUT,DELETE", "/api/flows/check", "/api/flows/yaml"),
  ...owners("the marks of changes in the owner's workspace: undoing one puts the owner's files back", "/api/marks/forget", "/api/marks/undo"),
  ...owners("one of the owner's outgoing webhooks (a preview reads it)", "/api/webhooks/:id/preview"),
  ...owners("a consolidation starts a task filed under the owner", "/api/memory/consolidate"),
  ...owners("a file kept beside any task, listed in the owner's Library › Made for you", "/api/artifacts/save"),
  ...owners("a goal starts its rounds as the owner's own tasks, in the owner's conversations", "/api/goals"),
  ...owners("the doors for other programs: each starts or answers work filed under the owner, with the owner's tools",
    "/v1/chat/completions", "/a2a", "/mcp POST,DELETE", "/ap/v1/agent/tasks", "/ap/v1/agent/tasks/:id/artifacts",
    "/ap/v1/agent/tasks/:id/steps"),
];
/** Q262: the entry that makes this one of the owner's stores for a household person, or undefined when it is not. */
export function householdOwnerStore(method: string | undefined, path: string): TaskRoute | undefined {
  const verb = method ?? "GET";
  return householdOwnerStores.find((route) => route.method === verb && route.pattern.test(path));
}

/** Q261: one read a household person at the window may make, and why it is theirs, shared or public. */
export interface HouseholdRead {
  pattern: RegExp;
  why: string;
}
/** One read, written as the table writes it (":id" for any id); the pattern is anchored at both ends. */
const read = (path: string, why: string): HouseholdRead => ({
  pattern: new RegExp(`^${path.split(":id").map(escape).join(id)}$`),
  why,
});

/**
 * Q261: the reads a household person at the window may make. Reading fails closed the way changing does above: any
 * GET (and any HEAD) that is not listed here answers the one sentence, before the route's own code runs. A read added
 * later is the owner's until somebody lists it here with its reason, and tests/q261-household-reads.test.mjs pins
 * this list, so it cannot grow without a reviewed change to that test too.
 *
 * Only what the person's own window needs is here: their conversations, tasks, memory and profile; what the window
 * reads as it opens, each narrowed for them or answering them nothing; and public catalogues. Themes, pets and the
 * look's pictures are files (public/), served before any key is asked for, so they need no entry.
 */
export const householdReads: readonly HouseholdRead[] = [
  // What the window reads as it opens.
  read("/api/state", "the window's snapshot, narrowed to the person's own records (Q258, src/household-state.ts)"),
  read("/api/profiles", "who is on this computer and who is at the window: names and faces only, the way back to the owner"),
  // your-profile: each person's own profile to edit, and everybody's picture for their tile (the owner's time zone,
  // in /api/profiles/owner/about, is left out).
  read("/api/profiles/:id/about", "one person's name and face; only that person may change them (src/person-about.ts)"),
  read("/api/profiles/:id/picture", "one person's picture, for their tile"),
  read("/api/profiles/owner/picture", "the owner's picture, for the owner's tile"),
  read("/api/lock", "whether Branch is locked, which the lock screen needs while nothing else answers"),
  read("/api/look", "the window's look and language"),
  read("/api/events/stream", "live events, following who is at the window (#339)"),
  read("/api/activity", "tasks working now, only the person's own (profiles.scope(), #324)"),
  read("/api/commands", "the typed commands a household person may send; the owner's saved commands left out (Q259)"),
  read("/api/policy", "the presets and the person's own waiting questions; the owner's policy is null (Q259)"),
  read("/api/practice-runs", "only whether practice is available, so a person can practice their own task"),
  read("/api/conversation-mode", "the mode chip of the person's own conversation (another conversation's id reads as none)"),
  read("/api/conversation-mode/settings", "what a new conversation starts on, which the mode chip's answer already carries"),
  read("/api/usage/glance", "the status bar's ring, which answers a household person with nothing"),
  read("/api/delight", "the pet and background switches, which answer a household person with nothing"),
  read("/api/deployment/suggestion", "the recommendation bar, which answers a household person with nothing"),
  read("/api/accounts", "only the accounts the owner shares with this person, nothing of the owner's lists"),
  read("/api/adapt", "the /adapt switch; the owner's stopped tasks are left out for anybody else"),
  read("/api/read-marks", "the person's own read marks"),
  read("/api/voice/wake", "the wake word card, thinned for a household person (the owner's word left out)"),
  read("/api/voice/dictation", "the dictation card, thinned for a household person"),
  read("/api/voice/dictation/listen", "the dictation card, thinned for a household person"),
  // Their own conversations and tasks, each found only under profiles.scope().
  read("/api/sessions", "the person's own conversations"),
  read("/api/sessions/put-away", "the person's own archived conversations and Recently Deleted"),
  read("/api/sessions/:id/delete-now", "what deleting one of the person's own conversations for good removes"),
  read("/api/sessions/:id", "one of the person's own conversations, or a private room's conversation they are a member of"),
  read("/api/sessions/:id/context", "what one of the person's own conversations holds"),
  read("/api/sessions/:id/export", "one of the person's own conversations written out"),
  read("/api/sessions/:id/followups", "the follow-ups waiting in one of the person's own conversations"),
  read("/api/sessions/:id/goal", "the goal of one of the person's own conversations"),
  read("/api/sessions/:id/model", "the model of one of the person's own conversations"),
  read("/api/sessions/:id/paths", "the named paths of one of the person's own conversations"),
  read("/api/sessions/:id/pins", "the pinned messages of one of the person's own conversations"),
  read("/api/sessions/:id/rewind", "whether one of the person's own conversations can be taken back"),
  read("/api/attachments/file", "a file the person attached to one of their own conversations (src/attachments.ts attachmentForWindow)"),
  // privacy: Settings › Your data, narrowed to the person's own: their counts, the model services their words go to, and
  // their own export (src/your-data.ts). The owner's keys, logs, folder and doors are left out for anybody else.
  read("/api/your-data", "what is kept for the person, and the model services their words go to"),
  read("/api/your-data/export/:id", "how far the person's own export has got"),
  read("/api/your-data/export/:id/file", "the person's own export"),
  read("/api/runs/:id", "one of the person's own tasks"),
  read("/api/runs/:id/inspect", "Look inside one of the person's own tasks (Q259)"),
  read("/api/runs/:id/steps", "the steps of one of the person's own tasks (Q259)"),
  read("/api/runs/:id/live", "the live steps of one of the person's own tasks, while it works"),
  read("/api/runs/:id/plan", "the plan of one of the person's own tasks"),
  read("/api/runs/:id/receipts", "the receipts of one of the person's own tasks"),
  read("/api/runs/:id/recording", "the recording of one of the person's own tasks"),
  read("/api/audit", "the record of the person's own tasks only (Q259)"),
  read("/api/audit/export.csv", "the same record of the person's own tasks, as a file (Q259)"),
  read("/api/usage", "the usage of the person's own conversations only; the owner's month and prices left out (Q259)"),
  read("/api/prompts", "saved prompts, an empty list for a household person (Q259)"),
  read("/api/approvals/categories", "an empty list for a household person (Q259)"),
  read("/api/trunks", "the private rooms the person is a member of, and nothing of the owner's Trunks"),
  read("/api/trunks/:id/files", "only the active person's own default Trunk files; the route rejects foreign ids"),
  read("/api/trunks/rooms/:id", "a private room the person is a member of, without the owner's context or questions"),
  read("/api/trunks/conversations/:id", "who answers in a private room's conversation the person is a member of"),
  read("/api/collab/events", "the household's signed events, each person's own to read and publish"),
  read("/api/teams/:id/handoffs", "the team-task offers addressed to the person, which they may accept or reject (Q62)"),
  // What is remembered for them (memoryApi on profiles.scope()).
  read("/api/memory/tidy", "what is remembered for the person, to tidy"),
  read("/api/memory/archive", "what is archived for the person"),
  read("/api/memory/checkpoints", "the person's own memory checkpoints"),
  read("/api/memory/export", "what is remembered for the person, written out"),
  read("/api/memory/learned", "what was noticed about the person"),
  read("/api/memory/proposals", "facts proposed for the person to keep"),
  read("/api/memory/versions", "the earlier versions of one of the person's facts"),
  read("/api/seasons", "the person's own nights of Rings and what they kept (src/seasons/api.ts reads profiles.scope())"),
  read("/api/seasons/morning", "what the person's own last night kept"),
  read("/api/labels", "the person's own labels"),
  // Public catalogues and facts about the program: the same for everybody, with nothing of the owner's in them.
  read("/api/connections/catalog", "the connector catalogue"),
  read("/api/mcp/catalogue", "the tool server catalogue"),
  read("/api/release-notes", "what is new in this version"),
];

/** Q261: GET and HEAD are reads, and every read fails closed for a household person. */
export const isRead = (method: string | undefined): boolean => (method ?? "GET") === "GET" || method === "HEAD";

/**
 * True when a household person at the window may send this, whatever a short-lived key may. A read must be in
 * householdReads (a HEAD never is); a change must be in householdOwnRoutes, or be a task route a short-lived key may
 * use (src/server.ts offLimitsToHousehold decides that part).
 */
export function householdMaySend(method: string | undefined, path: string): boolean {
  const verb = method ?? "GET";
  if (verb === "GET") return householdReads.some((entry) => entry.pattern.test(path));
  return householdOwnRoutes.some((route) => route.method === verb && route.pattern.test(path));
}
