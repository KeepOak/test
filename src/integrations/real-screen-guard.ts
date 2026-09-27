/**
 * Dogfood follow-up: nothing run by the test runner may reach this computer's real screen, keyboard or windows unless a
 * person asked for it. Every place Branch starts the program that does (PowerShell on Windows, osascript or xdotool on a
 * Mac or Linux, the live view's reader, the Stop notice) asks here first.
 *
 * The test runner sets NODE_TEST_CONTEXT in every test process; Branch itself never runs with it. Under it the real
 * screen is refused unless BRANCH_SCREEN_TESTS=1 (a person opting in on this computer) or the run is CI on Windows (a
 * throwaway runner whose screen belongs to nobody). Tests that stand the screen in (an injected runner, a fake program
 * runner) never reach these places, so they are not affected. On a Mac or Linux a test may also really run a stand-in
 * program it wrote into the temporary folder: only the Mac/Linux runner passes the program, only when the code that
 * built the runner handed in its own program finder (Branch itself never does), and only a file that truly lies inside
 * the temporary folder (links followed) counts as a stand-in.
 *
 * Nothing here can loosen Branch: outside the test runner this guard refuses nothing, so switching the test runner's
 * variable on can only add refusals, and the stand-in exemption only takes some of those back.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

export const realScreenTestRefusal =
  "A test tried to use this computer's real screen, keyboard or windows. That is refused unless BRANCH_SCREEN_TESTS=1 is set.";

export function realScreenRefusal(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  if (!env.NODE_TEST_CONTEXT) return null;
  if (env.BRANCH_SCREEN_TESTS === "1") return null;
  const ci = String(env.CI ?? "").trim().toLowerCase();
  if (ci !== "" && ci !== "0" && ci !== "false" && platform === "win32") return null;
  return realScreenTestRefusal;
}

/** Whether a program is a stand-in a test wrote: a real file inside the temporary folder, links followed. */
export function standInProgram(executable: string, temp: string = tmpdir()): boolean {
  try {
    const inside = relative(realpathSync(temp), realpathSync(executable));
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
  } catch {
    return false;
  }
}

/** Throws the refusal when a test may not reach the real screen. `executable`, when given, may be a stand-in. */
export function assertRealScreenAllowed(executable?: string): void {
  const refused = realScreenRefusal();
  if (refused && !(executable !== undefined && standInProgram(executable))) throw new Error(refused);
}
