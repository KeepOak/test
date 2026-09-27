// Proves tests/pass18-onboarding-window.test.mjs guards pass 18c's setup: each mutation below is applied to the window's
// source in place, the test is run and must fail (RED), and the file is put back byte for byte. Then the test runs once
// on the real source and must pass (GREEN). Run from the repository root after `npx tsc -p .`:
//   node design/redesign/tools/mutate-pass18-onboarding.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TEST = "tests/pass18-onboarding-window.test.mjs";
const MUTATIONS = [
  ["the wizard back to eleven steps", "public/app/flows/setup.js",
    'const WIZARD = ["welcome", "models", "trunks"];',
    'const WIZARD = ["welcome", "where", "models", "yours", "trunks", "reach", "tools", "keep", "people", "more", "check"];'],
  ["a tick written in (the prototype's where: true)", "public/app/places/overview.js",
    "const completed = new Set(p.completed ?? []);",
    'const completed = new Set(["where", ...(p.completed ?? [])]);'],
  ["Hide kept only in the window", "public/app/places/overview.js",
    "try { await saveProgress({ finishHidden: true }); }",
    "try { E.state.onboarding.finishHidden = true; }"],
  ["the Guide menu says Done once the wizard ends", "public/app/flows/setup.js",
    'return done === FINISH.length ? t("window.shell.shell.all-done")',
    'return done === FINISH.length || p.finishedAt ? t("window.shell.shell.all-done")'],
];

const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=1", TEST], { encoding: "utf8", timeout: 300000 }).status;
let bad = 0;
for (const [name, file, from, to] of MUTATIONS) {
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) { console.log(`SKIPPED (not found once): ${name}`); bad++; continue; }
  try {
    writeFileSync(file, original.replace(from, to));
    const status = run();
    console.log(`${status === 0 ? "GREEN (the test missed it)" : "RED"}: ${name}`);
    if (status === 0) bad++;
  } finally {
    writeFileSync(file, original);
  }
  if (readFileSync(file, "utf8") !== original) throw new Error(`${file} was not restored`);
}
const green = run();
console.log(`${green === 0 ? "GREEN" : "RED (the real source fails)"}: unmutated`);
if (green !== 0) bad++;
process.exit(bad ? 1 : 0);
