import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { audit, auditOrigins, type AuditOrigin } from "./audit.js";
import type { ToolContext } from "./contracts.js";
import { branchRef, type GitOutcome, type GitRunOptions } from "./integrations/git-run.js";
import { commandFolder } from "./integrations/shell-config.js";
import { cwdOf } from "./never-break/protected.js";
import { isReadOnlyPermission } from "./policy.js";
import { isCommandTool } from "./policy-resources.js";
import { wallReport } from "./sandbox-backends.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * Q12: Branch changing its own source is bound to a contract written down before the first change.
 *
 * `branch.prepare_source_change` asks the model to propose the terms (which paths, which tools, which
 * tests, what "done" means, what else it touches, how to undo it). Branch adds what the model may not
 * choose: the exact source commit and the worktree. The contract is stored once, with a hash of its
 * contents, in a table that refuses edits and removals. Every call that could change something inside
 * `branch-agent-source` is then checked against it (`contractGuard`, run by `ToolRegistry.execute`).
 * A call outside the contract is refused and written in the audit record. A wider contract is a new
 * revision, made only by `branch.widen_source_contract`, which the owner is asked about every time.
 */
export const sourceFolder = "branch-agent-source";
export const prepareToolName = "branch.prepare_source_change";
export const widenToolName = "branch.widen_source_contract";
export const widenReason = "Branch asks you every time before it widens what it may change in its own source";
const worktreePattern = /^branch-agent-source\/\.branch-worktrees\/self-[a-z0-9][a-z0-9-]{0,23}$/;
const shaPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const relativeGlob = z.string().trim().min(1).max(200).refine(
  (value) => !value.startsWith("/") && !/[\\:\0]/.test(value) && !value.split("/").includes(".."),
  "Use a path inside the worktree, written with forward slashes and without ..",
);
export const ContractTermsSchema = z.object({
  allowedPaths: z.array(relativeGlob).min(1).max(50),
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/)).min(1).max(50),
  expectedTests: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  definitionOfDone: z.string().trim().min(1).max(2000),
  sideEffects: z.array(z.string().trim().min(1).max(300)).max(30),
  rollbackPlan: z.string().trim().min(1).max(2000),
}).strict();
export type ContractTerms = z.infer<typeof ContractTermsSchema>;

export interface SelfDevelopmentContract extends ContractTerms {
  taskRunId: string;
  sourceSha: string;
  worktreePath: string;
  revision: number;
  createdAt: string;
  /** Empty for the first revision; the owner who allowed a widening afterwards. */
  approvedBy: string;
  reason: string;
}

/** JSON with every object's keys in order, so the same contract always hashes the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const contractHash = (contract: SelfDevelopmentContract): string =>
  createHash("sha256").update(canonical(contract)).digest("hex");

/** Makes the contracts table and the two rules that refuse any change or removal, once. */
export function ensureContractTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS self_development_contracts(id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL, worktree TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(owner, worktree, revision));
    CREATE TRIGGER IF NOT EXISTS self_development_contracts_no_update BEFORE UPDATE ON self_development_contracts
      BEGIN SELECT RAISE(ABORT, 'A self-development contract cannot be changed; widen it with a new revision'); END;
    CREATE TRIGGER IF NOT EXISTS self_development_contracts_no_delete BEFORE DELETE ON self_development_contracts
      BEGIN SELECT RAISE(ABORT, 'A self-development contract cannot be removed'); END;`);
}

/** The written contracts: one row per revision, never changed or removed once written. */
export class ContractBook {
  constructor(private readonly db: DatabaseSync) {
    ensureContractTable(this.db);
  }
  /** Writes the first revision. Refused when the worktree already has a contract. */
  create(owner: string, input: { taskRunId: string; sourceSha: string; worktreePath: string; terms: ContractTerms }): SelfDevelopmentContract {
    if (!worktreePattern.test(input.worktreePath)) throw new Error("A contract is only for a Branch Agent self-development worktree.");
    if (!shaPattern.test(input.sourceSha)) throw new Error("A contract needs the exact source commit.");
    if (this.history(owner, input.worktreePath).length)
      throw new Error(`${input.worktreePath} already has a contract. Widening it needs ${widenToolName} and the owner's yes.`);
    return this.insert(owner, { ...ContractTermsSchema.parse(input.terms), taskRunId: input.taskRunId.slice(0, 64),
      sourceSha: input.sourceSha, worktreePath: input.worktreePath, revision: 1, createdAt: new Date().toISOString(), approvedBy: "", reason: "" });
  }
  /**
   * Writes the next revision with the changed terms. Only `branch.widen_source_contract` calls this,
   * after the owner said yes to that exact request; the revisions before stay as they were.
   */
  widen(owner: string, worktreePath: string, input: { taskRunId: string; terms: { [K in keyof ContractTerms]?: ContractTerms[K] | undefined }; approvedBy: string; reason: string }): SelfDevelopmentContract {
    const current = this.current(owner, worktreePath);
    if (!current) throw new Error(`${worktreePath} has no contract to widen.`);
    if (!input.approvedBy.trim()) throw new Error("Widening a contract needs the owner's approval.");
    const terms: ContractTerms = { allowedPaths: current.allowedPaths, permissions: current.permissions, expectedTests: current.expectedTests,
      definitionOfDone: current.definitionOfDone, sideEffects: current.sideEffects, rollbackPlan: current.rollbackPlan };
    const changed = Object.fromEntries(Object.entries(input.terms).filter(([, value]) => value !== undefined));
    const next = ContractTermsSchema.parse({ ...terms, ...changed });
    return this.insert(owner, { ...next, taskRunId: input.taskRunId.slice(0, 64), sourceSha: current.sourceSha, worktreePath,
      revision: current.revision + 1,
      createdAt: new Date().toISOString(), approvedBy: input.approvedBy.slice(0, 120), reason: input.reason.slice(0, 500) });
  }
  /** The newest revision, or null. Throws when any revision no longer matches its hash. */
  current(owner: string, worktreePath: string): SelfDevelopmentContract | null {
    return this.history(owner, worktreePath).at(-1) ?? null;
  }
  /** Every revision, oldest first, each checked against the hash written beside it. */
  history(owner: string, worktreePath: string): SelfDevelopmentContract[] {
    const rows = this.db.prepare("SELECT revision, body, hash FROM self_development_contracts WHERE owner=? AND worktree=? ORDER BY revision")
      .all(owner, worktreePath);
    return rows.map((row, at) => {
      const contract = JSON.parse(String(row.body)) as SelfDevelopmentContract;
      if (contractHash(contract) !== String(row.hash) || contract.revision !== at + 1 || Number(row.revision) !== at + 1
        || contract.worktreePath !== worktreePath)
        throw new Error(`The contract for ${worktreePath} (revision ${String(row.revision)}) does not match its hash; it was changed after it was written.`);
      return contract;
    });
  }
  private insert(owner: string, contract: SelfDevelopmentContract): SelfDevelopmentContract {
    this.db.prepare("INSERT INTO self_development_contracts(owner, worktree, revision, body, hash, created_at) VALUES(?,?,?,?,?,?)")
      .run(owner, contract.worktreePath, contract.revision, JSON.stringify(contract), contractHash(contract), contract.createdAt);
    return contract;
  }
}

export const firstContractReason = "Branch asks you every time before it starts changing its own source";

/** A path glob with no fixed leading folder (`**`, `*`, `*.ts`, or a wildcard first folder) can reach anywhere in the worktree. */
const broadGlob = (pattern: string): boolean => /[*?[]/.test(pattern.split("/")[0] ?? "");

/**
 * A list for the owner's question: every broad glob first, always shown in full, then the rest as
 * long as they fit, and "and N more" when some are left out, so nothing wide can hide at the end.
 */
function listed(values: string[], none: string): string {
  if (!values.length) return none;
  const ordered = [...values.filter(broadGlob), ...values.filter((value) => !broadGlob(value))];
  const shown: string[] = [];
  for (const value of ordered) {
    if (!broadGlob(value) && shown.join(", ").length + value.length > 300) break;
    shown.push(value);
  }
  const rest = ordered.length - shown.length;
  return rest ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** The paths and tools a proposed contract asks for, in plain words, for the owner's question. */
function askedFor(terms: unknown): string {
  const asked = (terms ?? {}) as { allowedPaths?: unknown; permissions?: unknown };
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  return `It would be allowed to change ${listed(strings(asked.allowedPaths), "no new paths")}, using ${listed(strings(asked.permissions), "no new tools")}.`;
}

/**
 * The first contract and every wider one are put to the owner, once each, whatever the rules say,
 * so a model can never give itself `**` and every tool. The question names the paths and tools asked for.
 */
export function contractHold(tool: string, args: unknown): { reason: string; onceOnly: true } | null {
  const input = (args ?? {}) as { contract?: unknown; changes?: unknown };
  if (tool === prepareToolName) return { reason: `${firstContractReason}. ${askedFor(input.contract)}`, onceOnly: true };
  if (tool === widenToolName) return { reason: `${widenReason}. ${askedFor(input.changes)}`, onceOnly: true };
  return null;
}

/** A path glob: `**` spans folders, `*` and `?` stay inside one name, a trailing `/` means the whole folder. */
export function globFits(pattern: string, path: string): boolean {
  const whole = pattern.endsWith("/") ? `${pattern}**` : pattern;
  const source = whole.split(/(\*\*\/|\*\*|\*|\?)/).map((part) =>
    part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]"
      : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${source}$`, "s").test(path);
}

const tidy = (value: string): string => value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
/** A path with its links followed: the nearest part that exists is read back from the disk, the rest kept as written. */
function onDisk(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  try { return join(realpathSync.native(existing), ...rest); } catch { return path; }
}
/**
 * The one spelling of a path inside the source folder. Only the source folder's own name is folded
 * (lowercased, trailing dots and spaces taken off): macOS and Windows find `Branch-Agent-Source` or
 * `branch-agent-source.` as the same folder, and on a disk that tells them apart treating them as
 * the source fails closed. `.branch-worktrees` and the worktree's name are never folded: where the
 * disk ignores case the path has already been read back from the disk in its true spelling, and
 * anywhere else `.Branch-Worktrees` or `SELF-X` is some other folder inside the protected checkout,
 * so a misspelled one is not a worktree and is refused as the checkout itself.
 */
function sourceSpelling(path: string): string {
  const parts = path.split("/");
  if ((parts[0] ?? "").replace(/[. ]+$/, "").toLowerCase() !== sourceFolder) return path;
  return [sourceFolder, ...parts.slice(1)].join("/");
}
/**
 * A Windows path without its device or network prefix: `\\?\C:\x` and `\\.\C:\x` are `C:\x`, and
 * `\\?\UNC\localhost\C$\x` or `\\localhost\C$\x` (this computer's own admin share) are `C:\x`
 * too, so each names the same place the plain spelling does.
 */
export function windowsPlain(path: string): string {
  const device = path.replace(/^[\\/]{2}[?.][\\/](?!UNC[\\/])/i, "");
  const share = /^(?:[\\/]{2}[?.][\\/]UNC[\\/]|[\\/]{2})(?:localhost|127\.0\.0\.1|\.)[\\/]([A-Za-z])\$(?=[\\/]|$)/i.exec(device);
  return share ? `${share[1]}:${device.slice(share[0].length) || "\\"}` : device;
}

/** Where a path named from `scope` really is, from the workspace, or null when it is outside it. */
export function workspacePath(workspace: string, scope: string, path: string, platform: NodeJS.Platform = process.platform): string | null {
  const paths = platform === "win32" ? win32 : posix;
  // The disk is asked only on the computer it belongs to; on Windows a path is compared without its prefix.
  const real = platform === process.platform ? onDisk : (value: string) => value;
  const plain = platform === "win32" ? windowsPlain : (value: string) => value;
  const root = real(paths.resolve(plain(workspace)));
  const full = real(paths.resolve(plain(workspace), plain(scope), plain(path)));
  const inside = paths.relative(root, full);
  if (inside.startsWith("..") || paths.isAbsolute(inside)) return null;
  return sourceSpelling(tidy(inside));
}
const insideSource = (path: string): boolean => path === sourceFolder || path.startsWith(`${sourceFolder}/`);
/** The self-development worktree a workspace path is in, or "" for the protected checkout itself. */
export function worktreeOf(path: string): string {
  const match = /^branch-agent-source\/\.branch-worktrees\/[^/]+/.exec(path);
  return match && worktreePattern.test(match[0]) ? match[0] : "";
}

export interface ContractGuardDeps {
  store: Store;
  owner: string;
  workspace: string;
  registry: ToolRegistry;
  book: ContractBook;
  git: (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;
  /** Whether this computer has a sandbox that can hold a command's writes to one folder. Replaced in tests. */
  confinement?: () => Promise<boolean>;
}

/** The workspace paths (forward slashes, from the workspace) a call names. */
/** A path a call names, and whether the call acts on the whole of it (a folder it pulls into, runs in, or commits whole). */
interface NamedPath { path: string; folder: boolean }

/** Whether a workspace path is a folder on disk now. */
function folderOnDisk(workspace: string, path: string): boolean {
  try { return statSync(resolve(workspace, path)).isDirectory(); } catch { return false; }
}

function pathsOf(deps: ContractGuardDeps, name: string, args: unknown, context: ToolContext, scope: string): NamedPath[] {
  // `probe`: whether a folder on disk means the call acts on all of it. A tool that lists its targets
  // says so itself (git tools name the repository folder beside the files they touch, whole only when no file is named).
  const named: { path: string; folder: boolean; probe: boolean }[] = [];
  const many = deps.registry.targetsOf(name, args, context);
  if (many) for (const one of many) { if (one.path) named.push({ path: one.path, folder: one.folder === true, probe: false }); }
  else {
    const target = deps.registry.targetOf(name, args, context);
    const resource = target ? deps.registry.resourceOf(name, target, args) : null;
    // A tool that words its own target (the pull request tool: "send changes to GitHub on ...") is
    // not naming a file unless it works on files, as the approval policy reads it too.
    const worded = deps.registry.declaresTarget(name).target && !/^(files|documents|media|data|code)\./.test(deps.registry.permissionOf(name));
    if (resource?.kind === "path" && !worded) named.push({ path: resource.value, folder: false, probe: true });
  }
  // A command's working folder counts too, read exactly as the command tool reads it (from the
  // workspace, not the active project: commandFolder), so the folder judged is the folder it runs in.
  const cwd = cwdOf(args).cwd;
  if (cwd) named.push({ path: commandFolder(context.workspace || deps.workspace, cwd), folder: true, probe: false });
  return named.flatMap(({ path, folder, probe }) => {
    const where = workspacePath(deps.workspace, scope, path);
    return where === null ? [] : [{ path: where, folder: folder || (probe && folderOnDisk(deps.workspace, where)) }];
  });
}

/**
 * Whether the allowed paths cover a whole folder inside the worktree ("" for the worktree itself):
 * `**`, or `<folder>/**` (or `<folder>/`) for the folder or one above it. A tool that works on a
 * whole folder (git.pull, a command's working folder, a folder a tool names) can change anything
 * in it, so a glob that only fits some files there is not enough.
 */
function coversFolder(allowedPaths: readonly string[], folder: string): boolean {
  return allowedPaths.some((pattern) => {
    if (pattern === "**") return true;
    const fixed = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern.endsWith("/") ? pattern.slice(0, -1) : null;
    return fixed !== null && !/[*?[]/.test(fixed) && folder !== "" && (folder === fixed || folder.startsWith(`${fixed}/`));
  });
}

/** Tools whose folder target is what they send, judged commit by commit instead (`remoteBroken`). */
const sendingTools = new Set(["git.push", "github.pull_request_from_changes", "github.open_pull_request"]);

/** Why the call breaks the contract's worktree, tools or paths, or null when it keeps to them. */
function termsBroken(contract: SelfDevelopmentContract, name: string, paths: readonly NamedPath[]): string | null {
  if (!contract.permissions.includes(name))
    return `${name} is not one of the tools this contract allows (${contract.permissions.join(", ")}).`;
  for (const { path, folder } of paths) {
    const worktree = worktreeOf(path);
    if (worktree !== contract.worktreePath) return `${path} is outside the contract's worktree ${contract.worktreePath}.`;
    const inside = path.slice(worktree.length + 1);
    // A folder named only as where the files are (git.commit with paths) is judged by those files.
    if (folder) {
      if (!sendingTools.has(name) && !coversFolder(contract.allowedPaths, inside))
        return `${name} works on the whole of ${inside || "the worktree"}, and the contract's allowed paths do not cover all of it (${contract.allowedPaths.join(", ")}).`;
    } else if (inside && !contract.allowedPaths.some((pattern) => globFits(pattern, inside)))
      return `${inside} is outside the contract's allowed paths (${contract.allowedPaths.join(", ")}).`;
  }
  return null;
}

/** The paths on both sides of every change in a list of `git log --name-status` lines. */
const namesInLog = (text: string): string[] =>
  text.split("\n").filter((line) => line.includes("\t")).flatMap((line) => line.split("\t").slice(1));

/** Q109: the branch HEAD points at in the worktree, or `HEAD` itself when it is detached (the push then refuses). */
async function checkedOut(deps: Pick<ContractGuardDeps, "workspace" | "git">, contract: SelfDevelopmentContract, signal: AbortSignal): Promise<string> {
  const outcome = await deps.git({ cwd: resolve(deps.workspace, contract.worktreePath), args: ["symbolic-ref", "-q", "HEAD"], timeoutMs: 10_000 }, signal);
  const ref = outcome.status === "completed" ? outcome.stdout.trim() : "";
  return /^refs\/heads\/./.test(ref) ? ref : "HEAD";
}
/** Q109: the one commit `ref` names now, or "" when it names none. */
async function commitOf(deps: Pick<ContractGuardDeps, "workspace" | "git">, contract: SelfDevelopmentContract, signal: AbortSignal, ref: string): Promise<string> {
  const outcome = await deps.git({ cwd: resolve(deps.workspace, contract.worktreePath), args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], timeoutMs: 10_000 }, signal);
  return outcome.status === "completed" ? outcome.stdout.trim() : "";
}

/**
 * Why sending `ref` (walked as `commit`) breaks the contract, or null. `ref` must still start from the contract's source
 * commit, and every change on the way there is checked, commit by commit, on both sides (renames as
 * a removal and an addition, merges against each parent), along with what is changed or new in the
 * worktree and not yet committed. A file added and removed again, or moved out of the allowed paths
 * under another name, is caught as surely as one left changed at the end.
 */
/** Whether the repository Git finds in the worktree is the worktree's own, sharing the source checkout's, not one planted in it. */
export async function worktreesOwnRepository(deps: Pick<ContractGuardDeps, "workspace" | "git">, contract: SelfDevelopmentContract, signal: AbortSignal): Promise<boolean> {
  const cwd = resolve(deps.workspace, contract.worktreePath);
  const found = await deps.git({ cwd, args: ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], timeoutMs: 60_000 }, signal);
  const [top = "", common = ""] = found.stdout.trim().split("\n");
  return found.status === "completed" && !!top && onDisk(resolve(top)) === onDisk(cwd) && onDisk(resolve(cwd, common)) === onDisk(resolve(deps.workspace, sourceFolder, ".git"));
}

async function remoteBroken(deps: Pick<ContractGuardDeps, "workspace" | "git">, contract: SelfDevelopmentContract, signal: AbortSignal, commit: string, ref = commit): Promise<string | null> {
  const cwd = resolve(deps.workspace, contract.worktreePath);
  const git = (args: string[]) => deps.git({ cwd, args, timeoutMs: 60_000, maxOutputBytes: 4_194_304 }, signal);
  if (!(await worktreesOwnRepository(deps, contract, signal)))
    return `The repository Git finds in ${contract.worktreePath} is not the worktree's own, so nothing is sent from it.`;
  if ((await git(["merge-base", "--is-ancestor", contract.sourceSha, commit])).status !== "completed")
    return `${ref === "HEAD" ? "This worktree" : ref} no longer starts from the contract's source commit ${contract.sourceSha.slice(0, 12)}.`;
  const walked = await git(["log", "--no-renames", "-m", "--name-status", "--format=", `${contract.sourceSha}..${commit}`]);
  const changed = await git(["diff", "--no-renames", "--name-only", "-z", contract.sourceSha]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if ([walked, changed, untracked].some((outcome) => outcome.status !== "completed" || outcome.truncated))
    return "Branch could not list everything that changed in this worktree.";
  const files = [...namesInLog(walked.stdout), ...`${changed.stdout}\0${untracked.stdout}`.split("\0")].map(tidy).filter(Boolean);
  const outside = [...new Set(files.filter((file) => !contract.allowedPaths.some((pattern) => globFits(pattern, file))))];
  return outside.length ? `These changed files are outside the contract's allowed paths: ${outside.slice(0, 10).join(", ")}.` : null;
}

/**
 * Writes the refusal down, then refuses the call. The refusal is Branch's own ("system"), made
 * against the task named as the actor; what started that task goes in the origin column. The owner
 * did not do this, so the row does not say they did.
 */
function refuse(deps: Pick<ContractGuardDeps, "store" | "owner">, context: Pick<ToolContext, "runId" | "source">, name: string, worktree: string, why: string): never {
  // A task says nothing of where it came from when the owner started it, as elsewhere (`context.source ?? "owner"`).
  const from = context.source ?? "owner";
  const started = (auditOrigins as readonly string[]).includes(from) ? { origin: from as AuditOrigin } : {};
  audit(deps.store, deps.owner, { action: "self_development.contract", actor: context.runId ? `task:${context.runId}`.slice(0, 120) : "Branch",
    subject: `${name} in ${worktree || sourceFolder}`.slice(0, 300), reason: why.slice(0, 500), source: "system", ...started,
    runId: context.runId ? context.runId.slice(0, 64) : null, outcome: "refused" });
  throw new Error(`Refused by the self-development contract: ${why}`);
}

const remotePermissions = new Set(["git.remote", "github.manage"]);

/**
 * The contract a changing call inside `branch-agent-source` is held to, once its worktree, tools and
 * paths have been checked against it (a refusal throws, audited); null when the call only looks or
 * touches nothing there.
 */
/**
 * Q12: where a Git tool would run inside Branch's source when that is not a worktree's root, or null.
 * Git reads the repository it finds there, and a repository's own settings can start programs
 * (core.fsmonitor, a filter), so a `.git` a held command planted deeper down must never be run in.
 * Branch pins the known settings (src/integrations/git-run.ts); this keeps Git out of such folders.
 */
function gitBelowRoot(deps: ContractGuardDeps, name: string, args: unknown): string | null {
  // Q98: publishing runs `git remote` and `git push` in its folder too.
  if (!/^(git|plans)\./.test(name) && name !== "github.publish_repo") return null;
  const named = (args as { folder?: unknown } | null)?.folder;
  const scope = workspacePath(deps.workspace, "", deps.registry.pathScope() || ".") ?? "";
  const folder = workspacePath(deps.workspace, scope, typeof named === "string" && named ? named : ".");
  return folder !== null && insideSource(folder) && worktreeOf(folder) !== folder ? folder : null;
}

function heldTerms(deps: ContractGuardDeps, name: string, args: unknown, context: ToolContext): { contract: SelfDevelopmentContract; permission: string } | null {
  if (name === prepareToolName || name === widenToolName) return null;
  const below = gitBelowRoot(deps, name, args);
  if (below) refuse(deps, context, name, worktreeOf(below), `Git runs in Branch's own source only at a self-development worktree's root, never in ${below}, where a repository's own settings could start a program outside the sandbox.`);
  const permission = deps.registry.permissionOf(name);
  if (isReadOnlyPermission(permission)) return null;
  const scope = workspacePath(deps.workspace, "", deps.registry.pathScope() || ".") ?? "";
  let paths: NamedPath[];
  try { paths = pathsOf(deps, name, args, context, scope); } catch (error) {
    // Outside the source the approval policy already refuses a call whose targets cannot be told.
    if (!insideSource(scope)) return null;
    refuse(deps, context, name, worktreeOf(scope), `Branch could not tell what this call would change: ${(error as Error).message}`);
  }
  if (!insideSource(scope) && !paths.some((one) => insideSource(one.path))) return null;
  const worktree = worktreeOf(insideSource(scope) ? scope : paths.find((one) => insideSource(one.path))!.path);
  if (!worktree) refuse(deps, context, name, "", "The protected Branch Agent source checkout is never changed directly; work in a self-development worktree.");
  let contract: SelfDevelopmentContract | null;
  try { contract = deps.book.current(deps.owner, worktree); } catch (error) { refuse(deps, context, name, worktree, (error as Error).message); }
  if (!contract) refuse(deps, context, name, worktree, `no contract: ${worktree} has no self-development contract, so nothing in it may be changed.`);
  const broken = termsBroken(contract, name, paths);
  if (broken) refuse(deps, context, name, worktree, broken);
  return { contract, permission };
}

/** Permissions whose tools start a program on this computer. */
const commandPermissions = new Set(["shell.execute", "code.execute", "process.manage"]);
/** The one command tool the shell can hold behind the OS sandbox with its writes kept to one folder. */
const confinableCommand = "shell.execute";
const whileCheckedOut = "While Branch's own source is checked out in this workspace, ";

/** Whether a tool starts a program here: by its permission, its name, or a command line it reports. */
function startsProgram(deps: ContractGuardDeps, name: string, args: unknown): boolean {
  return commandPermissions.has(deps.registry.permissionOf(name)) || isCommandTool(name)
    || deps.registry.resourceOf(name, "", args)?.kind === "command";
}

/** Whether Branch's own source is checked out in this workspace, under any spelling of its folder. */
export function sourceCheckedOut(workspace: string): boolean {
  try { return readdirSync(workspace).some((entry) => sourceSpelling(entry) === sourceFolder); } catch { return false; }
}

const canConfineWrites = async (): Promise<boolean> => (await wallReport()).available;

/**
 * A command's text is never read: globs and variables can always name Branch's source some other
 * way. So while that source is checked out here, a command runs only as `shell.execute`, from the
 * active self-development worktree, listed in its contract, and behind the OS sandbox with its
 * writes held to that worktree. Anything else is refused and audited; a computer with no such
 * sandbox refuses every command until the checkout is gone.
 */
async function confineCommand(deps: ContractGuardDeps, name: string, args: unknown, context: ToolContext): Promise<Pick<ToolContext, "writesConfinedTo">> {
  const scope = workspacePath(deps.workspace, "", deps.registry.pathScope() || ".") ?? "";
  const worktree = worktreeOf(scope);
  if (name !== confinableCommand)
    refuse(deps, context, name, worktree, `${whileCheckedOut}${name} is refused: Branch cannot hold the program it starts to one folder. Only shell.execute runs then, from the active self-development worktree, behind the OS sandbox.`);
  const folder = workspacePath(deps.workspace, "", commandFolder(context.workspace || deps.workspace, cwdOf(args).cwd));
  if (!worktree || folder === null || worktreeOf(folder) !== worktree)
    refuse(deps, context, name, worktree, `${whileCheckedOut}a command runs only inside the active self-development worktree: make its project active and set cwd to a folder in ${worktree || "branch-agent-source/.branch-worktrees/self-<name>"}. Commands run anywhere else again once the self-development work is finished and branch-agent-source is removed from the workspace.`);
  heldTerms(deps, name, args, context);
  if (!(await (deps.confinement ?? canConfineWrites)()))
    refuse(deps, context, name, worktree, `${whileCheckedOut}commands are refused on this computer: it has no sandbox that can hold a command's writes to one folder.`);
  // The folder it runs in, which the allowed paths cover whole (termsBroken): its writes are held there.
  return { writesConfinedTo: resolve(deps.workspace, folder) };
}

/**
 * The check `ToolRegistry.execute` runs before a tool does anything. Calls that only look, and calls
 * that touch nothing inside `branch-agent-source`, pass untouched. Everything else needs the
 * worktree's contract and must keep to it; a remote step also needs the contract's source commit
 * underneath it and no changed file outside the allowed paths. Commands follow `confineCommand`.
 */
export function contractGuard(deps: ContractGuardDeps): (name: string, args: unknown, context: ToolContext) => Promise<Pick<ToolContext, "writesConfinedTo" | "sendsRef" | "sendsCommit"> | void> {
  return async (name, args, context) => {
    if (startsProgram(deps, name, args) && sourceCheckedOut(deps.workspace)) return confineCommand(deps, name, args, context);
    const held = heldTerms(deps, name, args, context);
    if (!held || !remotePermissions.has(held.permission)) return;
    // git.push and publishing send the branch they name (or the one checked out); that ref is the one walked.
    const pushes = name === "git.push" || name === "github.publish_repo";
    const named = (args as { branch?: unknown } | null)?.branch;
    const sends = pushes && typeof named === "string" && named && named !== "HEAD" ? named : "";
    // Walked as the branch itself (refs/heads/<name>), which is what the push sends: a bare name would let Git pick
    // one of its own files first (ORIG_HEAD, worktrees/<id>/HEAD), so the walk and the push could differ.
    // Q109: resolved once, to the branch HEAD points at when none is named and then to one commit, which is what is
    // walked and exactly what the push sends, so nothing that moves the branch meanwhile changes what goes out.
    const ref = sends ? branchRef(sends) : pushes ? await checkedOut(deps, held.contract, context.signal) : "HEAD";
    const commit = await commitOf(deps, held.contract, context.signal, ref);
    if (!commit) refuse(deps, context, name, held.contract.worktreePath, `${ref === "HEAD" ? "This worktree" : ref} is not a commit here, so nothing is sent.`);
    const broken = await remoteBroken(deps, held.contract, context.signal, commit, ref);
    if (broken) refuse(deps, context, name, held.contract.worktreePath, broken);
    if (pushes) return { sendsCommit: commit, ...(ref.startsWith("refs/") ? { sendsRef: ref } : {}) };
  };
}

/**
 * The same worktree, tool and path check, asked by a step that calls a second tool itself after an
 * outside effect: `github.pull_request_from_changes` pushes and then opens the pull request with
 * `github.open_pull_request`. Asked before the push, so a contract that does not list the second
 * tool leaves nothing pushed. A sentence refuses (and is audited); null lets it go.
 */
export function contractPreflight(deps: ContractGuardDeps): (name: string, args: unknown, context: ToolContext) => string | null {
  return (name, args, context) => {
    try { heldTerms(deps, name, args, context); return null; } catch (error) { return (error as Error).message; }
  };
}

const pullRequestTool = "github.pull_request_from_changes";

/**
 * Q12: a pull request's push from Branch's own source, checked where the push happens
 * (`pullRequestFromChanges`), so every way there is held to it: the tool, the hook that runs when a
 * task finishes, anything added later. The folder must be a worktree with a sound contract that
 * lists the pull request step, still start from the contract's source commit, and change nothing
 * outside its allowed paths. `refusal` is a sentence that refuses (and is audited), or null to let
 * the push go. Anything that goes wrong while checking a folder inside the source refuses too.
 * `walked` is the one commit HEAD named when it was read, which is what was checked: the pull request
 * builds on exactly that commit, so nothing that moves HEAD afterwards changes what is sent. It is
 * null outside the source, where nothing is walked.
 */
export async function pushRefusal(input: {
  store: Store; owner: string; workspace: string; git: ContractGuardDeps["git"]; folder: string; runId?: string | undefined; signal: AbortSignal;
}): Promise<{ refusal: string | null; walked: string | null }> {
  const where = workspacePath(input.workspace, "", input.folder);
  if (where === null || !insideSource(where)) return { refusal: null, walked: null };
  const worktree = worktreeOf(where), context = { runId: input.runId ?? "" };
  try {
    if (!worktree) refuse(input, context, pullRequestTool, "", "The protected Branch Agent source checkout is never sent directly; work in a self-development worktree.");
    if (where !== worktree)
      refuse(input, context, pullRequestTool, worktree, `Git runs in Branch's own source only at a self-development worktree's root, never in ${where}, so nothing is sent from it.`);
    let contract: SelfDevelopmentContract | null;
    try { contract = new ContractBook(input.store.sqlite).current(input.owner, worktree); } catch (error) { refuse(input, context, pullRequestTool, worktree, (error as Error).message); }
    if (!contract) refuse(input, context, pullRequestTool, worktree, `no contract: ${worktree} has no self-development contract, so nothing in it may be sent.`);
    if (!contract.permissions.includes(pullRequestTool))
      refuse(input, context, pullRequestTool, worktree, `${pullRequestTool} is not one of the tools this contract allows (${contract.permissions.join(", ")}).`);
    // HEAD is read once, as one commit; that commit is what is walked and what the caller builds on.
    const walked = await commitOf(input, contract, input.signal, "HEAD");
    if (!walked) refuse(input, context, pullRequestTool, worktree, "This worktree has no commit checked out, so nothing is sent.");
    const broken = await remoteBroken(input, contract, input.signal, walked, "HEAD");
    if (broken) refuse(input, context, pullRequestTool, worktree, broken);
    return { refusal: null, walked };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : "Branch could not check this push against its contract.", walked: null };
  }
}
