import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellProcess, type ProcessResult } from "./shell-process.js";
import { posixEnvironment } from "./shell-config.js";

/**
 * Runs the copy of Git already installed on this computer. The program is found once with
 * `where git` (`which git` elsewhere) and then always started from that exact path, never through
 * a shell. Repository hooks are switched off, the folder is marked safe for this run, and Git is
 * told never to stop and ask for a password, so a command can never hang waiting for a person.
 */
export type GitLocator = () => Promise<string | null>;
export interface GitRunOptions { cwd: string; args: string[]; timeoutMs?: number; maxOutputBytes?: number }
export interface GitOutcome extends ProcessResult { command: string }
/** Q98: a branch as the full ref Git pushes and walks alike (`HEAD` and a ref already written in full stay as they are). */
export const branchRef = (branch: string): string => (branch === "HEAD" || branch.startsWith("refs/") ? branch : `refs/heads/${branch}`);

const NO_HOOKS = join(tmpdir(), "branch-hooks-disabled-does-not-exist");
const NO_GRAFTS = join(tmpdir(), "branch-grafts-disabled-does-not-exist");
const KEEP_ENV = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA", "LANG", "LC_ALL", "TZ"];

/** Git's own environment: the little it needs from the host, plus settings that keep it silent. */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of KEEP_ENV) {
    const entry = Object.entries(source).find(([name]) => name.toUpperCase() === key);
    if (entry?.[1]) result[key] = entry[1];
  }
  // macOS and Linux: where temporary files go, who is signed in, and the key agent ssh remotes use.
  Object.assign(result, posixEnvironment(["TMPDIR", "USER", "LOGNAME", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME"], source, platform));
  return { ...result, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", NO_COLOR: "1", GCM_INTERACTIVE: "never" };
}

/**
 * Q12: settings a repository's own `.git/config` could use to make Git start a program, each pinned
 * to a harmless value. `-c` outranks every config file, and Git hands these to the Git processes it
 * starts itself (a submodule's), so a folder a task wrote cannot run anything through them.
 * `diff.external` cannot be emptied, so it names `false`: a patch Branch asks for passes
 * `--no-ext-diff` (src/integrations/git.ts), and any other would stop loudly rather than run a program.
 * The owner's own sign-in (credential helpers, askPass, sshCommand, the computer-wide config file
 * where macOS keeps its keychain helper) is left alone: Branch's pushes use it. A planted repository
 * never reaches those, because Git tools are kept out of nested repositories in Branch's source and a
 * held command cannot make a `.git` (src/self-development-contract.ts, src/sandbox-seatbelt.ts).
 */
export const pinnedGitConfig: readonly string[] = [
  "core.fsmonitor=false", "core.pager=cat", "core.editor=:", "sequence.editor=:", "diff.external=false", "protocol.ext.allow=never",
];

/**
 * Q12: more pins, only for Git run inside Branch's own source (`branch-agent-source`), where the
 * owner's preferences matter less than what a self-development task could have left behind:
 * signing programs, submodules and a bare repository found by walking up. Replacement objects and
 * the commit-graph file are explained with `pinnedEnvironmentInSource` below.
 */
export const pinnedInSource: readonly string[] = [
  "commit.gpgSign=false", "tag.gpgSign=false", "gpg.program=false", "submodule.recurse=false", "diff.ignoreSubmodules=all",
  "core.gitProxy=", "safe.bareRepository=explicit", "protocol.file.allow=never",
  "core.useReplaceRefs=false", "core.commitGraph=false",
];

/**
 * Inside Branch's own source, Git reads every commit as it is stored, which is what a push sends.
 * Replacement objects (`refs/replace/`) and grafts (`info/grafts`) can each make Git show a commit
 * with other parents or another tree, so neither is used there. Replacements are turned off both by
 * GIT_NO_REPLACE_OBJECTS and by `core.useReplaceRefs=false` in `pinnedInSource`, so a repository's
 * own `core.useReplaceRefs` cannot turn them back on. Grafts have no setting, so they are read from a
 * file that is not there. Git skips its commit-graph file (a saved copy of each commit's parents and
 * tree) while replacements or grafts are in use, so with both off it would read that file again;
 * `core.commitGraph=false` in `pinnedInSource` keeps it unread.
 */
const pinnedEnvironmentInSource: Readonly<Record<string, string>> = { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: NO_GRAFTS };
export const inBranchSource = (cwd: string): boolean => {
  try {
    const resolved = realpathSync.native(cwd);
    return /(^|[\\/])branch-agent-source([\\/\.\s]|$)/i.test(resolved);
  } catch {
    return /(^|[\\/])branch-agent-source([\\/\.\s]|$)/i.test(cwd);
  }
};

/** Settings forced on every call; they come before the subcommand so no repository can override them. */
export function hardening(cwd: string, inSource = inBranchSource(cwd)): string[] {
  const pins = inSource ? [...pinnedGitConfig, ...pinnedInSource] : pinnedGitConfig;
  return ["-c", `safe.directory=${cwd}`, "-c", `core.hooksPath=${NO_HOOKS}`, "-c", "core.quotepath=false",
    "-c", "credential.interactive=never", ...pins.flatMap((setting) => ["-c", setting]), "--no-pager"];
}

let located: Promise<string | null> | undefined;
/** Asks the operating system where Git is, once per launch. */
export async function locateGit(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return (located ??= findGitOn(env));
}
/** How Git is looked for: `where git` on Windows, `command -v git` (no extension) elsewhere. */
export function gitFinder(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { executable: string; args: string[] } {
  if (platform === "win32") return { executable: join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "where.exe"), args: ["git"] };
  return { executable: "/bin/sh", args: ["-c", "command -v git"] };
}
type LineReader = (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string[]>;
export async function findGitOn(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, lines: LineReader = firstLines): Promise<string | null> {
  const windows = platform === "win32";
  const finder = gitFinder(platform, env);
  for (const line of (await lines(finder.executable, finder.args, env)).slice(0, 5)) {
    const candidate = line.trim().replace(/^"|"$/g, "");
    if (!candidate || (windows && !/\.exe$/i.test(candidate)) || (!windows && !candidate.startsWith("/"))) continue;
    if (await stat(candidate).then((info) => info.isFile()).catch(() => false)) return candidate;
  }
  return null;
}
function firstLines(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolve) => {
    let output = "";
    const done = (value: string[]) => { clearTimeout(timer); resolve(value); };
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve([]); }, 5000);
    child.stdout.on("data", (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString("utf8"); });
    child.once("error", () => done([]));
    child.once("close", () => done(output.split(/\r?\n/)));
  });
}

export class GitRunner {
  constructor(private readonly options: { locate?: GitLocator; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {}
  /** The absolute path of Git, or a plain explanation that it is not installed. */
  async executable(): Promise<string> {
    const found = await (this.options.locate ?? (() => locateGit(this.options.env)))();
    if (!found) throw new Error("Git is not installed on this computer. Install Git, then ask me again.");
    return found;
  }
  async run(options: GitRunOptions, signal: AbortSignal): Promise<GitOutcome> {
    const executable = await this.executable();
    // Decided once, so the settings and the environment always agree on whether this is Branch's source.
    const inSource = inBranchSource(options.cwd);
    const args = [...hardening(options.cwd, inSource), ...options.args];
    const env = { ...gitEnvironment(this.options.env), ...(inSource ? pinnedEnvironmentInSource : {}) };
    const result = await new ShellProcess({
      executable, args, cwd: options.cwd, env, signal,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 30000,
      maxOutputBytes: options.maxOutputBytes ?? 65536, maxMemoryMb: 2048, maxCpuSeconds: 120,
    }).run();
    return { ...result, command: options.args.filter((argument) => !argument.startsWith("-")).slice(0, 2).join(" ") };
  }
}

const PLAIN: [RegExp, string][] = [
  [/not a git repository|does not appear to be a git repo/i, "This folder is not a repository yet. Ask me to start one, or pick a folder that already has one."],
  [/unmerged|you have unresolved conflicts|fix conflicts/i, "There are unmerged changes from an earlier merge. Those files need to be sorted out before this will work."],
  [/please tell me who you are|empty ident|unable to auto-detect email/i, "Git does not know your name and email address yet. Set those once in Git, then try again."],
  [/dubious ownership/i, "This folder belongs to another Windows account, so Git will not touch it."],
  [/authentication failed|could not read username|terminal prompts disabled|invalid username or (password|token)/i, "The sign-in was not accepted. Check the GitHub token saved in your secrets."],
  [/non-fast-forward|fetch first|updates were rejected/i, "The copy on the server has changes yours does not. Bring those down first, then send yours."],
  [/pathspec .* did not match|unknown revision|bad revision/i, "I could not find that file, branch or revision in this repository."],
  [/a branch named .* already exists|branch .* already exists/i, "There is already a branch with that name."],
  [/already exists|is already (registered|used) by/i, "Something with that name is already there."],
  [/could not resolve host|unable to access|connection (timed out|refused)/i, "I could not reach the server. Check the internet connection and try again."],
  [/no such file or directory|cannot chdir/i, "That folder does not exist."],
];

/** Turns Git's own wording into something a non-technical person can act on. */
export function explainGit(result: Pick<GitOutcome, "status" | "stderr" | "stdout">): string {
  if (result.status === "timed_out") return "Git took too long and was stopped.";
  if (result.status === "cancelled") return "The task was stopped before Git finished.";
  if (result.status === "output_limit") return "Git produced more output than fits here; ask for a smaller range.";
  const text = `${result.stderr}\n${result.stdout}`;
  for (const [pattern, message] of PLAIN) if (pattern.test(text)) return message;
  // Git's own "fatal:" or "error:" line says what went wrong; progress lines such as "Preparing worktree" come first.
  const lines = result.stderr.split("\n").map((value) => value.trim()).filter(Boolean);
  const line = (lines.find((value) => /^(fatal|error):/i.test(value)) ?? lines[0])?.replace(/^(fatal|error):\s*/i, "");
  return line ? `Git could not do that: ${line.slice(0, 300)}` : "Git could not do that.";
}
