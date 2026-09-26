// Q257: applies each named mutation to dist/ in turn, runs tests/q257-household-approvals.test.mjs, prints which tests went
// red, and puts dist/ back (checked by hash). Run from the repo root after `npx tsc -p .`: node design/redesign/tools/mutate-q257.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const M = [
  ["M1", "dist/server.js", "waiting: app.runtime.approvals.waiting().filter((asked) => mayAnswerHere(app.store, asked))", "waiting: app.runtime.approvals.waiting()"],
  ["M2", "dist/server.js", "const runs = profiles.isOwner() ? app.store.waitingRuns(app.runtime.owner)\n        : app.store.waitingRuns(profiles.scope()).filter((run) => mayAnswerHere(app.store, { runId: run.id, sessionId: run.sessionId }));", "const runs = app.store.waitingRuns(app.runtime.owner);"],
  ["M3", "dist/server.js", "        refuseForeignQuestion(app, input.sessionId, input.fingerprint);\n", ""],
  ["M4", "dist/server.js", "        throw new HttpError(404, nothingWaitingRefusal);\n}", "        throw new Error(nothingWaitingRefusal);\n}"],
  ["M5", "dist/household-approvals.js", "    const person = profiles.active();\n    if (!person || !asked.runId)\n        return false;", "    const person = profiles.active();\n    if (person || !person || !asked.runId)\n        return false;"],
  // Q258: startedForHere has an owner shortcut of its own, so M6 names mayAnswerHere's by what follows it.
  ["M6", "dist/household-approvals.js", "    if (profiles.isOwner())\n        return true;\n    const person = profiles.active();\n    if (!person || !asked.runId)", "    const person = profiles.active();\n    if (!person || !asked.runId)"],
  ["M6b", "dist/server.js", "    if (app.store.profiles.isOwner())\n        return;\n    const approvals = app.runtime.approvals;", "    const approvals = app.runtime.approvals;"],
  ["M7", "dist/server.js", "        if (refusal)\n            throw new HttpError(409, refusal);\n", ""],
  ["M8", "dist/policy-change-guard.js", "    if (lockdownActive(store, owner))", "    if (false)"],
  ["M9", "dist/policy-change-guard.js", "    if (confirmLoosening)", "    if (true)"],
  ["M10", "dist/misc-api.js", "        if (refusal)\n            throw new MiscApiError(409, refusal);\n", ""],
  ["M11", "dist/credential-cli.js", "    audit(store, owner, { action: \"connection.changed\"", "    void ({ action: \"connection.changed\""],
  ["M12", "dist/credential-cli.js", "services: [choose, ...current.services.filter((service) => service !== choose)]", "services: [choose]"],
  ["M13", "dist/preset-moves.js", "if (before.unmatchedCommands === \"ask\" && after.unmatchedCommands === \"allow\")", "if (false)"],
  ["M14", "dist/preset-moves.js", "if (limitLooser(before.limits[key], after.limits[key]))", "if (false)"],
  // Q258: /preset weighs Lockdown and loosening through policyChangeRefusal, so M16 drops that refusal's throw.
  ["M16", "dist/terminal-commands.js", "    if (refusal)\n        throw new Error(refusal);\n", ""],
  ["M15", "dist/server.js","if (input.fingerprint === undefined && app.runtime.approvals.questionFor(input.sessionId)?.fingerprint)", "if (false)"],
];
// M6 is the two owner shortcuts together: both lines are removed for that one run.
const groups = { M6: ["M6", "M6b"] };
const skip = new Set(["M6b"]);
const results = [];
for (const [name] of M) {
  if (skip.has(name)) continue;
  const parts = (groups[name] ?? [name]).map((id) => M.find((m) => m[0] === id));
  const originals = new Map();
  for (const [, file, from, to] of parts) {
    const text = originals.get(file) ?? readFileSync(file, "utf8");
    if (!originals.has(file)) originals.set(file, text);
    const current = readFileSync(file, "utf8");
    if (current.split(from).length !== 2) throw new Error(`${name}: pattern not found exactly once in ${file}`);
    writeFileSync(file, current.replace(from, to));
  }
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/q257-household-approvals.test.mjs"], { encoding: "utf8" });
  for (const [file, text] of originals) { writeFileSync(file, text); if (hash(readFileSync(file, "utf8")) !== hash(text)) throw new Error(`${file} not restored`); }
  const red = (run.stdout + run.stderr).split("\n").filter((line) => /^✖ /.test(line) && !/failing tests/.test(line));
  const unique = [...new Set(red)];
  results.push(`${unique.length ? "RED  " : "GREEN"} ${name}\n${unique.map((line) => `      ${line.replace(/ \(\d+(\.\d+)?ms\)$/, "")}`).join("\n")}`);
}
console.log(results.join("\n"));
