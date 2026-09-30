// Installs this repository's git merge drivers in the clone it runs in (the settings are kept in .git/config, which
// every worktree of the clone shares, so once per clone is enough; running it again changes nothing). Run once:
//   node scripts/setup-merge-drivers.mjs
// Without it git still merges the files named in .gitattributes, only line by line, as before.
import { spawnSync } from "node:child_process";

const DRIVERS = {
  jsonkeys: { name: "Merge JSON string tables by key", driver: "node scripts/merge-json-keys.mjs %O %A %B" },
};

for (const [id, { name, driver }] of Object.entries(DRIVERS)) {
  for (const [key, value] of [[`merge.${id}.name`, name], [`merge.${id}.driver`, driver]]) {
    const run = spawnSync("git", ["config", key, value], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  console.log(`merge driver "${id}" installed: ${driver}`);
}
