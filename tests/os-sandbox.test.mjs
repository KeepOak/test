import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, PolicyRuleSchema } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import {
  saveWallSettings, tighterNetwork, wallApplies, wallNetworkFor, wallNetworks, wallSettings,
} from "../dist/sandbox.js";
import { seatbeltArgs, sandboxExecPath } from "../dist/sandbox-seatbelt.js";
import {
  bwrapArgs, bwrapAvailability, bwrapMissing, namespacesOff, seccompFilter, seccompStarterScript, withSeccomp,
} from "../dist/sandbox-bwrap.js";
import { SandboxProxy, proxyEnvironment } from "../dist/sandbox-proxy.js";
import { explainDenial, widenable } from "../dist/sandbox-denial.js";
import { openWall, sandboxBackendSet, SandboxBackendSettingsSchema, wallReport } from "../dist/sandbox-backends.js";
import { walledTools, wallContextFor } from "../dist/sandbox-wall.js";
import { ApprovalGate } from "../dist/approvals.js";

/**
 * Wave mac3 (os-sandbox): the wall around programs. Everything here is worked out on paper — the
 * profile, the bubblewrap arguments, the filter bytes — or run against fakes and a local stand-in
 * site. The one exception runs macOS's own sandbox on this Mac, inside temporary folders only.
 */

const memoryStore = (initial = {}) => {
  const saved = new Map(Object.entries(initial));
  return {
    get: (_kind, _owner, key) => (saved.has(key) ? { data: saved.get(key) } : undefined),
    save: (_kind, _owner, key, data) => { saved.set(key, data); },
    run: () => ({ sessionId: "s1" }),
  };
};
const emptyPolicy = { preset: "off", rules: [], limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 }, unmatchedCommands: "allow" };
/**
 * These build the wall from this computer's own home and temporary folders, a local socket or a
 * POSIX error message. The wall is macOS and Linux only (Windows is handed back untouched, see W9),
 * so on Windows there is nothing real for them to stand in for.
 */
const posixWall = { skip: process.platform === "win32" && "the wall around programs is macOS and Linux only" };
const wallFor = (overrides = {}) => ({
  network: "per-site", keySites: {}, unreadable: [], answer: () => undefined, granted: () => [], spend() {}, ...overrides,
});

/* ------------------------------------------------------------------ tighten-only */

test("W1 the switch ships off and a rule can only make the wall stricter", () => {
  assert.equal(wallSettings(memoryStore(), "local").mode, "off");
  assert.equal(wallSettings(memoryStore(), "local").network, "none");
  // A damaged record is read as the strictest thing it could mean, never as "off".
  const damaged = wallSettings(memoryStore({ "os-sandbox": { mode: "sideways" } }), "local");
  assert.deepEqual([damaged.mode, damaged.network], ["on", "none"]);
  // Every combination: the wall applies at least whenever the setting alone says so.
  for (const mode of ["off", "when-needed", "on"]) for (const risky of [false, true]) {
    const alone = mode === "on";
    if (alone) assert.equal(wallApplies(mode, risky), true, `${mode}/${risky} dropped the wall`);
    if (risky) assert.equal(wallApplies("when-needed", risky), true);
  }
  assert.equal(wallApplies("off", true), false, "off adds no wall of its own");
  assert.equal(wallApplies("when-needed", false), false);
  for (const network of wallNetworks) for (const choice of [null, undefined, "no-internet", "limits-only", "none"]) {
    const got = wallNetworkFor(network, choice);
    assert.equal(tighterNetwork(got, network), got, `${network} with ${choice} became looser (${got})`);
    if (choice === "no-internet") assert.equal(got, "none");
  }
  assert.equal(tighterNetwork("open", "limited"), "limited");
  assert.equal(tighterNetwork("none", "open"), "none");
  assert.throws(() => saveWallSettings(memoryStore(), "local", { mode: "on", netless: false }), /Unrecognized key/);
});

test("W2 the runtime hands the wall only to program tools, from the owner's settings and rules", () => {
  const base = { owner: "local", approvals: new ApprovalGate(), permission: "shell.execute", target: "ls", args: {},
    context: { runId: "r1" }, choice: null, policy: emptyPolicy };
  const off = memoryStore();
  assert.deepEqual(wallContextFor({ ...base, store: off, tool: "shell.execute" }), {}, "off hands nothing");
  const on = memoryStore({ "os-sandbox": { mode: "on", network: "open" } });
  assert.deepEqual(wallContextFor({ ...base, store: on, tool: "files.write" }), {}, "not a program tool");
  assert.deepEqual([...walledTools].sort(), ["code.run", "process.start", "shell.execute"]);
  const given = wallContextFor({ ...base, store: on, tool: "shell.execute" }).osSandbox;
  if (process.platform === "win32") { assert.equal(given, undefined, "Windows is left exactly as it was"); return; }
  assert.equal(given.network, "open");
  // A rule that says "no internet" makes the wall's network stricter too.
  assert.equal(wallContextFor({ ...base, store: on, tool: "shell.execute", choice: "no-internet" }).osSandbox.network, "none");
  // "When needed": nothing for a call no rule asks about; the wall for one a rule asks about.
  const needed = memoryStore({ "os-sandbox": { mode: "when-needed", network: "none" } });
  assert.deepEqual(wallContextFor({ ...base, store: needed, tool: "shell.execute" }), {});
  const asking = { ...emptyPolicy, rules: [PolicyRuleSchema.parse({ tool: "shell.execute", decision: "ask" })] };
  assert.ok(wallContextFor({ ...base, store: needed, tool: "shell.execute", policy: asking }).osSandbox);
  assert.ok(wallContextFor({ ...base, store: needed, tool: "shell.execute", choice: "limits-only" }).osSandbox);
});

test("W3 site answers come from explicit rules and this conversation's yeses; a no always wins", () => {
  if (process.platform === "win32") return;
  const approvals = new ApprovalGate();
  const rules = [
    PolicyRuleSchema.parse({ tool: "*", decision: "allow" }),
    PolicyRuleSchema.parse({ tool: "network.site", match: "blocked.test", decision: "deny" }),
    PolicyRuleSchema.parse({ tool: "network.site", match: "always.test", decision: "allow" }),
    PolicyRuleSchema.parse({ tool: "sandbox.write", match: "/tmp/kept.txt", decision: "allow" }),
    PolicyRuleSchema.parse({ tool: "sandbox.write", match: "/tmp/*", decision: "allow" }),
  ];
  const wall = wallContextFor({ store: memoryStore({ "os-sandbox": { mode: "on", network: "per-site" } }), owner: "local",
    approvals, context: { runId: "r1" }, tool: "shell.execute", permission: "shell.execute", target: "x", args: {},
    choice: null, policy: { ...emptyPolicy, rules } }).osSandbox;
  assert.equal(wall.answer("network.site", "new.test"), undefined, "a broad * rule never opens a site");
  assert.equal(wall.answer("network.site", "always.test"), "allow");
  approvals.remember("s1", "network.site", "blocked.test", "allow");
  assert.equal(wall.answer("network.site", "blocked.test"), "deny", "a rule's no beats a yes");
  approvals.remember("s1", "network.site", "always.test", "deny");
  assert.equal(wall.answer("network.site", "always.test"), "deny", "a conversation's no beats a rule's yes");
  approvals.remember("s1", "sandbox.write", "/tmp/once.txt", "allow");
  assert.deepEqual(wall.granted("sandbox.write").sort(), ["/tmp/kept.txt", "/tmp/once.txt"], "a pattern is never a standing widening");
  wall.spend("sandbox.write", "/tmp/once.txt");
  assert.deepEqual(wall.granted("sandbox.write"), ["/tmp/kept.txt"], "a yes for one retry is used up");
});

/* ------------------------------------------------------------------ macOS profile */

test("W4 the macOS profile never contains a path, and writes stop at the workspace", () => {
  const workspace = '/Users/o/work "(allow file-write*)"';
  const args = seatbeltArgs({ workspace, network: "none", home: "/Users/o", temp: ["/private/tmp"], unreadable: ["/Volumes/Keys"],
    extraWrites: ["/Users/o/notes.txt"], dataDir: "/Users/o/.branch-data" }, { executable: "/usr/bin/env", args: ["ls", "-la"] });
  assert.equal(args[0], "-p");
  const profile = args[1];
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.ok(!profile.includes("/Users/o"), "no path is pasted into the profile");
  assert.ok(!/network-outbound|network-inbound/.test(profile), "no network when none is allowed");
  assert.deepEqual(args.slice(-4), ["--", "/usr/bin/env", "ls", "-la"]);
  const params = Object.fromEntries(args.filter((arg) => arg.startsWith("-D")).map((arg) => arg.slice(2).split(/=(.*)/s).slice(0, 2)));
  assert.equal(params.WRITE_0, workspace);
  assert.equal(params.WRITE_1, "/private/tmp");
  assert.equal(params.GRANTED_0, "/Users/o/notes.txt");
  assert.equal(params.KEEP_0, `${workspace}/.git`);
  assert.equal(params.KEEP_1, `${workspace}/.branch`);
  assert.equal(params.KEEP_2, `${workspace}/.agents`);
  const hidden = Object.entries(params).filter(([key]) => key.startsWith("HIDDEN_")).map(([, value]) => value);
  for (const place of ["/Users/o/.ssh", "/Users/o/.aws", "/Users/o/Library/Keychains", "/Volumes/Keys", "/Users/o/.branch-data"])
    assert.ok(hidden.includes(place), `${place} is readable`);
  // The refusals come after every allowance, so none of them can be reopened.
  const lastAllow = profile.lastIndexOf("(allow file-write*");
  assert.ok(profile.indexOf('(deny file-write* (literal (param "KEEP_0"))') > lastAllow);
  assert.ok(profile.indexOf('(deny file-read* file-write* (literal (param "HIDDEN_0"))') > lastAllow);
  assert.throws(() => seatbeltArgs({ workspace: "relative/path", network: "none" }, { executable: "/bin/ls", args: [] }), /full paths/);
});

test("W5 behind the door, only the door's ports are reachable", posixWall, () => {
  const command = { executable: "/usr/bin/curl", args: [] };
  const door = seatbeltArgs({ workspace: "/w", network: "per-site", proxyPorts: [4100, 4101], temp: [] }, command)[1];
  assert.match(door, /\(allow network-outbound \(remote ip "localhost:4100"\)\)/);
  assert.match(door, /\(allow network-outbound \(remote ip "localhost:4101"\)\)/);
  assert.ok(!/\(allow network-outbound\)\n/.test(door), "not the whole internet");
  const open = seatbeltArgs({ workspace: "/w", network: "open", temp: [] }, command)[1];
  assert.match(open, /\(allow network-outbound \(remote ip "\*:\*"\)\)/);
  assert.ok(!/\(allow network-outbound\)/.test(open), "open means internet addresses, not every local socket file");
  // A port that is not a real port gives no network at all rather than some network.
  const bad = seatbeltArgs({ workspace: "/w", network: "per-site", proxyPorts: [4100, 70000], temp: [] }, command)[1];
  assert.ok(!bad.includes("network-outbound"));
  const noDoor = seatbeltArgs({ workspace: "/w", network: "limited", temp: [] }, command)[1];
  assert.ok(!noDoor.includes("network-outbound"), "limited with no door is no network");
});

/* ------------------------------------------------------------------ Linux arguments and filter */

test("W6 bubblewrap arguments: read-only disk, writable workspace, protected folders, no network", () => {
  const kinds = { "/home/o/.ssh": "dir", "/home/o/.netrc": "file" };
  const args = bwrapArgs({ workspace: "/home/o/work", network: "none", home: "/home/o", temp: "/tmp", seccompFd: 9,
    extraWrites: ["/home/o/notes"], kindOf: (path) => kinds[path] ?? null }, { executable: "/usr/bin/python3", args: ["-c", "1"] });
  const joined = args.join(" ");
  for (const flag of ["--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-net", "--proc /proc", "--ro-bind / /",
    "--tmpfs /tmp", "--bind /home/o/work /home/o/work", "--bind-try /home/o/notes /home/o/notes",
    "--ro-bind-try /home/o/work/.git /home/o/work/.git", "--ro-bind-try /home/o/work/.agents /home/o/work/.agents",
    "--tmpfs /home/o/.ssh --remount-ro /home/o/.ssh", "--ro-bind /dev/null /home/o/.netrc", "--seccomp 9", "--chdir /home/o/work"])
    assert.ok(joined.includes(flag), `missing ${flag}`);
  assert.ok(!joined.includes("/home/o/.aws"), "a place that is not there needs nothing hidden");
  assert.ok(joined.indexOf("--ro-bind-try /home/o/work/.git") > joined.indexOf("--bind /home/o/work"), ".git is put back read-only after the workspace");
  assert.deepEqual(args.slice(-4), ["--", "/usr/bin/python3", "-c", "1"]);
  const open = bwrapArgs({ workspace: "/w", network: "open", kindOf: () => null }, { executable: "/bin/true", args: [] });
  assert.ok(!open.includes("--unshare-net"));
  const door = bwrapArgs({ workspace: "/w", network: "per-site", doorDir: "/tmp/door", kindOf: () => null }, { executable: "/bin/true", args: [] });
  assert.ok(door.includes("--unshare-net"), "behind the door the program still has a network of its own");
  assert.ok(door.join(" ").includes("--bind /tmp/door /tmp/door"));
  const started = withSeccomp("/usr/bin/bwrap", "/tmp/f.bpf", ["--x"]);
  assert.deepEqual(started, { executable: "/bin/sh", args: ["-c", seccompStarterScript, "branch-wall", "/tmp/f.bpf", "/usr/bin/bwrap", "--x"] });
  assert.ok(!seccompStarterScript.includes("/tmp"), "the starter line is fixed text");
});

/** A tiny classic-BPF reader, enough to run the filter on paper. */
function runFilter(bytes, data) {
  const view = (offset) => (offset === 0 ? data.nr : offset === 4 ? data.arch : offset === 16 ? data.arg0 : 0);
  let acc = 0;
  for (let pc = 0; pc < bytes.length / 8;) {
    const code = bytes.readUInt16LE(pc * 8), jt = bytes[pc * 8 + 2], jf = bytes[pc * 8 + 3], k = bytes.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) { acc = view(k); pc += 1; }
    else if (code === 0x15) pc += 1 + (acc === k ? jt : jf);
    else if (code === 0x35) pc += 1 + (acc >= k ? jt : jf);
    else if (code === 0x06) return k;
    else throw new Error(`unknown op ${code}`);
  }
  throw new Error("fell off the end");
}

test("W7 the system-call filter refuses tracing, non-local sockets with no network, and foreign calls", () => {
  const KILL = 0x80000000, EPERM = 0x00050001, ALLOW = 0x7fff0000;
  const x64 = 0xc000003e, arm64 = 0xc00000b7;
  const none = seccompFilter({ network: "none", arch: "x64" });
  assert.equal(runFilter(none, { arch: x64, nr: 101 }), EPERM, "ptrace");
  assert.equal(runFilter(none, { arch: x64, nr: 41, arg0: 2 }), EPERM, "an internet socket");
  assert.equal(runFilter(none, { arch: x64, nr: 41, arg0: 1 }), ALLOW, "a local socket");
  assert.equal(runFilter(none, { arch: x64, nr: 0 }), ALLOW, "read");
  assert.equal(runFilter(none, { arch: x64, nr: 0x40000029 }), KILL, "an x32 call");
  assert.equal(runFilter(none, { arch: 0x40000003, nr: 1 }), KILL, "another processor type");
  const door = seccompFilter({ network: "per-site", arch: "arm64" });
  assert.equal(runFilter(door, { arch: arm64, nr: 117 }), EPERM, "ptrace on arm64");
  assert.equal(runFilter(door, { arch: arm64, nr: 198, arg0: 2 }), ALLOW, "the door needs a local internet socket");
  assert.equal(runFilter(seccompFilter({ network: "none", arch: "arm64" }), { arch: arm64, nr: 198, arg0: 10 }), EPERM);
  assert.throws(() => seccompFilter({ network: "none", arch: "mips" }), /cannot filter/);
});

test("W8 a missing bwrap or switched-off namespaces is a plain refusal", async () => {
  const probe = (answer) => async (executable, args) => { probe.calls.push([executable, ...args]); return answer; };
  probe.calls = [];
  assert.deepEqual(await bwrapAvailability(probe({ code: 0, stderr: "", missing: false }), async () => null), { ok: false, reason: bwrapMissing });
  assert.deepEqual(await bwrapAvailability(probe({ code: 1, stderr: "setting up uid map: Permission denied", missing: false }), async () => "/usr/bin/bwrap"),
    { ok: false, reason: namespacesOff });
  assert.deepEqual(await bwrapAvailability(probe({ code: 0, stderr: "", missing: false }), async () => "/usr/bin/bwrap"), { ok: true, path: "/usr/bin/bwrap" });
  assert.deepEqual(probe.calls.at(-1), ["/usr/bin/bwrap", "--unshare-user", "--ro-bind", "/", "/", "--", "/bin/true"]);
  const linux = await wallReport({ platform: "linux", locateBwrap: async () => null });
  assert.deepEqual(linux, { platform: "linux", available: false, reason: bwrapMissing });
  assert.equal((await wallReport({ platform: "win32" })).available, false);
  assert.equal((await wallReport({ platform: "darwin", exists: async () => true })).available, true);
});

/* ------------------------------------------------------------------ putting a program behind it */

const plain = (cwd) => ({ executable: "/usr/bin/printenv", args: ["TOKEN"], cwd, env: { PATH: "/usr/bin", TOKEN: "real-value-1234" } });

test("W9 on Windows the start is handed back untouched; elsewhere nothing starts without a wall", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wall-"));
  t.after(() => discardTemp(root));
  const start = plain(root);
  const windows = await openWall(wallFor(), start, { workspace: root }, { platform: "win32" });
  assert.equal(windows.start, start, "Windows is left exactly as it was");
  await assert.rejects(openWall(wallFor(), start, { workspace: root }, { platform: "freebsd" }), /macOS and Linux only/);
  await assert.rejects(openWall(wallFor(), start, { workspace: root }, { platform: "darwin", exists: async () => false }), /sandbox-exec\) is missing/);
  await assert.rejects(openWall(wallFor(), start, { workspace: root }, { platform: "linux", locateBwrap: async () => null }), /needs bubblewrap/);
});

test("W10 macOS: the program sees a stand-in key and only the door; a new site stops the task with a question", posixWall, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const wall = wallFor({ keySites: { TOKEN: "api.example.test" } });
  const start = { ...plain(root), env: { ...plain(root).env, OTHER: "real-other-5678" } };
  const opened = await openWall(wall, start, { workspace: root, secrets: { TOKEN: "real-value-1234", OTHER: "real-other-5678" } },
    { platform: "darwin", exists: async (path) => path === sandboxExecPath });
  t.after(() => opened.close());
  assert.equal(opened.start.executable, "/usr/bin/sandbox-exec");
  assert.match(opened.start.env.TOKEN, /^branch_[a-f0-9]{32}$/);
  assert.match(opened.start.env.OTHER, /^branch_[a-f0-9]{32}$/, "a key with no site is a stand-in too");
  for (const real of ["real-value-1234", "real-other-5678"])
    assert.ok(!JSON.stringify(opened.start).includes(real), "no real key is anywhere in what starts");
  const port = Number(new URL(opened.start.env.HTTP_PROXY).port);
  assert.match(opened.start.args[1], new RegExp(`localhost:${port}`));
  assert.match(opened.start.env.ALL_PROXY, /^socks5h:\/\/branch:[a-f0-9]{36}@127\.0\.0\.1:\d+$/);
  // A program tries a site nobody has decided about.
  const refused = await new Promise((resolve) => {
    const auth = Buffer.from(decodeURIComponent(`${new URL(opened.start.env.HTTP_PROXY).username}:${new URL(opened.start.env.HTTP_PROXY).password}`)).toString("base64");
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET http://new.example.test/ HTTP/1.1\r\nHost: new.example.test\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`));
    let text = ""; socket.on("data", (chunk) => { text += chunk; }); socket.on("end", () => resolve(text)); socket.on("close", () => resolve(text));
  });
  assert.match(refused, /403/);
  await assert.rejects(opened.finish({ exitCode: 6, stdout: "", stderr: "" }),
    (error) => error.name === "ApprovalRequiredError" && error.tool === "network.site" && error.target === "new.example.test");
});

test("W11 a blocked write names the file once, the yes widens exactly that file, and it is used up", posixWall, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const deps = { platform: "darwin", exists: async () => true };
  const blocked = { exitCode: 1, stdout: "", stderr: "touch: /Users/o/report.txt: Operation not permitted\n" };
  const first = await openWall(wallFor({ network: "none" }), plain(root), { workspace: root }, deps);
  await assert.rejects(first.finish(blocked), (error) => error.tool === "sandbox.write" && error.target === "/Users/o/report.txt"
    && /let the next try write to it, once/.test(error.label));
  const spent = [];
  const granted = wallFor({ network: "none", granted: () => ["/Users/o/report.txt", join(homedir(), ".ssh", "config")], spend: (kind, path) => spent.push(path) });
  const second = await openWall(granted, plain(root), { workspace: root }, deps);
  assert.ok(second.start.args.includes("-DGRANTED_0=/Users/o/report.txt"));
  assert.ok(!second.start.args.some((arg) => arg.startsWith("-DGRANTED_1")), "a hidden place is never widened");
  assert.deepEqual(spent, ["/Users/o/report.txt", join(homedir(), ".ssh", "config")], "every one-time yes is used up, used or not");
  // Still failing after the one retry: a sentence, not another question.
  assert.match(await second.finish(blocked), /stopped this command writing to \/Users\/o\/report\.txt/);
  const answered = await openWall(wallFor({ network: "none", answer: () => "deny" }), plain(root), { workspace: root }, deps);
  assert.match(await answered.finish(blocked), /stopped this command writing/);
  const offline = await openWall(wallFor({ network: "none" }), plain(root), { workspace: root }, deps);
  assert.match(await offline.finish({ exitCode: 6, stdout: "", stderr: "curl: (6) Could not resolve host: example.com" }), /reaching the internet/);
});

test("W12 Linux: bwrap through the fixed starter, the filter written, the door bridged, all cleaned up", posixWall, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const probed = [];
  const deps = { platform: "linux", locateBwrap: async () => "/usr/bin/bwrap", kindOf: () => null,
    probe: async (executable, args) => { probed.push([executable, ...args]); return { code: 0, stdout: "", stderr: "", missing: false }; } };
  const opened = await openWall(wallFor({ keySites: { TOKEN: "api.example.test" } }), plain(root), { workspace: root, secrets: { TOKEN: "real-value-1234" } }, deps);
  assert.equal(opened.start.executable, "/bin/sh");
  assert.equal(opened.start.args[opened.start.args.indexOf("--seccomp") + 1], "9", "the filter is read from the descriptor the starter opens");
  assert.match(seccompStarterScript, / 9< "\$f"$/);
  const [flag, script, name, filter, bwrap, ...rest] = opened.start.args;
  assert.deepEqual([flag, script, name, bwrap], ["-c", seccompStarterScript, "branch-wall", "/usr/bin/bwrap"]);
  assert.equal((await readFile(filter)).length % 8, 0, "the filter is whole instructions");
  const marker = rest.indexOf("--");
  assert.equal(rest[marker + 1], process.execPath, "the door's bridge runs first inside the wall");
  assert.deepEqual([rest[marker + 4], rest[marker + 6], rest[marker + 7]], ["3128", "1080", "--"]);
  assert.deepEqual(rest.slice(-3), ["--", "/usr/bin/printenv", "TOKEN"]);
  assert.match(opened.start.env.HTTP_PROXY, /^http:\/\/branch:[a-f0-9]{36}@127\.0\.0\.1:3128$/);
  assert.match(opened.start.env.TOKEN, /^branch_/);
  assert.ok(rest.includes("--unshare-net"));
  const staging = dirname(filter);
  assert.ok(rest.join(" ").includes(`--bind ${staging} ${staging}`), "the door's folder is shared with the program");
  assert.ok((await stat(staging)).isDirectory());
  await opened.close();
  assert.equal(await stat(staging).catch(() => null), null, "the door's folder is gone");
});

test("W13 the plain box puts scripts behind the wall only when the call carries one", posixWall, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const spawned = [];
  const spawn = async (options) => { spawned.push(options); return { status: "failed", exitCode: 1, stdout: "", stderr: "boom", truncated: false, durationMs: 1 }; };
  const set = sandboxBackendSet({ settings: SandboxBackendSettingsSchema.parse({}), spawn,
    probe: async () => ({ code: 0, stdout: "", stderr: "", missing: false }), wall: { platform: "darwin", exists: async () => true } });
  const handle = await set["job-object"].prepare({ hostPath: root });
  const limits = { timeoutMs: 1000, maxMemoryMb: 64, maxCpuSeconds: 1, maxOutputBytes: 1000, network: false, job: false };
  const bare = await handle.run({ executable: "/bin/echo", args: ["hi"] }, limits, AbortSignal.timeout(5000));
  assert.deepEqual(bare.argv, ["/bin/echo", "hi"], "no wall, no change");
  const walled = await handle.run({ executable: "/bin/echo", args: ["hi"] }, { ...limits, wall: wallFor({ network: "none" }) }, AbortSignal.timeout(5000));
  assert.equal(walled.argv[0], "/usr/bin/sandbox-exec");
  assert.equal(spawned[1].executable, "/usr/bin/sandbox-exec");
  const kept = await handle.argvFor({ executable: "/bin/sleep", args: ["9"] }, { ...limits, wall: wallFor({ network: "per-site" }) });
  const keptOpen = await openWall(wallFor({ network: "open", keySites: { TOKEN: "api.example.test" } }), plain(root),
    { workspace: root, secrets: { TOKEN: "real-value-1234" }, proxy: false }, { platform: "darwin", exists: async () => true });
  assert.equal(keptOpen.start.env.HTTP_PROXY, undefined, "no door is ever opened for a program left running");
  assert.match(keptOpen.start.env.TOKEN, /^branch_/);
  await keptOpen.close();
  assert.equal(kept.executable, "/usr/bin/sandbox-exec");
  assert.equal(kept.env.HTTP_PROXY, "http://127.0.0.1:9", "a program left running gets no door, only the dead address");
  assert.ok(!kept.args[1].includes("network-outbound"));
});

/* ------------------------------------------------------------------ denials */

test("W14 a denial is told apart from an ordinary failure", posixWall, () => {
  const options = { network: "open", workspace: "/w", hidden: ["/home/o/.ssh"] };
  assert.equal(explainDenial({ exitCode: 0, stdout: "", stderr: "Operation not permitted" }, options), null);
  assert.equal(explainDenial({ exitCode: 127, stdout: "", stderr: "sandbox: command not found" }, options), null);
  assert.equal(explainDenial({ exitCode: 1, stdout: "", stderr: "error: tests failed" }, options), null);
  assert.equal(explainDenial({ exitCode: 1, stdout: "", stderr: "OSError: [Errno 30] Read-only file system: '/opt/lib/x.pyc'" }, options).path, "/opt/lib/x.pyc");
  assert.equal(explainDenial({ exitCode: 1, stdout: "", stderr: "open /w/.git/hooks/pre-commit: operation not permitted" }, options).path, undefined);
  assert.equal(explainDenial({ exitCode: 1, stdout: "", stderr: "Permission denied" }, options).kind, "unknown");
  assert.equal(explainDenial({ exitCode: 6, stdout: "", stderr: "Could not resolve host" }, options), null, "with network allowed, a lookup failure is just a failure");
  assert.equal(widenable("/home/o/.ssh/id_ed25519", options), false);
  assert.equal(widenable("/w/.agents/x", options), false);
  assert.equal(widenable("/", options), false);
  assert.equal(widenable("/home/o/out.txt", options), true);
});

/* ------------------------------------------------------------------ the door */

async function fakeSite(t, { delayMs = 0 } = {}) {
  const seen = [];
  const server = createServer(async (request, response) => {
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.writeHead(200, { "content-type": "application/json", "x-echo": request.headers.authorization ?? "" });
    response.end(JSON.stringify({ echo: request.headers.authorization ?? "", leaked: "aws_secret_access_key=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port: server.address().port };
}

/** A public-looking address for every test site; the door refuses private ones. */
const publicResolve = async () => ["93.184.216.34"];
const withAuth = (text, secret) => text.replace("\r\n", `\r\nProxy-Authorization: Basic ${Buffer.from(`branch:${secret}`).toString("base64")}\r\n`);

async function door(t, options) {
  const proxy = new SandboxProxy({ resolve: publicResolve, ...options });
  const address = await proxy.start();
  t.after(() => proxy.close());
  const raw = (text, secret = proxy.secret) => rawSend(address.httpPort, secret === null ? text : withAuth(text, secret));
  const socks = (host, port = 80, credentials = ["branch", proxy.secret]) => socksTry(address.socksPort, host, port, credentials);
  return { proxy, address, raw, socks };
}
function rawSend(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let got = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { got += chunk; });
    socket.once("close", () => resolve(got));
    socket.once("error", reject);
    socket.setTimeout(5_000, () => socket.destroy(new Error("proxy response timed out")));
  });
}
/** A SOCKS5 client: greeting, user name and password, connect, then a plain request. Resolves with every reply. */
function socksTry(port, host, targetPort, credentials) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const replies = [];
    const [user, password] = credentials ?? [];
    socket.on("data", (chunk) => {
      replies.push(chunk);
      const step = replies.length;
      if (step === 1 && chunk[1] === 2) socket.write(Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([password.length]), Buffer.from(password)]));
      else if (step === 2 && chunk[1] === 0) socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([targetPort >> 8, targetPort & 255])]));
      else if (step === 3 && chunk[1] === 0) socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("error", () => resolve(replies));
    socket.on("close", () => resolve(replies));
    socket.write(Buffer.from(credentials ? [5, 1, 2] : [5, 1, 0]));
  });
}

test("W15 the door asks about new sites, keeps to reading in limited mode, and follows the owner's rules", async (t) => {
  const site = await fakeSite(t);
  const answers = { "ok.test": "allow", "no.test": "deny", "ruled.test": "allow" };
  const { proxy, raw } = await door(t, { network: "limited", decide: (host) => answers[host] ?? "ask",
    check: async (url) => { if (url.hostname === "ruled.test") throw new Error("ruled.test is on the blocked list"); },
    upstream: () => ({ host: "127.0.0.1", port: site.port, secure: false }) });
  assert.match(await raw("GET http://ok.test/a HTTP/1.1\r\nHost: ok.test\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 200/);
  assert.match(await raw("POST http://ok.test/a HTTP/1.1\r\nHost: ok.test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), /405[\s\S]*only read/);
  assert.match(await raw("CONNECT ok.test:443 HTTP/1.1\r\nHost: ok.test:443\r\n\r\n"), /403[\s\S]*secure tunnel/);
  assert.match(await raw("GET http://no.test/ HTTP/1.1\r\nHost: no.test\r\nConnection: close\r\n\r\n"), /403[\s\S]*not allowed programs to reach no\.test/);
  assert.match(await raw("GET http://ruled.test/ HTTP/1.1\r\nHost: ruled.test\r\nConnection: close\r\n\r\n"), /blocked list/);
  assert.match(await raw("GET http://new.test/ HTTP/1.1\r\nHost: new.test\r\nConnection: close\r\n\r\n"), /asking the owner/);
  assert.deepEqual(proxy.asked, ["new.test"]);
  assert.deepEqual(site.seen.map((entry) => entry.method), ["GET"], "only the allowed read reached the site");
});

test("W16 a stand-in becomes the real key only for its own site, and the answer comes back clean", async (t) => {
  const site = await fakeSite(t, { delayMs: 600 });
  const keys = [{ name: "TOKEN", placeholder: `branch_${"a".repeat(32)}`, value: "real-value-1234", site: "api.example.test" }];
  const routed = [];
  const { proxy, raw } = await door(t, { network: "per-site", decide: () => "allow", keys,
    upstream: (target) => { routed.push(target); return { host: "127.0.0.1", port: site.port, secure: false }; } });
  const answer = await raw(`GET http://api.example.test/me HTTP/1.1\r\nHost: api.example.test\r\nAuthorization: Bearer ${keys[0].placeholder}\r\nConnection: close\r\n\r\n`);
  assert.equal(site.seen[0].authorization, "Bearer real-value-1234", "the site got the real key");
  assert.deepEqual(routed[0], { host: "api.example.test", address: "93.184.216.34", port: 443, secure: true }, "a real key only ever goes out over a secure connection");
  assert.ok(!answer.includes("real-value-1234"), "the key is taken back out of the answer");
  assert.match(answer, /\[secret TOKEN\]/);
  assert.match(answer, /hidden key-like value/);
  assert.ok(proxy.hidden.size > 0);
  const elsewhere = await raw(`GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\nX-Key: ${keys[0].placeholder}\r\nConnection: close\r\n\r\n`);
  assert.match(elsewhere, /403[\s\S]*belongs to api\.example\.test/);
  const siteless = { name: "LOOSE", placeholder: `branch_${"c".repeat(32)}`, value: "loose-1234", site: "" };
  keys.push(siteless);
  assert.match(await raw(`GET http://api.example.test/ HTTP/1.1\r\nHost: api.example.test\r\nX-Key: ${siteless.placeholder}\r\nConnection: close\r\n\r\n`),
    /No site is set for the key LOOSE/);
  const unknown = await raw(`GET http://api.example.test/ HTTP/1.1\r\nHost: api.example.test\r\nX-Key: branch_${"b".repeat(32)}\r\nConnection: close\r\n\r\n`);
  assert.match(unknown, /stand-in key Branch does not know/);
  assert.equal(site.seen.length, 1);
});

test("W17 the SOCKS door connects only where the owner said yes", async (t) => {
  const site = await fakeSite(t);
  const { socks } = await door(t, { network: "per-site", decide: (host) => (host === "ok.test" ? "allow" : "ask"),
    upstream: () => ({ host: "127.0.0.1", port: site.port, secure: false }) });
  const yes = await socks("ok.test");
  assert.equal(yes[2][1], 0, "connected");
  assert.match(Buffer.concat(yes.slice(3)).toString(), /200 OK/);
  const no = await socks("other.test");
  assert.equal(no[2][1], 2, "refused");
  assert.match(proxyEnvironment({ httpPort: 1, socksPort: 2 }, "s3cret").ALL_PROXY, /^socks5h:\/\/branch:s3cret@127\.0\.0\.1:2$/);
});

/* ------------------------------------------------------------------ integration review: attacks on the door */

async function recordingSite(t) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ host: request.headers.host, proxyAuthorization: request.headers["proxy-authorization"], url: request.url });
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port: server.address().port };
}
const CRLF = "\r\n";
const get = (host, extra = "", path = "/") => `GET http://${host}${path} HTTP/1.1${CRLF}Host: ${host}${CRLF}${extra}Connection: close${CRLF}${CRLF}`;
const tunnelTo = (target) => `CONNECT ${target} HTTP/1.1${CRLF}Host: ${target}${CRLF}${CRLF}`;
// A refused tunnel, either way the door says it. A tunnel to a real port other than 443 carries plain
// words, so the door establishes it, dials nothing, and says 403 inside, where a program reading the
// answer gets the reason in words instead of a bare network error. Everything else — 443, and a port
// that is not a port — keeps the 403 on the tunnel's own reply.
const tunnelRefusal = (why = "") =>
  new RegExp(`^(?:HTTP/1\\.1 200 Connection Established\\r\\n\\r\\n)?HTTP/1\\.1 403[\\s\\S]*${why}`);

test("R1 the door turns away any caller without this run's secret, and never passes the secret on", async (t) => {
  const site = await recordingSite(t);
  const { proxy, raw, socks } = await door(t, { network: "open", decide: () => "allow",
    upstream: () => ({ host: "127.0.0.1", port: site.port, secure: false }) });
  assert.match(await raw(get("ok.test"), null), /^HTTP\/1\.1 407/);
  assert.match(await raw(get("ok.test"), "0".repeat(36)), /^HTTP\/1\.1 407/);
  assert.match(await raw(tunnelTo("ok.test:443"), null), /^HTTP\/1\.1 407/);
  const noAuth = await socks("ok.test", 80, null);
  assert.deepEqual([...noAuth[0]], [5, 0xff], "SOCKS without a password is refused");
  const wrong = await socks("ok.test", 80, ["branch", "0".repeat(36)]);
  assert.deepEqual([...wrong[1]], [1, 1], "a wrong password is refused");
  assert.equal(site.seen.length, 0, "nothing reached the site");
  assert.match(await raw(get("ok.test")), /^HTTP\/1\.1 200/);
  assert.equal(site.seen.length, 1);
  assert.equal(site.seen[0].proxyAuthorization, undefined, "the door's secret is not passed to the site");
  assert.equal(proxyEnvironment({ httpPort: 5, socksPort: 6 }, proxy.secret).HTTP_PROXY, `http://branch:${proxy.secret}@127.0.0.1:5`);
});

test("R2 the door never reaches this computer, the cloud metadata address or a private network", async (t) => {
  const site = await recordingSite(t);
  const names = { "inner.test": ["10.0.0.5"], "mixed.test": ["93.184.216.34", "127.0.0.1"], "v6.test": ["::ffff:127.0.0.1"] };
  const upstream = () => ({ host: "127.0.0.1", port: site.port, secure: false });
  const { raw, socks, proxy } = await door(t, { network: "open", decide: () => "allow", upstream,
    resolve: async (host) => names[host] ?? ["93.184.216.34"] });
  for (const target of ["127.0.0.1:80", "169.254.169.254:80", "[::1]:443", "10.1.2.3:22", "inner.test:443", "mixed.test:443", "v6.test:443"])
    assert.match(await raw(tunnelTo(target)), tunnelRefusal("(private network|not a site)"), target);
  assert.match(await raw(get("169.254.169.254", "", "/latest/meta-data/")), /^HTTP\/1\.1 403/);
  assert.match(await raw(get("inner.test")), /^HTTP\/1\.1 403/);
  assert.equal((await socks("169.254.169.254"))[2][1], 2, "SOCKS to the metadata address is refused");
  assert.equal((await socks("inner.test"))[2][1], 2);
  // The system's own lookup: "localhost" and a number that means 127.0.0.1.
  const real = await door(t, { network: "open", decide: () => "allow", upstream, resolve: undefined });
  for (const name of ["localhost", "2130706433"])
    assert.match(await real.raw(tunnelTo(`${name}:80`)), tunnelRefusal(), name);
  assert.equal(site.seen.length, 0, "nothing private was reached");
  assert.ok(proxy.refused.some((reason) => /private network/.test(reason)));
});

test("R3 the door connects to the address it checked, with the site's own name on the request", async (t) => {
  const site = await recordingSite(t);
  const lookups = [], routed = [];
  // A name that answers a public address first and this computer afterwards (DNS rebinding).
  const answers = [["93.184.216.34"], ["127.0.0.1"]];
  const { raw } = await door(t, { network: "open", decide: () => "allow",
    check: async () => undefined,
    resolve: async (host) => { lookups.push(host); return answers[Math.min(lookups.length - 1, 1)]; },
    upstream: (target) => { routed.push(target); return { host: "127.0.0.1", port: site.port, secure: false }; } });
  const steered = `GET http://rebind.test/x HTTP/1.1${CRLF}Host: evil.test${CRLF}Connection: close${CRLF}${CRLF}`;
  assert.match(await raw(steered), /^HTTP\/1\.1 200/);
  assert.deepEqual(lookups, ["rebind.test"], "looked up once");
  assert.equal(routed[0].address, "93.184.216.34", "the connection goes to the checked address");
  assert.equal(site.seen[0].host, "rebind.test", "a different Host line cannot steer the request to another site");
  assert.match(await raw(get("rebind.test", "", "/x")), /^HTTP\/1\.1 403/, "the second lookup says 127.0.0.1, and that is refused");
});

test("R3b a name a fake-IP proxy answers in 198.18.0.0/15 passes the door only when the owner said so, and a literal never does", async (t) => {
  const site = await recordingSite(t);
  // Every name is answered the way a fake-IP proxy does; the one-number and trailing-dot spellings of
  // 198.18.0.5 are answered with it too, as a real lookup would.
  const names = { "fake.test": ["198.18.0.5"], "home.test": ["127.0.0.1"], "both.test": ["198.18.0.5", "127.0.0.1"],
    "3323068421": ["198.18.0.5"], "198.18.0.5.": ["198.18.0.5"], "lan.test": ["192.168.1.1"] };
  const options = (flag) => ({ network: "open", decide: () => "allow", check: async () => undefined,
    resolve: async (host) => names[host] ?? ["93.184.216.34"], upstream: () => ({ host: "127.0.0.1", port: site.port, secure: false }),
    ...(flag === undefined ? {} : { fakeIpProxy: () => flag }) });
  const strict = await door(t, options(undefined));
  assert.match(await strict.raw(tunnelTo("fake.test:80")), tunnelRefusal("private network"), "refused by default");
  assert.equal((await strict.socks("fake.test"))[2][1], 2, "SOCKS refuses it by default");
  const off = await door(t, options(false));
  assert.match(await off.raw(get("fake.test")), /^HTTP\/1\.1 403/, "refused while the setting is off");
  assert.equal(site.seen.length, 0);
  const { raw, socks } = await door(t, options(true));
  assert.match(await raw(get("fake.test")), /^HTTP\/1\.1 200/, "a name the proxy answers is let through");
  assert.match(await raw(tunnelTo("fake.test:80") + get("fake.test").replace(/^GET http:\/\/fake\.test/, "GET ")), /^HTTP\/1\.1 200 Connection Established[\s\S]*200 OK/);
  assert.equal((await socks("fake.test"))[2][1], 0, "SOCKS lets it through too");
  const reached = site.seen.length;
  for (const target of ["198.18.0.5:80", "198.19.255.254:443", "[::ffff:198.18.0.5]:443", "3323068421:80", "198.18.0.5.:80",
    "home.test:80", "both.test:443", "lan.test:80", "127.0.0.1:80"])
    assert.match(await raw(tunnelTo(target)), tunnelRefusal("(private network|not a site)"), target);
  assert.match(await raw(get("198.18.0.5")), /^HTTP\/1\.1 403/, "a literal in the range is refused on a plain request");
  for (const name of ["198.18.0.5", "3323068421", "198.18.0.5.", "home.test"])
    assert.equal((await socks(name))[2][1], 2, `SOCKS refuses ${name}`);
  assert.equal(site.seen.length, reached, "nothing but the named site was reached");
});

test("R3c with the fake-IP setting on, the door never dials an answer that mixes 198.18.0.0/15 with a public address", async (t) => {
  const site = await recordingSite(t);
  const names = { "pool.test": ["198.18.0.5", "198.19.0.7"], "mixed.test": ["198.18.0.5", "93.184.216.34"],
    "public-first.test": ["93.184.216.34", "198.18.0.5"] };
  const { raw, socks } = await door(t, { network: "open", decide: () => "allow", check: async () => undefined,
    resolve: async (host) => names[host] ?? ["93.184.216.34"], upstream: () => ({ host: "127.0.0.1", port: site.port, secure: false }),
    fakeIpProxy: () => true });
  assert.match(await raw(get("pool.test")), /^HTTP\/1\.1 200/, "an answer wholly from the proxy's pool is let through");
  const reached = site.seen.length;
  for (const name of ["mixed.test", "public-first.test"]) {
    assert.match(await raw(get(name)), /^HTTP\/1\.1 403/, `${name} on a plain request`);
    assert.match(await raw(tunnelTo(`${name}:80`)), tunnelRefusal("private network"), `${name} through a tunnel`);
    assert.equal((await socks(name))[2][1], 2, `SOCKS refuses ${name}`);
  }
  assert.equal(site.seen.length, reached, "nothing was dialled for a mixed answer");
});

test("R4 odd names, ports and keys are refused without bringing the door down", async (t) => {
  const site = await recordingSite(t);
  const keys = [{ name: "TOKEN", placeholder: `branch_${"d".repeat(32)}`, value: `bad value${CRLF}x`, site: "api.example.test" }];
  const { raw, socks, proxy } = await door(t, { network: "open", decide: () => "allow", keys,
    upstream: () => ({ host: "127.0.0.1", port: site.port, secure: false }) });
  assert.match(await raw(tunnelTo("ok.test:99999")), /^HTTP\/1\.1 403[\s\S]*not a port/);
  assert.match(await raw(tunnelTo("ok.test:0")), /^HTTP\/1\.1 403/);
  assert.equal((await socks(`ok.test${String.fromCharCode(0)}.evil.test`))[2][1], 2, "a name with a hidden byte is refused");
  assert.equal((await socks("ok.test/@evil.test"))[2][1], 2);
  // A saved key that cannot be sent as it is must not stop the door.
  await raw(get("api.example.test", "", `/${keys[0].placeholder}`));
  await raw(get("api.example.test", `X-Key: ${keys[0].placeholder}${CRLF}`));
  assert.match(await raw(get("ok.test")), /^HTTP\/1\.1 200/, "still answering");
  // Asking about many sites does not grow without end.
  const asking = await door(t, { network: "per-site", decide: () => "ask" });
  for (let index = 0; index < 40; index += 1) await asking.raw(get(`site${index}.test`));
  assert.equal(asking.proxy.asked.length, 16);
  assert.equal(asking.proxy.asked[0], "site0.test", "the first site is still the one asked about");
  assert.ok(proxy.refused.length >= 4);
});

/* ------------------------------------------------------------------ integration review: widening and hidden places */

test("R5 a yes to a write only ever names a real file, never a link, a startup file or a protected place", posixWall, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const { symlink, writeFile } = await import("node:fs/promises");
  const outside = join(root, "outside.txt"), link = join(root, "work", "link.txt");
  await mkdir(join(root, "work"));
  await writeFile(outside, "x");
  await symlink(outside, link);
  const home = homedir();
  const spent = [];
  const wall = wallFor({ network: "none", spend: (_kind, path) => spent.push(path),
    granted: () => [link, outside, join(home, "Library", "LaunchAgents", "evil.plist"), join(home, ".zshrc")] });
  const deps = { platform: "darwin", exists: async () => true };
  const opened = await openWall(wall, plain(join(root, "work")), { workspace: join(root, "work") }, deps);
  const granted = opened.start.args.filter((arg) => arg.startsWith("-DGRANTED_")).map((arg) => arg.split(/=(.*)/s)[1]);
  assert.deepEqual(granted, [outside], "only the real file the owner was asked about");
  assert.equal(spent.length, 4, "every one-time yes is used up");
  for (const path of [join(home, "Library", "LaunchAgents", "x.plist"), join(home, ".bashrc"), "/etc/hosts", join(home, ".ssh", "rc")])
    assert.equal(widenable(path, { workspace: join(root, "work"), hidden: [] }), false, path);
  // A denial through a link is asked about as the file it really is.
  const blocked = { exitCode: 1, stdout: "", stderr: `node: ${link}: Operation not permitted` };
  const again = await openWall(wallFor({ network: "none" }), plain(join(root, "work")), { workspace: join(root, "work") }, deps);
  await assert.rejects(again.finish(blocked), (error) => error.tool === "sandbox.write" && error.target === outside);
  const startup = await openWall(wallFor({ network: "none" }), plain(root), { workspace: join(root, "work") }, deps);
  const agent = join(home, "Library", "LaunchAgents", "a.plist");
  assert.match(await startup.finish({ exitCode: 1, stdout: "", stderr: `cp: ${agent}: Operation not permitted` }), /always protected/);
});

test("R6 Linux: a private temporary folder, and the desktop bus and Docker covered", () => {
  const kinds = { "/run/user/1000": "dir", "/run/docker.sock": "file" };
  const args = bwrapArgs({ workspace: "/tmp/work", network: "none", home: "/home/o", temp: "/var/tmp/o", uid: 1000,
    kindOf: (path) => kinds[path] ?? null }, { executable: "/bin/true", args: [] }).join(" ");
  assert.ok(args.includes("--tmpfs /tmp ") && args.includes("--tmpfs /var/tmp/o"), "both temporary folders are private");
  assert.ok(!args.includes("--bind /tmp /tmp"), "the real /tmp (ssh agent, screen, other doors) is never shared");
  assert.ok(args.indexOf("--bind /tmp/work /tmp/work") > args.indexOf("--tmpfs /tmp "), "the workspace is put back after");
  assert.ok(args.includes("--tmpfs /run/user/1000 --remount-ro /run/user/1000"));
  assert.ok(args.includes("--ro-bind /dev/null /run/docker.sock"));
});

test("R7 child programs never get key-like or loader variables", async () => {
  const { cleanChildEnvironment } = await import("../dist/child-env.js");
  const risky = ["DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "PYTHONPATH",
    "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "BW_SESSION", "BWS_ACCESS_TOKEN", "GH_TOKEN", "SLACK_BOT_TOKEN", "STRIPE_SECRET",
    "OPENAI_API_KEY", "BRANCH_KEY", "SSH_AUTH_SOCK", "GIT_DIR", "GIT_CONFIG_GLOBAL", "BASH_ENV", "ENV", "PROMPT_COMMAND", "HTTPS_PROXY"];
  const env = cleanChildEnvironment(Object.fromEntries([...risky, "PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP"].map((name) => [name, "v"])));
  assert.deepEqual(Object.keys(env).sort(), ["ComSpec", "PATH", "PATHEXT", "SystemRoot", "TEMP"].sort(), "Windows programs still find themselves");
});

/* ------------------------------------------------------------------ the app */

test("W18 the runtime hands program tools the wall; a short-lived key cannot take it down", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wall-app-"));
  let turn = 0;
  const provider = { name: "scripted", async complete() {
    turn += 1;
    return turn === 1 ? { content: "", toolCalls: [{ id: "c1", name: "code.run", arguments: JSON.stringify({ language: "javascript", source: "1+1" }) }] }
      : { content: "done", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "daemon" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const host = new URL(server.url).host;
  const call = (method, path, body, token = server.token) => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${token}`, host, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (response) => ({ status: response.status, body: await response.json() }));

  const first = await call("GET", "/api/os-sandbox");
  assert.equal(first.status, 200);
  assert.equal(first.body.settings.mode, "off", "ships off");
  assert.equal(typeof first.body.computer.available, "boolean");
  const acting = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 60 });
  const sneaky = await call("POST", "/api/os-sandbox", { mode: "off" }, acting.token);
  assert.equal(sneaky.status, 401);
  assert.match(sneaky.body.error, /cannot change the wall/);
  assert.equal((await call("POST", "/api/sandboxes", { windowsSandbox: true }, acting.token)).status, 401);
  const saved = await call("POST", "/api/os-sandbox", { mode: "on", network: "per-site", keySites: { GITHUB_TOKEN: "API.GitHub.com" }, unreadable: [] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings.keySites, { GITHUB_TOKEN: "api.github.com" });
  const written = app.store.audit.list(app.runtime.owner, { action: "policy.changed" })
    .filter((entry) => entry.subject.startsWith("Wall around programs"));
  assert.equal(written.length, 1, "switching the wall is written in the record once; the refused key changed nothing");
  assert.match(written[0].subject, /on, network per-site/);
  assert.match(written[0].reason, /Was off, network none/);

  const seen = [];
  const registry = app.runtime.registry;
  const original = registry.execute.bind(registry);
  registry.execute = async (name, args, context) => {
    if (name !== "code.run") return original(name, args, context);
    seen.push(context.osSandbox);
    return { ok: true };
  };
  await app.runtime.run({ prompt: "add", source: "owner" });
  assert.equal(seen.length, 1);
  if (process.platform === "win32") assert.equal(seen[0], undefined, "Windows is left exactly as it was");
  else {
    assert.equal(seen[0].network, "per-site");
    assert.deepEqual(seen[0].keySites, { GITHUB_TOKEN: "api.github.com" });
    assert.ok(seen[0].unreadable.some((place) => place.endsWith("data")), "Branch's own data folder is hidden");
    assert.equal(typeof seen[0].siteCheck, "function", "the door asks the owner's network rules");
    assert.equal(typeof seen[0].fakeIpProxy, "function", "the door reads the owner's fake-IP proxy setting");
    assert.equal(seen[0].fakeIpProxy(), false, "and it is off unless the owner switched it on");
    for (const place of app.runtime.protectedAreas.noChange) assert.ok(seen[0].readOnly.includes(place), `${place} is read-only behind the wall`);
    for (const place of app.runtime.protectedAreas.noRead) assert.ok(seen[0].unreadable.includes(place), `${place} is hidden behind the wall`);
  }
});

/* ------------------------------------------------------------------ the real thing, on this Mac */

test("W19 macOS's own sandbox refuses a write outside the workspace and allows one inside", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-real-")));
  t.after(() => discardTemp(root));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(outside);
  const targets = { inside: join(workspace, "a.txt"), git: join(workspace, ".git", "hook"), outside: join(outside, "b.txt") };
  const script = `const fs=require("fs");const out={};for(const [k,p] of Object.entries(${JSON.stringify(targets)})){try{fs.writeFileSync(p,"x");out[k]="written"}catch(e){out[k]=e.code}}try{fs.readdirSync(${JSON.stringify(join(homedir(), ".ssh"))});out.keys="read"}catch(e){out.keys=e.code}console.log(JSON.stringify(out))`;
  // The temporary folder is writable by design, so for this check only a folder that holds nothing counts as "temporary".
  const args = seatbeltArgs({ workspace, network: "none", temp: [join(root, "scratch")] }, { executable: process.execPath, args: ["-e", script] });
  const output = await new Promise((resolve, reject) => execFile(sandboxExecPath, args, { cwd: workspace, timeout: 20_000 },
    (error, stdout) => (error ? reject(error) : resolve(stdout))));
  const result = JSON.parse(output.trim());
  assert.equal(result.inside, "written");
  assert.equal(result.git, "EPERM", ".git stays read-only");
  assert.equal(result.outside, "EPERM", "a write outside the workspace is refused");
  assert.notEqual(result.keys, "read", "where keys live is not readable");
  assert.equal(await stat(targets.outside).catch(() => null), null, "nothing was written outside");
});

test("R8 macOS for real: 'anywhere' is internet addresses, not local socket files; hidden places hold through /var", { skip: process.platform !== "darwin" }, async (t) => {
  const plainTemp = await mkdtemp(join(tmpdir(), "branch-wall-r8-"));
  const root = await realpath(plainTemp);
  const unixSite = createServer((_request, response) => response.end("reached"));
  t.after(async () => { await new Promise((resolve) => unixSite.close(resolve)); await discardTemp(root); });
  const socketPath = join(root, "s.sock");
  await new Promise((resolve) => unixSite.listen(socketPath, resolve));
  const { writeFile } = await import("node:fs/promises");
  await mkdir(join(root, "work"));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "db"), "private");
  const script = [
    'const http=require("http"),fs=require("fs");const out={};',
    `try{out.data=fs.readFileSync(${JSON.stringify(join(root, "data", "db"))},"utf8")}catch(e){out.data=e.code}`,
    'function done(){console.log(JSON.stringify(out));process.exit(0)}',
    `function viaSocket(){http.get({socketPath:${JSON.stringify(socketPath)},path:"/"},(u)=>{out.unix=u.statusCode;done()}).on("error",(e)=>{out.unix=e.code;done()})}`,
    'const site=http.createServer((q,r)=>r.end("tcp")).listen(0,"127.0.0.1",()=>{',
    'http.get({host:"127.0.0.1",port:site.address().port},(r)=>{out.tcp=r.statusCode;site.close();viaSocket()}).on("error",(e)=>{out.tcp=e.code;viaSocket()})});',
  ].join("\n");
  // The hidden place is given the way a person would write it: through /var, not /private/var.
  const wall = wallFor({ network: "open", unreadable: [join(plainTemp, "data")] });
  const opened = await openWall(wall, { executable: process.execPath, args: ["-e", script], cwd: join(root, "work"), env: { PATH: "/usr/bin" } },
    { workspace: join(root, "work") });
  t.after(() => opened.close());
  const output = await new Promise((resolve, reject) => execFile(opened.start.executable, opened.start.args,
    { cwd: join(root, "work"), env: opened.start.env, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  const result = JSON.parse(output.trim());
  assert.equal(result.tcp, 200, "an internet-style address still works");
  assert.equal(result.unix, "EPERM", "a local socket file (Docker, the ssh agent) is refused");
  assert.equal(result.data, "EPERM", "a hidden place written through /var is still hidden");
});

test("R9 never-break's places stay unchangeable behind the wall too, even inside the workspace", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-r9-")));
  t.after(() => discardTemp(root));
  const { writeFile } = await import("node:fs/promises");
  const workspace = join(root, "work");
  await mkdir(join(workspace, "dist"), { recursive: true });
  await writeFile(join(workspace, "dist", "index.js"), "original");
  const targets = { program: join(workspace, "dist", "index.js"), fresh: join(workspace, "dist", "new.js"), work: join(workspace, "notes.txt") };
  const script = `const fs=require("fs");const out={};for(const [k,p] of Object.entries(${JSON.stringify(targets)})){try{fs.writeFileSync(p,"x");out[k]="written"}catch(e){out[k]=e.code}}console.log(JSON.stringify(out))`;
  const wall = wallFor({ network: "none", readOnly: [join(workspace, "dist")] });
  const opened = await openWall(wall, { executable: process.execPath, args: ["-e", script], cwd: workspace, env: { PATH: "/usr/bin" } }, { workspace });
  t.after(() => opened.close());
  const output = await new Promise((resolve, reject) => execFile(opened.start.executable, opened.start.args,
    { cwd: workspace, env: opened.start.env, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  assert.deepEqual(JSON.parse(output.trim()), { program: "EPERM", fresh: "EPERM", work: "written" });
  assert.equal(await readFile(targets.program, "utf8"), "original");
  // Never offered as a widening either.
  assert.match(await opened.finish({ exitCode: 1, stdout: "", stderr: `${targets.program}: Operation not permitted` }), /always protected/);
  const linux = bwrapArgs({ workspace, network: "none", readOnly: ["/opt/branch"], kindOf: () => null }, { executable: "/bin/true", args: [] }).join(" ");
  assert.ok(linux.includes("--ro-bind-try /opt/branch /opt/branch"));
});

test("R10 a command run through the shell tool really goes behind the wall", { skip: process.platform !== "darwin" }, async (t) => {
  const { BranchShell } = await import("../dist/integrations/shell.js");
  const root = await mkdtemp(join(tmpdir(), "branch-wall-r10-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const shell = new BranchShell({ executables: { node: { path: process.execPath } } }, { PATH: "/usr/bin" });
  t.after(async () => { await shell.close(); await app.close(); await discardTemp(root); });
  // The temporary folder is writable by design, so the refusal checked here is the workspace's own .git.
  await mkdir(join(app.runtime.workspace, ".git"), { recursive: true });
  const outside = join(app.runtime.workspace, ".git", "hook"), inside = join(app.runtime.workspace, "inside.txt");
  const script = `const fs=require("fs");for(const p of ${JSON.stringify([inside, outside])}){try{fs.writeFileSync(p,"x");console.log("written")}catch(e){console.log(e.code)}}`;
  const context = { ...app.runtime.context({ runId: "wall-run" }), osSandbox: wallFor({ network: "none" }) };
  const result = await shell.execute({ executable: "node", args: ["-e", script] }, context);
  assert.deepEqual(result.stdout.trim().split("\n"), ["written", "EPERM"]);
  assert.equal(await stat(outside).catch(() => null), null, "nothing was written into .git");
  const plainRun = await shell.execute({ executable: "node", args: ["-e", script] }, app.runtime.context({ runId: "plain-run" }));
  assert.deepEqual(plainRun.stdout.trim().split("\n"), ["written", "written"], "with the wall off the command runs as before");
});

/* ------------------------------------------------------------------ the card */

// Redesign: Coming soon (seg "System sandbox for commands" and sw:f15-add-sign-ins-from-outside-the-sandbox on
// Settings › Permissions at Technical), checked at fc541c24; French also waits on sw:lang. That it ships off and refuses
// a short-lived key is checked through the engine above.
test.skip("W20 the card lives in Settings, Computer, speaks French, fits 400 px and saves", async (t) => {
  const { chromium } = await import("playwright");
  const { openSettings } = await import("./places.mjs");
  const root = await mkdtemp(join(tmpdir(), "branch-wall-ui-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const card = page.locator("#os-sandbox-card");
  await card.waitFor({ state: "attached" });
  assert.equal(await card.getAttribute("data-home"), "settings:computer");
  await openSettings(page, "computer");
  await card.scrollIntoViewIfNeeded();
  assert.match(await card.textContent(), /The wall around programs/);
  assert.equal(await page.locator("#os-sandbox-mode").inputValue(), "off");
  assert.equal(await card.locator("button:not(.quiet-button):not(.sg-more)").count(), 1); // "N more" can end the card (DG-199)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the page scrolls sideways");
  const wide = await page.evaluate(() => [...document.querySelectorAll("#os-sandbox-card *")]
    .filter((node) => !node.closest(".sr-only") && (node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1))
    .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`));
  assert.deepEqual(wide, []);
  await page.locator("#os-sandbox-mode").selectOption("when-needed");
  await page.locator("#os-sandbox-network").selectOption("per-site");
  await page.locator("#os-sandbox-keys").fill("GITHUB_TOKEN api.github.com");
  await card.getByRole("button", { name: "Save the wall" }).click();
  await page.locator("#os-sandbox-card [role=status]", { hasText: "Saved." }).waitFor();
  const saved = wallSettings(app.store, app.runtime.owner);
  assert.deepEqual([saved.mode, saved.network, saved.keySites], ["when-needed", "per-site", { GITHUB_TOKEN: "api.github.com" }]);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("os-sandbox-card")?.textContent.includes("Le mur autour des programmes"));
  assert.deepEqual(errors, []);
});

/* ------------------------------------------------------------------ media and speech programs */

test("W21 ffmpeg, yt-dlp and the reading-aloud program get a clean environment with no keys", async () => {
  const { cleanChildEnvironment } = await import("../dist/child-env.js");
  const { runProgram } = await import("../dist/voice-stt.js");
  const source = { PATH: "/usr/bin", HOME: "/home/o", LANG: "fr_FR.UTF-8", LC_ALL: "C", TMPDIR: "/tmp", SystemRoot: "C:\\Windows",
    OPENAI_API_KEY: "sk-proj-abcdefghijklmnopqrstuvwxyz123", ANTHROPIC_API_KEY: "sk-ant-x", BW_SESSION: "vault", NODE_OPTIONS: "--require x", // not-a-real-secret
    GITHUB_TOKEN: "ghp_x", BRANCH_TOKEN: "branch_x", AWS_SECRET_ACCESS_KEY: "y" };
  assert.deepEqual(cleanChildEnvironment(source),
    { PATH: "/usr/bin", HOME: "/home/o", LANG: "fr_FR.UTF-8", LC_ALL: "C", TMPDIR: "/tmp", SystemRoot: "C:\\Windows" });
  // The runner the media and speech programs start through really hands the child only that.
  const printed = await runProgram(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
    AbortSignal.timeout(20_000), { ...source, PATH: process.env.PATH ?? "" });
  const names = JSON.parse(printed);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BW_SESSION", "NODE_OPTIONS", "GITHUB_TOKEN", "BRANCH_TOKEN", "AWS_SECRET_ACCESS_KEY"])
    assert.ok(!names.includes(key), `${key} reached the program`);
  assert.ok(names.includes("HOME") && names.includes("LANG"));
  // ffmpeg, yt-dlp and the speech engines use that runner unless a test hands in another.
  const { readFile: read } = await import("node:fs/promises");
  const src = (name) => read(new URL(`../src/${name}`, import.meta.url), "utf8");
  assert.match(await src("media-understand.ts"), /deps\.run \?\? runProgram/);
  assert.match(await src("speech-engine-service.ts"), /this\.deps\.run \?\? runProgram/);
  assert.match(await src("index.ts"), /new MediaUnderstanding\(\{ store, media, policy: web\.policy \}\)/);
});
