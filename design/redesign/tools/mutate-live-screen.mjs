// parity-b2: runs the live-screen and owner-browse tests once per mutation, restoring each file after. The engine's are
// made to the built engine (dist/), the window's to public/app (served as they are). Every line must say "red": a
// mutation that leaves its test green means the test does not guard that check.
// Run from the repo root after the build: node design/redesign/tools/mutate-live-screen.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SCREEN = "tests/live-screen.test.mjs", BROWSE = "tests/owner-browse.test.mjs", WINDOW = "tests/live-screen-window.test.mjs";
const MUTATIONS = [
  ["S1 who: a caller through a door (a paired phone) is shown the screen", "dist/live-screen.js", SCREEN,
    [["if (deps.viaDoor)\n        return new LiveScreenRefusal(", "if (false)\n        return new LiveScreenRefusal("]]],
  ["S2 who: anyone but the owner is shown the screen", "dist/live-screen.js", SCREEN,
    [["if (!deps.profiles.isOwner())\n        return new LiveScreenRefusal(", "if (false)\n        return new LiveScreenRefusal("]]],
  ["S3 who: Lockdown no longer refuses the screen", "dist/live-screen.js", SCREEN,
    [["if (lockdownActive(deps.store, deps.owner))\n        return new LiveScreenRefusal(", "if (false)\n        return new LiveScreenRefusal("]]],
  ["S4 who: a short-lived key may read the screen", "dist/short-lived-keys.js", SCREEN,
    [["/^\\/api\\/panels\\/screen$/,", ""]]],
  ["S5 start: two reads at once take two frames", "dist/live-screen.js", SCREEN,
    [["inFlight ??= (async", "inFlight = (async"]]],
  ["S6 the screen switch off no longer stops a frame", "dist/integrations/desktop.js", SCREEN,
    [["if (!readDesktopSettings(this.store, owner).enabled)\n            throw new Error(switchedOffMessage);\n        const windows", "const windows"]]],
  ["S7 a password window on screen no longer stops a frame", "dist/integrations/desktop.js", SCREEN,
    [["else\n                privateShowing(answer.windows);", "else\n                void answer.windows;"]]],
  ["B1 who: a caller through a door types into the browser", "dist/owner-browse.js", BROWSE,
    [["if (deps.viaDoor)\n        return new BrowseRefusal(", "if (false)\n        return new BrowseRefusal("]]],
  ["B2 who: anyone but the owner types into the browser", "dist/owner-browse.js", BROWSE,
    [["if (!deps.profiles.isOwner())\n        return new BrowseRefusal(", "if (false)\n        return new BrowseRefusal("]]],
  ["B3 who: Lockdown no longer refuses the browser", "dist/owner-browse.js", BROWSE,
    [["if (lockdownActive(deps.store, deps.owner))\n        return new BrowseRefusal(", "if (false)\n        return new BrowseRefusal("]]],
  ["B4 a working task's browser takes the owner's typing", "dist/owner-browse.js", BROWSE,
    [["if (deps.busy(sessionId))\n        return new BrowseRefusal(", "if (false)\n        return new BrowseRefusal("]]],
  ["B5 stop: an unread window never closes", "dist/owner-browse.js", BROWSE,
    [["entry.timer = setTimeout(() => close(sessionId), browseIdleMs);", "entry.timer = null;"]]],
  ["B6 stop: a read no longer keeps the window open", "dist/owner-browse.js", BROWSE,
    [["  if (!entry)\n        return null;\n    idle(sessionId, entry);", "  if (!entry)\n        return null;"]]],
  ["B7 who: a short-lived key may type into the browser", "dist/short-lived-keys.js", BROWSE,
    [['post("/api/tools/try",', 'post("/api/panels/browse", "mutation"), post("/api/tools/try",']]],
  ["W1 stop: closing the view keeps reading the screen", "public/app/chat/stage-screen.js", WINDOW,
    [["if (!!on === V.on) return;\n  V.on = !!on;", "if (!on) return;\n  V.on = !!on;"]]],
  ["W2 stop: a hidden window keeps reading the screen", "public/app/chat/stage-screen.js", WINDOW,
    [["if (!V.on || document.hidden || locked()) return;", "if (!V.on || locked()) return;"], ["if (V.on && wait && !document.hidden && !locked())", "if (V.on && wait && !locked())"]]],
  ["W3 stop: a locked Branch keeps reading the screen", "public/app/chat/stage-screen.js", WINDOW,
    [["if (!V.on || document.hidden || locked()) return;", "if (!V.on || document.hidden) return;"], ["if (V.on && wait && !document.hidden && !locked())", "if (V.on && wait && !document.hidden)"]]],
  ["W4 start: the screen is read as soon as a conversation opens", "public/app/chat/stage.js", WINDOW,
    [["watchScreen(computer && E.profiles?.isOwner !== false", "watchScreen(here && E.profiles?.isOwner !== false"]]],
  ["W5 stop: switching to the browser keeps reading the screen", "public/app/chat/stage.js", WINDOW,
    [["const computer = here && (G.kind === \"computer\" ||", "const computer = here && (!!G.kind ||"]]],
];

let green = 0;
for (const [name, file, testFile, swaps] of MUTATIONS) {
  const original = readFileSync(file, "utf8");
  const missing = swaps.find(([from]) => !original.includes(from));
  if (missing) { console.log(`${name}: mutation text not found in ${file}: ${missing[0].slice(0, 60)}`); green++; continue; }
  writeFileSync(file, swaps.reduce((text, [from, to]) => text.replace(from, to), original));
  try {
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", testFile], { encoding: "utf8" });
    const failed = [...new Set(run.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("✖") && !/failing tests/.test(l)).map((l) => l.replace(/\s*\(\d[^)]*\)$/, "")))];
    if (run.status === 0) green++;
    console.log(`${name}: ${run.status === 0 ? "STILL GREEN" : "red"}${failed.map((l) => `\n    ${l}`).join("")}`);
  } finally {
    writeFileSync(file, original);
  }
}
console.log(green ? `${green} mutation(s) not caught` : "every mutation caught");
process.exit(green ? 1 : 0);
