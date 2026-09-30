/**
 * The one place that decides who may call what over HTTP. src/server.ts resolves the caller once (src/caller.ts) and
 * asks `callerRefusal` once, before any route's own code runs; nothing else in the request path decides it.
 *
 * Every route written in src/ (the table in tests/short-lived-key-routes.mjs) is asked of a running engine for every
 * kind of caller, with Lockdown off and on, the window on the owner and on a household person, and the App lock
 * locked: tests/caller-policy.test.mjs holds the answers in tests/caller-policy.golden.txt, so changing any entry
 * below changes that file, and a route missing from the table fails the build.
 *
 * The checks run in this order, and the first refusal is the answer:
 *   1. the key's own reach: a person's key (their own page only, 401), a short-lived key (looking, and a "run" key's
 *      task routes, 401);
 *   2. a door: what outlasts a removed phone, or reaches past this computer, is done here only (403);
 *   3. a household person: the owner's own parts of Branch (400, the sentence `requireOwner` says);
 *   4. the App lock: nothing but the lock itself while Branch is locked (423);
 *   5. Lockdown: routes that do nothing but what Lockdown switches off (their own status and sentence).
 * What depends on the request's body (a change that loosens approvals or safety, which Lockdown refuses and which
 * otherwise needs the owner's yes: src/policy-change-guard.ts looseningRefusal) is decided where the body is read,
 * and is not repeated here.
 */
import type { Caller } from "./caller.js";
import { handlesWikiPath } from "./wiki.js";
import { handlesWorkspaceEditorPath } from "./workspace-editor-api.js";
import { listenKeyRefusal } from "./listen-address.js";
import { handlesUpdateFixPath } from "./update-fix.js";
import { handlesUpdateFailurePath } from "./update-failure.js";
import {
  comfortRefusal, generalShortLivedKeyRefusal, knobsRefusal, ownerOnlyRead, savingsRefusal, taskRouteFor,
} from "./short-lived-keys.js";
import { readKeyRefusal } from "./session-tokens.js";
import { handlesAccountsPath } from "./accounts/api.js";
import { handlesAdaptPath } from "./adapt/api.js";
import { handlesGuardsPath } from "./run-guards.js";
import { handlesKnobsPath } from "./knobs/api.js";
import { handlesSavingsPath } from "./model-savings/api.js";
import { handlesComfortPath } from "./comfort/api.js";
import { handlesNeverBreakPath } from "./never-break/api.js";
import { handlesChannelSetupPath } from "./channel-setup/api.js";
import { handlesLearningCorePath } from "./fly-core-api.js";
import { handlesUsageLimitsPath } from "./usage-limits-api.js";
import { handlesYourDataPath } from "./your-data.js";
import { interopOffLimits } from "./interop/api.js";
import { householdMaySend, householdOwnerStore, householdRefusalFor, isRead } from "./household-routes.js";
import { hereOnly } from "./remote/window-key.js";
import { lockedRefusal } from "./session-lock.js";
import { phoneLockdownRefusal } from "./phone-app/index.js";
import { joinLockdownWords } from "./devices/join.js";
import { selfDevelopmentLockdownRefusal } from "./self-development-contract.js";

export interface CallerRefusal { status: number; message: string }

/* ---------- 1a. A person's own key: their own page, and nothing else of the owner's (bucket 19) ---------- */

const idPattern = "[a-f0-9-]{36}";
interface Door { method: "GET" | "POST"; pattern: RegExp }
const door = (method: Door["method"], path: string): Door => ({ method, pattern: new RegExp(`^${path}$`) });
/** Where a person's key reaches: who they are, their PIN and passkeys, signing out, and their own conversations. */
export const personDoors: readonly Door[] = [
  door("GET", "/api/people/me"),
  door("POST", "/api/people/me/sign-out"),
  door("POST", "/api/people/me/pin"),
  door("GET", "/api/people/me/passkeys"),
  door("POST", "/api/people/me/passkeys/(begin|finish)"),
  door("POST", "/api/people/me/passkeys/remove"),
  door("GET", "/api/people/conversations"),
  door("POST", "/api/people/conversations"),
  door("GET", `/api/people/conversations/${idPattern}`),
  door("POST", `/api/people/conversations/${idPattern}/message`),
];
/** Where a set-up key (from the owner's one-time code) reaches: a new PIN or a passkey, then sign in again. */
export const setupDoors: readonly Door[] = [
  door("GET", "/api/people/me"),
  door("POST", "/api/people/me/sign-out"),
  door("POST", "/api/people/me/pin"),
  door("GET", "/api/people/me/passkeys"),
  door("POST", "/api/people/me/passkeys/(begin|finish)"),
];
export const personKeyRefusal = "A person's sign-in reaches only their own page. Everything else is the owner's.";
export const setupKeyRefusal = "This short sign-in may only set a new PIN or register a passkey. Then sign in again.";

/** Why a person's key may not use this address, or null. */
export function personDoorRefusal(method: string | undefined, path: string, setupOnly: boolean): string | null {
  const doors = setupOnly ? setupDoors : personDoors;
  if (doors.some((each) => each.method === (method ?? "GET") && each.pattern.test(path))) return null;
  return setupOnly ? setupKeyRefusal : personKeyRefusal;
}

/* ---------- 1b. A short-lived key: looking, and a "run" key's task routes (src/short-lived-keys.ts lists them) ---------- */

/**
 * Why one of the owner's short-lived keys may not send this, or null. The areas below are named first, each with its
 * own sentence, because some are refused even to look at; then a read is open unless it hands back a secret
 * (ownerOnlyRead), and every other change fails closed unless it is a task route (taskRouteFor).
 */
export function offLimitsToShortLivedKeys(method: string | undefined, path: string): string | null {
  // The wiki is what the owner and the assistant have written down together; a script's key may
  // neither read it nor write a page in it.
  if (handlesWikiPath(path)) return "A short-lived key cannot read or write the wiki. Do that in the app window.";
  // bucket-18 (A0098): the code editor, its switch included, is the owner's alone: a script's key may
  // neither read files through it nor save over them, so this comes before reading is let through.
  // FQ-collaboration: the video bytes the code editor's own player opens are the same door.
  if (handlesWorkspaceEditorPath(path) || path === "/api/media-comments/media")
    return "A short-lived key cannot use the code editor. Do that in the app window.";
  // mac7/bind: opening Branch's door to the private network is the owner's alone, and so is being
  // told where the door already is. A Trunk's message from another computer arrives with such a
  // key, so this is where a Trunk is refused too. Like the code editor above, it comes before
  // reading is let through, because the answer is where to knock.
  if (path === "/api/listen") return listenKeyRefusal;
  // mac7/phone-qr: the phone download link is a way in from the home network, however narrow, and
  // the live link is on the card, so opening, reading and closing it are the owner's alone.
  if (path === "/api/phone-app" || path.startsWith("/api/phone-app/"))
    return "A short-lived key cannot open or read the phone download. Do that in the app window.";
  // mac5/key-sweep: a few reads hand back a secret or everybody's data (src/short-lived-keys.ts).
  // mac7/diagnostics: the activity log and problem reports are the owner's alone, reading included.
  // A person's attached files are the owner's alone, like everything else kept beside the database.
  // privacy: Settings › Your data is the app window's alone, reading included: the summary names the owner's webhooks,
  // phones and folder, and an export's progress and file hand back everything kept, the full backup among it.
  if (handlesYourDataPath(path))
    return "A short-lived key cannot read, export or delete everything kept here. Do that in the app window.";
  if (path.startsWith("/api/attachments/"))
    return "A short-lived key cannot open a file somebody attached. Do that in the app window.";
  if (path.startsWith("/api/diagnostics/"))
    return "A short-lived key cannot read the activity log or make a problem report. Do that in the app window.";
  if (handlesUpdateFixPath(path))
    return "A short-lived key cannot fix an update or choose who does. Do that in the app window.";
  if (handlesUpdateFailurePath(path))
    return "A short-lived key cannot read an update's problem or make its file. Do that in the app window.";
  if (path === "/api/updates/data-copies")
    return "A short-lived key cannot see or put back the copies of the data folder taken before updates. Do that in the app window.";
  // CHAT-156: who may message Branch names people; like the door above, a script's key may not even read it.
  if (path === "/api/channels/allowlist") return "A short-lived key cannot read or change who may message Branch. Do that in the app window.";
  if (method === "GET") return ownerOnlyRead(path);
  // Wave mac3 (commands, integration review): when Branch checks with you, which model every new
  // conversation starts with (and the model services behind it), and which commands are offered
  // are the owner's; `/preset` and `/default` already refused a "run" key, their routes did not.
  // mac7/smoke-fixes (B4): a key can never make or take back another key. No self-renewal.
  if (path === "/api/tokens" || path.startsWith("/api/tokens/"))
    return "A short-lived key cannot make or take back a short-lived key. Do that at this computer.";
  if (path === "/api/policy" || path === "/api/models" || path === "/api/commands/settings")
    return "A short-lived key cannot change when Branch checks with you, the models, or which commands are offered. Do that in the app window.";
  if (path === "/api/providers/cli-agents" || path.startsWith("/api/secrets") || path.startsWith("/api/connections") || /^\/api\/schedules\/[a-f0-9-]{36}\/gate$/.test(path))
    return "A short-lived key cannot name a program for Branch to run, add a model service, or change the locker. Do that in the app window.";
  // mac6/accounts: adding, removing and switching accounts is the owner's alone.
  if (handlesAccountsPath(path))
    return "A short-lived key cannot add, remove or switch accounts. Do that in the app window.";
  if (path === "/api/deployment/close" || path === "/api/deployment/quit") // quit: bucket 22
    return "A short-lived key cannot close Branch. Only the app on this computer can.";
  // Wave mac2 (quiet-jobs): the check-in's switches, hours and where its news goes are the owner's.
  if (path === "/api/heartbeat" || path.startsWith("/api/heartbeat/"))
    return "A short-lived key cannot change the check-in or start one. Do that in the app window.";
  // Wave mac3 (dashboard review): a "run" key "cannot change what Branch is allowed to do", and
  // Lockdown is exactly that; without this a script's key could switch Lockdown off.
  if (path === "/api/lockdown")
    return "A short-lived key cannot switch Lockdown on or off. Do that in the app window or with the key of this computer.";
  // mac7/adapt: getting what a stopped task is missing installs programs and spends the owner's
  // disk, so no short-lived key — and so no other computer reaching this one — may ask for it.
  if (handlesAdaptPath(path))
    return "A short-lived key cannot have Branch fetch or install what a stopped task is missing. Do that in the app window.";
  // mac7/vault-autofill (R17-068): which saved sign-in Branch may type into a page is the owner's alone.
  if (path.startsWith("/api/vault-autofill"))
    return "A short-lived key cannot change which saved sign-ins Branch may fill. Do that in the app window.";
  // bucket-18 (A2317): a copy of what is remembered may be sent to a remote; only the owner names it.
  if (path === "/api/memory/history")
    return "A short-lived key cannot change where the history of what is remembered is kept. Do that in the app window.";
  // FQ-memory.providers: where facts are kept is the owner's setting and the locker secret is the owner's alone.
  if (path === "/api/memory/provider")
    return "A short-lived key cannot change where facts are kept or which key an outside memory service uses. Do that in the app window.";
  // bucket-18 (A0300): where work is sent on GitHub is the owner's to decide.
  if (path === "/api/developer/pull-requests")
    return "A short-lived key cannot change how work is sent to GitHub. Do that in the app window.";
  // Wave mac3 (os-sandbox): the wall around programs, and where scripts run, decide what a program
  // may touch; a script's key must not be able to take either down.
  if (path === "/api/os-sandbox" || path === "/api/sandboxes")
    return "A short-lived key cannot change the wall around programs or where scripts run. Do that in the app window.";
  // Wave mac2 (guards): trusting a folder lets what is in it steer the assistant.
  if (handlesGuardsPath(path)) return "A short-lived key cannot change which folders are trusted or how repeated steps are stopped. Do that in the app window.";
  // R17-S-B: the knobs include which environment variables commands get and how keys are hidden.
  if (handlesKnobsPath(path)) return knobsRefusal;
  if (handlesSavingsPath(path)) return savingsRefusal; // R17-E
  // R17-S-C: the proxy, certificates, browser care and automatic updates are the owner's.
  if (handlesComfortPath(path)) return comfortRefusal;
  // mac3/never-break: the gateway's settings are the owner's alone.
  if (handlesNeverBreakPath(path)) return "A short-lived key cannot change how Branch keeps itself running. Do that in the app window.";
  // mac7/connect: saving a chat app's token or switching setting-up on is the owner's alone.
  if (handlesChannelSetupPath(path)) return "A short-lived key cannot save a chat app's token or change how chat apps are set up. Do that in the app window.";
  // mac3/never-break (integration review): letting a new person reach the assistant is the owner's alone.
  if (path.startsWith("/api/channels/pairings/")) return "A short-lived key cannot let a new person reach the assistant, or remove one. Do that in the app window.";
  // Bucket 17: naming a program for Branch to run (ffmpeg, yt-dlp, a reading-aloud program) is the owner's step.
  if (path === "/api/media/programs" || path === "/api/voice/engines")
    return "A short-lived key cannot choose which programs or speech services Branch uses. Do that in the app window.";
  // Wave mac3 (tool-safety): the second look decides what gets asked about.
  if (path === "/api/approval-reviewer" && method !== "GET") return "A short-lived key cannot change the safety check before approvals. Do that in the app window.";
  // mac3/security-check: changing who may reach Branch's files, or the check's own switches.
  if (path.startsWith("/api/security-check/") && path !== "/api/security-check/run")
    return "A short-lived key cannot change security settings or file permissions. Do that in the app window.";
  // mac2/fly-core-2 (integration review): the learning core's switch and "forget" are the owner's.
  if (handlesLearningCorePath(path)) return "A short-lived key cannot change the learning core or make it forget. Do that in the app window.";
  // mac4/bucket-14 (integration review): the report shows every person's tasks, and the counters go out to the trace address.
  if (path.startsWith("/api/usage/report") || path.startsWith("/api/usage/counters"))
    return "A short-lived key cannot make the usage report, change it, or send the task counters. Do that in the app window.";
  // Redesign phase 1: how much the assistant may do in a conversation is picked in the app window.
  if (path.startsWith("/api/conversation-mode") && method !== "GET") return "A short-lived key cannot change how much the assistant may do in a conversation. Do that in the app window.";
  // mac7/usage-bar: what the owner's paid-for connections have left is the owner's business.
  if (handlesUsageLimitsPath(path))
    return "A short-lived key cannot see what each connection has left, or change how it is asked for. Do that in the app window.";
  // mac3/channels-parity (integration review): switching a chat app on lets outsiders reach the assistant.
  if (path === "/api/channels/parity") return "A short-lived key cannot switch chat apps on or off. Do that in the app window.";
  // mac4/bucket-13 (integration review): the recordings switch (and whether saved pages carry
  // pictures) and the event-loop watch are the owner's settings.
  if (path === "/api/recordings" || path === "/api/event-loop")
    return "A short-lived key cannot change task recordings or the check on whether Branch is keeping up. Do that in the app window.";
  // mac7/clean-uninstall: removing Branch, and even the list of what removing it would take away.
  if (path === "/api/remove-branch" || path === "/api/remove-branch/plan")
    return "A short-lived key cannot remove Branch from this computer, and neither can another computer reaching this one. Do that in the app window.";
  // mac5/local-models (integration review): the switch, downloading, starting a program and deleting a model.
  // mac7/one-click (issue #107): installing the program that runs the models is the owner's alone too.
  if (/^\/api\/local-models\/(switch|setup|pull|load|stop|remove|delete|unload|runtime|install|one-button|routing$)/.test(path))
    return "A short-lived key cannot switch models on this computer, install the program that runs them, download or delete one, or start or stop its program. Do that in the app window.";
  // mac5/key-sweep: every other change fails closed; only the task routes in src/short-lived-keys.ts are open.
  if (!taskRouteFor(method, path) && interopOffLimits(method, path) === null) return generalShortLivedKeyRefusal;
  // mac4/bucket-20: switching those parts, bringing an assistant in, and handing a conversation on.
  return interopOffLimits(method, path);
}
/**
 * profile-audit: what a household person at the window is refused. Whatever a short-lived key is
 * refused, they are too — settings, permissions, secrets, pairing, backups, updates, the danger
 * zone — except their own things and the ways out listed in src/household-routes.ts.
 * Q261: reading fails closed too. A GET is answered only when it is listed in householdReads, and a HEAD never is,
 * whatever a short-lived key may read.
 */
export function offLimitsToHousehold(method: string | undefined, path: string, key: { ownersShortLivedKey?: boolean } = {}): string | null {
  // Q262: the owner's own stores come first, whatever a list below (or a short-lived key's task routes) would allow;
  // only a request made with the owner's own short-lived key (src/server.ts, where the key is accepted) is the owner's.
  if (!key.ownersShortLivedKey && householdOwnerStore(method, path)) return householdRefusalFor(path);
  if (householdMaySend(method, path)) return null;
  if (isRead(method)) return householdRefusalFor(path);
  return offLimitsToShortLivedKeys(method, path) === null ? null : householdRefusalFor(path);
}

/* ---------- 2. A door: made or widened here only ---------- */

/**
 * What a door may never change: making a short-lived key or a phone invitation (either would outlast the phone that
 * made it once that phone is removed) and where Branch listens. Switching the phone door is refused where it is
 * handled (src/server.ts). Looking stays open.
 *
 * Nor anything else that keeps working after the phone that made it is removed: an outgoing webhook (or switching a
 * stopped one back on; a trigger is switched back on in src/server.ts, where the body says which way), a trigger and its
 * secret, a chat app's token or setup, letting a new chat account reach the assistant, and a person's sign-in code, the
 * services people sign in with, an outside sign-in tied to a person, or a new person with a PIN (each makes a person's
 * key). Removing one of these stays open to a door.
 */
const outlastsAPhone: readonly RegExp[] = [
  /^\/api\/(tokens|listen|deployment\/remote\/invite)$/,
  /^\/api\/webhooks$/,
  /^\/api\/webhooks\/[a-f0-9-]{36}\/enable$/,
  /^\/api\/triggers$/, /^\/api\/triggers\/[a-f0-9-]{36}\/rotate-secret$/,
  /^\/api\/channel-setup(\/|$)/, /^\/api\/channels\/pairings\/approve$/,
  /^\/api\/people\/settings$/, /^\/api\/people\/[a-f0-9-]{36}\/reset-code$/, /^\/api\/people\/links\/confirm$/,
  /^\/api\/profiles$/,
];
/**
 * What a door may not even read, nor change: the address each chat service posts to carries that service's own secret
 * word, which a phone would keep after it is removed, and its settings keep the old addresses without one answered.
 */
const secretToADoor: readonly RegExp[] = [/^\/api\/channels\/addresses(\/|$)/, /^\/api\/panels\/browser(\/|$)/];
/**
 * A coding assistant's own sign-in (src/accounts/sign-ins.ts) opens its page in this computer's browser, so only the
 * person at this computer can start it or paste its code. Checking and stopping stay open to a door.
 */
const opensOnThisComputer: readonly RegExp[] = [/^\/api\/accounts\/sign-ins\/(start|code)$/];
/**
 * Deleting conversations for good (src/conversation-actions.ts, and the retention sweep, src/retention.ts): only in the
 * app on this computer, never a phone.
 */
const permanentHereOnly: readonly RegExp[] = [/^\/api\/sessions\/[a-f0-9-]{36}\/delete-now$/, /^\/api\/sessions\/put-away\/empty$/, /^\/api\/retention\/prune$/];
/** Why a door (the paired door, a phone's own key, or a caller beyond this computer) may not send this, or null. */
export function hereOnlyRefusal(method: string | undefined, path: string): string | null {
  if (/^\/api\/taste(\/|$)/.test(path) || /^\/api\/self-development\/publications(\/|$)/.test(path)) return hereOnly;
  if (/^\/api\/self-development\/merge(\/|$)/.test(path)) return hereOnly;
  if (secretToADoor.some((route) => route.test(path))) return hereOnly;
  if (method === "GET" || method === "HEAD") return null;
  return [...outlastsAPhone, ...opensOnThisComputer, ...permanentHereOnly].some((route) => route.test(path)) ? hereOnly : null;
}

/* ---------- 4. The App lock: while Branch is locked, only the lock itself answers ---------- */

/** What a locked Branch still answers: its lock status and the unlock, whether it is alive, and closing it. */
export const openWhileLocked: ReadonlySet<string> = new Set(["GET /api/lock", "POST /api/lock/unlock", "GET /api/alive",
  "GET /api/health", "POST /api/deployment/quit", "POST /api/deployment/close"]);

/* ---------- 5. Lockdown: routes that do nothing but what Lockdown switches off ---------- */

/**
 * Refused to every caller while Lockdown is on, before the route's own code runs. Each route still asks again itself,
 * because the engine reaches the same work without a request too.
 */
export const lockdownRoutes: readonly { method: string; path: string; status: number; message: string }[] = [
  { method: "GET", path: "/api/self-development/merge", status: 403, message: selfDevelopmentLockdownRefusal },
  { method: "GET", path: "/api/self-development/merge/runner", status: 403, message: selfDevelopmentLockdownRefusal },
  ...["/api/self-development/merge/review", "/api/self-development/merge/approve", "/api/self-development/merge/finish"]
    .flatMap((path) => ["GET", "POST"].map((method) => ({ method, path, status: 403, message: selfDevelopmentLockdownRefusal }))),
  // Opening the phone download to the home network (src/phone-app/index.ts). Closing it stays open.
  { method: "POST", path: "/api/phone-app/share", status: 403, message: phoneLockdownRefusal },
  // Lending this computer to another Branch, or waiting to be found by one (src/devices/join.ts). Leaving stays open.
  { method: "POST", path: "/api/devices/join", status: 409, message: joinLockdownWords },
  { method: "POST", path: "/api/devices/join/find", status: 409, message: joinLockdownWords },
];

/* ---------- The one decision ---------- */

/** What the server knows about the key beyond its kind. */
export interface KeyDetail {
  /** A person's set-up key, which reaches less than their own (src/people). */
  setupOnly?: boolean;
  /** A read key's slash command only looks (src/server.ts commandLook), so it counts as a GET. */
  onlyLooking?: boolean;
}

/** Why this caller may not send this request, or null when every check about who is calling lets it through. */
export function callerRefusal(caller: Caller, method: string | undefined, path: string, key: KeyDetail = {}): CallerRefusal | null {
  const verb = method ?? "GET";
  if (caller.kind === "person-key") {
    const refused = personDoorRefusal(verb, path, key.setupOnly === true);
    if (refused) return { status: 401, message: refused };
  }
  const shortLived = caller.kind === "key-read" || caller.kind === "key-run";
  if (shortLived) {
    const refused = offLimitsToShortLivedKeys(verb, path)
      ?? (caller.kind === "key-read" && verb !== "GET" && !key.onlyLooking ? readKeyRefusal : null);
    if (refused) return { status: 401, message: refused };
  }
  if (caller.throughDoor) {
    const refused = hereOnlyRefusal(verb, path);
    if (refused) return { status: 403, message: refused };
  }
  // Q261: a person's own key already has its own fail-closed list of what it may read (1a), so its reads are decided
  // there only. Q262: the owner's own short-lived key is the owner's, whoever the window is switched to.
  if (caller.household && !(caller.kind === "person-key" && isRead(verb))) {
    const refused = offLimitsToHousehold(verb, path, { ownersShortLivedKey: shortLived });
    if (refused) return { status: 400, message: refused };
  }
  if (caller.appLocked && !openWhileLocked.has(`${verb} ${path}`)) return { status: 423, message: lockedRefusal };
  if (caller.lockdown) {
    const row = lockdownRoutes.find((each) => each.method === verb && each.path === path);
    if (row) return { status: row.status, message: row.message };
  }
  return null;
}
