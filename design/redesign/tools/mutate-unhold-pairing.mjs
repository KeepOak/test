// Runs tests/unhold-pairing.test.mjs once per mutation of the built engine (dist/), restoring each file after.
// Every line must say "red": a mutation that leaves the test green means the test does not guard that check.
// Run from the repo root after `npx tsc -p .`: node design/redesign/tools/mutate-unhold-pairing.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MUTATIONS = [
  ["M1 short-lived key: a task route lets POST /api/devices/* through", "dist/short-lived-keys.js",
    'post("/api/run", "starts a task"),', 'post("/api/run", "starts a task"), { method: "POST", pattern: /^\\/api\\/devices\\/.*$/, why: "mutation" },'],
  ["M2 short-lived key: the devices list is no longer an owner-only read", "dist/short-lived-keys.js",
    "/^\\/api\\/devices(\\/.*)?$/,", ""],
  ["M3 household: householdMaySend lets /api/devices through (the owner check is still there)", "dist/household-routes.js",
    'const verb = method ?? "GET";', 'const verb = method ?? "GET"; if (path.startsWith("/api/devices")) return true;'],
  ["M4 owner approval: the check-code confirmation is dropped", "dist/devices/api.js",
    "if (body.approve && body.codeMatches !== true)", "if (false)"],
  ["M5 wrong code: the wrong-number refusal is skipped", "dist/devices/book.js",
    "if (!rightCode) {", "if (false) {"],
  ["M6 tries: a sixth try is allowed", "dist/devices/book.js",
    "if (offer.attempts > offerAttempts) {", "if (offer.attempts > offerAttempts + 1) {"],
  ["M7 expiry: an invitation never expires", "dist/devices/book.js",
    "if (this.offer && this.offer.expiresAt <= this.now())", "if (this.offer && this.offer.expiresAt + 36e5 <= this.now())"],
];

let green = 0;
for (const [name, file, from, to] of MUTATIONS) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { console.log(`${name}: mutation text not found in ${file}`); green++; continue; }
  writeFileSync(file, original.replace(from, to));
  try {
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/unhold-pairing.test.mjs"], { encoding: "utf8" });
    const failed = [...new Set(run.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("✖") && !/failing tests/.test(l)).map((l) => l.replace(/\s*\(\d[^)]*\)$/, "")))];
    if (run.status === 0) green++;
    console.log(`${name}: ${run.status === 0 ? "STILL GREEN" : "red"}${failed.map((l) => `\n    ${l}`).join("")}`);
  } finally {
    writeFileSync(file, original);
  }
}
console.log(green ? `${green} mutation(s) not caught` : "every mutation caught");
process.exit(green ? 1 : 0);
