import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Beta update channel: like Hermes Desktop, Branch follows one line of work and builds the newest merged change
 * on this computer, instead of waiting for a published Stable release. It needs git and Node here, and each build
 * takes minutes.
 *
 * Every build clones afresh into the updater's own folder, which the assistant may never change, at exactly the
 * commit that was looked up, and only after the history shows it goes forward from the running change. Every
 * program runs hidden, never asks for a password or sign-in (the repository is public), and is given a time limit.
 */
/** The line of work Beta builds. Named here only, and never chosen by anyone, so it can move to main later. */
export const betaLine = "redesign/window";

export interface Run {
  (file: string, args: string[], options: { cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<string>;
}
export type DevPhase = "fetching" | "installing" | "building";

const minutes = (count: number) => count * 60_000;
const quietGit = ["-c", "credential.helper=", "-c", "core.askPass="];

/** The real runner: hidden, no prompts, npm through the command shell Windows needs for `npm.cmd`. */
export function realRun(platform: NodeJS.Platform = process.platform): Run {
  const env = buildEnv(process.env, platform);
  return (file, args, options) => new Promise((resolve, reject) => {
    const [program, programArgs] = platform === "win32" && file === "npm"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", "npm", ...args]]
      : [file, args];
    execFile(program, programArgs, { cwd: options.cwd, env: options.env ? { ...env, ...options.env } : env, windowsHide: true, timeout: options.timeoutMs, maxBuffer: 16 << 20 },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const lastLine = String(stderr).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
        reject(new Error(`${file} ${args[0] ?? ""} did not finish${error.killed ? " in time" : ""}${lastLine ? `: ${lastLine.slice(0, 300)}` : "."}`));
      });
  });
}

/**
 * What the build's programs see: this computer's own environment without the running app's own switches (a
 * BRANCH_* or ELECTRON_* value meant for this app must not steer the build), with prompts off, and on a Mac the
 * places Homebrew puts git and Node, which an app started from the Dock is not told about.
 */
export function buildEnv(from: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(from).filter(([key]) => !/^(BRANCH|ELECTRON)_/i.test(key)));
  const extraPath = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  return {
    ...kept,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "",
    // NAS cfc3808 follow-up: the Dev check's history holds commits only, and git would fetch a missing one lazily with
    // all its trees (14,720 for one train on 2026-09-25) instead of through the check's own commits-only fetch.
    GIT_NO_LAZY_FETCH: "1",
    PATH: [...extraPath, from.PATH ?? ""].filter(Boolean).join(platform === "win32" ? ";" : ":"),
  };
}

/** Whether this computer has what a Beta build needs; the reason in plain words when it does not. */
export async function devToolsMissing(run: Run): Promise<string | null> {
  const missing: string[] = [];
  for (const [tool, args] of [["git", ["--version"]], ["node", ["--version"]], ["npm", ["--version"]]] as const) {
    try { await run(tool, [...args], { timeoutMs: 20_000 }); } catch { missing.push(tool); }
  }
  if (!missing.length) return null;
  return `The Beta channel builds Branch on this computer, and ${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not found. Install git and Node.js (which includes npm), then check again, or choose Stable.`;
}

/** The newest commit on Beta's line of work, read with git (not GitHub's rate-limited web API). */
export async function remoteHead(run: Run, repo: string): Promise<string> {
  const out = await run("git", [...quietGit, "ls-remote", `https://github.com/${repo}.git`, `refs/heads/${betaLine}`], { timeoutMs: 60_000 });
  // ls-remote matches the end of ref names, so only the line naming exactly Beta's ref counts.
  const want = `refs/heads/${betaLine}`;
  const sha = out.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find(([id, ref]) => /^[0-9a-f]{40}$/.test(id ?? "") && ref === want)?.[0];
  if (!sha) throw new Error("GitHub did not say what the newest change is. Check the internet connection and try again.");
  return sha;
}

/**
 * Dogfood F5: where the running change stands against the main line's newest one, read from the history alone (the
 * commits without their files: under 2 MB for the whole line, and only what is new after that) in the updater's own
 * folder. "behind": the newest change includes the running one, so it is newer. "ahead": the running change already
 * includes it (a train or a canary built ahead of the main line). "apart": neither includes the other. "unknown": the
 * history could not be read, and the build's own never-go-back step (neverBack) still decides.
 */
export type DevStanding = "behind" | "ahead" | "apart" | "unknown";
/**
 * NAS cfc3808: the walls every history call runs behind, as src/reach/agent-git.ts's do: no hooks, https only.
 * Redirects are followed for the first request only (git's own default), and the walls keep them to https: GitHub
 * forwards Branch's current name after a move, and refusing that would leave every answer unknown (Q210).
 */
const historyWalls = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=initial"];
/**
 * Q209: git reads `protocol.<name>.allow` before `protocol.allow`, so a setting in the history folder's own config could
 * allow another protocol past the walls. `GIT_ALLOW_PROTOCOL` outranks every setting, and it lets only https through.
 */
const historyEnv = { GIT_ALLOW_PROTOCOL: "https" };
export async function devStanding(run: Run, historyDir: string, repo: string, running: string, head: string): Promise<DevStanding> {
  const cwd = historyDir, timeoutMs = 30_000;
  const git = (args: string[], ms = timeoutMs) => run("git", [...quietGit, ...historyWalls, ...args], { cwd, timeoutMs: ms, env: historyEnv });
  const has = (commit: string) => git(["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false);
  // NAS cfc3808: a link or a file planted where the history goes is never followed; the build's own step decides.
  const found = await lstat(historyDir).catch(() => null);
  if (found && (found.isSymbolicLink() || !found.isDirectory())) return "unknown";
  if (!found) await run("git", ["init", "--quiet", "--bare", historyDir], { timeoutMs, env: historyEnv }).catch(() => undefined);
  for (const [commit, ref] of [[head, "refs/branch/head"], [running, "refs/branch/running"]] as const) {
    if (!(await has(commit)))
      await git(["fetch", "--quiet", "--filter=tree:0", "--no-tags", `https://github.com/${repo}.git`, commit], minutes(5)).catch(() => undefined);
    // Kept by name, so the next look fetches only what is new after it, not the whole line again (NAS cfc3808).
    if (await has(commit)) await git(["update-ref", ref, commit]).catch(() => undefined);
  }
  if (!(await has(head)) || !(await has(running))) return "unknown";
  // One question whose answer is a change id: a walk that fails is unknown, never "apart" (NAS cfc3808).
  const shared = await git(["merge-base", running, head]).then((out) => out.trim(), () => "");
  if (!/^[0-9a-f]{40}$/.test(shared)) return "unknown";
  return shared === running ? "behind" : shared === head ? "ahead" : "apart";
}

/**
 * Clones Branch afresh into `sourceDir`, which must not exist yet, at exactly `commit`, and builds the release
 * download from it. Returns the download's path and the version it was stamped with. A failure leaves the installed
 * app untouched. Nothing is reused from an earlier build: `sourceDir` sits in the updater's own folder, which the
 * assistant may never change and which every install empties first.
 */
export interface DevBuildPlan {
  repo: string; sourceDir: string; commit: string; running: string | null; assetName: string; onPhase: (phase: DevPhase) => void;
  /**
   * The owner confirmed, in the window, moving to this exact commit although it does not contain the running change
   * (a copy built from another line of work). Only then is the never-go-back step left out; the updater checks it.
   */
  otherLineConfirmed?: boolean;
}

export async function buildDev(run: Run, plan: DevBuildPlan): Promise<{ archive: string; checksumFile: string; version: string }> {
  const { repo, sourceDir, commit, running, assetName, onPhase } = plan;
  if (await lstat(sourceDir).then(() => true, () => false))
    throw new Error("The folder a Beta build starts in was not empty, so nothing was built. Try the update again.");
  onPhase("fetching");
  await run("git", [...quietGit, "clone", "--no-tags", "--single-branch", "--branch", betaLine, `https://github.com/${repo}.git`, sourceDir], { timeoutMs: minutes(15) });
  await run("git", ["reset", "--hard", commit], { cwd: sourceDir, timeoutMs: minutes(2) });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceDir, timeoutMs: 30_000 })).trim();
  if (head !== commit) throw new Error("The source did not arrive at the change that was looked up, so nothing was built.");
  if (running && running !== commit && plan.otherLineConfirmed !== true) await neverBack(run, sourceDir, running, commit);
  onPhase("installing");
  await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: sourceDir, timeoutMs: minutes(30) });
  const committedAt = Number((await run("git", ["show", "-s", "--format=%ct", commit], { cwd: sourceDir, timeoutMs: 30_000 })).trim());
  const version = await stampDevVersion(sourceDir, committedAt, commit);
  onPhase("building");
  await run("npm", ["run", "package:desktop", "--", "--release"], { cwd: sourceDir, timeoutMs: minutes(30) });
  // The built app must say which change it is, or the next check could not tell it is current and could not see
  // going back from it (a change older than the Dev channel itself has no such record).
  const stamped = await readFile(join(sourceDir, "dist", "build-info.json"), "utf8").then((text) => JSON.parse(text)?.commit, () => null);
  if (stamped !== commit)
    throw new Error("The Beta build does not record which change it was made from, so nothing was changed. It is offered again once the newest change can say so.");
  return { archive: join(sourceDir, "release", assetName), checksumFile: join(sourceDir, "release", `${assetName}.sha256`), version };
}

/**
 * The change offered must already contain the one running: a Beta or a release can be built from a newer change
 * than the main line's head for a while. The running change is fetched by its id when the clone does not have it.
 * Anything that cannot be shown to go forward stops the build: a change that cannot be found, or a failed check.
 */
async function neverBack(run: Run, sourceDir: string, running: string, commit: string): Promise<void> {
  const cwd = sourceDir, timeoutMs = 30_000;
  const known = () => run("git", ["cat-file", "-e", `${running}^{commit}`], { cwd, timeoutMs }).then(() => true, () => false);
  let found = await known();
  if (!found) {
    await run("git", [...quietGit, "fetch", "--no-tags", "origin", running], { cwd, timeoutMs: minutes(5) }).catch(() => undefined);
    found = await known();
  }
  if (!found)
    throw new Error(`Branch could not find the change the version running now was built from (${running.slice(0, 7)}), so it cannot tell whether the newest Beta change is newer. Nothing was changed. Choose Stable, or try again later.`);
  const shared = await run("git", ["merge-base", running, commit], { cwd, timeoutMs }).then((out) => out.trim(), () => null);
  if (shared !== running)
    throw new Error(`The newest Beta change does not include the version running now (change ${running.slice(0, 7)}), so installing it would go back. Nothing was changed; it is offered again once it catches up.`);
}

/**
 * Like Beta's stamp (scripts/beta-release.mjs), only for the build: a Dev build of 0.19.2's line is
 * 0.19.3-dev.<commit time>-g<commit> (one identifier: the Windows packager takes at most four dotted parts). The commit makes every build's version its own, so the update's record can
 * tell whether the swap landed even for two changes made in the same second; Beta (0.19.3-beta.N sorts below it)
 * never offers the same line's older code, and that line's Stable release sorts above it. Which Dev change is newer
 * is decided by the history (neverBack), never by these numbers: commit times need not increase.
 */
export async function stampDevVersion(sourceDir: string, committedAt: number, commit: string): Promise<string> {
  const manifestPath = join(sourceDir, "package.json"), lockPath = join(sourceDir, "package-lock.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")), lock = JSON.parse(await readFile(lockPath, "utf8"));
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(manifest.version));
  if (manifest.name !== "branch-agent" || !match || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version
    || !Number.isSafeInteger(committedAt) || committedAt < 1 || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error("The source's version could not be read, so nothing was built.");
  const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}-dev.${committedAt}-g${commit.slice(0, 12)}`;
  manifest.version = lock.version = lock.packages[""].version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return version;
}
