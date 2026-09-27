/**
 * The owner: "the fact that auto update doesn't work is stupid". "Keep Branch up to date by itself" must just work, and
 * when it can't, say exactly why. Through the real public/app/shell/autoupdate.js (its imports stood in for) and the real
 * POST /api/comfort/update-plan route; only the desktop's updater bridge and the timers are stand-ins. Stable and Beta.
 * Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const source = async (path) => (await readFile(new URL(`../public/app/${path}`, import.meta.url), "utf8"))
  .replace(/^import [\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
const words = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

async function engine(t, notify) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-honest-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.store.save("settings", app.runtime.owner, "comfort-notify", notify);
  const refuse = { on: false };
  const api = async (path, body) => {
    if (refuse.on) throw new Error("The engine is not answering.");
    const response = await fetch(new URL(`/api/${path}`, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? String(response.status));
    return answer;
  };
  return { app, owner: app.runtime.owner, api, refuse };
}

function clock() {
  let now = Date.parse("2026-09-26T12:00:00Z"), nextId = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; },
    clear: (id) => timers.delete(id),
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
    async advance(ms, settled) {
      const end = now + ms;
      for (;;) {
        await settled();
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
      await settled();
    },
  };
}

/** The window's update-by-itself module, loaded as the shell loads it. */
async function window17({ desktop, api, state = null }) {
  const time = clock(), toasts = [], comfortSaved = new Set(), painters = [];
  const context = createContext({
    window: { branchDesktop: desktop }, Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clear,
    console: { warn: () => undefined }, api, comfortSaved, goingAway: () => undefined, toast: (said) => toasts.push(said), t: words,
    E: { state, sessions: [], trunks: [] }, onRender: (draw) => painters.push(draw), render: () => painters.forEach((draw) => draw()),
  });
  runInContext(await source("shell/autoupdate.js"), context);
  const settled = async () => {
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (!runInContext("updateAttempt || reading", context)) return;
    }
  };
  const run = (code) => runInContext(code, context);
  return { context, time, toasts, comfortSaved, run, settled, advance: (ms) => time.advance(ms, settled), look: () => run("lastLook") };
}

const u2status = (u, next) => { u.status = next; };
function updater(tag, overrides = {}) {
  const calls = { checks: 0, installs: 0 };
  let status = { phase: "available", message: `Version ${tag} is ready to install.`, release: { tag } };
  const desktop = {
    updateStatus: async () => status,
    checkForUpdates: async () => { calls.checks++; return status; },
    installUpdate: async (automatic) => { calls.installs++; assert.equal(automatic, true); status = { phase: "ready", message: "Restarting to finish the update…", release: { tag } }; return status; },
    set: (next) => { status = next; },
    ...overrides,
  };
  return { desktop, calls, get status() { return status; }, set status(next) { status = next; } };
}

for (const channel of ["stable", "beta"]) {
  const tag = channel === "beta" ? "v0.19.6-beta.3" : "v0.19.6";

  test(`${channel}: a failed look is said once in the updater's words, kept by the engine, and tried again on the normal cadence`, async (t) => {
    const e = await engine(t, { autoUpdate: "install", releaseChannel: channel });
    const u = updater(tag);
    const why = "GitHub could not be reached: the rate limit is used up until 13:00.";
    u.desktop.updateStatus = async () => ({ phase: "idle", message: "Updates have not been checked yet.", release: null });
    u.desktop.checkForUpdates = async () => { u.calls.checks++; return { phase: "error", message: why, release: null }; };
    const w = await window17({ desktop: u.desktop, api: e.api });
    w.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: channel } }) + ")");
    await w.advance(5 * 60_000);
    assert.ok(u.calls.checks >= 3, `looked again on the cadence (${u.calls.checks})`);
    assert.deepEqual(w.toasts, [why], "said once, in the updater's words");
    const kept = await e.api("comfort/update-plan", {});
    assert.equal(kept.problem?.message, why, "kept by the engine for Settings › Updates");
    assert.equal(w.look().problem.message, why);
    // A look that goes through clears it.
    u.desktop.checkForUpdates = async () => ({ phase: "current", message: "You have the newest version.", release: null });
    await w.advance(60_000);
    assert.equal((await e.api("comfort/update-plan", {})).problem, null, "a clean look clears it");
  });

  test(`${channel}: a failed install says the updater's words once; a deferral is a wait, not a failure`, async (t) => {
    const e = await engine(t, { autoUpdate: "install", releaseChannel: channel });
    const u = updater(tag);
    const broke = channel === "beta"
      ? "The Beta build failed: npm ci exited with code 1."
      : "The download's checksum did not match, so nothing was installed.";
    u.desktop.installUpdate = async () => {
      u.calls.installs++;
      u.status = { phase: "error", message: broke, outcome: { kept: "0.19.5", backgroundStopped: false }, release: { tag } };
      throw new Error(`Error invoking remote method 'branch:update-install': Error: ${broke}`);
    };
    const w = await window17({ desktop: u.desktop, api: e.api });
    w.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: channel } }) + ")");
    await w.advance(3 * 60_000);
    assert.equal(u.calls.installs, 1, "the failed release is not tried again by itself");
    assert.equal(w.toasts.length, 1, `said once (${JSON.stringify(w.toasts)})`);
    assert.ok(w.toasts[0].startsWith(broke), "in the updater's own words, without Electron's prefix");
    assert.match(w.toasts[0], /will not try it again by itself/, "with what happens next");
    assert.equal((await e.api("comfort/update-plan", {})).problem?.message, broke);

    // A deferral (the updater leaves the version available and says why) is shown as what it waits for, never toasted.
    const e2 = await engine(t, { autoUpdate: "install", releaseChannel: channel });
    const d = updater(tag);
    const wait = "The update channel was just changed, so Branch looks again before installing.";
    d.desktop.installUpdate = async () => { d.calls.installs++; u2status(d, { phase: "idle", message: "Checking beta updates has not started yet.", release: null }); throw new Error(`Error invoking remote method 'branch:update-install': UpdateDeferredError: ${wait}`); };
    // As updater-ipc.ts: the switch leaves the updater idle; the next look finds the release again on the new channel.
    d.desktop.checkForUpdates = async () => { d.calls.checks++; d.status = { phase: "available", message: `Version ${tag} is ready to install.`, release: { tag } }; return d.status; };
    const w2 = await window17({ desktop: d.desktop, api: e2.api });
    w2.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: channel } }) + ")");
    await w2.advance(10);
    assert.deepEqual(w2.toasts, [], "a wait is not a failure");
    assert.equal(w2.run("waitingLine()"), wait, "the updater's reason is the waiting line");
    await w2.advance(60_000);
    assert.ok(d.calls.installs >= 2, "and it tries again on the normal cadence");
    // Turned off: nothing is said to be waiting any more.
    w2.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "off", releaseChannel: channel } }) + ")");
    assert.equal(w2.run("waitingLine()"), null);
  });

  test(`${channel}: a held update says what it waits for in the engine's words and names the owner's holding tasks`, async (t) => {
    const e = await engine(t, { autoUpdate: "install", releaseChannel: channel });
    const sessionId = e.app.store.createSession(e.owner);
    const run = e.app.store.createRun(e.owner, "tidy the notes", sessionId);
    const u = updater(tag);
    const w = await window17({ desktop: u.desktop, api: e.api });
    w.context.E.sessions = [{ id: sessionId, title: "Tidy the notes" }];
    w.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: channel } }) + ")");
    await w.advance(10);
    assert.equal(u.calls.installs, 0, "a working task holds it");
    const plan = w.look().plan;
    assert.equal(plan.until, "no task is working");
    assert.match(plan.reason, /installs once no task is working/);
    assert.equal(w.run("waitingLine()"), words("window.updates.ready-installs-when", { until: "no task is working" }));
    assert.deepEqual(JSON.parse(JSON.stringify(w.run("holdingTasks()"))), [{ sessionId, state: "working", name: "Tidy the notes" }]);

    // Only a fresh question left: it says so as a question, not as work.
    e.app.store.finish(run.id, "needs_input", "Which folder?");
    await w.advance(30_000);
    assert.equal(w.look().plan.until, "the questions asked in the last hour are answered");
    assert.equal(w.run("holdingTasks()")[0].state, "asking");

    // Once nothing holds it, it installs by itself. (Lockdown does not hold it: #420's rule, update-beta-channel.test.mjs.)
    e.app.store.finish(run.id, "completed", "done");
    await w.advance(30_000);
    assert.equal(u.calls.installs, 1, "and it installs as soon as nothing holds it");
    assert.deepEqual(w.toasts, []);
  });
}

test("switching update by itself on anywhere applies at once, and a failed first read is tried again soon", async (t) => {
  const e = await engine(t, { autoUpdate: "off", releaseChannel: "stable" });
  // It ships "install" (the ship-on rule); the owner switches it off through the window's own save, so the off is theirs.
  await e.api("comfort", { card: "notify", values: { autoUpdate: "off" } });
  const u = updater("v0.19.6");
  let failFirst = 1;
  const api = async (path, body) => {
    if (path === "comfort" && body === undefined && failFirst-- > 0) throw new Error("The engine is starting.");
    return e.api(path, body);
  };
  const w = await window17({ desktop: u.desktop, api, state: {} });
  // The shell starts it with the window, whatever page shows; Settings is never opened here.
  w.run("initAutoUpdate()");
  await w.advance(10);
  assert.deepEqual(w.toasts, ["The engine is starting."], "the failed read is said");
  await w.advance(2_000);
  assert.equal(w.run("asked"), true, "read again after two seconds, with no refresh");
  assert.equal(u.calls.installs, 0, "off: nothing looked for");
  // The owner switches it on in a page; core/api.js hands the saved values to the loop.
  const saved = await e.api("comfort", { card: "notify", values: { autoUpdate: "install" } });
  for (const heard of w.comfortSaved) heard(saved.values);
  await w.advance(10);
  assert.equal(u.calls.installs, 1, "the switch took effect at once, before any refresh");
});

test("core/api.js hands every saved comfort choice to its listeners", async () => {
  const heard = [];
  const context = createContext({
    location: { search: "" }, sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ values: { notify: { autoUpdate: "install" } } }) }),
    TextDecoder, AbortController, URLSearchParams, addEventListener: () => undefined,
  });
  runInContext(await source("core/api.js"), context);
  runInContext("comfortSaved", context).add((values) => heard.push(values.notify.autoUpdate));
  await runInContext(`api("comfort", { card: "notify", values: { autoUpdate: "install" } })`, context);
  await runInContext(`api("comfort")`, context);
  assert.deepEqual(heard, ["install"], "a save is heard; a read is not");
});

test("the shell starts update by itself with the window", async () => {
  const shell = await readFile(new URL("../public/app/shell/shell.js", import.meta.url), "utf8");
  const boot = shell.slice(shell.indexOf("initUsage();"));
  assert.match(boot.slice(0, 400), /\n\s*initAutoUpdate\(\);/);
});

test("Settings › Updates: the switch installs, and the status card says the failure, then the wait, in the engine's words", async () => {
  const posted = [];
  const lastLook = { plan: null, status: null, wait: null, problem: null };
  const context = createContext({
    E: { profiles: { isOwner: true }, state: { version: "0.19.5" } }, level: () => "simple", esc: (s) => String(s), render: () => undefined,
    markLive: () => undefined, toast: () => undefined, updates17: () => "", t: words, ic: () => "", waiting: async () => null,
    channelSection: () => "", initChannel: () => undefined, loadChannel: async () => undefined,
    lastLook, waitingLine: () => (lastLook.plan?.until ? words("window.updates.ready-installs-when", { until: lastLook.plan.until }) : null),
    holdingTasks: () => [{ sessionId: "s-1", state: "working", name: "Tidy the notes" }],
    api: async (path, body) => { posted.push(body); return { values: { notify: { autoUpdate: body?.values?.autoUpdate ?? "check" } } }; },
    document: { addEventListener: () => undefined }, window: { branchDesktop: {} },
    // shell/updating.js: no install under way (tests/update-screen-ui.test.mjs covers the card while one is).
    updateNow: () => null, channelStatus: () => null, installing: () => false, clock: String, stageWords: String, targetWords: String,
  });
  runInContext(await source("settings/pages/updates.js"), context);
  await runInContext("saveAutoUpdate(true)", context);
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), { card: "notify", values: { autoUpdate: "install" } }, "Keep Branch up to date by itself installs");
  runInContext(`comfortData = { notify: { autoUpdate: "check" } }`, context);
  assert.doesNotMatch(runInContext("draw()", context), /id="u-auto" checked/, "only looking is not keeping it up to date by itself");
  runInContext(`comfortData = { notify: { autoUpdate: "install" } }`, context);
  assert.match(runInContext("draw()", context), /id="u-auto" checked/);

  lastLook.plan = { reason: "A newer version is ready; it installs once no task is working.", until: "no task is working" };
  lastLook.problem = { message: "The download's checksum did not match, so nothing was installed.", at: "2026-09-26T12:00:00Z" };
  // The owner: nothing contradictory at once. The failure is what the card says until a look goes through cleanly.
  const failed = runInContext("draw()", context);
  assert.match(failed, /sdot bad"><\/span><div class="grow"><b>window.updates.card.failed \{"reason":"The download's checksum did not match, so nothing was installed."\}<\/b>/);
  assert.doesNotMatch(failed, /ready-installs-when/, "one thing at a time");
  lastLook.problem = null;
  const html = runInContext("draw()", context);
  assert.match(html, /<b>window.updates.ready-installs-when \{"until":"no task is working"\}<\/b><p>A newer version is ready; it installs once no task is working.<\/p>/);
  assert.match(html, /data-act="chat" data-id="s-1">Tidy the notes<\/button>/, "the holding task opens its conversation");
});

/* Coordinator: the owner never clicks. When the running build's change is an ancestor of Beta's newest change, update by
   itself builds and installs it with no confirmation; only a line that diverged (or was force-pushed) waits for the
   owner's yes, and that is said in the window, never a silent stall. The real Updater with stand-ins for git and npm
   (as dev-channel.test.mjs does), behind a bridge that does what updater-ipc.ts does, and the real plan route. */
import { mkdir, writeFile } from "node:fs/promises";
import { Updater } from "../dist/desktop/updater.js";
import { betaLine, packageSteps } from "../dist/desktop/dev-build.js";

const NEW = "a".repeat(40), OLD = "b".repeat(40), assetName = "Branch-Agent-windows-x64.zip", exe = "Branch Agent.exe";
function gitAndNpm(sourceDir, standing) {
  const built = [];
  const run = async (file, args, options = {}) => {
    const line = [file, ...args.filter((a, i) => a !== "-c" && args[i - 1] !== "-c")].join(" ");
    const cwd = options.cwd ?? "";
    if (args[0] === "--version") return "1.0";
    if (line.startsWith("git ls-remote")) return `${NEW}\trefs/heads/${betaLine}\n`;
    if (line.startsWith("git merge-base --is-ancestor")) return ""; // the change is on Beta's line
    if (line.startsWith("git merge-base")) return `${standing === "behind" ? OLD : standing === "ahead" ? NEW : "c".repeat(40)}\n`; // behind: OLD is an ancestor of NEW
    if (line.startsWith("git init")) { await mkdir(join(sourceDir, ".git"), { recursive: true }); return ""; }
    if (line.startsWith("git fetch") && line.includes(`+refs/heads/${betaLine}:`)) { built.push("fetch"); return ""; }
    if (line.startsWith("git checkout")) {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "branch-agent", version: "0.19.5", scripts: { "package:desktop": packageSteps } }));
      await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ name: "branch-agent", version: "0.19.5", packages: { "": { version: "0.19.5" } } }));
      return "";
    }
    if (line.startsWith("git rev-parse")) return `${NEW}\n`;
    if (line.startsWith("git show")) return "1758600000\n";
    if (line.startsWith("node scripts/package-desktop.mjs")) {
      built.push("package");
      const { version } = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      // Windows: the app folder itself, which the update swaps in (no zip).
      const app = join(cwd, "release", "Branch Agent-win32-x64");
      await mkdir(join(app, "resources", "app"), { recursive: true });
      await mkdir(join(cwd, "dist"), { recursive: true });
      await writeFile(join(cwd, "dist", "build-info.json"), JSON.stringify({ commit: NEW }));
      await writeFile(join(app, exe), "the new app");
      await writeFile(join(app, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version }));
    }
    if (line.startsWith("npm ci")) await mkdir(join(cwd, "node_modules"), { recursive: true });
    return "";
  };
  return { run, built };
}
async function betaBridge(t, standing) {
  const root = await mkdtemp(join(tmpdir(), "branch-beta-noclick-"));
  t.after(() => discardTemp(root));
  const installDir = join(root, "installed"), scratchDir = join(root, "scratch");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, exe), "the installed app");
  const devBuildDir = join(root, "data", "updates", "beta-build");
  const tools = gitAndNpm(join(devBuildDir, "source"), standing), order = [];
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.19.5-beta.3", channel: "beta", installDir, executableName: exe,
    assetName, scratchDir, platform: "win32", fetch: async (url) => { throw new Error(`no network in this test: ${url}`); },
    extract: async (archive, into) => {
      const app = join(into, "Branch Agent");
      await mkdir(join(app, "resources", "app"), { recursive: true });
      await writeFile(join(app, exe), "the new app");
      await writeFile(join(app, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: await readFile(archive, "utf8") }));
    },
    devRun: tools.run, currentCommit: OLD, devBuildDir, runOnceKey: "HKCU\Software\BranchTest\RunOnce",
    canary: async () => { order.push("canary"); }, tryOut: async () => { order.push("try-out"); return null; }, backup: async () => { order.push("data copy"); }, beforeStop: async () => { order.push("idle check"); } });
  // As updater-ipc.ts: update by itself passes `automatic` and never a confirmation.
  const desktop = {
    updateStatus: async () => updater.status,
    checkForUpdates: async () => updater.check(),
    installUpdate: async (automatic, confirm) => {
      assert.equal(automatic, true);
      assert.equal(confirm, undefined, "update by itself never confirms a change");
      await updater.install({});
      return updater.status;
    },
  };
  return { desktop, updater, tools, order };
}

test("beta: a newer change on the same line (the running one is its ancestor) is built and installed with no click", async (t) => {
  const e = await engine(t, { autoUpdate: "install", releaseChannel: "beta" });
  const b = await betaBridge(t, "behind");
  const w = await window17({ desktop: b.desktop, api: e.api });
  w.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: "beta" } }) + ")");
  await w.advance(60_000);
  assert.equal(b.updater.status.phase, "ready", `installed by itself: ${b.updater.status.message}`);
  assert.deepEqual(b.tools.built, ["fetch", "package"]);
  assert.deepEqual(b.order, ["canary", "try-out", "data copy", "idle check"], "#420: the data folder is copied before the install goes on, after the new version's try-out");
  assert.deepEqual(w.toasts, []);
});

test("beta: a line that diverged waits for the owner's yes, and the window says so once in the updater's words", async (t) => {
  const e = await engine(t, { autoUpdate: "install", releaseChannel: "beta" });
  const b = await betaBridge(t, "apart");
  const w = await window17({ desktop: b.desktop, api: e.api });
  w.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: "beta" } }) + ")");
  await w.advance(12 * 60_000);
  assert.deepEqual(b.tools.built, [], "nothing is built without the owner's confirmation");
  const said = b.updater.status.message;
  assert.match(said, /different line of work/);
  assert.deepEqual(w.toasts, [said], "said once, not a silent stall");
  assert.equal(w.run("waitingLine()"), said, "and it stays as the waiting line");
});

test("beta: a copy already ahead of Beta's newest change is not invited to go back, and nothing is built", async (t) => {
  const e = await engine(t, { autoUpdate: "install", releaseChannel: "beta" });
  const b = await betaBridge(t, "ahead");
  const w = await window17({ desktop: b.desktop, api: e.api });
  w.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: "beta" } }) + ")");
  await w.advance(12 * 60_000);
  assert.equal(b.updater.status.release?.standing, "ahead");
  assert.deepEqual(b.tools.built, []);
  assert.deepEqual(w.toasts, [], "no notice asks the owner to move back");
  assert.equal(w.run("waitingLine()"), null);
});

test("the desktop names a deferral, so the window hears a wait and not a failure", async () => {
  const { UpdateDeferredError } = await import("../dist/desktop/updater.js");
  assert.equal(String(new UpdateDeferredError("The update channel was just changed.")), "UpdateDeferredError: The update channel was just changed.");
});

/* Codex P2 on #441: an engine outage is said once while it lasts; once the engine answers again, the next outage is
   said too, even in the same words. */
test("an engine that stops answering again after it came back is said again", async (t) => {
  const e = await engine(t, { autoUpdate: "install", releaseChannel: "stable" });
  const u = updater("v0.19.6");
  u.desktop.updateStatus = async () => ({ phase: "current", message: "You have the newest version.", release: null });
  u.desktop.checkForUpdates = async () => ({ phase: "current", message: "You have the newest version.", release: null });
  const w = await window17({ desktop: u.desktop, api: e.api });
  w.run("applyComfort(" + JSON.stringify({ notify: { autoUpdate: "install", releaseChannel: "stable" } }) + ")");
  await w.advance(10);
  e.refuse.on = true;
  await w.advance(2 * 60_000);
  assert.deepEqual(w.toasts, ["The engine is not answering."], "said once while it lasts");
  e.refuse.on = false;
  await w.advance(60_000);
  e.refuse.on = true;
  await w.advance(60_000);
  assert.deepEqual(w.toasts, ["The engine is not answering.", "The engine is not answering."], "the second outage is said too");
});
