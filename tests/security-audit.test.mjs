/**
 * mac3/security-check: the security self-check.
 *
 * Every check is a pure function over one snapshot, so the first half of this file proves each of
 * them on all three systems without touching a disk: a clean setup finds nothing, and for every one
 * of the checks there is a setup that makes it speak up. A check that can never fire is worse than
 * none, so the list of mutations below must name every check there is.
 *
 * The second half gathers a real snapshot from a Branch made in a temporary folder, changes who may
 * read files in that folder only, and repairs them. Windows' access lists are exercised with a fake
 * icacls, so the exact arguments are proved on any machine and no real access list is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import {
  securityChecks, runAudit, plannedFixes, applyFixes, auditText, syncedService, sharedPlace, wholeHome,
  readIcacls, icaclsRepair, tightenPath, packageOfLaunch, npmPackage, pypiPackage, modelConcern, billionsInName,
  keyLikeValues, readIntegrationFacts, securityCheckSettings, securityToolName, securityAuditCommand,
} from "../dist/security-audit/index.js";
import { doctorFix } from "../dist/doctor-fix.js";
import { fixtureModel } from "./fixtures/fixture-model.mjs";
import { setGroupActivation } from "../dist/channels/group-activation.js";

const run = promisify(execFile);
const NOW = "2026-09-17T12:00:00.000Z";
const HOME = "/Users/owner";
const DATA = `${HOME}/Library/Application Support/Branch`;
const WORK = `${HOME}/BranchWork`;
const SETTINGS = `${HOME}/.config/branch/integrations.json`;

const fact = (role, path, kind = "file", extra = {}) => ({ role, path, kind, mode: kind === "folder" ? 0o700 : 0o600, othersRead: false, othersWrite: false, ...extra });
const integrations = (extra = {}) => ({ path: SETTINGS, problem: null, mcp: [], shell: null, browser: null, channels: [], hooks: [], web: null, keyLikeValues: [], ...extra });
const shell = (extra = {}) => ({ executables: [{ alias: "git", path: "/usr/bin/git", args: [] }], netless: true, useJobObject: true, inheritEnv: ["TEMP"], ...extra });
const channel = (extra = {}) => ({ id: "telegram", type: "telegram", activation: "mention", pairing: true, allowlist: [], tls: true, ...extra });
const rule = (extra) => ({ tool: "*", match: "*", applies: "any", decision: "ask", remember: "session", hasResource: false, ...extra });
const npx = (id, args, extra = {}) => ({ id, transport: "stdio", command: "npx", args, url: "", envKeys: [], ...extra });

function clean() {
  return {
    platform: "darwin", home: HOME, dataDir: DATA, workspace: WORK,
    paths: [
      fact("data-folder", DATA, "folder"), fact("workspace", WORK, "folder"), fact("database", `${DATA}/branch.sqlite`),
      fact("locker-key", `${DATA}/locker.key`), fact("integrations", SETTINGS), fact("plugins-folder", `${DATA}/plugins`, "folder"),
    ],
    workspaceKeyFolders: [], icloudDesktopDocuments: false, integrations: integrations(),
    policy: { preset: "ask-before-changes", rules: [rule({ applies: "changes" })], limits: { toolCallsPerMinute: 30, modelRoundsPerMinute: 30 }, unmatchedCommands: "ask" },
    remoteEnabled: false, gatewayChain: ["token", "pairing"], knownDevices: 1,
    sessionLock: { idleMinutes: 15, secretsWhileLocked: false }, privacy: { outbound: "mask", moderation: true },
    network: { allowPrivateAddresses: false, allowedHosts: null, blockedHosts: 0 },
    traceExport: { enabled: false, endpoint: "", plainHeaders: [] }, tokens: [], now: NOW,
    models: [{ id: "default", name: "Default", model: "claude-opus-5", provider: "anthropic" }], tools: ["files.read", "web.fetch"],
    plugins: [], skills: [], switches: { audit: "off", malware: "off" }, sandboxImage: "node:22-alpine",
  };
}
const withPath = (role, extra, kind) => (s) => { s.paths.push(fact(role, `${DATA}/${role}`, kind ?? (role.endsWith("folder") ? "folder" : "file"), extra)); };
const chat = (s, extra) => { s.integrations.channels.push(channel(extra)); };
const inDays = (days) => new Date(Date.parse(NOW) + days * 86400000).toISOString();

/** One setup per check that makes that check, at least, speak up. */
const triggers = {
  "files.private-folder-open": (s) => { s.paths[0].othersRead = true; },
  "files.private-folder-writable": (s) => { s.paths[0].othersWrite = true; },
  "files.database-readable": (s) => { s.paths[2].othersRead = true; },
  "files.database-writable": (s) => { s.paths[2].othersWrite = true; },
  "files.locker-key-readable": (s) => { s.paths[3].othersRead = true; },
  "files.chatgpt-sign-in-readable": withPath("chatgpt-sign-in", { othersRead: true }),
  "files.session-key-readable": withPath("session-token", { othersRead: true }),
  "files.launch-settings-readable": (s) => { s.paths[4].othersRead = true; },
  "files.launch-settings-writable": (s) => { s.paths[4].othersWrite = true; },
  "files.plugins-folder-writable": (s) => { s.paths[5].othersWrite = true; },
  "files.plugin-writable": withPath("plugin-file", { othersWrite: true }),
  "files.website-sign-ins-readable": withPath("browser-profiles", { othersRead: true }, "folder"),
  "files.screenshots-readable": withPath("artifacts", { othersRead: true }, "folder"),
  "files.task-files-readable": withPath("kept", { othersRead: true }, "folder"),
  "files.logs-readable": withPath("logs", { othersRead: true }, "folder"),
  "files.update-copies-readable": withPath("update-backups", { othersRead: true }, "folder"),
  "files.diagnostics-readable": withPath("diagnostics", { othersRead: true }, "folder"),
  "files.program-writable": withPath("shell-program", { othersWrite: true }),
  "files.workspace-writable": (s) => { s.paths[1].othersWrite = true; },
  "files.private-folder-link": (s) => { s.paths[0].kind = "link"; },
  "files.locker-key-link": (s) => { s.paths[3].kind = "link"; },
  "files.launch-settings-link": (s) => { s.paths[4].kind = "link"; },
  "files.private-folder-synced": (s) => { s.paths[0].path = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Branch`; },
  "files.launch-settings-synced": (s) => { s.paths[4].path = `${HOME}/Dropbox/branch.json`; },
  "files.workspace-synced": (s) => { s.icloudDesktopDocuments = true; s.paths[1].path = `${HOME}/Documents/Work`; },
  "files.private-folder-shared-place": (s) => { s.dataDir = "/tmp/branch-data"; },
  "files.workspace-whole-home": (s) => { s.workspace = HOME; },
  "files.workspace-key-folders": (s) => { s.workspaceKeyFolders = [".ssh"]; },
  "secrets.key-in-launch-settings": (s) => { s.integrations.keyLikeValues = ["web.search.apiKey"]; },
  "secrets.key-in-server-arguments": (s) => { s.integrations.keyLikeValues = ["mcp[0].args[2]"]; },
  "secrets.key-in-hook-arguments": (s) => { s.integrations.keyLikeValues = ["hooks[1].args[0]"]; },
  "secrets.used-while-locked": (s) => { s.sessionLock.secretsWhileLocked = true; },
  "secrets.never-locks": (s) => { s.sessionLock.idleMinutes = 0; chat(s); },
  "secrets.trace-headers-in-clear": (s) => { s.traceExport.plainHeaders = ["x-api-key"]; },
  "secrets.launch-settings-unreadable": (s) => { s.integrations.problem = "The launch settings file is not valid JSON, so Branch cannot read it."; },
  "remote.open-without-password": (s) => { s.remoteEnabled = true; s.gatewayChain = []; },
  "remote.no-pairing": (s) => { s.remoteEnabled = true; s.gatewayChain = ["token"]; },
  "remote.no-known-device": (s) => { s.remoteEnabled = true; },
  "remote.weak-when-turned-on": (s) => { s.gatewayChain = []; },
  "remote.many-devices": (s) => { s.knownDevices = 9; },
  "remote.no-auto-lock": (s) => { s.remoteEnabled = true; s.gatewayChain = ["token", "pairing", "device"]; s.sessionLock.idleMinutes = 0; },
  "remote.long-lived-keys": (s) => { s.tokens = [{ name: "nightly script", scope: "read", expiresAt: inDays(20), revoked: false }]; },
  "remote.keys-that-start-tasks": (s) => { s.tokens = [{ name: "runner", scope: "run", expiresAt: inDays(1), revoked: false }]; },
  "people.pin-alone-from-afar": (s) => { s.remoteEnabled = true; s.people = { mode: "on", chain: ["pin"], sessionMinutes: 720, signedIn: 1, waiting: 0 }; },
  "people.long-sign-in": (s) => { s.people = { mode: "on", chain: ["pin", "passkey"], sessionMinutes: 3 * 24 * 60, signedIn: 0, waiting: 0 }; },
  "people.accounts-waiting": (s) => { s.people = { mode: "on", chain: ["oidc"], sessionMinutes: 60, signedIn: 0, waiting: 2 }; },
  "approvals.nothing-asked": (s) => { s.policy.preset = "off"; s.policy.rules = []; s.integrations.shell = shell(); },
  "approvals.allow-everything": (s) => { s.policy.rules = [rule({ decision: "allow" }), rule({ decision: "deny", tool: "shell.*" })]; },
  "approvals.commands-allowed": (s) => { s.integrations.shell = shell(); s.policy.rules.unshift(rule({ tool: "shell.execute", decision: "allow" })); },
  "approvals.commands-unboxed": (s) => { s.policy.rules.unshift(rule({ tool: "shell.execute", decision: "allow", match: "git *", sandbox: "none" })); },
  "approvals.unlisted-commands-allowed": (s) => { s.integrations.shell = shell(); s.policy.unmatchedCommands = "allow"; },
  "approvals.refusal-never-reached": (s) => { s.policy.rules = [rule({ tool: "shell.*", decision: "allow" }), rule({ tool: "shell.execute", decision: "deny" })]; },
  "approvals.yes-kept-forever": (s) => { s.policy.rules.unshift(rule({ tool: "shell.execute", remember: "always" })); },
  "approvals.no-pace-with-channels": (s) => { chat(s); s.policy.limits = { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 }; },
  "commands.any-program": (s) => { s.integrations.shell = shell({ executables: [{ alias: "run", path: "/bin/bash", args: [] }] }); },
  "commands.program-in-workspace": (s) => { s.integrations.shell = shell({ executables: [{ alias: "tool", path: `${WORK}/bin/tool`, args: [] }] }); },
  "commands.reach-internet-from-chat": (s) => { s.integrations.shell = shell({ netless: false }); chat(s); },
  "commands.no-windows-job": (s) => { s.platform = "win32"; s.integrations.shell = shell({ useJobObject: false }); },
  "commands.inherit-path": (s) => { s.integrations.shell = shell({ inheritEnv: ["PATH"] }); },
  "commands.hook-lets-through": (s) => { s.integrations.hooks = [{ id: "review", event: "tool.before", executable: "git", args: [], onTimeout: "allow" }]; },
  "commands.container-image-unpinned": (s) => { s.policy.rules.unshift(rule({ tool: "code.run", backend: "docker" })); },
  "web.private-addresses": (s) => { s.network.allowPrivateAddresses = true; },
  "web.fake-ip-proxy": (s) => { s.network.fakeIpProxy = true; },
  "web.anywhere-with-chat": (s) => { chat(s); },
  "web.instructions-only-noted": (s) => { chat(s); s.integrations.web = { allowPrivateAddresses: false, allowedHosts: null, injection: "warn" }; },
  "web.browser-plain-site": (s) => { s.integrations.browser = { allowedOrigins: ["http://intranet.example.com"], downloadTypes: [] }; },
  "web.browser-local-site": (s) => { s.integrations.browser = { allowedOrigins: ["http://192.168.1.1"], downloadTypes: [] }; },
  "web.browser-many-sites": (s) => { s.integrations.browser = { allowedOrigins: Array.from({ length: 11 }, (_, i) => `https://site${i}.example`), downloadTypes: [] }; },
  "web.browser-saves-programs": (s) => { s.integrations.browser = { allowedOrigins: ["https://example.com"], downloadTypes: ["pdf", "exe"] }; },
  "web.trace-plain-address": (s) => { s.traceExport = { enabled: true, endpoint: "http://collector.example.com/v1", plainHeaders: [] }; },
  "add-ons.unpinned-package": (s) => { s.integrations.mcp = [npx("files", ["-y", "@modelcontextprotocol/server-filesystem"])]; },
  "add-ons.malware-check-off": (s) => { s.integrations.mcp = [npx("files", ["-y", "some-server@1.2.3"])]; },
  "add-ons.package-unreadable": (s) => { s.integrations.mcp = [npx("git", ["github:someone/server"])]; },
  "add-ons.server-by-name": (s) => { s.integrations.mcp = [{ ...npx("local", []), command: "my-server" }]; },
  "add-ons.server-many-keys": (s) => { s.integrations.mcp = [{ ...npx("cloud", []), command: "/opt/cloud", envKeys: ["A", "B", "C", "D"] }]; },
  "add-ons.plugin-unfingerprinted": (s) => { s.plugins = [{ id: "dropped", enabled: false, fingerprinted: false, unchanged: false, permissions: [] }]; },
  "add-ons.plugin-changed": (s) => { s.plugins = [{ id: "notes", enabled: true, fingerprinted: true, unchanged: false, permissions: [] }]; },
  "add-ons.plugin-broad": (s) => { s.plugins = [{ id: "ops", enabled: true, fingerprinted: true, unchanged: true, permissions: ["shell.execute"] }]; },
  "add-ons.skill-flagged": (s) => { s.skills = [{ id: "s1", name: "Deploy helper", active: true, findings: 2 }]; },
  "models.small-with-outside-text": (s) => { s.models.push({ id: "local", name: "Local", model: "llama3.1:8b", provider: "ollama" }); },
  "models.legacy": (s) => { s.models.push({ id: "old", name: "Old", model: "gpt-3.5-turbo", provider: "openai" }); },
  "models.older-with-tools": (s) => { s.models.push({ id: "prev", name: "Prev", model: "gpt-4o", provider: "openai" }); },
  "channels.open-to-anyone": (s) => { chat(s, { pairing: false }); },
  "channels.no-pairing": (s) => { chat(s, { pairing: false, allowlist: ["12345"] }); },
  "channels.always-listening": (s) => { chat(s, { activation: "always" }); },
  "channels.mail-in-clear": (s) => { chat(s, { id: "email", type: "email", tls: false }); },
  // Owner ruling 2026-09-30: "a command no rule mentions" is the owner's own tasks' setting (outside ones ask anyway), so only a rule counts.
  "channels.commands-without-asking": (s) => { chat(s); s.integrations.shell = shell(); s.policy.rules = [rule({ tool: "shell.execute", decision: "allow" })]; },
  "channels.personal-details-sent": (s) => { chat(s); s.privacy.outbound = "off"; },
  "channels.no-content-check": (s) => { chat(s); s.privacy.moderation = false; },
};

test("there are about eighty named checks, each with its own id and a plain title", () => {
  const ids = securityChecks.map((check) => check.id);
  assert.ok(ids.length >= 80, `only ${ids.length} checks`);
  assert.equal(new Set(ids).size, ids.length, "two checks share an id");
  for (const check of securityChecks) {
    assert.match(check.id, /^[a-z-]+\.[a-z-]+$/);
    assert.ok(check.title.length > 10 && !/[_{}]/.test(check.title), check.id);
  }
});

test("a clean setup finds nothing, on macOS, Linux and Windows", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const snapshot = clean();
    snapshot.platform = platform;
    const report = runAudit(snapshot);
    assert.deepEqual(report.findings.map((finding) => finding.id), [], platform);
    assert.equal(report.summary.passed, securityChecks.length);
  }
});

test("every check has a setup that makes it speak up", () => {
  assert.deepEqual(securityChecks.map((check) => check.id).filter((id) => !(id in triggers)), [], "a check nobody can make fire");
  for (const [id, mutate] of Object.entries(triggers)) {
    const snapshot = clean();
    mutate(snapshot);
    const found = runAudit(snapshot).findings.find((finding) => finding.id === id);
    assert.ok(found, `${id} stayed quiet`);
    assert.ok(found.detail.length > 20 && found.advice.length > 10, `${id} says too little`);
  }
});

test("urgent findings come first, and one check can raise its own severity", () => {
  const snapshot = clean();
  triggers["remote.many-devices"](snapshot);
  triggers["files.locker-key-readable"](snapshot);
  snapshot.plugins = [{ id: "dropped", enabled: true, fingerprinted: false, unchanged: false, permissions: [] }];
  const report = runAudit(snapshot);
  assert.equal(report.findings[0].severity, "critical");
  assert.equal(report.findings.at(-1).severity, "info");
  assert.equal(report.findings.find((finding) => finding.id === "add-ons.plugin-unfingerprinted").severity, "critical", "a hand-dropped plugin that is on is urgent");
  assert.match(auditText(report), /URGENT/);
});

test("a check that breaks is reported as not run, never as passed", () => {
  const broken = [{ id: "files.broken", area: "files", severity: "warn", title: "A broken check for this test", decide: () => { throw new Error("boom"); } }];
  const report = runAudit(clean(), broken);
  assert.equal(report.summary.passed, 0);
  assert.match(report.findings[0].detail, /could not be run: boom/);
});

test("repairs are offered only for Branch's own files, folders first, each once", () => {
  const snapshot = clean();
  snapshot.paths[0].othersRead = true;
  snapshot.paths[3].othersRead = true;
  snapshot.paths[1].othersWrite = true; // the workspace: described, never changed
  const report = runAudit(snapshot);
  const plans = plannedFixes(report);
  assert.deepEqual(plans.map((plan) => [plan.path, plan.target]), [[DATA, "folder"], [`${DATA}/locker.key`, "file"]]);
  assert.deepEqual(plannedFixes(report, ["files.locker-key-readable"]).map((plan) => plan.path), [`${DATA}/locker.key`]);
});

test("synced and shared folders are recognised by each system's own rules", () => {
  assert.equal(syncedService(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/x`, HOME, "darwin"), "iCloud Drive");
  assert.equal(syncedService(`${HOME}/Library/CloudStorage/Dropbox-Personal/x`, HOME, "darwin"), "Dropbox");
  assert.equal(syncedService(`${HOME}/library/cloudstorage/OneDrive-Work/x`, HOME, "darwin"), "OneDrive", "macOS folds case");
  assert.equal(syncedService("C:\\Users\\ann\\OneDrive\\Branch", "C:\\Users\\ann", "win32"), "OneDrive");
  assert.equal(syncedService("D:\\Work\\Branch", "C:\\Users\\ann", "win32", { OneDriveCommercial: "D:\\Work" }), "Work");
  assert.equal(syncedService("G:\\My Drive\\Branch", "C:\\Users\\ann", "win32"), "my drive");
  assert.equal(syncedService("/home/ann/Dropbox/branch", "/home/ann", "linux"), "Dropbox");
  assert.equal(syncedService("/home/ann/.local/share/branch", "/home/ann", "linux"), null);
  assert.equal(syncedService("/home/ann/dropboxes/branch", "/home/ann", "linux"), null, "a name that only starts the same is not the service");
  assert.equal(sharedPlace("/tmp/branch", "linux"), true);
  assert.equal(sharedPlace("/Users/Shared/branch", "darwin"), true);
  assert.equal(sharedPlace("C:\\Users\\Public\\branch", "win32"), true);
  assert.equal(sharedPlace(`${HOME}/branch`, "darwin"), false);
  assert.equal(wholeHome("C:\\Users\\Ann", "C:\\Users\\ann", "win32"), true);
  assert.equal(wholeHome("/", HOME, "linux"), true);
  assert.equal(wholeHome(WORK, HOME, "darwin"), false);
});

test("icacls output is read for broad groups, in English, French and German", () => {
  const path = "C:\\Users\\ann\\AppData\\Roaming\\Branch\\locker.key";
  const english = `${path} NT AUTHORITY\\SYSTEM:(F)\n    BUILTIN\\Administrators:(F)\n    BUILTIN\\Users:(RX)\n    CONTOSO\\ann:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files`;
  assert.deepEqual(readIcacls(english, path), { groups: ["BUILTIN\\Users"], write: false });
  assert.deepEqual(readIcacls(`${path} Everyone:(I)(OI)(CI)(M)`, path), { groups: ["Everyone"], write: true });
  assert.deepEqual(readIcacls(`${path} Tout le monde:(RX)\n Jeder:(W,D)`, path), { groups: ["Tout le monde", "Jeder"], write: true });
  assert.deepEqual(readIcacls(`${path} Everyone:(DENY)(W)`, path), { groups: [], write: false }, "a refusal is not access");
  assert.deepEqual(readIcacls(`${path} CONTOSO\\ann:(F)`, path), { groups: [], write: false });
});

test("the Windows repair is two icacls calls with exact arguments, and needs a signed-in name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-acl-"));
  t.after(() => discardTemp(root));
  const file = join(root, "locker.key");
  await writeFile(file, "x");
  assert.deepEqual(icaclsRepair(file, "file", "CONTOSO\\ann"), [
    [file, "/inheritance:r", "/grant:r", "CONTOSO\\ann:(F)", "*S-1-5-18:(F)"],
    [file, "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"],
  ]);
  assert.equal(icaclsRepair(root, "folder", "ann")[0][3], "ann:(OI)(CI)(F)");
  const calls = [];
  const fake = async (program, args) => { calls.push([program, ...args]); return ""; };
  const done = await tightenPath({ path: file, target: "file", sentence: "" }, "win32", fake, { USERNAME: "ann", USERDOMAIN: "CONTOSO" });
  assert.equal(done.outcome, "fixed");
  assert.deepEqual(calls, icaclsRepair(file, "file", "CONTOSO\\ann").map((args) => ["icacls", ...args]));
  const refused = await tightenPath({ path: file, target: "file", sentence: "" }, "win32", fake, {});
  assert.equal(refused.outcome, "failed");
  assert.equal(calls.length, 2, "nothing ran without a name to give the file to");
});

test("npx, uvx and pipx command lines name the package they would fetch", () => {
  const cases = [
    ["npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], { ecosystem: "npm", name: "@modelcontextprotocol/server-filesystem", version: null }],
    ["npx", ["-y", "@scope/pkg@1.2.3"], { ecosystem: "npm", name: "@scope/pkg", version: "1.2.3" }],
    ["npx.cmd", ["--package", "left-pad@1.3.0", "left-pad"], { ecosystem: "npm", name: "left-pad", version: "1.3.0" }],
    ["C:\\Program Files\\nodejs\\npx.cmd", ["--package=react@latest", "x"], { ecosystem: "npm", name: "react", version: null }],
    ["/usr/local/bin/bunx", ["eslint@^9"], { ecosystem: "npm", name: "eslint", version: null }],
    ["pnpm", ["dlx", "cowsay@1.6.0"], { ecosystem: "npm", name: "cowsay", version: "1.6.0" }],
    ["npm", ["exec", "--", "tsx@4.0.0"], { ecosystem: "npm", name: "tsx", version: "4.0.0" }],
    ["uvx", ["mcp-server-fetch"], { ecosystem: "PyPI", name: "mcp-server-fetch", version: null }],
    ["uvx", ["--python", "3.12", "--from", "Black[jupyter]==24.1.0", "black"], { ecosystem: "PyPI", name: "black", version: "24.1.0" }],
    ["uvx", ["ruff@0.5.0", "check"], { ecosystem: "PyPI", name: "ruff", version: "0.5.0" }],
    ["uv", ["tool", "run", "Some_Package.Name>=2"], { ecosystem: "PyPI", name: "some-package-name", version: null }],
    ["pipx", ["run", "--spec", "httpie==3.2.2", "http"], { ecosystem: "PyPI", name: "httpie", version: "3.2.2" }],
  ];
  for (const [command, args, expected] of cases) assert.deepEqual(packageOfLaunch(command, args), expected, `${command} ${args.join(" ")}`);
  for (const [command, args] of [["npx", ["github:user/repo"]], ["npx", ["./local"]], ["npx", ["-c", "echo hi"]],
    ["node", ["server.js"]], ["uvx", ["git+https://example.com/x.git"]], ["pipx", ["install", "black"]], ["npx", []]])
    assert.equal(packageOfLaunch(command, args), null, `${command} ${args.join(" ")}`);
  assert.equal(npmPackage("../x"), null);
  assert.deepEqual(pypiPackage("requests (==2.0)"), { ecosystem: "PyPI", name: "requests", version: null });
});

test("model names are read for size and generation", () => {
  assert.equal(billionsInName("llama3.1:8b"), 8);
  assert.equal(billionsInName("mixtral-8x7b-instruct"), 56);
  assert.equal(billionsInName("qwen2.5-coder:32b"), 32);
  assert.equal(billionsInName("gemma-3n-e2b"), 2);
  assert.equal(billionsInName("gpt-5"), null);
  assert.equal(modelConcern("claude-3-5-haiku-latest"), "small");
  assert.equal(modelConcern("gemini-2.0-flash-lite"), "small");
  assert.equal(modelConcern("gpt-3.5-turbo"), "legacy");
  assert.equal(modelConcern("gpt-4o-2024-08-06"), "older");
  assert.equal(modelConcern("llama-3.3-70b"), null);
  assert.equal(modelConcern("claude-opus-5"), null);
  assert.equal(modelConcern("gpt-5-mini"), null, "a mini of a current family is not flagged by its name alone");
});

test("key-like values are found by place, never kept, and names of secrets are not values", async (t) => {
  const places = keyLikeValues({
    mcp: [{ args: ["--token", "sk-proj-abcdefghij1234567890ABCDEFGH"] }], // not-a-real-secret
    channels: [{ tokenSecret: "TELEGRAM_BOT_TOKEN", password: "hunter22x!" }],
    web: { search: { apiKey: "your-key-here" } },
  });
  assert.deepEqual(places, ["mcp[0].args[1]", "channels[0].password"]);
  const root = await mkdtemp(join(tmpdir(), "branch-facts-"));
  t.after(() => discardTemp(root));
  const file = join(root, "integrations.json");
  await writeFile(file, JSON.stringify({
    mcp: [npx("fs", ["-y", "server@1.0.0"], { envKeys: ["A"] })],
    shell: { executables: { git: { path: "/usr/bin/git" } } },
    channels: [{ id: "mail", type: "email", imap: { tls: true }, smtp: { tls: false }, pairing: false }],
    hooks: [{ id: "h", event: "tool.before", executable: "git", onTimeout: "allow" }],
  }));
  const facts = await readIntegrationFacts(file);
  assert.equal(facts.problem, null);
  assert.deepEqual(facts.shell, { executables: [{ alias: "git", path: "/usr/bin/git", args: [] }], netless: false, useJobObject: true, inheritEnv: ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] });
  assert.deepEqual(facts.channels, [{ id: "mail", type: "email", activation: "mention", pairing: false, allowlist: [], tls: false }]);
  assert.equal(facts.hooks[0].onTimeout, "allow");
  await writeFile(file, "{ not json");
  assert.match((await readIntegrationFacts(file)).problem, /not valid JSON/);
  assert.match((await readIntegrationFacts(join(root, "missing.json"))).problem, /not there/);
});

/* ---- A real Branch in a temporary folder ---- */

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-security-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  const provider = { name: "security-fixture", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace, dataDir, provider, home: root, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, dataDir, workspace };
}

test("a fresh install has both checks when needed and runs neither by itself; switched off, no tool for the assistant", async (t) => {
  const { app } = await fixture(t);
  // The ship-on rule (src/security-audit/settings.ts): both ship "when needed".
  assert.deepEqual(securityCheckSettings(app.store, "local"), { audit: "when-needed", malware: "when-needed" });
  assert.deepEqual(app.security.state().report, null, "nothing ran by itself");
  app.security.configure({ audit: "off", malware: "off" });
  assert.equal(app.registry.names().includes(securityToolName), false);
  app.security.configure({ audit: "when-needed" });
  assert.equal(app.registry.names().includes(securityToolName), true, "when needed, the assistant can ask");
  assert.deepEqual(app.security.settings(), { audit: "when-needed", malware: "off" }, "the other switch kept its value");
  assert.throws(() => app.security.configure({ audit: "always" }));
  app.security.configure({ audit: "off" });
  assert.equal(app.registry.names().includes(securityToolName), false);
});

// Review r4117782283: a group the owner set to answer every message is reported, even with no launch settings file.
test("a group set to answer every message is reported by the always-listening check", async (t) => {
  const { app } = await fixture(t);
  const quiet = await app.security.check();
  assert.ok(!quiet.findings.some((finding) => finding.id === "channels.always-listening"));
  setGroupActivation(app.store, app.runtime.owner, { channel: "telegram", chatId: "-10", activation: "always", title: "Family" }, "test");
  const found = (await app.security.check()).findings.find((finding) => finding.id === "channels.always-listening");
  assert.ok(found, "the group override stayed quiet");
  assert.match(found.detail, /Family/);
});

test("the tool the assistant uses reads the same check and hands back no repairs", async (t) => {
  const { app } = await fixture(t);
  app.security.configure({ audit: "when-needed" });
  const context = app.runtime.context({ runId: "security-tool" });
  const answer = await app.registry.execute(securityToolName, {}, { ...context, permissions: new Set(["history.read"]) });
  assert.equal(answer.summary.checks, securityChecks.length);
  assert.ok(answer.findings.every((finding) => !("fixes" in finding)));
});

test("files other people can read in the private folder are found and repaired there only", { skip: process.platform === "win32" }, async (t) => {
  const { app, dataDir, root } = await fixture(t);
  const outside = join(root, "not-branch.txt");
  await writeFile(outside, "the owner's own file");
  await chmod(outside, 0o644);
  await chmod(dataDir, 0o755);
  await chmod(join(dataDir, "branch.sqlite"), 0o644);
  await mkdir(join(dataDir, "plugins"), { recursive: true });
  await symlink(outside, join(dataDir, "plugins", "linked.mjs"));
  const before = await app.security.check();
  const ids = before.findings.map((finding) => finding.id);
  assert.ok(ids.includes("files.private-folder-open"), ids.join(", "));
  assert.ok(ids.includes("files.database-readable"), ids.join(", "));
  const { fixed, report } = await app.security.fix();
  assert.ok(fixed.some((result) => result.path === dataDir && result.outcome === "fixed"));
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDir, "branch.sqlite"))).mode & 0o777, 0o600);
  assert.equal((await stat(outside)).mode & 0o777, 0o644, "a file a link points at is never touched");
  assert.ok(!report.findings.some((finding) => finding.id.startsWith("files.") && finding.fixes?.length), "nothing fixable is left");
});

test("once the private folder is closed, files inside it are not reported again", { skip: process.platform === "win32" }, async (t) => {
  const { app, dataDir } = await fixture(t);
  await chmod(dataDir, 0o700);
  await chmod(join(dataDir, "branch.sqlite"), 0o644);
  const report = await app.security.check();
  assert.equal(report.findings.some((finding) => finding.id === "files.database-readable"), false);
});

test("a repair refuses a path that became a link after it was checked", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-link-"));
  t.after(() => discardTemp(root));
  const target = join(root, "target"), link = join(root, "link");
  await writeFile(target, "x");
  await chmod(target, 0o644);
  await symlink(target, link);
  const [result] = await applyFixes([{ path: link, target: "file", sentence: "" }], "linux");
  assert.equal(result.outcome, "skipped");
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  const [gone] = await applyFixes([{ path: join(root, "nothing"), target: "file", sentence: "" }], "linux");
  assert.equal(gone.outcome, "skipped");
});

test("on Windows the check asks icacls about each file and repairs with it", async (t) => {
  const { app, dataDir } = await fixture(t);
  const calls = [];
  const fake = async (program, args) => {
    calls.push([program, ...args]);
    return args.length === 1 ? `${args[0]} NT AUTHORITY\\SYSTEM:(F)\n    BUILTIN\\Users:(RX)\n` : "";
  };
  const { SecurityService } = await import("../dist/security-audit/index.js");
  const service = new SecurityService(app, { dataDir, integrationsPath: () => null, platform: "win32", run: fake, env: { USERNAME: "ann" }, home: "C:\\Users\\ann" });
  const report = await service.check();
  assert.ok(report.findings.some((finding) => finding.id === "files.database-readable"), "inside an open folder a file is still reachable on Windows");
  assert.ok(calls.every(([program, ...args]) => program === "icacls" && args.length === 1), "looking only reads");
  calls.length = 0;
  await service.fix(["files.database-readable"]);
  const repairs = calls.filter((call) => call.length > 2);
  const expected = icaclsRepair(join(dataDir, "branch.sqlite"), "file", "ann").map((args) => ["icacls", ...args]);
  assert.deepEqual(repairs.filter((call) => call[1] === expected[0][1]), expected);
  assert.ok(repairs.every((call) => call[1].startsWith(join(dataDir, "branch.sqlite"))), "only the database files were repaired");
});

test("the launch settings file is read for what is in it", async (t) => {
  const { app, root } = await fixture(t);
  const file = join(root, "integrations.json");
  await writeFile(file, JSON.stringify({
    mcp: [npx("files", ["-y", "@modelcontextprotocol/server-filesystem", "--token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"])], // not-a-real-secret
    channels: [channel({ pairing: false })],
  }));
  const { SecurityService } = await import("../dist/security-audit/index.js");
  const service = new SecurityService(app, { dataDir: join(root, "data"), integrationsPath: () => file, home: root });
  app.security.configure({ malware: "off" }); // the lookup ships when needed; with it off the check says so
  const ids = (await service.check()).findings.map((finding) => finding.id);
  for (const id of ["add-ons.unpinned-package", "add-ons.malware-check-off", "secrets.key-in-server-arguments", "channels.open-to-anyone"])
    assert.ok(ids.includes(id), `${id} missing from ${ids.join(", ")}`);
  const text = JSON.stringify(await service.check());
  assert.equal(text.includes("ghp_abcdefghijklmnop"), false, "the key itself never appears in the report");
});

test("the doctor adds one line for security, and points at the command that repairs", async () => {
  const deps = { run: async () => "git version 2.0", portFree: async () => true };
  const base = { fix: false, port: 3210, workspace: tmpdir(), browsersInstalled: async () => true };
  const clear = await doctorFix({ ...base, security: async () => ({ critical: 0, warn: 0, checks: 85 }) }, deps);
  assert.deepEqual(clear.checks.at(-1), { name: "Security", ok: true, summary: "All 85 security checks passed." });
  const found = await doctorFix({ ...base, security: async () => ({ critical: 1, warn: 2, checks: 85 }) }, deps);
  assert.equal(found.ok, false);
  assert.match(found.checks.at(-1).fix, /branch security audit --fix/);
  const without = await doctorFix(base, deps);
  assert.equal(without.checks.some((check) => check.name === "Security"), false, "without the hook the doctor is as it was");
});

test("branch security audit prints the report, and --fix repairs", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-security-cli-"));
  t.after(() => discardTemp(root));
  const dataDir = join(root, "data"), settings = join(root, "integrations.json");
  await writeFile(settings, JSON.stringify({ web: { allowPrivateAddresses: true } }));
  await chmod(settings, 0o666);
  const env = { ...process.env, ...(await fixtureModel()).env, BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_DATA_DIR: dataDir, BRANCH_INTEGRATIONS: settings };
  const cli = join(import.meta.dirname, "..", "dist", "cli.js");
  const first = await run(process.execPath, [cli, "security", "audit", "--json"], { env }).catch((error) => error);
  const report = JSON.parse(first.stdout).report;
  const ids = report.findings.map((finding) => finding.id);
  assert.ok(ids.includes("files.launch-settings-writable"), ids.join(", "));
  assert.ok(ids.includes("web.private-addresses"), "the live network settings came from the file");
  assert.equal(first.code, 1, "something urgent is left, so the command says so");
  const second = await run(process.execPath, [cli, "security", "audit", "--fix"], { env }).catch((error) => error);
  assert.match(second.stdout, /FIXED/);
  assert.equal((await stat(settings)).mode & 0o777, 0o600);
  const usage = await run(process.execPath, [cli, "security"], { env }).catch((error) => error);
  assert.match(usage.stderr, /Usage: branch security audit/);
  const help = await run(process.execPath, [cli, "security", "--help"], { env });
  assert.match(help.stdout, /security audit/);
  assert.equal(JSON.parse(await readFile(settings, "utf8")).web.allowPrivateAddresses, true, "the file's contents were not changed");
});

/* ---- Integrator's adversarial pass ---- */

test("a Branch made in a temporary folder checks that folder's home, never the owner's real one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-security-home-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const provider = { name: "security-fixture", complete: async () => ({ content: "Done", toolCalls: [] }) };
  // The workspace is the whole (pretend) home folder, which only the pretend home can reveal.
  const app = await createBranch({ workspace: home, dataDir: join(root, "data"), provider, home });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const report = await app.security.check();
  assert.ok(report.findings.some((finding) => finding.id === "files.workspace-whole-home"), "the home handed in is the one looked at");
});

test("the assistant's tool only reads: it takes no arguments and hands back no repairs", async (t) => {
  const { app, dataDir } = await fixture(t);
  await chmod(dataDir, 0o755);
  app.security.configure({ audit: "when-needed", malware: "on" });
  const permissions = new Set(["history.read"]);
  const context = { signal: new AbortController().signal, permissions, budget: { step: () => undefined } };
  await assert.rejects(app.registry.execute(securityToolName, { audit: "off" }, context), "a switch cannot be passed in");
  await assert.rejects(app.registry.execute(securityToolName, { fix: true }, context));
  const result = await app.registry.execute(securityToolName, {}, context);
  if (process.platform !== "win32") assert.ok(result.findings.some((finding) => finding.id === "files.private-folder-open"), "the open folder was found");
  assert.equal(result.findings.some((finding) => "fixes" in finding), false, "no list of paths to change reaches the model");
  assert.deepEqual(app.security.settings(), { audit: "when-needed", malware: "on" }, "running it changed no switch");
  if (process.platform !== "win32") assert.equal((await stat(dataDir)).mode & 0o777, 0o755, "running it changed no file");
});

test("a server wrapped in cmd /c or started with value-taking options is still named", () => {
  const cases = [
    ["cmd", ["/c", "npx", "-y", "evil-mcp"], { ecosystem: "npm", name: "evil-mcp", version: null }],
    ["C:\\Windows\\System32\\cmd.exe", ["/C", "npx.cmd", "-y", "evil-mcp@1.0.0"], { ecosystem: "npm", name: "evil-mcp", version: "1.0.0" }],
    ["cmd.exe", ["/d", "/s", "/c", "uvx", "evil-py"], { ecosystem: "PyPI", name: "evil-py", version: null }],
    ["cmd", ["/c", "npx -y evil-mcp"], { ecosystem: "npm", name: "evil-mcp", version: null }],
    ["npx", ["--prefix", "/somewhere", "evil-mcp"], { ecosystem: "npm", name: "evil-mcp", version: null }],
    ["npx", ["--loglevel", "silent", "-y", "evil-mcp"], { ecosystem: "npm", name: "evil-mcp", version: null }],
    ["uvx", ["--refresh-package", "requests", "evil-py"], { ecosystem: "PyPI", name: "evil-py", version: null }],
    ["uvx", ["--exclude-newer", "2026-01-01", "evil-py"], { ecosystem: "PyPI", name: "evil-py", version: null }],
    ["uvx", ["--python-platform", "linux", "--index-strategy", "unsafe-best-match", "evil-py"], { ecosystem: "PyPI", name: "evil-py", version: null }],
  ];
  for (const [command, args, expected] of cases) assert.deepEqual(packageOfLaunch(command, args), expected, `${command} ${args.join(" ")}`);
  assert.equal(packageOfLaunch("cmd", ["/c", "echo", "hello"]), null, "cmd running anything else is not a package");
});

test("trusting a fake-IP proxy is a warning that says what it gives up", async () => {
  const snapshot = clean();
  triggers["web.fake-ip-proxy"](snapshot);
  const found = runAudit(snapshot).findings.find((finding) => finding.id === "web.fake-ip-proxy");
  assert.equal(found.severity, "warn", "as serious as letting the assistant reach private addresses");
  assert.equal(found.severity, securityChecks.find((check) => check.id === "web.private-addresses").severity);
  assert.match(found.detail, /proxy does the name lookups/);
  assert.match(found.detail, /this computer or your home network/, "a name that really points there can get through");
  // The title the card shows, in each language, says it too.
  const title = async (language) => JSON.parse(await readFile(new URL(`../public/locales/${language}.json`, import.meta.url), "utf8"))["security.check.web.fake-ip-proxy"];
  assert.match(await title("en"), /looks up site names itself/, "who does the name lookups when the setting is off");
  assert.match(await title("en"), /home network/, "what the setting gives up");
  assert.match(await title("fr"), /résout lui-même les noms/);
  assert.match(await title("fr"), /réseau local/);
});
