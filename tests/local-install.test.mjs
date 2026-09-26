/**
 * mac7/one-click (issue #107): the one button that installs the program that runs the models.
 *
 * Every program, file system and network call here is a stand-in. Nothing is installed on this
 * computer, `brew`, `winget`, `ollama` and every installer are never called, no model is
 * downloaded, and no window is opened. The tests assert the exact commands that would have run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Store } from "../dist/store.js";
import { startPlan } from "../dist/local-launch.js";
import { ModelRouter } from "../dist/models.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { RuntimeLauncher } from "../dist/local-launch.js";
import { OneClick } from "../dist/local-oneclick.js";
import { saveLocalModelsMode, stages } from "../dist/local-jobs.js";
import { setLockdown } from "../dist/lockdown.js";
import { underShortLivedKey } from "../dist/key-context.js";
import {
  checksumFor, detectTools, fetchInstaller, installPlan, isInstallable, planFingerprint, planSize, runInstall,
} from "../dist/local-install.js";
import {
  installChatRefusal, installGuard, installLockdownRefusal, installOffRefusal, installShortLivedRefusal,
  installPersonRefusal, installTrunkRefusal, oneButtonMode, saveOneButtonMode, sizeChoices,
} from "../dist/local-one-button.js";
import { localModelsApi } from "../dist/local-models-api.js";

const GB = 1024 ** 3;
/** The owner in the app window, as the server hands it to the one button. */
const owner = { source: "owner", person: null, shortLivedKey: false };
const at = {
  darwin: { platform: "darwin", arch: "arm64", home: "/Users/sam", env: { PATH: "/usr/bin" } },
  linux: { platform: "linux", arch: "x64", home: "/home/sam", env: { PATH: "/usr/bin" } },
  win32: { platform: "win32", arch: "x64", home: "C:\\Users\\sam", env: { Path: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" } },
};
const DATA = "/Users/sam/Library/Application Support/Branch Agent/state";
const RUNNER = `${DATA}/runners/ollama`;
const noTools = { homebrew: null, winget: null };
const room = (over = {}) => ({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 20 * GB, graphicsLimitBytes: null, cores: 10,
  graphics: { name: "Apple M4", memoryBytes: null, sharedMemory: true }, summary: "", ...over });

async function scratch(label) {
  const base = join(tmpdir(), "branch-session-files");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `branch-${label}-`));
}

/* ------------------------------------------------------------------ the plan, on every system */

test("I1 every system unpacks the publisher's own archive inside Branch, with argument lists only", () => {
  const brewOllama = installPlan("ollama", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null }, DATA, true);
  assert.equal(brewOllama.via, "homebrew", "Homebrew only when the owner deliberately asks for it");
  assert.deepEqual(brewOllama.steps.map((step) => step.command), [["/opt/homebrew/bin/brew", "install", "ollama"]]);
  const brewStudio = installPlan("lm-studio", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null }, DATA);
  assert.deepEqual(brewStudio.steps.map((step) => step.command), [["/opt/homebrew/bin/brew", "install", "--cask", "lm-studio"]]);
  assert.match(brewStudio.after, /Open LM Studio once/);

  const winget = "C:\\Users\\sam\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
  const wingetOllama = installPlan("ollama", at.win32, { homebrew: null, winget }, DATA, true);
  assert.equal(wingetOllama.via, "winget");
  assert.deepEqual(wingetOllama.steps[0].command,
    [winget, "install", "--id", "Ollama.Ollama", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]);
  assert.equal(installPlan("lm-studio", at.win32, { homebrew: null, winget }, DATA).steps[0].command[3], "ElementLabs.LMStudio");

  const mac = installPlan("ollama", at.darwin, noTools, DATA);
  assert.equal(mac.via, "download");
  assert.equal(mac.where, RUNNER);
  assert.deepEqual(mac.steps.map((step) => step.command), [
    ["/usr/bin/ditto", "-x", "-k", "{file}", "{unpacked}"],
    ["/usr/bin/codesign", "--verify", "--strict", "--deep", "{unpacked}/Ollama.app"],
    ["/usr/sbin/spctl", "--assess", "--type", "execute", "{unpacked}/Ollama.app"],
    ["/usr/bin/ditto", "{unpacked}/Ollama.app", "{root}/Ollama.app"],
    ["/usr/bin/tmutil", "addexclusion", "{models}"],
  ], "it lands inside Branch, never in /Applications");
  const linux = installPlan("ollama", at.linux, noTools, DATA);
  assert.deepEqual(linux.steps.map((step) => step.command), [["tar", "--zstd", "-xf", "{file}", "-C", "{root}"]],
    "a plain archive, never an install script that needs a password");
  assert.deepEqual(installPlan("ollama", at.win32, noTools, DATA).steps.map((step) => step.command),
    [["C:\\Windows\\System32\\tar.exe", "-xf", "{file}", "-C", "{root}"]], "no publisher's installer runs");

  for (const plan of [brewOllama, brewStudio, wingetOllama, mac, linux]) {
    for (const step of plan.steps) {
      assert.ok(Array.isArray(step.command) && step.command.length > 0);
      for (const part of step.command) assert.doesNotMatch(part, /[|&;><`$\n]/, `${part} looks like a shell line`);
    }
    assert.ok(plan.verify.length > 20, "every plan says how the download is checked");
  }
  // mac7/clean-uninstall: the default leaves nothing behind; a system installer says plainly that it does.
  for (const plan of [mac, linux, installPlan("ollama", at.win32, noTools, DATA)]) {
    assert.equal(plan.leavesBehind, false);
    assert.ok(plan.where.replaceAll("\\", "/").startsWith(DATA), `${plan.where} is inside Branch`);
    assert.match(plan.after, /removed with Branch/);
  }
  for (const plan of [brewOllama, brewStudio, wingetOllama]) {
    assert.equal(plan.leavesBehind, true);
    assert.equal(plan.where, "");
    assert.match(plan.leavesBehindNote, /Removing Branch will not remove it/);
  }
});

test("I2 what Branch cannot install safely it refuses, in plain words, with where to get it", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const plan = installPlan("lm-studio", at[platform], noTools, DATA);
    assert.equal(plan.via, "none");
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.fetch, null);
    assert.match(plan.instead, /lmstudio\.ai/);
  }
  assert.equal(isInstallable("llama-cpp"), false, "llama.cpp and MLX are never installed by Branch");
  assert.equal(isInstallable("mlx"), false);
  assert.equal(isInstallable("ollama"), true);
});

test("I3 a yes only ever agrees to the plan that was shown", () => {
  const mac = installPlan("ollama", at.darwin, noTools, DATA);
  const linux = installPlan("ollama", at.linux, noTools, DATA);
  assert.match(mac.fingerprint, /^[a-f0-9]{32}$/);
  assert.notEqual(mac.fingerprint, linux.fingerprint);
  assert.equal(planFingerprint(mac), mac.fingerprint, "the line is the plan's own facts, nothing else");
  const meddled = { ...mac, steps: [{ what: "x", command: ["/bin/sh", "-c", "curl x | sh"] }] };
  assert.notEqual(planFingerprint(meddled), mac.fingerprint);
  assert.match(planSize(mac), /MB$/);
  assert.notEqual(planFingerprint({ ...mac, where: "/Applications" }), mac.fingerprint, "where it goes is part of the plan");
  assert.match(planSize(installPlan("ollama", at.linux, noTools, DATA)), /GB$/);

  // The size and the sentence about how it is checked are part of what the owner agreed to: change
  // either and the yes they gave no longer fits. Both were left out of the line at first.
  assert.notEqual(planFingerprint({ ...mac, approxBytes: mac.approxBytes * 10 }), mac.fingerprint);
  assert.notEqual(planFingerprint({ ...mac, verify: "Branch checks nothing at all." }), mac.fingerprint);
});

test("I3b the size and the address the owner reads are what really happens", () => {
  // Measured against the publishers on 2026-09-18, from the machines themselves:
  //   Ollama-darwin.zip is 197,183,181 bytes; the Linux and Windows x64 archives are about 1.4 GB.
  // (merge-queue: Branch now unpacks Ollama's own archive inside its folder rather than running the
  // publisher's installer, so these are the archives' sizes.) A size the owner agrees to has to be
  // the size that is really transferred.
  const linux = installPlan("ollama", at.linux, noTools, DATA);
  assert.ok(linux.approxBytes > 1024 ** 3,
    "the Linux plan counts the whole archive");
  assert.match(linux.source, /github\.com\/ollama\/ollama\/releases/, "and names where the program itself comes from");
  assert.match(planSize(linux), /GB$/);

  const win = installPlan("ollama", at.win32, noTools, DATA);
  assert.ok(win.approxBytes > 1024 ** 3 && win.approxBytes < 3 * 1024 ** 3, "the Windows archive is about 1.4 GB");
  const winget = installPlan("ollama", at.win32, { homebrew: null, winget: "C:\\w\\winget.exe" }, DATA, true);
  assert.equal(winget.approxBytes, win.approxBytes, "winget fetches the same program, so it is counted at the same size");

  const mac = installPlan("ollama", at.darwin, noTools, DATA);
  assert.ok(mac.approxBytes < 512 * 1024 ** 2, "Ollama-darwin.zip is about 190 MB, not 1.2 GB");

  // A size under a megabyte was rounded up to "about 1 MB"; small is allowed to look small.
  assert.equal(planSize({ approxBytes: 15902 }), "about 16 KB");
  assert.equal(planSize({ approxBytes: 0 }), "about 0 KB");
  assert.equal(planSize({ approxBytes: 30 * 1024 ** 2 }), "about 30 MB");
});

test("I4 Homebrew and winget are looked for only where they really live", async () => {
  const seen = [];
  const exists = async (path) => { seen.push(path); return path === "/opt/homebrew/bin/brew"; };
  assert.deepEqual(await detectTools(at.darwin, exists), { homebrew: "/opt/homebrew/bin/brew", winget: null });
  assert.deepEqual(seen, ["/opt/homebrew/bin/brew"]);
  assert.deepEqual(await detectTools(at.linux, async () => false), { homebrew: null, winget: null });
  const win = await detectTools(at.win32, async (path) => path.endsWith("winget.exe"));
  assert.equal(win.winget, "C:\\Users\\sam\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe");
  assert.equal(win.homebrew, null);
});

/* ------------------------------------------------------------------ the download and its check */

test("I5 the publisher's checksum decides: a file that does not match is thrown away", async (t) => {
  const root = await scratch("install");
  t.after(async () => { await discardTemp(root); });
  const body = Buffer.from("#!/bin/sh\necho hello\n");
  const good = createHash("sha256").update(body).digest("hex");
  const asset = "ollama-linux-amd64.tar.zst";
  const list = `${good}  ./${asset}\n0000000000000000000000000000000000000000000000000000000000000000  ./other.zip\n`;
  assert.equal(checksumFor(list, asset), good);
  assert.throws(() => checksumFor(list, "missing.zip"), /not in the list of checksums/);

  const plan = installPlan("ollama", at.linux, noTools, DATA);
  const asked = [];
  const library = async (url) => {
    asked.push(url);
    if (url.endsWith("sha256sum.txt")) return new Response(list);
    return new Response(body, { headers: { "content-length": String(body.length) } });
  };
  const deps = { at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false, library, scratchDir: join(root, "dl") };
  const file = await fetchInstaller(plan, deps);
  assert.ok(file.endsWith(asset));
  assert.ok(asked[0].endsWith("sha256sum.txt"), "the checksum is read before the file");

  const wrong = async (url) => url.endsWith("sha256sum.txt")
    ? new Response(`${"a".repeat(64)}  ./${asset}\n`) : new Response(body);
  await assert.rejects(fetchInstaller(plan, { ...deps, library: wrong, scratchDir: join(root, "bad") }),
    /did not match the checksum its publisher published/);
  assert.deepEqual(await readdir(join(root, "bad")), [], "nothing is left behind when it does not match");
});

test("I6 nothing is ever fetched from anywhere but the publisher", async (t) => {
  const root = await scratch("install-host");
  t.after(async () => { await discardTemp(root); });
  const plan = installPlan("ollama", at.linux, noTools, DATA);
  const elsewhere = { ...plan, fetch: { ...plan.fetch, checksums: "https://example.invalid/sha256sum.txt" } };
  await assert.rejects(fetchInstaller(elsewhere, {
    at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false,
    library: async () => { throw new Error("a test must never reach the internet"); }, scratchDir: join(root, "dl"),
  }), /only ever downloaded from its own publisher/);

  const redirected = async (url) => url.endsWith("sha256sum.txt")
    ? new Response(null, { status: 302, headers: { location: "http://ollama.com/plain" } }) : new Response("x");
  await assert.rejects(fetchInstaller(plan, {
    at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false, library: redirected, scratchDir: join(root, "dl2"),
  }), /only ever downloaded from its own publisher/, "a redirect off https is refused too");
});

test("I6b a real release redirect is followed: GitHub's signed asset address is ~900 characters", async (t) => {
  // Found on a real Ubuntu box: github.com sends a release download on to
  // release-assets.githubusercontent.com with a signed address about 900 characters long. A cap of
  // 400 refused it, so the whole download path — Linux, and a Mac or Windows with no package
  // manager — could never install anything. The cap stays, because an address is still bounded
  // input; it is just no longer shorter than the publisher's own.
  const root = await scratch("install-redirect");
  t.after(async () => { await discardTemp(root); });
  const body = Buffer.from("#!/bin/sh\nexit 0\n");
  const sum = createHash("sha256").update(body).digest("hex");
  const signed = (name) =>
    `https://release-assets.githubusercontent.com/github-production-release-asset/658928958/${"a".repeat(40)}`
    + `?sp=r&sv=2018-11-09&sr=b&rscd=attachment%3B+filename%3D${name}&sig=${"b".repeat(60)}&jwt=${"c".repeat(600)}`;
  assert.ok(signed("ollama-linux-amd64.tar.zst").length > 700, "the stand-in is as long as the real thing");
  const library = async (url) => {
    if (url.startsWith("https://github.com/"))
      return new Response(null, { status: 302, headers: { location: signed(url.split("/").pop()) } });
    return new Response(url.includes("sha256sum.txt") ? `${sum}  ./ollama-linux-amd64.tar.zst\n` : body);
  };
  const plan = installPlan("ollama", at.linux, noTools, DATA);
  const file = await fetchInstaller(plan, {
    at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false, library, scratchDir: join(root, "dl"),
  });
  assert.ok(file.endsWith("ollama-linux-amd64.tar.zst"));

  // Still bounded, and still only the publisher's own hosts.
  const tooLong = async () => new Response(null, { status: 302, headers: { location: signed("x") + "d".repeat(4000) } });
  await assert.rejects(fetchInstaller(plan, {
    at: at.linux, run: async () => ({ stdout: "" }), exists: async () => false, library: tooLong, scratchDir: join(root, "dl2"),
  }), /only ever downloaded from its own publisher/);
});

test("I6c on Linux the service Ollama's own installer started is waited for, not handed back", async () => {
  // Found on a real Ubuntu box: install.sh installs Ollama as a systemd service and starts it, but
  // it is not answering the instant the script returns. Branch asked once, got no answer, and gave
  // up with "start it yourself" — for a service that was already running. The one-click could never
  // finish on Linux. A service that is up is not something to start; a stopped one still is.
  const running = startPlan("ollama", "/usr/local/bin/ollama", {}, at.linux, "active");
  assert.equal(running.instead, null, "a running service is not handed back to the owner");
  assert.deepEqual(running.commands, []);
  assert.equal(running.serve, null, "and Branch does not start a second copy beside it");

  const stopped = startPlan("ollama", "/usr/local/bin/ollama", {}, at.linux, "known");
  assert.match(stopped.instead, /system service/, "a stopped service still needs the owner's password");
  assert.deepEqual(startPlan("ollama", "/usr/local/bin/ollama", {}, at.linux, "none").serve,
    ["/usr/local/bin/ollama", "serve"], "with no service at all Branch runs it itself");
});

test("I7 a step that fails stops the rest and is reported honestly", async (t) => {
  const root = await scratch("install-run");
  t.after(async () => { await discardTemp(root); });
  const plan = installPlan("ollama", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null }, DATA, true);
  const ran = [];
  const ok = await runInstall(plan, {
    at: at.darwin, exists: async () => true, library: async () => { throw new Error("no internet"); }, scratchDir: join(root, "x"),
    run: async (file, args) => { ran.push([file, ...args]); return { stdout: "" }; },
  });
  assert.deepEqual(ran, [["/opt/homebrew/bin/brew", "install", "ollama"]]);
  assert.equal(ok.installed, true);

  const failed = await runInstall(plan, {
    at: at.darwin, exists: async () => true, library: async () => { throw new Error("no internet"); }, scratchDir: join(root, "x"),
    run: async () => { throw Object.assign(new Error("exit 1"), { stderr: "No such keg" }); },
  });
  assert.equal(failed.installed, false);
  assert.match(failed.message, /could not install Ollama/);
  assert.match(failed.message, /No such keg/);

  // winget says why on its ordinary output, not on the error one, so on a real Windows box the
  // owner was told only that the step "did not work" and nothing at all about why.
  const quiet = await runInstall(plan, {
    at: at.darwin, exists: async () => true, library: async () => { throw new Error("no internet"); }, scratchDir: join(root, "y"),
    run: async () => { throw Object.assign(new Error("exit 1"), { stdout: "No applicable upgrade found", stderr: "" }); },
  });
  assert.match(quiet.message, /No applicable upgrade found/);
  assert.match(failed.message, /Nothing was left half-installed/, "Homebrew tidies up after itself");

  const refused = await runInstall(installPlan("lm-studio", at.linux, noTools, DATA), {
    at: at.linux, exists: async () => true, library: async () => { throw new Error("no"); }, scratchDir: join(root, "x"),
    run: async () => { throw new Error("a refused plan must run nothing"); },
  });
  assert.equal(refused.installed, false);
  assert.deepEqual(refused.ran, []);
});

/* ------------------------------------------------------------------ the switch and who may press */

async function world(t, { mode = "when-needed", install = "when-needed", programs = [], library } = {}) {
  const root = await scratch("button");
  const store = new Store(join(root, "branch.sqlite"));
  if (mode) saveLocalModelsMode(store, "owner", { mode });
  if (install) saveOneButtonMode(store, "owner", { mode: install });
  const here = [...programs];
  const ran = [];
  const launcher = new RuntimeLauncher({
    at: at.darwin,
    exists: async (path) => here.some((name) => path.endsWith(name)),
    run: async (file, args) => { ran.push([file, ...args]); return { stdout: "" }; },
    spawn: () => ({ pid: 1, stop: () => {} }),
    freePort: async () => 48081,
  });
  const models = new ModelRouter(store, [{ id: "demo", name: "Demo", provider: { name: "demo", complete: async () => ({ content: "", toolCalls: [] }) }, model: "demo" }]);
  const deps = {
    store, owner: "owner", models, policy: new NetworkPolicy({}), dataDir: join(root, "data"), launcher,
    fetch: async () => { throw new TypeError("fetch failed"); },
    library: library ?? (async () => { throw new Error("no internet in tests"); }),
    room: async () => room(), statfs: async () => ({ bavail: 200, bsize: GB }), sleep: async () => {},
  };
  const oneClick = new OneClick(deps);
  // One hook, in the order Node runs them: stop the setups and let them write their last line, then
  // close the database, then remove the folder. Closing first would fail on Windows every time.
  t.after(async () => {
    oneClick.closeAll();
    for (let tries = 0; tries < 300 && oneClick.jobs.unfinished().length; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    store.close();
    await discardTemp(root);
  });
  return { store, root, here, ran, oneClick };
}

test("I7b a download that cannot happen is said in plain words, with nothing left behind", async (t) => {
  // On a real Ubuntu box with no network the owner was told "fetch failed", and with the publisher
  // unreachable, nothing more. A step that fails has always said what it was and what to do next;
  // the download in front of the steps said whatever the network happened to throw.
  const root = await scratch("install-offline");
  t.after(async () => { await discardTemp(root); });
  const plan = installPlan("ollama", at.linux, noTools, DATA);
  const ran = [];
  const outcome = await runInstall(plan, {
    at: at.linux, exists: async () => false, scratchDir: join(root, "dl"),
    library: async () => { throw new TypeError("fetch failed"); },
    run: async (file, args) => { ran.push([file, ...args]); return { stdout: "" }; },
  });
  assert.equal(outcome.installed, false);
  assert.deepEqual(ran, [], "nothing is run when the download never happened");
  assert.match(outcome.message, /could not download Ollama/);
  assert.match(outcome.message, /fetch failed/, "and what really went wrong is still in there");
  assert.match(outcome.message, /Nothing was left half-installed/);
  assert.match(outcome.message, /ollama\.com/, "and where to install it by hand");
  assert.deepEqual(await readdir(join(root, "dl")).catch(() => []), [], "and no half a file on the disk");

  // A file that arrives but is not the publisher's keeps its own sentence: it is a different thing.
  const body = Buffer.from("not the real installer");
  const wrong = async (url) => new Response(url.endsWith("sha256sum.txt") ? `${"a".repeat(64)}  ./ollama-linux-amd64.tar.zst\n` : body);
  const refused = await runInstall(plan, {
    at: at.linux, exists: async () => false, scratchDir: join(root, "dl2"), library: wrong,
    run: async () => { throw new Error("a refused download must run nothing"); },
  });
  assert.match(refused.message, /did not match the checksum its publisher published/);
});

test("I7c when unpacking inside Branch fails, what was unpacked is cleared and nothing outside was touched", async (t) => {
  // merge-queue: mac7/one-click-real ran Ollama's Linux install script, which could leave part of
  // itself in /usr/local. Since mac7/clean-uninstall Branch unpacks Ollama's own archive into its own
  // folder instead, and clears that folder when a step fails, so this promise is one it can keep.
  const root = await scratch("install-partial");
  t.after(async () => { await discardTemp(root); });
  const body = Buffer.from("not really an archive");
  const sum = createHash("sha256").update(body).digest("hex");
  const library = async (url) => new Response(url.includes("sha256sum.txt") ? `${sum}  ./ollama-linux-amd64.tar.zst\n` : body);
  const plan = installPlan("ollama", at.linux, noTools, join(root, "data"));
  const outcome = await runInstall(plan, {
    at: at.linux, exists: async () => false, library, scratchDir: join(root, "dl"), dataDir: join(root, "data"),
    run: async () => { throw Object.assign(new Error("exit 1"), { stderr: "tar: this does not look like a tar archive" }); },
  });
  assert.equal(outcome.installed, false);
  assert.match(outcome.message, /does not look like a tar archive/, "what it said is still there");
  assert.match(outcome.message, /cleared away again, and nothing outside Branch was touched/);
  assert.equal(existsSync(plan.where), false, "the half-unpacked folder inside Branch is gone");

  // Homebrew and winget clean up after themselves, so there the promise holds too.
  const brew = await runInstall(installPlan("ollama", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null }, DATA, true), {
    at: at.darwin, exists: async () => false, library: async () => { throw new Error("no download here"); },
    scratchDir: join(root, "x"), run: async () => { throw Object.assign(new Error("exit 1"), { stderr: "No such keg" }); },
  });
  assert.match(brew.message, /Nothing was left half-installed/);
});

test("I8 the switch ships off, and Lockdown holds it off whatever is saved", async (t) => {
  const w = await world(t, { install: null });
  assert.equal(oneButtonMode(w.store, "owner"), "off");
  assert.equal(installGuard(w.store, "owner", {}), installOffRefusal);
  saveOneButtonMode(w.store, "owner", { mode: "when-needed" });
  assert.equal(installGuard(w.store, "owner", {}), null);
  setLockdown(w.store, "owner", { on: true });
  assert.equal(oneButtonMode(w.store, "owner"), "off");
  assert.equal(installGuard(w.store, "owner", {}), installLockdownRefusal);
  setLockdown(w.store, "owner", { on: false });
  assert.equal(installGuard(w.store, "owner", {}), null);
});

test("I9 it is the owner's alone: a chat, a key, another computer, a Trunk and a schedule are refused", async (t) => {
  const w = await world(t);
  assert.equal(installGuard(w.store, "owner", { source: "channel" }), installChatRefusal);
  assert.equal(installGuard(w.store, "owner", { trunkKeys: {} }), installTrunkRefusal);
  assert.match(installGuard(w.store, "owner", { source: "schedule" }), /Only work you started yourself/);
  assert.equal(underShortLivedKey(() => installGuard(w.store, "owner", {})), installShortLivedRefusal);
  assert.equal(installGuard(w.store, "owner", {}, "person-7"), "Installing a program on this computer belongs to the owner. Switch back to the owner's profile to do it.");
  assert.equal(installGuard(w.store, "owner", {}), null, "the owner in the app window may");
});

test("I9b the guard itself refuses every caller but the owner, from what the caller hands in", async (t) => {
  // Called directly, with no request marks at all: these would fail if only the server blocked them.
  const w = await world(t);
  const callers = {
    "a household profile": [{ ...owner, person: "profile-kid" }, installPersonRefusal],
    "a short-lived key": [{ ...owner, shortLivedKey: true }, installShortLivedRefusal],
    "a chat app": [{ source: "channel" }, installChatRefusal],
    "a Trunk": [{ source: "owner", trunkKeys: { id: "trunk-1" } }, installTrunkRefusal],
  };
  assert.equal(installGuard(w.store, "owner", owner), null, "the owner may");
  for (const [who, [context, refusal]] of Object.entries(callers))
    assert.equal(installGuard(w.store, "owner", context), refusal, who);
  setLockdown(w.store, "owner", { on: true });
  for (const context of [owner, ...Object.values(callers).map(([one]) => one)])
    assert.equal(installGuard(w.store, "owner", context), installLockdownRefusal, "Lockdown refuses everyone, the owner too");
});

test("I9c both routes hand the caller to the guard and refuse in the same words", async (t) => {
  const w = await world(t, { programs: [] });
  const call = (caller, path, body = {}) => localModelsApi(
    { runtimes: {}, store: w.store, models: null, owner: "owner", kit: { oneClick: w.oneClick }, caller },
    "POST", path, async () => body);
  const callers = [
    [{ ...owner, person: "profile-kid" }, installPersonRefusal],
    [{ ...owner, shortLivedKey: true }, installShortLivedRefusal],
    [{ source: "channel" }, installChatRefusal],
    [{ source: "owner", trunkKeys: { id: "trunk-1" } }, installTrunkRefusal],
  ];
  for (const [caller, refusal] of callers) {
    assert.equal((await call(caller, "/api/local-models/one-button/plan")).refusal, refusal);
    await assert.rejects(call(caller, "/api/local-models/one-button", { size: "small" }), { message: refusal });
  }
  assert.equal((await call(owner, "/api/local-models/one-button/plan")).refusal, null, "the owner is not refused");
  setLockdown(w.store, "owner", { on: true });
  for (const caller of [owner, ...callers.map(([one]) => one)]) {
    assert.equal((await call(caller, "/api/local-models/one-button/plan")).refusal, installLockdownRefusal);
    await assert.rejects(call(caller, "/api/local-models/one-button", { size: "small" }), { message: installLockdownRefusal });
  }
  assert.deepEqual(w.ran, [], "nothing was ever run");
});

test("I10 three sizes are offered, all able to use tools, with plain words and a suggestion", () => {
  const roomy = sizeChoices(room({ freeMemoryBytes: 40 * GB, totalMemoryBytes: 64 * GB }), "ollama");
  assert.equal(roomy.choices.length, 3);
  assert.deepEqual(roomy.choices.map((one) => one.size), ["small", "medium", "large"]);
  for (const choice of roomy.choices) {
    assert.equal(choice.tools, true, "a model that cannot use tools can only talk, so it is not offered");
    assert.ok(choice.guidance.length > 40, "each size says what it means here");
    assert.ok(choice.downloadBytes > 0);
  }
  const sorted = roomy.choices.map((one) => one.downloadBytes);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b), "small to large");
  assert.equal(roomy.recommended.fit, "well", "the suggestion is one that fits comfortably");
  const tiny = sizeChoices(room({ freeMemoryBytes: 2 * GB, totalMemoryBytes: 4 * GB }), "ollama");
  assert.ok(tiny.choices.length >= 1);
  assert.ok(tiny.recommended, "a small computer is still offered the smallest one");
});

/* ------------------------------------------------------------------ the button itself */

test("I11 the button installs nothing until the owner agrees to the exact plan it showed", async (t) => {
  const w = await world(t);
  const view = await w.oneClick.buttonPlan({}, owner);
  assert.equal(view.runner, "ollama");
  assert.equal(view.alreadyInstalled, false);
  assert.equal(view.install.via, "download", "no Homebrew in this stand-in world");
  assert.equal(view.refusal, null);
  assert.equal(view.choices.length, 3);

  const asked = await w.oneClick.buttonGo({ size: "small" }, owner);
  assert.equal(asked.needsAgreement.fingerprint, view.install.fingerprint);
  assert.match(asked.message, /press the button again/);
  assert.deepEqual(w.ran, [], "nothing at all was run");

  const stale = await w.oneClick.buttonGo({ size: "small", agreedPlan: "0".repeat(32) }, owner);
  assert.match(stale.message, /has changed since you looked/);
  assert.deepEqual(w.ran, []);
});

test("I12 after installing, Branch checks the program really arrived rather than claiming success", async (t) => {
  const body = Buffer.from("#!/bin/sh\ntrue\n");
  const sum = createHash("sha256").update(body).digest("hex");
  // A stand-in publisher: the checksum matches, and the "installer" does nothing at all.
  const library = async (url) => String(url).endsWith("sha256sum.txt")
    ? new Response(`${sum}  ./Ollama-darwin.zip\n`)
    : new Response(body, { headers: { "content-length": String(body.length) } });
  const w = await world(t, { programs: [], library });
  const view = await w.oneClick.buttonPlan({}, owner);
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan: view.install.fingerprint }, owner),
    /still is not on this computer/, "a half-install is never called a success");
  // The plan is a Mac's, so it is written with a Mac's "/" whatever computer runs this test.
  const data = join(w.root, "data");
  const scratch = posix.join(data, "local-installers");
  const runner = posix.join(data, "runners", "ollama");
  const models = posix.join(data, "models", "ollama");
  assert.deepEqual(w.ran, [
    ["/usr/bin/ditto", "-x", "-k", posix.join(scratch, "Ollama-darwin.zip"), posix.join(scratch, "unpacked")],
    ["/usr/bin/codesign", "--verify", "--strict", "--deep", `${posix.join(scratch, "unpacked")}/Ollama.app`],
    ["/usr/sbin/spctl", "--assess", "--type", "execute", `${posix.join(scratch, "unpacked")}/Ollama.app`],
    ["/usr/bin/ditto", `${posix.join(scratch, "unpacked")}/Ollama.app`, `${runner}/Ollama.app`],
    ["/usr/bin/tmutil", "addexclusion", models],
  ], "the exact commands, filled in under Branch's own folder and nowhere else");
  for (const command of w.ran) for (const part of command) assert.doesNotMatch(part, /[{}]/, "nothing is left unfilled");
  // mac7/clean-uninstall: the one place it may write is inside Branch.
  for (const command of w.ran) for (const part of command.slice(1))
    if (part.startsWith("/")) assert.ok(part.startsWith(w.root), `${part} is outside Branch's own folders`);
});

test("I15 the owner's yes to the plan counts for that one install only: the engine holds it, and nothing is left on", async (t) => {
  const body = Buffer.from("#!/bin/sh\ntrue\n");
  const sum = createHash("sha256").update(body).digest("hex");
  // The same stand-in publisher as I12: the checksum matches, and the "installer" installs nothing.
  const library = async (url) => String(url).endsWith("sha256sum.txt")
    ? new Response(`${sum}  ./Ollama-darwin.zip\n`)
    : new Response(body, { headers: { "content-length": String(body.length) } });
  const w = await world(t, { install: null, programs: [], library });
  const view = await w.oneClick.buttonPlan({}, owner);
  assert.equal(view.refusal, installOffRefusal, "installing ships off");
  const agreedPlan = view.install.fingerprint;
  // The switch alone still refuses, and `once` sets aside the off switch and nothing else.
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan }, owner), { message: installOffRefusal });
  await assert.rejects(w.oneClick.buttonGo({ size: "small", once: true }, owner), { message: installOffRefusal }, "only with the plan agreed to");
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan, once: true }, { ...owner, person: "profile-kid" }), { message: installPersonRefusal });
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan, once: true }, { ...owner, shortLivedKey: true }), { message: installShortLivedRefusal });
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan, once: true }, { source: "channel" }), { message: installChatRefusal });
  setLockdown(w.store, "owner", { on: true });
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan, once: true }, owner), { message: installLockdownRefusal });
  setLockdown(w.store, "owner", { on: false });
  assert.deepEqual(w.ran, [], "nothing was run for any of them");

  // The owner's own yes: exactly that plan is carried out, with installing still off before, during and after.
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan, once: true }, owner), /still is not on this computer/);
  assert.ok(w.ran.some((command) => command[0] === "/usr/bin/ditto"), "the agreed plan was carried out");
  assert.equal(oneButtonMode(w.store, "owner"), "off");
  assert.equal(w.store.get("settings", "owner", "local-runner-install"), undefined, "nothing was saved, so a restart finds nothing on");
  const ran = w.ran.length;
  await assert.rejects(w.oneClick.buttonGo({ size: "small", agreedPlan }, owner), { message: installOffRefusal }, "the yes was for that one install");
  assert.equal(w.ran.length, ran);
});

test("I12b a program macOS does not accept is never unpacked into Branch", async (t) => {
  const body = Buffer.from("not really a program");
  const sum = createHash("sha256").update(body).digest("hex");
  const library = async (url) => String(url).endsWith("sha256sum.txt")
    ? new Response(`${sum}  ./Ollama-darwin.zip\n`)
    : new Response(body, { headers: { "content-length": String(body.length) } });
  const root = await scratch("install-signature");
  t.after(async () => { await discardTemp(root); });
  const ran = [];
  const outcome = await runInstall(installPlan("ollama", at.darwin, noTools, join(root, "data")), {
    at: at.darwin, exists: async () => false, library, scratchDir: join(root, "dl"), dataDir: join(root, "data"),
    run: async (file, args) => {
      ran.push([file, ...args]);
      if (file === "/usr/sbin/spctl") throw Object.assign(new Error("exit 3"), { stderr: "rejected: source=no usable signature" });
      return { stdout: "" };
    },
  });
  assert.equal(outcome.installed, false);
  assert.match(outcome.message, /Check the signature|Check macOS accepts it/, "the message names the step that stopped it");
  assert.match(outcome.message, /no usable signature/);
  assert.equal(ran.length, 3, "it stopped at the check");
  assert.equal(ran.some((command) => command.some((part) => part.endsWith("/runners/ollama/Ollama.app"))), false,
    "nothing an unsigned download unpacked is ever put in place");
  assert.equal(ran.some((command) => command.includes("/Applications/Ollama.app")), false,
    "and nothing ever reaches Applications");
});

test("I13 with the program already there the button goes straight to the model, and says so", async (t) => {
  const w = await world(t, { programs: ["/opt/homebrew/bin/ollama"] });
  const view = await w.oneClick.buttonPlan({}, owner);
  assert.equal(view.alreadyInstalled, true);
  assert.equal(view.install, null, "nothing would be installed, so nothing is proposed");
  const answer = await w.oneClick.buttonGo({ size: "small" }, owner);
  assert.equal(answer.runner, "ollama");
  assert.ok(answer.chose, "it chose a size");
  assert.match(answer.message, /Setting up/);
  assert.deepEqual(w.ran, [], "nothing was installed: the program was already there");
});

test("I13b the size on the screen is the one sentence the server worked out", async (t) => {
  // The page did its own `${bytes / 1024 ** 3} GB`, so a 30 MB Homebrew install read "about 0.0 GB
  // to download" and a 190 MB one read "0.2 GB". The sentence the server already writes is the one
  // shown, and it picks the unit that fits.
  const w = await world(t, { programs: [] });
  const view = await w.oneClick.buttonPlan({}, owner);
  assert.ok(view.install, "a Mac with no Homebrew is offered the download");
  assert.equal(view.downloadNote, `${planSize(view.install)} from ${view.install.source}.`);
  assert.match(view.downloadNote, /^about 190 MB from https:\/\/github\.com\//);
  assert.doesNotMatch(view.downloadNote, /0\.[0-2] GB/);
  assert.equal(planSize({ approxBytes: 30 * 1024 ** 2 }), "about 30 MB", "and Homebrew's is not 0.0 GB either");
});

test("I14 a short-lived key can neither flip the switch nor press the button", async () => {
  const { offLimitsToShortLivedKeys } = await import("../dist/server.js");
  assert.ok(stages.includes("installing"), "a setup can say it is installing the program");
  for (const path of ["/api/local-models/install/switch", "/api/local-models/one-button", "/api/local-models/one-button/plan"])
    assert.match(offLimitsToShortLivedKeys("POST", path), /short-lived key cannot/, path);
  assert.match(offLimitsToShortLivedKeys("POST", "/api/local-models/setup"), /short-lived key cannot/, "the older routes still are");
});
