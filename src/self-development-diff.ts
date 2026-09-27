import { resolve } from "node:path";
import type { GitOutcome, GitRunOptions } from "./integrations/git-run.js";
import { globFits, worktreesOwnRepository, type SelfDevelopmentContract } from "./self-development-contract.js";

/**
 * The bounded diff of a change to Branch itself, for the owner to read before saying yes to it: what
 * the self-development worktree has changed since the contract's source commit, file by file, with the
 * files outside the contract's allowed paths named. Bounded in files, bytes and lines, and marked cut
 * when it had to be. Git runs with Branch's pinned settings (src/integrations/git-run.ts), and with no
 * external diff program and no text conversion, so no program a repository names is started for it;
 * new files are listed by name only, never added to Git's index to show them.
 */
export const maxDiffFiles = 40;
export const maxDiffBytes = 262_144;
const maxLinesPerFile = 400;

export interface DiffLine { m: "+" | "-" | " "; t: string }
export interface DiffFile { path: string; added: number; removed: number; lines: DiffLine[]; cut: boolean }
export interface BoundedDiff {
  files: DiffFile[];
  /** New files not yet known to Git, by name only. */
  untracked: string[];
  /** Changed or new files the contract's allowed paths do not cover. */
  outside: string[];
  truncated: boolean;
  allowedPaths: string[];
  /** Said instead of a diff when there is nothing to show. */
  note: string | null;
  /** Files outside the allowed paths, or a diff cut at its bound, in one sentence each. */
  warning: string | null;
}
export interface DiffDeps { workspace: string; git: (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome> }

export const nothingPreparedYet = "Nothing has been changed yet. The edits are made only after you approve this request, in a copy of Branch's source held to the terms you write.";
const nothingChangedYet = "Nothing in this copy of Branch's source has changed yet.";

/** A unified diff as files of marked lines; each file's lines stop at the bound and say so. */
export function parsePatch(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null, before = "", inHunk = false;
  for (const line of text.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) { file = { path: header[2]!, added: 0, removed: 0, lines: [], cut: false }; files.push(file); inHunk = false; continue; }
    if (!file) continue;
    if (!inHunk && line.startsWith("--- ")) { before = line.slice(4).replace(/^a\//, ""); continue; }
    if (!inHunk && line.startsWith("+++ ")) { const after = line.slice(4); file.path = after === "/dev/null" ? before : after.replace(/^b\//, ""); continue; }
    if (line.startsWith("@@")) { inHunk = true; push(file, { m: " ", t: line }); continue; }
    if (!inHunk || line.startsWith("\\")) continue;
    const m = line[0];
    if (m === "+") file.added++;
    else if (m === "-") file.removed++;
    else if (m !== " ") continue;
    push(file, { m, t: line.slice(1) });
  }
  return files;
}
function push(file: DiffFile, line: DiffLine): void {
  if (file.lines.length < maxLinesPerFile) file.lines.push(line);
  else file.cut = true;
}

export async function boundedDiff(deps: DiffDeps, contract: SelfDevelopmentContract, signal: AbortSignal): Promise<BoundedDiff> {
  if (!(await worktreesOwnRepository(deps, contract, signal)))
    throw new Error(`The repository Git finds in ${contract.worktreePath} is not the worktree's own, so its changes are not shown.`);
  const cwd = resolve(deps.workspace, contract.worktreePath);
  const git = (args: string[], maxOutputBytes: number) => deps.git({ cwd, args, timeoutMs: 30_000, maxOutputBytes }, signal);
  const patch = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3", contract.sourceSha, "--"], maxDiffBytes);
  const others = await git(["ls-files", "--others", "--exclude-standard", "-z"], 65_536);
  if (patch.status !== "completed" || others.status !== "completed") throw new Error("Branch could not read what changed in this copy of its source.");
  const files = parsePatch(patch.stdout);
  const untracked = others.stdout.split("\0").filter(Boolean);
  const outside = [...new Set([...files.map((f) => f.path), ...untracked])].filter((path) => !contract.allowedPaths.some((glob) => globFits(glob, path)));
  const truncated = !!patch.truncated || !!others.truncated || files.length > maxDiffFiles || untracked.length > maxDiffFiles || files.some((f) => f.cut);
  const warning = [outside.length ? `These changed files are outside the contract's allowed paths: ${outside.slice(0, 10).join(", ")}.` : "",
    truncated ? "Only part of the change is shown here; it is longer than Branch shows at once." : ""].filter(Boolean).join(" ") || null;
  return { files: files.slice(0, maxDiffFiles), untracked: untracked.slice(0, maxDiffFiles), outside: outside.slice(0, maxDiffFiles), truncated,
    allowedPaths: contract.allowedPaths, note: files.length || untracked.length ? null : nothingChangedYet, warning };
}
