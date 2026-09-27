import type { Run } from "../contracts.js";
import { lockdownState } from "../lockdown.js";
import { policyPresets, readPolicy } from "../policy.js";
import type { Call } from "./handlers.js";
import { mayAnswerHere } from "../household-approvals.js";
import { atWindow, householdHere, runsHere } from "./household.js"; // Q259

/** `/status` and `/whoami`, in words, for any surface. */

const ago = (iso: string): string => `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))} s`;
/** One line per working task, with the short id `/stop <task>` takes. */
export function runningLines(runs: Run[]): string[] {
  return runs.map((run) => `  ${run.id.slice(0, 8)}  working for ${ago(run.createdAt)} — ${run.prompt.replace(/\s+/g, " ").slice(0, 70)}`);
}

function stepLine(call: Call, run: Run): string {
  const events = call.host.runtime.store.events(run.id);
  const steps = events.filter((event) => event.kind === "tool.started" && !String(event.data.name ?? "").startsWith("tools."));
  const last = steps.at(-1);
  const label = last ? String(last.data.label ?? last.data.name ?? "").replace(/\s+/g, " ").slice(0, 80) : "thinking about it";
  return `Working for ${ago(run.createdAt)}, ${steps.length} ${steps.length === 1 ? "step" : "steps"} so far. Latest: ${label}.`;
}

/**
 * Q258: what the person at the window may count. Through the window, the phone and the dashboard (POST /api/commands/run)
 * a household person counts only their own tasks: the ones started for them, and the questions GET /api/policy shows
 * them (src/household-approvals.ts). A chat app and the terminal are the owner's, whatever the window is switched to.
 * Q259: the working tasks counted are exactly the ones `/stop` may stop (src/commands/household.ts runsHere).
 */
function countedHere(call: Call): { working: Run[]; waiting: number } {
  const { store, owner, approvals } = call.host.runtime;
  const working = runsHere(store, owner, call.surface).filter((run) => run.status === "running");
  const waiting = approvals.waiting().filter((asked) => !atWindow(call.surface) || mayAnswerHere(store, asked)).length;
  return { working, waiting };
}

export function statusLines(call: Call): string[] {
  const { runtime } = call.host, { store, owner } = runtime;
  const { working, waiting } = countedHere(call);
  const policy = readPolicy(store, owner);
  const lines: string[] = [];
  if (call.sessionId) {
    const choice = runtime.models.plan(owner, call.sessionId).choice;
    lines.push(`Model: ${choice.presetName} (${choice.model})${choice.reasoning ? `, thinking ${choice.reasoning}` : ""}.`);
    const here = working.filter((run) => run.sessionId === call.sessionId);
    lines.push(...(here.length ? here.map((run) => stepLine(call, run)) : ["Nothing is working in this conversation."]));
    const goal = call.host.goals?.status(call.sessionId);
    if (goal) lines.push(`Goal: ${goal.status}, round ${goal.round} of ${goal.maxRounds}.`);
  }
  if (!call.sessionId || call.surface === "dashboard") {
    lines.push(working.length ? `${working.length} ${working.length === 1 ? "task is" : "tasks are"} working:` : "Nothing is working right now.");
    lines.push(...runningLines(working));
  }
  if (waiting) lines.push(`${waiting} ${waiting === 1 ? "question waits" : "questions wait"} for your yes in Inbox.`);
  // Q259: the owner's approval settings are theirs; GET /api/policy leaves them out for a household person too.
  if (!householdHere(store, call.surface))
    lines.push(`When to check with you: ${policyPresets().find((entry) => entry.id === policy.preset)?.label ?? "Rules you set yourself"}.`);
  if (lockdownState(store, owner).on) lines.push("Lockdown is on: commands are refused and everything else waits for your yes.");
  return lines;
}

const keyWords: Record<Call["access"], string> = {
  full: "You are using the key of this computer: you may look, start tasks and change settings.",
  run: "You are using a short-lived key that may look and start tasks. It cannot change settings, permissions or Lockdown.",
  read: "You are using a short-lived key that may only look. It cannot start a task or change anything.",
};
/** Q259: the key of this computer, while a household person is at the window (their profile, or signed in). */
const householdWords = "You are using your own profile: you may look at and start tasks in your own conversations. Settings and permissions are the owner's.";
export function whoamiLines(call: Call): string[] {
  if (householdHere(call.host.runtime.store, call.surface)) return [householdWords, "Send /help to see the commands you can use here."];
  if (call.surface !== "chat") return [keyWords[call.access], "Send /help to see the commands you can use here."];
  const may = call.permissions ?? [];
  return [
    "You are writing from a chat app that the owner paired with Branch.",
    may.length ? `Tasks you start here may use ${may.length} kinds of tool, for example: ${may.slice(0, 8).join(", ")}.` : "Tasks you start here may not use any tools.",
    "They may not run programs on the computer, publish, or write to other chats. Settings and permissions are changed only in the app.",
    "Send /help to see the commands you can use here.",
  ];
}
