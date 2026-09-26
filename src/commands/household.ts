import type { Run } from "../contracts.js";
import type { Store } from "../store.js";
import { personConversation, startedForHere } from "../household-approvals.js";
import { householdRefusal } from "../household-routes.js";
import type { Surface } from "./catalog.js";

/**
 * Q259: what a typed command may touch when a household person is at the window.
 *
 * The window, the phone and the dashboard send commands through POST /api/commands/run, and while the window is
 * switched to somebody else's profile (or a person is signed in) that person is who is typing. A chat app and the
 * terminal are the owner's, whatever the window is switched to, and keep acting as the owner (as /status does, Q258).
 *
 * At the window the rule fails closed, like src/household-routes.ts: a command is refused to a household person in
 * the one sentence `Profiles.requireOwner` says unless it is listed below as one that only works on their own
 * things (their conversation, their tasks, what is remembered for them) or only moves the window. A command added
 * later is the owner's until somebody lists it here.
 */
export const atWindow = (surface: Surface): boolean => surface === "window" || surface === "phone" || surface === "dashboard";

/** True when the person typing is a household person at the window, not the owner. */
export function householdHere(store: Store, surface: Surface): boolean {
  return atWindow(surface) && !store.profiles.isOwner();
}

type Allowed = "any" | "bare";
/**
 * The commands a household person at the window may send, and whether with words after them ("any") or only on
 * their own ("bare"). Everything else is refused before its handler runs. Left out on purpose, among others:
 * /btw, /compact, /goal and /help with a question (each starts work in the owner's name, not the person's),
 * /skills, /prompts and the owner's saved commands, /suggestions, /installs, /account, /health, /busy, /preset,
 * /adapt, /init and /learn (each reads or changes the owner's own records, settings or workspace).
 */
const householdCommands: Readonly<Record<string, Allowed>> = {
  // Only move the window or its message box.
  new: "any", attach: "any", plan: "any", temporary: "any", pane: "any", theme: "any", focus: "any",
  go: "any", inbox: "any", automations: "any", library: "any", customize: "any", settings: "any",
  help: "bare", whoami: "any", version: "any",
  // The person's own conversation, which POST /api/commands/run has checked is theirs.
  model: "any", think: "any", export: "any", tokens: "any", queue: "bare",
  // Narrowed to the person's own tasks, conversations and remembered facts in their handlers.
  stop: "any", status: "any", sessions: "any", memory: "any", usage: "any",
  // Whether Lockdown is on, which holds their tasks too; switching it stays the owner's.
  lockdown: "bare",
};

/** Why a household person at the window may not send this command, or null when they may (or nobody is). */
export function householdCommandRefusal(store: Store, surface: Surface, name: string, argument: string): string | null {
  if (!householdHere(store, surface)) return null;
  const allowed = householdCommands[name];
  const given = argument.trim();
  if (allowed === "any" || (allowed === "bare" && (!given || (name === "help" && given === "all")))) return null;
  return householdRefusal;
}

/** Whether the person typing may use this conversation: the owner their own, a household person theirs. */
export function mayUseConversation(store: Store, owner: string, surface: Surface, sessionId: string): boolean {
  return householdHere(store, surface) ? personConversation(store, owner, sessionId) : store.ownsSession(owner, sessionId);
}

/**
 * The tasks the person typing may see and stop, newest first. The owner (and a chat app or the terminal): every
 * task of the owner's, as before. A household person at the window: only the tasks started for them in their own
 * conversations. Anything else is left out, so its id reads exactly like an id that does not exist.
 */
export function runsHere(store: Store, owner: string, surface: Surface): Run[] {
  if (!householdHere(store, surface)) return store.runs(owner);
  const seen = new Set<string>();
  return [...store.runs(owner), ...store.runs(store.profiles.scope())]
    .filter((run) => !seen.has(run.id) && seen.add(run.id))
    .filter((run) => startedForHere(store, run.id) && personConversation(store, owner, run.sessionId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
