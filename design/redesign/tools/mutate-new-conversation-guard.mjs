// setup-make-it-yours: applies each named mutation to dist/ in turn, runs tests/conversation-mode-settings-guard.test.mjs,
// prints which tests went red, and puts dist/ back. Run from the repo root after `npx tsc -p .`:
//   node design/redesign/tools/mutate-new-conversation-guard.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const W = process.cwd();
const M = [
  ["M1 the owner's yes is taken as given", "dist/conversation-mode-api.js", "    if (confirmLoosening)\n        return null;", "    if (true)\n        return null;"],
  ["M2 the refusal is never thrown", "dist/conversation-mode-api.js", "            if (refusal)\n                throw new ConversationModeError(409, refusal);\n", ""],
  ["M3 Lockdown is not weighed", "dist/conversation-mode-api.js", "    if (lockdownActive(app.store, app.runtime.owner))\n        return lockdownSettingsRefusal;", "    if (false)\n        return lockdownSettingsRefusal;"],
  ["M4 follow as the new start ranks by its preset", "dist/conversation-mode.js", "after ? followAfterRank : presetRank[preset]", "presetRank[preset]"],
  ["M5 follow as the old start ranks as the loosest", "dist/conversation-mode.js", "after ? followAfterRank : presetRank[preset]", "followAfterRank"],
];
for (const [name, file, from, to] of M) {
  const path = `${W}/${file}`, text = readFileSync(path, "utf8");
  if (text.split(from).length !== 2) { console.log(`${name}: pattern not found exactly once in ${file}`); continue; }
  writeFileSync(path, text.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/conversation-mode-settings-guard.test.mjs"], { cwd: W, encoding: "utf8" });
    const red = [...new Set((r.stdout + r.stderr).split("\n").filter((l) => /^✖ /.test(l) && !/failing tests/.test(l)).map((l) => l.replace(/ \([\d.]+ms\)/, "")))];
    console.log(`${red.length ? "RED  " : "GREEN"} ${name}\n${red.map((l) => `      ${l}`).join("\n")}`);
  } finally {
    writeFileSync(path, text);
    if (readFileSync(path, "utf8") !== text) throw new Error(`${file} not restored`);
  }
}
