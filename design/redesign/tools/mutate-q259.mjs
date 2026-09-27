// Q259: applies each named mutation to dist/ in turn, runs tests/q259-household-commands.test.mjs, prints which tests went
// red, and puts dist/ back (checked by hash). Run from the repo root after `npx tsc -p .`: node design/redesign/tools/mutate-q259.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const M = [
  ["S1", "dist/commands/household.js", "    if (!householdHere(store, surface))\n        return store.runs(owner);\n    const seen", "    if (true)\n        return store.runs(owner);\n    const seen"],
  ["S2", "dist/commands/household.js", ".filter((run) => startedForHere(store, run.id) && personConversation(store, owner, run.sessionId))", ".filter(() => false)"],
  ["S3", "dist/household-approvals.js", "return store.ownsSession(scope, sessionId) || (store.ownsSession(owner, sessionId) && lentOwner(store, sessionId) === scope);", "return store.ownsSession(scope, sessionId);"],
  ["S4", "dist/commands/api.js", "!mayUseConversation(app.store, app.runtime.owner, input.surface, input.sessionId)", "!app.store.ownsSession(app.runtime.owner, input.sessionId)"],
  ["S5", "dist/commands/execute.js", "    const notTheirs = householdCommandRefusal(host.runtime.store, input.surface, name, argument);", "    const notTheirs = null;"],
  ["S6", "dist/commands/execute.js", "    if (!parsed && householdHere(host.runtime.store, input.surface))\n        return promptsLine", "    if (false)\n        return promptsLine"],
  ["S7", "dist/commands/household.js", "    return atWindow(surface) && !store.profiles.isOwner();", "    return !store.profiles.isOwner();"],
  ["S8", "dist/commands/handlers.js", "runsHere(store, owner, call.surface).map((run) => run.sessionId)", "store.runs(owner).map((run) => run.sessionId)"],
  ["S8b", "dist/commands/handlers.js", "found && mayUseConversation(store, owner, call.surface, found)", "found && store.ownsSession(owner, found)"],
  ["S9", "dist/commands/status.js", "    if (!householdHere(store, call.surface))\n        lines.push(`When to check with you", "    if (true)\n        lines.push(`When to check with you"],
  ["S10", "dist/commands/handlers.js", "    if (householdHere(runtime.store, call.surface))\n        return say(lines.length", "    if (false)\n        return say(lines.length"],
  ["S11", "dist/commands/handlers.js", "const owner = householdHere(store, call.surface) ? store.profiles.scope() : call.host.runtime.owner;", "const owner = call.host.runtime.owner;"],
  ["S12", "dist/server.js", "policy: app.store.profiles.isOwner() ? readPolicy(app.store, app.runtime.owner) : null", "policy: readPolicy(app.store, app.runtime.owner)"],
  ["S13", "dist/misc-api.js", "categories: app.store.profiles.isOwner() ? decisionsFromRules(app.registry, readPolicy(app.store, owner).rules) : []", "categories: decisionsFromRules(app.registry, readPolicy(app.store, owner).rules)"],
  ["S14", "dist/misc-api.js", "    if (!app.store.profiles.isOwner())\n        return ownAudit(app, query);", ""],
  ["S15", "dist/misc-api.js", "const entries = household ? ownAudit(app, query).entries : app.store.audit.list(owner, query);", "const entries = app.store.audit.list(owner, query);"],
  ["S16", "dist/server.js", "        if (!app.store.profiles.isOwner())\n            return { data: app.store.usageStore().aggregateUsage(range, by, overrides, ownConversationOf(app))", "        if (false)\n            return { data: app.store.usageStore().aggregateUsage(range, by, overrides, ownConversationOf(app))"],
  ["S17", "dist/prompt-library-api.js", "(store.profiles.isOwner() ? listPrompts(store, owner) : [])", "listPrompts(store, owner)"],
  ["S18", "dist/server.js", "const run = app.store.run(inspectMatch[1]);\n        if (!run || run.owner !== app.store.profiles.scope())", "const run = app.store.run(inspectMatch[1]);\n        if (!run || run.owner !== app.runtime.owner)"],
  ["S19", "dist/server.js", "        app.store.profiles.requireOwner(\"Doing a task again\");\n", ""],
  ["S20", "dist/server.js", "        const scope = app.store.profiles.scope();\n        if (!app.store.ownsSession(scope, sessionId))\n            throw new HttpError(404, \"Conversation not found\");\n        const view = app.store.sessionView(scope, sessionId);", "        const scope = app.runtime.owner;\n        if (!app.store.ownsSession(scope, sessionId))\n            throw new HttpError(404, \"Conversation not found\");\n        const view = app.store.sessionView(scope, sessionId);"],
  // Q261: reading fails closed now, so "not refused" means listed as a household read (dist/household-routes.js).
  ["S21", "dist/household-routes.js", "    read(\"/api/release-notes\", \"what is new in this version\"),\n", "    read(\"/api/release-notes\", \"what is new in this version\"),\n    read(\"/api/agents/pairing\", \"mutation\"),\n"],
  ["S22", "dist/cli-run.js", "    if (lockdownActive(store, owner))\n        throw new Error(lockdownSettingsRefusal);\n    const before = readPolicy(store, owner);", "    const before = readPolicy(store, owner);"],
  ["S23", "dist/cli-run.js", "options.confirm === true, options.tools,", "true, options.tools,"],
  ["S24", "dist/terminal-cli.js", "choosePreset(app.runtime, args.join(\" \"), (name) => `Run branch permissions ${name} confirm to go ahead.`)", "choosePreset(app.runtime, args.join(\" \"))"],
  ["S25", "dist/commands/api.js", "const saved = surface === \"dashboard\" || householdHere(app.store, surface) ? []", "const saved = surface === \"dashboard\" ? []"],
  ["S26", "dist/server.js", "/trace does).\n        if (!run || run.owner !== app.store.profiles.scope())", "/trace does).\n        if (!run || run.owner !== app.runtime.owner)"],
  ["S27", "dist/household-routes.js", "    read(\"/api/release-notes\", \"what is new in this version\"),\n", "    read(\"/api/release-notes\", \"what is new in this version\"),\n    read(\"/api/brief\", \"mutation\"),\n    read(\"/api/research\", \"mutation\"),\n"],
  ["S26b", "dist/server.js", "const run = app.store.run(trajectory[1]);\n        if (!run || run.owner !== app.store.profiles.scope())", "const run = app.store.run(trajectory[1]);\n        if (!run || run.owner !== app.runtime.owner)"],
];
// Some mutations are two edits made together for one run.
const groups = { S8: ["S8", "S8b"], S26: ["S26", "S26b"] };
const skip = new Set(["S8b", "S26b"]);
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
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=60000", "tests/q259-household-commands.test.mjs"], { encoding: "utf8" });
  for (const [file, text] of originals) { writeFileSync(file, text); if (hash(readFileSync(file, "utf8")) !== hash(text)) throw new Error(`${file} not restored`); }
  const red = (run.stdout + run.stderr).split("\n").filter((line) => /^✖ /.test(line) && !/failing tests/.test(line));
  const unique = [...new Set(red)];
  results.push(`${unique.length ? "RED  " : "GREEN"} ${name}\n${unique.map((line) => `      ${line.replace(/ \(\d+(\.\d+)?ms\)$/, "")}`).join("\n")}`);
}
console.log(results.join("\n"));
