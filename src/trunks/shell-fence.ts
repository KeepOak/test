import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, parse, resolve, sep } from "node:path";
import type { ToolContext } from "../contracts.js";
import { trunkFilesHome } from "./file-root.js";

/**
 * What keeps a Trunk's commands out of the other Trunks' folders, and what does not.
 *
 * A Trunk's own turn works in `.branch-agents/<id>` (src/trunks/file-root.ts), and `files.*` is held to it. A command
 * started there runs as the owner, so on its own it could still read `../<other id>`. Two layers stand in the way:
 *
 * 1. The words of the command, on every computer (`fenceRefusal`, called by src/integrations/shell.ts): a piece of an
 *    argument that points at another Trunk's folder, at `.branch-agents` itself or at a folder above it, or that names
 *    another Trunk's id, is refused before the program starts.
 * 2. The system, on macOS and Linux while the wall is on (Settings, src/sandbox-wall.ts): the other Trunks' folders are
 *    among the places a program behind the wall may not even read.
 *
 * What is not enforced, said plainly: the word check cannot see a path a program builds for itself (a script file, a
 * variable, a computed path), so it is a guard, not a sandbox. Windows has no system wall here at all, so there the
 * word check is the only layer. The word check covers `shell.execute` only, not `code.run` or `process.start`; a
 * Trunk working in a copy of a project (a coding fork) is not fenced; and the filesystem root itself (`/`, `C:\`) is let
 * through, since `/` and `//` are everyday script text, so a program searching from the root is not caught. The fence
 * follows where the work runs, not who asked: a helper a Trunk starts works in the Trunk's folder, and is fenced too.
 * Like OpenClaw, which says of its per-agent workspaces that they are the default folder and "not a hard sandbox" (docs/concepts/multi-agent.md, https://github.com/openclaw/openclaw/blob/1794d8b4ef8dde46f39a16da2bdbcf0bf2b519ef/docs/concepts/multi-agent.md),
 * Branch never calls this a sandbox. A Trunk's own state (its personal files, memory, secrets and conversations) is kept
 * in Branch's data folder, not in the workspace.
 */
export interface TrunkFence {
  /** The Trunk's own folder, where its command runs. */
  own: string;
  /** `.branch-agents`, the folder every Trunk's folder sits in. */
  home: string;
  /** The other Trunks' folders there now. */
  siblings: string[];
}

// Windows and macOS name files without regard to case by default, so there `../BOB` is Bob's folder.
const caseBlind = process.platform === "win32" || process.platform === "darwin";
const same = (path: string): string => (caseBlind ? path.toLowerCase() : path);
const within = (path: string, folder: string): boolean => {
  const [p, f] = [same(path), same(folder)];
  return p === f || p.startsWith(f.endsWith(sep) ? f : f + sep);
};
/** A place as written and as the system names it (a link, or Windows' short names), so neither slips past. */
function forms(path: string): string[] {
  try { const real = realpathSync(path); return real === path ? [path] : [path, real]; } catch { return [path]; }
}

/**
 * The fence for work running in a Trunk's own folder (src/trunks/file-root.ts gives a Trunk's turn that folder, and its
 * helpers inherit it); null for anything else (the owner's turn, a coding fork). Read from where the work runs, not from
 * who asked, so a helper carrying a specialist's name instead of the Trunk's is held all the same.
 */
export function trunkFence(context: Pick<ToolContext, "workspace">): TrunkFence | null {
  // A call that names no workspace (the wall is asked about before a task's place is known) runs in no Trunk's folder.
  if (!context.workspace) return null;
  const own = resolve(context.workspace), id = basename(own);
  if (basename(dirname(own)) !== trunkFilesHome) return null;
  const home = dirname(own);
  let names: string[] = [];
  try { names = readdirSync(home, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { names = []; }
  return { own, home, siblings: names.filter((name) => same(name) !== same(id)).map((name) => resolve(home, name)) };
}

/** The places a program behind the wall may not read, for a Trunk's call: every other Trunk's folder. */
export function fencedFolders(context: Pick<ToolContext, "workspace">): string[] {
  return trunkFence(context)?.siblings.flatMap(forms) ?? [];
}

/** Pieces of an argument that could be a path: split on spaces, quotes and the characters a shell or script joins with. */
const pieces = (arg: string): string[] => arg.split(/[\s"'`;&|()<>=,]+/).filter(Boolean);

/** Why a Trunk's command may not run as written, or null. `cwd` is where it starts; `args` are exactly what it is given. */
export function fenceRefusal(fence: TrunkFence, cwd: string, args: readonly string[]): string | null {
  const homes = forms(fence.home), owns = forms(fence.own);
  // Trunk ids are UUIDs (src/trunks/record.ts), matched as text in any case on every computer; a short folder name is
  // left to the path check, never matched as text.
  const ids = fence.siblings.map((path) => basename(path).toLowerCase()).filter((id) => id.length >= 8);
  for (const arg of args) {
    const named = ids.find((id) => arg.toLowerCase().includes(id));
    if (named) return refusal(arg);
    for (const piece of pieces(arg)) {
      const path = resolve(cwd, piece);
      if (owns.some((own) => within(path, own)) || path === parse(path).root) continue; // the root: see above
      // Inside .branch-agents but not this Trunk's folder, or .branch-agents itself or any folder above it.
      if (homes.some((home) => within(path, home) || within(home, path))) return refusal(piece);
    }
  }
  return null;
}
function refusal(piece: string): string {
  return `A Trunk's commands stay in its own folder: "${piece.slice(0, 200)}" reaches the folder that holds every Trunk's `
    + "files, or another Trunk's. Branch checks a command's words for this on every computer; on macOS and Linux with the "
    + "wall switched on, the system also hides the other Trunks' folders. The word check cannot see a path a program builds "
    + "for itself, and Windows has no system wall here, so this is a guard and not a sandbox.";
}
