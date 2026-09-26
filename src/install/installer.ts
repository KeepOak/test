import { cp, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quitRunning, type QuitReport } from "./quit.js";
import { installedLocation, portableLocation, legacyDataDirs, migrateLegacyData, type MigrationReport } from "./layout.js";
import { createShortcuts, regDeleteKeyArgs, runTool, systemTool, writeRegistryValues, type RegistryValue, type RunTool } from "./windows.js";

/**
 * Installing without a signed installer. The release zip already carries a complete Node runtime
 * (the app's own executable), so a two-line Windows script unpacks the zip and hands the real work
 * back to this file: copy the app into the person's own programs folder, make the Start menu entry,
 * register an Uninstall entry, keep the previous version, and bring older data along.
 */
export const defaultUninstallHive = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
export const uninstallKeyName = "BranchAgent";
export const publisher = "Branch Agent";

export interface InstallOptions {
  /** Folder holding the unpacked app (the one with the executable in it). */
  source: string;
  /** Where the app is installed, normally %LOCALAPPDATA%\Programs\Branch Agent. */
  installRoot: string;
  executableName: string;
  version: string;
  /** Folder for the Start menu shortcut. */
  startMenuDir: string;
  /** Folder for the desktop shortcut, or null to skip it. */
  desktopDir?: string | null;
  /** Root of the Add/Remove Programs list; tests pass their own so nothing real is written. */
  uninstallHive?: string;
  /** Where the app keeps saved work after this install. */
  userDataDir: string;
  legacyDataDirs?: string[];
}
export interface InstallReport {
  installRoot: string;
  executable: string;
  previousKept: string | null;
  /** mac7/real-update: a Branch that was open was closed through its own route before installing. */
  closedFirst: boolean;
  shortcuts: string[];
  /** mac7/win-icon: whether the installed app gave the shortcuts the taskbar's app ID. */
  shortcutsStamped: boolean;
  uninstallKey: string;
  uninstaller: string;
  data: MigrationReport;
}
export interface InstallDeps {
  run?: RunTool; systemRoot?: string;
  /** mac7/real-update: asks a running Branch to close through its own route (src/install/quit.ts). */
  quit?: (dataDir: string) => Promise<QuitReport>;
  /** mac7/real-update: whether Windows still holds the program file open. */
  locked?: (file: string) => Promise<boolean>;
  lockPauseMs?: number;
  /**
   * mac7/win-icon: asks the installed app to give its shortcuts the taskbar's app ID, which the
   * script host cannot write (src/install/windows-identity.ts). A failure is not fatal: the shortcuts
   * already carry the mascot icon, and the app adds the ID itself when it first starts.
   */
  stampShortcuts?: (executable: string) => Promise<void>;
}

/** Windows will not let a running program's file be opened for writing; nothing is written. */
async function fileLocked(file: string): Promise<boolean> {
  try { await (await open(file, "r+")).close(); return false; }
  catch (error) { return ["EBUSY", "EPERM", "EACCES"].includes((error as { code?: string }).code ?? ""); }
}

/**
 * mac7/real-update. Installing over the copy that is open failed half-way with a raw
 * "EPERM: operation not permitted, unlink ...Branch Agent.exe". The copy that is running is now asked
 * to close through its own route first; when it cannot be (0.17.0 has no such route) or something
 * still holds the program open, the install stops before anything changes, and says what to do.
 */
async function closeRunningFirst(options: InstallOptions, deps: InstallDeps): Promise<boolean> {
  const executable = join(options.installRoot, options.executableName);
  let closed = false;
  for (const dataDir of [installedLocation(options.userDataDir).dataDir, portableLocation(options.installRoot).dataDir]) {
    const report = await (deps.quit ?? quitRunning)(dataDir).catch(() => null);
    if (report?.wasRunning && !report.stopped) throw stillOpen();
    closed ||= Boolean(report?.wasRunning);
  }
  const installed = await stat(executable).then(() => true, () => false);
  const locked = deps.locked ?? fileLocked;
  // The window's helper processes let go of the program a moment after the app itself has gone.
  for (let tries = closed ? 30 : 0; installed && tries > 0 && await locked(executable); tries--)
    await new Promise((resolve) => setTimeout(resolve, deps.lockPauseMs ?? 500));
  if (installed && await locked(executable)) throw stillOpen();
  return closed;
}
const stillOpen = () => new Error("Branch Agent is still open, so it was not replaced. Nothing was changed. "
  + "Quit it first (right-click the Branch icon by the clock and choose Quit), then run the installer again.");

export function defaultInstallRoot(env: NodeJS.ProcessEnv): string {
  const local = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
  return join(local, "Programs", "Branch Agent");
}
export function uninstallKey(hive = defaultUninstallHive): string {
  return `${hive}\\${uninstallKeyName}`;
}
export const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const runValueName = "Branch Agent";

/**
 * mac7/app-icon: the mascot icon that travels inside the app, and what Windows shows when it is not
 * there. The executable itself is the stock Electron one (see scripts/package-desktop.mjs, which
 * copies it back over the packaged one so Smart App Control keeps recognising its hash), so it still
 * carries Electron's own logo. Every shortcut and every list entry has to name the `.ico` instead.
 */
export const shippedIconPath = join("resources", "app", "public", "assets", "branch.ico");
export function shortcutIcon(installRoot: string, executableName: string, hasIcon: boolean): string {
  return hasIcon ? `${join(installRoot, shippedIconPath)},0` : `${join(installRoot, executableName)},0`;
}

/** What Add/Remove Programs shows, and how it removes the app again. */
export function uninstallEntries(options: {
  installRoot: string; executableName: string; version: string; uninstaller: string; icon?: string;
}): RegistryValue[] {
  const quiet = `"${options.uninstaller}" /quiet`;
  return [
    { name: "DisplayName", type: "REG_SZ", value: "Branch Agent" },
    { name: "DisplayVersion", type: "REG_SZ", value: options.version },
    { name: "Publisher", type: "REG_SZ", value: publisher },
    { name: "InstallLocation", type: "REG_SZ", value: options.installRoot },
    { name: "DisplayIcon", type: "REG_SZ", value: options.icon ?? join(options.installRoot, options.executableName) },
    { name: "UninstallString", type: "REG_SZ", value: `"${options.uninstaller}"` },
    { name: "QuietUninstallString", type: "REG_SZ", value: quiet },
    { name: "NoModify", type: "REG_DWORD", value: "1" },
    { name: "NoRepair", type: "REG_DWORD", value: "1" },
  ];
}

/** The removal script left in the install folder; saved work is deliberately kept. */
/**
 * A path as a batch script must write it. The script's own parser reads `%` even inside quotes, so a
 * folder such as `100%Done` loses part of its name unless the `%` is doubled; and outside quotes `&`, `^`
 * and friends split the line, so every path goes inside them. Every path the uninstaller names goes
 * through here, not only the one that happened to be measured first.
 */
const batchText = (path: string): string => path.replaceAll("%", "%%");
const batchPath = (path: string): string => `"${batchText(path)}"`;

export function uninstallScript(options: {
  installRoot: string; executableName: string; uninstallHive: string; userDataDir: string; shortcuts: string[];
}): string {
  const sys = "%SystemRoot%\\System32\\";
  const remove = options.shortcuts.map((path) => `del /q ${batchPath(path)} 2>NUL`);
  return [
    // Whoever starts this script may have delayed expansion on (`cmd /v:on`, or the Command Processor
    // `DelayedExpansion` registry value), which strips `!` from every path below, or command extensions
    // off, which breaks `if defined` and `%%~A`. Plain `setlocal` keeps the caller's settings; this sets both.
    "@echo off", "setlocal EnableExtensions DisableDelayedExpansion",
    // bucket 22: `--delete-data` removes conversations and files too; without it they are always kept.
    'set "DELETE_DATA="', 'for %%A in (%*) do if /i "%%~A"=="--delete-data" set "DELETE_DATA=1"',
    `if not defined DELETE_DATA echo Removing Branch Agent. Your conversations and files stay in ${batchPath(options.userDataDir)}.`,
    "if defined DELETE_DATA echo Removing Branch Agent, with its conversations and files.",
    `${sys}taskkill.exe /IM "${options.executableName}" /F >NUL 2>&1`,
    `${sys}ping.exe -n 3 127.0.0.1 >NUL`,
    `${sys}schtasks.exe /Delete /F /TN "Branch Agent daemon" >NUL 2>&1`,
    `${sys}reg.exe delete "${runKey}" /v "${runValueName}" /f >NUL 2>&1`,
    `${sys}reg.exe delete "${uninstallKey(options.uninstallHive)}" /f >NUL 2>&1`,
    ...remove,
    `rmdir /s /q ${batchPath(`${options.installRoot}.previous`)} 2>NUL`,
    `if defined DELETE_DATA rmdir /s /q ${batchPath(options.userDataDir)} 2>NUL`,
    // A script cannot delete the folder it is running from, so the last step runs from the temp folder.
    // The folder's path never appears on that step's command line. Nested inside `cmd /c "..."`, a path
    // is outside quotes for one of the two parsers whichever way it is quoted, so a space, `&` or `^` in
    // it (`Programs\Branch Agent`, or an account folder such as `Tom&Jerry`) split the line: the install
    // was left behind and `rmdir` was handed a differently named path. It is set in a variable here and
    // expanded only when the step runs (`/v:on`, `!…!`), when nothing is parsed again. `%` is doubled
    // because the script's own parser reads it even inside quotes. `/b` keeps the step in the
    // uninstaller's own console rather than opening a second window.
    `set "BRANCH_REMOVE=${batchText(options.installRoot)}"`,
    `start "" /b /d "%TEMP%" ${sys}cmd.exe /d /v:on /c "${sys}ping.exe -n 4 127.0.0.1 >NUL & rmdir /s /q "!BRANCH_REMOVE!""`,
    "exit /b 0", "",
  ].join("\r\n");
}

/**
 * The script shipped next to the release zip. It verifies and preflights a private staged copy,
 * then runs this module from inside the unpacked app, so installing needs nothing else installed.
 */
export function bootstrapperScript(options: { assetName: string; executableName: string }): string {
  const sys = "%SystemRoot%\\System32\\";
  const ps = `${sys}WindowsPowerShell\\v1.0\\powershell.exe`;
  const verify = [
    "$archive=$env:ARCHIVE", "$expectedName=$env:ASSET_NAME",
    "$line=(Get-Content -LiteralPath ($archive+'.sha256') -Raw).Trim()",
    "$match=[regex]::Match($line,'\\A([0-9a-fA-F]{64})  ([^\\r\\n]+)\\z')",
    "if(-not $match.Success -or $match.Groups[2].Value -cne $expectedName){throw 'The checksum file is not valid.'}",
    "$actual=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash",
    "if($actual -ne $match.Groups[1].Value){throw 'The download did not match the published checksum.'}",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip=[IO.Compression.ZipFile]::OpenRead($archive)",
    "try{foreach($item in $zip.Entries){$name=$item.FullName.Replace([char]92,'/');"
      + "if($name.IndexOf([char]0) -ge 0 -or $name -match ':' -or $name -match '(^/|(^|/)\\.\\.(/|$))'){throw 'The download contains an unsafe path.'};"
      + "if((($item.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw 'The download contains an unsafe link.'}}}finally{$zip.Dispose()}",
  ].join(";");
  return [
    "@echo off", "setlocal DisableDelayedExpansion", "title Install Branch Agent",
    // bucket 22: `/quiet` (or `--quiet`) never waits for a key press, so a script can run it. The stand-in
    // is `type NUL`, not `rem`: a `rem` would swallow the rest of the line it lands on, `exit` included.
    'set "PAUSE=pause"', 'for %%A in (%*) do if /i "%%~A"=="/quiet" set "PAUSE=type NUL"',
    'for %%A in (%*) do if /i "%%~A"=="--quiet" set "PAUSE=type NUL"',
    'set "HERE=%~dp0"', `set "ZIP=%HERE%${options.assetName}"`, 'set "CHECKSUM=%ZIP%.sha256"',
    `if not exist "%ZIP%" ( echo Put this file in the same folder as ${options.assetName} and run it again. & %PAUSE% & exit /b 1 )`,
    `if not exist "%CHECKSUM%" ( echo Put this file in the same folder as ${options.assetName}.sha256 and run it again. & %PAUSE% & exit /b 1 )`,
    'set "STAGE=%TEMP%\\branch-agent-setup-%RANDOM%-%RANDOM%"', `set "ASSET_NAME=${options.assetName}"`,
    `set "ARCHIVE=%STAGE%\\${options.assetName}"`, 'mkdir "%STAGE%"',
    'if errorlevel 1 ( echo A private setup folder could not be made. & %PAUSE% & exit /b 1 )',
    'copy /b "%ZIP%" "%ARCHIVE%" >NUL', 'if errorlevel 1 ( rmdir /s /q "%STAGE%" & echo The download could not be staged. & %PAUSE% & exit /b 1 )',
    'copy /b "%CHECKSUM%" "%ARCHIVE%.sha256" >NUL', 'if errorlevel 1 ( rmdir /s /q "%STAGE%" & echo The checksum could not be staged. & %PAUSE% & exit /b 1 )',
    "echo Checking Branch Agent...", `"${ps}" -NoProfile -NonInteractive -Command "${verify}"`,
    'if errorlevel 1 ( rmdir /s /q "%STAGE%" & echo The download was not opened. & %PAUSE% & exit /b 1 )',
    "echo Unpacking Branch Agent...", `"${ps}" -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath $env:ARCHIVE -DestinationPath $env:STAGE -Force"`,
    'if errorlevel 1 ( rmdir /s /q "%STAGE%" & echo The download could not be unpacked. & %PAUSE% & exit /b 1 )',
    `set "APP=%STAGE%"`,
    `if not exist "%APP%\\${options.executableName}" for /d %%D in ("%STAGE%\\*") do if exist "%%~fD\\${options.executableName}" set "APP=%%~fD"`,
    `if not exist "%APP%\\${options.executableName}" ( echo The download did not contain the app. & %PAUSE% & exit /b 1 )`,
    "echo Installing...",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"%APP%\\${options.executableName}" "%APP%\\resources\\app\\dist\\install\\install-cli.js" install --source "%APP%" %*`,
    "set CODE=%ERRORLEVEL%",
    'rmdir /s /q "%STAGE%" 2>NUL',
    "if not \"%CODE%\"==\"0\" ( echo Installing did not finish. & %PAUSE% & exit /b %CODE% )",
    "echo Done. Branch Agent is in your Start menu.", "%PAUSE%", "exit /b 0", "",
  ].join("\r\n");
}

async function keepPrevious(installRoot: string, executableName: string): Promise<string | null> {
  const previous = `${installRoot}.previous`;
  const installed = await stat(join(installRoot, executableName)).then(() => true, () => false);
  if (!installed) return null;
  await rm(previous, { recursive: true, force: true });
  await cp(installRoot, previous, { recursive: true, force: true });
  return previous;
}

function shortcutTargets(options: InstallOptions): { path: string; desktop: boolean }[] {
  const targets = [{ path: join(options.startMenuDir, "Branch Agent.lnk"), desktop: false }];
  if (options.desktopDir) targets.push({ path: join(options.desktopDir, "Branch Agent.lnk"), desktop: true });
  return targets;
}

/** Whether the copy that was just installed carries the mascot `.ico`. */
async function hasShippedIcon(installRoot: string): Promise<boolean> {
  return stat(join(installRoot, shippedIconPath)).then(() => true, () => false);
}

/** Copies the app into place, makes the shortcuts, registers Uninstall and brings older data along. */
export async function performInstall(options: InstallOptions, deps: InstallDeps = {}): Promise<InstallReport> {
  const executable = join(options.installRoot, options.executableName);
  const closedFirst = await closeRunningFirst(options, deps);
  const previousKept = await keepPrevious(options.installRoot, options.executableName);
  await mkdir(options.installRoot, { recursive: true });
  await cp(options.source, options.installRoot, { recursive: true, force: true });
  await mkdir(options.startMenuDir, { recursive: true });
  if (options.desktopDir) await mkdir(options.desktopDir, { recursive: true });
  const iconLocation = shortcutIcon(options.installRoot, options.executableName, await hasShippedIcon(options.installRoot));
  const shortcuts = await createShortcuts(
    shortcutTargets(options).map((target) => ({
      path: target.path, target: executable, workingDirectory: options.installRoot,
      description: "Branch Agent — your assistant on this computer", iconLocation,
    })), deps);
  const hive = options.uninstallHive ?? defaultUninstallHive;
  const uninstaller = join(options.installRoot, "Uninstall Branch Agent.cmd");
  await writeFile(uninstaller, uninstallScript({
    installRoot: options.installRoot, executableName: options.executableName,
    uninstallHive: hive, userDataDir: options.userDataDir, shortcuts,
  }), "utf8");
  await writeRegistryValues(uninstallKey(hive), uninstallEntries({
    installRoot: options.installRoot, executableName: options.executableName,
    version: options.version, uninstaller, icon: iconLocation.replace(/,0$/, ""),
  }), deps);
  const shortcutsStamped = deps.stampShortcuts
    ? await deps.stampShortcuts(executable).then(() => true, () => false) : false;
  const target = installedLocation(options.userDataDir).dataDir;
  await mkdir(target, { recursive: true });
  const data = await migrateLegacyData(
    options.legacyDataDirs ?? legacyDataDirs(process.env), target);
  return { installRoot: options.installRoot, executable, previousKept, closedFirst, shortcuts, shortcutsStamped, uninstallKey: uninstallKey(hive), uninstaller, data };
}

/** Removes the Add/Remove Programs entry; the folder itself is removed by the uninstall script. */
export async function removeUninstallEntry(hive: string, deps: InstallDeps = {}): Promise<void> {
  const run = deps.run ?? runTool;
  await run(systemTool("reg.exe", deps.systemRoot), regDeleteKeyArgs(uninstallKey(hive))).catch(() => undefined);
}
