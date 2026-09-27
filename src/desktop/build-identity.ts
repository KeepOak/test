import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const commitShape = /^[0-9a-f]{40}$/;

/**
 * The commit a source checkout is at now, or null when git cannot say. Asked without waiting on git (never a
 * synchronous child process), so the window's main process keeps answering while git is slow or stuck.
 */
export function checkoutHead(appPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: appPath, encoding: "utf8", timeout: 5000, windowsHide: true }, (error, stdout) => {
      const head = error ? "" : String(stdout).trim();
      resolve(commitShape.test(head) ? head : null);
    });
  });
}

/**
 * The commit written into this build by scripts/package-desktop.mjs, or null for a copy built without one.
 * Q55: a copy running from its source code keeps an old dist/build-info.json across later builds, so there
 * the stamp is believed only when the checkout is still at that commit; otherwise it is "not recorded".
 */
export async function builtFrom(
  appPath: string, packaged: boolean, headOf: (appPath: string) => Promise<string | null> = checkoutHead,
): Promise<string | null> {
  let commit: unknown;
  try { commit = JSON.parse(await readFile(join(appPath, "dist", "build-info.json"), "utf8"))?.commit; } catch { return null; }
  if (typeof commit !== "string" || !commitShape.test(commit)) return null;
  return packaged || (await headOf(appPath)) === commit ? commit : null;
}

/**
 * Q55: the commit of the copy at `packageRoot` (the terminal's own). An installed copy has no .git and believes
 * its stamp, as a packaged window does; a source checkout believes it only while it is still at that commit.
 */
export function commitOfCopy(
  packageRoot: string, headOf: (appPath: string) => Promise<string | null> = checkoutHead,
): Promise<string | null> {
  return builtFrom(packageRoot, !existsSync(join(packageRoot, ".git")), headOf);
}
