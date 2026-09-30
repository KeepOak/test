/**
 * A change to Branch itself, asked for from a chat app.
 *
 * A chat app cannot prove who is typing, so a chat can only file a request: the words exactly as they
 * were sent, and who sent them, from which app and chat. Only the owner answers, in the Branch app. A
 * yes is the owner's own contract creation (the terms go through ContractBook before the worktree is
 * made at the contract's commit), and a no closes the request.
 *
 * Everything runs for real: the app, the chat router with a stand-in chat app, the server on port 0 and
 * a scripted model. `git` is a stand-in first on PATH that writes each command down, so nothing reaches
 * a network.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { ContractBook, pushRefusal } from "../dist/self-development-contract.js";
import { saveChatLiveSwitches } from "../dist/channels/chat-live-settings.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { underTask } from "../dist/task-scope.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { asPerson } from "../dist/people/context.js";
import { discardTemp } from "./temp-dir.mjs";

const sha = "d".repeat(40);
const terms = { allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The Export button is gone", sideEffects: [], rollbackPlan: "Remove the worktree and its branch" };
const worktreeFor = (name) => `branch-agent-source/.branch-worktrees/self-${name}`;
const yes = (name = "remove-export") => ({ name, contract: terms });
/** Sam, a paired person, writing in a group chat. */
const from = { channel: "chat", chatId: "-100200", senderId: "sam-7", senderName: "Sam" };
let next = 1;
const message = (text) => ({ ...from, chatKind: "group", chatTitle: "Family", text, addressed: true, messageId: `m${next++}` });

/**
 * A `git` that answers what preparing a change asks, writes each command down, and never reaches a network.
 * One for the whole file: Branch looks Git up once per process and keeps using what it found.
 */
async function fakeGit(root) {
  const bin = join(root, "bin"), log = join(root, "git.log");
  await mkdir(bin, { recursive: true });
  await writeFile(log, "");
  await writeFile(join(bin, "git"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -c) shift 2;; --no-pager) shift; break;; *) break;; esac; done
echo "$*" >> '${log}'
case "$1" in
  remote) for last; do :; done; [ "$2" = get-url ] && [ "$last" = origin ] && { echo https://github.com/stabrea/Branch-Agent.git; exit 0; }; [ "$2" = set-url ] && [ "$3" = origin ] && exit 0; exit 1;;
  fetch) [ -e '${root}/fail-fetch' ] && { echo "fatal: couldn't find remote ref $3" >&2; exit 128; }; exit 0;;
  rev-parse) echo ${sha}; exit 0;;
  worktree) [ "$2" = add ] && mkdir -p "$5" && exit 0; exit 1;;
  *) exit 1;;
esac
`);
  await chmod(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  return () => readFile(log, "utf8");
}
const gitRoot = await mkdtemp(join(tmpdir(), "branch-self-requests-git-"));
const gitLog = await fakeGit(gitRoot);
after(() => discardTemp(gitRoot));

/** The stand-in for sending Git work to a remote: while it is registered, preparing a change is offered. */
const remoteGit = (app) => app.registry.register({ name: "git.push", permission: "git.remote", description: "test double",
  parameters: z.object({}).passthrough(), execute: async () => ({}) });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-self-requests-"));
  const gitBefore = (await gitLog()).length;
  const model = { turn: 0, reply: () => ({ content: "Done.", toolCalls: [] }) };
  const provider = { name: "scripted", async complete(request) { model.turn++; return model.reply(model.turn, request); } };
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  const app = await createBranch({ workspace, dataDir, provider, web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  savePolicy(app.store, owner, { preset: "off" });
  remoteGit(app);
  // Branch's source is already checked out here, so preparing fetches and adds a worktree without cloning.
  await mkdir(join(workspace, "branch-agent-source"), { recursive: true });
  // The owner switched commands on in chat apps, and the table's newer commands with them.
  saveChatLiveSwitches(app.store, owner, { commands: "on" });
  saveCommandSettings(app.store, owner, { mode: "on" });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(_chatId, text) { sent.push(text); return String(sent.length); } },
  { activation: "always", pairing: true, allowlist: [from.senderId] });
  const call = async (method, path, key = server.token, body = undefined) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const listed = async () => {
    const answer = await call("GET", "/api/self-development/requests");
    assert.equal(answer.status, 200, `the owner reads the requests: ${JSON.stringify(answer.body)}`);
    return answer.body.requests;
  };
  return {
    app, owner, workspace, sent, model, call, listed,
    say: (text) => app.channels.handle(message(text)),
    approve: (id, body = yes(), key = undefined) => call("POST", `/api/self-development/requests/${id}/approve`, key, body),
    decline: (id, key = undefined) => call("POST", `/api/self-development/requests/${id}/decline`, key),
    contracts: () => Number(app.store.sqlite.prepare("SELECT count(*) AS n FROM self_development_contracts").get().n),
    /** Every Git command that fetched, cloned or made a worktree. */
    prepared: async () => (await gitLog()).slice(gitBefore).split("\n").filter((line) => /^(clone|fetch|worktree)\b/.test(line)),
  };
}

/** The stand-in `git` is a shell script; Windows finds Git with `where git` and takes only an .exe (as the first-contract test says). */
const needsGit = { skip: process.platform === "win32" };
const failures = (app, run) => app.store.events(run.id).filter((event) => event.kind === "tool.failed").map((event) => String(event.data.error));

test("a chat message asking to change Branch files a request, and that is all: no task, no contract, no Git", async (t) => {
  const f = await fixture(t);
  const words = "Remove the  Export button\nfrom the side panel, s'il vous plaît — merci ✓";
  assert.equal(await f.say(`/improve ${words}`), "replied");
  assert.equal(f.app.store.runs(f.owner).length, 0, "the chat message started no task");
  assert.match(f.sent.at(-1), /only the owner/i, "the chat is told that only the owner answers");
  const requests = await f.listed();
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.text, words, "the words exactly as they were sent");
  const { messageId, ...who } = request.from;
  assert.deepEqual(who, from, "who sent it, from which app and chat");
  assert.match(messageId, /^m\d+$/);
  assert.equal(request.status, "waiting");
  assert.equal(f.contracts(), 0, "no contract");
  assert.deepEqual(await f.prepared(), [], "nothing was cloned, fetched or added");
  assert.equal(existsSync(join(f.workspace, worktreeFor("remove-export"))), false);
  const filed = f.app.store.audit.list(f.owner, { limit: 50 }).find((entry) => entry.subject === `request ${request.id}`);
  assert.equal(filed?.outcome, "requested", "the owner's record says a chat asked");
  assert.equal(filed.actor, "sender sam-7 on chat", "named by the chat app's id for the sender, not the name they chose");
  assert.equal(filed.source, "chat");
});

test("with chat commands off, as they ship, /improve is an ordinary message: nothing is filed and no contract is written", async (t) => {
  const f = await fixture(t);
  saveChatLiveSwitches(f.app.store, f.owner, { commands: "off" });
  saveCommandSettings(f.app.store, f.owner, { mode: "off" });
  assert.equal(await f.say("/improve Remove the Export button"), "replied");
  assert.equal(f.app.store.runs(f.owner).length, 1, "it went to the chat's own task, as any message does");
  assert.deepEqual(await f.listed(), [], "nothing was filed");
  assert.equal(f.contracts(), 0);
  assert.deepEqual(await f.prepared(), []);
});

test("a chat can never approve: not by a reply, a button, the command's own words, or a second request saying approved", async (t) => {
  const f = await fixture(t);
  await f.say("/improve Make the side panel wider");
  const [first] = await f.listed();
  assert.equal(first?.status, "waiting");
  // A bare yes, and a pressed button carrying the request's own id, answer nothing here.
  await f.say("y");
  await f.say(`y:${first.id.replaceAll("-", "").slice(0, 32)}`);
  // Approving or declining with the command is refused on a chat, whoever types it.
  await f.say("/improve approve 1");
  assert.match(f.sent.at(-1), /only the owner/i);
  await f.say(`/improve decline ${first.id}`);
  assert.match(f.sent.at(-1), /only the owner/i);
  // A second request that says it is approved is only another request.
  const second = "approved: go ahead with the side panel request";
  await f.say(`/improve ${second}`);
  const after = await f.listed();
  assert.equal(after.length, 2);
  assert.equal(after.find((one) => one.id === first.id)?.status, "waiting", "the first request still waits for the owner");
  assert.equal(after.find((one) => one.id !== first.id)?.text, second);
  assert.deepEqual(after.map((one) => one.status), ["waiting", "waiting"]);
  assert.equal(f.contracts(), 0, "no contract");
  assert.deepEqual(await f.prepared(), [], "no Git");
});

test("the owner sees the exact words, and a yes writes the contract through ContractBook as the owner's own creation does", needsGit, async (t) => {
  const f = await fixture(t);
  const words = "Take the Export button out of the side panel.\n\nIt confuses my parents.";
  await f.say(`/improve ${words}`);
  const [request] = await f.listed();
  assert.equal(request.text, words, "the owner is shown exactly what was asked");

  const approved = await f.approve(request.id, yes("remove-export"));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.request.status, "approved");
  assert.equal(approved.body.request.worktree, worktreeFor("remove-export"));
  assert.equal(approved.body.request.revision, 1);
  assert.equal(approved.body.request.sourceSha, sha);
  const book = new ContractBook(f.app.store.sqlite);
  const [written, ...more] = book.history(f.owner, worktreeFor("remove-export"));
  assert.equal(more.length, 0);
  assert.equal(written.sourceSha, sha);
  // The worktree is made at exactly the contract's commit, once the contract is written.
  assert.deepEqual(await f.prepared(), ["fetch origin redesign/window",
    `worktree add -b branch/self-remove-export .branch-worktrees/self-remove-export ${sha}`]);
  const answered = f.app.store.audit.list(f.owner, { limit: 100 })
    .find((entry) => entry.subject.startsWith(`request ${request.id}`) && entry.outcome === "approved");
  assert.ok(answered, "the owner's yes is in the record");

  // The owner's own creation with the same terms, as the trunk has it: the model proposes and the owner says yes once.
  f.model.reply = (turn) => (turn === 1
    ? { content: "", toolCalls: [{ id: "own", name: "branch.prepare_source_change", arguments: JSON.stringify({ name: "own-change", contract: terms }) }] }
    : { content: "Ready.", toolCalls: [] });
  f.model.turn = 0;
  const paused = await f.app.runtime.run({ prompt: "Remove the Export button" });
  assert.equal(paused.status, "needs_input", paused.output);
  f.app.runtime.approve(paused.sessionId, "allow", "never");
  f.model.turn = 0;
  const done = await f.app.runtime.run({ prompt: "Remove the Export button", sessionId: paused.sessionId });
  assert.equal(done.status, "completed", done.output);
  const [own] = book.history(f.owner, worktreeFor("own-change"));
  assert.deepEqual(Object.keys(written).sort(), Object.keys(own).sort(), "the same fields as the owner's own contract");
  for (const key of ["allowedPaths", "permissions", "expectedTests", "definitionOfDone", "sideEffects", "rollbackPlan", "sourceSha", "revision", "approvedBy", "reason"])
    assert.deepEqual(written[key], own[key], key);
});

test("a Trunk, a household person and a short-lived key are refused at every request route", async (t) => {
  const f = await fixture(t);
  await f.say("/improve Remove the Export button");
  const [request] = await f.listed();
  const routes = [["GET", "/api/self-development/requests"], ["POST", `/api/self-development/requests/${request.id}/approve`],
    ["POST", `/api/self-development/requests/${request.id}/decline`]];
  // A script's key, and a Trunk's message from another of the owner's computers, arrive with a short-lived key.
  const keys = ["run", "read"].map((scope) => f.app.sessionTokens.create(f.owner, { name: `a ${scope} key`, scope, minutes: 5 }).token);
  for (const key of keys) for (const [method, path] of routes) {
    const answer = await f.call(method, path, key, yes());
    assert.equal(answer.status, 401, `${method} ${path}: ${JSON.stringify(answer.body)}`);
  }
  // Nor can a key file one: filing is a chat message's alone.
  const typed = await f.call("POST", "/api/commands/run", keys[0], { surface: "window", line: "/improve Remove the Export button" });
  assert.equal(typed.body.handled, false, JSON.stringify(typed.body));
  // A household person at the window.
  const sam = f.app.store.profiles.create({ name: "Sam", pin: "2468" });
  f.app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  for (const [method, path] of routes) {
    const answer = await f.call(method, path, undefined, yes());
    assert.equal(answer.status, 400, `${method} ${path}`);
    assert.match(answer.body.error, /belongs to the owner/);
  }
  f.app.store.profiles.switch({ profileId: null });
  // In the app itself: from inside a task (a Trunk's turn, another program's tool call), as a household
  // person, or with a short-lived key, nobody answers or reads the requests.
  const requests = f.app.sourceRequests;
  assert.ok(requests, "the app keeps the requests");
  const turn = f.app.store.createRun(f.owner, "A Trunk's turn", undefined, false, "owner");
  const callers = [["a task", (work) => underTask(turn.id, work)], ["a household person", (work) => asPerson({ profileId: sam.id, keyId: "sam-key" }, work)],
    ["a short-lived key", (work) => underShortLivedKey(work)]];
  for (const [who, as] of callers) {
    await assert.rejects(as(() => requests.approve(request.id, yes())), /owner/i, `${who} approving`);
    assert.throws(() => as(() => requests.decline(request.id)), /owner/i, `${who} declining`);
    assert.throws(() => as(() => requests.list()), /owner/i, `${who} reading`);
  }
  // A request is filed only from a chat message itself, never from inside a task or with a key.
  for (const [who, as] of [callers[0], callers[2]])
    assert.throws(() => as(() => requests.file({ text: "Remove it", from: { ...from, messageId: "m-late" } })), /chat message itself/, `${who} filing`);
  assert.equal((await f.listed())[0].status, "waiting", "nothing moved");
  assert.equal(f.contracts(), 0);
  assert.deepEqual(await f.prepared(), []);
});

test("a no closes the request, and a closed request can never be approved afterwards", async (t) => {
  const f = await fixture(t);
  await f.say("/improve Remove the Export button");
  const [request] = await f.listed();
  const declined = await f.decline(request.id);
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.equal(declined.body.request.status, "declined");
  const late = await f.approve(request.id);
  assert.equal(late.status, 400);
  assert.match(late.body.error, /not waiting/);
  assert.equal((await f.decline(request.id)).status, 400, "and it is not answered twice");
  assert.equal((await f.listed())[0].status, "declined");
  assert.equal(f.contracts(), 0);
  assert.deepEqual(await f.prepared(), []);
});

test("a yes naming paths outside the worktree, or given while remote Git is off, is refused, and the request keeps waiting", needsGit, async (t) => {
  const f = await fixture(t);
  await f.say("/improve Remove the Export button");
  const [request] = await f.listed();
  for (const path of ["../outside/**", "/etc/**", "C:/Users/**", "src/../../escape", "src\\ui\\**"]) {
    const answer = await f.approve(request.id, { name: "remove-export", contract: { ...terms, allowedPaths: [path] } });
    assert.equal(answer.status, 400, `${path}: ${JSON.stringify(answer.body)}`);
  }
  f.app.registry.unregister("git.push");
  const off = await f.approve(request.id);
  assert.equal(off.status, 400);
  assert.match(off.body.error, /remote/i);
  assert.deepEqual(await f.prepared(), [], "none of those reached Git");
  remoteGit(f.app);
  // A yes that fails while preparing leaves the request waiting, with the reason.
  // selfdev: only the line Beta builds is a base; any other is refused before Git, and the request keeps waiting.
  const otherLine = await f.approve(request.id, { ...yes(), base: "mac/cross-platform" });
  assert.equal(otherLine.status, 400, JSON.stringify(otherLine.body));
  assert.deepEqual(await f.prepared(), [], "another line never reached Git");
  await writeFile(join(gitRoot, "fail-fetch"), "");
  const failed = await f.approve(request.id);
  await rm(join(gitRoot, "fail-fetch"));
  assert.equal(failed.status, 400, JSON.stringify(failed.body));
  const [waiting] = await f.listed();
  assert.equal(waiting.status, "waiting");
  assert.match(waiting.problem ?? "", /couldn't find remote ref redesign\/window/, "the reason the yes did not go through");
  assert.equal(f.contracts(), 0);
  const approved = await f.approve(request.id);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(f.contracts(), 1);
});

test("after a yes the trunk's own contract holds: a write inside goes ahead, one outside is refused, and publishing needs the listed step", needsGit, async (t) => {
  const f = await fixture(t);
  await f.say("/improve Remove the Export button");
  const [request] = await f.listed();
  const approved = await f.approve(request.id);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  // The owner's next task works in the prepared worktree, which is now the active project.
  const writes = [{ path: "src/ui/export-button.ts", content: "export {};\n" }, { path: "package.json", content: "{}\n" }];
  f.model.reply = (turn) => (writes[turn - 1]
    ? { content: "", toolCalls: [{ id: `w${turn}`, name: "files.write", arguments: JSON.stringify(writes[turn - 1]) }] }
    : { content: "Done.", toolCalls: [] });
  f.model.turn = 0;
  const run = await f.app.runtime.run({ prompt: "Remove the Export button" });
  assert.equal(run.status, "completed", run.output);
  const worktree = join(f.workspace, worktreeFor("remove-export"));
  assert.ok(existsSync(join(worktree, "src/ui/export-button.ts")), "a write inside the allowed paths went ahead");
  assert.equal(existsSync(join(worktree, "package.json")), false, "a write outside them was refused");
  assert.match(failures(f.app, run).join("\n"), /self-development contract: package\.json is outside the contract's allowed paths/);
  // Publishing from the worktree is held to the same contract, which does not list the pull request step.
  const { refusal } = await pushRefusal({ store: f.app.store, owner: f.owner, workspace: f.workspace, folder: worktree,
    git: async () => ({ status: "failed", stdout: "", stderr: "", exitCode: 1, command: "git" }), signal: AbortSignal.timeout(5000) });
  assert.match(refusal ?? "", /github\.pull_request_from_changes is not one of the tools this contract allows/);
});

test("at most twenty requests wait at once, and a request is never cut short", async (t) => {
  const f = await fixture(t);
  await f.say(`/improve ${"x".repeat(4001)}`);
  assert.match(f.sent.at(-1), /4000/);
  for (let i = 1; i <= 20; i += 1) await f.say(`/improve Change number ${i}`);
  await f.say("/improve One more");
  assert.match(f.sent.at(-1), /20/);
  const requests = await f.listed();
  assert.equal(requests.length, 20, "nothing past twenty, and nothing cut short, was filed");
  assert.ok(requests.every((one) => /^Change number \d+$/.test(one.text)));
  // An answer makes room again.
  assert.equal((await f.decline(requests[0].id)).status, 200);
  await f.say("/improve One more");
  assert.equal((await f.listed()).filter((one) => one.status === "waiting").length, 20);
});

test("a yes Branch was still preparing when it stopped waits for the owner again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-requests-restart-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider };
  const first = await createBranch(options);
  let again = null, firstOpen = true;
  t.after(async () => { if (firstOpen) await first.close(); await again?.close(); await discardTemp(root); });
  assert.ok(first.sourceRequests, "the app keeps the requests");
  const filed = first.sourceRequests.file({ text: "Remove the Export button", from: { ...from, messageId: "m1" } });
  first.store.sqlite.prepare("UPDATE self_development_requests SET status='preparing' WHERE id=?").run(filed.id);
  firstOpen = false;
  await first.close();
  again = await createBranch(options);
  const [request] = again.sourceRequests.list();
  assert.equal(request.status, "waiting");
  assert.match(request.problem ?? "", /stopped/);
});
