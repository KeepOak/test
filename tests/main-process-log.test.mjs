// The desktop app's main process writes into the engine's activity log (src/desktop/main-log.ts): with the engine
// down, beside a running engine in another process, and for every step an update takes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiagnosticLog, DiagnosticLogSettingsSchema, diagnose, markedLogSettings, setDiagnosticLog, writeLogSettingsMark,
} from "../dist/diagnostic-log.js";
import { mainLogSettings, openMainLog } from "../dist/desktop/main-log.js";
import { Updater, UpdateDeferredError, UpdateStuckError, beforeInstall } from "../dist/desktop/updater.js";

const dataFolder = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-main-log-"));
  t.after(() => { setDiagnosticLog(null); return rm(dir, { recursive: true, force: true }); });
  return dir;
};
const lines = async (dataDir) => {
  const dir = join(dataDir, "logs");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((name) => /^branch(\.\d+)?\.jsonl$/.test(name));
  const texts = await Promise.all(files.map((name) => readFile(join(dir, name), "utf8")));
  return texts.flatMap((text) => text.split("\n").filter(Boolean)).map((text) => JSON.parse(text));
};
const mark = (dataDir, settings) => writeLogSettingsMark(dataDir, DiagnosticLogSettingsSchema.parse(settings));

test("a main-process diagnose call lands in branch.jsonl with no engine running", async (t) => {
  const dataDir = await dataFolder(t);
  // Before this, only the engine set a log up, so this call did nothing at all in main.
  diagnose("updater", "info", "nobody hears this");
  assert.deepEqual(await lines(dataDir), []);
  // The owner's saved setting is the shipped "when needed"; main still writes its update steps (info and up).
  mark(dataDir, { mode: "when-needed", keepDays: 7 });
  openMainLog(dataDir);
  diagnose("updater", "info", "Update step: downloading", { fields: { version: "0.3.0" } });
  const [line] = await lines(dataDir);
  assert.equal(line.component, "updater");
  assert.equal(line.message, "Update step: downloading");
  assert.equal(line.pid, process.pid);
  assert.equal(line.fields.version, "0.3.0");
});

test("main follows the owner's switch and size cap from the file the engine writes, and the shipped ones without it", async (t) => {
  const dataDir = await dataFolder(t);
  assert.deepEqual(markedLogSettings(dataDir), DiagnosticLogSettingsSchema.parse({}), "no file yet: the shipped settings");
  assert.equal(mainLogSettings(dataDir).mode, "on", "shipped: main writes from info up");
  mark(dataDir, { mode: "off", maxMegabytes: 3 });
  assert.equal(mainLogSettings(dataDir).mode, "off");
  assert.equal(mainLogSettings(dataDir).maxMegabytes, 3, "the same cap as the engine, so both rotate at the same size");
  openMainLog(dataDir);
  diagnose("updater", "error", "the owner turned the log off");
  assert.deepEqual(await lines(dataDir), [], "off means off, in main too");
  // A file from before it carried the mode holds only the crash switch; a damaged one keeps crash capture off.
  writeFileSync(join(dataDir, "logs", "crash-capture.json"), JSON.stringify({ crashCapture: "on" }));
  assert.equal(mainLogSettings(dataDir).mode, "on");
  writeFileSync(join(dataDir, "logs", "crash-capture.json"), "{not json");
  assert.equal(markedLogSettings(dataDir).crashCapture, "off");
});

test("the engine in another process and main write the same file at once: every line whole, none lost, across a rotation", async (t) => {
  const dataDir = await dataFolder(t);
  mark(dataDir, { mode: "when-needed", maxMegabytes: 1 }); // 1 MB over five files: a rotation every ~200 KB
  const each = 400, padding = "x".repeat(300);
  const module = new URL("../dist/diagnostic-log.js", import.meta.url).href;
  // The engine: its own process, its own log object on the same folder, the owner's settings with everything on.
  const engine = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DiagnosticLog, DiagnosticLogSettingsSchema } from ${JSON.stringify(module)};
    const log = new DiagnosticLog({ dir: ${JSON.stringify(join(dataDir, "logs"))},
      settings: () => DiagnosticLogSettingsSchema.parse({ mode: "on", maxMegabytes: 1 }) });
    process.stdin.once("data", () => {
      for (let n = 0; n < ${each}; n++) log.write({ level: "info", component: "engine", message: "engine " + n, fields: { padding: ${JSON.stringify(padding)} } });
      process.exit(0);
    });
    process.stdout.write("ready");
  `], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((resolve) => engine.stdout.once("data", resolve));
  const ended = new Promise((resolve) => engine.once("exit", resolve));
  openMainLog(dataDir);
  engine.stdin.write("go");
  for (let n = 0; n < each; n++) diagnose("updater", "info", `main ${n}`, { fields: { padding } });
  assert.equal(await ended, 0);
  const all = await lines(dataDir); // JSON.parse throws on any line torn or mixed with another
  const files = (await readdir(join(dataDir, "logs"))).filter((name) => name.startsWith("branch"));
  assert.ok(files.length > 1, `the file rotated while both wrote: ${files.join(", ")}`);
  for (const [component, pid] of [["engine", engine.pid], ["updater", process.pid]]) {
    const mine = all.filter((line) => line.component === component);
    assert.equal(mine.length, each, `${component}: every line kept`);
    assert.ok(mine.every((line) => line.pid === pid));
    assert.equal(new Set(mine.map((line) => line.message)).size, each);
  }
});

test("a rotation the other writer already made, or cannot finish, still writes the line", async (t) => {
  const dataDir = await dataFolder(t);
  const dir = join(dataDir, "logs");
  const log = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ mode: "on", maxMegabytes: 1 }) });
  const big = "y".repeat(1500);
  // A full file and a gap in the rotated copies (.1 moved away by the other writer a moment ago).
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "branch.jsonl"), `${JSON.stringify({ message: "old", big: "z".repeat(210_000) })}\n`);
  await writeFile(join(dir, "branch.2.jsonl"), `${JSON.stringify({ message: "older" })}\n`);
  log.write({ level: "info", component: "updater", message: "after a rotation with a gap", fields: { big } });
  assert.equal(log.read({ limit: 1 })[0].message, "after a rotation with a gap");
  assert.ok(existsSync(join(dir, "branch.1.jsonl")) && existsSync(join(dir, "branch.3.jsonl")));
  // The oldest copy's place taken by a folder: that move fails, and the line is written anyway.
  await mkdir(join(dir, "branch.4.jsonl", "blocked"), { recursive: true });
  await writeFile(join(dir, "branch.jsonl"), `${JSON.stringify({ message: "full", big: "z".repeat(210_000) })}\n`);
  log.write({ level: "info", component: "updater", message: "written though a move failed" });
  assert.equal(log.read({ limit: 1 })[0].message, "written though a move failed");
});

/** A Stable release served without the network: the lookup, the download and its checksum. */
function stableRelease() {
  const bytes = Buffer.from("0.3.0");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const release = { tag_name: "v0.3.0", name: "v0.3.0", body: "", published_at: "2026-09-23T00:00:00Z", draft: false, prerelease: false,
    html_url: "https://github.com/KeepOak/Branch-Agent/releases/tag/v0.3.0", assets: [
      { name: "Branch-Agent-windows-x64.zip", browser_download_url: "https://github.com/KeepOak/Branch-Agent/releases/download/v0.3.0/app.zip", size: bytes.length },
      { name: "Branch-Agent-windows-x64.zip.sha256", browser_download_url: "https://github.com/KeepOak/Branch-Agent/releases/download/v0.3.0/app.zip.sha256", size: 96 },
    ] };
  return async (url) => {
    const text = String(url);
    if (text.endsWith("/releases/latest")) return Response.json(release);
    if (text.endsWith("/app.zip")) return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    if (text.endsWith("/app.zip.sha256")) return new Response(`${digest}  Branch-Agent-windows-x64.zip\n`);
    return new Response("not found", { status: 404 });
  };
}
const extract = async (archive, into) => {
  const app = join(into, "Branch Agent");
  await mkdir(join(app, "resources", "app"), { recursive: true });
  await writeFile(join(app, "Branch Agent.exe"), "the new app");
  await writeFile(join(app, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: await readFile(archive, "utf8") }));
};

test("every updater step leaves a line with the engine down, and a deferral leaves its reason", async (t) => {
  const dataDir = await dataFolder(t);
  const installDir = join(dataDir, "installed");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "Branch Agent.exe"), "the installed app");
  openMainLog(dataDir);
  const reason = "An update is ready, but Branch will wait until every task finishes or is answered.";
  const updater = new Updater({ repo: "KeepOak/Branch-Agent", currentVersion: "0.2.0", channel: "stable", platform: "win32", installDir,
    executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(dataDir, "scratch"),
    fetch: stableRelease(), extract, backup: async () => {}, canary: async () => {},
    beforeStop: async () => { throw new UpdateDeferredError(reason); } });
  await updater.check();
  await assert.rejects(updater.install({ automatic: true }), /wait until every task/);
  const said = (await lines(dataDir)).filter((line) => line.component === "updater").map((line) => line.message);
  for (const step of [/^Looked for an update: Version 0\.3\.0 is ready/, /^An update started$/, /^Update step: downloading$/, /^Update step: checking$/,
    /^Trying the new version on a copy/, /^The new version passed its check/, /^Update step: copying$/, /^The safety copy was made$/])
    assert.ok(said.some((message) => step.test(message)), `${step} in:\n${said.join("\n")}`);
  assert.ok(said.includes(`The update waits: ${reason}`), "the reason an update did not go in is kept");

  // Before the updater takes over (the channel, idle work): a wait, a stuck wait and a failure each leave their reason.
  await assert.rejects(beforeInstall(async () => { throw new UpdateDeferredError("The update channel was just changed."); }));
  await assert.rejects(beforeInstall(async () => { throw new UpdateStuckError("The background engine would not close."); }));
  await assert.rejects(beforeInstall(async () => { throw new Error("Branch cannot read its update channel."); }));
  const after = (await lines(dataDir)).filter((line) => line.component === "updater");
  assert.ok(after.some((line) => line.level === "info" && line.message === "The update waits: The update channel was just changed."));
  assert.ok(after.some((line) => line.level === "warn" && line.message === "The update waits: The background engine would not close."));
  assert.ok(after.some((line) => line.level === "error" && line.message === "The update could not start: Branch cannot read its update channel."));
});

test("stopping the background engine and a failed update each leave a line", async (t) => {
  const dataDir = await dataFolder(t);
  const installDir = join(dataDir, "installed");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "Branch Agent.exe"), "the installed app");
  openMainLog(dataDir);
  const updater = new Updater({ repo: "KeepOak/Branch-Agent", currentVersion: "0.2.0", channel: "stable", platform: "win32", installDir,
    executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(dataDir, "scratch"),
    fetch: stableRelease(), extract, backup: async () => {}, canary: async () => {},
    stopDaemon: async () => { throw new UpdateStuckError("The background engine did not close in time, so nothing was changed."); } });
  await assert.rejects(updater.install(), /did not close in time/);
  const said = (await lines(dataDir)).filter((line) => line.component === "updater");
  assert.ok(said.some((line) => line.message === "Closing the background engine for the update"));
  assert.ok(said.some((line) => line.level === "warn" && line.message.startsWith("The update waits: The background engine did not close")));
  // A failure that is not a wait: the reason, the step it stopped at and the version kept.
  const failing = new Updater({ repo: "KeepOak/Branch-Agent", currentVersion: "0.2.0", channel: "stable", platform: "win32", installDir,
    executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(dataDir, "scratch-2"),
    fetch: stableRelease(), extract, canary: async () => { throw new Error("the copy did not start"); } });
  await assert.rejects(failing.install(), /did not pass its check/);
  const stopped = (await lines(dataDir)).find((line) => line.level === "error" && line.message.startsWith("The update stopped:"));
  assert.ok(stopped, "a failed update is an error line");
  assert.equal(stopped.fields.kept, "0.2.0");
  assert.equal(stopped.fields.step, "checking");
});
