// Mutation check for the caller layer (src/caller-policy.ts): takes each entry of the table's lists out, one at a time,
// asks the one decision again for every route, caller and state in tests/caller-policy.golden.txt, and reports every
// entry whose removal changes no answer (a dead entry). Each entry that changes an answer is one that turns
// tests/caller-policy.test.mjs red when flipped. Run after `npm run build`:
//   node design/redesign/tools/mutate-caller-policy.mjs
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCaller } from "../../../dist/caller.js";
import { callerRefusal, lockdownRoutes, openWhileLocked, personDoors } from "../../../dist/caller-policy.js";
import { householdOwnerStores, householdOwnRoutes, householdReads } from "../../../dist/household-routes.js";
import { shortLivedKeyTaskRoutes } from "../../../dist/short-lived-keys.js";
import { SAMPLE_ID } from "../../../tests/short-lived-key-routes.mjs";

const text = await readFile(join(import.meta.dirname, "../../../tests/caller-policy.golden.txt"), "utf8");
const cells = [];
for (const line of text.split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [head, answers] = line.split(" | ");
  const [state, method, path] = head.split(" ");
  for (const pair of answers.split(" ")) {
    const [kind, answer] = pair.split("=");
    if (kind !== "nobody") cells.push({ state, method, path: path.replaceAll(":id", SAMPLE_ID), kind, answer });
  }
}
const keyOf = { here: "window", remote: "window", legacy: "window", phone: "phone", person: "person", read: "read", run: "run" };
const decide = ({ state, method, path, kind }) => {
  const caller = resolveCaller({ key: keyOf[kind], pairedDoor: kind === "phone" || kind === "legacy", fromThisComputer: kind !== "remote",
    windowHousehold: state.startsWith("household") && kind !== "person" && kind !== "phone" && kind !== "legacy",
    lockdown: state.endsWith("lockdown"), appLocked: state === "applock" });
  const onlyLooking = kind === "read" && method === "POST" && path === "/api/commands/run";
  const refused = callerRefusal(caller, method, path, { onlyLooking });
  return refused ? refused.status : "ok";
};
const statusOf = (answer) => (answer === "ok" ? "ok" : Number(answer.split("/")[0]));
// The emulation must agree with the running engine on every cell before any mutation means anything. A key's 401s
// that come from the key itself rather than the table (a set-up key, a key held to one conversation) are not asked here.
const disagree = cells.filter((cell) => decide(cell) !== statusOf(cell.answer));
if (disagree.length) {
  console.error(`${disagree.length} cells differ from the golden file before any mutation, e.g.`, disagree.slice(0, 5));
  process.exit(1);
}
const lists = { personDoors, lockdownRoutes, householdReads, householdOwnRoutes, householdOwnerStores, shortLivedKeyTaskRoutes };
let live = 0;
const dead = [];
for (const [name, list] of Object.entries(lists)) {
  for (let at = 0; at < list.length; at++) {
    const [removed] = list.splice(at, 1);
    const changed = cells.some((cell) => decide(cell) !== statusOf(cell.answer));
    list.splice(at, 0, removed);
    if (changed) live++;
    else dead.push(`${name}[${at}] ${removed.pattern ?? `${removed.method} ${removed.path}`}`);
  }
}
for (const entry of [...openWhileLocked]) {
  openWhileLocked.delete(entry);
  const changed = cells.some((cell) => decide(cell) !== statusOf(cell.answer));
  openWhileLocked.add(entry);
  if (changed) live++;
  else dead.push(`openWhileLocked ${entry}`);
}
console.log(`${cells.length} cells agree with the running engine; ${live} entries each turn the golden red when taken out.`);
if (dead.length) console.log(`${dead.length} entries change no answer asked here:\n  ${dead.join("\n  ")}`);
