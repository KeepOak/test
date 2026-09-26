// Q258: applies each named mutation to dist/ in turn, runs tests/q258-household-gaps.test.mjs, prints which tests went
// red, and puts dist/ back (checked by hash). Run from the repo root after `npx tsc -p .`: node design/redesign/tools/mutate-q258.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const M = [
  ["S1 state(): everyone gets ownerStateParts", "dist/server.js", "...(app.store.profiles.isOwner() ? ownerStateParts(app) : householdStateParts(app)),", "...ownerStateParts(app),"],
  ["S2 ownAllowed: no own-task filter", "dist/household-state.js", ".filter((entry) => entry.runId !== null && own.has(entry.runId));", ".filter(() => true);"],
  ["S3 household identity keeps the instructions", "dist/household-state.js", "identity: { ...identity, instructions: \"\" },", "identity,"],
  ["S4 household memoryProposals: no own-task filter", "dist/household-state.js", ".filter((proposal) => own.has(proposal.runId)),", ","],
  ["S5 household background: no own-task filter", "dist/household-state.js", ".filter((result) => own.has(result.parentRunId)),", ","],
  ["S6 collab: household gets the owner's calendar", "dist/collab-server.js", "calendar: { settings: null, countries: [] } };", "calendar: { settings: app.calendar.settings(owner), countries: [] } };"],
  ["T1 /status: count every waiting question", "dist/commands/status.js", ".filter((asked) => !atWindow(call.surface) || mayAnswerHere(store, asked))", ".filter(() => true)"], // Q259: atWindow moved to commands/household
  ["T2 /status: list every working task", "dist/commands/status.js", "runsHere(store, owner, call.surface).filter((run) => run.status === \"running\")", "store.runs(owner).filter((run) => run.status === \"running\")"], // Q259: runsHere, as /stop
  ["T3 /status: a chat app counts as the window", "dist/commands/household.js", "export const atWindow = (surface) => surface === \"window\" || surface === \"phone\" || surface === \"dashboard\";", "export const atWindow = (surface) => true;"],
  ["P1 /preset: every change counts as confirmed", "dist/terminal-commands.js", "after, word === \"confirm\", runtime.registry", "after, true, runtime.registry"],
  ["P2 /preset: the refusal throw removed", "dist/terminal-commands.js", "    if (refusal)\n        throw new Error(refusal);\n", ""],
  ["R1 rooms answer: no-fingerprint check removed", "dist/trunks/rooms.js", "if (value.fingerprint === undefined && asked?.fingerprint)", "if (false)"],
  ["A1 mayAnswerHere: run-origin check -> true", "dist/household-approvals.js", "return runOrigin(store, asked.runId).personProfileId === person.id && store.ownsSession", "return true && store.ownsSession"],
  ["A2 mayAnswerHere: session check dropped", "dist/household-approvals.js", "personProfileId === person.id && store.ownsSession(profiles.scope(), asked.sessionId);", "personProfileId === person.id;"],
  ["A3 attention(): household waiting-runs filter dropped", "dist/server.js", "app.store.waitingRuns(profiles.scope()).filter((run) => mayAnswerHere(app.store, { runId: run.id, sessionId: run.sessionId }));", "app.store.waitingRuns(profiles.scope());"],
];
const results = [];
for (const [name, file, from, to] of M) {
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) throw new Error(`${name}: pattern not found exactly once in ${file}`);
  writeFileSync(file, original.replace(from, to));
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/q258-household-gaps.test.mjs"], { encoding: "utf8" });
  writeFileSync(file, original);
  if (hash(readFileSync(file, "utf8")) !== hash(original)) throw new Error(`${file} not restored`);
  const red = [...new Set((run.stdout + run.stderr).split("\n").filter((line) => /^✖ /.test(line) && !/failing tests/.test(line)))];
  results.push(`${red.length ? "RED  " : "GREEN"} ${name}\n${red.map((line) => `      ${line.replace(/ \(\d+(\.\d+)?ms\)$/, "")}`).join("\n")}`);
}
console.log(results.join("\n"));
