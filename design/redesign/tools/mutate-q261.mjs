// Q261: applies each named mutation to dist/ in turn, runs tests/q261-household-reads.test.mjs, prints which tests went
// red, and puts dist/ back (checked by hash). Run from the repo root after `npx tsc -p .`: node design/redesign/tools/mutate-q261.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const M = [
  ["R1 a GET not listed falls back to the old rule", "dist/server.js",
    "    if (isRead(method))\n        return householdRefusalFor(path);\n", "    if (isRead(method) && offLimitsToShortLivedKeys(method, path) !== null)\n        return householdRefusalFor(path);\n    if (isRead(method))\n        return null;\n"],
  ["R2 HEAD is not a read", "dist/household-routes.js",
    "export const isRead = (method) => (method ?? \"GET\") === \"GET\" || method === \"HEAD\";", "export const isRead = (method) => (method ?? \"GET\") === \"GET\";"],
  ["R3 /api/mcp/servers added to the list", "dist/household-routes.js",
    "    read(\"/api/release-notes\", \"what is new in this version\"),\n", "    read(\"/api/release-notes\", \"what is new in this version\"),\n    read(\"/api/mcp/servers\", \"the tool servers\"),\n"],
  ["R4 a listed GET matches by prefix (no end anchor)", "dist/household-routes.js",
    "const read = (path, why) => ({\n    pattern: new RegExp(`^${path.split(\":id\").map(escape).join(id)}$`),",
    "const read = (path, why) => ({\n    pattern: new RegExp(`^${path.split(\":id\").map(escape).join(id)}`),"],
  ["R5 sockets: the household check removed", "dist/server.js",
    "                if (app.store.profiles.isOwner() || offLimitsToHousehold(\"GET\", path) === null)\n                    return false;", "                return false;"],
  ["R6 conversation-mode: another conversation's id read for a household person", "dist/conversation-mode-api.js",
    "const theirs = valid && (app.store.profiles.isOwner() || personConversation(app.store, app.runtime.owner, valid)) ? valid : null;", "const theirs = valid;"],
  ["R7 models/switch: the conversation check removed", "dist/voice-api.js",
    "        if (!mayUseConversation(store, owner, \"window\", input.sessionId))\n", "        if (false)\n"],
  ["R8 models/switch: names listed to a household person", "dist/voice-api.js",
    "{ names: store.profiles.isOwner(), holder:", "{ names: true, holder:"],
  ["R9 /model command: names listed to a household person", "dist/commands/handlers.js",
    "{ names: !household, holder }", "{ names: true, holder }"],
  ["R10 models/switch: the person's own conversation looked up under the owner", "dist/household-approvals.js",
    "    return store.ownsSession(scope, sessionId) ? scope : owner;", "    return owner;"],
];
const results = [];
for (const [name, file, from, to] of M) {
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) throw new Error(`${name}: pattern not found exactly once in ${file}`);
  writeFileSync(file, original.replace(from, to));
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "tests/q261-household-reads.test.mjs"], { encoding: "utf8" });
  writeFileSync(file, original);
  if (hash(readFileSync(file, "utf8")) !== hash(original)) throw new Error(`${file} not restored`);
  const red = [...new Set((run.stdout + run.stderr).split("\n").filter((line) => /^✖ /.test(line) && !/failing tests/.test(line)))];
  results.push(`${red.length ? "RED  " : "GREEN"} ${name}\n${red.map((line) => `      ${line.replace(/ \(\d+(\.\d+)?ms\)$/, "")}`).join("\n")}`);
}
console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("GREEN")) ? 1 : 0);
