import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * Wave 8: real sandboxes where this computer offers one, workspaces on another computer over SSH,
 * and the last of the approval-policy rows. Nothing here starts a container, a Linux distribution,
 * Windows Sandbox or an SSH connection: every outside program is a fake that records what it was
 * asked to do, which is the only way to assert the exact arguments anyway.
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-sandbox-remote-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}

/** A context good enough for a tool that only wants the workspace, a run id and a signal. */
const contextOf = (app, extra = {}) => ({
  // FQ-routing.isolated-agents: app.workspace was never a real field (app.runtime.workspace is); this
  // always fell back to "", unnoticed while every tool used here read the app's own captured workspace
  // instead of context.workspace. code.run reads context.workspace now, so it needs the real path.
  owner: "local", workspace: app?.runtime?.workspace ?? "", runId: "", signal: AbortSignal.timeout(10_000),
  budget: { step() {}, charge() {}, remaining: () => 1000, limits: { maxSteps: 9, maxTokens: 9 }, steps: 0, tokens: 0 },
  permissions: new Set(), depth: 0, ...extra,
});

/** A stand-in for every outside program: it answers, and remembers exactly what it was asked. */
function fakeWorld(answers = {}) {
  const calls = [];
  const probe = async (executable, args) => {
    calls.push({ kind: "probe", executable, args });
    const answer = answers[executable];
    if (!answer) return { code: null, stdout: "", stderr: "", missing: true };
    return { code: 0, stdout: answer.version ?? "1.0", stderr: "", missing: false };
  };
  const spawn = async (options) => {
    calls.push({ kind: "run", ...options });
    const answer = answers[options.executable];
    return { status: "completed", exitCode: 0, stdout: answer?.stdout ?? "", stderr: "",
      truncated: false, durationMs: 1 };
  };
  return { calls, probe, spawn, runs: () => calls.filter((c) => c.kind === "run") };
}

// ------------------------------------------------------------ A2131 / A2152 / A2160 / A2277 / A0797

test("A2277/A0797 an approval rule picks the backend, and code.run and process.start both honour it", async (t) => {
  const { app, workspace } = await fixture(t);
  const { PolicyRuleSchema, savePolicy, evaluatePolicy, readPolicy } = await import("../dist/policy.js");

  // The rule shape carries where a program runs and what it may see, alongside how tightly it is held.
  const rule = PolicyRuleSchema.parse({ tool: "code.run", decision: "allow", sandbox: "no-internet", backend: "docker", paths: ["reports"] });
  assert.equal(rule.backend, "docker");
  savePolicy(app.store, "local", { rules: [rule] });
  const { rule: matched } = evaluatePolicy(readPolicy(app.store, "local"), { tool: "code.run", target: "", readOnly: false });
  assert.equal(matched?.backend, "docker");
  assert.deepEqual(matched?.paths, ["reports"]);
  assert.ok(workspace);
});

test("A2152 the container backend builds the exact arguments, against a fake docker that never runs one", async (t) => {
  const { root } = await fixture(t);
  const { ContainerBackend, dockerArgv, SandboxBackendSettingsSchema } = await import("../dist/sandbox-backends.js");
  const world = fakeWorld({ docker: { version: "27.0.0", stdout: "42" } });
  const settings = SandboxBackendSettingsSchema.parse({ image: "node:22-alpine" });
  const backend = new ContainerBackend(settings, world.probe, world.spawn);
  assert.equal((await backend.available()).ok, true);

  const slice = { hostPath: join(root, "workspace") };
  const handle = await backend.prepare(slice);
  assert.equal(handle.mount, "/work");
  const limits = { timeoutMs: 5000, maxMemoryMb: 512, maxCpuSeconds: 20, maxOutputBytes: 8192, network: false, job: true };
  const result = await handle.run({ executable: "node", args: ["-e", "1"] }, limits, AbortSignal.timeout(5000));

  assert.equal(result.backend, "docker");
  assert.deepEqual(result.argv, ["docker", ...dockerArgv({ image: "node:22-alpine", hostPath: slice.hostPath, command: { executable: "node", args: ["-e", "1"] }, limits })]);
  assert.deepEqual(result.argv.slice(0, 12), ["docker", "run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1", "--read-only", "--workdir", "/work"]);
  assert.ok(result.argv.includes(`${slice.hostPath}:/work:rw`), "the folder is mounted read-write under /work");
  assert.ok(result.argv.includes("node:22-alpine"));
  // The fake was asked to start docker, and nothing else on this computer was started at all.
  assert.deepEqual(world.runs().map((c) => c.executable), ["docker"]);
  await handle.dispose();
});

test("A2131/A2160 a backend that is not on this computer refuses plainly and names what to install", async (t) => {
  await fixture(t);
  const { sandboxBackendSet, chooseSandboxBackend, SandboxBackendSettingsSchema } = await import("../dist/sandbox-backends.js");
  const world = fakeWorld({});  // nothing is installed
  const set = sandboxBackendSet({ settings: SandboxBackendSettingsSchema.parse({}), probe: world.probe, spawn: world.spawn });

  await assert.rejects(chooseSandboxBackend(set, "docker"), /Docker Desktop or Podman/);
  await assert.rejects(chooseSandboxBackend(set, "wsl"), /Windows Subsystem for Linux/);
  await assert.rejects(chooseSandboxBackend(set, "windows-sandbox"), /switch it on in Settings/);
  // The plain box is always there, and is what a call with no rule gets.
  assert.equal((await chooseSandboxBackend(set, null)).name, "job-object");
  // Nothing was ever started: only version questions were asked.
  assert.equal(world.runs().length, 0);
});

test("A2160 the Linux backend and the throwaway desktop make the files and arguments they promise", async (t) => {
  const { root } = await fixture(t);
  const { WslBackend, WindowsSandboxBackend, wslPath, windowsSandboxFile, SandboxBackendSettingsSchema } =
    await import("../dist/sandbox-backends.js");
  const slice = { hostPath: join(root, "workspace") };
  await mkdir(slice.hostPath, { recursive: true });
  await writeFile(join(slice.hostPath, "note.txt"), "hello", "utf8");
  const limits = { timeoutMs: 5000, maxMemoryMb: 256, maxCpuSeconds: 10, maxOutputBytes: 4096, network: false, job: true };

  assert.equal(wslPath("C:\\work\\thing"), "/mnt/c/work/thing");
  const wslWorld = fakeWorld({ "wsl.exe": { version: "2.0" } });
  const wsl = new WslBackend(SandboxBackendSettingsSchema.parse({ distro: "Ubuntu" }), wslWorld.probe, wslWorld.spawn);
  const wslHandle = await wsl.prepare(slice);
  const ran = await wslHandle.run({ executable: "python3", args: ["-c", "print(1)"] }, limits, AbortSignal.timeout(5000));
  assert.deepEqual(ran.argv.slice(0, 5), ["wsl.exe", "-d", "Ubuntu", "--cd", wslHandle.mount]);
  assert.deepEqual(ran.argv.slice(5), ["--", "python3", "-c", "print(1)"]);
  // The folder was copied in, not handed over: the copy has the file, and it is not the original.
  assert.notEqual(wslHandle.mount, slice.hostPath);
  await wslHandle.dispose();

  const wsbWorld = fakeWorld({ "WindowsSandbox.exe": { version: "" } });
  const wsb = new WindowsSandboxBackend(SandboxBackendSettingsSchema.parse({ windowsSandbox: true }), wsbWorld.probe, wsbWorld.spawn);
  const wsbHandle = await wsb.prepare(slice);
  const opened = await wsbHandle.run({ executable: "cmd.exe", args: ["/c", "dir"] }, limits, AbortSignal.timeout(5000));
  assert.equal(opened.argv[0], "WindowsSandbox.exe");
  assert.ok(opened.argv[1].endsWith(".wsb"));
  const written = await readFile(opened.argv[1], "utf8");
  assert.equal(written, windowsSandboxFile({ hostPath: slice.hostPath, command: { executable: "cmd.exe", args: ["/c", "dir"] } }));
  assert.match(written, /<HostFolder>/);
  assert.match(written, /<SandboxFolder>C:\\work<\/SandboxFolder>/);
  assert.match(written, /<ReadOnly>false<\/ReadOnly>/);
  assert.match(written, /<Networking>Disable<\/Networking>/);
  await wsbHandle.dispose();
});

// ------------------------------------------------------------------------------------ A1520

test("A1520 a script is read before anything is started, and a forbidden call or a network import refuses", async (t) => {
  await fixture(t);
  const { checkCodeBlock, maxScriptBytes } = await import("../dist/code-check.js");

  const spawning = checkCodeBlock("import { execSync } from 'node:child_process'; execSync('x')", { language: "javascript", network: true });
  assert.equal(spawning.ok, false);
  assert.deepEqual(spawning.found, ["start another program"]);
  assert.match(spawning.reason, /start another program/);

  const reaching = checkCodeBlock("import requests\nrequests.get('http://x')", { language: "python", network: false });
  assert.equal(reaching.ok, false);
  assert.deepEqual(reaching.found, ["reach the internet"]);
  // The same script is fine when the owner's rule lets it out.
  assert.equal(checkCodeBlock("import requests\nrequests.get('http://x')", { language: "python", network: true }).ok, true);

  assert.equal(checkCodeBlock("console.log(2 + 2)", { language: "javascript", network: false }).ok, true);
  const long = checkCodeBlock("x".repeat(maxScriptBytes + 1), { language: "javascript", network: false });
  assert.equal(long.ok, false);
  assert.match(long.reason, /Put it in a file/);
});

test("A1520/A0018 code.run refuses the forbidden script before it prepares anywhere to run it", async (t) => {
  const { app, root } = await fixture(t);
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const world = fakeWorld({ docker: { version: "27" } });
  const runner = new CodeRunner(app.store, "local", join(root, "workspace"), { create: async () => null }, world.probe, world.spawn);

  await assert.rejects(
    runner.run({ language: "javascript", source: "require('child_process')" }, contextOf(app)),
    /start another program/);
  // Nothing was prepared and nothing was started, not even a look for docker.
  assert.equal(world.calls.length, 0);
});

test("A0018/A2277 a rule's folder list is the only part of the workspace a sandboxed script can see", async (t) => {
  const { app, root } = await fixture(t);
  const workspace = join(root, "workspace");
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  const { sliceFor } = await import("../dist/sandbox-backends.js");
  await mkdir(join(workspace, "reports"), { recursive: true });
  await saveCodeRunSettings(app.store, "local", { enabled: true });

  assert.deepEqual(await sliceFor(workspace, []), { hostPath: workspace });
  assert.deepEqual(await sliceFor(workspace, ["reports"]), { hostPath: join(workspace, "reports") });
  await assert.rejects(sliceFor(workspace, ["../elsewhere"]), /relative to your workspace/);
  await assert.rejects(sliceFor(workspace, ["C:\\Windows"]), /relative to your workspace/);

  const world = fakeWorld({ docker: { version: "27" } });
  const runner = new CodeRunner(app.store, "local", workspace, { create: async () => null }, world.probe, world.spawn);
  const result = await runner.run({ language: "javascript", source: "console.log(1)" },
    contextOf(app, { sandboxBackend: "docker", sandboxPaths: ["reports"] }));
  assert.equal(result.backend, "docker");
  assert.equal(result.folder, "reports");
  // The mount is the one folder, not the workspace.
  const started = world.runs().at(-1);
  assert.ok(started.args.includes(`${join(workspace, "reports")}:/work:rw`));
  assert.ok(!started.args.some((a) => a === `${workspace}:/work:rw`));
});

// --------------------------------------------------------------------------- A1618 / A1413

test("A1618/A1413 the firewall card says the policy in sentences, and the test button asks the real check", async (t) => {
  await fixture(t);
  const { firewallView, testFirewall } = await import("../dist/firewall.js");
  const { NetworkPolicy, NetworkPolicySchema } = await import("../dist/network-policy.js");

  const policy = NetworkPolicySchema.parse({ allowedHosts: ["example.com", "docs.rs"], blockedHosts: ["ads.example.net"] });
  const view = firewallView({ policy, browserOrigins: ["https://example.com"], scriptsMayReachInternet: false, commandsMayReachInternet: false });
  assert.ok(view.sentences.includes("Scripts cannot reach the internet: they are pointed at an address that goes nowhere."));
  assert.ok(view.sentences.includes("Branch may only reach example.com and docs.rs, and nowhere else on the internet."));
  assert.ok(view.sentences.some((s) => s.startsWith("The browser may visit https://example.com.")));
  assert.ok(view.sentences.includes("Branch may never reach ads.example.net."));
  assert.equal(view.limited, true);

  // The button asks exactly the check every real request asks; no address is ever fetched.
  const net = new NetworkPolicy(policy, async () => ["93.184.216.34"]);
  const ok = await testFirewall((url) => net.assertAllowed(url), "https://example.com/a", ["https://example.com"]);
  assert.deepEqual([ok.allowed, ok.browserWouldOpen], [true, true]);
  const no = await testFirewall((url) => net.assertAllowed(url), "https://elsewhere.test/a", ["https://example.com"]);
  assert.equal(no.allowed, false);
  assert.match(no.reason, /not on the allowed list/);
  // On Branch's list, but not a website the browser may open: the card says both halves.
  const partly = await testFirewall((url) => net.assertAllowed(url), "https://docs.rs/x", ["https://example.com"]);
  assert.deepEqual([partly.allowed, partly.browserWouldOpen], [true, false]);
  assert.match(partly.reason, /the browser cannot open it/);
  assert.equal((await testFirewall((url) => net.assertAllowed(url), "not an address")).allowed, false);

  // A fake-IP proxy is said in a sentence of its own only when the owner switched it on, with who
  // then does the resolving; it changes nothing about the home network sentence beside it.
  const proxied = /fake-IP proxy/;
  assert.ok(!view.sentences.some((s) => proxied.test(s)), "nothing is said while it is off");
  const trusting = firewallView({ policy: NetworkPolicySchema.parse({ fakeIpProxy: true }) });
  const said = trusting.sentences.filter((s) => proxied.test(s));
  assert.equal(said.length, 1);
  assert.match(said[0], /198\.18\.0\.0\/15/);
  assert.match(said[0], /the proxy then does the resolving/);
  assert.ok(trusting.sentences.includes("Branch cannot reach other computers on your home network, or this computer itself."));
});

test("A1413 the browser refuses an address outside its own list and outside the network rules", async (t) => {
  await fixture(t);
  const { BranchBrowser } = await import("../dist/integrations/browser.js");
  const { NetworkPolicy } = await import("../dist/network-policy.js");
  const browser = new BranchBrowser({ allowedOrigins: ["https://example.com", "https://docs.rs"] });
  browser.policy = new NetworkPolicy({ allowedHosts: ["example.com"] }, async () => ["93.184.216.34"]);
  const context = contextOf(null, { runId: "r1" });

  // Not on the browser's own list: refused before a browser is even started.
  await assert.rejects(browser.navigate("https://elsewhere.test/", context), /not an allowed origin/);
  // On the browser's list, but the owner's network rules say no: refused by those rules.
  await assert.rejects(browser.navigate("https://docs.rs/", context), /not on the allowed list/);
  // An address carrying a password is refused whatever the lists say.
  await assert.rejects(browser.navigate("https://user:pw@example.com/", context), /not an allowed origin/);
  /* Integration review (adversarial): something that is not an address at all is refused in the
     same plain words, not with the URL parser's own "Invalid URL". */
  for (const nonsense of ["not a url", "", "://", "http://"])
    await assert.rejects(browser.navigate(nonsense, context), /not an allowed origin/, JSON.stringify(nonsense));
});

// --------------------------------------------------------------------------------- A2028

test("A2028 a fixed window holds the owner back for a moment and turns a stranger away with a sentence", async (t) => {
  const { app } = await fixture(t);
  const { SessionLimiter, saveSessionLimits, sessionLimits } = await import("../dist/session-limits.js");
  saveSessionLimits(app.store, "local", { requestsPerMinute: 2, tokensPerHour: 100, senderRequestsPerMinute: 1, senderTokensPerHour: 50 });
  assert.equal(sessionLimits(app.store, "local").requestsPerMinute, 2);

  let clock = 1_000_000;
  const limiter = new SessionLimiter(app.store, "local", () => clock);
  const conversation = { scope: "conversation", id: "s1" };

  assert.equal(limiter.check(conversation, "owner").ok, true);
  assert.equal(limiter.check(conversation, "owner").ok, true);
  const third = limiter.check(conversation, "owner");
  assert.equal(third.ok, false);
  assert.ok(third.waitMs > 0 && third.waitMs <= 60_000, "the owner is made to wait, not turned away");
  assert.equal(third.reason, "");
  assert.equal(limiter.used(conversation).requests, 2);

  // Somebody messaging from outside gets a sentence instead of a wait, and their message is let go.
  const stranger = { scope: "sender", id: "telegram:5551" };
  assert.equal(limiter.check(stranger, "stranger").ok, true);
  const turned = limiter.check(stranger, "stranger");
  assert.equal(turned.ok, false);
  assert.equal(turned.waitMs, 0);
  assert.match(turned.reason, /as much as Branch will do for one person right now/);
  assert.match(turned.reason, /Try again in about/);

  // The next minute starts a fresh window.
  clock += 60_000;
  assert.equal(limiter.check(conversation, "owner").ok, true);

  // Tokens have an hour of their own, and being refused does not spend the minute.
  const heavy = { scope: "conversation", id: "s2", tokens: 90 };
  assert.equal(limiter.check(heavy, "owner").ok, true);
  const over = limiter.check(heavy, "owner");
  assert.equal(over.ok, false);
  assert.equal(over.limit, "tokens");
  assert.equal(limiter.used({ scope: "conversation", id: "s2" }).requests, 1, "a refused request is not counted against the minute");

  // Every one of those is on the record.
  const written = app.store.audit.list("local", { action: "limit.reached" });
  assert.ok(written.length >= 3);
  assert.ok(written.some((entry) => entry.outcome === "discarded"));
  assert.ok(written.some((entry) => entry.outcome === "queued"));
});

// --------------------------------------------------------------------------------- A1770

test("A1770 a saved sign-in can be carried to another computer, sealed, and read back", async (t) => {
  const { root } = await fixture(t);
  const { BrowserProfiles } = await import("../dist/integrations/browser-profiles.js");
  const key = { key: async () => Buffer.alloc(32, 7) };
  const profiles = new BrowserProfiles(join(root, "profiles"), key);
  const state = { cookies: [{ name: "session", value: "abc123", domain: "example.com" }], origins: [{ origin: "https://example.com" }] };
  await profiles.save("local", "shop", state);
  assert.deepEqual((await profiles.list("local")).map((p) => p.name), ["shop"]);

  const bundle = await profiles.export("local", "shop", "a long enough passphrase");
  assert.ok(Buffer.isBuffer(bundle));
  // The secret is sealed: the cookie value is nowhere in the bytes that leave this computer.
  assert.equal(bundle.includes(Buffer.from("abc123", "utf8")), false);
  assert.equal(bundle.subarray(0, 16).toString("utf8"), "branch-signin-v1");

  const elsewhere = new BrowserProfiles(join(root, "other"), key);
  const restored = await elsewhere.import("local", bundle, "a long enough passphrase", "shop-copy");
  assert.equal(restored.name, "shop-copy");
  assert.deepEqual(await elsewhere.load("local", "shop-copy"), state);

  // The wrong passphrase, and a file that is not one of ours, both refuse plainly.
  await assert.rejects(elsewhere.import("local", bundle, "a different passphrase"), /Check the passphrase/);
  await assert.rejects(elsewhere.import("local", Buffer.from("hello there, not a bundle at all"), "a long enough passphrase"),
    /not a saved sign-in exported from Branch/);
  await assert.rejects(profiles.export("local", "shop", "short"), /./);
});

// ------------------------------------------------------------ A0329 / A0648 / A2279: another computer

/**
 * A stand-in for the OpenSSH programs. Nothing is ever connected: the fake records the exact
 * program and arguments it was handed, which is the only thing worth asserting here anyway.
 */
function fakeSsh(answers = {}) {
  const calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    const key = executable === "ssh" && args.length === 1 && args[0] === "-V" ? "ssh -V" : executable;
    const answer = answers[key] ?? {};
    return { status: answer.status ?? "completed", stdout: answer.stdout ?? "",
      stderr: answer.stderr ?? "", exitCode: answer.exitCode ?? 0 };
  };
  return { calls, run, last: () => calls.at(-1) };
}

/** The owner's own two SSH files, written where the test can point at them. */
async function sshHome(root, config, knownHosts) {
  const folder = join(root, `ssh-${Math.random().toString(36).slice(2)}`);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "config"), config, "utf8");
  await writeFile(join(folder, "known_hosts"), knownHosts, "utf8");
  return { config: join(folder, "config"), knownHosts: join(folder, "known_hosts") };
}

test("the SSH runner binds every tool to one resolved OpenSSH suite", async (t) => {
  const { root } = await fixture(t);
  const { resolveSshSuite, sshSuiteProgram } = await import("../dist/remote/ssh-workspace.js");
  const systemSuite = join(root, "Windows", "System32", "OpenSSH");
  const laterSuite = join(root, "later-on-path");
  const present = new Set([
    join(systemSuite, "ssh.exe"), join(systemSuite, "scp.exe"), join(systemSuite, "ssh-keygen.exe"),
    join(laterSuite, "ssh.exe"), join(laterSuite, "scp.exe"), join(laterSuite, "ssh-keygen.exe"),
  ].map((path) => path.toLowerCase()));
  const env = { SystemRoot: join(root, "Windows"), PATH: laterSuite };
  const suite = await resolveSshSuite("win32", env, async (path) => present.has(path.toLowerCase()));

  env.PATH = join(root, "older-mixed-suite");
  assert.equal(sshSuiteProgram(suite, "ssh"), join(systemSuite, "ssh.exe"));
  assert.equal(sshSuiteProgram(suite, "scp"), join(systemSuite, "scp.exe"));
  assert.equal(sshSuiteProgram(suite, "ssh-keygen"), join(systemSuite, "ssh-keygen.exe"));
});

test("an SSH suite missing its sibling scp fails closed instead of mixing PATH tools", async (t) => {
  const { root } = await fixture(t);
  const { resolveSshSuite } = await import("../dist/remote/ssh-workspace.js");
  const first = join(root, "first-suite"), later = join(root, "later-suite");
  const present = new Set([
    join(first, "ssh.exe"), join(first, "ssh-keygen.exe"),
    join(later, "ssh.exe"), join(later, "scp.exe"), join(later, "ssh-keygen.exe"),
  ].map((path) => path.toLowerCase()));
  const env = { SystemRoot: join(root, "missing-system-root"), PATH: `${first};${later}` };

  await assert.rejects(resolveSshSuite("win32", env, async (path) => present.has(path.toLowerCase())),
    /same OpenSSH folder.*scp|missing.*scp/i);
});

test("the sanitized Windows SSH environment preserves ProgramData case-insensitively", async () => {
  const { sshEnvironment } = await import("../dist/remote/ssh-workspace.js");
  const env = sshEnvironment({ PATH: "C:\\Windows\\System32", pRoGrAmDaTa: "C:\\ProgramData",
    UNRELATED_SECRET: "do not inherit" }, "win32");

  assert.equal(env.PROGRAMDATA, "C:\\ProgramData");
  assert.equal(env.UNRELATED_SECRET, undefined);
});

test("A0329/A2279 a computer can only be added by a name in the owner's own SSH config", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n  User me\n", "tower.lan ssh-ed25519 AAAA\n");
  const world = fakeSsh();
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);

  // A name the owner never wrote down cannot be added, however it is spelled.
  await assert.rejects(remotes.add({ alias: "stranger", root: "/srv/work" }), /not in your SSH config/);
  // Nor can a password be smuggled in: the shape has no field for one.
  await assert.rejects(remotes.add({ alias: "tower", root: "/srv/work", password: "hunter2" }), /./);

  const added = await remotes.add({ alias: "tower", root: "/srv/work", label: "The tower" });
  assert.equal(added.alias, "tower");
  assert.deepEqual(added.executables, [], "a new computer may run nothing at all until the owner says so");
  assert.equal(remotes.list().length, 1);
  assert.equal(remotes.get("tower").root, "/srv/work");
  assert.throws(() => remotes.get("nowhere"), /not one of the computers/);
  assert.equal(remotes.remove("tower"), true);
  assert.equal(remotes.remove("tower"), false);
});

test("A0329 a computer whose key the owner has never accepted is refused, never trusted", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, sshOptions } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "somewhere-else.example ssh-ed25519 AAAA\n");
  // ssh-keygen -F is the last word on a known_hosts file whose names are hidden; here it finds nothing.
  const world = fakeSsh({ "ssh-keygen": { exitCode: 1, stdout: "" } });
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);

  await assert.rejects(remotes.add({ alias: "tower", root: "/srv/work" }), /never seen tower.lan before/);
  assert.equal(remotes.list().length, 0, "nothing is saved when the key is not already accepted");
  // And Branch never asks ssh to stop checking: the options it forces say the opposite.
  assert.ok(sshOptions.includes("StrictHostKeyChecking=yes"));
  assert.ok(sshOptions.includes("PasswordAuthentication=no"));
  assert.ok(sshOptions.includes("BatchMode=yes"));
  assert.equal(sshOptions.includes("StrictHostKeyChecking=no"), false);
});

test("A2279 files on another computer stay inside that computer's own folder", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, remotePath } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "tower.lan ssh-ed25519 AAAA\n");
  const world = fakeSsh({ ssh: { stdout: "march.csv\nnotes.md\n" } });
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);
  await remotes.add({ alias: "tower", root: "/srv/work" });

  const listed = await remotes.files("tower", "reports", AbortSignal.timeout(5000));
  assert.deepEqual(listed.entries, ["march.csv", "notes.md"]);
  // The alias is what goes on the command line, never the real name behind it.
  const call = world.last();
  assert.equal(call.executable, "ssh");
  assert.equal(call.args.includes("tower"), true);
  assert.equal(call.args.includes("tower.lan"), false);
  assert.deepEqual(call.args.slice(call.args.indexOf("tower")),
    ["tower", "--", "'ls' '-1A' '--' '/srv/work/reports'"]);

  // Every way out of the folder is refused before anything is sent.
  assert.equal(remotePath("/srv/work", "reports/march.csv"), "/srv/work/reports/march.csv");
  assert.throws(() => remotePath("/srv/work", "../../etc/passwd"), /traversal/);
  assert.throws(() => remotePath("/srv/work", "/etc/passwd"), /inside that computer/);
  assert.throws(() => remotePath("/srv/work", "~/.ssh/id_ed25519"), /inside that computer/);
  assert.throws(() => remotePath("/srv/work", "C:\\Windows"), /inside that computer/);
  await assert.rejects(remotes.read("tower", "../secrets.txt", AbortSignal.timeout(5000)), /traversal/);
});

test("A0648 a computer may only run the programs the owner allowed, and the card names the computer", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, registerRemoteWorkspaces, explainSsh } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "tower.lan ssh-ed25519 AAAA\n");
  const world = fakeSsh({ ssh: { stdout: "ok\n" } });
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);
  await remotes.add({ alias: "tower", root: "/srv/work", executables: ["make"] });

  await assert.rejects(remotes.execute("tower", "rm", ["-rf", "/"], AbortSignal.timeout(5000)),
    /"rm" is not one of the programs tower is allowed to run/);
  const done = await remotes.execute("tower", "make", ["build"], AbortSignal.timeout(5000));
  assert.equal(done.output.trim(), "ok");
  assert.deepEqual(world.last().args.slice(-2), ["--", "'make' 'build'"]);

  // The approval card says which computer, so a yes is never given blind. The app registers these
  // at start-up, so registering them again is refused: that is the wiring, asserted.
  assert.throws(() => registerRemoteWorkspaces(app.registry, remotes), /duplicate tool name/);
  const context = contextOf(app);
  assert.equal(app.registry.targetOf("remote.run", { computer: "tower", program: "make", args: ["build"] }, context),
    "tower: make build");
  assert.equal(app.registry.targetOf("remote.files", { computer: "tower", path: "reports" }, context), "tower: reports");
  // Running a program on another computer is its own permission: allowing commands here must not
  // quietly allow them there.
  assert.equal(app.registry.permissionOf("remote.run"), "remote.execute");
  assert.equal(app.registry.permissionOf("remote.read"), "files.read");

  // Ssh's own wording is turned into something the owner can act on.
  assert.match(explainSsh("tower", { status: "completed", stderr: "Host key verification failed." }), /different key/);
  assert.match(explainSsh("tower", { status: "completed", stderr: "Permission denied (publickey)." }), /never uses a password/);
  assert.match(explainSsh("tower", { status: "timed_out", stderr: "" }), /did not answer in time/);
});

test("remote OpenSSH quotes commands while modern scp receives raw SFTP path data", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, quoteRemoteArg, remoteCommand, remotePath } =
    await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "tower.lan ssh-ed25519 AAAA\n");
  const world = fakeSsh({ ssh: { stdout: "ok\n" },
    "ssh -V": { stderr: "OpenSSH_for_Windows_9.8p1, LibreSSL 3.3.6" } });
  const remoteRoot = "/srv/team's work;$(touch nope)`id`/*";
  const program = "tool name's;$(bad)`bad`*";
  const relativePath = "reports/Q1 O'Brien;$(bad)`bad`[abc]*.txt";
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);
  await remotes.add({ alias: "tower", root: remoteRoot, executables: [program] });

  assert.equal(quoteRemoteArg("O'Brien's file"), "'O'\"'\"'Brien'\"'\"'s file'");
  assert.equal(remoteCommand(["tool name", "O'Brien", ";", "$()", "`id`", "*.txt"]),
    ["'tool name'", "'O'\"'\"'Brien'", "';'", "'$()'", "'`id`'", "'*.txt'"].join(" "));

  await remotes.files("tower", relativePath, AbortSignal.timeout(5000));
  const listed = world.last();
  const listedTarget = remotePath(remoteRoot, relativePath);
  assert.deepEqual(listed.args.slice(listed.args.indexOf("tower") + 1),
    ["--", remoteCommand(["ls", "-1A", "--", listedTarget])],
    "ssh must receive exactly one serialized command after the alias separator");
  assert.match(listed.args.at(-1), /^'ls' '-1A' '--' '/);
  assert.match(listed.args.at(-1), /'\"'\"'/, "apostrophes stay inside the quoted argument");

  const commandArgs = ["ordinary space", "O'Brien", "; touch nope", "$(touch nope)", "`touch nope`", "*.txt"];
  await remotes.execute("tower", program, commandArgs, AbortSignal.timeout(5000));
  assert.deepEqual(world.last().args.slice(world.last().args.indexOf("tower") + 1),
    ["--", remoteCommand([program, ...commandArgs])]);

  await remotes.write("tower", relativePath, join(root, "local file.txt"), AbortSignal.timeout(5000));
  assert.equal(world.last().executable, "scp");
  assert.deepEqual(world.calls.at(-2), { executable: "ssh", args: ["-V"] });
  assert.equal(world.last().args.includes("-s"), false, "-s is not treated as an SFTP capability switch");
  assert.equal(world.last().args.at(-1), `tower:${listedTarget}`);
  assert.notEqual(world.last().args.at(-1), `tower:${quoteRemoteArg(listedTarget)}`,
    "SFTP path data must not contain shell-quote characters");
});

test("remote writes refuse pre-9 or unknown OpenSSH clients before scp starts", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "tower.lan ssh-ed25519 AAAA\n");
  const setup = fakeSsh();
  const remotes = new RemoteWorkspaces(app.store, "local", setup.run, home);
  await remotes.add({ alias: "tower", root: "/srv/work" });

  const unsupported = [
    { stderr: "OpenSSH_8.9p1, LibreSSL 3.3.6" },
    { stderr: "Dropbear ssh client v2025.88" },
    { stderr: "", exitCode: 1 },
  ];
  for (const answer of unsupported) {
    const world = fakeSsh({ "ssh -V": answer });
    const guarded = new RemoteWorkspaces(app.store, "local", world.run, home);
    await assert.rejects(guarded.write("tower", "report's final;*.txt", join(root, "local.txt"),
      AbortSignal.timeout(5000)), /OpenSSH 9 or newer/);
    assert.deepEqual(world.calls, [{ executable: "ssh", args: ["-V"] }],
      "an unsupported client may be probed but must never start scp");
  }
});

test("remote OpenSSH rejects NUL, CR and LF before spawning", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteComputerSchema, RemoteReadSchema, RemoteRunSchema, RemoteWorkspaces,
    quoteRemoteArg, remoteCommand } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "tower.lan ssh-ed25519 AAAA\n");
  const world = fakeSsh();
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);

  assert.throws(() => remoteCommand([]), /at least one argument/i);
  for (const control of ["\0", "\r", "\n"]) {
    for (const value of [`${control}bad`, `bad${control}value`, `bad${control}`]) {
      assert.throws(() => quoteRemoteArg(value), /NUL|line break|control/i);
      assert.throws(() => remoteCommand(["safe", value]), /NUL|line break|control/i);
    }
    for (const rootValue of [`${control}/srv/work`, `/srv/bad${control}root`, `/srv/work${control}`])
      assert.equal(RemoteComputerSchema.safeParse({ alias: "tower", root: rootValue }).success, false);
    for (const program of [`${control}program`, `bad${control}program`, `program${control}`]) {
      assert.equal(RemoteComputerSchema.safeParse({ alias: "tower", root: "/srv/work",
        executables: [program] }).success, false);
      assert.equal(RemoteRunSchema.safeParse({ computer: "tower", program }).success, false);
    }
    for (const pathValue of [`${control}path`, `bad${control}path`, `path${control}`])
      assert.equal(RemoteReadSchema.safeParse({ computer: "tower", path: pathValue }).success, false);
    for (const arg of [`${control}arg`, `bad${control}arg`, `arg${control}`])
      assert.equal(RemoteRunSchema.safeParse({ computer: "tower", program: "safe", args: [arg] }).success, false);
    await assert.rejects(remotes.add({ alias: "tower", root: `${control}/srv/work` }), /./);
    await assert.rejects(remotes.add({ alias: "tower", root: `/srv/work${control}` }), /./);
    await assert.rejects(remotes.add({ alias: "tower", root: "/srv/work",
      executables: [`${control}program`] }), /./);
    await assert.rejects(remotes.add({ alias: "tower", root: "/srv/work",
      executables: [`program${control}`] }), /./);
  }
  assert.equal(world.calls.length, 0, "invalid roots and allowed program names never start OpenSSH");

  await remotes.add({ alias: "tower", root: "/srv/work", executables: ["safe"] });
  const callsBefore = world.calls.length;
  for (const control of ["\0", "\r", "\n"]) {
    for (const program of [`${control}safe`, `sa${control}fe`, `safe${control}`])
      await assert.rejects(remotes.execute("tower", program, [], AbortSignal.timeout(5000)),
        /NUL|line break|control/i);
    for (const pathValue of [`${control}path`, `bad${control}path`, `path${control}`])
      await assert.rejects(remotes.read("tower", pathValue, AbortSignal.timeout(5000)),
        /NUL|line break|control/i);
    for (const arg of [`${control}arg`, `bad${control}arg`, `arg${control}`])
      await assert.rejects(remotes.execute("tower", "safe", [arg], AbortSignal.timeout(5000)),
        /NUL|line break|control/i);
    const afterLimit = [...Array(32).fill("safe"), `bad${control}arg`];
    await assert.rejects(remotes.execute("tower", "safe", afterLimit, AbortSignal.timeout(5000)),
      /NUL|line break|too big|32/i);
  }
  await assert.rejects(remotes.execute("tower", "safe", Array(33).fill("safe"), AbortSignal.timeout(5000)),
    /too big|32/i);
  assert.equal(world.calls.length, callsBefore, "invalid remote text is rejected before OpenSSH is spawned");
});

// ------------------------------------------------------------ A0544 / A1582: a way back, and a line of work

/** A stand-in for git. No repository is touched; the calls are what matter. */
function fakeGit(answers = {}) {
  const calls = [];
  const run = async (cwd, args) => {
    calls.push({ cwd, args });
    const answer = answers[args.join(" ")] ?? answers[args[0]] ?? {};
    return { status: answer.status ?? "completed", stdout: answer.stdout ?? "",
      stderr: answer.stderr ?? "", exitCode: answer.exitCode ?? 0 };
  };
  return { calls, run, args: () => calls.map((call) => call.args.join(" ")) };
}

test("A0544 a mark is made before a change set is written, and undo puts the files back", async (t) => {
  const { app } = await fixture(t);
  const { GitCheckpoints } = await import("../dist/git-checkpoint.js");
  const commit = "a".repeat(40);
  const git = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "true" }, stash: { stdout: `${commit}\n` } });
  const marks = new GitCheckpoints(app.store, "local", git.run);

  const mark = await marks.before("C:/work", "writing 4 files", AbortSignal.timeout(5000));
  assert.ok(mark, "a repository gets a mark");
  assert.equal(mark.commit, commit);
  assert.match(mark.ref, /^refs\/branch\/checkpoints\//, "the mark lives on a ref of Branch's own");
  // It is made without disturbing the folder, the index, or the shared stash list.
  assert.ok(git.args().includes("stash create writing 4 files"));
  assert.equal(git.args().some((line) => /^stash (push|pop|save|apply)/.test(line)), false);
  assert.ok(git.args().some((line) => line === `update-ref ${mark.ref} ${commit}`));
  assert.deepEqual(marks.list().map((entry) => entry.id), [mark.id]);

  const back = await marks.undo(mark.id, AbortSignal.timeout(5000));
  assert.equal(back.commit, commit);
  assert.equal(git.args().at(-1), `checkout ${commit} -- .`);
  await assert.rejects(marks.undo("no-such-mark", AbortSignal.timeout(5000)), /no saved way back/);

  assert.equal(await marks.forget(mark.id), true);
  assert.equal(git.args().at(-1), `update-ref -d ${mark.ref}`);
  assert.deepEqual(marks.list(), []);
});

test("A0544 a folder that is not kept in Git gets no mark, and the change says so rather than failing", async (t) => {
  const { app, workspace } = await fixture(t);
  const { GitCheckpoints } = await import("../dist/git-checkpoint.js");
  const git = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "not a repository", exitCode: 128 } });
  const marks = new GitCheckpoints(app.store, "local", git.run);
  assert.equal(await marks.before("C:/plain", "writing 1 file", AbortSignal.timeout(5000)), null);
  assert.deepEqual(marks.list(), []);

  // The change tool asks for a mark before it writes, and reports what it got back either way.
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "hello there", "utf8");
  const asked = [];
  app.codeChanges.checkpoints = {
    async before(folder, label) { asked.push({ folder, label, wrote: await readFile(join(workspace, "notes.md"), "utf8") }); return { id: "mark-1" }; },
  };
  const context = contextOf(app, { workspace });
  const written = await app.codeChanges.changeSet(
    { reason: "tidy the note", edits: [{ path: "notes.md", find: "hello", replace: "goodbye", expectedOccurrences: 1 }], dryRun: false }, context);
  assert.equal(written.applied, true);
  assert.equal(written.undo.id, "mark-1");
  assert.equal(asked.length, 1, "the mark is taken before anything is written");
  assert.equal(asked[0].wrote, "hello there", "and taken while the file is still as it was");
  assert.match(asked[0].label, /notes\.md/);
  assert.equal(await readFile(join(workspace, "notes.md"), "utf8"), "goodbye there");

  app.codeChanges.checkpoints = { async before() { return null; } };
  const plain = await app.codeChanges.changeSet(
    { reason: "tidy it again", edits: [{ path: "notes.md", find: "goodbye", replace: "hello", expectedOccurrences: 1 }], dryRun: false }, context);
  assert.equal(plain.undo.id, "");
  assert.match(plain.undo.note, /not kept in Git/);
});

test("A1582 a project may name a line of work, and switching to it switches the folder", async (t) => {
  const { app } = await fixture(t);
  const { GitCheckpoints, GitWorkspaces } = await import("../dist/git-checkpoint.js");
  const clean = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "true" }, "status --porcelain": { stdout: "" } });
  const workspaces = new GitWorkspaces(new GitCheckpoints(app.store, "local", clean.run), clean.run);

  const done = await workspaces.switchTo("C:/work", "accounts", AbortSignal.timeout(5000));
  assert.equal(done.switched, true);
  assert.equal(done.reason, 'Now working on "accounts".');
  assert.ok(clean.args().includes("switch accounts"));

  // Work not saved yet is left exactly where it is: switching must never lose anything.
  const dirty = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "true" }, "status --porcelain": { stdout: " M notes.md" } });
  const careful = new GitWorkspaces(new GitCheckpoints(app.store, "local", dirty.run), dirty.run);
  const held = await careful.switchTo("C:/work", "accounts", AbortSignal.timeout(5000));
  assert.equal(held.switched, false);
  assert.match(held.reason, /changes not saved yet/);
  assert.equal(dirty.args().some((line) => line.startsWith("switch")), false);

  // A name that could carry an option, and a folder that is not a repository, are both refused plainly.
  assert.match((await careful.switchTo("C:/work", "--exec=calc", AbortSignal.timeout(5000))).reason, /not a name a line of work can have/);
  const plain = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "no", exitCode: 128 } });
  const none = new GitWorkspaces(new GitCheckpoints(app.store, "local", plain.run), plain.run);
  assert.match((await none.switchTo("C:/work", "accounts", AbortSignal.timeout(5000))).reason, /not a repository/);

  // The project itself carries the name, and says so to whoever is listening when it becomes active.
  const heard = [];
  app.store.projects.onSwitched((owner, project) => heard.push(project.branch));
  app.store.projects.save("local", { id: "site", name: "The website", branch: "rewrite" });
  app.store.projects.setActive("local", { active: "site" });
  assert.deepEqual(heard, ["rewrite"]);
});

// ------------------------------------------------------------ the screens these modules were missing

/** The app behind a real HTTP door, so the screens are asked for exactly as the browser asks. */
async function served(t) {
  const made = await fixture(t);
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(made.app, { dataDir: join(made.root, "data"), port: 0, presence: "daemon" });
  t.after(() => server.close());
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* some answers are not JSON */ }
    return { status: response.status, body: parsed, text };
  };
  return { ...made, server, api };
}

test("A1618/A1413/A2028 the firewall card, the ceilings and the sandbox choice all have a way in", async (t) => {
  const { api } = await served(t);

  const firewall = await api("GET", "/api/firewall");
  assert.equal(firewall.status, 200);
  assert.ok(firewall.body.sentences.length >= 4, "the card is sentences, not a list of rules");
  assert.ok(firewall.body.sentences.some((line) => line.startsWith("The browser has no websites set up")));
  assert.ok(firewall.body.sentences.some((line) => /Scripts cannot reach the internet/.test(line)));

  // The test button asks the check every real request asks; nothing is fetched.
  const tried = await api("POST", "/api/firewall/test", { address: "https://example.com/a" });
  assert.equal(tried.status, 200);
  assert.equal(typeof tried.body.allowed, "boolean");
  assert.equal((await api("POST", "/api/firewall/test", { address: "not an address" })).body.allowed, false);

  // The ceilings are the owner's to set and to read back.
  assert.equal((await api("GET", "/api/limits")).body.limits.requestsPerMinute, 0);
  const saved = await api("POST", "/api/limits", { requestsPerMinute: 12, tokensPerHour: 0, senderRequestsPerMinute: 4, senderTokensPerHour: 0 });
  assert.equal(saved.body.limits.requestsPerMinute, 12);
  assert.equal((await api("GET", "/api/limits")).body.limits.senderRequestsPerMinute, 4);

  // Where scripts run: the owner's choice, and an honest list of what this computer can offer.
  const sandboxes = await api("GET", "/api/sandboxes");
  assert.equal(sandboxes.status, 200);
  assert.equal(sandboxes.body.settings.windowsSandbox, false, "the throwaway desktop is never the default");
  assert.deepEqual(sandboxes.body.backends.map((entry) => entry.name), ["job-object", "docker", "wsl", "windows-sandbox"]);
  assert.equal(sandboxes.body.backends[0].available, true, "the plain box is always there");
  for (const entry of sandboxes.body.backends)
    if (!entry.available) assert.ok(entry.reason.length > 20, "an unavailable one says what to install");
});

test("A0329/A0544 the other computers and the marks are reachable, and both refuse plainly", async (t) => {
  const { api } = await served(t);

  assert.deepEqual((await api("GET", "/api/remotes")).body.computers, []);
  // A name the owner never wrote in their own SSH config cannot be added through the screen either.
  const refused = await api("POST", "/api/remotes", { alias: "stranger", root: "/srv/work" });
  assert.equal(refused.status, 400);
  assert.match(refused.text, /SSH config/);
  assert.equal((await api("POST", "/api/remotes/remove", { computer: "stranger" })).body.removed, false);

  assert.deepEqual((await api("GET", "/api/marks")).body.marks, []);
  const noMark = await api("POST", "/api/marks/undo", { id: "nothing" });
  assert.equal(noMark.status, 400);
  assert.match(noMark.text, /no saved way back/);
});

// ------------------------------------------------------------ A2344: letting old conversations go


test("A2344 the size a conversation counts as is its words and its files, and an unreadable one is never the one offered", async (t) => {
  // "Keep everything under N MB" measured message JSON alone, so a conversation holding thirty
  // megabytes of video counted as a few kilobytes and the rule was blind to the only thing that now
  // makes a conversation big. It counts the files now. Nothing is deleted without the owner's yes,
  // so an honest number changes what is *offered*, never what goes — which is the whole boundary.
  const { app } = await fixture(t);
  const { ConversationRetention, saveRetentionSettings, sentenceFor, retentionSettings } =
    await import("../dist/retention.js");

  const light = app.store.createSession("local");
  app.store.message(light, { role: "user", content: "a few words" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const heavy = app.store.createSession("local");
  const film = { id: "0123456789abcdef", kind: "video", mediaType: "video/mp4", name: "film.mp4", bytes: 30 * 1024 * 1024 };
  app.store.message(heavy, { role: "user", content: "a few words, and a film", attachments: [film] });
  app.attachments.writeInto(heavy, [{ ref: film, bytes: Buffer.alloc(30 * 1024 * 1024, 7) }]);

  saveRetentionSettings(app.store, "local", { enabled: true, keepDays: 0, megabytes: 20, exportBeforeDeleting: false });
  assert.match(sentenceFor(retentionSettings(app.store, "local")), /the words and the files attached to them/,
    "and the rule says what it counts, rather than leaving the owner to find out");

  const proposal = new ConversationRetention(app.store, "local").propose();
  assert.ok(proposal.bytes > 30 * 1024 * 1024, `the history is measured as what it really is (${proposal.bytes})`);
  assert.deepEqual(proposal.conversations.map((entry) => entry.sessionId), [light, heavy],
    "oldest first, as it always did, until the history fits again");
  for (const entry of proposal.conversations)
    assert.match(entry.why, /once the files attached to it are counted/,
      "every one of them says the files are why, because until now they were not counted at all");

  // Nothing has gone. That is the boundary: counting honestly proposes more, and deletes nothing.
  const looked = new ConversationRetention(app.store, "local").prune({ approve: false });
  assert.equal(looked.deleted, false);
  assert.equal(app.store.messages(light).length, 1);
  assert.equal(app.store.messages(heavy).length, 1);

  // A conversation whose files cannot be measured still counts towards the total — leaving it out
  // would make the history look smaller than it is — but it is never the one offered up.
  const unreadable = app.store.createSession("local");
  app.store.message(unreadable, { role: "user", content: "a film nobody can measure", attachments: [film] });
  app.attachments.writeInto(unreadable, [{ ref: film, bytes: Buffer.alloc(1024, 3) }]);
  await writeFile(join(app.attachments.root, unreadable.replace(/[^a-z0-9]/gi, ""), "kept.json"), "{ not a listing");

  const second = new ConversationRetention(app.store, "local").propose();
  assert.ok(second.bytes > 60 * 1024 * 1024,
    `what cannot be read is still counted, from what the messages say (${second.bytes})`);
  assert.equal(second.conversations.some((entry) => entry.sessionId === unreadable), false,
    "but it is not offered for deletion on the strength of a number nobody could check");
});


test("A2344 old conversations are proposed, exported, and deleted only on the owner's yes", async (t) => {
  const { app } = await fixture(t);
  const { ConversationRetention, retentionSettings, saveRetentionSettings, sentenceFor } =
    await import("../dist/retention.js");

  // Off by default: nothing is ever proposed, and the sentence says exactly that.
  const retention = new ConversationRetention(app.store, "local");
  assert.equal(retentionSettings(app.store, "local").enabled, false);
  assert.match(sentenceFor(retentionSettings(app.store, "local")), /kept for ever/);
  assert.deepEqual(retention.propose().conversations, []);

  // Two conversations, and a clock moved a year on so the first one really is old.
  const old = app.store.createSession("local");
  app.store.message(old, { role: "user", content: "the old one" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = app.store.createSession("local");
  app.store.message(fresh, { role: "user", content: "the new one" });
  const madeAt = Date.now();
  const later = new ConversationRetention(app.store, "local", () => madeAt + 200 * 86_400_000);

  saveRetentionSettings(app.store, "local", { enabled: true, keepDays: 90, megabytes: 0, exportBeforeDeleting: true });
  const proposal = later.propose();
  assert.deepEqual(proposal.conversations.map((entry) => entry.sessionId).sort(), [old, fresh].sort(),
    "with the clock 200 days on, both are older than 90 days");
  assert.match(proposal.conversations[0].why, /older than 90 days/);
  assert.match(proposal.sentence, /It always asks first/);

  // Pressing it without the yes changes nothing at all.
  const looked = later.prune({ approve: false });
  assert.equal(looked.deleted, false);
  assert.equal(looked.removed.length, 0);
  assert.equal(app.store.messages(old).length, 1, "nothing was deleted without a yes");

  // With the yes: a saved copy comes back first, and only the old one goes.
  const done = new ConversationRetention(app.store, "local", () => madeAt + 200 * 86_400_000)
    .prune({ approve: true, sessionIds: [old] });
  assert.equal(done.deleted, true);
  assert.deepEqual(done.removed, [old], "only the one the owner chose goes");
  assert.equal(done.exported.length, 1);
  assert.equal(done.exported[0].archive.format, "branch-agent-conversation");
  assert.equal(done.exported[0].archive.messages[0].content, "the old one");
  assert.equal(app.store.messages(old).length, 0);
  assert.equal(app.store.messages(fresh).length, 1, "the one the owner did not choose is left alone");

  // And it is written into the record.
  const written = app.store.audit.list("local", { action: "history.pruned" });
  assert.equal(written.length, 1);
  assert.equal(written[0].outcome, "deleted");
  assert.match(written[0].reason, /saved copy/);
});

test("A2344 the rule can also be about size, and the screen never deletes by itself", async (t) => {
  const { app, api } = await served(t);
  const first = app.store.createSession("local"), second = app.store.createSession("local");
  app.store.message(first, { role: "user", content: "x".repeat(4000) });
  app.store.message(second, { role: "user", content: "y".repeat(4000) });

  // Saving the rule answers with what it would sweep up, and deletes nothing.
  const saved = await api("POST", "/api/retention", { enabled: true, keepDays: 0, megabytes: 1, exportBeforeDeleting: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.megabytes, 1);
  assert.match(saved.body.sentence, /once everything together . the words and the files attached to them . is over 1 MB/);
  assert.deepEqual(saved.body.conversations, [], "8 KB is nowhere near 1 MB, so nothing is proposed");
  assert.ok(saved.body.bytes >= 8000, "the card knows how big the whole history is");

  // A ceiling the history really is over: the oldest are proposed until it fits again.
  const { ConversationRetention } = await import("../dist/retention.js");
  app.store.save("settings", "local", "retention", { enabled: true, keepDays: 0, megabytes: 0, exportBeforeDeleting: true });
  const tight = app.store.prunableSessions("local", 0, 1);
  assert.deepEqual(tight.conversations, [], "1 MB is not reached, so the size rule proposes nothing");
  const tiny = new ConversationRetention(app.store, "local");
  assert.deepEqual(tiny.propose().conversations, [], "no rule at all proposes nothing");

  // Asking for the rule, and saving it, never deleted anything.
  assert.equal(app.store.messages(first).length, 1);
  assert.equal(app.store.messages(second).length, 1);
  const looked = await api("POST", "/api/retention/prune", { approve: false });
  assert.equal(looked.body.deleted, false);
  assert.equal(app.store.messages(first).length, 1);
});

// ------------------------------------------------------------ A2233: what a manifest asked for

test("A2233 a package's calls are narrowed to what the owner allowed, and cannot wander off", async (t) => {
  const { app } = await fixture(t);
  const { packSkill, declaredHosts, requestedPermissions } = await import("../dist/skill-package.js");
  const { grantAll, narrowTools, assertDeclaredHost } = await import("../dist/manifest-permissions.js");

  const files = {
    "SKILL.md": "---\nname: weather\ndescription: Says what the weather is\n---\n\nAsk the service.\n",
    "tools.json": JSON.stringify({ tools: [{
      name: "forecast", description: "Today's weather", method: "GET",
      url: "https://api.weather.test/today?place={{place}}",
      input: { place: { type: "string", required: true } }, headers: {}, body: {}, pick: [],
    }] }),
  };
  const bytes = packSkill({ files, author: "Someone", packageVersion: "1.0.0" });

  // What the owner is shown before they say yes: the permissions and every address by name.
  const preview = app.skillPackages.inspect(bytes);
  assert.deepEqual(preview.hosts, ["api.weather.test"]);
  assert.ok(preview.permissions.some((entry) => entry.permission === "skills.http"));
  assert.deepEqual(declaredHosts(files), ["api.weather.test"]);
  assert.ok(requestedPermissions(files).length >= 2);

  // Allowing only the reading half leaves the web call out of the catalog altogether.
  const narrow = app.skillPackages.install(bytes, true, ["skills.read"]);
  assert.equal(narrow.installed, true);
  assert.deepEqual(narrow.grant.permissions, ["skills.read"]);
  assert.equal(app.registry.names().some((name) => name.startsWith("skill.weather.")), false,
    "a call the owner did not allow is never registered, so nothing can call it");
  assert.ok(narrow.leftOut.some((line) => /did not allow "skills.http"/.test(line)));
  assert.ok(app.skillPackages.list().some((entry) => entry.leftOut.length === 1));

  // Allowing everything it asked for puts the call in, and its address is remembered.
  app.store.skills.remove("local", narrow.skill.id, { expectedRevision: narrow.skill.revision });
  app.skillPackages.forget(narrow.skill.id);
  const full = app.skillPackages.install(bytes, true);
  assert.deepEqual(full.grant.hosts, ["api.weather.test"]);
  assert.ok(app.registry.names().includes("skill.weather.forecast"));
  assert.deepEqual(full.leftOut, []);

  // And the address is held to at the moment of the call, not only when the package was read.
  const grant = grantAll({ permissions: [{ permission: "skills.http", why: "" }], hosts: ["api.weather.test"] });
  assert.doesNotThrow(() => assertDeclaredHost(grant, new URL("https://api.weather.test/today"), "the tool"));
  assert.throws(() => assertDeclaredHost(grant, new URL("https://somewhere.else.test/x"), "the tool"),
    /not one of the addresses you were shown/);
  // Narrowing is the enforcement: a tool outside the grant is simply not there.
  const { kept, left } = narrowTools([{ name: "a", permission: "skills.http" }, { name: "b", permission: "skills.read" }],
    grantAll({ permissions: [{ permission: "skills.read", why: "" }], hosts: [] }));
  assert.deepEqual(kept.map((tool) => tool.name), ["b"]);
  assert.deepEqual(left.map((tool) => tool.name), ["a"]);
});

// ------------------------------------------------------------ A2027: one list, the phones included

test("A2027 the one allowlist covers a paired phone as well as every chat app", async (t) => {
  const { app } = await fixture(t);
  const { GatewayAuth, deviceHeader, deviceSecretHeader, remoteChannel, saveGatewayAuth } =
    await import("../dist/remote/gateway-auth.js");
  const { saveSenderAllowlist, decide, readSenderAllowlist } = await import("../dist/channels/allowlist.js");

  const gateway = new GatewayAuth(app.store, "local");
  saveGatewayAuth(app.store, "local", { chain: ["token", "device"] });
  const { device, secret } = gateway.remember("The phone");
  const headers = { [deviceHeader]: device.id, [deviceSecretHeader]: secret };

  // The phone is let in: same key, same device secret.
  assert.equal(gateway.check({ headers }, true), null);

  // One rule in the same shape every chat app uses turns it away, without un-pairing it.
  saveSenderAllowlist(app.store, "local", { rules: [{ channel: remoteChannel, sender: device.id, decision: "block", note: "Lost it" }] });
  assert.equal(decide(readSenderAllowlist(app.store, "local"), remoteChannel, device.id), "block");
  const refused = gateway.check({ headers }, true);
  assert.match(String(refused), /may never reach Branch/);
  assert.equal(gateway.devices().length, 1, "the phone is still paired; it is the rule that stops it");

  // A rule about every phone at once works the same way, and the refusal is on the record.
  saveSenderAllowlist(app.store, "local", { rules: [{ channel: remoteChannel, sender: "*", decision: "block", note: "All of them" }] });
  assert.ok(gateway.check({ headers }, true));
  assert.ok(app.store.audit.list("local", { action: "auth.refused" }).length >= 1);

  // Taking the rule away lets it back in, and a rule about a chat app never touches the phone.
  saveSenderAllowlist(app.store, "local", { rules: [{ channel: "telegram", sender: device.id, decision: "block", note: "elsewhere" }] });
  assert.equal(gateway.check({ headers }, true), null);
});

// ------------------------------------------------------------ A2028 at the two real boundaries

test("A2028 the ceiling really reaches the run loop and the chat door", async (t) => {
  const { app } = await fixture(t);
  const { saveSessionLimits } = await import("../dist/session-limits.js");
  saveSessionLimits(app.store, "local", { requestsPerMinute: 1, tokensPerHour: 0, senderRequestsPerMinute: 1, senderTokensPerHour: 0 });

  // The owner's side: the run loop asks the counter, and waiting is what reaching it means.
  assert.equal(typeof app.runtime.sessionCeiling, "function");
  const first = app.runtime.sessionCeiling("session-a", 0);
  assert.equal(first.ok, true);
  const second = app.runtime.sessionCeiling("session-a", 0);
  assert.equal(second.ok, false);
  assert.ok(second.waitMs > 0, "the owner is made to wait, never refused");

  // The chat side: somebody messaging from outside gets a sentence instead.
  assert.equal(typeof app.channels.senderCeiling, "function");
  assert.equal(app.channels.senderCeiling("telegram", "5551").ok, true);
  const turned = app.channels.senderCeiling("telegram", "5551");
  assert.equal(turned.ok, false);
  assert.match(turned.reason, /as much as Branch will do for one person/);
});

test("A0648 a rule about another computer is about the program, not the computer's name", async (t) => {
  await fixture(t);
  const { resourceOf } = await import("../dist/policy-resources.js");
  const { presetRules, evaluatePolicy, isReadOnlyPermission, PolicySchema } = await import("../dist/policy.js");

  // "tower: make build" is a command rule about `make`, so "always allow make" means make and not
  // everything that computer can run.
  // Wave mac3 (tool-safety): the whole command is kept; a rule naming "make" still covers it.
  assert.deepEqual(resourceOf("remote.run", "remote.execute", "tower: make build", { computer: "tower", program: "make" }),
    { kind: "command", value: "make build" });
  // Integration review (mac3/tool-safety): the program's folder is kept, so `/tmp/make` is not `make`
  // to an allow; a refusal naming "make" still reaches it.
  assert.deepEqual(resourceOf("remote.run", "remote.execute", "tower: /usr/bin/make build", {}),
    { kind: "command", value: "/usr/bin/make build" });

  // Running a program elsewhere is a change, so the strict presets cover it without naming it.
  assert.equal(isReadOnlyPermission("remote.execute"), false);
  assert.equal(isReadOnlyPermission("files.read"), true);
  const readOnly = PolicySchema.parse({ preset: "read-only", rules: presetRules("read-only") });
  assert.equal(evaluatePolicy(readOnly, { tool: "remote.run", target: "tower: make build", readOnly: false }).decision, "deny");
  assert.equal(evaluatePolicy(readOnly, { tool: "remote.files", target: "tower: reports", readOnly: true }).decision, "allow");
  const asks = PolicySchema.parse({ preset: "workspace", rules: presetRules("workspace") });
  assert.equal(evaluatePolicy(asks, { tool: "remote.run", target: "tower: make build", readOnly: false }).decision, "ask");
});

/* Q4: a Trunk may use another computer only when the owner lent it to that Trunk; the owner's own conversations may use
   every one. Mutation: make getFor ignore the Trunk in src/remote/ssh-workspace.ts and the refusals go. */
test("a Trunk uses another computer only once the owner lends it to that Trunk", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, registerRemoteWorkspaces } = await import("../dist/remote/ssh-workspace.js");
  const { ToolRegistry } = await import("../dist/registry.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\nHost attic\n  HostName attic.lan\n",
    "tower.lan ssh-ed25519 AAAA\nattic.lan ssh-ed25519 BBBB\n");
  const remotes = new RemoteWorkspaces(app.store, "local", fakeSsh({ ssh: { stdout: "notes.md\n" } }).run, home);
  assert.deepEqual((await remotes.add({ alias: "tower", root: "/srv/work", trunks: ["builder"] })).trunks, ["builder"]);
  assert.deepEqual((await remotes.add({ alias: "attic", root: "/srv/old" })).trunks, [], "lent to no Trunk until the owner says");
  assert.deepEqual(remotes.listFor(null).map((c) => c.alias), ["tower", "attic"]);
  assert.deepEqual(remotes.listFor("builder").map((c) => c.alias), ["tower"]);
  assert.deepEqual(remotes.listFor("writer"), []);

  const registry = new ToolRegistry();
  registerRemoteWorkspaces(registry, remotes);
  const run = app.store.createRun(app.runtime.owner, "another computer");
  const as = (trunk) => ({ ...app.runtime.context({ runId: run.id }), ...(trunk ? { trunk } : {}) });
  assert.deepEqual((await registry.execute("remote.files", { computer: "attic", path: "." }, as(null))).entries, ["notes.md"],
    "the owner's own conversation may use every computer");
  assert.deepEqual((await registry.execute("remote.files", { computer: "tower", path: "." }, as("builder"))).entries, ["notes.md"]);
  await assert.rejects(registry.execute("remote.files", { computer: "attic", path: "." }, as("builder")), /may not use "attic"/);
  await assert.rejects(registry.execute("remote.read", { computer: "attic", path: "a.txt" }, as("builder")), /may not use "attic"/);
  await assert.rejects(registry.execute("remote.run", { computer: "tower", program: "ls", args: [] }, as("writer")), /may not use "tower"/);
  assert.deepEqual((await registry.execute("remote.list", {}, as("writer"))).computers, [], "a Trunk sees only what it was lent");
});
