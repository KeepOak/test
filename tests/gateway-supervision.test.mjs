/**
 * UP-PLATFORM-002: the operating system keeps the background gateway running. Windows: a scheduled task (restart on
 * failure) running "Branch Agent.exe" --branch-gateway, or a Startup shortcut where schtasks is refused; the window
 * starts the gateway through the task. Linux: Restart=always with a start limit, and a stop on purpose that stays
 * stopped. Everywhere: a restart storm is said once. Stand-ins only: nothing is registered on this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  gatewayTaskXml, taskXmlBytes, shouldFallBackToStartup, registerGatewayTask, ensureGatewayTask, followSignInChoice,
  startupShortcutPath, taskUser, gatewayTaskName, gatewayTaskMarker,
} from "../dist/install/gateway-task.js";
import { launchSupervisedGateway } from "../dist/desktop/gateway-supervised.js";
import { systemdUnit, markStoppedOnPurpose, stoppedOnPurposeCode } from "../dist/install/systemd.js";
import { recordUncleanStart, restartStorm } from "../dist/never-break/gateway-state.js";

const app = "C:\\Program Files\\Branch & Co <x>\\Branch Agent.exe";

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-gw-supervise-"));
  t.after(() => discardTemp(root));
  return root;
}

/** A stand-in schtasks: `answer(args)` throws to refuse; every call is kept. */
function schtasks(answer = () => "") {
  const calls = [], xml = [];
  const run = async (file, args) => {
    calls.push(args);
    assert.match(file, /schtasks\.exe$/i);
    if (args[0] === "/Create") xml.push(await readFile(args[args.indexOf("/XML") + 1]));
    return answer(args);
  };
  return { calls, xml, run };
}
const denied = () => { throw new Error("C:\\Windows\\System32\\schtasks.exe failed: ERROR: Access is denied."); };

test("the task runs the app itself at sign-in, restarts it on failure, and never stops it for time or battery", () => {
  const xml = gatewayTaskXml({ executable: app, atSignIn: true, user: "PC\\pat" });
  assert.match(xml, /<Command>C:\\Program Files\\Branch &amp; Co &lt;x&gt;\\Branch Agent\.exe<\/Command>/, "text is escaped");
  assert.match(xml, /<Arguments>--branch-gateway<\/Arguments>/);
  assert.match(xml, /<WorkingDirectory>C:\\Program Files\\Branch &amp; Co &lt;x&gt;<\/WorkingDirectory>/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\pat<\/UserId>\s*<\/LogonTrigger>/);
  assert.match(xml, /<UserId>PC\\pat<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>\s*<\/RestartOnFailure>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/, "no three-day limit");
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>\s*<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.ok(!/wscript|cscript|\.vbs|cmd\.exe/i.test(xml), "no script host and no console");
  const off = gatewayTaskXml({ executable: app, atSignIn: false, user: null });
  assert.ok(!/<Triggers>|LogonTrigger/.test(off), "with Start with Windows off, nothing starts it at sign-in");
  assert.match(off, /<GroupId>S-1-5-32-545<\/GroupId>/);
  assert.match(off, /<RestartOnFailure>/, "it still restarts a gateway it started itself");
  const bytes = taskXmlBytes(xml);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString("utf16le"), xml);
  assert.equal(taskUser({ USERDOMAIN: "PC", USERNAME: "pat" }), "PC\\pat");
  assert.equal(taskUser({}), null);
});

test("schtasks refused or stuck falls back to the Startup folder; any other failure is a real problem", () => {
  for (const words of ["ERROR: Access is denied.", "FEHLER: Zugriff verweigert", "ERROR: Acceso denegado.", "错误: 拒绝访问。", "schtasks timed out"])
    assert.equal(shouldFallBackToStartup(new Error(`schtasks.exe failed: ${words}`)), true, words);
  assert.equal(shouldFallBackToStartup(new Error("schtasks.exe failed: Command failed", { cause: { killed: true } })), true, "stopped for taking too long");
  assert.equal(shouldFallBackToStartup(new Error("schtasks.exe failed: ERROR: The task XML is malformed.")), false);
  assert.equal(startupShortcutPath({ APPDATA: "/r" }), join("/r", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Branch Agent gateway.lnk"));
  assert.throws(() => startupShortcutPath({}), /Startup folder/);
});

test("registering writes the task's XML only for the moment schtasks reads it", async (t) => {
  const root = await scratch(t), tasks = schtasks();
  const shortcut = startupShortcutPath({ APPDATA: join(root, "roaming") });
  await mkdir(join(shortcut, ".."), { recursive: true }); await writeFile(shortcut, "an earlier fallback");
  const kind = await registerGatewayTask({ executable: app, atSignIn: true, user: "PC\\pat", dataDir: root },
    { run: tasks.run, env: { APPDATA: join(root, "roaming") }, writeShortcut: async () => assert.fail("no shortcut when the task is there") });
  assert.equal(kind, "task");
  assert.deepEqual(tasks.calls[0], ["/Create", "/F", "/TN", gatewayTaskName, "/XML", join(root, "gateway-task.xml")]);
  assert.equal(tasks.xml[0].subarray(2).toString("utf16le"), gatewayTaskXml({ executable: app, atSignIn: true, user: "PC\\pat" }));
  assert.equal(await stat(join(root, "gateway-task.xml")).catch(() => null), null, "the XML is removed again");
  assert.equal(await stat(shortcut).catch(() => null), null, "the task starts it now, not a second Startup entry");
});

test("Access is denied: a Startup shortcut starts the app's gateway directly, with no VBScript", async (t) => {
  const root = await scratch(t), tasks = schtasks(denied), links = [];
  const deps = { run: tasks.run, env: { APPDATA: join(root, "roaming") }, writeShortcut: async (link) => { links.push(link); } };
  assert.equal(await registerGatewayTask({ executable: app, atSignIn: true, user: null, dataDir: root }, deps), "startup");
  assert.deepEqual(links, [{ path: startupShortcutPath(deps.env), target: app, arguments: "--branch-gateway",
    workingDirectory: "C:\\Program Files\\Branch & Co <x>", description: "Branch Agent, working with the window closed" }]);
  assert.ok(links[0].path.endsWith(".lnk"));
  assert.equal(await registerGatewayTask({ executable: app, atSignIn: false, user: null, dataDir: root }, deps), "none",
    "with Start with Windows off, a shortcut would only start it against the owner's choice");
  assert.equal(links.length, 1);
  const broken = schtasks(() => { throw new Error("schtasks.exe failed: ERROR: The task XML is malformed."); });
  await assert.rejects(registerGatewayTask({ executable: app, atSignIn: true, user: null, dataDir: root }, { ...deps, run: broken.run }), /malformed/);
  assert.equal(links.length, 1, "a real failure is reported, not hidden behind a shortcut");
  await assert.rejects(registerGatewayTask({ executable: "C:\\node\\node.exe", atSignIn: true, user: null, dataDir: root }, deps),
    /Only the installed Branch Agent app/);
});

test("the window registers once: the same wish is only confirmed, a changed Start with Windows registers again", async (t) => {
  const root = await scratch(t), tasks = schtasks();
  const deps = { run: tasks.run, env: { APPDATA: join(root, "roaming") }, writeShortcut: async () => {} };
  const input = { executable: app, atSignIn: true, user: "PC\\pat", dataDir: root };
  assert.equal(await followSignInChoice(input, deps), null, "nothing is registered from Settings before the window did");
  assert.equal(await ensureGatewayTask(input, deps), "task");
  assert.equal(await ensureGatewayTask(input, deps), "task");
  assert.deepEqual(tasks.calls.map((args) => args[0]), ["/Create", "/Query"], "the second start only asks whether it is still there");
  assert.equal(await followSignInChoice({ ...input, atSignIn: false }, deps), "task");
  assert.equal(tasks.calls.at(-1)[0], "/Create");
  assert.ok(!/LogonTrigger/.test(tasks.xml.at(-1).subarray(2).toString("utf16le")), "the sign-in trigger follows the switch");
  const refused = schtasks(denied), marker = join(root, "refused");
  await mkdir(marker);
  const off = { ...input, atSignIn: false, dataDir: marker };
  assert.equal(await ensureGatewayTask(off, { ...deps, run: refused.run }), "none");
  assert.equal(await ensureGatewayTask(off, { ...deps, run: refused.run }), "none");
  assert.equal(refused.calls.length, 1, "a refusal is not asked again on every start");
  assert.ok(JSON.parse(await readFile(join(marker, gatewayTaskMarker), "utf8")).hash);
});

test("the window starts the gateway through its task, and directly when that cannot work", async () => {
  const lines = [], started = [];
  const base = (overrides) => ({ supervise: async () => "task", runTask: async () => { started.push("task"); },
    join: async () => null, direct: async () => { started.push("direct"); return { direct: true }; }, log: (line) => lines.push(line),
    graceMs: 60, registerMs: 50, ...overrides });
  let asked = 0;
  assert.deepEqual(await launchSupervisedGateway(base({ graceMs: 5000, join: async () => (++asked >= 3 ? { task: true } : null) })), { task: true });
  assert.deepEqual(started, ["task"], "started by Task Scheduler, which restarts it after a crash");
  started.length = 0;
  assert.deepEqual(await launchSupervisedGateway(base({ join: async () => ({ running: true }), supervise: async () => assert.fail("not asked") })),
    { running: true }, "one already running is joined");
  assert.deepEqual(await launchSupervisedGateway(base({ supervise: async () => "startup" })), { direct: true });
  assert.deepEqual(await launchSupervisedGateway(base({ runTask: async () => { throw new Error("The task is disabled"); } })), { direct: true });
  assert.deepEqual(await launchSupervisedGateway(base({})), { direct: true }, "a task gateway that never becomes ready");
  assert.deepEqual(await launchSupervisedGateway(base({ supervise: () => new Promise(() => {}) })), { direct: true }, "a stuck schtasks");
  assert.deepEqual(await launchSupervisedGateway(base({ supervise: async () => { throw new Error("denied"); } })), { direct: true });
  assert.match(lines.join("\n"), /did not start it: The task is disabled/);
  assert.match(lines.join("\n"), /did not become ready through its scheduled task/);
});

test("Linux: always restarted, within a start limit, except after a stop on purpose", () => {
  const unit = systemdUnit({ executable: "/opt/branch/branch-agent", script: "/opt/branch/cli.js", dataDir: "/home/pat/.local/share/branch", workspace: "/w", port: 3210 });
  assert.match(unit, /^\[Unit\][^[]*^StartLimitIntervalSec=600$[^[]*^StartLimitBurst=5$/m, "the start limit belongs to [Unit]");
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=10$/m);
  assert.match(unit, new RegExp(`^RestartPreventExitStatus=${stoppedOnPurposeCode}$`, "m"));
  assert.match(unit, new RegExp(`^SuccessExitStatus=${stoppedOnPurposeCode}$`, "m"), "a quit leaves the unit inactive, not failed");
  assert.match(unit, /^Environment="BRANCH_SERVICE_MANAGER=systemd"$/m);
  const target = { exitCode: undefined };
  markStoppedOnPurpose({ BRANCH_SERVICE_MANAGER: "systemd" }, target);
  assert.equal(target.exitCode, 78);
  const elsewhere = { exitCode: undefined };
  markStoppedOnPurpose({}, elsewhere);
  assert.equal(elsewhere.exitCode, undefined, "launchd and a terminal keep the ordinary exit");
  const restarting = { exitCode: 75 };
  markStoppedOnPurpose({ BRANCH_SERVICE_MANAGER: "systemd" }, restarting);
  assert.equal(restarting.exitCode, 75, "the dashboard's Restart keeps its code, so systemd starts it again");
});

test("three unclean starts within ten minutes are a restart storm, said once per ten minutes", async (t) => {
  const root = await scratch(t), at = Date.parse("2026-09-29T12:00:00Z"), minute = 60_000;
  assert.equal(restartStorm.threshold, 3);
  assert.equal(await recordUncleanStart(root, at), null);
  assert.equal(await recordUncleanStart(root, at + minute), null);
  assert.match(await recordUncleanStart(root, at + 2 * minute), /started again 3 times in the last ten minutes/);
  assert.equal(await recordUncleanStart(root, at + 3 * minute), null, "said once per window");
  assert.equal(await recordUncleanStart(root, at + 30 * minute), null, "old restarts fall out of the window");
  assert.equal(await recordUncleanStart(root, at + 31 * minute), null);
  assert.match(await recordUncleanStart(root, at + 32 * minute), /started again 3 times/, "a new storm later is said again");
  await writeFile(join(root, "gateway-restarts.json"), "not json");
  assert.equal(await recordUncleanStart(root, at + 40 * minute), null, "an unreadable file never stops the gateway");
});
