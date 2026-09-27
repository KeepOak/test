// unhold/people: applies each named mutation to dist/ in turn, runs tests/unhold-people.test.mjs, prints which tests went red,
// and puts dist/ back. Run from the repo root after `npx tsc -p .`: node design/redesign/tools/mutate-unhold-people.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const W = process.cwd();
const M = [
  ["M1 switch() skips verifyPin", "dist/profiles.js", 'const at = this.verifyPin(value.profileId, value.pin ?? "");', "const at = new Date().toISOString();"],
  ["M2 switch() drops verifyOwnerPin", "dist/profiles.js", '                this.verifyOwnerPin(value.pin ?? "");', "                void 0;"],
  ["M3 household list gains /api/profiles/owner-pin AND setOwnerPin loses requireOwner", [["dist/household-routes.js", `...own("/api/lock"),`, `...own("/api/lock"), ...own("/api/profiles/owner-pin"),`], ["dist/profiles.js", `this.requireOwner("The PIN for switching back to the owner");`, `void 0;`]]],
  ["M3b household list gains /api/settings-kit/pins alone", "dist/household-routes.js", `...own("/api/lock"),`, `...own("/api/lock"), ...own("/api/settings-kit/pins"),`],
  ["M4 short-lived task routes gain /api/profiles/switch", "dist/short-lived-keys.js", 'post("/api/run", "starts a task"),', 'post("/api/run", "starts a task"), post("/api/profiles/switch", "mutation"),'],
  ["M5 the PIN goes into the added audit subject", "dist/collab-server.js", "subject: `${made.name}'s profile`,", "subject: `${made.name}'s profile ${person.pin}`,"],
  ["M6 the role change is not audited", "dist/collab-server.js", "        audit(app.store, app.runtime.owner, {\n            action: \"policy.changed\", actor: app.runtime.owner, subject: `${name}'s role`,", "        void ({\n            action: \"policy.changed\", actor: app.runtime.owner, subject: `${name}'s role`,"],
  ["M7 confirmSuggestion leaves the account waiting", "dist/people/index.js", "this.writeSuggestions(waiting.filter((each) => each !== found));", "void 0;"],
];
for (const [name, a, b, c] of M) {
  const edits = Array.isArray(a) ? a : [[a, b, c]];
  const saved = edits.map(([file]) => [`${W}/${file}`, readFileSync(`${W}/${file}`, "utf8")]);
  const missing = edits.filter(([file, from]) => !readFileSync(`${W}/${file}`, "utf8").includes(from));
  if (missing.length) { console.log(`${name}: pattern not found`); continue; }
  for (const [file, from, to] of edits) writeFileSync(`${W}/${file}`, readFileSync(`${W}/${file}`, "utf8").replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/unhold-people.test.mjs"], { cwd: W, encoding: "utf8" });
    const lines = (r.stdout + r.stderr).split("\n").filter((l) => /^(✔|✖) /.test(l)).map((l) => l.replace(/ \([\d.]+ms\)/, ""));
    console.log(`== ${name} (exit ${r.status})\n${[...new Set(lines)].join("\n")}`);
  } finally { for (const [path, text] of saved.reverse()) writeFileSync(path, text); }
}
