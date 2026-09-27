import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { errorText, type ToolContext } from "../contracts.js";
import { refuseSignInForTrunk } from "../accounts/context.js";
import { primaryAccount, savedAccountsSettings } from "../accounts/settings.js";
import { accountHomeVariables, strippedEnvironment } from "../providers/cli-agent.js";
import type { ToolRegistry } from "../registry.js";
import { globFits, worktreeOf, type ContractBook } from "../self-development-contract.js";
import type { Store } from "../store.js";
import type { GitOutcome, GitRunOptions } from "../integrations/git-run.js";
import { startCall } from "../windows-command.js";

/**
 * Handing a coding job to Claude Code or Codex, the programs the owner signed in to with their own plans, so the
 * work is done by the program itself inside one folder: it reads and edits there (Codex may also run its checks), and Branch gets
 * back what it did. Elsewhere Branch only asks these programs for words (src/providers/cli-agent.ts,
 * src/asks/codex-app-server.ts, both read-only); this is the one door where they may change files, and it is
 * held three ways:
 * - Each program's own limits: Codex runs with `--sandbox workspace-write` in the folder; Claude Code runs with
 *   `--permission-mode acceptEdits` in the folder and runs no commands at all (no allowed commands, Bash refused, and
 *   none of the folder's own settings, hooks or MCP servers loaded), since nothing walls its commands in the way Codex's
 *   sandbox does (NAS 22aa6e3, 454af77, Mac mini 2e70eda). The checks are run afterwards through Branch's own held tools.
 * - Branch's own check afterwards: every file the job changed is listed against where it started, and inside
 *   Branch's own source (a self-development worktree) anything outside the contract's allowed paths is put back
 *   and named, so the contract holds whatever the program did. Sending still goes through the contract's push check.
 *   That check runs Git in the folder, so if the job rewrote the folder's own Git settings (its config, the files
 *   that config pulls in, its attributes or its hooks) Branch runs no more Git there: nothing is checked or kept,
 *   and the owner is told. The owner's own global and system config is untouched, so their sign-in stays.
 * - It is the owner's sign-in, so a Trunk or somebody else on this computer never reaches it.
 */

export const handOffPrograms = ["claude-code", "codex"] as const;
export type HandOffProgram = (typeof handOffPrograms)[number];

export const HandOffInputSchema = z.object({
  program: z.enum(handOffPrograms),
  /** The folder, from the workspace, the job is done in. It must be a Git repository, so what changed can be told. */
  folder: z.string().trim().min(1).max(400),
  task: z.string().trim().min(1).max(20_000),
  /** Which of the owner's accounts for that program; absent means its usual sign-in. */
  account: z.string().trim().min(1).max(64).optional(),
  minutes: z.number().int().min(1).max(120).default(30),
  /** The program's model for this job, when the one in its own settings is not the one wanted (or not on the plan). */
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, "A model name has letters, digits, dots, dashes and colons only").optional(),
  /** How hard it thinks: each program's own effort setting. */
  effort: z.enum(["low", "medium", "high"]).optional(),
}).strict();
export type HandOffInput = z.infer<typeof HandOffInputSchema>;

/**
 * The commands Claude Code may run by itself in the folder: none. A build or test runs the folder's own scripts,
 * which the job may just have edited, with the owner's account and outside any wall; and Git reads the folder's own
 * settings, which the job may edit too. Claude Code edits; Branch runs the checks afterwards.
 */
export const claudeAllowedCommands: readonly string[] = [];

/** Handing a job over is asked every time, just this once: the program works with the owner's own sign-in. */
export const handOffReason = "Your Claude Code or Codex would change files in that folder with your own sign-in, so this is asked every time. "
  + "Claude Code runs without that folder's own settings, hooks or MCP servers, and runs no commands.";
export function handOffHold(tool: string): { reason: string; onceOnly: true } | null {
  return tool === "code.hand_off" ? { reason: handOffReason, onceOnly: true } : null;
}

/** What keeps the folder's own Claude Code settings (hooks) and MCP servers out of a handed-over job. */
export const claudeIsolation: readonly string[] = ["--setting-sources", "user", "--strict-mcp-config",
  "--settings", JSON.stringify({ disableAllHooks: true }), "--disallowedTools", "Bash"];

export interface ProgramCall { command: string; args: string[]; cwd: string }
export function programCall(program: HandOffProgram, folder: string, model?: string, effort?: string): ProgramCall {
  const chosen = model ? ["--model", model] : [];
  if (program === "claude-code")
    return { command: "claude", cwd: folder, args: ["-p", "--output-format", "stream-json", "--verbose", ...chosen,
      ...(effort ? ["--effort", effort] : []),
      "--permission-mode", "acceptEdits", ...(claudeAllowedCommands.length ? ["--allowedTools", ...claudeAllowedCommands] : []),
      // NAS 454af77 / 4b4812a: hooks in the folder's own .claude/settings*.json, and servers in its .mcp.json, would run
      // programs outside every permission and wall, and an earlier job could have left them there. Only the account's
      // own settings are read, no MCP server from the folder, no hook at all, and Bash is refused whatever allows it.
      ...claudeIsolation] };
  return { command: "codex", cwd: folder, args: ["exec", "--json", "--sandbox", "workspace-write", "--cd", folder, ...chosen,
    ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []), "-"] };
}

export interface ProgramRun { code: number | null; lines: string[]; stderr: string; timedOut: boolean; missing: boolean }
export type RunProgram = (call: ProgramCall, prompt: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
  timeoutMs: number, onLine: (line: string) => void) => Promise<ProgramRun>;

export const runProgram: RunProgram = (call, prompt, env, signal, timeoutMs, onLine) => new Promise((done) => {
  const start = startCall(call.command, call.args, env);
  const child = spawn(start.command, start.args, { cwd: call.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  const lines: string[] = [];
  let pending = "", stderr = "", timedOut = false, settled = false;
  const finish = (code: number | null, missing = false): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (pending.trim()) { lines.push(pending); onLine(pending); }
    done({ code, lines, stderr, timedOut, missing });
  };
  const stop = (): void => { child.kill(); finish(null); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) if (line.trim() && lines.length < 20_000) { lines.push(line); onLine(line); }
  });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
  child.on("error", (error: NodeJS.ErrnoException) => finish(1, error.code === "ENOENT"));
  child.on("close", (code) => finish(code));
  child.stdin.on("error", () => undefined);
  child.stdin.end(prompt);
});

/** What a program's stream said: its last words, the steps it took, and whether its plan's limit stopped it. */
export interface ProgramReport { summary: string; steps: string[]; failed: string | null; limitReached: boolean; signedOut: boolean }
const limitWords = /usage limit|rate limit|limit reached|quota exceeded|exceeded your (?:current )?quota|too many requests/i;
/** The program's sign-in has run out, or was never made: the owner signs in again, and nothing else will fix it. */
const signedOutWords = /failed to authenticate|oauth (?:access )?token has expired|not logged in|please (?:run \S+ )?log ?in|re-?authenticate|\b401\b/i;
const reportOf = (summary: string, steps: string[], failed: string | null): ProgramReport =>
  ({ summary, steps, failed, limitReached: limitWords.test(failed ?? ""), signedOut: signedOutWords.test(failed ?? "") });
const parse = (line: string): Record<string, unknown> | null => {
  try { const value = JSON.parse(line) as unknown; return value && typeof value === "object" ? value as Record<string, unknown> : null; }
  catch { return null; }
};

/** Claude Code's `stream-json`: assistant messages with text and tool uses, then one `result`. */
export function readClaude(lines: readonly string[]): ProgramReport {
  const steps: string[] = [];
  let summary = "", failed: string | null = null;
  for (const event of lines.map(parse)) {
    if (!event) continue;
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (event.type === "assistant" && Array.isArray(content))
      for (const part of content as { type?: string; text?: string; name?: string }[]) {
        if (part.type === "text" && part.text) summary = part.text;
        if (part.type === "tool_use" && part.name) steps.push(part.name);
      }
    if (event.type === "result") {
      if (typeof event.result === "string" && event.result) summary = event.result;
      if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success"))
        failed = typeof event.result === "string" && event.result ? event.result : String(event.subtype ?? "failed");
    }
  }
  return reportOf(summary, steps, failed);
}

/** Codex's `exec --json`: items as they complete (its words, the commands it ran, the files it changed), then the turn. */
export function readCodex(lines: readonly string[]): ProgramReport {
  const steps: string[] = [];
  let summary = "", failed: string | null = null;
  for (const event of lines.map(parse)) {
    if (!event) continue;
    const item = event.item as { type?: string; text?: string; command?: string } | undefined;
    if (event.type === "item.completed" && item?.type === "agent_message" && item.text) summary = item.text;
    if (event.type === "item.completed" && item?.type === "command_execution" && item.command) steps.push(item.command);
    if (event.type === "item.completed" && item?.type === "file_change") steps.push("file change");
    if (event.type === "turn.failed" || event.type === "error") {
      const error = (event.error as { message?: string } | undefined)?.message ?? (event.message as string | undefined);
      failed = error ?? "failed";
    }
  }
  return reportOf(summary, steps, failed);
}

export interface HandOffDeps {
  store: Store;
  owner: string;
  workspace: string;
  dataDir: string;
  book: ContractBook;
  git: (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;
  run?: RunProgram;
}

export interface HandOffResult {
  program: HandOffProgram;
  account: string;
  status: "done" | "failed" | "limit reached" | "sign in again" | "stopped" | "timed out" | "repository settings changed" | "left its folder";
  summary: string;
  steps: string[];
  changed: string[];
  undone: string[];
}

/** Where a folder's own Git settings live: its `.git` when that is a directory, or the directories a linked worktree's `.git` file points at. */
function gitDirsOf(folder: string): { common: string; perWorktree: string } | null {
  const dotGit = join(folder, ".git");
  let isDirectory = false;
  try { isDirectory = statSync(dotGit).isDirectory(); } catch { return null; }
  if (isDirectory) return { common: dotGit, perWorktree: dotGit };
  let pointer = "";
  try { pointer = readFileSync(dotGit, "utf8"); } catch { return null; }
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  if (!target) return null;
  const perWorktree = resolve(folder, target);
  let common = perWorktree;
  try { const shared = readFileSync(join(perWorktree, "commondir"), "utf8").trim(); if (shared) common = resolve(perWorktree, shared); }
  catch { /* a standalone git directory has no commondir */ }
  return { common, perWorktree };
}

/** The files a Git config pulls in with `include.path` / `includeIf.*.path`, each resolved to an absolute path. */
function includeTargets(configFile: string, text: string): string[] {
  const base = dirname(configFile), targets: string[] = [];
  let inInclude = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) { inInclude = /^\[\s*(include|includeIf)\b/i.test(line); continue; }
    const captured = inInclude ? /^path\s*=\s*(.+?)\s*$/i.exec(line)?.[1] : undefined;
    if (!captured) continue;
    let value = captured.replace(/^"(.*)"$/, "$1");
    if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
    targets.push(isAbsolute(value) ? value : resolve(base, value));
  }
  return targets;
}

/**
 * A fingerprint of the settings in the folder's own repository that could make Git start a program: its local
 * config and every file that config pulls in, the per-worktree config, the git-directory attributes file, and the
 * hooks. Read straight from disk, so it can be taken before a job and again after without running Git itself. When
 * a job rewrites any of them this string changes, and the after-check then runs no Git in the folder (NAS 22aa6e3).
 * The owner's own global and system config is never read here, so their credential helpers and filters (git-lfs)
 * keep working for a folder a job did not touch.
 */
const settingsFileLimit = 1_000_000;
const settingsFilesLimit = 500;
export function repoOwnSettings(folder: string): string {
  const parts: [string, string][] = [];
  // NAS 448815a: a folder's file can be a link to /dev/zero or a huge file, which reading would take Branch down with.
  // A link is noted by where it points and never followed; anything not a plain file, or over a megabyte, by what it is.
  const record = (label: string, path: string): string => {
    let about: import("node:fs").Stats;
    try { about = lstatSync(path); } catch { parts.push([label, "absent"]); return ""; }
    if (about.isSymbolicLink()) { parts.push([label, `link:${readlinkSafe(path)}`]); return ""; }
    if (!about.isFile()) { parts.push([label, "special"]); return ""; }
    if (about.size > settingsFileLimit) { parts.push([label, `size:${about.size}:${about.mtimeMs}`]); return ""; }
    try { const bytes = readFileSync(path); parts.push([label, `sha256:${createHash("sha256").update(bytes).digest("hex")}`]); return bytes.toString("utf8"); }
    catch { parts.push([label, "absent"]); return ""; }
  };
  const dotGit = join(folder, ".git");
  try { if (!statSync(dotGit).isDirectory()) record(".git", dotGit); } catch { parts.push([".git", "absent"]); }
  // NAS 4b4812a: the folder's own Claude Code settings and MCP servers can start programs too, so a job that writes
  // them is caught the same way, even though a hand-off no longer loads them.
  for (const file of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"]) record(`folder:${file}`, join(folder, file));
  // NAS 538774b: Codex's own project settings (its config, MCP servers, hooks, exec rules) live under .codex/ and
  // .agents/, which Claude Code's edits may reach; every file there, to a bound, counts like the ones above.
  for (const dir of [".codex", ".agents"]) {
    const files: string[] = [];
    let incomplete = false;
    const walk = (at: string): void => {
      let entries: import("node:fs").Dirent[] = [];
      try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= settingsFilesLimit) { incomplete = true; return; }
        const path = join(at, entry.name);
        if (entry.isDirectory()) walk(path); else files.push(path);
      }
    };
    walk(join(folder, dir));
    parts.push([`folder:${dir}/`, files.map((file) => relative(folder, file)).join(",")]);
    // Past the bound the look is incomplete, so it never matches itself: the job ends as a settings change rather than
    // one hiding past the bound (NAS 448815a LOW), as linksOut fails closed at its own.
    if (incomplete) parts.push([`folder:${dir}/incomplete`, randomUUID()]);
    for (const file of files) record(`folder:${relative(folder, file)}`, file);
  }
  const dirs = gitDirsOf(folder);
  if (dirs) {
    const seen = new Set<string>();
    const queue = [join(dirs.common, "config"), join(dirs.common, "config.worktree"), join(dirs.perWorktree, "config.worktree")];
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const target of includeTargets(file, record(`config:${file}`, file))) if (!seen.has(target)) queue.push(target);
    }
    record("info/attributes", join(dirs.common, "info", "attributes"));
    let hooks: string[] = [];
    try { hooks = readdirSync(join(dirs.common, "hooks")).sort(); } catch { /* no hooks directory */ }
    parts.push(["hooks", hooks.join(",")]);
    for (const name of hooks) record(`hooks/${name}`, join(dirs.common, "hooks", name));
  }
  return JSON.stringify(parts.sort());
}

/**
 * The adversarial of R19 (Legion, 2026-09-25): a job could leave its folder through a link it made inside it (to
 * somewhere else on disk, then write through it) or by writing next to the folder, and the Git after-check, which only
 * sees the folder's own repository, said "done". These two looks catch both; writes further out are held back by the
 * programs' own limits (Claude Code runs no commands; Codex runs in its workspace-write sandbox).
 */
const linkLookLimit = 200_000;
/**
 * Every link inside the folder (not following links) that leads out of it, as "path -> target". Q241: `.git` is looked
 * at too, since Branch's own Git after-check writes there; its object stores, and those of its submodules under
 * `.git/modules`, are looked at one level deep only (Git never writes through an object it already has), so a big
 * repository does not reach the bound.
 */
export function linksOut(folder: string): { links: Set<string>; complete: boolean } {
  const links = new Set<string>();
  const gitRoot = join(folder, ".git");
  // Mac mini's Q243 review: a submodule's own Git folder is `.git/modules/<name>`, with its own object store.
  const gitDirOf = (dir: string): boolean => dir === gitRoot || (dir.startsWith(gitRoot + sep) && basename(dirname(dir)) === "modules");
  const isStore = (dir: string): boolean => basename(dir) === "objects"
    && (gitDirOf(dirname(dir)) || (basename(dirname(dir)) === "lfs" && gitDirOf(dirname(dirname(dir)))));
  const stack = [folder];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > linkLookLimit) return { links, complete: false };
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target = "";
        try { target = realpathSync.native(path); } catch { target = resolve(dir, readlinkSafe(path)); }
        const from = relative(folder, target);
        if (from.startsWith("..") || resolve(from) === from) links.add(`${relative(folder, path)} -> ${target}`);
      } else if (entry.isDirectory() && !isStore(dir)) stack.push(path);
    }
  }
  return { links, complete: true };
}
function readlinkSafe(path: string): string { try { return readlinkSync(path); } catch { return ""; } }
/** The folder's neighbours (its parent directory's entries, except the folder itself), each with when it last changed. */
export function neighbours(folder: string): Map<string, number> {
  const parent = dirname(folder), found = new Map<string, number>();
  let entries: string[] = [];
  try { entries = readdirSync(parent); } catch { return found; }
  for (const name of entries) {
    const path = join(parent, name);
    if (path === folder) continue;
    try { found.set(name, lstatSync(path).mtimeMs); } catch { /* gone while looking */ }
  }
  return found;
}

export class HandOff {
  constructor(private readonly deps: HandOffDeps) {}

  /**
   * The folder from the workspace, refused when it leaves the workspace or is not a Git repository. Judged where it
   * really is: a link in the workspace that leads out of it is refused, not followed (NAS 22aa6e3).
   */
  folderOf(folder: string): { absolute: string; fromWorkspace: string } {
    const written = resolve(this.deps.workspace, folder);
    const inside = (root: string, path: string): string | null => {
      const from = relative(root, path).split(sep).join("/");
      return from.startsWith("..") || resolve(from) === from ? null : from;
    };
    if (inside(this.deps.workspace, written) === null) throw new Error("The folder must be inside the workspace.");
    if (!existsSync(written) || !statSync(written).isDirectory()) throw new Error(`There is no folder ${folder} in the workspace.`);
    const absolute = realpathSync.native(written);
    const fromWorkspace = inside(realpathSync.native(this.deps.workspace), absolute);
    if (fromWorkspace === null) throw new Error("The folder must be inside the workspace: that one leads out of it.");
    if (!existsSync(join(absolute, ".git"))) throw new Error(`${fromWorkspace} is not a Git repository, so what the job changed could not be told.`);
    return { absolute, fromWorkspace };
  }

  /** The environment the program gets: only what it needs, with the chosen account's own folder. */
  environment(program: HandOffProgram, account: string): NodeJS.ProcessEnv {
    if (account === primaryAccount) return strippedEnvironment();
    const pool = `cli-${program}`;
    const saved = savedAccountsSettings(this.deps.store, this.deps.owner)?.pools.find((one) => one.pool === pool);
    if (!saved?.accounts.some((one) => one.id === account))
      throw new Error(`There is no ${program === "codex" ? "Codex" : "Claude Code"} account called "${account}" in Settings › Accounts.`);
    return { ...strippedEnvironment(), [accountHomeVariables[program]!]: join(this.deps.dataDir, "accounts", pool, account) };
  }

  private async gitText(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
    const outcome = await this.deps.git({ cwd, args, timeoutMs: 30_000 }, signal);
    if (outcome.status !== "completed") throw new Error(`git ${args[0]} did not finish: ${outcome.stderr.trim().slice(0, 300)}`);
    return outcome.stdout;
  }

  /** Every file that differs from `start` now, committed or not, tracked or new. */
  async changedSince(cwd: string, start: string, signal: AbortSignal): Promise<{ tracked: string[]; added: string[] }> {
    const tracked = (await this.gitText(cwd, ["diff", "--name-only", "--no-renames", start], signal)).split("\n").filter(Boolean);
    const added = (await this.gitText(cwd, ["ls-files", "--others", "--exclude-standard"], signal)).split("\n").filter(Boolean);
    return { tracked, added };
  }

  /** Inside Branch's own source, the contract's allowed paths decide; anything else the job changed is put back. */
  async keepToContract(folder: { absolute: string; fromWorkspace: string }, start: string, changed: { tracked: string[]; added: string[] },
    signal: AbortSignal): Promise<string[]> {
    const worktree = worktreeOf(folder.fromWorkspace);
    if (!worktree) return [];
    const contract = this.deps.book.current(this.deps.owner, worktree);
    const inside = folder.fromWorkspace.slice(worktree.length).replace(/^\//, "");
    const allowed = (file: string): boolean =>
      !!contract && contract.allowedPaths.some((pattern) => globFits(pattern, inside ? `${inside}/${file}` : file));
    const undoTracked = changed.tracked.filter((file) => !allowed(file));
    const undoAdded = changed.added.filter((file) => !allowed(file));
    if (undoTracked.length) await this.gitText(folder.absolute, ["checkout", start, "--", ...undoTracked], signal);
    for (const file of undoAdded) await rm(join(folder.absolute, file), { force: true });
    return [...undoTracked, ...undoAdded];
  }

  async run(input: HandOffInput, context: ToolContext): Promise<HandOffResult> {
    refuseSignInForTrunk();
    this.deps.store.profiles.requireOwner("Handing a job to your Claude Code or Codex");
    if (context.agent) throw new Error("Handing a job to the owner's Claude Code or Codex is the owner's own; a specialist cannot.");
    const folder = this.folderOf(input.folder), account = input.account ?? primaryAccount;
    const env = this.environment(input.program, account);
    // The folder's own Git settings as they were before the job, so a job that rewrites them is caught below.
    const settingsBefore = repoOwnSettings(folder.absolute);
    // Links that already led out of the folder, and what sat next to it, so only what the job did is judged below.
    const linksBefore = linksOut(folder.absolute).links, besideBefore = neighbours(folder.absolute);
    const start = (await this.gitText(folder.absolute, ["rev-parse", "--verify", "HEAD"], context.signal)).trim();
    let shown = 0;
    const onLine = (line: string): void => {
      if (shown++ < 200) this.deps.store.event(context.runId, "code.hand_off.step", { program: input.program, line: line.slice(0, 500) });
    };
    const ran = await (this.deps.run ?? runProgram)(programCall(input.program, folder.absolute, input.model, input.effort), input.task, env,
      context.signal, input.minutes * 60_000, onLine);
    if (ran.missing) throw new Error(`"${programCall(input.program, folder.absolute).command}" is not installed on this computer.`);
    const report = input.program === "codex" ? readCodex(ran.lines) : readClaude(ran.lines);
    // A job could have written the folder's own `.git` settings (its config, attributes or hooks) so that the
    // steps below would run a program of its choosing. If any of them changed, run no Git in the folder at all.
    if (repoOwnSettings(folder.absolute) !== settingsBefore) return this.settingsChanged(input, account, report, context);
    const left = this.leftFolder(folder.absolute, linksBefore, besideBefore);
    if (left) return this.leftItsFolder(input, account, report, context, left);
    const changed = await this.changedSince(folder.absolute, start, AbortSignal.timeout(60_000));
    const undone = await this.keepToContract(folder, start, changed, AbortSignal.timeout(60_000));
    const status: HandOffResult["status"] = context.signal.aborted ? "stopped" : ran.timedOut ? "timed out"
      : report.limitReached ? "limit reached" : report.signedOut ? "sign in again" : report.failed || ran.code !== 0 ? "failed" : "done";
    const result: HandOffResult = { program: input.program, account, status,
      summary: (report.summary || report.failed || ran.stderr.trim()).slice(0, 4000), steps: report.steps.slice(-40),
      changed: [...changed.tracked, ...changed.added].filter((file) => !undone.includes(file)), undone };
    this.deps.store.event(context.runId, "code.hand_off", { ...result, summary: result.summary.slice(0, 500) });
    return result;
  }

  /**
   * What the job did outside its folder, in plain words, or null when nothing. A new link leading out is removed at
   * once (only the link, never what it points at); a changed neighbour is only named, since it is not the job's to keep.
   */
  private leftFolder(folder: string, linksBefore: Set<string>, besideBefore: Map<string, number>): string | null {
    const found: string[] = [];
    const now = linksOut(folder);
    for (const link of now.links) if (!linksBefore.has(link)) {
      const path = join(folder, link.split(" -> ")[0]!);
      try { unlinkSync(path); } catch { try { rmdirSync(path); } catch { /* a junction is removed as a directory */ } }
      found.push(`made a link out of the folder (${link}), which I removed`);
    }
    if (!now.complete) found.push(`has more than ${linkLookLimit.toLocaleString()} files, so not every link in it could be looked at`);
    for (const [name, when] of neighbours(folder)) {
      const before = besideBefore.get(name);
      if (before === undefined) found.push(`added ${name} next to the folder`);
      else if (before !== when) found.push(`changed ${name} next to the folder`);
    }
    return found.length ? found.join("; ") : null;
  }

  /** The job reached outside its folder. What it did inside is not trusted either: nothing is checked or kept. */
  private leftItsFolder(input: HandOffInput, account: string, report: ProgramReport, context: ToolContext, what: string): HandOffResult {
    const result: HandOffResult = { program: input.program, account, status: "left its folder",
      summary: `The job reached outside the folder it was given: it ${what}. I checked and kept nothing from this run. `
        + "Look over the folder and what is next to it yourself before you trust anything from it.",
      steps: report.steps.slice(-40), changed: [], undone: [] };
    this.deps.store.event(context.runId, "code.hand_off", { ...result, summary: result.summary.slice(0, 500) });
    return result;
  }

  /** The job changed the folder's own Git settings. Branch runs no more Git in it: nothing is checked or put back, and the owner is told plainly. */
  private settingsChanged(input: HandOffInput, account: string, report: ProgramReport, context: ToolContext): HandOffResult {
    const result: HandOffResult = { program: input.program, account, status: "repository settings changed",
      summary: "The job changed this folder's own Git or Claude Code settings (its config, attributes, hooks or MCP servers), so I ran no more Git in it: "
        + "nothing it did was checked or put back. Look the folder over yourself before you trust or keep anything from this run.",
      steps: report.steps.slice(-40), changed: [], undone: [] };
    this.deps.store.event(context.runId, "code.hand_off", { ...result, summary: result.summary.slice(0, 500) });
    return result;
  }
}

export function registerHandOff(registry: ToolRegistry, handOff: HandOff): void {
  registry.register({
    name: "code.hand_off", permission: "code.handoff", group: "code",
    description: "Give a coding job to the owner's Claude Code or Codex, signed in with the owner's own plan, to do inside one "
      + "folder of the workspace that is a Git repository: the program reads and edits there, and this answers "
      + "with what it did and which files changed. Choose the account from Settings › Accounts, or leave it out for the usual one. "
      + "When the answer says the plan's limit was reached, try another account. Inside Branch's own source, anything the job "
      + "changed outside the contract's allowed paths is put back and named. A job that makes a link out of its folder, or "
      + "writes next to it, ends as \"left its folder\" and nothing from it is kept.",
    parameters: HandOffInputSchema,
    // The program may change anything in the folder, so a rule about any folder inside it counts; inside Branch's
    // own source the contract must cover the whole folder, and is held again file by file afterwards.
    targets: (args) => [{ kind: "write", path: args.folder, folder: true }],
    execute: async (args, context) => {
      try { return await handOff.run(args, context); }
      catch (error) { throw new Error(errorText(error)); }
    },
  });
}
