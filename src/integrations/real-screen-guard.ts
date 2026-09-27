/**
 * Dogfood follow-up: nothing run by the test runner may reach this computer's real screen, keyboard or windows unless a
 * person asked for it. Every place Branch starts the program that does (PowerShell on Windows, osascript or xdotool on a
 * Mac or Linux, the live view's reader, the Stop notice) asks here first.
 *
 * The test runner sets NODE_TEST_CONTEXT in every test process; Branch itself never runs with it. Under it the real
 * screen is refused unless BRANCH_SCREEN_TESTS=1 (a person opting in on this computer) or the run is CI on Windows (a
 * throwaway runner whose screen belongs to nobody). Tests that stand the screen in (an injected runner, a fake program
 * runner) never reach these places, so they are not affected.
 */
export const realScreenTestRefusal =
  "A test tried to use this computer's real screen, keyboard or windows. That is refused unless BRANCH_SCREEN_TESTS=1 is set.";

export function realScreenRefusal(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  if (!env.NODE_TEST_CONTEXT) return null;
  if (env.BRANCH_SCREEN_TESTS === "1") return null;
  const ci = String(env.CI ?? "").trim().toLowerCase();
  if (ci !== "" && ci !== "0" && ci !== "false" && platform === "win32") return null;
  return realScreenTestRefusal;
}

/** Throws the refusal when a test may not reach the real screen. */
export function assertRealScreenAllowed(): void {
  const refused = realScreenRefusal();
  if (refused) throw new Error(refused);
}
