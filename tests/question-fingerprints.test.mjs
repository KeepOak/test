/**
 * Every question the assistant stops on carries a fingerprint of its own: a keyed digest of the tool it is about and
 * the exact bytes it asks for, made by the engine with a key kept for this install. A yes given with
 * that fingerprint lands on that question and lets the work carry on; nobody outside the engine can work one out.
 *
 * Node only: the real dist/, temporary folders, port 0, a scripted model, a stand-in chat app, and the stand-in MCP
 * server that ships in dist/examples. The wall around programs is built on paper (the macOS profile, which is only
 * arguments) and its door is a local socket; nothing reaches the internet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { ApprovalRequiredError } from "../dist/approvals.js";
import { argumentFingerprint } from "../dist/runtime.js";
import { launchFingerprint } from "../dist/mcp-own-servers.js";
import { openWall } from "../dist/sandbox-backends.js";
import { saveWallSettings } from "../dist/sandbox.js";
import { wallContextFor } from "../dist/sandbox-wall.js";
import { readPolicy } from "../dist/policy.js";
import { protectedAreas, protectedTarget } from "../dist/never-break/protected.js";
import { discardTemp } from "./temp-dir.mjs";

const hex32 = /^[a-f0-9]{32}$/;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
const posixWall = { skip: process.platform === "win32" && "the wall around programs is macOS and Linux only" };
const notesServer = fileURLToPath(new URL("../dist/examples/mcp-notes-server.js", import.meta.url));

const allow = (tool) => ({ tool, match: "*", decision: "allow", remember: "session" });
const ask = (tool) => ({ tool, match: "*", decision: "ask", remember: "session" });

async function fixture(t, { serve = false, dataDir: kept } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-question-prints-")));
  const workspace = join(root, "workspace"), dataDir = kept ?? join(root, "data");
  await mkdir(workspace, { recursive: true });
  // The model makes the calls queued for this run, one a round, then says it is done.
  const provider = { name: "scripted", queue: [],
    async complete() { return provider.queue.shift() ?? { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir, presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }] });
  const server = serve ? await startServer(app, { dataDir, port: 0 }) : null;
  let open = true;
  const close = async () => { if (!open) return; open = false; await server?.close(); await app.close(); };
  t.after(async () => { await close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const run = (prompt, calls, sessionId) => {
    provider.queue.splice(0, provider.queue.length, ...calls.map(([name, args]) => ({ content: "",
      toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args) }] })));
    return app.runtime.run({ prompt, ...(sessionId ? { sessionId } : {}) });
  };
  const rules = (...list) => savePolicy(app.store, owner, { preset: "custom", rules: list });
  const waiting = (sessionId) => app.runtime.waitingApprovals(sessionId);
  const asked = (runId) => app.store.events(runId).filter((event) => event.kind === "policy.ask" && !event.data.step);
  const decided = () => app.store.audit.list(owner, { action: "approval.decided" }).map((row) => `${row.subject} [${row.outcome}]`);
  const approve = async (body) => {
    const response = await fetch(`${server.url}/api/policy/approve`, { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, root, workspace, dataDir, server, owner, run, rules, waiting, asked, decided, approve, close };
}

/** The last answer the model was handed for a tool call in this run. */
const lastToolAnswer = (app, runId) => {
  const done = app.store.events(runId).filter((event) => event.kind === "tool.completed" || event.kind === "tool.failed").at(-1);
  return done?.data.result ?? done?.data.error;
};

/** A stand-in chat app, paired, in its own conversation. */
async function chat(app) {
  const sent = [];
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); },
    async sendButtons(chatId, text, buttons) { sent.push({ chatId, text, buttons: buttons.map((button) => button.value) }); return String(sent.length); } };
  app.channels.mergeWindowMs = 0;
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  const message = (text, id) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: id });
  await app.channels.handle(message("hello", "hello-1"));
  const sessionId = app.store.get("settings", app.runtime.owner, "channel-session:chat:c1").data.sessionId;
  let n = 0;
  // PR #289: the chat is shown one exact question, with its own words and buttons, under a delivery key of its own.
  const show = async (question) => { await app.channels["askInChat"](message("", `show-${++n}`), sessionId, question, "", `show:${n}`); return sent.at(-1); };
  const say = (text) => app.channels.handle(message(text, `said-${++n}`));
  return { sent, sessionId, show, say };
}

/* ------------------------------------------------------------ the wall around programs, driven through a task */

const wallDeps = { platform: "darwin", exists: async () => true };
const blockedWrite = { exitCode: 1, stdout: "", stderr: "touch: /Users/o/report.txt: Operation not permitted\n" };

/** Through the wall's own door, the way a program behind it asks for a site. */
const throughDoor = (opened, site) => new Promise((resolve) => {
  const proxy = new URL(opened.start.env.HTTP_PROXY);
  const auth = Buffer.from(decodeURIComponent(`${proxy.username}:${proxy.password}`)).toString("base64");
  const socket = connect(Number(proxy.port), "127.0.0.1",
    () => socket.write(`GET http://${site}/ HTTP/1.1\r\nHost: ${site}\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`));
  let text = "";
  socket.on("data", (chunk) => { text += chunk; });
  socket.on("end", () => resolve(text));
  socket.on("close", () => resolve(text));
});

/**
 * Two stand-in program tools behind the wall, built exactly as the runtime builds a program's wall: one whose program
 * is stopped writing a file outside the workspace, one whose program asks the door for a site nobody decided about.
 */
function wallTools(app, root) {
  const owner = app.runtime.owner;
  const wallOf = (context) => wallContextFor({ store: app.store, owner, policy: readPolicy(app.store, owner), approvals: app.runtime.approvals,
    context, tool: "shell.execute", permission: "shell.execute", target: "touch", args: {}, choice: null }).osSandbox;
  const start = { executable: "/usr/bin/touch", args: ["/Users/o/report.txt"], cwd: root, env: { PATH: "/usr/bin" } };
  app.registry.register({ name: "probe.write", permission: "files.read", description: "stand-in program that writes a file",
    parameters: z.object({}).strict(), execute: async (_args, context) => {
      const opened = await openWall(wallOf(context), start, { workspace: root }, wallDeps);
      try { return { widened: opened.start.args.filter((arg) => arg.startsWith("-DGRANTED_")), said: await opened.finish(blockedWrite) }; }
      finally { await opened.close(); }
    } });
  app.registry.register({ name: "probe.site", permission: "files.read", description: "stand-in program that reaches a site",
    parameters: z.object({}).strict(), execute: async (_args, context) => {
      const wall = wallOf(context);
      const opened = await openWall(wall, start, { workspace: root }, wallDeps);
      try {
        // What the door decides for the site is this answer; only a site nobody decided about is put to the door.
        const door = wall.answer("network.site", "new.example.test") ?? null;
        if (door === null) assert.match(await throughDoor(opened, "new.example.test"), /403/);
        return { door, said: await opened.finish({ exitCode: 6, stdout: "", stderr: "" }) };
      } finally { await opened.close(); }
    } });
}

/* ----------------------------------------------- questions raised without a fingerprint, and their answers */

test("a question the wall raises without a fingerprint gets one, on the waiting list and on its event", posixWall, async (t) => {
  const { app, root, run, rules, waiting, asked } = await fixture(t);
  wallTools(app, root);
  rules(allow("probe.write"), allow("probe.site"));
  saveWallSettings(app.store, app.runtime.owner, { mode: "on", network: "per-site" });
  for (const [tool, kind, target] of [["probe.write", "sandbox.write", "/Users/o/report.txt"], ["probe.site", "network.site", "new.example.test"]]) {
    const stopped = await run(`use ${tool}`, [[tool, {}]]);
    assert.equal(stopped.status, "needs_input", `${tool}: ${stopped.output}`);
    const question = waiting(stopped.sessionId).find((one) => one.tool === kind);
    assert.equal(question?.target, target);
    assert.match(String(question.fingerprint), hex32, `${kind}: the waiting question carries a fingerprint`);
    const [event] = asked(stopped.id).filter((one) => one.data.name === kind);
    assert.equal(event.data.fingerprint, question.fingerprint, `${kind}: the event carries the same one`);
  }
});

test("a raised question's fingerprint is bound to its tool and what it asks about", () => {
  const site = new ApprovalRequiredError("network.site", "a.example.test", "Reach a.example.test");
  assert.match(String(site.fingerprint), hex32);
  assert.equal(site.fingerprint, new ApprovalRequiredError("network.site", "a.example.test", "Reach it, worded otherwise").fingerprint,
    "the same request asked again is the same question");
  assert.notEqual(site.fingerprint, new ApprovalRequiredError("network.site", "b.example.test", "Reach b.example.test").fingerprint);
  assert.notEqual(site.fingerprint, new ApprovalRequiredError("sandbox.write", "a.example.test", "Write a.example.test").fingerprint);
  const given = argumentFingerprint("files.read", "{}");
  assert.equal(new ApprovalRequiredError("files.read", "x", "Read x", "session", given).fingerprint, given, "a raiser's own fingerprint is kept");
});

test("the wall's questions: a yes with the fingerprint lets the retry through without asking again, and a no is kept", posixWall, async (t) => {
  const { app, root, run, rules, waiting, asked, approve, decided } = await fixture(t, { serve: true });
  wallTools(app, root);
  rules(allow("probe.write"), allow("probe.site"));
  saveWallSettings(app.store, app.runtime.owner, { mode: "on", network: "per-site" });
  for (const [tool, kind] of [["probe.write", "sandbox.write"], ["probe.site", "network.site"]]) {
    for (const decision of ["allow", "deny"]) {
      const stopped = await run(`use ${tool}`, [[tool, {}]]);
      const question = waiting(stopped.sessionId).find((one) => one.tool === kind);
      assert.match(String(question?.fingerprint), hex32, `${kind}: asked with a fingerprint`);
      const answered = await approve({ sessionId: stopped.sessionId, decision, remember: "session", fingerprint: question.fingerprint });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      assert.equal(answered.body.tool, kind);
      const again = await run("carry on", [[tool, {}]], stopped.sessionId);
      assert.equal(again.status, "completed", `${kind} ${decision}: ${again.output}`);
      assert.equal(asked(again.id).length, 0, `${kind} ${decision}: the same step is not asked again`);
      assert.equal(waiting(stopped.sessionId).length, 0);
      const result = lastToolAnswer(app, again.id);
      if (kind === "sandbox.write") {
        assert.deepEqual(result.widened, decision === "allow" ? ["-DGRANTED_0=/Users/o/report.txt"] : [], `${decision}: what the wall lets through`);
        assert.match(result.said, /stopped this command/);
      } else assert.equal(result.door, decision, "the door's answer for the site is the one given");
    }
  }
  assert.deepEqual(decided().filter((row) => /sandbox\.write|network\.site/.test(row)).sort(), [
    "network.site on new.example.test [allowed]", "network.site on new.example.test [refused]",
    "sandbox.write on /Users/o/report.txt [allowed]", "sandbox.write on /Users/o/report.txt [refused]"]);
});

test("the project's tests: Once is used once, the card's answer lands on its own question while another waits, and a no refuses", async (t) => {
  const { app, workspace, run, rules, waiting, asked, approve } = await fixture(t, { serve: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p", type: "module" }));
  rules(ask("files.read"), allow("code.check"));
  const reading = await run("read it", [["files.read", { path: "README.md" }]]);
  const sessionId = reading.sessionId;
  const testing = await run("test it", [["code.check", {}]], sessionId);
  assert.equal(testing.status, "needs_input", testing.output);
  const [readQuestion, testsQuestion] = waiting(sessionId);
  assert.equal(readQuestion?.tool, "files.read");
  assert.equal(testsQuestion?.kind, "project-tests");
  assert.match(String(testsQuestion.fingerprint), hex32, "the tests question carries a fingerprint");
  assert.equal(asked(testing.id)[0].data.fingerprint, testsQuestion.fingerprint);
  // The card for the tests question answers it while the older question still waits.
  const once = await approve({ sessionId, decision: "allow", remember: "never", fingerprint: testsQuestion.fingerprint });
  assert.equal(once.status, 200, JSON.stringify(once.body));
  assert.equal(once.body.tool, testsQuestion.tool);
  assert.deepEqual(waiting(sessionId).map((one) => one.tool), ["files.read"], "the other question is still waiting");
  const ran = await run("carry on", [["code.check", {}]], sessionId);
  assert.equal(asked(ran.id).length, 0, "Once lets the next run go without asking");
  assert.ok(app.store.events(ran.id).some((event) => event.kind === "code.check"), "the tests ran");
  const next = await run("again", [["code.check", {}]], sessionId);
  assert.equal(next.status, "needs_input", "Once was used up");
  const refused = waiting(sessionId).find((one) => one.kind === "project-tests");
  assert.equal((await approve({ sessionId, decision: "deny", remember: "session", fingerprint: refused.fingerprint })).status, 200);
  const declined = await run("and again", [["code.check", {}]], sessionId);
  assert.equal(asked(declined.id).length, 0, "a no is not asked again");
  assert.equal(app.store.events(declined.id).some((event) => event.kind === "code.check"), false, "and nothing ran");
});

/* ---------------------------------------------------------------------------------------------------- the chat */

test("a chat shown a question its raiser gave no fingerprint to gets buttons naming it, and can refuse and allow it", async (t) => {
  const { app, run, rules, waiting, decided } = await fixture(t);
  const { sessionId, show, say } = await chat(app);
  // A step inside a tool that reaches something to ask about, with no fingerprint of its own (as the wall's did).
  app.registry.register({ name: "probe.asks", permission: "files.read", description: "stand-in step that asks",
    parameters: z.object({ target: z.string() }).strict(),
    execute: async ({ target }) => { throw new ApprovalRequiredError("files.read", target, `Reading ${target}`, "session"); } });
  rules(allow("probe.asks"));
  for (const [target, answer, outcome] of [["notes.txt", "n", "refused"], ["plan.txt", "y", "allowed"]]) {
    const stopped = await run("look", [["probe.asks", { target }]], sessionId);
    assert.equal(stopped.status, "needs_input", stopped.output);
    const question = waiting(sessionId).find((one) => one.target === target);
    assert.match(String(question?.fingerprint), hex32);
    const shown = await show(question);
    assert.deepEqual(shown.buttons, [`y:${question.fingerprint}`, `n:${question.fingerprint}`]);
    await say(answer);
    assert.ok(decided().includes(`files.read on ${target} [${outcome}]`), `${answer}: ${JSON.stringify(decided())}`);
    assert.equal(waiting(sessionId).length, 0);
  }
});

/* ---------------------------------------------------------- the engine's own questions, and a flow's steps */

test("a model's call is asked about under the fingerprint of its tool and the bytes it sent, and a step under its own", async (t) => {
  const { app, run, rules, waiting, asked } = await fixture(t);
  assert.equal(argumentFingerprint("shell.execute", '{"a":1}'), argumentFingerprint("shell.execute", '{"a":1}'));
  assert.notEqual(argumentFingerprint("shell.execute", '{"a":1}'), argumentFingerprint("shell.execute", '{"a":2}'));
  assert.match(argumentFingerprint("shell.execute", "x"), hex32);
  rules(ask("files.read"), ask("probe.click"));
  const sent = JSON.stringify({ path: "README.md" });
  const stopped = await run("read", [["files.read", sent]]);
  const [question] = waiting(stopped.sessionId);
  assert.equal(question.bytes, sent);
  assert.equal(question.fingerprint, argumentFingerprint("files.read", sent));
  assert.equal(question.fingerprint, argumentFingerprint(question.tool, question.bytes));
  assert.equal(asked(stopped.id)[0].data.fingerprint, argumentFingerprint(asked(stopped.id)[0].data.name, asked(stopped.id)[0].data.bytes));
  // A step a tool takes on its own is asked about under the step's fingerprint, never the bare words of the step.
  app.registry.register({ name: "probe.click", permission: "files.read", description: "stand-in step",
    parameters: z.object({ role: z.string(), name: z.string() }).strict(), execute: async () => ({ ok: true }) });
  const step = { role: "button", name: "Place order" };
  const raised = (target, index) => {
    try { app.runtime.judgeStep("probe.click", step, app.runtime.context({}), target, index); } catch (error) { return error; }
    return null;
  };
  const one = raised("shop.example.com", 0);
  assert.ok(one instanceof ApprovalRequiredError, String(one));
  assert.match(one.fingerprint, hex32);
  assert.notEqual(one.fingerprint, argumentFingerprint("probe.click", JSON.stringify(step)), "bound to the step, not only to its words");
  assert.equal(raised("shop.example.com", 0).fingerprint, one.fingerprint);
  assert.notEqual(raised("docs.example.com", 0).fingerprint, one.fingerprint, "the same step on another website is another question");
  assert.notEqual(raised("shop.example.com", 1).fingerprint, one.fingerprint, "and so is another step");
});

/* ------------------------------------------------------------------------------- two tools, identical bytes */

test("two tools asked with identical bytes are two questions, and a yes to one does not answer the other", async (t) => {
  const { app, run, rules, waiting } = await fixture(t);
  rules(ask("files.read"), ask("files.list"));
  const bytes = JSON.stringify({ path: "notes" });
  assert.notEqual(argumentFingerprint("files.read", bytes), argumentFingerprint("files.list", bytes));
  const first = await run("read", [["files.read", bytes]]);
  await run("list", [["files.list", bytes]], first.sessionId);
  const [read, list] = waiting(first.sessionId);
  assert.deepEqual([read?.tool, list?.tool], ["files.read", "files.list"], "the second did not take the first one's place");
  assert.notEqual(read.fingerprint, list.fingerprint);
  assert.equal(app.runtime.approve(first.sessionId, "allow", "session", read.fingerprint).tool, "files.read");
  assert.deepEqual(waiting(first.sessionId).map((one) => one.tool), ["files.list"], "the yes did not answer the other tool");
  assert.throws(() => app.runtime.approve(first.sessionId, "allow", "session", read.fingerprint), /different request/);
});

/* -------------------------------------------------------------------- a digest of the bytes answers nothing */

test("a fingerprint worked out from the request's bytes answers nothing", async (t) => {
  const { app, run, rules, waiting, decided } = await fixture(t);
  const { sessionId, show, say } = await chat(app);
  rules(ask("files.read"));
  await run("read the readme", [["files.read", { path: "README.md" }]], sessionId);
  await show(waiting(sessionId)[0]);
  const bytes = JSON.stringify({ path: "SECRET.md" });
  await run("read the other one", [["files.read", bytes]], sessionId);
  const secret = waiting(sessionId).find((one) => one.target === "SECRET.md");
  assert.match(String(secret?.fingerprint), hex32);
  for (const guess of [sha(bytes), sha(`files.read${bytes}`), sha(`files.read\u0000${bytes}`)])
    assert.notEqual(secret.fingerprint, guess, "the fingerprint is not a plain digest anyone can work out");
  await say(`y:${sha(bytes)}`);
  assert.ok(!decided().some((row) => row.includes("SECRET.md")), JSON.stringify(decided()));
  assert.ok(waiting(sessionId).some((one) => one.target === "SECRET.md"), "the request it named still waits");
});

/* ------------------------------------------------------------------------------------------ one key per install */

const keyFile = (dataDir) => join(dataDir, "question-fingerprint.key");

test("the key is made once per install: a fresh start on the same data folder keeps it, another install has its own", async (t) => {
  const first = await fixture(t);
  const bytes = JSON.stringify({ path: "a" });
  const before = argumentFingerprint("files.read", bytes);
  assert.match(before, hex32);
  const saved = await readFile(keyFile(first.dataDir));
  assert.equal(saved.length, 32);
  if (process.platform !== "win32") assert.equal((await stat(keyFile(first.dataDir))).mode & 0o777, 0o600, "only the owner can read it");
  await first.close();
  const again = await fixture(t, { dataDir: first.dataDir });
  assert.equal(argumentFingerprint("files.read", bytes), before, "the same request is the same question after a restart");
  assert.deepEqual(await readFile(keyFile(first.dataDir)), saved, "the key was not made again");
  await again.close();
  const other = await fixture(t);
  assert.notEqual(argumentFingerprint("files.read", bytes), before, "another install, another key");
  // The key is never shown: not in the fingerprint, and not by anything a task can use.
  assert.ok(!before.includes(saved.toString("hex").slice(0, 16)));
  const areas = protectedAreas({ workspace: other.workspace, dataDir: other.dataDir });
  const refused = (tool, args) => protectedTarget({ tool, readOnly: tool === "files.read", args, target: "" }, areas);
  assert.match(String(refused("files.read", { path: keyFile(other.dataDir) })), /keys/);
  assert.ok(refused("shell.execute", { executable: "cat", args: [keyFile(other.dataDir)] }));
  assert.ok(refused("shell.execute", { executable: "cat", args: ["question-fingerprint.key"], cwd: other.dataDir }));
  other.rules(allow("files.read"));
  await assert.rejects(other.app.runtime.executeTool("files.read", { path: keyFile(other.dataDir) }, { mode: "policy" }));
});

test("a saved workflow paused on a question is carried on by the yes after a restart, and a changed step is asked again", async (t) => {
  const first = await fixture(t);
  savePolicy(first.app.store, first.owner, { preset: "ask-before-changes" });
  const step = (path) => [{ name: "Write", kind: "tool", tool: "files.write", args: { path, content: "z" } }];
  const made = first.app.workflows.create(first.owner, { name: "Write it", steps: step("kept.txt") });
  const changed = first.app.workflows.create(first.owner, { name: "Write that", steps: step("that.txt") });
  assert.equal((await first.app.workflows.run(first.owner, made.id)).status, "waiting_approval");
  assert.equal((await first.app.workflows.run(first.owner, changed.id)).status, "waiting_approval");
  await first.close();

  const fresh = await fixture(t, { dataDir: first.dataDir });
  const done = await fresh.app.workflows.resume(fresh.owner, made.id);
  assert.equal(done.status, "completed", done.error ?? done.question ?? "");
  assert.equal(await readFile(join(fresh.workspace, "kept.txt"), "utf8"), "z");
  // The other workflow's step now asks for other bytes than the yes was given for: that yes answers nothing.
  const row = fresh.app.store.get("workflows", fresh.owner, changed.id);
  fresh.app.store.save("workflows", fresh.owner, changed.id,
    { ...row.data, steps: row.data.steps.map((one) => ({ ...one, args: { path: "other.txt", content: "z" } })) });
  const asked = await fresh.app.workflows.resume(fresh.owner, changed.id);
  assert.equal(asked.status, "waiting_approval", "a yes to one request let a different one through");
  await assert.rejects(access(join(fresh.workspace, "other.txt")));
  await fresh.close(); // its data folder is the first app's, which is cleared after the test
});

test("a flow paused on a question is carried on by the yes after a restart, and a changed box is asked again", async (t) => {
  const first = await fixture(t);
  first.app.coding.setMode("read-first", "off");
  savePolicy(first.app.store, first.owner, { preset: "ask-before-changes" });
  const graph = (name, path) => ({ name, input: {}, state: { answer: "text" }, entry: "a", edges: [],
    nodes: [{ id: "a", name: "Write", kind: "tool", tool: "files.write", args: { path, content: "z" }, input: {}, output: { answer: "text" } }] });
  const kept = first.app.flows.saveGraph(graph("Write it", "kept.txt"));
  const other = first.app.flows.saveGraph(graph("Write that", "that.txt"));
  for (const flow of [kept, other]) {
    const stopped = await first.app.flows.settled(first.app.flows.startGraph(flow.id, {}).runId);
    assert.equal(stopped.status, "waiting_approval", stopped.error ?? "");
  }
  await first.close();

  const fresh = await fixture(t, { dataDir: first.dataDir });
  fresh.app.coding.setMode("read-first", "off");
  const done = await fresh.app.flows.settled((await fresh.app.flows.run(kept.id, { resume: true })).runId);
  assert.equal(done.status, "completed", done.error ?? done.question ?? "");
  assert.equal(await readFile(join(fresh.workspace, "kept.txt"), "utf8"), "z");
  fresh.app.flows.saveGraph({ ...graph("Write that", "other.txt"), id: other.id });
  const asked = await fresh.app.flows.settled((await fresh.app.flows.run(other.id, { resume: true })).runId);
  assert.equal(asked.status, "waiting_approval", "a yes to one request let a different one through");
  await assert.rejects(access(join(fresh.workspace, "other.txt")));
  await fresh.close(); // its data folder is the first app's, which is cleared after the test
});

/* -------------------------------------------------------------------------------- switching on a command server */

test("switching on a command server: the yes starts it, the stored yes is the launch's own, and a fresh start keeps it", async (t) => {
  const first = await fixture(t, { serve: true });
  const server = { transport: "stdio", command: process.execPath, args: [notesServer] };
  const toolsOf = (app, id) => app.registry.names().filter((name) => name.startsWith(`mcp.${id}.`));
  const until = async (check, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await check()) return; await new Promise((done) => setTimeout(done, 50)); }
    throw new Error("timed out");
  };
  const { server: { id } } = await first.app.ownMcp.add({ name: "My notes", server });
  const launch = launchFingerprint(first.app.ownMcp.saved()[0].server); // the launch as saved, which is what a yes is kept against
  await first.app.ownMcp.start(id);
  const question = first.waiting().find((one) => one.tool === "mcp.start");
  assert.match(String(question?.fingerprint), hex32);
  assert.notEqual(question.fingerprint, launch, "the question's fingerprint is not the stored launch value");
  const answered = await first.approve({ sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  await until(() => toolsOf(first.app, id).length === 2);
  assert.equal(first.app.ownMcp.saved()[0].approved, launch, "the yes is kept against the launch itself");
  assert.equal(first.app.ownMcp.saved()[0].on, true);
  await first.close();

  // A fresh app on the same data folder, starting its saved servers as Branch does when it starts.
  const fresh = await fixture(t, { dataDir: first.dataDir });
  await fresh.app.ownMcp.startSaved([]);
  assert.equal(toolsOf(fresh.app, id).length, 2, "left on with the same launch, it starts again");
  assert.equal(fresh.app.ownMcp.saved()[0].on, true);
  await fresh.close(); // its data folder is the first app's, which is cleared after the test
});
