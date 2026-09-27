// Proves tests/pass18-window.test.mjs checks what it says: each mutation breaks one pass 18 part in the window, the
// test named for that part must then fail, and the file is put back. Run from the worktree root after `npm run build`:
//   node design/redesign/tools/mutate-pass18.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MUTATIONS = [
  ["empty states drawn as a blank list", "public/app/places/team.js",
    'return runs.length ? `<div class="runs6">${runs.map((r) => liveRow(r)).join("")}</div>` : empty18("team:live");',
    'return `<div class="runs6">${runs.map((r) => liveRow(r)).join("")}</div>`;', "an empty list is a welcome"],
  ["live line always Idle", "public/app/core/p18.js",
    'if (trunk.paused) return `<span class="live18">${t("dashboard.standing.paused")}</span>`;', "", "live line is the engine's"],
  ["lanes use the Trunk's own conversation, not the room's", "public/app/chat/pane.js",
    "const sid = view?.memberSessions?.[seated.id],", "const sid = seated.chatSessionId,", "one lane per member"],
  ["handoff Accept wired live", "public/app/places/team-tabs.js",
    'data-act="hoaccept18b" data-held="security" aria-disabled="true" disabled', 'data-act="hoaccept18b"', "team run board"],
  ["rounds numbered from 0 again", "public/app/places/team-tabs.js",
    'esc(t("window.p18.round", { n: b }))', 'esc(t("window.p18.round", { n: b + 1 }))', "team run board"],
];

let bad = 0;
for (const [name, file, from, to, pattern] of MUTATIONS) {
  const before = readFileSync(file, "utf8");
  if (!before.includes(from)) { console.log(`SKIP ${name}: the line to mutate is not in ${file}`); bad++; continue; }
  writeFileSync(file, before.replace(from, to));
  try {
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${pattern}`, "tests/pass18-window.test.mjs"], { encoding: "utf8" });
    const red = run.status !== 0;
    console.log(`${red ? "RED (good)" : "GREEN (bad)"} ${name}`);
    if (!red) bad++;
  } finally { writeFileSync(file, before); }
}
console.log(bad ? `${bad} mutation(s) not caught` : `all ${MUTATIONS.length} mutations caught`);
process.exit(bad ? 1 : 0);
