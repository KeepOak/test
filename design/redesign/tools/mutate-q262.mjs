// Q262: applies each named mutation (to dist/ or public/) in turn, runs tests/q262-household-writes.test.mjs, prints
// which tests went red, and puts the file back (checked by hash). Exits 1 when any mutation leaves every test green.
// Run from the repo root after `npx tsc -p .`: node design/redesign/tools/mutate-q262.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const check = "    if (householdOwnerStore(method, path))\n        return householdRefusalFor(path);\n";
const maySend = "    if (householdMaySend(method, path))\n        return null;\n";
const documents = "\"/api/documents\", \"/api/documents/:id DELETE\", \"/api/documents/reindex\", \"/api/documents/search\"),";
const monitors = "\"/api/monitors\", \"/api/monitors/:id/check\"),";
/** [name, [file, from, to]...]: every change of one mutation, each found exactly once. */
const M = [
  ["W1 offLimitsToHousehold: the owner's stores not checked at all", ["dist/server.js", check, ""]],
  ["W2 the document library back as a person's own", ["dist/household-routes.js", documents, "\"/api/documents/reindex\"),"],
    ["dist/household-routes.js", "        own(\"/api/coding/ci\"),\n", "        own(\"/api/coding/ci\"),\n        own(\"/api/documents\"),\n        own(\"/api/documents/:id\", \"DELETE\"),\n        own(\"/api/documents/search\"),\n"]],
  ["W3 the watches back as a person's own", ["dist/household-routes.js", monitors, "\"/api/monitors/:id/check\"),"],
    ["dist/household-routes.js", "        own(\"/api/memory/tidy/all\"),\n", "        own(\"/api/memory/tidy/all\"),\n        own(\"/api/monitors\"),\n"]],
  ["W4 householdOwnerStores: POST /api/documents/search left out", ["dist/household-routes.js", documents, "\"/api/documents\", \"/api/documents/:id DELETE\", \"/api/documents/reindex\"),"]],
  ["W5 the owner's stores checked after householdMaySend, POST /api/documents a person's own again",
    ["dist/server.js", check + maySend, maySend + check],
    ["dist/household-routes.js", "        own(\"/api/coding/ci\"),\n", "        own(\"/api/coding/ci\"),\n        own(\"/api/documents\"),\n"]],
  ["W6 the owner's stores refused only where a short-lived key is refused too",
    ["dist/server.js", "    if (householdOwnerStore(method, path))\n", "    if (householdOwnerStore(method, path) && offLimitsToShortLivedKeys(method, path) !== null)\n"]],
  ["W7 householdOwnerStore: any route with the same method counts",
    ["dist/household-routes.js", "householdOwnerStores.find((route) => route.method === verb && route.pattern.test(path))", "householdOwnerStores.find((route) => route.method === verb)"]],
  ["W8 the household check applied to the owner as well", ["dist/server.js", "            if (!app.store.profiles.isOwner()) {\n", "            if (true) {\n"]],
  ["W9 chart.js: Save to Library drawn for a household person", ["public/app/chat/chart.js", "const saveBtn = ownerHere() ?", "const saveBtn = true ?"]],
  ["W10 diagram.js: Save to Library drawn for a household person", ["public/app/chat/diagram.js", "  if (!ownerHere()) return \"\";\n", ""]],
];

const results = [];
for (const [name, ...changes] of M) {
  const originals = new Map();
  for (const [file] of changes) if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
  const edited = new Map(originals);
  for (const [file, from, to] of changes) {
    const text = edited.get(file);
    if (text.split(from).length !== 2) throw new Error(`${name}: pattern not found exactly once in ${file}`);
    edited.set(file, text.replace(from, to));
  }
  let run;
  try {
    for (const [file, text] of edited) writeFileSync(file, text);
    run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=180000", "tests/q262-household-writes.test.mjs"], { encoding: "utf8" });
  } finally {
    for (const [file, text] of originals) {
      writeFileSync(file, text);
      if (hash(readFileSync(file, "utf8")) !== hash(text)) throw new Error(`${file} not restored`);
    }
  }
  const red = [...new Set((run.stdout + run.stderr).split("\n").filter((line) => /^✖ /.test(line) && !/failing tests/.test(line)))];
  results.push(`${red.length ? "RED  " : "GREEN"} ${name}\n${red.map((line) => `      ${line.replace(/ \(\d+(\.\d+)?ms\)$/, "")}`).join("\n")}`);
}
console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("GREEN")) ? 1 : 0);
