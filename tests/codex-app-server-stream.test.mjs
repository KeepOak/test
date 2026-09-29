/* QA 2026-09-28: Codex as a model answers word by word over its app-server protocol (src/asks/codex-app-server.ts),
   where `codex exec` only hands the whole answer back at the end. The turn names Branch's model and Branch's own folder,
   a Codex without app-server falls back to exec (and is remembered), and Codex's own refusals are said plainly.
   Stand-in app-server children only. */
import test from "node:test";
import assert from "node:assert/strict";
import { CliAgentProvider, cliAgentCatalog, codexDefaultModel, codexWorkDir } from "../dist/providers/cli-agent.js";
import { closeWarmCodex, warmCodexCount } from "../dist/asks/codex-app-server.js";

test.afterEach(() => closeWarmCodex());

const codexRow = () => cliAgentCatalog.find((row) => row.id === "codex");
const request = (onTextDelta) => ({ messages: [{ role: "user", content: "Say hello" }], signal: AbortSignal.timeout(10000), onTextDelta });

/** A stand-in app-server: answers the handshake, then streams `words`, or ends the turn with `failure`. */
function appServer({ words = ["Hello ", "there"], failure = null, noAppServer = false } = {}) {
  const told = [], listeners = [];
  let exit = () => {}, threads = 0, starts = 0;
  const reply = (message) => setImmediate(() => { for (const fn of listeners) fn(message); });
  const child = {
    send(message) {
      told.push(message);
      if (noAppServer) { setImmediate(() => exit(2, false)); return; } // an older codex: "unrecognized subcommand"
      if (message.method === "initialize") reply({ id: message.id, result: { userAgent: "codex/1" } });
      if (message.method === "thread/start") reply({ id: message.id, result: { thread: { id: `thr${++threads}` } } });
      if (message.method === "turn/start") {
        const threadId = message.params.threadId;
        reply({ id: message.id, result: { turn: { id: "turn", status: "inProgress" } } });
        for (const delta of failure ? [] : words) reply({ method: "item/agentMessage/delta", params: { threadId, delta } });
        reply({ method: "turn/completed", params: { threadId, turn: failure ? { status: "failed", error: { message: failure } } : { status: "completed" } } });
      }
    },
    onMessage: (fn) => listeners.push(fn), onExit: (fn) => { exit = fn; }, stop() {},
    crash: () => exit(1, false),
  };
  return { told, child, get starts() { return starts; }, start: () => { starts++; listeners.length = 0; return child; } };
}

test("Codex streams its answer word by word, on Branch's model and in Branch's own folder", async () => {
  const fake = appServer();
  const provider = new CliAgentProvider(codexRow(), {}, async () => assert.fail("exec is not used when app-server answers"));
  provider.appServer = fake.start;
  const pieces = [];
  const said = await provider.complete(request((piece) => pieces.push(piece)));
  assert.equal(said.content, "Hello there");
  assert.deepEqual(pieces, ["Hello ", "there"], "each word as Codex sends it");
  const thread = fake.told.find((m) => m.method === "thread/start").params;
  assert.equal(thread.model, codexDefaultModel);
  assert.equal(thread.cwd, codexWorkDir());
  assert.deepEqual({ sandbox: thread.sandbox, approval: thread.approvalPolicy }, { sandbox: "read-only", approval: "never" });
});

test("a Codex with no app-server answers through exec, and is not asked again", async () => {
  const fake = appServer({ noAppServer: true });
  let execs = 0;
  const row = { ...codexRow(), command: "codex-without-app-server" };
  const provider = new CliAgentProvider(row, {}, async () => {
    execs++;
    return { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "from exec" } }), stderr: "" };
  });
  provider.appServer = fake.start;
  assert.equal((await provider.complete(request())).content, "from exec");
  const asked = fake.told.length;
  assert.equal((await provider.complete(request())).content, "from exec");
  assert.equal(fake.told.length, asked, "the app-server is not tried again this run");
  assert.equal(execs, 2);
});

test("a model Codex refuses over app-server is said plainly, with the ones it takes", async () => {
  const fake = appServer({ failure: `{"type":"error","status":400,"error":{"message":"The '${codexDefaultModel}' model is not supported when using Codex with a ChatGPT account."}}` });
  const provider = new CliAgentProvider(codexRow(), {}, async () => assert.fail("no exec"));
  provider.appServer = fake.start;
  await assert.rejects(provider.complete(request()), (error) => {
    assert.match(error.message, new RegExp(`cannot use ${codexDefaultModel.replaceAll(".", "\.")} with this sign-in`));
    assert.doesNotMatch(error.message, /status|400|sign in again/);
    return true;
  });
});

test("the app-server stays warm: a second turn reuses it on a new thread, and a crashed one is started again", async () => {
  const fake = appServer();
  const provider = new CliAgentProvider(codexRow(), {}, async () => assert.fail("no exec"));
  provider.appServer = fake.start;
  assert.equal((await provider.complete(request())).content, "Hello there");
  assert.equal((await provider.complete(request())).content, "Hello there");
  assert.equal(fake.starts, 1, "one app-server for both turns");
  assert.equal(fake.told.filter((m) => m.method === "initialize").length, 1, "the handshake is done once");
  assert.equal(fake.told.filter((m) => m.method === "thread/start").length, 3, "each turn has its own thread, and the next one is opened ahead");
  assert.equal(warmCodexCount(), 1);
  fake.child.crash();
  assert.equal(warmCodexCount(), 0, "a crashed app-server is forgotten");
  assert.equal((await provider.complete(request())).content, "Hello there");
  assert.equal(fake.starts, 2, "and started again on the next turn");
  closeWarmCodex();
  assert.equal(warmCodexCount(), 0, "Branch closing stops it");
});

test("an npm-installed Codex's own binary is found, so no launcher process sits beside the warm app-server", { skip: process.platform !== "win32" }, async (t) => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { discardTemp } = await import("./temp-dir.mjs");
  const { codexBinary } = await import("../dist/asks/codex-app-server.js");
  const root = await mkdtemp(join(tmpdir(), "branch-codex-npm-"));
  t.after(() => discardTemp(root));
  const pkg = join(root, "node_modules", "@openai", "codex");
  const platformPkg = join(pkg, "node_modules", "@openai", `codex-win32-${process.arch}`);
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  await mkdir(join(pkg, "bin"), { recursive: true });
  await mkdir(join(platformPkg, "vendor", triple, "bin"), { recursive: true });
  await writeFile(join(pkg, "bin", "codex.js"), "");
  await writeFile(join(platformPkg, "package.json"), JSON.stringify({ name: `@openai/codex-win32-${process.arch}` }));
  await writeFile(join(platformPkg, "vendor", triple, "bin", "codex.exe"), "");
  await writeFile(join(root, "codex.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  const found = codexBinary("codex", { PATH: root });
  assert.ok(found, "found");
  assert.ok(found.path.endsWith(join("codex", "node_modules", "@openai", `codex-win32-${process.arch}`, "vendor", triple, "bin", "codex.exe")), found.path);
  assert.equal(codexBinary("codex", { PATH: join(root, "nowhere") }), null, "no npm install: the launcher is used");
});
