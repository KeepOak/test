import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * mac7/hardening-3: reliability and safety fixes found in reviews (docs/agents/STATUS-hardening-3.md).
 * Nothing here opens a window or starts a real model: every model is a scripted fake.
 */

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-hardening-3-"));
  const provider = options.provider ?? { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
    ...(options.reliability ? { reliability: options.reliability } : {}),
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { app, root, workspace };
}
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
const eventsOf = (app, run, kind) => app.store.events(run.id).filter((event) => event.kind === kind);
/** "Never allow anything under finance": the owner's folder rule, the one a renamed key must not walk past. */
async function financeRule(app, decision = "deny") {
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "*", match: "*", decision, remember: "always", resource: { kind: "path", pattern: "finance" } });
}

// ------------------------------------------------------------------ 1. rules see what the tool uses

test("1 runArgs: the arguments as the tool will run with them — mapped names, trimmed text, filled defaults", async (t) => {
  const { app } = await fixture(t);
  assert.deepEqual(app.registry.runArgs("files.edit", { file_path: "finance/a.txt", old_string: "x", new_string: "y" }),
    { path: "finance/a.txt", find: "x", replace: "y", expectedOccurrences: 1, replaceAll: false });
  const bad = { path: 5 };
  assert.equal(app.registry.runArgs("files.read", bad), bad, "a call that does not parse is judged as it was sent");
  assert.equal(app.registry.runArgs("no.such.tool", bad), bad);
  assert.equal(app.registry.targetOf("files.edit", { file_path: "finance/a.txt", old_string: "x", new_string: "y" }, {}), "finance/a.txt");
});

test("1 a folder rule cannot be walked past by a name the tool maps (file_path for path)", async (t) => {
  const provider = scripted([call("files.edit", { file_path: "finance/q1.txt", old_string: "10", new_string: "99" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), "10\n");
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "change it" });
  assert.equal(await readFile(join(workspace, "finance", "q1.txt"), "utf8"), "10\n", "the file was not changed");
  const [denied] = eventsOf(app, run, "policy.denied");
  assert.equal(denied?.data.target, "finance/q1.txt");
});

test("1 a folder rule covers a tool whose file is called `file` (documents.analyse)", async (t) => {
  const provider = scripted([call("documents.analyse", { file: "finance/report.md", question: "what is the total?" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "report.md"), "# Report\n\nThe total is 12.\n");
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "read it" });
  const [denied] = eventsOf(app, run, "policy.denied");
  assert.equal(denied?.data.target, "finance/report.md");
  assert.equal(eventsOf(app, run, "tool.completed").length, 0, "nothing was read");
  // The same for a folder added to a knowledge base, whose path sits inside `source`.
  assert.equal(app.registry.targetOf("knowledge.add", { collection: "notes", source: { kind: "folder", path: " finance " } }, {}), "finance");
  // And for a document edited into a new file: the file written (`saveAs`) is what the rule sees.
  assert.equal(app.registry.targetOf("documents.edit", { path: "public/a.docx", changes: [{ op: "replace-text", find: "a", replaceWith: "b" }], saveAs: " finance/leak.docx " }, {}), "finance/leak.docx");
});

test("1 the question shows the call as it will run: the mapped name, not the one sent; the yes stays bound to what was sent", async (t) => {
  const sent = { file_path: "finance/q1.txt", old_string: "10", new_string: "99" };
  const provider = scripted([call("files.edit", sent), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), "10\n");
  await financeRule(app, "ask");
  const { argumentFingerprint } = await import("../dist/runtime.js");
  const run = await app.runtime.run({ prompt: "change it" });
  assert.equal(run.status, "needs_input");
  const [question] = eventsOf(app, run, "policy.ask");
  assert.equal(question.data.target, "finance/q1.txt");
  assert.equal(JSON.parse(question.data.bytes).path, "finance/q1.txt");
  assert.equal(question.data.fingerprint, argumentFingerprint("files.edit", JSON.stringify(sent)));
});

test("1 trying a tool by hand and another AI tool's dry run judge the call as the tool will run it", async (t) => {
  const { app, workspace } = await fixture(t);
  await financeRule(app);
  const { dryRunPlan } = await import("../dist/mcp-policy.js");
  const plan = dryRunPlan(app.registry, app.store, "local", workspace, { name: "files.edit",
    arguments: { file_path: "finance/q1.txt", old_string: "10", new_string: "99" } });
  assert.equal(plan.target, "finance/q1.txt");
  assert.equal(plan.decision, "deny");
});

// ------------------------------------------------------------------ 2. the loop guard compares cleaned calls

test("2 the loop guard sees a call that only changes a junk key each round as the same call", async (t) => {
  const steps = [];
  for (let round = 0; round < 8; round++) steps.push(call("files.read", { path: "a.txt", [`junk${round}`]: round }));
  steps.push(say("done"));
  const provider = scripted(steps);
  const { app, workspace } = await fixture(t, { provider });
  await writeFile(join(workspace, "a.txt"), "hello\n");
  const { saveLoopGuardSettings } = await import("../dist/loop-guard.js");
  saveLoopGuardSettings(app.store, "local", { mode: "on" });
  const run = await app.runtime.run({ prompt: "read it" });
  assert.ok(eventsOf(app, run, "loop.warned").length + eventsOf(app, run, "loop.blocked").length > 0,
    "the repeats were noticed although the junk key changed every time");
  assert.ok(eventsOf(app, run, "loop.blocked").length > 0, "and the repeated call was refused");
});

// ------------------------------------------------------------------ 3. a hung model on this computer

/** An OpenAI-shaped server on this computer that never says anything; counts the requests it gets. */
async function silentLocalServer(t) {
  const { createServer } = await import("node:http");
  const seen = { requests: 0 };
  const server = createServer((request, response) => { seen.requests++; request.resume(); response.on("close", () => undefined); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, seen };
}

test("3 a model on this computer that never starts answering is tried again once, briefly, then the task says what to try", async (t) => {
  const { app } = await fixture(t);
  const { OpenAIProvider } = await import("../dist/providers.js");
  const { endpoint, seen } = await silentLocalServer(t);
  const provider = new OpenAIProvider({ endpoint, model: "m", apiKey: "local" });
  /* Counted where the runtime asks as well as where the server hears: the second try is cut off after
     the 100 ms grace, which can end before its request reaches the stand-in. */
  const asked = { times: 0 };
  const complete = provider.complete.bind(provider);
  provider.complete = (request) => { asked.times++; return complete(request); };
  app.runtime.models.register({ id: "on-this-computer", name: "Local", model: "m", provider });
  /* Shortened for the test (shipped: 60 s and 300 s, grace 30 s): a 3 s first-reply wait, grace 300 ms.
     ci-flakes-4: it was a 1 s wait and a 100 ms grace, which left the clock check below only about
     600 ms for everything else the run does, and a crawling Windows machine used more than that
     (2570 ms). The waits are longer so the room is, without changing what is being proved: a retry
     given a whole first-reply wait instead of the grace still lands far past the bound. */
  app.runtime.reliability.modelStallMs = 300;
  app.runtime.reliability.localFirstReplyMs = 3000;
  /* A busy computer: the event loop is held for longer than the grace just before the wait runs out, so
     the silence is noticed late. The retry used to be skipped then (trunk d366b45f, Linux: asked once). */
  setTimeout(() => { const until = Date.now() + 500; while (Date.now() < until); }, 2900);
  const run = await app.runtime.run({ prompt: "hi", model: "on-this-computer", onTextDelta: () => undefined });
  assert.equal(run.status, "failed");
  assert.match(run.output ?? "", /model on this computer didn't start answering/);
  assert.match(run.output ?? "", /smaller model/);
  assert.equal(asked.times, 2, "asked once, and tried again once");
  assert.ok(seen.requests >= 1, "the first request reached the model's server");
  const recoveries = app.store.events(run.id).filter((event) => event.kind === "model.stall_recovery").map((event) => event.data);
  assert.deepEqual(recoveries.map((one) => one.action), ["retry", "fail"]);
  assert.equal(recoveries[0].waitMs, 300, "the retry waits the grace, however late the silence was noticed");
  assert.equal(recoveries[1].afterMs, 300, "the retry uses the grace cap, not another full first-reply wait");
});

test("3 the grace is a tenth of the first-reply wait, at most 30 seconds", async () => {
  const { localFirstReplyGraceMs } = await import("../dist/reliability.js");
  assert.equal(localFirstReplyGraceMs(300_000), 30_000);
  assert.equal(localFirstReplyGraceMs(1_800_000), 30_000);
  assert.equal(localFirstReplyGraceMs(60_000), 6_000);
});

// ------------------------------------------------------------------ 4. code.rename reads first

/** A scripted model, the fake language server switched on, and read-before-edit set to `mode`. */
async function renameFixture(t, steps, mode) {
  const { fileURLToPath } = await import("node:url");
  const { saveLanguageServerSettings } = await import("../dist/index.js");
  const { saveCodingMode } = await import("../dist/coding/settings.js");
  const made = await fixture(t, { provider: scripted(steps) });
  const fake = join(fileURLToPath(import.meta.url), "..", "fixtures", "fake-language-server.mjs");
  await saveLanguageServerSettings(made.app.store, "local", {
    enabled: true, servers: { fake: { path: process.execPath, args: [fake], languages: ["TypeScript"] } }, timeoutMs: 10000 });
  t.after(() => made.app.languageServers.stopAll());
  saveCodingMode(made.app.store, "local", "read-first", mode);
  await mkdir(join(made.workspace, "src"), { recursive: true });
  await writeFile(join(made.workspace, "src", "sums.ts"), "export const total = 1;\nconsole.log(total);\n");
  return made;
}
const rename = call("code.rename", { path: "src/sums.ts", line: 1, character: 14, newName: "grandTotal" });
const toolAnswers = (app, run) => app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));

test("4 read-first on: code.rename of a file the task has not read is refused, and nothing is written", async (t) => {
  const { app, workspace } = await renameFixture(t, [rename, say("done")], "on");
  const run = await app.runtime.run({ prompt: "rename it" });
  const [answer] = toolAnswers(app, run);
  assert.equal(answer.ok, false);
  assert.match(answer.error, /read/i);
  assert.equal(await readFile(join(workspace, "src", "sums.ts"), "utf8"), "export const total = 1;\nconsole.log(total);\n");
});

test("4 read-first on: after the file is read, code.rename goes through; with the switch off it goes through as before", async (t) => {
  const read = call("files.read", { path: "src/sums.ts" });
  const on = await renameFixture(t, [read, rename, say("done")], "on");
  const run = await on.app.runtime.run({ prompt: "rename it" });
  assert.equal(toolAnswers(on.app, run)[1].ok, true, JSON.stringify(toolAnswers(on.app, run)[1]));
  assert.match(await readFile(join(on.workspace, "src", "sums.ts"), "utf8"), /grandTotal/);
  const off = await renameFixture(t, [rename, say("done")], "off");
  const plain = await off.app.runtime.run({ prompt: "rename it" });
  assert.equal(toolAnswers(off.app, plain)[0].ok, true);
});

// ------------------------------------------------------------------ 5. the malware check reads to the end

/** A stand-in for OSV that always has one more page and never names malware; counts the pages. */
function endlessOsv(malwareOnPage = null) {
  const seen = { pages: 0 };
  const fetcher = async () => {
    seen.pages++;
    const vulns = seen.pages === malwareOnPage ? [{ id: "MAL-2026-1", summary: "bad" }] : [{ id: "GHSA-1" }];
    return new Response(JSON.stringify({ vulns, next_page_token: `p${seen.pages}` }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetcher, seen };
}

test("5 an answer longer than ten pages is 'not checked', never clean", async (t) => {
  const { malwareAdvisories, MalwareCheck } = await import("../dist/security-audit/index.js");
  const endless = endlessOsv();
  await assert.rejects(malwareAdvisories({ ecosystem: "npm", name: "huge", version: null }, endless.fetcher, "https://osv.test/v1/query"),
    /more than 10 pages .* huge was not checked/);
  assert.equal(endless.seen.pages, 10);
  // Malware found in what was read still refuses.
  const listed = endlessOsv(3);
  assert.deepEqual(await malwareAdvisories({ ecosystem: "npm", name: "huge", version: null }, listed.fetcher, "https://osv.test/v1/query"),
    [{ id: "MAL-2026-1", summary: "bad" }]);
  // The check before an outside server starts says so plainly, and does not keep it as a clean answer.
  const check = new MalwareCheck({ mode: () => "on", fetch: () => endlessOsv().fetcher, endpoint: "https://osv.test/v1/query" });
  await check.vet("npx", ["-y", "huge-mcp"]);
  assert.match(check.status().problem, /not read to the end and huge-mcp was not checked/);
  // Where the owner decides, it is not clean: an install request is "unchecked" and a plain yes is refused.
  const { app } = await fixture(t);
  app.flowsBoards.setMode("install-requests", { mode: "on" });
  const { InstallRequests } = await import("../dist/flows-boards/install-requests.js");
  const installs = new InstallRequests({ store: app.store, owner: app.runtime.owner, fetch: () => endlessOsv().fetcher, endpoint: "https://osv.test/v1/query" });
  const asked = await installs.request({ kind: "package", ecosystem: "npm", name: "huge", why: "x" }, "assistant", "the assistant");
  assert.equal(asked.check.state, "unchecked");
  assert.match(asked.check.note, /not read to the end/);
  await assert.rejects(installs.answer(asked.id, true), /did not give a full answer/);
});

// ------------------------------------------------------------------ 6. the month counts what is still being made

test("6 a video a still-running task paid for is in this month's figure, and stops new tasks at the budget", async (t) => {
  const { app } = await fixture(t);
  const store = app.store;
  const running = store.createRun("local", "make a video");
  // Written down before the video service is asked (src/reach/video.ts), while the task is still going.
  store.event(running.id, "spend.recorded", { dollars: 1.2, what: "a 12-second video (sora-2)", estimate: false });
  const month = store.usageStore().getMonthlyStats();
  assert.equal(month.estimatedCost, 1.2, "the month is not understated while the task runs");
  assert.equal(month.stillBeingMade, 1.2);
  store.save("settings", "local", "usage_budget", { maxMonthlyDollars: 1, pauseAtBudget: true });
  await assert.rejects(app.runtime.run({ prompt: "another" }), /Monthly budget reached.*\$1\.20/);
  store.finish(running.id, "completed", "made");
  const after = store.usageStore().getMonthlyStats();
  assert.equal(after.estimatedCost, 1.2, "counted once when it finishes");
  assert.equal(after.stillBeingMade, 0);
});

// ------------------------------------------------------------------ 8 and 9. accounts: names, and whose they are

/** The installed Claude Code program (a stand-in), the accounts switch on, and a second sign-in added. */
async function accountsFixture(t) {
  const { registerCliAgent } = await import("../dist/providers/cli-agent.js");
  const { accountsServiceFor } = await import("../dist/accounts/service.js");
  const { setMode, addAccount } = await import("../dist/accounts/manage.js");
  const { saveCommandSettings } = await import("../dist/commands/settings.js");
  const made = await fixture(t);
  const { app } = made;
  const service = accountsServiceFor(app.runtime.models);
  const spawn = async () => ({ code: 0, stdout: JSON.stringify({ result: "hi" }), stderr: "" });
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" });
  service.deps.spawnAgent = spawn;
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: "cli-claude-code", label: "Second" })).accounts.at(-1).id;
  return { ...made, service, second };
}

test("8 /account's one-time notice and the window name the connection alike, never by its internal id", async (t) => {
  const { app, service } = await accountsFixture(t);
  const { saveAccountsSettings } = await import("../dist/accounts/settings.js");
  const { viewAll } = await import("../dist/accounts/manage.js");
  // A second list, for the Codex program, saved while Codex is not set up on this computer right now.
  const codex = { pool: "cli-codex", kind: "cli", autoSwitch: false, accounts: [
    { id: "primary", label: "Mine", pinned: false, disabled: false, monthlyCapUsd: null, shared: false, keptSeparate: false, createdAt: "2026-09-19T10:00:00.000Z" }] };
  const settings = service.settings();
  saveAccountsSettings(app.store, app.runtime.owner, { ...settings, pools: [...settings.pools, codex], poolingNotices: ["cli-claude-code", "cli-codex"] });
  const pools = (await viewAll(service)).pools;
  assert.equal(pools.find((pool) => pool.pool === "cli-codex").name, "Codex (installed on this computer)", "the window never shows cli-codex");
  const windowName = pools.find((pool) => pool.pool === "cli-claude-code").notice.service;
  const { executeCommand } = await import("../dist/commands/execute.js");
  const host = { runtime: app.runtime, requireOwner: (what) => app.store.profiles.requireOwner(what) };
  const looked = await executeCommand(host, { surface: "dashboard", line: "/account", access: "read" });
  assert.doesNotMatch(looked.text, /cli-claude-code/);
  assert.ok(looked.text.includes(windowName), `the notice says "${windowName}"`);
});

test("9 a household person is shown none of the owner's lists: no kind, no strategy, no sign-in state", async (t) => {
  const { app, service } = await accountsFixture(t);
  const { viewAll } = await import("../dist/accounts/manage.js");
  assert.ok((await viewAll(service)).pools.some((pool) => pool.pool === "cli-claude-code"), "the owner sees the list");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const theirs = await viewAll(service);
  assert.deepEqual(theirs.pools, [], "nothing is shared with them, so there is nothing to show");
  assert.doesNotMatch(JSON.stringify(theirs), /strategy|autoSwitch|signedIn|defaultAccount|claude/i);
});

// ------------------------------------------------------------------ integration review (hardening-3)

test("Integration: \"././\" or \"a/..\" in front of a path is still the folder a rule names", async (t) => {
  const { pathMatches } = await import("../dist/policy-resources.js");
  assert.ok(pathMatches("finance", "././finance/q1.txt"));
  assert.ok(pathMatches("finance", "a/../finance/q1.txt"));
  assert.ok(pathMatches("finance", String.raw`.\finance\q1.txt`));
  assert.ok(pathMatches("./finance/", "finance//q1.txt"));
  assert.ok(!pathMatches("finance", "../finance/q1.txt"), "a path outside the workspace is not the workspace's finance folder");
  assert.ok(!pathMatches("finance", "financial/q1.txt"));
  // A file at the top of the workspace is a file, not a website, whatever dots its name has...
  const { resourceOf } = await import("../dist/policy-resources.js");
  assert.equal(resourceOf("files.write", "files.write", "q1.txt", { path: "q1.txt" })?.kind, "path");
  assert.equal(resourceOf("files.restore", "files.write", "q1.txt", { versionId: "x" })?.kind, "path");
  // ...while a file tool reading an address, and any other tool, are judged by the site as before.
  assert.equal(resourceOf("data.load", "data.read", "example.com", { url: "https://example.com/a.csv" })?.kind, "host");
  assert.equal(resourceOf("home.call", "personal.write", "light.kitchen", {})?.kind, "host");
  const provider = scripted([call("files.write", { path: "././finance/q1.txt", content: "PWNED" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), "10\n");
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "change it" });
  assert.equal(await readFile(join(workspace, "finance", "q1.txt"), "utf8"), "10\n", "the file was not written");
  assert.equal(eventsOf(app, run, "policy.denied").length, 1);
});

test("Integration: a folder rule holds while the active project's folder is inside it", async (t) => {
  const provider = scripted([call("files.write", { path: "q1.txt", content: "PWNED" }), say("done"),
    call("files.write", { path: "q1.txt", content: "fine" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), "10\n");
  await financeRule(app);
  app.store.projects.save("local", { id: "money", name: "Money", folder: "finance" });
  app.store.projects.setActive("local", { active: "money" });
  const refused = await app.runtime.run({ prompt: "change it" });
  assert.equal(await readFile(join(workspace, "finance", "q1.txt"), "utf8"), "10\n", "q1.txt in the project is finance/q1.txt");
  assert.equal(eventsOf(app, refused, "policy.denied")[0]?.data.target, "q1.txt", "the question and the card still show the path as written");
  // Another AI tool's dry run is answered for the project that is active, as the call would run.
  const { dryRunPlan } = await import("../dist/mcp-policy.js");
  assert.equal(dryRunPlan(app.registry, app.store, "local", workspace, { name: "files.write", arguments: { path: "q1.txt", content: "x" } }).decision, "deny");
  // Another project's folder is not finance, so the same path there is written as before.
  app.store.projects.save("local", { id: "garden", name: "Garden", folder: "garden" });
  app.store.projects.setActive("local", { active: "garden" });
  const allowed = await app.runtime.run({ prompt: "write it" });
  assert.equal(eventsOf(app, allowed, "policy.denied").length, 0);
  assert.equal(await readFile(join(workspace, "garden", "q1.txt"), "utf8"), "fine");
});

test("Integration: putting back a kept version is judged against the file that version belongs to", async (t) => {
  let versionId = "";
  const provider = scripted([() => ({ content: "", toolCalls: [{ id: "r1", name: "files.restore", arguments: JSON.stringify({ versionId }) }] }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); this test is about the folder rule, not reading first
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), "10\n");
  await app.runtime.executeTool("files.write", { path: "finance/q1.txt", content: "NOW" });
  versionId = (await app.runtime.executeTool("files.history", { path: "finance/q1.txt" }))[0].id;
  assert.equal(app.registry.targetOf("files.restore", { versionId }, {}), "finance/q1.txt");
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "put it back" });
  assert.equal(eventsOf(app, run, "policy.denied")[0]?.data.target, "finance/q1.txt");
  assert.equal(await readFile(join(workspace, "finance", "q1.txt"), "utf8"), "NOW", "the old version was not written back");
});
