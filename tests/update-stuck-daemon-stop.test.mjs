/**
 * 2026-09-29, the owner's PC: Beta built, tried and backed up the same version every minute and never swapped. The
 * window had joined the background engine (the gateway, a windowless Electron process), and the update closed it with
 * `taskkill /PID <pid> /T` only (an automatic update never forces). Windows cannot close a process that has no window
 * that way ("can only be terminated forcefully"), so every attempt ended in a silent wait after the safety copy.
 *
 * The engine is now asked to close through `branch quit`'s door first (the gateway saves the work and ends), and a stop
 * that still cannot happen is an UpdateStuckError: a wait the window reports (kept, logged, said once), never silence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { discardTemp } from "./temp-dir.mjs";
import { stopBackgroundEngine } from "../dist/install/background-engine.js";
import { writeRunning, readRunning } from "../dist/install/running.js";
import { Updater, UpdateDeferredError, UpdateStuckError } from "../dist/desktop/updater.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const token = "c".repeat(64);
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-stuck-stop-"));
  t.after(() => discardTemp(root));
  await writeFile(join(root, "session-token"), token);
  return root;
}
const note = (root, pid) => writeRunning(root, { port: 3210, pid, url: "http://127.0.0.1:3210", mode: "daemon", version: "1.0.0" });
const tasklist = (file, args) =>
  file.endsWith("tasklist.exe") ? `"Branch Agent.exe","${args[1].replace("PID eq ", "")}","Console","1","90,000 K"\r\n` : null;
const forcefullyOnly = "C:\\Windows\\System32\\taskkill.exe failed: ERROR: The process with PID 37204 could not be terminated.\r\nReason: This process can only be terminated forcefully (with /F option).";

test("Windows: the background engine is asked to close through branch quit's door, and taskkill is never needed", async (t) => {
  const root = await scratch(t);
  await note(root, 37204);
  const asked = [], killed = [];
  let living = true;
  const report = await stopBackgroundEngine(root, {
    platform: "win32", gracefulOnly: true, alive: () => living, sleep: async () => {},
    run: async (file, args) => tasklist(file, args) ?? (killed.push(args), ""),
    fetch: async (url, init) => {
      asked.push([new URL(url).pathname, init.method, init.headers.authorization]);
      if (url.endsWith("/api/state")) return new Response(JSON.stringify({ version: "1.0.0" }));
      living = false; // the gateway saves the work and ends
      return new Response(JSON.stringify({ closing: true }));
    },
  });
  assert.deepEqual(asked.at(-1), ["/api/deployment/quit", "POST", `Bearer ${token}`]);
  assert.deepEqual(killed, [], "no taskkill at all");
  assert.deepEqual([report.pid, report.stopped, report.forced], [37204, true, false]);
  assert.equal(await readRunning(root), null, "the note is cleared");
});

test("Windows, automatic: an engine that cannot be closed politely is left running, and the reason is said", async (t) => {
  const root = await scratch(t);
  await note(root, 37204);
  const killed = [];
  const report = await stopBackgroundEngine(root, {
    platform: "win32", gracefulOnly: true, alive: () => true, sleep: async () => {}, waitMs: 0,
    run: async (file, args) => { if (tasklist(file, args)) return tasklist(file, args); killed.push(args); throw new Error(forcefullyOnly); },
    fetch: async (url) => url.endsWith("/api/state")
      ? new Response(JSON.stringify({ version: "1.0.0" }))
      : new Response(JSON.stringify({ error: "This copy of Branch cannot be closed from outside." }), { status: 403 }),
  });
  assert.deepEqual(killed, [["/PID", "37204", "/T"]], "never forced");
  assert.deepEqual([report.pid, report.stopped, report.forced], [37204, false, false]);
  assert.match(report.message, /HTTP 403: This copy of Branch cannot be closed from outside\./);
  assert.match(report.message, /can only be terminated forcefully \(with \/F option\)/, "taskkill's own reason, on one line");
  assert.doesNotMatch(report.message, /\r|\n/);
  assert.notEqual(await readRunning(root), null, "the running engine keeps its note");
});

for (const platform of ["darwin", "linux"]) {
  test(`${platform}: behind the gateway the engine refuses the close door, so the gateway is asked to quit`, async (t) => {
    const root = await scratch(t);
    await note(root, 41414);
    const asked = [], kills = [];
    let living = true;
    const report = await stopBackgroundEngine(root, {
      platform, gracefulOnly: true, alive: () => living, sleep: async () => {}, kill: (pid, signal) => kills.push([pid, signal]),
      run: async () => { throw new Error("no tool is run"); },
      fetch: async (url) => {
        asked.push(new URL(url).pathname);
        if (url.endsWith("/api/deployment/close")) return new Response(JSON.stringify({ error: "This copy of Branch is not the one working in the background." }), { status: 400 });
        living = false;
        return new Response(JSON.stringify({ closing: true }));
      },
    });
    assert.deepEqual(asked, ["/api/deployment/close", "/api/deployment/quit"]);
    assert.deepEqual(kills, []);
    assert.deepEqual([report.stopped, report.forced], [true, false]);
  });
}

test("a background engine that will not close is a wait the window must report: nothing swapped, still available", async (t) => {
  const root = await scratch(t);
  const installDir = join(root, "installed");
  await mkdir(installDir, { recursive: true });
  const bytes = Buffer.from("pretend zip");
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const why = "Branch could not close its background engine without forcing it (…), so the update is waiting rather than ending it by force. Nothing was changed.";
  const updater = new Updater({ lastReleaseWithoutProvenance: "2.0.0",
    repo: "x/y", currentVersion: "1.0.0", installDir, executableName: "Branch Agent.exe", assetName: "app.zip",
    scratchDir: join(root, "scratch"), platform: "win32", backup: async () => {},
    fetch: async (url) => String(url).includes("releases/latest")
      ? new Response(JSON.stringify({ tag_name: "v2.0.0", name: "2.0.0", body: "", published_at: null, html_url: "https://github.com/x/y",
        assets: [{ name: "app.zip", browser_download_url: "https://example.invalid/app.zip", size: bytes.length },
          { name: "app.zip.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 }] }), { status: 200 })
      : String(url).endsWith("app.zip") ? new Response(bytes) : new Response(`${digest}  app.zip\n`),
    extract: async (_archive, into) => {
      await mkdir(join(into, "app", "resources", "app"), { recursive: true });
      await writeFile(join(into, "app", "Branch Agent.exe"), "new");
      await writeFile(join(into, "app", "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
    },
    stopDaemon: async () => { throw new UpdateStuckError(why); },
  });
  const error = await updater.install().then(() => null, (thrown) => thrown);
  assert.ok(error instanceof UpdateDeferredError, "still a wait: the updater gives the install back and the next look tries again");
  assert.equal(String(error), `UpdateStuckError: ${why}`, "named apart, so the window does not file it as an ordinary wait");
  assert.equal(updater.status.phase, "available");
  assert.equal(updater.status.message, why, "the status says why");
  assert.equal(updater.inProgress, false);
  await assert.rejects(readFile(join(root, "scratch", "apply-update.cmd")), /ENOENT/, "no hand-over was written");
});

/* ---------- the window: reported, logged and said once, and tried again ---------- */

const source = async (path) => (await readFile(new URL(`../public/app/${path}`, import.meta.url), "utf8"))
  .replace(/^import [\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");

test("the window reports a stuck stop: said once, kept for Settings › Updates, written to the activity log, tried again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-stuck-window-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.store.save("settings", app.runtime.owner, "comfort-notify", { autoUpdate: "install", releaseChannel: "beta" });
  const api = async (path, body) => {
    const response = await fetch(new URL(`/api/${path}`, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? String(response.status));
    return answer;
  };
  const why = "Branch could not close its background engine without forcing it (it refused to close (HTTP 403)), so the update is waiting rather than ending it by force. Nothing was changed.";
  const status = { phase: "available", message: "A newer Beta build (change bbfd005) can be built and installed.", release: { tag: "dev-bbfd005" } };
  let installs = 0;
  const desktop = {
    updateStatus: async () => status,
    checkForUpdates: async () => status,
    installUpdate: async () => { installs++; status.message = why; throw new Error(`Error invoking remote method 'branch:update-install': UpdateStuckError: ${why}`); },
  };
  let now = Date.parse("2026-09-29T06:30:00Z"), nextId = 0;
  const timers = new Map(), toasts = [];
  const context = createContext({
    window: { branchDesktop: desktop }, setTimeout: (fn, ms) => { timers.set(++nextId, { fn, at: now + ms }); return nextId; },
    clearTimeout: (id) => timers.delete(id), console: { warn: () => undefined }, api, comfortSaved: new Set(), goingAway: () => undefined,
    toast: (said) => toasts.push(said), t: (key) => key, E: { state: null, sessions: [], trunks: [] }, onRender: () => undefined, render: () => undefined,
  });
  runInContext(await source("shell/autoupdate.js"), context);
  const settled = async () => { for (let i = 0; i < 400 && runInContext("updateAttempt", context); i++) await new Promise((r) => setTimeout(r, 5)); };
  runInContext(`applyComfort(${JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: "beta" } })})`, context);
  for (let step = 0; step < 6; step++) {
    await settled();
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    timers.delete(next[0]); now = next[1].at; next[1].fn();
  }
  await settled();
  assert.ok(installs >= 2, `tried again on the normal cadence (${installs})`);
  assert.deepEqual(toasts, [why], "said once, in the updater's words");
  assert.equal(runInContext("lastLook.wait", context), null, "not filed away as an ordinary wait");
  const plan = await api("comfort/update-plan", {});
  assert.equal(plan.problem?.message, why, "kept by the engine for Settings › Updates");
  assert.equal(plan.failed, undefined, "not remembered as a failed release: it is tried again");
  const log = await readFile(join(dataDir, "logs", "branch.jsonl"), "utf8");
  assert.ok(log.split("\n").some((line) => line.includes('"component":"updater"') && line.includes("could not close its background engine")),
    "the reason is a line in the activity log");
});
