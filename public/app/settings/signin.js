/* Which system "Start with Windows" names (Settings › General). The prototype's words are for Windows; on a Mac or
   another computer the same switch names that system instead, from the engine's GET /api/deployment platform. Until
   the engine has said which system it runs on, none is guessed. No imports, so it can be read on its own. */

export const signInSystem = (platform) => (platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "computer");

/* The switch's words: the prototype's on Windows, the sign-in words for a Mac or this computer elsewhere. */
export const startKey = (platform) => ({
  windows: "window.settings.general.start-with-windows",
  mac: "field.start-branch-when-i-sign.mac",
  computer: "field.start-branch-when-i-sign",
})[signInSystem(platform)];

/* "Branch starts with Windows" is said only where Branch runs on Windows. */
export const startsWithWindows = (platform) => signInSystem(platform) === "windows";
