import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import * as installers from "../scripts/package-installers.mjs";
import { releaseFiles } from "../scripts/publish-release.mjs";
import { packageTypeOf } from "../dist/desktop/release-assets.js";
import { Updater } from "../dist/desktop/updater.js";

const workflowText = await readFile(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
const workflow = parse(workflowText);
const step = (job, name) => workflow.jobs[job].steps.find((entry) => entry.name === name);

test("the Windows setup file is per-user and hands every step to the app's own installer", () => {
  const script = installers.innoScript({ version: "0.20.0", appFolder: "C:\\b\\release\\Branch Agent-win32-x64",
    outputDir: "C:\\b\\release", icon: "C:\\b\\public\\assets\\branch.ico" });
  assert.match(script, /^PrivilegesRequired=lowest$/m, "no administrator");
  assert.match(script, /^Uninstallable=no$/m, "the Apps entry and uninstaller are the app installer's own");
  assert.match(script, /^CreateAppDir=no$/m);
  assert.match(script, /^OutputBaseFilename=Branch-Agent-Setup-windows-x64$/m);
  assert.match(script, /DestDir: "\{tmp\}\\app"/, "the app is unpacked to the setup's own temporary folder only");
  assert.match(script, /resources\\app\\dist\\install\\install-cli\.js'\) \+ ' install --source '/,
    "the same install-cli.js that Install Branch Agent.cmd runs");
  assert.match(script, /SetEnvironmentVariable\('ELECTRON_RUN_AS_NODE', '1'\)/);
  assert.match(script, /ClearEnvironmentVariable\('ELECTRON_RUN_AS_NODE', 0\)/, "the app opened afterwards is the app, not Node");
  assert.match(script, /GetCustomSetupExitCode[\s\S]*Result := Failure/, "a failed install is a failed setup");
  // Only the installer's own flags are passed on, never anything else on the command line.
  const passed = [...script.matchAll(/Name = '(--[a-z-]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(passed, ["--desktop", "--install-root", "--no-desktop-shortcut", "--start-menu", "--uninstall-hive", "--user-data"]);
  assert.match(script, /Flags: postinstall nowait skipifsilent; Check: Installed/);
  assert.equal(installers.numericVersion("0.20.0"), "0.20.0.0");
  assert.equal(installers.numericVersion("0.0.0-rehearsal.3"), "0.0.0.0");
  assert.match(installers.innoScript({ version: '1.0.0-a"b', appFolder: "x", outputDir: "y", icon: "z" }), /AppVersion=1.0.0-a""b/);
});

test("the Mac disk image holds the app and a link to Applications", () => {
  const [copy, link, create] = installers.dmgPlan({ app: "release/B/Branch Agent.app", stage: "s", dmg: "o.dmg" });
  assert.equal(copy[0], "ditto", "ditto keeps the bundle's links and signature");
  assert.deepEqual(link.slice(0, 3), ["ln", "-s", "/Applications"]);
  assert.match(link[3], /^s[\\/]Applications$/);
  assert.equal(create[0], "hdiutil");
  assert.ok(create.includes("UDZO") && create.at(-1) === "o.dmg");
  assert.equal(installers.macDmgName("arm64"), "Branch-Agent-macos-arm64.dmg");
  assert.equal(installers.macDmgName("x64"), "Branch-Agent-macos-x64.dmg");
});

test("the Linux .deb sets up the sandbox helper and depends on Electron's libraries under both names", () => {
  assert.equal(installers.debVersion("0.20.0"), "0.20.0");
  assert.equal(installers.debVersion("0.0.0-rehearsal.3"), "0.0.0~rehearsal.3", "Debian sorts a prerelease before its release");
  assert.throws(() => installers.debVersion("1.0\nX: y"));
  const control = installers.debControl({ version: "0.20.0", installedKb: 12 });
  assert.match(control, /^Package: branch-agent$/m);
  assert.match(control, /^Architecture: amd64$/m);
  assert.match(control, /libasound2 \| libasound2t64/);
  assert.match(installers.debPostinst(), /chmod 4755 '\/opt\/branch-agent\/chrome-sandbox'/);
  assert.match(installers.appRun, /exec "\$HERE\/branch-agent" "\$@"/, "the AppImage passes every argument on");
  assert.match(installers.APPIMAGE_RUNTIME.url, /^https:\/\/github\.com\/AppImage\/type2-runtime\/releases\/download\/\d+\/runtime-x86_64$/,
    "a dated release, never `continuous`");
  assert.match(installers.APPIMAGE_RUNTIME.sha256, /^[0-9a-f]{64}$/);
});

test("every installer is published with its checksum, beside the update archives the updater reads", () => {
  const published = releaseFiles("v9.8.7");
  for (const name of installers.installerNames) {
    assert.ok(published.includes(name), name);
    assert.ok(published.includes(`${name}.sha256`), `${name}.sha256`);
  }
  for (const name of ["Branch-Agent-windows-x64.zip", "Branch-Agent-macos-arm64.zip", "Branch-Agent-macos-x64.zip", "Branch-Agent-linux-x64.tar.gz"])
    assert.ok(published.includes(name), `${name} is still published for the Stable updater`);
  const check = step("publish", "Check every download is there with its checksum").run;
  for (const name of installers.installerNames) assert.ok(check.includes(name), `the publish job checks ${name}`);
});

test("a .deb or AppImage copy is never replaced by the in-app updater, and says what to do instead", async () => {
  const read = (files) => (path) => {
    const hit = files[path.replace(/\\/g, "/")];
    if (hit === undefined) throw new Error("ENOENT");
    return hit;
  };
  assert.equal(packageTypeOf("linux", "/opt/branch-agent", read({ "/opt/branch-agent/resources/package-type": "deb\n" })), "deb");
  assert.equal(packageTypeOf("linux", "/tmp/.mount_x", read({ "/tmp/.mount_x/resources/package-type": "appimage\n" })), "appimage");
  assert.equal(packageTypeOf("linux", "/home/a/b", read({})), null, "the tar.gz copy updates itself as before");
  assert.equal(packageTypeOf("linux", "/opt/x", read({ "/opt/x/resources/package-type": "rpm" })), null);
  assert.equal(packageTypeOf("win32", "C:/b", read({ "C:/b/resources/package-type": "deb" })), null);
  assert.equal(packageTypeOf("linux", null, read({})), null);
  const base = { repo: "stabrea/Branch-Agent", currentVersion: "0.20.0", installDir: "/opt/branch-agent", executableName: "branch-agent",
    assetName: "Branch-Agent-linux-x64.tar.gz", scratchDir: "/tmp/none", platform: "linux", packaged: true,
    fetch: () => { throw new Error("no network in this test"); } };
  const deb = new Updater({ ...base, packageType: "deb" });
  assert.equal(deb.status.phase, "unsupported");
  assert.match(deb.status.message, /newest \.deb/);
  assert.match(new Updater({ ...base, packageType: "appimage" }).status.message, /newest AppImage/);
  assert.notEqual(new Updater({ ...base, packageType: null }).status.phase, "unsupported");
});

test("the release signs the Windows setup file only through SignPath, and says plainly when it could not", () => {
  const build = workflow.jobs.build;
  assert.equal(build.env.HAS_WINDOWS_SIGNING, "${{ secrets.SIGNPATH_API_TOKEN != '' && vars.SIGNPATH_ORGANIZATION_ID != '' }}");
  const sign = step("build", "Sign the setup file");
  assert.match(sign.uses, /^signpath\/github-action-submit-signing-request@[0-9a-f]{40}$/, "pinned to a commit");
  assert.equal(sign.if, "runner.os == 'Windows' && env.HAS_WINDOWS_SIGNING == 'true'");
  assert.equal(sign.with["api-token"], "${{ secrets.SIGNPATH_API_TOKEN }}");
  const place = step("build", "Put the signed setup file in place");
  assert.match(place.run, /Get-AuthenticodeSignature[\s\S]*-ne 'Valid'[\s\S]*exit 1/, "an invalid signature stops the release");
  assert.match(place.run, /\.sha256/, "the checksum is written again for the signed file");
  const warn = step("build", "Warn that the Windows setup file is unsigned");
  assert.match(warn.run, /::warning::/);
  assert.match(warn.run, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(warn.run, /exit 1/, "unsigned still ships");
  assert.match(step("build", "Refuse a half-finished Windows signing setup").run, /exit 1/);
  assert.match(step("publish", "Say in the notes when the Windows setup file is unsigned").run, /SmartScreen/);
  assert.doesNotMatch(workflowText, /echo[^\n]*secrets\.SIGNPATH/, "the token is never printed");
});

test("each system's installer is started once before anything is published, and provenance is recorded", () => {
  const windows = step("build", "Install, start, reinstall and uninstall the Windows setup file").run;
  assert.match(windows, /\/VERYSILENT/);
  assert.match(windows, /Start Menu\/Programs\/Branch Agent\.lnk/);
  assert.match(windows, /Desktop\/Branch Agent\.lnk/);
  assert.match(windows, /Uninstall\/BranchAgent/);
  assert.match(windows, /\.previous\/Branch Agent\.exe/, "installing again keeps the previous copy, as the .cmd installer does");
  assert.match(windows, /Uninstall Branch Agent\.cmd/);
  assert.match(windows, /node scripts\/launch-smoke\.mjs \$exe/);
  assert.match(step("build", "Open the Mac disk image and start the app inside it").run, /launch-smoke\.mjs "\$mount\/Branch Agent\.app\/Contents\/MacOS\/Branch Agent"/);
  const linux = step("build", "Install the Linux .deb and start the app, then start the AppImage").run;
  assert.match(linux, /xvfb-run -a node scripts\/launch-smoke\.mjs \/opt\/branch-agent\/branch-agent/);
  assert.match(linux, /xvfb-run -a node scripts\/launch-smoke\.mjs release\/Branch-Agent-linux-x64\.AppImage/);
  assert.match(linux, /root 4755/);
  const publish = workflow.jobs.publish;
  assert.deepEqual(publish.permissions, { contents: "write", "id-token": "write", attestations: "write" });
  const attest = step("publish", "Record build provenance for every download");
  assert.match(attest.uses, /^actions\/attest-build-provenance@[0-9a-f]{40}$/);
  for (const glob of ["zip", "tar.gz", "exe", "dmg", "deb", "AppImage"]) assert.ok(attest.with["subject-path"].includes(`Branch-Agent-*.${glob}`), glob);
  const steps = publish.steps.map((entry) => entry.name ?? "");
  assert.ok(steps.indexOf("Record build provenance for every download") < steps.indexOf("Publish the complete reviewed release"));
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"], "never on a pull request");
});
