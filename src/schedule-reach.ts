import { isReadOnlyPermission } from "./policy.js";

/**
 * Dogfood (the weekday 8 AM automation): a schedule made from the Automations box or from chat, naming no permissions,
 * was stored with everything the owner holds, the screen, sending to chats and running programs included, although
 * its words said "read-only, public web". A schedule now gets the least its words need:
 *
 *   - words that say read-only: the tools that only look (reading files, the web, memory, the browser's reading);
 *   - otherwise those, plus writing in the workspace and Branch's own notes;
 *   - never the screen, keyboard or clipboard, sending anything anywhere, running programs or commands, or reaching
 *     another computer or device, unless the owner names them in the schedule's own list.
 *
 * The confirm card shows what is included (`reachWords`) before anything is saved. A schedule saved before this, with
 * no list the owner chose, runs without those held-back kinds (`withoutHeldBack`).
 */

const readOnlyWords = /\b(read[- ]only|only reads?|just reads?|look only|don'?t (?:change|edit|write)|do not (?:change|edit|write)|without (?:changing|editing|writing))\b/i;
/** Writing kept inside the workspace and Branch's own records: nothing is sent, run or reached elsewhere. */
const localWrites: readonly string[] = ["files.write", "documents.write", "memory.write", "scratch.write", "data.write", "media.write", "pages.write"];
/** Sending, running and reaching elsewhere: named by the owner or never. */
const heldBackKinds: readonly string[] = [
  "channels.send", "personal.write", "home.control", "issues.write", "github.manage", "gitlab.manage", "git.remote", "api.call", "agents.ask",
  "code.execute", "shell.execute", "remote.execute", "process.manage", "nodes.run", "devices.run", "devices.act", "devices.capture",
  "blocks.run", "addons.wasm", "code.handoff", "signin.fill", "browser.interact", "sessions.handoff", "skills.http",
];

/** A permission a schedule never gets unless the owner named it: the screen, sending, running or reaching elsewhere. */
export const heldBack = (permission: string): boolean => permission.startsWith("desktop.") || heldBackKinds.includes(permission);

/** Whether a schedule's words say it only reads. */
export const saysReadOnly = (words: string): boolean => readOnlyWords.test(String(words ?? ""));

/** The owner's own mail, calendar and files in their accounts are read only when the words are about them. */
const personalWords = /\b(e-?mails?|inbox|mail|gmail|outlook|calendar|meetings?|appointments?|drive)\b/i;

/** The least a schedule's words need, from what the owner holds. Schedules, settings and installing are never included. */
export function leastPermissions(words: string, held: readonly string[]): string[] {
  const personal = personalWords.test(String(words ?? ""));
  const usable = held.filter((p) => !p.startsWith("schedules.") && !p.endsWith(".manage") && !p.endsWith(".propose") && !heldBack(p)
    && (p !== "personal.read" || personal));
  const reads = usable.filter(isReadOnlyPermission);
  return saysReadOnly(words) ? reads : [...new Set([...reads, ...usable.filter((p) => localWrites.includes(p))])];
}

/** A list saved before this, that the owner never chose, without the held-back kinds. */
export const withoutHeldBack = (permissions: readonly string[]): string[] => permissions.filter((p) => !heldBack(p));

/** What a schedule may do, in the owner's words, for the confirm card. */
export function reachWords(permissions: readonly string[]): string {
  const writes = permissions.some((p) => !isReadOnlyPermission(p) && !heldBack(p));
  const named = permissions.filter(heldBack);
  const base = writes
    ? "It can read, and write in your workspace and Branch's notes."
    : "It only reads: your files, the web and Branch's notes.";
  return named.length
    ? `${base} You also let it: ${named.join(", ")}.`
    : `${base} It cannot use your screen, send anything or run programs.`;
}
