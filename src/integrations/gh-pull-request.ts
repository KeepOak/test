import { execFile } from "node:child_process";
import type { ComputerPullRequest } from "../pr-hook.js";
import { matchingPublication, publicationLookupPath, type PublicationLookup } from "../self-development-publication-lookup.js";

type Run = (file: string, args: string[], options: { signal: AbortSignal; windowsHide: true; timeout: number },
  done: (error: Error | null, stdout: string, stderr: string) => void) => { stdin: { end(text: string): void } | null };

/** Read-only reconciliation through the computer's existing sign-in, including closed PRs. */
export function computerGhPublicationFinder(run: Run = execFile as unknown as Run, gh = "gh"):
  (input: PublicationLookup, signal: AbortSignal) => Promise<unknown | null> {
  return (input, signal) => new Promise((resolve, reject) => {
    run(gh, ["api", "--method=GET", publicationLookupPath(input)], { signal, windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`GitHub lookup failed: ${String(stderr).slice(0, 300) || error.message}`)); return; }
      try { resolve(matchingPublication(input, JSON.parse(String(stdout)))); } catch (failure) { reject(failure); }
    });
  });
}

/**
 * selfdev: opens a draft pull request with this computer's own GitHub sign-in (`gh auth`). `gh` reads its
 * token itself, so Branch never holds it and nothing it writes (the model's context, a log) can carry it.
 * The fields are passed as `--name=value`, never through a shell, and the body goes in on standard input.
 */
export function computerGhOpener(run: Run = execFile as unknown as Run, gh = "gh"): (opening: ComputerPullRequest, signal: AbortSignal) => Promise<{ url: string }> {
  return (opening, signal) => new Promise((resolve, reject) => {
    const args = ["pr", "create", "--draft", `--repo=${opening.repo}`, `--base=${opening.base}`, `--head=${opening.head}`,
      `--title=${opening.title}`, "--body-file=-"];
    const child = run(gh, args, { signal, windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
      if (!error) { resolve({ url: String(stdout).trim().split(/\s+/).pop() ?? "" }); return; }
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(new Error(missing
        ? "Branch has no saved GitHub connection and this computer has no GitHub CLI (gh) either, so the pull request was not opened. Connect GitHub in Settings."
        : `The pull request was not opened with this computer's GitHub sign-in: ${String(stderr).trim().slice(0, 300) || error.message}`));
    });
    child.stdin?.end(opening.body);
  });
}
