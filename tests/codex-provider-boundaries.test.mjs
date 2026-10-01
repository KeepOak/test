/* Cloud QA: official Codex transport keeps its configured proxy/CA and isolated home;
   exec fallback keeps the app-server's read-only/no-approval boundary. Stand-ins only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTransportEnvironment } from "../dist/providers/codex-environment.js";
import { codexEnvironment, closeWarmCodex, warmCodexTurn } from "../dist/asks/codex-app-server.js";
import { CliAgentProvider, cliAgentCatalog, codexArgs, runCliAgent, strippedEnvironment } from "../dist/providers/cli-agent.js";
import { discardTemp } from "./temp-dir.mjs";

const transport = {
  CODEX_HOME: "/isolated/branch-codex", HTTP_PROXY: "http://proxy.test:8080", HTTPS_PROXY: "http://proxy.test:8080",
  ALL_PROXY: "socks5://proxy.test:1080", NO_PROXY: "localhost,127.0.0.1,::1",
  http_proxy: "http://lower.test:8080", https_proxy: "http://lower.test:8080", all_proxy: "socks5://lower.test:1080", no_proxy: "",
  SSL_CERT_FILE: "/certs/roots.pem", SSL_CERT_DIR: "/certs", NODE_EXTRA_CA_CERTS: "/certs/node.pem",
  REQUESTS_CA_BUNDLE: "/certs/requests.pem", CURL_CA_BUNDLE: "/certs/curl.pem",
};
// Windows environment names are case-insensitive: conflicting lowercase values cannot
// coexist with their uppercase names there. Plain-object coverage above still proves both.
const processTransport = process.platform === "win32"
  ? Object.fromEntries(Object.entries(transport).filter(([key]) => key === key.toUpperCase()))
  : transport;
function assertProcessTransport(actual) {
  const copied = codexTransportEnvironment(actual);
  if (process.platform !== "win32") return assert.deepEqual(copied, processTransport);
  for (const [key, value] of Object.entries(copied))
    assert.equal(value, processTransport[key.toUpperCase()], key);
  for (const [key, value] of Object.entries(processTransport))
    assert.ok(Object.entries(copied).some(([name, got]) => name.toUpperCase() === key && got === value), key);
}
const excluded = {
  OPENAI_API_KEY: "fixture-not-a-key", OPENAI_BASE_URL: "https://not-used.test", BRANCH_MASTER_KEY: "fixture",
  ANTHROPIC_API_KEY: "fixture", NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_OPTIONS: "--require=/not-used.js",
  CODEX_CLIENT_ID: "not-branch", SSLKEYLOGFILE: "/not-used", UNRELATED_SECRET: "fixture",
};
function environment(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}
const row = () => cliAgentCatalog.find((r) => r.id === "codex");
const request = () => ({ messages: [{ role: "user", content: "fixture" }], signal: AbortSignal.timeout(5000) });

function server() {
  const starts = [], told = [];
  return { starts, told, start(command, env) {
    starts.push({ command, env });
    let listener = () => {};
    return {
      send(message) {
        told.push(message);
        const reply = (value) => setImmediate(() => listener(value));
        if (message.method === "initialize") reply({ id: message.id, result: {} });
        if (message.method === "thread/start") reply({ id: message.id, result: { thread: { id: "thread" } } });
        if (message.method === "turn/start") {
          reply({ id: message.id, result: { turn: { id: "turn" } } });
          reply({ method: "item/agentMessage/delta", params: { threadId: "thread", delta: "fixture answer" } });
          reply({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
        }
      },
      onMessage(fn) { listener = fn; }, onExit() {}, stop() {},
    };
  } };
}

test("Codex transport copies only configured names, preserving no-proxy and CA verification", () => {
  assert.deepEqual(codexTransportEnvironment({ ...transport, ...excluded }), transport);
  assert.deepEqual(codexTransportEnvironment({}), {});
  assert.deepEqual(codexEnvironment({ PATH: "/bin", HOME: "/h", ...transport, ...excluded }), { PATH: "/bin", HOME: "/h", ...transport });
});

test("primary app-server uses the explicit CODEX_HOME and never reuses another home's child", async (t) => {
  environment(t, { ...processTransport, ...excluded });
  t.after(closeWarmCodex);
  const fake = server();
  const provider = new CliAgentProvider(row(), {}, async () => assert.fail("no exec"));
  provider.appServer = fake.start;
  await provider.complete(request());
  assertProcessTransport(fake.starts[0].env);
  for (const key of Object.keys(excluded)) assert.equal(fake.starts[0].env[key], undefined, key);
  process.env.CODEX_HOME = "/isolated/another-home";
  await provider.complete(request());
  assert.equal(fake.starts.length, 2, "a changed home gets another process");
  const account = new CliAgentProvider(row(), {}, async () => assert.fail("no exec"), { name: "CODEX_HOME", path: "/isolated/account" });
  account.appServer = fake.start;
  await account.complete(request());
  assert.equal(fake.starts[2].env.CODEX_HOME, "/isolated/account", "account selection takes precedence");
  const thread = fake.told.find((m) => m.method === "thread/start").params;
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(fake.told.find((m) => m.method === "initialize").params.clientInfo.name, "branch_agent");
  for (const key of Object.keys(transport)) assert.equal(strippedEnvironment()[key], undefined, "other programs retain their short environment");
});

test("a spawned stand-in exec receives configured transport and explicit account isolation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-codex-boundary-"));
  t.after(() => discardTemp(root));
  const script = join(root, "stand-in.cjs");
  await writeFile(script, 'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify(process.env)));');
  environment(t, { ...processTransport, ...excluded });
  const standIn = { ...row(), command: process.execPath, args: [script] };
  const limits = { timeoutMs: 5000, maxOutputChars: 20000 };
  const run = (home) => runCliAgent(standIn, "fixture", AbortSignal.timeout(5000), limits, home);
  const primary = JSON.parse((await run()).stdout);
  assertProcessTransport(primary);
  for (const key of Object.keys(excluded)) assert.equal(primary[key], undefined, key);
  const account = JSON.parse((await run({ name: "CODEX_HOME", path: join(root, "account") })).stdout);
  assert.equal(account.CODEX_HOME, join(root, "account"));
});

test("unavailable app-server falls back with explicit read-only and never-approve settings", async (t) => {
  t.after(closeWarmCodex);
  const calls = [];
  const provider = new CliAgentProvider({ ...row(), command: "fixture-codex-unavailable" }, {}, async (call) => {
    calls.push(call);
    return { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fixture" } }), stderr: "" };
  });
  provider.appServer = () => {
    let exit = () => {};
    return { send() { setImmediate(() => exit(2, false)); }, onMessage() {}, onExit(fn) { exit = fn; }, stop() {} };
  };
  await provider.complete(request());
  await provider.complete(request());
  for (const call of calls) {
    const config = call.args.filter((_, i) => call.args[i - 1] === "-c");
    assert.ok(config.includes('sandbox_mode="read-only"'));
    assert.ok(config.includes('approval_policy="never"'));
    assert.ok(!call.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  }
  assert.equal(calls.length, 2);
});


test("custom exec policy overrides fail closed before a child can start", () => {
  const overrides = [
    ["--sandbox", "danger-full-access"], ["-s", "workspace-write"], ["-a", "on-request"],
    ["--permissions", ":workspace"], ["--yolo"], ["--sandbox=workspace-write"], ["-sdanger-full-access"],
    ["--ask-for-approval", "on-request"], ["-aon-request"], ["--full-auto"], ["--approve-for-me"],
    ["--dangerously-bypass-approvals-and-sandbox"], ["-c", 'sandbox_mode="danger-full-access"'],
    ["--config", 'approval_policy="on-request"'], ["--config=approval_policy=\"on-request\""],
    ["-cdefault_permissions=\":workspace\""], ["-c", '"sandbox_mode" = "workspace-write"'],
    ["-c", "sandbox_workspace_write.network_access=true"], ["-c", "approvals_reviewer=auto_review"],
  ];
  for (const override of overrides)
    assert.throws(() => codexArgs(["exec", "--json", ...override, "-"], "fixture"), /requires read-only access and no approvals/, override.join(" "));
});


test("direct warm calls resolve the actual environment before selecting a child", async (t) => {
  environment(t, { CODEX_HOME: "/isolated/first" });
  t.after(closeWarmCodex);
  const fake = server();
  await warmCodexTurn("fixture", fake.start, request(), {}, 5000);
  process.env.CODEX_HOME = "/isolated/second";
  await warmCodexTurn("fixture", fake.start, request(), {}, 5000);
  await warmCodexTurn("fixture", fake.start, request(), { home: "same-label", env: { CODEX_HOME: "/isolated/third" } }, 5000);
  await warmCodexTurn("fixture", fake.start, request(), { home: "same-label", env: { CODEX_HOME: "/isolated/fourth" } }, 5000);
  assert.deepEqual(fake.starts.map((s) => s.env.CODEX_HOME), ["/isolated/first", "/isolated/second", "/isolated/third", "/isolated/fourth"]);
});

test("exec-only completion and model probe both carry the fixed sandbox and approval policy", async () => {
  const calls = [];
  const provider = new CliAgentProvider(row(), {}, async (call) => {
    calls.push(call.args);
    return { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fixture" } }), stderr: "" };
  });
  assert.equal(provider.appServer, null);
  await provider.complete(request());
  assert.equal(await provider.probe().tryModel("fixture"), "accepted");
  for (const args of calls) {
    const config = args.filter((_, i) => args[i - 1] === "-c");
    assert.ok(config.includes('sandbox_mode="read-only"'));
    assert.ok(config.includes('approval_policy="never"'));
  }
  assert.equal(calls.length, 2);
});

test("exec alias is normalized and unsupported or conflicting model invocations cannot launch", async () => {
  assert.deepEqual(codexArgs(["e", "--json", "-"], "fixture"), codexArgs(["exec", "--json", "-"], "fixture"));
  for (const args of [["e", "--yolo", "-"], ["e", "--json", "--dangerously-bypass-approvals-and-sandbox", "-"],
    ["e", "-c", 'approval_policy="on-request"', "-"], ["resume", "last"], ["--json", "-"]]) {
    let starts = 0;
    const provider = new CliAgentProvider({ ...row(), args }, {}, async () => { starts++; assert.fail("no child may start"); });
    await assert.rejects(provider.complete(request()), /requires.*read-only access and no approvals/);
    assert.equal(starts, 0);
  }
});

test("warm children separate fallback homes and changed configured transport", async (t) => {
  t.after(closeWarmCodex);
  const fake = server();
  const turn = (env) => warmCodexTurn("fixture", fake.start, request(), { home: "same-label", env }, 5000);
  for (const home of ["HOME", "USERPROFILE"]) {
    const before = fake.starts.length;
    await turn({ [home]: "/isolated/a" });
    await turn({ [home]: "/isolated/a" });
    assert.equal(fake.starts.length, before + 1, "unchanged effective environment reuses its child");
    await turn({ [home]: "/isolated/b" });
    assert.equal(fake.starts.length, before + 2, `${home} change gets its own child`);
  }
  const base = { CODEX_HOME: "/isolated/explicit", HOME: "/isolated/a" };
  await turn(base);
  for (const env of [{ ...base, HOME: "/isolated/b" }, { ...base, HTTP_PROXY: "http://proxy.test:8080" },
    { ...base, SSL_CERT_FILE: "/certs/new.pem" }, { ...base, NO_PROXY: "" }]) {
    const before = fake.starts.length;
    await turn(env);
    assert.equal(fake.starts.length, before + 1, "changed account/transport starts with the actual new environment");
    assert.deepEqual(fake.starts.at(-1).env, env);
  }
});