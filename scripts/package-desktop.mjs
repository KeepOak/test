/**
 * `npm run package:desktop`: the desktop app for the computer this runs on.
 *
 *   node scripts/package-desktop.mjs [--release] [--arch arm64|x64]
 *
 * Windows makes the app folder and the installer script, exactly as before; `--release` also zips
 * it as the download. macOS makes `Branch Agent.app` and always zips it; Linux makes the unpacked
 * folder with a menu entry and always packs it. Every download gets a `.sha256` beside it.
 * The plans are pure functions (tested in tests/packaging.test.mjs); nothing here opens the app.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as mac from "./package-macos.mjs";
import * as linux from "./package-linux.mjs";

const RELEASE = "release";

/** The download name for a computer, written exactly as src/desktop/release-assets.ts has it. */
export function assetNameFor(platform, arch) {
  if (platform === "win32" && arch === "x64") return "Branch-Agent-windows-x64.zip";
  if (platform === "darwin" && mac.MAC_ARCHES.includes(arch)) return mac.macAssetName(arch);
  if (platform === "linux" && arch === "x64") return linux.linuxAssetName(arch);
  return null;
}

/** The same two-space line `sha256sum` writes, with the bare file name. */
export function checksumLine(digest, assetName) {
  return `${digest}  ${assetName}\n`;
}

/** Only the files the app needs travel inside it. */
export function includedInApp(path) {
  return (
    path === "" ||
    /^\/(dist|public|node_modules|phone)(\/|$)/.test(path) ||
    /^\/(package\.json|package-lock\.json|LICENSE|THIRD_PARTY_NOTICES\.md|README\.md)$/.test(path)
  );
}

/** Packager options per system. Windows is the long-standing set; the others add their own part. */
export function packagerOptions(platform, arch, icon) {
  const shared = {
    dir: ".", out: RELEASE, name: "Branch Agent", executableName: "Branch Agent",
    asar: false, overwrite: true, prune: true, ignore: (path) => !includedInApp(path),
  };
  if (platform === "darwin") return { ...shared, ...mac.macPackagerOptions({ arch, icon }) };
  if (platform === "linux") return { ...shared, ...linux.linuxPackagerOptions({ arch, icon }) };
  return {
    ...shared,
    icon: "public/assets/branch.ico",
    appCategoryType: "public.app-category.productivity",
    platform,
    arch,
  };
}

/** Windows download: zipped with the tar that comes with Windows (forward-slash entries). */
export function windowsZipCommand(folder, archive) {
  return ["C:\\Windows\\System32\\tar.exe", "-a", "-cf", archive, "-C", RELEASE, basename(folder)];
}

/** Windows only makes a download with --release; its plain app folder is built for any arch, as before. */
export function needsAssetName(platform, release) {
  return platform !== "win32" || release;
}

export function parseArgs(argv, hostArch) {
  const at = argv.indexOf("--arch");
  const arch = at >= 0 ? argv[at + 1] : hostArch;
  if (!arch || arch.startsWith("--")) throw new Error("--arch needs a value: arm64 or x64.");
  return { release: argv.includes("--release"), arch };
}

/** Runs one planned command; fails loudly with the program's name, never with its arguments. */
export function runCommand([file, ...args], options = {}) {
  const result = spawnSync(file, args, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`${file} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${file} stopped with code ${result.status}.`);
}

async function sha256Of(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeChecksum(archive) {
  await writeFile(`${archive}.sha256`, checksumLine(await sha256Of(archive), basename(archive)), "utf8");
  console.log(`${archive}.sha256`);
}

/**
 * The commit this build is made from, written into the app (dist/build-info.json) so the Dev update channel can
 * tell whether the newest change is already the one running. CI gives it as GITHUB_SHA; a local build asks git.
 */
export function buildInfo(env = process.env, askGit = () => spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout) {
  const commit = (env.GITHUB_SHA || askGit() || "").trim();
  return { commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null, builtAt: new Date().toISOString() };
}

async function runPackager(options) {
  const { packager } = await import("@electron/packager");
  return packager(options);
}

async function packageWindows({ arch, release }) {
  // The .ico holds the mascot at every size Windows asks for (scripts/make-icons.mjs).
  const { writeWindowsIcon } = await import("./make-icons.mjs");
  await writeWindowsIcon();
  const paths = await runPackager(packagerOptions("win32", arch));
  // Smart App Control blocks unsigned executables it has never seen. The packager rewrites the
  // executable's icon and version resources, giving every build a brand-new hash. Until releases
  // are code-signed, ship the stock Electron executable (a widely known hash) under the app name;
  // the window and tray icons are set at runtime, and the taskbar takes its icon from the shortcuts,
  // which name branch.ico and the app's own ID (src/install/windows-identity.ts, mac7/win-icon). A
  // shortcut that names the executable's icon shows Electron's atom in the taskbar: 0.18.0 did that.
  for (const out of paths) {
    const target = join(out, "Branch Agent.exe");
    await copyFile("node_modules/electron/dist/electron.exe", target);
    await utimes(target, new Date(), new Date()); // Electron's file dates predate 1980, which ZIP cannot store
  }
  // The installer: one script to put beside the release zip. It unpacks the zip with the tar that
  // comes with Windows and then runs the installer that travels inside the app itself, so nothing has
  // to be installed first and nothing has to be signed.
  const { bootstrapperScript } = await import("../dist/install/installer.js");
  const script = join(RELEASE, "Install Branch Agent.cmd");
  await writeFile(script, bootstrapperScript({
    assetName: assetNameFor("win32", "x64"), executableName: "Branch Agent.exe",
  }), "utf8");
  console.log(script);
  console.log(paths.join("\n"));
  if (!release) return;
  const archive = join(RELEASE, assetNameFor("win32", arch));
  await finishArchive(archive, windowsZipCommand(paths[0], archive));
}

async function finishArchive(archive, command, options) {
  await rm(archive, { force: true });
  runCommand(command, options);
  await writeChecksum(archive);
}

async function macIcon() {
  const iconset = join(RELEASE, "build", "branch.iconset");
  const icns = join(RELEASE, "build", "branch.icns");
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  for (const command of mac.iconPlan("public/assets/branch-mascot.png", iconset, icns))
    runCommand(command, { stdio: "ignore" });
  return icns;
}

/**
 * A signed Mac copy must keep its identity across updates, or the owner grants microphone, screen
 * recording and accessibility all over again. macOS decides that from the designated requirement, so
 * the build reads it back and refuses a bundle whose requirement is pinned to its own contents. The
 * dangerous failure this catches is silent: a build that lost the certificate still signs, still
 * runs, and still resets every permission.
 */
export function assertStableIdentity(app) {
  const [file, ...args] = mac.macRequirementCommand(app);
  const result = spawnSync(file, args, { encoding: "utf8" });
  if (result.error) throw new Error(`${file} could not run: ${result.error.message}`);
  const check = mac.macIdentityCheck(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (!check.ok) throw new Error(`This Mac copy would lose its identity on the next update: ${check.reason}`);
  console.log(`Identity receipt: ${check.requirement}`);
  return check;
}

/** bucket 22: the no-questions installer for macOS and Linux, published beside their downloads. */
async function writeUnixInstaller() {
  const { unixBootstrapperName, unixBootstrapperScript } = await import("../dist/install/unix-bootstrap.js");
  const script = join(RELEASE, unixBootstrapperName);
  await writeFile(script, unixBootstrapperScript(), { encoding: "utf8", mode: 0o755 });
  console.log(script);
}

/**
 * Whether the owner has switched Mac signing on (the `MAC_SIGNING_REQUIRED` repository variable,
 * set beside the three signing secrets). Only the exact word "true" counts.
 */
export function signingRequired(env) {
  return env.MAC_SIGNING_REQUIRED === "true";
}

export const unsignedReleaseWarning = "This Mac release is unsigned: its identity is its own contents, so every update will ask each person for microphone, screen recording and accessibility permission again. Turning signing on is in docs/desktop.md.";

/**
 * Signs, checks the identity, and only then zips (and notarises). Once signing is switched on, a
 * release is checked whether or not it thinks it signed: the failure worth catching is a build that
 * lost the certificate, signed ad hoc, and looks perfectly fine until every user's permissions are
 * gone. Checking before the zip means a refused build leaves no download behind. Before signing is
 * switched on, a release is unsigned as it always was, and says what that costs. A plain local build
 * stays ad-hoc, unchecked and silent.
 */
export function finishMac(plan, { app, release, required, run = runCommand, check = assertStableIdentity, warn = console.warn }) {
  const zipAt = plan.commands.findIndex(([file]) => file === "ditto");
  const signing = zipAt === -1 ? plan.commands : plan.commands.slice(0, zipAt);
  for (const command of signing) run(command);
  if (plan.signed || (release && required)) check(app);
  else if (release) warn(unsignedReleaseWarning);
  for (const command of plan.commands.slice(signing.length)) run(command);
}

async function packageMac({ arch, release }) {
  const [out] = await runPackager(packagerOptions("darwin", arch, await macIcon()));
  const app = join(out, `${mac.MAC_APP_NAME}.app`);
  const entitlements = join(RELEASE, "build", "entitlements.mac.plist");
  await writeFile(entitlements, mac.entitlementsPlist(), "utf8");
  const nested = mac.nestedCode(app, await readdir(join(app, "Contents", "Frameworks")));
  const zip = join(RELEASE, assetNameFor("darwin", arch));
  // The checksum goes too: a stale one beside a new zip names a download that is not there.
  await rm(zip, { force: true });
  await rm(`${zip}.sha256`, { force: true });
  const plan = mac.macFinishPlan({ app, zip, nested, entitlements, env: process.env });
  finishMac(plan, { app, release, required: signingRequired(process.env) });
  await writeChecksum(zip);
  await writeUnixInstaller();
  console.log(app);
  console.log(mac.macSigningNotice(plan));
}

/**
 * mac7/app-icon: the ready-made icon sizes the Linux installer copies into this person's icon theme,
 * so a menu, a dock and a switcher each draw a mark made for their size instead of shrinking one big
 * picture. Made with the repository's own PNG code, so nothing has to be installed to build a release.
 */
export async function writeLinuxIcons(folder) {
  const { LINUX_ICON_FOLDER, LINUX_ICON_SIZES, iconFileName } = await import("../dist/install/unix-icons.js");
  const { writePng } = await import("../apps/mobile/scripts/png.mjs");
  const { iconAt, readMasters } = await import("./make-icons.mjs");
  const masters = await readMasters();
  const into = join(folder, LINUX_ICON_FOLDER);
  await mkdir(into, { recursive: true });
  for (const size of LINUX_ICON_SIZES)
    await writeFile(join(into, iconFileName(linux.LINUX_EXECUTABLE, size)), writePng(iconAt(masters, size)));
  return into;
}

async function packageLinux({ arch }) {
  const [out] = await runPackager(packagerOptions("linux", arch, "public/assets/branch-mascot.png"));
  const folder = join(RELEASE, linux.LINUX_FOLDER);
  await rm(folder, { recursive: true, force: true });
  await rename(out, folder);
  await chmod(folder, 0o755); // the packager's working folder is private to its builder
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(join(folder, `${linux.LINUX_EXECUTABLE}.desktop`), linux.desktopEntry({ version: manifest.version }), "utf8");
  await copyFile("public/assets/branch-mascot.png", join(folder, `${linux.LINUX_EXECUTABLE}.png`));
  console.log(await writeLinuxIcons(folder));
  const archive = join(RELEASE, assetNameFor("linux", arch));
  await finishArchive(archive, linux.tarCommand({ releaseDir: RELEASE, folder: linux.LINUX_FOLDER, archive }), {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  await writeUnixInstaller();
  console.log(folder);
}

/**
 * mac7/phone-qr: the signed Android app travels inside the desktop download, in `phone/`, so
 * "Get Branch on your phone" can hand it to a phone from the person's own computer. Nothing is
 * published, so there is nowhere else for an installed Branch to get it from. It is copied from
 * where scripts/package-mobile.mjs put it, with its `.sha256`, and only when the two agree; without
 * it the download is built as before and the card says the phone app is not included.
 */
export async function stagePhoneApp({
  from = process.env.BRANCH_MOBILE_OUT ?? join(RELEASE, "mobile"), into = "phone", warn = console.warn,
} = {}) {
  const name = "Branch-Agent-android.apk";
  await rm(into, { recursive: true, force: true });
  const line = await readFile(join(from, `${name}.sha256`), "utf8").catch(() => "");
  const expected = /^([a-f0-9]{64}) {2}/.exec(line)?.[1];
  const actual = expected ? await sha256Of(join(from, name)).catch(() => null) : null;
  if (!expected || actual !== expected) {
    warn(`No checked phone app in ${from}; this download will not include it (run scripts/package-mobile.mjs --android first).`);
    return false;
  }
  await mkdir(into, { recursive: true });
  await copyFile(join(from, name), join(into, name));
  await writeFile(join(into, `${name}.sha256`), checksumLine(expected, name));
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.arch);
  if (needsAssetName(process.platform, options.release) && !assetNameFor(process.platform, options.arch))
    throw new Error(`There is no desktop download for ${process.platform} ${options.arch}.`);
  await stagePhoneApp();
  await writeFile(join("dist", "build-info.json"), `${JSON.stringify(buildInfo())}\n`, "utf8");
  if (process.platform === "win32") return packageWindows(options);
  if (process.platform === "darwin") return packageMac(options);
  return packageLinux(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
