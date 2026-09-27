import { homedir } from "node:os";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalGate } from "./approvals.js";
import { ApprovalRequiredError } from "./approvals.js";
import type { ToolContext } from "./contracts.js";
import { runOrigin, startedWithShortLivedKey } from "./key-context.js";
import { lockdownActive } from "./lockdown.js";
import { readPolicy } from "./policy.js";
import type { Store } from "./store.js";
import { nobodyToAsk } from "./coding/project-tests.js";

/**
 * The owner's own Downloads, Desktop and Documents folders, which the file tools can list and move files in once the
 * owner has said yes (QA: "Tidy my Downloads folder" could not reach ~/Downloads, because the file tools see only the
 * workspace, which in a real install is Branch's own folder).
 *
 * Kept tight:
 *  - only these three folders, under the home folder, and never outside the one a path names;
 *  - only listing and moving one file (never reading, writing, editing or deleting), and a move stays in its folder;
 *  - asked once per folder in a conversation, the question naming the real path; "Always" is a rule for that folder only;
 *  - never under Lockdown, never for a task someone else started (a household person, a short-lived key, a chat app or
 *    a schedule), and never silently: a path outside reach is an error in plain words, never an empty list.
 * Inside a folder the workspace's own checks apply: no "..", no secret-looking names, no links or junctions on the way.
 */
export const ownerFolderNames = ["Downloads", "Desktop", "Documents"] as const;
/** The name a folder's question and its answers are kept under. No tool can be registered with it (a capital). */
export const ownerFolderTool = "files.ownerFolder";
export interface OwnerFolder { name: (typeof ownerFolderNames)[number]; path: string }

export function ownerFolderRoots(home: string = homedir()): OwnerFolder[] {
  return ownerFolderNames.map((name) => ({ name, path: join(home, name) }));
}

const secretPart = /(^\.env($|\.)|^\.ssh$|^\.aws$|^\.git$|^\.branch$|credentials|secrets?|^id_rsa|^id_ed25519|\.(pem|key|p12|pfx)$)/i;
/** Why one part of a path inside an owner folder is refused, or "" when it is fine. */
function badPart(part: string): string {
  if (!part || part === "." || part === "..") return "a path may not step out of its folder";
  if (/[*?]/.test(part)) return `"${part}" is a wildcard, not a path: use files.list to see the files, then files.move one at a time`;
  if (/[<>|":]/.test(part)) return `"${part}" is not a file name`;
  if (/[. ]$/.test(part)) return `"${part}" is not a file name`;
  if (secretPart.test(part)) return `"${part}" looks like it holds keys or passwords, so Branch leaves it alone`;
  return "";
}

export type OwnerPath = { folder: OwnerFolder; parts: string[] };
/**
 * What a path a model wrote stands for: a place in one of the owner's folders, "outside" for any other place outside
 * the workspace, or null for an ordinary workspace path. `~/Downloads/a.pdf`, `C:\Users\me\Downloads\a.pdf` and (when
 * the workspace has nothing called that) `Downloads/a.pdf` all name the same file.
 */
export function ownerPathOf(raw: string, home: string = homedir(), bareName = false): OwnerPath | "outside" | null {
  const text = String(raw ?? "").trim().replace(/\\/g, "/");
  const homeText = home.replace(/\\/g, "/").replace(/\/+$/, "");
  let rest: string, bare = false;
  if (text === "~" || text.startsWith("~/")) rest = text.slice(1);
  else if (text.toLowerCase() === homeText.toLowerCase() || text.toLowerCase().startsWith(homeText.toLowerCase() + "/")) rest = text.slice(homeText.length);
  else if (/^[a-z]:/i.test(text) || text.startsWith("/") || text.startsWith("~")) return "outside";
  else if (bareName) { rest = "/" + text; bare = true; }
  else return null;
  const parts = rest.split("/").filter((part) => part !== "" && part !== ".");
  const folder = ownerFolderRoots(home).find((one) => one.name.toLowerCase() === (parts[0] ?? "").toLowerCase());
  if (!folder) return bare ? null : "outside";
  const inside = parts.slice(1);
  for (const part of inside) {
    const why = badPart(part);
    if (why) throw new Error(`${raw}: ${why}.`);
  }
  return { folder, parts: inside };
}

/** The owner folder a files.list or files.move call reaches, by its real path, or null when it reaches none. */
export function ownerFolderIn(tool: string, args: unknown, home: string = homedir()): string | null {
  if (tool !== "files.list" && tool !== "files.move") return null;
  const a = (args && typeof args === "object" ? args : {}) as { path?: unknown; from?: unknown; to?: unknown; moves?: unknown };
  const moves = Array.isArray(a.moves) ? a.moves as { from?: unknown; to?: unknown }[] : [];
  for (const raw of [a.path, a.from, a.to, ...moves.flatMap((move) => [move?.from, move?.to])]) {
    if (typeof raw !== "string") continue;
    try {
      const place = ownerPathOf(raw, home);
      if (place && place !== "outside") return place.folder.path;
    } catch { /* a refused part: the tool itself says why */ }
  }
  return null;
}
/** The error for a place outside reach, in plain words, with what can be reached instead. */
export const outsideReach = (raw: string): string =>
  `${raw} is outside what I can reach. I can work in the workspace, and, once the person allows it, list and move files `
  + `in ~/Downloads, ~/Desktop and ~/Documents.`;
/** The error for anything but listing or moving in an owner folder. */
export const listAndMoveOnly = (raw: string, folder: OwnerFolder): string =>
  `${raw} is in the person's ${folder.name} folder, where I can only list files (files.list) and move them (files.move).`;

export interface OwnerFolderHost {
  store: Store;
  owner: string;
  approvals: Pick<ApprovalGate, "answer" | "takeOnce">;
  /** The conversation this call belongs to, where the owner's answers are kept. */
  sessionOf: (context: ToolContext) => string;
  home?: string;
}
export type FolderVerdict = "go" | "ask" | { refuse: string };

/** Whether this task may work in `folder` now, must ask, or is refused (and why). */
export function ownerFolderVerdict(host: OwnerFolderHost, context: ToolContext, folder: OwnerFolder): FolderVerdict {
  if (lockdownActive(host.store, host.owner)) return { refuse: `Lockdown is on, so Branch does not work in ${folder.path}.` };
  if (!ownersOwnTask(host.store, context)) return { refuse: `Only the owner's own tasks can work in ${folder.path}.` };
  const rule = readPolicy(host.store, host.owner).rules.find((each) => each.tool === ownerFolderTool && each.match === folder.path && !each.resource);
  if (rule?.decision === "deny") return { refuse: declined(folder) };
  if (rule?.decision === "allow") return "go";
  const sessionId = host.sessionOf(context);
  const answered = host.approvals.answer(sessionId, ownerFolderTool, folder.path);
  if (answered === "deny") return { refuse: declined(folder) };
  if (answered === "allow") return "go";
  if (host.approvals.takeOnce(sessionId, ownerFolderTool, folder.path)) return "go";
  if (nobodyToAsk(context) || (!context.askable && !context.approvalKey))
    return { refuse: `${folder.path} is outside what I can reach, and nobody is here to allow it.` };
  return "ask";
}
const declined = (folder: OwnerFolder): string =>
  `The person chose not to let Branch work in ${folder.path}. Do not try it again; say what you would have done instead.`;

/** The owner's own task: never a household person's, a short-lived key's, a lent one's, or one from outside. */
function ownersOwnTask(store: Store, context: ToolContext): boolean {
  if ((context.source ?? "owner") !== "owner" || startedWithShortLivedKey()) return false;
  if (!store.profiles.isOwner()) return false;
  const origin = context.runId ? runOrigin(store, context.runId) : null;
  if (origin && (origin.shortLivedKey || origin.source !== "owner" || origin.personProfileId || origin.lentTo)) return false;
  return !(context.runId && store.profiles.taskPerson?.(context.runId));
}

/** Asks, refuses, or lets the call go on. The question names the folder's real path. */
export function requireOwnerFolder(host: OwnerFolderHost, context: ToolContext, folder: OwnerFolder): void {
  const verdict = ownerFolderVerdict(host, context, folder);
  if (verdict === "go") return;
  if (verdict === "ask")
    throw new ApprovalRequiredError(ownerFolderTool, folder.path, `Work in your ${folder.name} folder`, "session", undefined,
      { question: `Let Branch list and move files in ${folder.path}?` });
  throw new Error(verdict.refuse);
}

/** Every part from the folder down must be a real folder or file, never a link or a junction. */
async function noLinks(folder: OwnerFolder, parts: string[]): Promise<void> {
  let current = folder.path;
  for (const part of ["", ...parts]) {
    current = part ? join(current, part) : current;
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`${current} is a link, so Branch leaves it alone.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/** Up to 200 entries of a folder inside an owner folder, links and secret-looking names left out. */
export async function listOwnerFolder(place: OwnerPath): Promise<{ folder: string; entries: { name: string; type: string }[]; note: string }> {
  await noLinks(place.folder, place.parts);
  const target = join(place.folder.path, ...place.parts);
  const info = await lstat(target).catch(() => null);
  if (!info) throw new Error(`${target} does not exist.`);
  if (!info.isDirectory()) throw new Error(`${target} is a file, not a folder.`);
  const entries: { name: string; type: string }[] = [];
  for (const entry of (await readdir(target, { withFileTypes: true })).slice(0, 400)) {
    if (entries.length >= 200) break;
    if (entry.isSymbolicLink() || secretPart.test(entry.name)) continue;
    entries.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
  }
  const shown = ["~", place.folder.name, ...place.parts].join("/");
  const loose = entries.filter((entry) => entry.type === "file").length;
  return { folder: target, entries, note: `Listing changes nothing. ${loose} loose file(s) here; to sort one, use files.move, `
    + `for example from ${shown}/<file> to ${shown}/<subfolder>/<file>.` };
}

/** One move, checked: within one owner folder, a file that exists, to a place that does not. */
async function checkedMove(from: OwnerPath, to: OwnerPath): Promise<{ source: string; target: string }> {
  if (from.folder.path !== to.folder.path)
    throw new Error(`A file can only be moved within one folder: ${from.folder.path} and ${to.folder.path} are different folders.`);
  if (!from.parts.length || !to.parts.length) throw new Error("Name the file to move and where it goes, not the folder itself.");
  await noLinks(from.folder, from.parts);
  await noLinks(to.folder, to.parts);
  const source = join(from.folder.path, ...from.parts), target = join(to.folder.path, ...to.parts);
  const info = await lstat(source).catch(() => null);
  if (!info) throw new Error(`${source} does not exist, so nothing was moved. Use files.list to see the folder's files.`);
  if (!info.isFile()) throw new Error(`${source} is not a file, so nothing was moved. Move files, not folders.`);
  if (await lstat(target).then(() => true, () => false)) throw new Error(`${target} already exists, so nothing was moved.`);
  return { source, target };
}
/**
 * Moves files within one owner folder. Every move is checked before any is made, so a bad one moves nothing; the
 * folders they go into are made. An existing file is never replaced.
 */
export async function moveInOwnerFolder(moves: readonly { from: OwnerPath; to: OwnerPath }[]):
Promise<{ moved: { from: string; to: string }[]; looseFilesLeft: string[]; note: string }> {
  const checked: { source: string; target: string; to: OwnerPath }[] = [];
  for (const move of moves) checked.push({ ...(await checkedMove(move.from, move.to)), to: move.to });
  const targets = checked.map((one) => one.target.toLowerCase());
  if (new Set(targets).size !== targets.length) throw new Error("Two moves go to the same place, so nothing was moved.");
  const moved: { from: string; to: string }[] = [];
  for (const one of checked) {
    await mkdir(join(one.to.folder.path, ...one.to.parts.slice(0, -1)), { recursive: true });
    // The folders just made are checked again, so nothing on the way was swapped for a link meanwhile.
    await noLinks(one.to.folder, one.to.parts);
    await rename(one.source, one.target);
    moved.push({ from: one.source, to: one.target });
  }
  // What is still loose where the files came from, so a task sorting a folder knows what is left to do.
  const first = moves[0]!.from, here = join(first.folder.path, ...first.parts.slice(0, -1));
  const left = (await readdir(here, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && !secretPart.test(entry.name)).map((entry) => entry.name);
  return { moved, looseFilesLeft: left.slice(0, 20),
    note: left.length ? `${left.length} loose file(s) are still in ${here}: ${left.slice(0, 20).join(", ")}.` : `No loose files are left in ${here}.` };
}
