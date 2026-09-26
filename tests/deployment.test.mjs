import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { performInstall, bootstrapperScript, uninstallEntries, uninstallScript, uninstallKey, defaultInstallRoot, shippedIconPath, shortcutIcon } from "../dist/install/installer.js";
import { shortcutScript, regAddArgs, regDeleteValueArgs } from "../dist/install/windows.js";
import { portableLocation, installedLocation, resolveDataLocation, migrateLegacyData, legacyDataDirs } from "../dist/install/layout.js";
import { autostartCommand, setAutostart, startsMinimized, minimizedFlag } from "../dist/install/autostart.js";
import { daemonCommand, daemonCommandLine, daemonInstallArgs, daemonUninstallArgs, daemonTaskName } from "../dist/install/daemon.js";
import { attachToRunning, writeRunning, readRunning } from "../dist/install/running.js";
import { encodeQr, capacity, generator, remainder, maximumQrBytes } from "../dist/remote/qr.js";
import { readStatus, isTailnetAddress } from "../dist/remote/tailscale.js";
import { Pairing, maximumAttempts } from "../dist/remote/pairing.js";
import { RemoteAccess, assertPrivateAddress } from "../dist/remote/remote-access.js";
import { hostAllowed, pairingRequest, startServer } from "../dist/server.js";
import { Readable } from "node:stream";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { doctorFix, doctorText } from "../dist/doctor-fix.js";
import { backupsToPrune, formatCopiesToPrune, writeUpdateBackup, listUpdateBackups, readUpdateBackup, recordFirstStart, readFirstStart, backupFileName } from "../dist/install/update-backup.js";
import { Updater } from "../dist/desktop/updater.js";
import { healthReport, startedCleanly } from "../dist/health.js";

const run = promisify(execFile);
const windows = process.platform === "win32";

async function scratch(t, prefix = "branch-deploy-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => discardTemp(root));
  return root;
}
/** A running app whose database is closed before the folder is removed, or Windows holds the file. */
async function branchIn(t, root) {
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  return app;
}

// ---------------------------------------------------------------- P1: installing

test("a dry-run install lays out the folders, writes shortcuts and registers Uninstall", { skip: !windows && "Windows tools" }, async (t) => {
  const root = await scratch(t);
  const source = join(root, "unpacked"), installRoot = join(root, "Programs", "Branch Agent");
  await mkdir(join(source, "resources", "app"), { recursive: true });
  await writeFile(join(source, "Branch Agent.exe"), "new program");
  await writeFile(join(source, "resources", "app", "package.json"), JSON.stringify({ version: "9.9.9" }));
  // A previous install is already there, and older saved work sits in an old-style folder.
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, "Branch Agent.exe"), "old program");
  const legacy = join(root, "legacy", "state");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "branch.sqlite"), "pretend database");

  // A registry key of our own under HKCU, removed again below: nothing real is touched.
  const hive = `HKCU\\Software\\BranchAgentTest\\${randomUUID()}`;
  t.after(() => run("reg.exe", ["delete", `HKCU\\Software\\BranchAgentTest`, "/f"]).catch(() => undefined));

  const report = await performInstall({
    source, installRoot, executableName: "Branch Agent.exe", version: "9.9.9",
    startMenuDir: join(root, "StartMenu"), desktopDir: join(root, "Desktop"),
    uninstallHive: hive, userDataDir: join(root, "AppData", "Branch Agent"),
    legacyDataDirs: [legacy],
  });

  assert.equal(await readFile(join(installRoot, "Branch Agent.exe"), "utf8"), "new program");
  assert.equal(report.previousKept, `${installRoot}.previous`);
  assert.equal(await readFile(join(`${installRoot}.previous`, "Branch Agent.exe"), "utf8"), "old program",
    "the version that was there is kept so an update can be undone");
  // Real .lnk files, written by Windows itself, inside this temporary folder only.
  assert.deepEqual(report.shortcuts, [join(root, "StartMenu", "Branch Agent.lnk"), join(root, "Desktop", "Branch Agent.lnk")]);
  for (const shortcut of report.shortcuts) assert.ok((await stat(shortcut)).size > 0, `${shortcut} exists`);
  // Add or remove programs shows the app and can remove it again.
  const listed = await run("reg.exe", ["query", uninstallKey(hive)]);
  assert.match(listed.stdout, /DisplayName\s+REG_SZ\s+Branch Agent/);
  assert.match(listed.stdout, /QuietUninstallString/);
  const removal = await readFile(report.uninstaller, "utf8");
  assert.ok(removal.includes(report.shortcuts[0]), "removing the app takes its shortcuts with it");
  // Older saved work came along, and the data folder is the installed one, not next to the program.
  assert.equal(report.data.reason, "copied");
  assert.equal(report.data.from, legacy);
  assert.equal(await readFile(join(root, "AppData", "Branch Agent", "state", "branch.sqlite"), "utf8"), "pretend database");
});

test("the installer script and the Uninstall entry say what they will do", () => {
  const script = bootstrapperScript({ assetName: "Branch-Agent-windows-x64.zip", executableName: "Branch Agent.exe" });
  assert.match(script, /Branch-Agent-windows-x64\.zip\.sha256/, "requires the published checksum beside the archive");
  assert.match(script, /copy \/b "%ZIP%" "%ARCHIVE%"/, "checks and extracts a private staged copy");
  assert.match(script, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/, "uses the system PowerShell, never PATH");
  assert.match(script, /Get-FileHash/, "verifies the staged archive before extraction");
  assert.match(script, /\$actual -ne \$match\.Groups\[1\]\.Value/, "PowerShell accepts the lowercase digest published by Branch");
  assert.match(script, /OpenRead/, "preflights every archive entry before extraction");
  assert.match(script, /ExternalAttributes/, "refuses archive links instead of following them");
  assert.match(script, /Expand-Archive/, "extracts only after verification and preflight");
  assert.doesNotMatch(script, /tar\.exe|(?<!WindowsPowerShell\\v1\.0\\)powershell\.exe/i,
    "a planted tar or PowerShell on PATH cannot replace a system tool");
  assert.match(script, /ELECTRON_RUN_AS_NODE/, "runs the installer with the runtime inside the download");
  assert.match(script, /dist\\install\\install-cli\.js/);
  assert.ok(!/Invoke-WebRequest|curl|http/i.test(script), "the installer downloads nothing of its own");

  const entries = uninstallEntries({ installRoot: "C:\\App", executableName: "Branch Agent.exe", version: "1.2.3", uninstaller: "C:\\App\\Uninstall Branch Agent.cmd" });
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
  assert.equal(byName.DisplayVersion, "1.2.3");
  assert.equal(byName.QuietUninstallString, '"C:\\App\\Uninstall Branch Agent.cmd" /quiet');
  const script2 = uninstallScript({ installRoot: "C:\\App", executableName: "Branch Agent.exe", uninstallHive: "HKCU\\X", userDataDir: "C:\\Data", shortcuts: ["C:\\M\\Branch Agent.lnk"] });
  // The path is quoted: printed bare, an `&` in it ran the rest of the path as a command (tests/uninstall-last-step.test.mjs).
  assert.match(script2, /Your conversations and files stay in "C:\\Data"/, "saved work is kept on purpose");
  assert.match(script2, /schtasks\.exe \/Delete/, "the background task goes too");
  assert.match(script2, /reg\.exe delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
  // bucket 22: the data folder goes only when --delete-data was given.
  const dataRemovals = script2.split("\r\n").filter((line) => line.includes('rmdir /s /q "C:\\Data"'));
  assert.deepEqual(dataRemovals, ['if defined DELETE_DATA rmdir /s /q "C:\\Data" 2>NUL'], "it deletes the data folder only when asked");
  assert.match(script2, /for %%A in \(%\*\) do if \/i "%%~A"=="--delete-data" set "DELETE_DATA=1"/);
  assert.ok(script.split("\r\n").every((line) => !/(^|&\s*)pause\b/.test(line)), "the installer's waits go through %PAUSE%, which /quiet switches off");
  assert.match(script, /if \/i "%%~A"=="\/quiet" set "PAUSE=type NUL"/);
  assert.match(shortcutScript({ path: "C:\\M\\a.lnk", target: "C:\\App\\x.exe" }), /CreateObject\("WScript\.Shell"\)/);

  // mac7/app-icon: the packager copies the stock Electron executable back over the packaged one, so it
  // still carries Electron's logo. Every shortcut and every list entry has to name the mascot .ico.
  assert.equal(shippedIconPath, join("resources", "app", "public", "assets", "branch.ico"));
  assert.equal(shortcutIcon("C:\\App", "Branch Agent.exe", true), `${join("C:\\App", shippedIconPath)},0`);
  assert.equal(shortcutIcon("C:\\App", "Branch Agent.exe", false), `${join("C:\\App", "Branch Agent.exe")},0`,
    "an older copy without the icon still gets a working shortcut");
  assert.match(shortcutScript({ path: "a", target: "t", iconLocation: "C:\\App\\k.ico,0" }), /link\.IconLocation = "C:\\App\\k\.ico,0"/);
  assert.equal(byName.DisplayIcon, join("C:\\App", "Branch Agent.exe"), "no icon given, the executable as before");
  const withIcon = uninstallEntries({ installRoot: "C:\\App", executableName: "Branch Agent.exe", version: "1.2.3", uninstaller: "u", icon: "C:\\App\\k.ico" });
  assert.equal(Object.fromEntries(withIcon.map((entry) => [entry.name, entry.value])).DisplayIcon, "C:\\App\\k.ico");
  assert.ok(defaultInstallRoot({ LOCALAPPDATA: "C:\\L" }).endsWith(join("Programs", "Branch Agent")));
});

test("the Windows bootstrapper refuses missing, changed and traversal downloads before extraction", { skip: !windows && "Windows only" }, async (t) => {
  const root = await scratch(t, "branch-bootstrap-");
  const temp = join(root, "temp");
  await mkdir(temp);
  const assetName = "Branch-Agent-windows-x64.zip";
  const archive = join(root, assetName);
  const checksum = `${archive}.sha256`;
  const script = join(root, "Install Branch Agent.cmd");
  await writeFile(script, bootstrapperScript({ assetName, executableName: "Branch Agent.exe" }));
  const invoke = async (message) => assert.rejects(
    run(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/c", script, "/quiet"], {
      env: { ...process.env, TEMP: temp }, windowsHide: true,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, message);
      return true;
    },
  );

  await writeFile(archive, "changed download");
  await invoke(/Put this file.*\.sha256/);
  await writeFile(checksum, "not a checksum\n");
  await invoke(/checksum file is not valid|download was not opened/i);
  await writeFile(checksum, `${"0".repeat(64)}  ${assetName}\n`);
  await invoke(/did not match the published checksum|download was not opened/i);

  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await rm(archive, { force: true });
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open($env:ARCHIVE_TO_BUILD,[IO.Compression.ZipArchiveMode]::Create); $e=$z.CreateEntry('../outside.txt'); $w=[IO.StreamWriter]::new($e.Open()); $w.Write('bad'); $w.Dispose(); $z.Dispose()"],
  { env: { ...process.env, ARCHIVE_TO_BUILD: archive }, windowsHide: true });
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(checksum, `${digest}  ${assetName}\n`);
  await invoke(/unsafe path|download was not opened/i);
  await assert.rejects(stat(join(temp, "outside.txt")), /ENOENT/, "the traversal entry was never extracted");

  await rm(archive, { force: true });
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open($env:ARCHIVE_TO_BUILD,[IO.Compression.ZipArchiveMode]::Create); $e=$z.CreateEntry('link'); $e.ExternalAttributes=-1577123840; $w=[IO.StreamWriter]::new($e.Open()); $w.Write('outside.txt'); $w.Dispose(); $z.Dispose()"],
  { env: { ...process.env, ARCHIVE_TO_BUILD: archive }, windowsHide: true });
  const linkDigest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(checksum, `${linkDigest}  ${assetName}\n`);
  await invoke(/unsafe link|download was not opened/i);
});

test("portable mode keeps everything beside the program; otherwise it lives with the person's other apps", async (t) => {
  const root = await scratch(t);
  const exeDir = join(root, "stick", "Branch Agent"), userData = join(root, "AppData", "Branch Agent");
  await mkdir(exeDir, { recursive: true });
  assert.deepEqual(await resolveDataLocation(exeDir, userData), installedLocation(userData));
  await writeFile(join(exeDir, "portable.txt"), "keep my data next to me");
  const portable = await resolveDataLocation(exeDir, userData);
  assert.deepEqual(portable, portableLocation(exeDir));
  assert.equal(portable.portable, true);
  assert.ok(portable.dataDir.startsWith(exeDir), "the data folder sits beside the program");

  // Moving older data never overwrites work that is already there.
  const from = join(root, "old"), to = join(root, "new");
  await mkdir(from, { recursive: true });
  await mkdir(to, { recursive: true });
  await writeFile(join(from, "branch.sqlite"), "old work");
  await writeFile(join(to, "branch.sqlite"), "work already here");
  assert.equal((await migrateLegacyData([from], to)).reason, "already-set-up");
  assert.equal(await readFile(join(to, "branch.sqlite"), "utf8"), "work already here");
  assert.ok(legacyDataDirs({ LOCALAPPDATA: "C:\\L", APPDATA: "C:\\R" }).length >= 4);
});

// ---------------------------------------------------------------- P2: starting with Windows, background engine

test("starting with Windows writes one line into the person's own sign-in list", async () => {
  const calls = [];
  const fake = async (file, args) => { calls.push({ file, args }); return ""; };
  const on = await setAutostart(true, { executable: "C:\\App\\Branch Agent.exe", minimized: true }, { run: fake, systemRoot: "C:\\Windows" });
  assert.equal(on.enabled, true);
  assert.equal(on.command, '"C:\\App\\Branch Agent.exe" --start-minimized');
  assert.equal(calls[0].file, "C:\\Windows\\System32\\reg.exe");
  assert.deepEqual(calls[0].args, regAddArgs("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", {
    name: "Branch Agent", type: "REG_SZ", value: on.command,
  }));
  assert.ok(calls[0].args[1].startsWith("HKCU\\"), "only this person's own settings are touched");

  const off = await setAutostart(false, { executable: "C:\\App\\Branch Agent.exe", minimized: true }, { run: fake, systemRoot: "C:\\Windows" });
  assert.equal(off.enabled, false);
  assert.deepEqual(calls[1].args, regDeleteValueArgs("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "Branch Agent"));
  assert.equal(autostartCommand("C:\\x.exe", false), '"C:\\x.exe"');
  assert.equal(startsMinimized(["node", "app", minimizedFlag]), true);
  assert.equal(startsMinimized(["node", "app"]), false);
});

test("the background engine is a sign-in task that opens no window, and is never registered here", async (t) => {
  const root = await scratch(t);
  const calls = [];
  const fake = async (file, args) => { calls.push({ file, args }); return ""; };
  const written = [];
  const options = {
    executable: "C:\\App\\Branch Agent.exe", script: "C:\\App\\resources\\app\\dist\\cli.js",
    dataDir: "C:\\Data", workspace: "C:\\Work", port: 3210,
    launcherPath: join(root, "branch-daemon.vbs"), systemRoot: "C:\\Windows", platform: "win32",
  };
  const report = await daemonCommand("install", options, {
    run: fake, write: async (path, content) => { written.push({ path, content }); },
  });
  assert.equal(report.installed, true);
  assert.equal(calls[0].file, "C:\\Windows\\System32\\schtasks.exe");
  const args = daemonInstallArgs(options);
  assert.deepEqual(calls[0].args, args);
  assert.equal(args[args.indexOf("/SC") + 1], "ONLOGON", "it starts when the person signs in");
  assert.equal(args[args.indexOf("/RL") + 1], "LIMITED", "no administrator rights are asked for");
  assert.equal(args[args.indexOf("/TN") + 1], daemonTaskName);
  // The task runs the script host, which is what keeps a console window from flashing up.
  assert.equal(args[args.indexOf("/TR") + 1], `"C:\\Windows\\System32\\wscript.exe" //B //Nologo "${options.launcherPath}"`);
  assert.equal(written.length, 1);
  assert.match(written[0].content, /CreateObject\("WScript\.Shell"\)\.Run .*, 0, False/, "window style 0 is hidden");
  const command = daemonCommandLine(options);
  assert.match(command, /BRANCH_DATA_DIR=C:\\Data/);
  assert.match(command, /BRANCH_PORT=3210/);
  assert.match(command, /"C:\\App\\Branch Agent\.exe" "C:\\App\\resources\\app\\dist\\cli\.js" start$/);
  assert.ok(written[0].content.includes(command.replace(/"/g, '""')));

  const removed = await daemonCommand("uninstall", options, { run: fake, write: async () => {} });
  assert.equal(removed.installed, false);
  assert.deepEqual(calls[1].args, daemonUninstallArgs(daemonTaskName));
  const missing = await daemonCommand("status", options, { run: async () => { throw new Error("no such task"); }, write: async () => {} });
  assert.equal(missing.installed, false);
  assert.match(missing.message, /does not start by itself/);
});

test("a second launch joins the engine that is already running, and ignores a note left by a crash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-deploy-"));
  const app = await branchIn(t, root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });

  const note = await readRunning(join(root, "data"));
  assert.equal(note.pid, process.pid);
  assert.equal(note.url, server.url);
  const joined = await attachToRunning(join(root, "data"));
  assert.ok(joined, "the running engine is found");
  assert.equal(joined.url, server.url);
  assert.equal(joined.token, server.token);

  // A note left behind by a crash names a process that is gone; it is cleared, not trusted.
  await writeRunning(join(root, "data"), { port: note.port, pid: 999999, url: note.url, mode: "daemon", version: note.version });
  assert.equal(await attachToRunning(join(root, "data"), { alive: () => false }), null);
  assert.equal(await readRunning(join(root, "data")), null, "the stale note is removed");
});

// ---------------------------------------------------------------- P3: reaching Branch from a phone

test("the square code is a real barcode: correct size, corner markers, and error correction that checks out", () => {
  const link = "http://desk-pc.tail9f3c.ts.net:3210/pair?id=7f4a1c2e-9b10-4d55-8f21-0c3e9a7b6d41";
  const matrix = encodeQr(link);
  assert.equal(matrix.size, 21 + 4 * (matrix.version - 1), "the width follows the version");
  assert.ok(matrix.version >= 4 && matrix.version <= 6, `a link of ${link.length} characters fits a middling version`);
  // The three corner markers a camera looks for: a 7x7 ring with a 3x3 centre.
  const corners = [[0, 0], [0, matrix.size - 7], [matrix.size - 7, 0]];
  for (const [top, left] of corners)
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const ring = x === 0 || x === 6 || y === 0 || y === 6;
        const centre = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        assert.equal(matrix.modules[top + y][left + x], ring || centre, `corner marker at ${top},${left} module ${x},${y}`);
      }
  // The dotted lines that tell a camera how big one square is.
  for (let i = 8; i < matrix.size - 8; i++) {
    assert.equal(matrix.modules[6][i], i % 2 === 0);
    assert.equal(matrix.modules[i][6], i % 2 === 0);
  }
  assert.equal(matrix.modules[matrix.size - 8][8], true, "the always-dark module is where the standard puts it");
  assert.equal(capacity(1), 17);
  assert.equal(capacity(10), maximumQrBytes);
  assert.throws(() => encodeQr("x".repeat(maximumQrBytes + 1)), /too long/);
});

test("the error-correction codewords are a true remainder: every check value comes out zero", () => {
  // A Reed-Solomon codeword must vanish at the first `degree` powers of the field's generator.
  const exp = new Uint8Array(512), log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const mul = (a, b) => (a && b ? exp[log[a] + log[b]] : 0);
  const degree = 20;
  const message = Array.from({ length: 60 }, (_value, index) => (index * 37 + 11) & 0xff);
  const codeword = [...message, ...remainder(message, degree)];
  for (let power = 0; power < degree; power++) {
    let total = 0;
    for (const byte of codeword) total = mul(total, exp[power]) ^ byte;
    assert.equal(total, 0, `the codeword vanishes at generator power ${power}`);
  }
  assert.equal(generator(7).length, 7);
});

test("reaching Branch from a phone needs Tailscale, binds only to the private address, and never to everything", async () => {
  assert.equal(isTailnetAddress("100.101.102.103"), true);
  assert.equal(isTailnetAddress("192.168.1.5"), false);
  assert.equal(isTailnetAddress("0.0.0.0"), false);
  assert.throws(() => assertPrivateAddress("0.0.0.0"), /private Tailscale address/);
  assert.throws(() => assertPrivateAddress("192.168.0.10"), /private Tailscale address/);

  const running = readStatus(JSON.stringify({
    BackendState: "Running",
    Self: { HostName: "desk-pc", DNSName: "desk-pc.tail9f3c.ts.net.", TailscaleIPs: ["100.88.4.9", "fd7a::1"] },
  }));
  assert.deepEqual([running.present, running.running, running.address, running.hostname], [true, true, "100.88.4.9", "desk-pc.tail9f3c.ts.net"]);
  const sleeping = readStatus(JSON.stringify({ BackendState: "Stopped", Self: { HostName: "desk-pc" } }));
  assert.equal(sleeping.address, null);
  assert.match(sleeping.message, /not signed in/);

  // Without Tailscale the switch refuses rather than falling back to any other address.
  const absent = new RemoteAccess("a".repeat(64), async () => ({ present: false, running: false, address: null, hostname: null, message: "Tailscale is not installed on this computer." }));
  await assert.rejects(absent.enable(() => {}), /not installed/);
  assert.equal(absent.status().enabled, false);
  assert.deepEqual(absent.allowedHosts(), []);
});

test("the Host and Origin checks accept the phone's address only while remote access is on", () => {
  const url = "http://127.0.0.1:3210";
  assert.equal(hostAllowed("127.0.0.1:3210", undefined, url), true);
  assert.equal(hostAllowed("desk-pc.tail9f3c.ts.net:3210", undefined, url), false, "off by default");
  assert.equal(hostAllowed("desk-pc.tail9f3c.ts.net:3210", undefined, url, ["desk-pc.tail9f3c.ts.net:3210"]), true);
  assert.equal(hostAllowed("127.0.0.1:3210", "https://evil.example", url), false, "a page elsewhere is refused");
  assert.equal(hostAllowed(undefined, undefined, url), false);
  assert.equal(hostAllowed("127.0.0.1:9999", undefined, url), false, "another port is a different app");
});

test("an invitation lets one phone in once, expires, and dies after a few wrong numbers", () => {
  let now = 1_700_000_000_000;
  const pairing = new Pairing("t".repeat(64), () => now);
  assert.equal(pairing.view(), null);
  const offer = pairing.create();
  assert.match(offer.code, /^\d{6}$/);
  assert.equal(pairing.view().id, offer.id);
  assert.throws(() => pairing.redeem(offer.id, "000000" === offer.code ? "111111" : "000000"), /not right/);
  assert.throws(() => pairing.redeem("not-the-offer", offer.code), /not the one/);
  assert.deepEqual(pairing.redeem(offer.id, offer.code), { token: "t".repeat(64) });
  assert.throws(() => pairing.redeem(offer.id, offer.code), /expired/, "an invitation is good once only");

  const second = pairing.create();
  for (let attempt = 0; attempt < maximumAttempts; attempt++)
    assert.throws(() => pairing.redeem(second.id, second.code === "000000" ? "111111" : "000000"));
  assert.throws(() => pairing.redeem(second.id, second.code), /expired|Too many/, "the invitation is burnt after too many guesses");

  const third = pairing.create();
  now += 6 * 60_000;
  assert.equal(pairing.view(), null);
  assert.throws(() => pairing.redeem(third.id, third.code), /expired/);
});

test("the pairing page answers at phone width and asks for the number, not for the key", async () => {
  const html = await readFile(new URL("../public/pair.html", import.meta.url), "utf8");
  assert.match(html, /width=device-width/, "it lays out for a phone screen");
  assert.match(html, /inputmode="numeric"/, "a phone shows the number pad");
  assert.ok(!/[a-f0-9]{64}/.test(html), "the page never carries the key itself");
  // The page's own rules must live in a file: the served pages allow no inline styles.
  assert.ok(!/<style/.test(html), "no inline stylesheet, which the content policy would block");
  const css = await readFile(new URL("../public/pair.css", import.meta.url), "utf8");
  assert.match(css, /max-width: 360px/, "the column fits inside 400 pixels");
  assert.match(css, /box-sizing: border-box/, "padding does not push the column past the screen");
  const script = await readFile(new URL("../public/pair.js", import.meta.url), "utf8");
  assert.match(script, /fetch\("\/api\/pair"/);
  assert.match(script, /sessionStorage\.setItem\("branch-token"/, "the key arrives only after the number is accepted");
});

test("the pairing door answers only a POST to /api/pair, and hands over the key only for the right number", async () => {
  const remote = new RemoteAccess("k".repeat(64), async () => ({ present: false, running: false, address: null, hostname: null, message: "no" }));
  const offer = remote.pairing.create();
  const request = (method, path, body) => Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    { method, url: path, headers: { "content-type": "application/json" } });
  const reply = () => {
    const sent = { status: 0, body: null };
    return { sent, writeHead(status) { sent.status = status; }, end(text) { sent.body = text && JSON.parse(text); } };
  };
  assert.equal(await pairingRequest(remote, request("GET", "/api/pair", {}), reply(), "/api/pair"), false,
    "only a POST is a pairing attempt");
  assert.equal(await pairingRequest(remote, request("POST", "/api/state", {}), reply(), "/api/state"), false,
    "no other route is opened up");
  const wrong = reply();
  await assert.rejects(pairingRequest(remote, request("POST", "/api/pair", { id: offer.id, code: "123456" === offer.code ? "654321" : "123456" }), wrong, "/api/pair"), /not right/);
  assert.equal(wrong.sent.status, 0, "nothing is sent back on a wrong number");
  const right = reply();
  assert.equal(await pairingRequest(remote, request("POST", "/api/pair", { id: offer.id, code: offer.code }), right, "/api/pair"), true);
  assert.deepEqual(right.sent.body, { token: "k".repeat(64) });
});

test("the pairing door is shut on this computer's own address", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-deploy-"));
  const app = await branchIn(t, root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const response = await fetch(`${server.url}/api/pair`, {
    method: "POST", headers: { "content-type": "application/json", origin: server.url },
    body: JSON.stringify({ id: "anything", code: "000000" }),
  });
  assert.equal(response.status, 401, "without the session key the ordinary door still refuses");
  const settings = await fetch(`${server.url}/api/deployment`, { headers: { origin: server.url } });
  assert.equal(settings.status, 401);
  const allowed = await fetch(`${server.url}/api/deployment`, {
    headers: { origin: server.url, authorization: `Bearer ${server.token}` },
  });
  assert.equal(allowed.status, 200);
  // The settings card's own check must not call the address Branch is listening on a problem.
  const checked = await fetch(`${server.url}/api/deployment/doctor`, {
    headers: { origin: server.url, authorization: `Bearer ${server.token}` },
  });
  assert.equal(checked.status, 200);
  const address = (await checked.json()).checks.find((check) => check.name === "Address on this computer");
  assert.equal(address.ok, true, "the address Branch is already using is not reported as blocked");
  assert.match(address.summary, /which is what we want/);
  const body = await allowed.json();
  assert.equal(body.installed, false, "running from source, so the switches say so");
  assert.equal(body.remote.enabled, false);
  assert.match(body.remote.message, /off/i);
  assert.equal(body.platform, process.platform, "the window learns which system Branch runs on");
});

test("the sign-in switches name the system Branch runs on: Windows, your Mac, or this computer", async () => {
  /* Redesign: the old card (public/deployment.js) is replaced by the new window's Settings › General (public/app/settings/
     pages/general.js), whose switch is the prototype's "Start with Windows". On a Mac or another computer that switch
     names that system instead (public/app/settings/signin.js, from GET /api/deployment platform), and "Branch starts
     with Windows" is said only on Windows. */
  const { signInSystem, startKey, startsWithWindows } = await import("../public/app/settings/signin.js");
  assert.equal(signInSystem("win32"), "windows");
  assert.equal(signInSystem("darwin"), "mac");
  assert.equal(signInSystem("linux"), "computer");
  assert.equal(signInSystem(undefined), "computer", "not known yet: no system is guessed");
  assert.deepEqual(["win32", "darwin", "linux", undefined].map(startsWithWindows), [true, false, false, false]);
  const page = await readFile(new URL("../public/app/settings/pages/general.js", import.meta.url), "utf8");
  assert.match(page, /ctl\("g-start", t\(startKey\(platform\)\)/, "the switch's words follow the system");
  assert.match(page, /starts && startsWithWindows\(platform\) \?/, "\"Branch starts with Windows\" only on Windows");
  assert.doesNotMatch(page, /t\("window\.settings\.general\.start-with-windows"\)/, "no switch names Windows on every system");
  const expected = { win32: /Windows$/, darwin: /(my Mac|mon Mac)$/, linux: /(this computer|cet ordinateur)$/ };
  for (const language of ["en", "fr", "es", "de"]) {
    const words = JSON.parse(await readFile(new URL(`../public/locales/${language}.json`, import.meta.url), "utf8"));
    for (const platform of Object.keys(expected)) {
      const said = words[startKey(platform)];
      assert.equal(typeof said, "string", `${language} has words for ${platform}`);
      if (language === "en" || language === "fr") assert.match(said, expected[platform], `${language} on ${platform}: ${said}`);
    }
    assert.doesNotMatch(words[startKey("linux")], /Windows|Mac/, `${language}: the default names no system`);
  }
});

// ---------------------------------------------------------------- P4: a safety copy before every update

test("an update takes a safety copy first, keeps three, and stops when the copy cannot be made", async (t) => {
  const root = await scratch(t);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const archive = { format: "branch-agent-backup", version: 1, exportedAt: new Date().toISOString(), appVersion: "0.1.0", tables: {} };
  for (const [index, version] of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"].entries())
    await writeUpdateBackup(dataDir, { ...archive, appVersion: version }, version, new Date(Date.UTC(2026, 0, index + 1)));
  const points = await listUpdateBackups(dataDir);
  assert.deepEqual(points.map((point) => point.version), ["0.4.0", "0.3.0", "0.2.0"], "three are kept, newest first");
  assert.equal((await readdir(join(dataDir, "update-backups"))).length, 3);
  assert.equal((await readUpdateBackup(dataDir, points[0].name)).appVersion, "0.4.0");
  await assert.rejects(readUpdateBackup(dataDir, "../secrets.json"), /not a safety copy/);
  assert.deepEqual(backupsToPrune([
    backupFileName("1", new Date(Date.UTC(2026, 0, 1))), backupFileName("2", new Date(Date.UTC(2026, 0, 2))),
    backupFileName("3", new Date(Date.UTC(2026, 0, 3))), backupFileName("4", new Date(Date.UTC(2026, 0, 4))),
    "someone-elses-file.json",
  ]), [backupFileName("1", new Date(Date.UTC(2026, 0, 1)))]);

  // The updater asks for the copy before it writes the hand-over script, and gives up when it fails.
  const taken = [];
  const install = join(root, "installed");
  await mkdir(install, { recursive: true });
  const updater = (backup) => new Updater({
    repo: "x/y", currentVersion: "1.0.0", installDir: install, executableName: "Branch Agent.exe",
    assetName: "app.zip", scratchDir: join(root, `scratch-${taken.length}-${randomUUID()}`),
    fetch: fakeRelease(), extract: async (_archive, into) => {
      await mkdir(join(into, "app", "resources", "app"), { recursive: true });
      await writeFile(join(into, "app", "Branch Agent.exe"), "new");
      await writeFile(join(into, "app", "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
    },
    backup, platform: "win32",
  });
  const good = await updater(async () => { taken.push("copy"); }).install();
  assert.deepEqual(taken, ["copy"], "the copy is taken before the hand-over script is written");
  assert.ok((await readFile(good.script, "utf8")).includes(".previous"), "the hand-over still keeps the previous version");
  await assert.rejects(
    updater(async () => { throw new Error("the disk is full"); }).install(),
    /safety copy could not be made.*the disk is full/s,
    "an update without something to go back to is refused");
});

test("a version that did not come up cleanly is remembered, so the update screen can offer a way back", async (t) => {
  const root = await scratch(t);
  assert.equal(await readFirstStart(root), null);
  const first = await recordFirstStart(root, "0.9.0", true);
  assert.deepEqual([first.version, first.previousVersion, first.healthy], ["0.9.0", null, true]);
  assert.deepEqual(await recordFirstStart(root, "0.9.0", false), first, "a later start of the same version changes nothing");
  const second = await recordFirstStart(root, "1.0.0", false);
  assert.deepEqual([second.version, second.previousVersion, second.healthy], ["1.0.0", "0.9.0", false]);
});

// Dogfood F6: after every install, Settings > General said the new version "did not start cleanly" and offered to
// put back the saved work from before it. It had started; the owner only had questions waiting and schedules the
// update's own restart had cut off, and the whole doctor report was taken as the version's health.
test("F6 a new version with the owner's to-dos waiting still started cleanly, and no way back is offered", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-deploy-"));
  const dataDir = join(root, "data");
  const app = await branchIn(t, root);
  await mkdir(dataDir, { recursive: true });
  await recordFirstStart(dataDir, "0.0.1-before", true);
  const asked = app.store.createRun(app.runtime.owner, "change a setting");
  app.store.finish(asked.id, "needs_input", "May I change it?");
  app.store.save("schedules", app.runtime.owner, randomUUID(), { prompt: "Water the tomatoes", status: "interrupted" });
  const doctor = await healthReport(app);
  assert.equal(doctor.ok, false, "the doctor still lists the owner's to-dos");
  const server = await startServer(app, { dataDir, port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const check = await readFirstStart(dataDir);
  assert.deepEqual([check.version, check.previousVersion, check.healthy], [app.version, "0.0.1-before", true],
    "a question waiting and an interrupted schedule are not a broken start");
});

// NAS e2ff08b: no test ran a really broken start through the first-start record. A workspace Branch cannot write to
// fails the program's own check, so that start is recorded as unclean and the way back is offered.
test("F6 a start whose own checks fail is recorded as unclean", { skip: process.platform === "win32" ? "POSIX file modes" : false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-deploy-"));
  const dataDir = join(root, "data");
  const app = await branchIn(t, root);
  await mkdir(dataDir, { recursive: true });
  await recordFirstStart(dataDir, "0.0.1-before", true);
  const { chmod } = await import("node:fs/promises");
  await chmod(app.runtime.workspace, 0o500);
  const server = await startServer(app, { dataDir, port: 0, presence: "app" });
  t.after(async () => { await chmod(app.runtime.workspace, 0o700); await server.close(); await app.close(); await discardTemp(root); });
  const check = await readFirstStart(dataDir);
  assert.deepEqual([check.version, check.previousVersion, check.healthy], [app.version, "0.0.1-before", false], "a start that cannot write its workspace is not clean");
});

test("F6 a start is unclean only when the program's own checks fail", () => {
  const report = (failing) => ({ ok: false, checkedAt: new Date().toISOString(), items: ["Saved data", "Workspace folder", "Device key", "Models", "ChatGPT account", "Models on this computer", "Channels", "Schedules", "Tasks waiting for you"].map((name) => ({ name, ok: name !== failing, summary: "" })) });
  for (const name of ["Saved data", "Workspace folder", "Device key", "Models", "ChatGPT account"])
    assert.equal(startedCleanly(report(name)), false, `${name} failing is a broken start`);
  for (const name of ["Models on this computer", "Channels", "Schedules", "Tasks waiting for you"])
    assert.equal(startedCleanly(report(name)), true, `${name} failing is the owner's to-do, not a broken start`);
});

test("putting back a safety copy replaces what is there; an ordinary restore still refuses to", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-deploy-"));
  const app = await branchIn(t, root);
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  await app.runtime.run({ prompt: "say hello" }); // a real conversation, so this copy is not empty
  app.store.save("settings", owner, "before-update", { kept: true });
  const snapshot = app.store.backup(app.version);
  app.store.save("settings", owner, "after-update", { kept: false });
  assert.ok(app.store.get("settings", owner, "after-update"));
  assert.throws(() => app.store.restore(snapshot), /already has conversations|fresh install/,
    "a plain restore still refuses to write over work that is already here");
  const result = app.store.restore(snapshot, { replaceExisting: true });
  assert.ok(result.rows > 0);
  assert.ok(app.store.get("settings", owner, "before-update"), "the older saved work is back");
  assert.equal(app.store.get("settings", owner, "after-update"), undefined, "what came after is gone");
});

// ---------------------------------------------------------------- P6: setting-up help

test("doctor --fix reports each problem in plain words and repairs what it can", async () => {
  const report = await doctorFix(
    { fix: false, port: 3210, workspace: process.cwd(), browsersInstalled: async () => false, platform: "win32" },
    { run: async (file) => { if (file === "git") throw new Error("not found"); return ""; }, portFree: async (port) => port !== 3210 },
  );
  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
  assert.equal(byName.Git.ok, false);
  assert.match(byName.Git.fix, /git-scm\.com/);
  assert.equal(byName["Web browsing"].ok, false);
  assert.match(byName["Address on this computer"].summary, /already using address 3210/);
  assert.match(byName["Address on this computer"].fix, /BRANCH_PORT to 3211/, "it names free addresses to use instead");
  assert.equal(byName["Your files folder"].ok, true);
  assert.ok(!/\b(TTS|daemon|binary|stdout|localhost)\b/.test(doctorText(report)), "no jargon reaches the person");
  assert.match(doctorText(report), /branch doctor --fix/);

  const installed = [];
  const repaired = await doctorFix(
    { fix: true, port: 3210, workspace: process.cwd(), browsersInstalled: async () => false },
    { run: async (file, args) => { installed.push([file, ...args].join(" ")); return ""; }, portFree: async () => true },
  );
  assert.deepEqual(repaired.repaired, ["Web browsing"]);
  assert.ok(installed.includes("npx playwright install chromium --only-shell"));
  assert.equal(repaired.ok, true);
});

/** A stand-in for GitHub Releases: one small download whose published checksum matches. */
function fakeRelease() {
  const bytes = Buffer.from("pretend zip");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return async (url) => {
    if (String(url).includes("releases/latest"))
      return new Response(JSON.stringify({
        tag_name: "v2.0.0", name: "Branch Agent 2.0.0", body: "", published_at: null,
        html_url: "https://github.com/x/y/releases/tag/v2.0.0",
        assets: [
          { name: "app.zip", browser_download_url: "https://example.invalid/app.zip", size: bytes.length },
          { name: "app.zip.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).endsWith("app.zip")) return new Response(bytes, { status: 200 });
    return new Response(`${digest}  app.zip\n`, { status: 200 });
  };
}

test("merge-queue review: pruning format copies never removes the one just taken, even under a clock that jumped back", () => {
  const names = ["before-format-500.sqlite", "before-format-400.sqlite", "before-format-300.sqlite", "before-format-100.sqlite"];
  const pruned = formatCopiesToPrune(names, 3, "before-format-100.sqlite");
  assert.equal(pruned.includes("before-format-100.sqlite"), false, "the copy an undo points at stays");
  assert.deepEqual(pruned, ["before-format-300.sqlite"], "still only three are kept");
  assert.deepEqual(formatCopiesToPrune(names, 3), ["before-format-100.sqlite"], "without one to keep, the oldest goes");
});

// ---------------------------------------------------------------- mac7/smoke-fixes (B4)

/**
 * The smoke test found every terminal command except `schedule` exiting 1 with "Branch is already
 * open" while the window was up — `doctor`, `memory`, `trace`, and worst of all `token`, so a script
 * could not be given a short-lived key at the one moment it needs one. The single-writer rule is
 * not weakened: these go through the Branch that is running, by the same door the window uses.
 */
async function openBranch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-b4-"));
  const app = await branchIn(t, root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { root, app, server, dataDir: join(root, "data") };
}
/**
 * The real `branch <command>` in another process, with the same saved work the open Branch holds.
 * Its home is a folder of the test's own and it is given no display, so it reads nothing of the
 * person running the tests.
 */
async function branchCli(dataDir, root, args) {
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: join(root, "workspace") };
  for (const name of ["FORCE_TTY", "DISPLAY", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) delete env[name];
  return new Promise((resolve) => execFile(process.execPath, ["dist/cli.js", ...args], { env, timeout: 120_000 },
    (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
}

test("B4 while Branch is open, the commands that only look work from another terminal", async (t) => {
  const { root, app, dataDir } = await openBranch(t);
  app.store.save("memory", "local", randomUUID(), { text: "the office plant is called Fern", source: "the owner said so" });

  const doctor = await branchCli(dataDir, root, ["doctor"]);
  assert.equal(doctor.code, 0, doctor.stderr);
  const said = JSON.parse(doctor.stdout);
  assert.match(said.from, /^the Branch already open at http/);
  assert.ok(Array.isArray(said.health.items) && said.health.items.length, "the checks came back");

  const memory = await branchCli(dataDir, root, ["memory"]);
  assert.equal(memory.code, 0, memory.stderr);
  assert.match(memory.stdout, /the office plant is called Fern/);

  const usage = await branchCli(dataDir, root, ["usage", "--json"]);
  assert.equal(usage.code, 0, usage.stderr);
  assert.ok("currentMonthlyTokens" in JSON.parse(usage.stdout));
});

test("B4 a short-lived key can be made while Branch is open, and it really works", async (t) => {
  const { root, server, dataDir } = await openBranch(t);
  const made = await branchCli(dataDir, root, ["token", "create", "--scope", "read", "--minutes", "10"]);
  assert.equal(made.code, 0, made.stderr);
  const key = made.stdout.split("\n")[0].trim();
  assert.match(key, /^branch_[a-f0-9]{48}$/);
  assert.match(made.stdout, /This is the only time it is shown\. May look at things only\./);

  // The key the terminal printed is a key the running Branch accepts, and only for looking.
  const reading = await fetch(`${server.url}/api/health`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(reading.status, 200);
  const starting = await fetch(`${server.url}/api/run`, { method: "POST", headers: {
    authorization: `Bearer ${key}`, origin: server.url, "content-type": "application/json" }, body: JSON.stringify({ prompt: "go" }) });
  assert.equal(starting.ok, false, "a read key may not start a task");

  const listed = await branchCli(dataDir, root, ["token", "list", "--json"]);
  assert.equal(JSON.parse(listed.stdout).tokens.length, 1);
  const gone = await branchCli(dataDir, root, ["token", "revoke", JSON.parse(listed.stdout).tokens[0].id]);
  assert.match(gone.stdout, /That key stops working now\./);
  assert.equal((await fetch(`${server.url}/api/health`, { headers: { authorization: `Bearer ${key}` } })).status, 401);
});

test("B4 a short-lived key cannot make or take back another key", async (t) => {
  const { server } = await openBranch(t);
  const made = await fetch(`${server.url}/api/tokens`, { method: "POST", headers: {
    authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
    body: JSON.stringify({ scope: "run", minutes: 10 }) });
  const key = (await made.json()).token;
  for (const [path, body] of [["/api/tokens", { scope: "run" }], ["/api/tokens/abc/revoke", {}]]) {
    const tried = await fetch(server.url + path, { method: "POST", headers: {
      authorization: `Bearer ${key}`, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(tried.ok, false, path);
    assert.match((await tried.json()).error, /A short-lived key cannot make or take back a short-lived key/);
  }
  const listing = await fetch(`${server.url}/api/tokens`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(listing.ok, false, "and it cannot read the list of keys either");

  // Somebody else using this computer under their own profile is refused the keys and the terminal's
  // places, reading included. A task's trace carries no words of its own, so it is an ordinary read,
  // like the inspect and monitor views beside it.
  const { offLimitsToHousehold } = await import("../dist/server.js");
  for (const [method, path] of [["POST", "/api/tokens"], ["GET", "/api/tokens"],
    ["POST", "/api/tokens/abc/revoke"], ["GET", "/api/terminal"]])
    assert.ok(offLimitsToHousehold(method, path), `${method} ${path} must be the owner's alone`);
});

test("B4 a command that would write to the same saved work still refuses, and says what to do", async (t) => {
  const { root, dataDir } = await openBranch(t);
  const refused = await branchCli(dataDir, root, ["backup", join(root, "out.json")]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Branch is already open and using the work saved in /);
  assert.match(refused.stderr, /branch doctor, branch token, branch trace, branch schedule/);
  assert.match(refused.stderr, /from any terminal: branch status, branch doctor/, "status is named among the ones that work");
  assert.match(refused.stderr, /needs that Branch closed first/);
  // The terminal's own writers are refused over the running Branch too, not quietly allowed.
  const themed = await branchCli(dataDir, root, ["theme", "dark"]);
  assert.equal(themed.code, 1);
  assert.match(themed.stderr, /Branch is already open/);
});

test("B4 branch trace reads one task's steps from the Branch that is open", async (t) => {
  const { root, app, dataDir } = await openBranch(t);
  const run = await app.runtime.run({ prompt: "say something" });
  const traced = await branchCli(dataDir, root, ["trace", run.id]);
  assert.equal(traced.code, 0, traced.stderr);
  assert.match(traced.stdout, /^Trace [a-f0-9]+ — \d+ step\(s\)/);
  assert.match(traced.stdout, /Sending traces is off, so this trace has stayed on this computer\./);
  const missing = await branchCli(dataDir, root, ["trace", "no-such-task"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Nothing was recorded for the task no-such-task\./);
});

/**
 * Integration review (B4). `GET /api/terminal` decides what it will run by the command's NAME, and
 * the words after it are passed straight through. That is only safe while every name on the list
 * reads and nothing else, so the list is pinned here: adding a name to it has to be a deliberate
 * act with this test changed, not something that arrives with a new subcommand. It also proves each
 * name really is answered — `version` used to be on the list and answer "I do not know the command".
 */
test("B4 the terminal door runs the commands that only look, and refuses the rest in plain words", async (t) => {
  const { server } = await openBranch(t);
  const { readOnlyTerminalCommands } = await import("../dist/terminal-cli.js");
  assert.deepEqual([...readOnlyTerminalCommands].sort(), [
    "automations", "channels", "customize", "household", "inbox", "library", "mcp", "memory",
    "overview", "places", "projects", "sessions", "settings", "skills", "snapshots", "status", "tools", "usage", "version",
  ], "the list of terminal commands a second terminal may run is pinned; changing it is deliberate");

  const ask = (query) => fetch(`${server.url}/api/terminal?${query}`, { headers: { authorization: `Bearer ${server.token}` } });
  for (const command of readOnlyTerminalCommands) {
    const answer = await ask(`command=${command}`);
    const body = await answer.json();
    assert.equal(answer.status, 200, `${command}: ${JSON.stringify(body)}`);
    const { lines } = body;
    assert.ok(Array.isArray(lines), `${command} answers with the lines it would have printed`);
    assert.ok(!lines.join("\n").includes("I do not know the command"), `${command} is really answered`);
  }
  // Nothing else gets through, whether it writes or is not a command at all, and the refusal says so.
  for (const command of ["theme", "lockdown", "model", "run", "backup", "not-a-command"]) {
    const refused = await ask(`command=${command}`);
    assert.equal(refused.status, 400, command);
    const said = (await refused.json()).error;
    assert.match(said, /is not one of the terminal commands that only look/);
    assert.match(said, /needs that Branch closed first/);
  }
});

/**
 * `branch status` only reads, so beside the open Branch it asks that Branch through the same door
 * as the places that only look, instead of being refused. It prints the very lines, and the same
 * --json shape, it prints with nothing running: both come from one function. The door stays this
 * computer's own key's alone, because status shows every working task's words and every question.
 */
const statusKeys = ["approvalPreset", "approvals", "health", "running", "waitingForYou"];
const healthKeys = ["checkedAt", "items", "ok"];

test("B4 branch status works beside the open Branch, in the same lines and --json shape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-b4-"));
  const dataDir = join(root, "data");
  const asked = [];
  // Opened as the app window opens it: the whole Branch, then its door announced as the app's.
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: {
    name: "scripted", async complete(request) { asked.push(request); return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  // One task working and one question waiting, both in the Branch that is open.
  const owner = app.runtime.owner;
  const working = app.store.createRun(owner, "tidy the garden notes");
  const question = "Which evening suits you, Friday or Saturday?";
  const waiting = app.store.finish(app.store.createRun(owner, "book a table").id, "needs_input", question);
  assert.equal(app.store.run(working.id).status, "running", "the task is still working when the terminal asks");

  const plain = await branchCli(dataDir, root, ["status"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.stderr, /already open/);
  assert.match(plain.stdout, /^When to check with me: \S+/m);
  assert.match(plain.stdout, /^Working now:$/m);
  assert.ok(plain.stdout.includes(`\n  ${working.id} — tidy the garden notes\n`), plain.stdout);
  assert.ok(plain.stdout.includes(`\n  waiting for you: ${waiting.id} — ${question}\n`), plain.stdout);
  assert.match(plain.stdout, /^(Everything checks out\.|Some checks need attention:)$/m);
  assert.match(plain.stdout, /^ {2}(ok|x ) Saved data: /m);

  const json = await branchCli(dataDir, root, ["status", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const said = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(said).sort(), statusKeys);
  assert.deepEqual(Object.keys(said.health).sort(), healthKeys);
  assert.deepEqual(said.running.map((run) => [run.id, run.prompt]), [[working.id, "tidy the garden notes"]]);
  assert.deepEqual(said.waitingForYou.map((run) => [run.id, run.question]), [[waiting.id, question]]);
  assert.ok(said.health.items.some((check) => check.name === "Saved data"), "the health summary came back");
  // The health summary only looks: nothing was sent to the model to fill it in.
  assert.equal(asked.length, 0, "status asked the model something");
});

test("B4 the terminal door gives status to this computer's own key alone, whatever the query says", async (t) => {
  const { app, server } = await openBranch(t);
  const { householdRefusalFor } = await import("../dist/household-routes.js");
  const ask = (key) => fetch(`${server.url}/api/terminal?command=status&json=1&locale=en_GB.UTF-8`, {
    headers: { authorization: `Bearer ${key}` } }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const owner = await ask(server.token);
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.deepEqual(Object.keys(JSON.parse(owner.body.lines.join("\n"))).sort(), statusKeys);

  // A script's short-lived key, for looking or for starting tasks, is refused before status runs.
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope, minutes: 5 }).token;
    const refused = await ask(key);
    assert.equal(refused.status, 401, scope);
    assert.match(refused.body.error, /A short-lived key cannot read/, scope);
  }
  // So is the window while it is switched to somebody else's household profile.
  const call = (path, body) => fetch(server.url + path, { method: "POST", headers: {
    authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
  const sam = await (await call("/api/profiles", { name: "Sam", pin: "2468" })).json();
  assert.equal((await call("/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  const household = await ask(server.token);
  assert.equal(household.status, 400);
  assert.equal(household.body.error, householdRefusalFor("/api/terminal"));
  assert.equal((await call("/api/profiles/switch", { profileId: null })).status, 200);
  assert.equal((await ask(server.token)).status, 200, "switched back, the owner reads it again");
});

test("B4 with nothing running, branch status opens the saved work itself, as before", async (t) => {
  const root = await scratch(t, "branch-b4-");
  const dataDir = join(root, "data");
  const plain = await branchCli(dataDir, root, ["status"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /^When to check with me: \S+/m);
  assert.match(plain.stdout, /^Nothing is working right now\.$/m);
  assert.match(plain.stdout, /^(Everything checks out\.|Some checks need attention:)$/m);
  assert.match(plain.stdout, /^ {2}(ok|x ) Saved data: /m);

  const json = await branchCli(dataDir, root, ["status", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const said = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(said).sort(), statusKeys);
  assert.deepEqual(Object.keys(said.health).sort(), healthKeys);
  assert.deepEqual([said.running, said.waitingForYou], [[], []]);
  // Nothing was open, so this terminal made and read the saved work itself.
  assert.equal(await readRunning(dataDir), null);
  assert.ok((await stat(join(dataDir, "branch.sqlite"))).isFile());
});
