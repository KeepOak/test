/**
 * The installers a release carries beside the update archives, made from the app that
 * `scripts/package-desktop.mjs --release` already built (run that first, on the same computer):
 *
 *   node scripts/package-installers.mjs [--arch arm64|x64]
 *
 * Windows: `Branch-Agent-Setup-windows-x64.exe`, one per-user setup file (no administrator). It unpacks
 * the app to its own temporary folder and runs the installer that travels inside the app
 * (dist/install/install-cli.js), exactly what `Install Branch Agent.cmd` runs: the same Start-menu and
 * desktop shortcuts, the same Apps entry and uninstaller, the same kept previous copy and kept data.
 * Built with Inno Setup, which the Windows build machines already have (nothing is added to npm).
 * macOS: `Branch-Agent-macos-<arch>.dmg`, the app beside a link to Applications (hdiutil, built in).
 * Linux: `Branch-Agent-linux-x64.deb` (dpkg-deb, built in) and `Branch-Agent-linux-x64.AppImage`
 * (mksquashfs plus AppImage's own start-up file, fetched once and checked against a pinned SHA-256).
 * Every installer gets a `.sha256` beside it. The update archives are left exactly as they were: the
 * Stable updater keeps installing those by name (src/desktop/release-assets.ts).
 */
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checksumLine, parseArgs, runCommand } from "./package-desktop.mjs";
import * as linux from "./package-linux.mjs";
import * as mac from "./package-macos.mjs";

const RELEASE = "release";
export const WINDOWS_SETUP = "Branch-Agent-Setup-windows-x64.exe";
export const LINUX_DEB = "Branch-Agent-linux-x64.deb";
export const LINUX_APPIMAGE = "Branch-Agent-linux-x64.AppImage";
export const macDmgName = (arch) => mac.macAssetName(arch).replace(/\.zip$/, ".dmg");
/** Every installer a complete release carries (each with its `.sha256`). */
export const installerNames = [WINDOWS_SETUP, ...mac.MAC_ARCHES.map(macDmgName), LINUX_DEB, LINUX_APPIMAGE];

/** Where a deb puts the app, and the file inside it that tells the updater a package manager owns it. */
export const DEB_ROOT = "/opt/branch-agent";
export const PACKAGE_TYPE_FILE = join("resources", "package-type");

/** AppImage's own start-up program (the part before the files), pinned to one release and its SHA-256. */
export const APPIMAGE_RUNTIME = {
  url: "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64",
  sha256: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
};

/** Windows file versions are four numbers; a prerelease keeps only its first three. */
export function numericVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Invalid Branch version: ${version}`);
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

/** Debian orders `~` before anything, so 0.20.0~beta.1 sorts before 0.20.0 as SemVer's `-` does. */
export function debVersion(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid Branch version: ${version}`);
  return version.replace("-", "~");
}

const inno = (text) => text.replaceAll('"', '""');

/**
 * The Inno Setup script. Nothing is installed by Inno itself (no app folder of its own, no uninstaller
 * of its own): the files go to Inno's temporary folder and the app's own installer does the rest, so
 * the setup file and the .cmd script cannot drift apart. `--install-root`, `--start-menu`, `--desktop`,
 * `--no-desktop-shortcut`, `--user-data` and `--uninstall-hive` given to the setup file are passed on.
 */
export function innoScript({ version, appFolder, outputDir, icon }) {
  return `; Written by scripts/package-installers.mjs. Do not edit by hand.
[Setup]
AppName=Branch Agent
AppVersion=${inno(version)}
AppPublisher=Branch Agent
VersionInfoVersion=${numericVersion(version)}
VersionInfoCompany=Branch Agent
VersionInfoProductName=Branch Agent
VersionInfoProductVersion=${numericVersion(version)}
VersionInfoDescription=Branch Agent Setup
PrivilegesRequired=lowest
Uninstallable=no
CreateAppDir=no
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=no
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=${inno(icon)}
OutputDir=${inno(outputDir)}
OutputBaseFilename=${WINDOWS_SETUP.replace(/\.exe$/, "")}
Compression=lzma2/normal
SolidCompression=yes
SetupLogging=yes

[Files]
Source: "${inno(appFolder)}\\*"; DestDir: "{tmp}\\app"; Flags: ignoreversion recursesubdirs createallsubdirs

[Code]
function SetEnvironmentVariable(Name: String; Value: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';
function ClearEnvironmentVariable(Name: String; Nothing: Cardinal): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

var
  Failure: Integer;
  InstalledIn: String;

function PassedOn(): String;
var
  I: Integer;
  Name: String;
begin
  Result := '';
  I := 1;
  while I <= ParamCount do begin
    Name := ParamStr(I);
    if (Name = '--no-desktop-shortcut') then
      Result := Result + ' ' + Name
    else if ((Name = '--install-root') or (Name = '--start-menu') or (Name = '--desktop') or
        (Name = '--user-data') or (Name = '--uninstall-hive')) and (I < ParamCount) then begin
      Result := Result + ' ' + Name + ' ' + AddQuotes(ParamStr(I + 1));
      I := I + 1;
    end;
    I := I + 1;
  end;
end;

procedure RunAppInstaller();
var
  App: String;
  Output: TExecOutput;
  Code: Integer;
  Line: Integer;
  Said: String;
begin
  App := ExpandConstant('{tmp}\\app');
  SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', '1');
  WizardForm.StatusLabel.Caption := 'Installing Branch Agent...';
  if not ExecAndCaptureOutput(App + '\\Branch Agent.exe',
      AddQuotes(App + '\\resources\\app\\dist\\install\\install-cli.js') + ' install --source ' + AddQuotes(App) + PassedOn(),
      App, SW_HIDE, ewWaitUntilTerminated, Code, Output) then Code := 1;
  ClearEnvironmentVariable('ELECTRON_RUN_AS_NODE', 0);
  Said := '';
  for Line := 0 to GetArrayLength(Output.StdOut) - 1 do begin
    Log(Output.StdOut[Line]);
    if Pos('Branch Agent is installed in ', Output.StdOut[Line]) = 1 then
      InstalledIn := Copy(Output.StdOut[Line], 30, Length(Output.StdOut[Line]) - 30);
  end;
  for Line := 0 to GetArrayLength(Output.StdErr) - 1 do begin
    Log(Output.StdErr[Line]);
    Said := Said + Output.StdErr[Line] + #13#10;
  end;
  if Code <> 0 then begin
    Failure := Code;
    SuppressibleMsgBox('Installing did not finish.' + #13#10#13#10 + Said, mbCriticalError, MB_OK, IDOK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RunAppInstaller();
end;

function GetCustomSetupExitCode(): Integer;
begin
  Result := Failure;
end;

function InstalledProgram(Param: String): String;
begin
  Result := AddBackslash(InstalledIn) + 'Branch Agent.exe';
end;

function Installed(): Boolean;
begin
  Result := (Failure = 0) and (InstalledIn <> '');
end;

[Run]
Filename: "{code:InstalledProgram}"; Description: "Open Branch Agent"; Flags: postinstall nowait skipifsilent; Check: Installed
`;
}

/** The unpacked Windows app the packager made. */
export const windowsAppFolder = (arch) => join(RELEASE, `Branch Agent-win32-${arch}`);

async function sha256Of(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeChecksum(path) {
  const name = path.split(/[\\/]/).pop();
  await writeFile(`${path}.sha256`, checksumLine(await sha256Of(path), name), "utf8");
  console.log(`${path}.sha256`);
}

async function packageVersion() {
  return JSON.parse(await readFile("package.json", "utf8")).version;
}

async function windowsInstaller(arch) {
  if (arch !== "x64") throw new Error(`There is no Windows installer for ${arch}.`);
  const appFolder = resolve(windowsAppFolder(arch));
  await stat(join(appFolder, "Branch Agent.exe"));
  const script = join(RELEASE, "build", "branch-setup.iss");
  await mkdir(join(RELEASE, "build"), { recursive: true });
  await writeFile(script, innoScript({ version: await packageVersion(), appFolder, outputDir: resolve(RELEASE),
    icon: resolve("public/assets/branch.ico") }), "utf8");
  const iscc = process.env.ISCC ?? "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe";
  runCommand([iscc, "/Q", script]);
  await writeChecksum(join(RELEASE, WINDOWS_SETUP));
}

/** The commands that make one disk image: a folder holding the app and a link to Applications. */
export function dmgPlan({ app, stage, dmg }) {
  return [
    ["ditto", app, join(stage, `${mac.MAC_APP_NAME}.app`)],
    ["ln", "-s", "/Applications", join(stage, "Applications")],
    ["hdiutil", "create", "-volname", mac.MAC_APP_NAME, "-srcfolder", stage, "-ov", "-fs", "HFS+", "-format", "UDZO", dmg],
  ];
}

async function macInstaller(arch) {
  const app = join(RELEASE, `${mac.MAC_APP_NAME}-darwin-${arch}`, `${mac.MAC_APP_NAME}.app`);
  await stat(app);
  const stage = join(RELEASE, "build", `dmg-${arch}`);
  const dmg = join(RELEASE, macDmgName(arch));
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const [copy, link, create] = dmgPlan({ app, stage, dmg });
  runCommand(copy);
  runCommand(link);
  // hdiutil on a shared build machine sometimes answers "Resource busy" once; a second try is enough.
  try { runCommand(create); } catch { runCommand(create); }
  await rm(stage, { recursive: true, force: true });
  await writeChecksum(dmg);
}

/** What the deb depends on: Electron's own libraries, under both their old and their 64-bit-time names. */
export const debDepends = [
  "libgtk-3-0 | libgtk-3-0t64", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils",
  "libatspi2.0-0 | libatspi2.0-0t64", "libuuid1", "libsecret-1-0", "libgbm1", "libasound2 | libasound2t64",
];

export function debControl({ version, installedKb }) {
  return [
    "Package: branch-agent", `Version: ${debVersion(version)}`, "Section: utils", "Priority: optional",
    "Architecture: amd64", "Maintainer: Branch Agent <noreply@github.com>", `Installed-Size: ${installedKb}`,
    `Depends: ${debDepends.join(", ")}`, "Homepage: https://github.com/stabrea/Branch-Agent",
    "Description: Branch Agent, your own assistant on this computer", "",
  ].join("\n");
}

/**
 * After install: Electron's sandbox helper must belong to root with the set-user-ID bit, or the app
 * cannot start its sandbox on systems that restrict user namespaces (Ubuntu 24.04 and later).
 */
export function debPostinst() {
  return [
    "#!/bin/sh", "set -e",
    `chmod 4755 '${DEB_ROOT}/chrome-sandbox' || true`,
    "if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi",
    "if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi",
    "",
  ].join("\n");
}

async function folderKb(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  return Math.ceil(total / 1024);
}

async function debInstaller(folder, version) {
  const stage = join(RELEASE, "build", "deb");
  await rm(stage, { recursive: true, force: true });
  const root = join(stage, ...DEB_ROOT.split("/").filter(Boolean));
  await cp(folder, root, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(root, PACKAGE_TYPE_FILE), "deb\n", "utf8");
  await mkdir(join(stage, "usr", "bin"), { recursive: true });
  await symlink(`${DEB_ROOT}/${linux.LINUX_EXECUTABLE}`, join(stage, "usr", "bin", linux.LINUX_EXECUTABLE));
  await mkdir(join(stage, "usr", "share", "applications"), { recursive: true });
  const entry = linux.desktopEntry({ version, folder: DEB_ROOT }).replace(/^Icon=.*$/m, `Icon=${linux.LINUX_EXECUTABLE}`);
  await writeFile(join(stage, "usr", "share", "applications", `${linux.LINUX_EXECUTABLE}.desktop`), entry, "utf8");
  const { LINUX_ICON_FOLDER, LINUX_ICON_SIZES, iconFileName } = await import("../dist/install/unix-icons.js");
  for (const size of LINUX_ICON_SIZES) {
    const into = join(stage, "usr", "share", "icons", "hicolor", `${size}x${size}`, "apps");
    await mkdir(into, { recursive: true });
    await copyFile(join(folder, LINUX_ICON_FOLDER, iconFileName(linux.LINUX_EXECUTABLE, size)), join(into, `${linux.LINUX_EXECUTABLE}.png`));
  }
  await mkdir(join(stage, "DEBIAN"), { recursive: true });
  await writeFile(join(stage, "DEBIAN", "control"), debControl({ version, installedKb: await folderKb(stage) }), "utf8");
  await writeFile(join(stage, "DEBIAN", "postinst"), debPostinst(), { encoding: "utf8", mode: 0o755 });
  await chmod(join(stage, "DEBIAN", "postinst"), 0o755);
  const deb = join(RELEASE, LINUX_DEB);
  runCommand(["dpkg-deb", "--root-owner-group", "-Zxz", "--build", stage, deb]);
  await rm(stage, { recursive: true, force: true });
  await writeChecksum(deb);
}

/** AppImage's entry point: starts the app from wherever the image is mounted, passing every argument on. */
export const appRun = '#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/branch-agent" "$@"\n';

async function appImageRuntime(fetchImpl = fetch) {
  const response = await fetchImpl(APPIMAGE_RUNTIME.url);
  if (!response.ok) throw new Error(`The AppImage runtime could not be fetched (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== APPIMAGE_RUNTIME.sha256)
    throw new Error("The AppImage runtime did not match its pinned SHA-256; nothing was built.");
  return bytes;
}

async function appImageInstaller(folder) {
  const appDir = join(RELEASE, "build", "AppDir");
  await rm(appDir, { recursive: true, force: true });
  await cp(folder, appDir, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(appDir, PACKAGE_TYPE_FILE), "appimage\n", "utf8");
  await writeFile(join(appDir, "AppRun"), appRun, { encoding: "utf8", mode: 0o755 });
  await chmod(join(appDir, "AppRun"), 0o755);
  await symlink(`${linux.LINUX_EXECUTABLE}.png`, join(appDir, ".DirIcon"));
  const image = join(RELEASE, "build", "app.squashfs");
  await rm(image, { force: true });
  runCommand(["mksquashfs", appDir, image, "-root-owned", "-noappend", "-comp", "zstd", "-quiet"]);
  const out = join(RELEASE, LINUX_APPIMAGE);
  await writeFile(out, Buffer.concat([await appImageRuntime(), await readFile(image)]), { mode: 0o755 });
  await chmod(out, 0o755);
  await rm(appDir, { recursive: true, force: true });
  await rm(image, { force: true });
  await writeChecksum(out);
}

async function main() {
  const { arch } = parseArgs(process.argv.slice(2), process.arch);
  if (process.platform === "win32") return windowsInstaller(arch);
  if (process.platform === "darwin") return macInstaller(arch);
  if (arch !== "x64") throw new Error(`There is no Linux installer for ${arch}.`);
  const folder = join(RELEASE, linux.LINUX_FOLDER);
  await stat(join(folder, linux.LINUX_EXECUTABLE));
  const version = await packageVersion();
  await debInstaller(folder, version);
  await appImageInstaller(folder);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
