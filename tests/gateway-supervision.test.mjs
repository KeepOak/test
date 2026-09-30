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
  startupShortcutPath, taskUser, gatewayTaskName, gatewayTaskMarker, failureHresult, accessDeniedHresult, registerTaskArgs,
  startGatewayAgain,
} from "../dist/install/gateway-task.js";
import { uninstallScript } from "../dist/install/installer.js";
import { windowsSwap } from "../dist/desktop/updater.js";
import { restartService } from "../dist/install/service-return.js";
import { launchSupervisedGateway } from "../dist/desktop/gateway-supervised.js";
import { systemdUnit, markStoppedOnPurpose, stoppedOnPurposeCode } from "../dist/install/systemd.js";
import { recordUncleanStart, restartStorm } from "../dist/never-break/gateway-state.js";

const app = "C:\\Program Files\\Branch & Co <x>\\Branch Agent.exe";

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-gw-supervise-"));
  t.after(() => discardTemp(root));
  return root;
}

/**
 * A stand-in Task Scheduler: schtasks calls are kept as their arguments, a registration through PowerShell as
 * ["/Register", xmlPath]; `answer(call)` throws to refuse.
 */
function schtasks(answer = () => "") {
  const calls = [], xml = [];
  const run = async (file, args) => {
    let call = args;
    if (/powershell\.exe$/i.test(file)) {
      const path = /ReadAllText\('([^']+)'\)/.exec(args.at(-1))[1].replace(/''/g, "'");
      assert.match(args.at(-1), new RegExp(`RegisterTask\\('${gatewayTaskName}'`));
      call = ["/Register", path];
      xml.push(await readFile(path));
    } else assert.match(file, /schtasks\.exe$/i);
    calls.push(call);
    return answer(call);
  };
  return { calls, xml, run };
}
/** What registerTaskArgs prints when Task Scheduler refuses, on any language of Windows. */
const denied = (call) => {
  if (call[0] === "/Register") throw new Error("powershell.exe failed: hresult=0x80070005 Zugriff verweigert");
  throw new Error("schtasks.exe failed: ERROR");
};

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
  const off = gatewayTaskXml({ executable: app, atSignIn: false, user: "pat" });
  assert.ok(!/<Triggers>|LogonTrigger/.test(off), "with Start with Windows off, nothing starts it at sign-in");
  assert.ok(!/GroupId/.test(off), "never a group: the task is this account's alone");
  assert.match(off, /<RestartOnFailure>/, "it still restarts a gateway it started itself");
  const bytes = taskXmlBytes(xml);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString("utf16le"), xml);
  assert.equal(taskUser({ USERDOMAIN: "PC", USERNAME: "pat" }), "PC\\pat");
  assert.equal(taskUser({}, () => "pat"), "pat", "the account this process runs as when Windows' variables are missing");
  assert.equal(taskUser({}, () => ""), null);
  assert.equal(taskUser({}, () => { throw new Error("no account"); }), null);
});

test("a refusal is told by its HRESULT, never by words; refused or stuck falls back, any other failure is real", () => {
  const failed = (text) => new Error(`powershell.exe failed: ${text}`);
  assert.equal(shouldFallBackToStartup(failed("hresult=0x80070005 Access is denied.")), true);
  assert.equal(shouldFallBackToStartup(failed("hresult=0x80070005 アクセスが拒否されました。")), true, "whatever language the words are in");
  assert.equal(failureHresult(failed("hresult=0x80070005 x")), accessDeniedHresult);
  assert.equal(shouldFallBackToStartup(failed("ERROR: Access is denied.")), false, "words alone decide nothing");
  assert.equal(shouldFallBackToStartup(failed("hresult=0x80041318 The task XML contains a value which is incorrectly formatted.")), false);
  assert.equal(shouldFallBackToStartup(new Error("powershell.exe failed: Command failed", { cause: { killed: true } })), true, "stopped for taking too long");
  assert.equal(failureHresult(failed("Cannot create type. Only core types are supported in this language mode.")), null);
  const script = registerTaskArgs("C:\\Users\\O'Neil\\state\\gateway-task.xml").at(-1);
  assert.match(script, /ReadAllText\('C:\\Users\\O''Neil\\state\\gateway-task\.xml'\)/, "a quote in the path is doubled for PowerShell");
  assert.match(script, /while \(\$e\.InnerException\)/, "the innermost exception's HRESULT, not PowerShell's wrapper's");
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
  assert.deepEqual(tasks.calls[0], ["/Register", join(root, "gateway-task.xml")]);
  assert.equal(tasks.xml[0].subarray(2).toString("utf16le"), gatewayTaskXml({ executable: app, atSignIn: true, user: "PC\\pat" }));
  assert.equal(await stat(join(root, "gateway-task.xml")).catch(() => null), null, "the XML is removed again");
  assert.equal(await stat(shortcut).catch(() => null), null, "the task starts it now, not a second Startup entry");
});

test("Access is denied: a Startup shortcut starts the app's gateway directly, with no VBScript", async (t) => {
  const root = await scratch(t), tasks = schtasks(denied), links = [];
  const deps = { run: tasks.run, env: { APPDATA: join(root, "roaming") }, writeShortcut: async (link) => { links.push(link); } };
  assert.equal(await registerGatewayTask({ executable: app, atSignIn: true, user: "pat", dataDir: root }, deps), "startup");
  assert.deepEqual(links, [{ path: startupShortcutPath(deps.env), target: app, arguments: "--branch-gateway",
    workingDirectory: "C:\\Program Files\\Branch & Co <x>", description: "Branch Agent, working with the window closed" }]);
  assert.ok(links[0].path.endsWith(".lnk"));
  assert.equal(await registerGatewayTask({ executable: app, atSignIn: false, user: "pat", dataDir: root }, deps), "none",
    "with Start with Windows off, a shortcut would only start it against the owner's choice");
  assert.equal(links.length, 1);
  const broken = schtasks(() => { throw new Error("powershell.exe failed: hresult=0x80041318 The task XML is malformed."); });
  await assert.rejects(registerGatewayTask({ executable: app, atSignIn: true, user: "pat", dataDir: root }, { ...deps, run: broken.run }), /malformed/);
  assert.equal(links.length, 1, "a real failure is reported, not hidden behind a shortcut");
  await assert.rejects(registerGatewayTask({ executable: "C:\\node\\node.exe", atSignIn: true, user: "pat", dataDir: root }, deps),
    /Only the installed Branch Agent app/);
});

test("the window registers once: the same wish is only confirmed, a changed Start with Windows registers again", async (t) => {
  const root = await scratch(t), tasks = schtasks();
  const deps = { run: tasks.run, env: { APPDATA: join(root, "roaming") }, writeShortcut: async () => {} };
  const input = { executable: app, atSignIn: true, user: "PC\\pat", dataDir: root };
  assert.equal(await followSignInChoice(input, deps), null, "nothing is registered from Settings before the window did");
  assert.equal(await ensureGatewayTask(input, deps), "task");
  assert.equal(await ensureGatewayTask(input, deps), "task");
  assert.deepEqual(tasks.calls.map((args) => args[0]), ["/Register", "/Query"], "the second start only asks whether it is still there");
  assert.equal(await followSignInChoice({ ...input, atSignIn: false }, deps), "task");
  assert.equal(tasks.calls.at(-1)[0], "/Register");
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

test("an unknown account registers nothing: the task never falls back to a group that any sign-in would start", async (t) => {
  const root = await scratch(t), tasks = schtasks(), links = [];
  const deps = { run: tasks.run, env: { APPDATA: join(root, "roaming") }, writeShortcut: async (link) => { links.push(link); } };
  for (const user of [null, "", "  ", "PC\\pat\nx"]) {
    assert.throws(() => gatewayTaskXml({ executable: app, atSignIn: true, user }), /did not say which account/);
    await assert.rejects(registerGatewayTask({ executable: app, atSignIn: true, user, dataDir: root }, deps), /did not say which account/);
    await assert.rejects(ensureGatewayTask({ executable: app, atSignIn: true, user, dataDir: root }, deps), /did not say which account/);
  }
  assert.deepEqual(tasks.calls, [], "Task Scheduler was never asked");
  assert.deepEqual(links, [], "and no Startup shortcut stands in for it");
  assert.equal(await stat(join(root, "gateway-task.xml")).catch(() => null), null, "no XML was written");
  const xml = gatewayTaskXml({ executable: app, atSignIn: true, user: "PC\\pat" });
  assert.equal((xml.match(/<UserId>PC\\pat<\/UserId>/g) ?? []).length, 2, "both the sign-in trigger and the principal name this account");
  assert.ok(!/GroupId|S-1-5-32-545/.test(xml));
});

test("the portable swap switches the gateway's task off before anything is ended, and on again before any version starts", () => {
  const plan = { install: "C:\\B", staged: "C:\\s", previous: "C:\\B.previous", exe: "C:\\B\\b.exe", log: "C:\\l", sys: "", archive: "a",
    unpacked: "u", mirror: () => "mirror", sleep: (n) => `sleep ${n}`, running: "running", recover: "r", runOnceKey: "k", image: "b.exe",
    started: "C:\\scratch\\started" };
  const lines = windowsSwap(plan);
  const starts = lines.filter((line) => line.includes('start "" "C:\\B\\b.exe"'));
  assert.equal(starts.length, 5);
  assert.ok(starts.every((line) => line.includes('call :taskon & start "" "C:\\B\\b.exe"')), "every start switches the task on first");
  const kill = lines.findIndex((line) => line.includes('taskkill.exe /IM "b.exe"'));
  assert.equal(lines[kill - 1], "call :taskoff", "a version ended because it did not come up is not started again by the task");
  assert.match(lines.find((line) => line.includes('"%~2"=="stay"')), /call :taskon & exit \/b 0/);
  const off = lines.indexOf(":taskoff"), on = lines.indexOf(":taskon");
  assert.match(lines[off + 1], /^schtasks\.exe \/Change \/TN "Branch Agent daemon" \/DISABLE <NUL >NUL 2>&1$/);
  assert.equal(lines[off + 2], 'if not errorlevel 1 set "TASKOFF=1"', "only a task that was there and was switched off");
  assert.match(lines[on + 1], /^if defined TASKOFF schtasks\.exe \/Change \/TN "Branch Agent daemon" \/ENABLE <NUL >NUL 2>&1$/);
});

test("uninstalling removes the gateway's Startup shortcut and the note of how its task was registered", () => {
  const script = uninstallScript({ installRoot: "C:\\App", executableName: "Branch Agent.exe", uninstallHive: "HKCU\\X",
    userDataDir: "C:\\Data 100%", shortcuts: [] });
  assert.ok(script.includes('del /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Branch Agent gateway.lnk" 2>NUL'),
    "%APPDATA% is left for the script to expand");
  assert.ok(script.includes(`del /q "${join("C:\\Data 100%%", "state", "gateway-task.json")}" 2>NUL`), "the data folder's own % is doubled");
  assert.match(script, /schtasks\.exe \/Delete \/F \/TN "Branch Agent daemon"/);
});

test("after an update, a gateway looked after only by its Startup shortcut is started directly", async (t) => {
  const root = await scratch(t), env = { APPDATA: join(root, "roaming"), ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", KEEP: "1" };
  const noTask = async (file, args) => { assert.match(file, /schtasks\.exe$/i); assert.deepEqual(args, ["/Run", "/TN", gatewayTaskName]); throw new Error("no such task"); };
  const started = [];
  const start = (file, args, childEnv) => started.push({ file, args, childEnv });
  await assert.rejects(startGatewayAgain(app, { run: noTask, env, start }), /no such task/, "neither a task nor a shortcut: the task's own failure");
  const shortcut = startupShortcutPath(env);
  await mkdir(join(shortcut, ".."), { recursive: true }); await writeFile(shortcut, "lnk");
  await restartService("win32", noTask, { executable: app, env, start });
  assert.equal(started.length, 1);
  assert.equal(started[0].file, app);
  assert.deepEqual(started[0].args, ["--branch-gateway"]);
  assert.equal(started[0].childEnv.ELECTRON_RUN_AS_NODE, undefined, "the app itself, not its runtime run as Node");
  assert.equal(started[0].childEnv.NODE_OPTIONS, undefined);
  assert.equal(started[0].childEnv.KEEP, "1");
  await assert.rejects(startGatewayAgain("C:\\node\\node.exe", { run: noTask, env, start }), /no such task/, "never a plain Node");
  const withTask = [];
  assert.equal(await startGatewayAgain(app, { run: async (_file, args) => { withTask.push(args); return ""; }, env, start }), "task");
  assert.deepEqual(withTask, [["/Run", "/TN", gatewayTaskName]]);
  assert.equal(started.length, 1, "with the task there, Task Scheduler starts it");
});
