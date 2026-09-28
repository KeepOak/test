// parity-b2: runs the live-screen tests once per mutation, restoring each file after. The engine's are
// made to the built engine (dist/), the window's to public/app (served as they are). Every line must say "red": a
// mutation that leaves its test green means the test does not guard that check.
// Run from the repo root after the build: node design/redesign/tools/mutate-live-screen.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SCREEN = "tests/live-screen.test.mjs", WINDOW = "tests/live-screen-window.test.mjs", PUTBACK = "tests/put-back-any-scope.test.mjs";
const MUTATIONS = [
  ["S1 who: a caller through a door (a paired phone) is shown the screen", "dist/live-screen.js", SCREEN,
    [["if (deps.viaDoor)\n        return new LiveScreenRefusal(", "if (false)\n        return new LiveScreenRefusal("]]],
  ["S2 who: anyone but the owner is shown the screen", "dist/live-screen.js", SCREEN,
    [["if (!deps.profiles.isOwner())\n        return new LiveScreenRefusal(", "if (false)\n        return new LiveScreenRefusal("]]],
  ["S3 who: Lockdown no longer refuses the screen", "dist/live-screen.js", SCREEN,
    [["if (lockdownActive(deps.store, deps.owner))\n        return new LiveScreenRefusal(", "if (false)\n        return new LiveScreenRefusal("]]],
  ["S4 who: a short-lived key may read the screen", "dist/short-lived-keys.js", SCREEN,
    [["/^\\/api\\/panels\\/screen$/,", ""]]],
  ["S5 start: a second view starts a second reader", "dist/live-screen.js", SCREEN,
    [["if (hub) {\n        hub.viewers.add(viewer);\n        return;\n    }", "if (false) {\n        hub.viewers.add(viewer);\n        return;\n    }"]]],
  ["S6 the screen switch off no longer stops a frame", "dist/integrations/desktop.js", SCREEN,
    [["if (!readDesktopSettings(this.store, owner).enabled)\n            throw new Error(switchedOffMessage);\n        const windows", "const windows"]]],
  ["S7 a password window open as the frame was taken no longer stops it", "dist/integrations/desktop.js", SCREEN,
    [["privateShowing(answer.windows);\n            privateShowing(answer.after);", "privateShowing(answer.after);"]]],
  ["S7b a password window opened while the frame was taken no longer stops it", "dist/integrations/desktop.js", SCREEN,
    [["privateShowing(answer.windows);\n            privateShowing(answer.after);", "privateShowing(answer.windows);"]]],
  ["S8 who: the server no longer tells a door from this computer", "dist/server.js", SCREEN,
    [["streamLiveScreen({ store: app.store, owner: app.runtime.owner, profiles: app.store.profiles, viaDoor: throughDoor(request),", "streamLiveScreen({ store: app.store, owner: app.runtime.owner, profiles: app.store.profiles, viaDoor: false,"]]],
  ["S9 a sign-in under way no longer stops a frame", "dist/live-screen.js", SCREEN,
    [["if (signInShowing())\n        return new LiveScreenRefusal(", "if (false)\n        return new LiveScreenRefusal("]]],
  ["S10 a sign-in that began mid-frame no longer drops it", "dist/live-screen.js", SCREEN,
    [["if (since)\n                throw since;", "if (false)\n                throw since;"]]],
  ["S21 Lockdown, the app lock or a switched window that came mid-frame no longer drops it", "dist/live-screen.js", SCREEN,
    [["const since = liveScreenRefusal(current.deps);", "const since = signInShowing() ? new LiveScreenRefusal(409, liveScreenSignInRefusal) : null;"]]],
  ["S22 the screen switch turned off mid-frame no longer drops it", "dist/integrations/desktop.js", SCREEN,
    [["// The switch turned off while the frame was being taken: dropped, not shown.\n            if (!readDesktopSettings(this.store, owner).enabled)", "// The switch turned off while the frame was being taken: dropped, not shown.\n            if (false)"]]],
  ["S23 who: a paired phone's own key from this computer is not a door", "dist/server.js", SCREEN,
    [["pairedDoorRequests.has(request) || throughADoor(request)\n", "pairedDoorRequests.has(request)\n"]]],
  ["S11 the app lock is no longer asked", "dist/live-screen.js", SCREEN,
    [["const locked = deps.locked();\n    if (locked)", "const locked = deps.locked();\n    if (false)"]]],
  ["S12 the Windows program writes the frame to a file", "dist/integrations/desktop-script.js", SCREEN,
    [["small.Save(stream, jpeg, quality)", "small.Save(Path.Combine(Path.GetTempPath(), \"live.jpg\"), ImageFormat.Jpeg)"]]],
  ["S13 a refusal that should end the view only pauses it", "dist/live-screen.js", SCREEN,
    [["if (refused && refused.status !== 409) {", "if (false) {"]]],
  ["S14 stop: the last view going keeps the reader", "dist/live-screen.js", SCREEN,
    [["hub = null;\n        current.abort.abort();\n        current.source.close();\n    });", "});"]]],
  ["S15 stop: a frame under way is not stopped when its view goes", "dist/live-screen.js", SCREEN,
    [["hub = null;\n        current.abort.abort();\n        current.source.close();\n    });", "hub = null;\n        current.source.close();\n    });"]]],
  ["S16 stop: Branch stopping leaves the views open", "dist/server.js", SCREEN,
    [["stopLiveScreen(); // parity-b2", "void 0; // parity-b2"]]],
  ["S17 stop: the Windows program no longer ends when its input goes", "dist/integrations/desktop-script.js", SCREEN,
    [["if ($line -eq $null) { break }", "if ($line -eq $null) { continue }"]]],
  ["S18 stop: a dropped frame leaves its program running", "dist/integrations/desktop-script.js", SCREEN,
    [["const aborted = () => stop('That was stopped before it finished.');", "const aborted = () => this.settle(new Error('That was stopped before it finished.'));"]]],
  ["S20 Branch stopping leaves the Windows program running", "dist/integrations/desktop.js", SCREEN,
    [["frames.close(); // parity-b2: no live view outlives Branch", "void frames; // parity-b2: no live view outlives Branch"]]],
  ["W1 stop: closing the view keeps reading the screen", "public/app/chat/stage-screen.js", WINDOW,
    [["if (!V.on) { Object.assign(V, { frame: \"\", refusal: \"\" }); return; }", "if (!V.on) { Object.assign(V, { frame: \"\", refusal: \"\" }); V.on = true; return; }"], ["    stop();\n    if (!V.on)", "    if (!V.on)"]]],
  ["W2 stop: a hidden window keeps reading the screen", "public/app/chat/stage-screen.js", WINDOW,
    [["if (document.hidden) stop(); else start();", "if (!document.hidden) start();"]]],
  ["W3 stop: a locked Branch keeps reading the screen", "public/app/chat/stage-screen.js", WINDOW,
    [["new MutationObserver(() => { if (locked()) stop(); })", "new MutationObserver(() => undefined)"]]],
  ["W4 start: the screen is read as soon as a conversation opens", "public/app/chat/stage.js", WINDOW,
    [["watchScreen(computer && E.profiles?.isOwner !== false", "watchScreen(here && E.profiles?.isOwner !== false"]]],
  ["W5 stop: switching to the browser keeps reading the screen", "public/app/chat/stage.js", WINDOW,
    [["const computer = here && (G.kind === \"computer\" ||", "const computer = here && (!!G.kind ||"]]],
  ["W6 All screens reads This computer when it is not one of its screens", "public/app/chat/stage.js", WINDOW,
    [["shows = grid ? grid.list.some((x) => x.id === \"this\") : onThis();", "shows = grid ? true : onThis();"]]],
  ["P1 Put back no longer reaches a Trunk's or a copy's file", "dist/server.js", PUTBACK,
    [[".versionId, { anyScope: true });", ".versionId);"]]],
  ["P2 Put back writes into the owner's folder, not the one it was changed in", "dist/workspace-history.js", PUTBACK,
    [["return inWorktree(scope, () => this.restore(versionId));", "return this.restore(versionId);"]]],
  ["P3 a task's files.restore reaches every folder", "dist/workspace-history.js", PUTBACK,
    [["async restore(versionId, options = {}) {", "async restore(versionId, options = { anyScope: true }) {"]]],
  ["P4 Put back follows a folder that became a link or junction", "dist/workspace-history.js", PUTBACK,
    [["await realFolderInside(this.files.root, scope);", ""]]],
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
