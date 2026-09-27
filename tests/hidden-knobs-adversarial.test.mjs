/**
 * R17-S-B integration review: the hidden knobs attacked. Each test here was written to fail against
 * the builder's branch first; the ones marked "pinned" guard a property that already held and must
 * not be lost in a later edit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import * as branch from "../dist/index.js";
const { createBranch, saveKnobs, readKnobs, refusedEnvironmentName, passedEnvironment, leakOptions, saveLaunchFile, knobCards } = branch;
import { findLeaks, redactLeaks } from "../dist/leak-guard.js";

const owner = "local";
const answer = (content, toolCalls = []) => ({ content, toolCalls });
const githubToken = "ghp_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";

async function fixture(t, provider, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-knobs-attack-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

test("environment pass-through refuses every name that can load code, redirect traffic or carry a secret", () => {
  const refused = [
    // secrets, any case
    "AWS_ACCESS_KEY_ID", "aws_secret_access_key", "AWS_SESSION_TOKEN", "OPENAI_API_KEY", "Openai_Api_Key", "BW_SESSION",
    "bw_session", "GITHUB_TOKEN", "MY_SERVICE_KEY",
    // whole families that point at credentials, endpoints or config
    "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_ENDPOINT_URL", "AWS_REGION", "OPENAI_BASE_URL", "openai_org_id",
    "ANTHROPIC_BASE_URL", "GH_HOST", "AZURE_CLIENT_ID", "GOOGLE_APPLICATION_CREDENTIALS",
    // the search path, in every spelling Windows accepts
    "PATH", "Path", "path", "PATHEXT", "PSModulePath", "CDPATH",
    // traffic
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "no_proxy", "FTP_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "HOSTALIASES",
    "npm_config_registry", "NPM_CONFIG_REGISTRY", "PIP_INDEX_URL", "GOPROXY", "DOCKER_HOST", "KUBECONFIG",
    // code loading
    "BASH_ENV", "ENV", "PROMPT_COMMAND", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONPATH", "PERL5OPT", "PERL5LIB",
    "RUBYOPT", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JAVA_HOME", "CLASSPATH", "LD_AUDIT", "ld_preload",
    "DYLD_INSERT_LIBRARIES", "dyld_library_path", "GIT_SSH_COMMAND", "git_dir", "NODE_OPTIONS", "node_path",
    "npm_config_script_shell", "npm_config_node_options", "HOME", "ZDOTDIR", "LESSOPEN", "EDITOR", "PAGER",
    "COMSPEC", "COR_PROFILER", "CORECLR_PROFILER_PATH", "DOTNET_STARTUP_HOOKS", "OPENSSL_CONF", "GCONV_PATH",
    "SHELL", "TMPDIR", "XDG_CONFIG_HOME", "CARGO_HOME", "RUSTC_WRAPPER", "GOFLAGS", "SSH_AUTH_SOCK", "SUDO_ASKPASS",
    "BROWSER", "ELECTRON_RUN_AS_NODE", "PS4", "IFS",
  ];
  const let_through = refused.filter((name) => refusedEnvironmentName(name) === null);
  assert.deepEqual(let_through, [], "each of these must be refused");
  for (const name of ["LANG", "TZ", "CI", "BUILD_MODE", "PHOTO_ALBUM_NAME", "LC_ALL"])
    assert.equal(refusedEnvironmentName(name), null, `${name} is harmless and may be passed`);
  // The saved card is checked again when a command starts, so a record written around the route is still refused.
  assert.deepEqual(passedEnvironment(["PATH", "HTTPS_PROXY", "npm_config_registry", "BUILD_MODE"],
    { PATH: "/evil", HTTPS_PROXY: "http://evil", npm_config_registry: "http://evil", BUILD_MODE: "fast" }), { BUILD_MODE: "fast" });
});

test("pinned: a leak-guard exception never widens what a passed variable may carry", async (t) => {
  const { app } = await fixture(t, { name: "p", async complete() { return answer("ok"); } });
  saveKnobs(app.store, owner, "leakGuard", { exceptions: ["GitHub token"] });
  assert.deepEqual(passedEnvironment(["BUILD_LABEL"], { BUILD_LABEL: githubToken }), {});
});

test("on Windows a passed name is found in any letter case and never doubled", () => {
  const source = { Build_Mode: "fast" };
  assert.deepEqual(passedEnvironment(["BUILD_MODE"], source, "win32"), { BUILD_MODE: "fast" });
  assert.deepEqual(passedEnvironment(["BUILD_MODE"], source, "darwin"), {}, "elsewhere names are exact");
  assert.deepEqual(passedEnvironment(["BUILD_MODE", "build_mode"], { BUILD_MODE: "a", build_mode: "b" }, "win32"), { BUILD_MODE: "a" });
});

test("a passed variable never replaces one the launch file already sets, in any letter case", () => {
  const base = { PATH: "", LANG: "C", Build_Mode: "safe" };
  assert.deepEqual(branch.withPassedEnvironment?.(base, { BUILD_MODE: "loose", TZ: "UTC" }),
    { PATH: "", LANG: "C", Build_Mode: "safe", TZ: "UTC" });
});

test("pinned: without options the guard is exactly as strict as before, whatever the owner saved", async (t) => {
  const { app } = await fixture(t, { name: "p", async complete() { return answer("ok"); } });
  saveKnobs(app.store, owner, "leakGuard", { exceptions: ["GitHub token"] });
  assert.equal(findLeaks(`token ${githubToken}`).length, 1);
  // A record written around the route (an old import, a hand edit) still cannot let a private key through.
  app.store.save("settings", owner, "knobs-leakGuard", { sensitivity: "standard", exceptions: ["private key", "GitHub token"] });
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----"; // not-a-real-secret
  assert.match(redactLeaks(pem, leakOptions(app.store, owner)).text, /hidden key-like value: private key/);
});

test("a household profile cannot change any of the owner's knobs, and nobody but the owner reads the note about them", async (t) => {
  const { startServer } = await import("../dist/server.js");
  const { app, root } = await fixture(t, { name: "p", async complete() { return answer("ok"); } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (method, body, token = server.token) => {
    const response = await fetch(server.url + "/api/knobs", { method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  saveKnobs(app.store, owner, "memory", { aboutYouOn: true, aboutYou: "I live at 12 Oak Lane and my doctor is Dr Kay." });
  saveKnobs(app.store, owner, "limits", { spendCapDollars: 1 });
  assert.match((await call("GET")).body.values.memory.aboutYou, /Oak Lane/, "the owner reads their own note");
  const key = app.sessionTokens.create(owner, { scope: "run", minutes: 5 });
  const looked = await call("GET", undefined, key.token);
  assert.equal(looked.status, 200);
  assert.doesNotMatch(JSON.stringify(looked.body), /Oak Lane/, "a short-lived key never reads the note");

  const person = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: person.id, pin: "4321" });
  assert.doesNotMatch(JSON.stringify((await call("GET")).body), /Oak Lane/, "a household profile never reads the note");
  for (const [card, values] of [["limits", { spendCapDollars: 10000 }], ["limits", { maxSteps: 500 }],
    ["memory", { aboutYou: "changed" }], ["reasoning", { showReasoning: true }], ["subtasks", { parallelSubtasks: 8 }],
    ["compaction", { autoCompact: false }]]) {
    const refused = await call("POST", { card, values });
    assert.equal(refused.status, 400, `${card} ${JSON.stringify(values)}`); // profile-audit: refused at one place in src/server.ts, as requireOwner answers
  }
  assert.equal((await call("POST", { card: "limits", reset: true })).status, 400);
  assert.equal((await call("POST", { card: "memory", memoryProvider: "branch" })).status, 400);
  app.store.profiles.switch({ profileId: null });
  assert.equal(readKnobs(app.store, owner, "limits").spendCapDollars, 1);
  assert.match(readKnobs(app.store, owner, "memory").aboutYou, /Oak Lane/);
});

test("a sub-task's spending counts against the task that started it", async (t) => {
  const priced = { input: 100_000, output: 30_000 }; // about $0.55 on gpt-4o
  let parentRounds = 0;
  const provider = { name: "main", async complete(request) {
    const last = request.messages.at(-1)?.content ?? "";
    if (/^child work/.test(last) || request.messages.some((m) => m.content === "child work")) return { ...answer("child done"), usage: priced };
    parentRounds++;
    if (parentRounds === 1) return { ...answer("", [{ id: "c1", name: "test.spawn", arguments: "{}" }]), usage: { input: 10, output: 10 } };
    return { ...answer("parent finished"), usage: { input: 10, output: 10 } };
  } };
  const { app } = await fixture(t, provider, { presets: [{ id: "default", name: "Priced", provider, model: "gpt-4o" }] });
  app.registry.register({ name: "test.spawn", permission: app.registry.permissionOf("memory.search"), description: "spawn",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => ({ said: (await app.runtime.delegate("child work", context, [], "")).output }) });
  saveKnobs(app.store, owner, "limits", { spendCapDollars: 0.5 });
  const run = await app.runtime.run({ prompt: "parent work" });
  assert.notEqual(run.status, "completed", run.output);
  assert.match(run.output, /reaches the limit of \$0\.50 for one task/);
  assert.equal(parentRounds, 1, "the parent's second round was never paid for");
});

test("a spending cap on a connection with no known price says so instead of doing nothing", async (t) => {
  const provider = { name: "main", async complete() { return { ...answer("done"), usage: { input: 900_000, output: 900_000 } }; } };
  const { app } = await fixture(t, provider, { presets: [{ id: "default", name: "Mystery", provider, model: "mystery-model-9" }] });
  saveKnobs(app.store, owner, "limits", { spendCapDollars: 0.01 });
  const run = await app.runtime.run({ prompt: "go" });
  const told = app.store.events(run.id).filter((e) => e.kind === "limits.spend_unpriced");
  assert.equal(told.length, 1);
  assert.match(told[0].data.message, /no price/i);
  const plain = await fixture(t, provider, { presets: [{ id: "default", name: "Mystery", provider, model: "mystery-model-9" }] });
  const quiet = await plain.app.runtime.run({ prompt: "go" });
  assert.equal(plain.app.store.events(quiet.id).filter((e) => e.kind === "limits.spend_unpriced").length, 0, "no cap, no note");
});

test("with thinking hidden, side questions and debate turns never carry it either", async (t) => {
  const provider = { name: "main", async complete() { return answer("<thinking>secret plan</thinking>Visible answer"); } };
  const { app } = await fixture(t, provider);
  const parent = await app.runtime.run({ prompt: "start" });
  const context = app.runtime.context({ runId: parent.id });
  const preset = app.runtime.models.presets.values().next().value;
  assert.match(await app.runtime.completeAside(parent, context, preset, "q"), /secret plan/, "shown as shipped");
  saveKnobs(app.store, owner, "reasoning", { showReasoning: false });
  assert.equal(await app.runtime.completeAside(parent, context, preset, "q2"), "Visible answer");
});

test("the launch file editor writes to the real file and never through a planted link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-launch-attack-"));
  t.after(() => discardTemp(root));
  const real = join(root, "real.json"), link = join(root, "branch.json"), victim = join(root, "victim.txt");
  await writeFile(real, JSON.stringify({ shell: { executables: { node: { path: process.execPath } }, timeoutMs: 30000 } }));
  await writeFile(victim, "untouched");
  await symlink(real, link);
  for (const guess of [`${link}.${process.pid}.saving`, `${real}.${process.pid}.saving`]) await symlink(victim, guess);
  await saveLaunchFile(link, { commandTimeoutSeconds: 20 });
  assert.equal(await readFile(victim, "utf8"), "untouched");
  assert.ok((await lstat(link)).isSymbolicLink(), "the owner's link is still a link");
  assert.equal(JSON.parse(await readFile(real, "utf8")).shell.timeoutMs, 20000);
});

test("pinned: every limit has a floor above zero and a ceiling", () => {
  const numbers = [];
  for (const [card, schema] of Object.entries(knobCards))
    for (const [field, type] of Object.entries(schema.shape)) {
      let inner = type;
      while (inner._zod.def.innerType) inner = inner._zod.def.innerType;
      if (inner._zod.def.type === "number") numbers.push([`${card}.${field}`, inner.minValue, inner.maxValue]);
    }
  assert.ok(numbers.length >= 14);
  const zeroAllowed = new Set(["limits.apiRetries", "memory.snapshotFacts", "memory.snapshotChars"]);
  for (const [name, min, max] of numbers) {
    assert.ok(Number.isFinite(max), `${name} has a ceiling`);
    assert.ok(min !== null && (zeroAllowed.has(name) ? min >= 0 : min > 0), `${name} has a floor above zero`);
  }
  for (const [name, min] of numbers.filter(([n]) => /Timeout|maxSteps|toolAnswer|contextWindow/.test(n)))
    assert.ok(min >= 1, `${name} can never be zero`);
});

test("behind the wall a passed value still reaches the program, and a planted proxy name never does", { skip: process.platform !== "darwin" && "sandbox-exec is macOS only" }, async (t) => {
  const { BranchShell } = await import("../dist/integrations/shell.js");
  const { commandTuning } = branch;
  const { mkdir, realpath } = await import("node:fs/promises");
  const { app } = await fixture(t, { name: "p", async complete() { return answer("ok"); } });
  await mkdir(app.runtime.workspace, { recursive: true });
  const source = { ...process.env, R17_REGION: "north", HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" };
  const shell = new BranchShell({ executables: { node: { path: process.execPath } } }, source);
  t.after(() => shell.close());
  shell.tuning = () => commandTuning(app.store, owner, source);
  // Written around the route, as an old import or a hand edit would: the start still refuses the proxy.
  app.store.save("settings", owner, "knobs-commands", { passEnvironment: ["R17_REGION", "HTTPS_PROXY", "https_proxy"] });
  const wall = { network: "none", keySites: {}, unreadable: [], answer: () => undefined, granted: () => [], spend() {} };
  const context = { ...app.runtime.context({ runId: "walled-run" }), workspace: await realpath(app.runtime.workspace), osSandbox: wall };
  const print = ["-e", "console.log(JSON.stringify([process.env.R17_REGION ?? null, process.env.HTTPS_PROXY ?? null, process.env.https_proxy ?? null]))"];
  const result = await shell.execute({ executable: "node", args: print }, context);
  assert.equal(result.status, "completed", result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["north", null, null]);
});

test("only the owner reads what the launch settings file sets up", async (t) => {
  const { startServer } = await import("../dist/server.js");
  const { app, root } = await fixture(t, { name: "p", async complete() { return answer("ok"); } });
  const launchFile = join(root, "integrations.json");
  await writeFile(launchFile, JSON.stringify({ shell: { executables: { "secret-deployer": { path: process.execPath } } } }));
  const before = process.env.BRANCH_INTEGRATIONS;
  process.env.BRANCH_INTEGRATIONS = launchFile;
  t.after(() => { if (before === undefined) delete process.env.BRANCH_INTEGRATIONS; else process.env.BRANCH_INTEGRATIONS = before; });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const look = async (token = server.token) => {
    const response = await fetch(server.url + "/api/knobs/launch-file", { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, text: await response.text() };
  };
  assert.match((await look()).text, /secret-deployer/, "the owner sees the programs");
  const key = app.sessionTokens.create(owner, { scope: "run", minutes: 5 });
  assert.doesNotMatch((await look(key.token)).text, /secret-deployer|integrations\.json/);
  const person = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: person.id, pin: "4321" });
  // Q261: reading fails closed for a household person at the window; the launch file is not in householdReads.
  const household = await look();
  assert.equal(household.status, 400);
  assert.doesNotMatch(household.text, /secret-deployer|integrations\.json/);
  assert.match(JSON.parse(household.text).error, /belongs to the owner/);
  app.store.profiles.switch({ profileId: null });
});

test("a background sub-task counts against a task that already finished, and nothing is left behind", async (t) => {
  const provider = { name: "main", async complete(request) {
    return { ...answer(request.messages.some((m) => m.content === "background child") ? "child done" : "parent done"), usage: { input: 100_000, output: 30_000 } };
  } };
  const { app } = await fixture(t, provider, { presets: [{ id: "default", name: "Priced", provider, model: "gpt-4o" }] });
  const parent = await app.runtime.run({ prompt: "parent" });
  assert.equal(parent.status, "completed");
  saveKnobs(app.store, owner, "limits", { spendCapDollars: 0.5 });
  const { childRunId } = await app.runtime.delegateBackground("background child", app.runtime.context({ runId: parent.id }), [], "");
  let child;
  for (let tries = 0; tries < 100 && !["completed", "failed", "cancelled", "budget_exceeded"].includes((child = app.store.run(childRunId))?.status); tries++)
    await new Promise((done) => setTimeout(done, 50));
  assert.notEqual(child.status, "completed", child.output);
  assert.match(child.output, /reaches the limit of \$0\.50/);
  assert.equal(app.runtime.spendRoot.size, 0);
  assert.equal(app.runtime.spendMembers.size, 0);
});
