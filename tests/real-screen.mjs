/**
 * Tests that drive this computer's real screen, keyboard or windows (open Notepad, type into it, take pictures of it)
 * must never run on the owner's PC by accident. Such a file starts with the marker line `// real-screen-test` and
 * runs its tests only when `realScreenAllowed()` says so:
 *
 *   - a person asked for it on this computer: BRANCH_SCREEN_TESTS=1, or
 *   - it is running in CI on Windows (a throwaway runner), where the screen belongs to nobody.
 *
 * scripts/review.mjs refuses any file carrying the marker, and tests/real-screen-guard.test.mjs fails when a test file
 * that reaches the real screen lacks the marker or the check.
 */
export const realScreenMarker = "// real-screen-test";
export const realScreenOptIn = "BRANCH_SCREEN_TESTS";

export function realScreenAllowed(env = process.env, platform = process.platform) {
  if (env[realScreenOptIn] === "1") return true;
  const ci = String(env.CI ?? "").trim().toLowerCase();
  return ci !== "" && ci !== "0" && ci !== "false" && platform === "win32";
}
