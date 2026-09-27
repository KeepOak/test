import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is calling, worked out once per request (src/server.ts, where the key is read) and carried into everything that
 * request starts, tasks included. The one place that decides what each caller may reach is src/caller-policy.ts.
 *
 * - owner-here: the app window's key, on this computer's own listener, from this computer.
 * - owner-remote: the window's key from beyond this computer (the wider door, a tunnel).
 * - phone-with-own-key: a paired phone's own key (src/remote/gateway-auth.ts keyDevice).
 * - legacy-phone: a phone paired before phones had keys, holding the window's key, on the paired door.
 * - household: the window's key while the window is switched to a household person (src/profiles.ts).
 * - person-key: a household person's own sign-in key (src/people).
 * - key-read, key-run: one of the owner's short-lived keys (`branch token create`). Another of the owner's computers
 *   (a paired computer) and an outside agent (MCP, A2A, the OpenAI-style and Agent Protocol doors) arrive with one of
 *   these or with the window's key, so they are judged as that key: nothing on the wire tells them apart.
 * - chat-app, system: never arrive over HTTP. A chat message reaches the engine by its own signed webhook, and the
 *   engine's own work (schedules, triggers, learning passes) has no request; `currentCaller()` answers "system" there.
 */
export type CallerKind =
  | "owner-here" | "owner-remote" | "phone-with-own-key" | "legacy-phone" | "household" | "person-key"
  | "key-read" | "key-run" | "paired-computer" | "chat-app" | "outside-agent" | "system";

export interface Caller {
  kind: CallerKind;
  /** Lockdown was on when the request arrived (src/lockdown.ts). */
  lockdown: boolean;
  /** The App lock had Branch locked when the request arrived (src/session-lock.ts). */
  appLocked: boolean;
  /** Came through a door rather than this computer's own window: the paired door, a phone's own key, or from beyond. */
  throughDoor: boolean;
  /** Arrived from this computer (loopback, not through the tunnel). */
  fromThisComputer: boolean;
  /** The request is judged as a household person, not the owner (the window's switch, or a person's own key). */
  household: boolean;
}

/** The kinds a request over HTTP can resolve to. The others are set only by the engine itself. */
export const httpCallerKinds: readonly CallerKind[] = [
  "owner-here", "owner-remote", "phone-with-own-key", "legacy-phone", "household", "person-key", "key-read", "key-run",
];

/** What the server knows about a request once its key has been read. */
export interface CallerFacts {
  key: "window" | "phone" | "person" | "read" | "run";
  pairedDoor: boolean;
  fromThisComputer: boolean;
  /** The window is switched to a household person, and this request is not the paired door's (which is the owner's). */
  windowHousehold: boolean;
  lockdown: boolean;
  appLocked: boolean;
}

/** The one place a request becomes a Caller. */
export function resolveCaller(facts: CallerFacts): Caller {
  const throughDoor = facts.pairedDoor || facts.key === "phone" || !facts.fromThisComputer;
  const kind: CallerKind = facts.key === "phone" ? "phone-with-own-key"
    : facts.key === "person" ? "person-key"
    : facts.key === "read" ? "key-read"
    : facts.key === "run" ? "key-run"
    : facts.pairedDoor ? "legacy-phone"
    : !facts.fromThisComputer ? "owner-remote"
    : facts.windowHousehold ? "household" : "owner-here";
  return {
    kind, lockdown: facts.lockdown, appLocked: facts.appLocked, throughDoor, fromThisComputer: facts.fromThisComputer,
    household: facts.key === "person" || facts.windowHousehold,
  };
}

const scope = new AsyncLocalStorage<Caller>();
/** Marks the rest of the current request, and everything it starts, as this caller's. */
export function enterCaller(caller: Caller): void {
  scope.enterWith(caller);
}
/** Runs `work` as this caller (the engine's own work that knows whom it acts for, and tests). */
export function asCaller<T>(caller: Caller, work: () => T): T {
  return scope.run(caller, work);
}
const system: Caller = {
  kind: "system", lockdown: false, appLocked: false, throughDoor: false, fromThisComputer: true, household: false,
};
/** Who the work in progress is for; "system" when no request is behind it. */
export function currentCaller(): Caller {
  return scope.getStore() ?? system;
}
