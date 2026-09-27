// Mutation check for Orchard (src/orchard): breaks each guard in the built engine, one at a time, runs
// tests/orchard.test.mjs, and reports every mutation that leaves it green (a guard no test holds). The built file is
// put back after each one, and at the end whatever happens. Run after `npm run build`:
//   node design/redesign/tools/mutate-orchard.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const dist = (file) => join(ROOT, "dist/orchard", file);
/* [what it breaks, built file, exact text, what it becomes] */
const MUTATIONS = [
  ["a Trunk's or a chat's card is planted as if the owner said yes", "index.js", 'planted: actor.kind === "owner"', "planted: true"],
  ["the grower pulls while Lockdown is on", "index.js", "if (!this.deps.on() || this.deps.lockdown())", "if (!this.deps.on())"],
  ["a card starts before the cards it waits for are picked", "index.js", "if (waiting.length)", "if (false)"],
  ["a paused Trunk is given work", "index.js", "return this.deps.runtime.trunkPaused(trunk.id) ?? this.deps.runtime.trunkAtOnce(trunk.id);", "return this.deps.runtime.trunkAtOnce(trunk.id);"],
  ["Grow ignores the board's limit", "index.js", "if (active.filter((other) => other.board === card.board).length >= this.data.board(card.board).atOnce)", "if (false)"],
  ["an active blocked card frees its board slot", "index.js", 'return !!run && (run.status === "running" || run.status === "needs_input" || this.pausedByOwner(run.id));', "return false;"],
  ["an interrupted migration retains partial boards and cards", "store.js", 'this.db.exec("ROLLBACK TO orchard_migration; RELEASE orchard_migration");', 'this.db.exec("RELEASE orchard_migration");'],
  ["a card follows its task's promise, not its record (a question bounces it)", "index.js", "this.track(work.then(() => undefined, (error) => {",
    'this.track(work.then((run) => { const now = this.data.find(card.id); if (now && now.lane === "growing") this.data.write(now, { lane: run.status === "completed" ? "ripe" : "seed", failures: run.status === "completed" ? 0 : now.failures + 1 }, "orchard", "promise"); }, (error) => {'],
  ["a chat's comment is put in front of the card's task", "index.js", ".filter((c) => !outsideActors.includes(c.by))", ""],
  ["a card shows every waiting question, not only its own", "api.js", "deps.orchard.containsRun(card.runId, ask.runId)", "true"],
  ["a household person's task reads Orchard", "tools.js", "if (currentPerson() || !store.profiles.isOwner())", "if (false)"],
  ["a chat's task reads Orchard", "tools.js", "    if (!boardWriter(store, context.runId))\n        throw new Error(\"Only the owner's own work can read", "    if (false)\n        throw new Error(\"Only the owner's own work can read"],
  ["a chat's task posts to Orchard", "tools.js", "    if (!boardWriter(store, context.runId))\n        throw new Error(\"Only the owner's own work can change", "    if (false)\n        throw new Error(\"Only the owner's own work can change"],
  ["a chat starts work with /orchard", "commands.js", "if (chat || call.access !== \"full\")\n        return say(ownersOnly);", ""],
  ["a chat's /orchard card is planted", "commands.js", 'const actor = chat ? { kind: "chat" } : call.access === "full" ? { kind: "owner" } : { kind: "key" };', 'const actor = { kind: "owner" };'],
];

let survived = 0;
for (const [what, file, from, to] of MUTATIONS) {
  const path = dist(file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(from)) { console.log(`MISSING ${what}: the text to break is not in dist/orchard/${file}`); survived++; continue; }
  try {
    writeFileSync(path, original.replace(from, to));
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/orchard.test.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 300000 });
    const red = run.status !== 0;
    if (!red) survived++;
    console.log(`${red ? "RED  " : "GREEN"} ${what}`);
  } finally {
    writeFileSync(path, original);
  }
}
console.log(survived ? `${survived} mutation(s) no test caught` : `all ${MUTATIONS.length} mutations turn tests/orchard.test.mjs red`);
process.exit(survived ? 1 : 0);
