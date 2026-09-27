// FQ-execution.desktop: the shared Linux desktop (VNC/Xvfb) and the owner taking it over. Every
// "docker"/"xdotool" call here is a fake that only records what it was asked, so this file needs
// no Docker and touches no real display; the pure argv builders prove the real commands are right.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, Budget, setLockdown, lockdownToolRefusalText } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import {
  LinuxDesktopSandbox, dockerRunArgv, dockerExecArgv, dockerStopArgv, xvfbArgv, x11vncArgv, xdotoolArgv,
  readLinuxDesktop, saveLinuxDesktop, switchedOffMessage, takenOverMessage, notRunningMessage, vncPort, display,
  dockerExecKillArgv, execTimeoutMs,
} from "../dist/integrations/linux-desktop.js";
import { TakeOverBanner, takeOverNotice } from "../dist/integrations/linux-desktop-banner.js";
import { bannerPage } from "../dist/desktop/banner-window.js";

const runContext = (runId, owner, permissions) => ({
  owner, workspace: ".", runId, signal: new AbortController().signal, budget: new Budget(),
  permissions: new Set(permissions), depth: 0,
});

/**
 * Every loopback listener a fixture desktop opens. Tests start desktops they never stop, and an open
 * listener keeps node from exiting once the file is done (seen on Windows as a job-length hang).
 */
const listeners = new Set();
function tracked(desktop) {
  const open = desktop.createListener;
  desktop.createListener = async (...args) => { const server = await open(...args); listeners.add(server); return server; };
  return desktop;
}
after(() => { for (const server of listeners) server.close(); });

/** A fake `docker`/`xdotool` runner that only records what it was asked and answers with a fixed id. */
function fakeRunner({ image = "branch-linux-desktop:latest" } = {}) {
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "image" && args[1] === "inspect") return "ok";
    if (args[0] === "run") return "abcdef012345\n";
    return "";
  };
  return { calls, runner, image };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-shared-desktop-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

// -------------------------------------------------------------- the commands themselves

test("Xvfb, x11vnc and the container's docker run line are built exactly, and nothing is ever pulled", () => {
  assert.deepEqual(xvfbArgv(), [":1", "-screen", "0", "1280x800x24", "-nolisten", "tcp"]);
  assert.deepEqual(x11vncArgv(), ["-display", ":1", "-rfbport", "5900", "-passwdfile", "rm:/tmp/vncpw", "-forever", "-shared", "-quiet"]);
  const argv = dockerRunArgv("branch-linux-desktop:latest");
  assert.ok(argv.includes("--pull=never"), "the image is never pulled automatically");
  assert.ok(argv.includes("--network"), "network isolation is enforced");
  assert.ok(argv.includes("none"), "--network none for isolation");
  assert.ok(argv.includes("--pids-limit"), "process limit is set");
  assert.ok(argv.includes("256"), "pids limit is 256");
  assert.ok(argv.includes("--label"), "labels are set");
  assert.ok(argv.includes("branch.shared-desktop=1"), "label marks shared desktop containers");
  assert.ok(argv.includes("--cap-drop"));
  assert.equal(argv.indexOf("-p"), -1, "no -p port mapping with --network none");
  assert.equal(argv.at(-4), "branch-linux-desktop:latest");
  assert.equal(argv.at(-3), "sh");
});

test("xdotool argument lists for opening a program, typing and a key press", () => {
  assert.deepEqual(xdotoolArgv({ type: "open", app: "xterm" }), ["exec", "--", "xterm"]);
  assert.deepEqual(xdotoolArgv({ type: "type", text: "hello" }), ["type", "--clearmodifiers", "--", "hello"]);
  assert.deepEqual(xdotoolArgv({ type: "key", chord: "ctrl+s" }), ["key", "--clearmodifiers", "ctrl+s"]);
  const exec = dockerExecArgv("abc123", { type: "open", app: "xterm" });
  assert.deepEqual(exec, ["exec", "-e", "DISPLAY=:1", "abc123", "xdotool", "exec", "--", "xterm"]);
  assert.deepEqual(dockerStopArgv("abc123"), ["stop", "abc123"]);
});

// -------------------------------------------------------------- settings

test("the switch is off until the owner turns it on, and the image name is saved", async (t) => {
  const { app } = await fixture(t);
  const before = readLinuxDesktop(app.store, "local");
  assert.equal(before.mode, "off");
  const after = saveLinuxDesktop(app.store, "local", { mode: "on", image: "my-desktop:1" });
  assert.equal(after.mode, "on");
  assert.equal(after.image, "my-desktop:1");
  assert.deepEqual(readLinuxDesktop(app.store, "local"), after);
});

// -------------------------------------------------------------- the sandbox itself

test("starting the shared desktop is refused in plain words while the switch is off", async (t) => {
  const { app } = await fixture(t);
  const { runner } = fakeRunner();
  const desktop = new LinuxDesktopSandbox(app.store, {});
  desktop.runner = runner;
  await assert.rejects(desktop.start("local"), (error) => {
    assert.equal(error.message, switchedOffMessage);
    return true;
  });
});

test("Docker missing is reported as the external part that is not done, not a crash", async (t) => {
  const { app } = await fixture(t);
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  const desktop = new LinuxDesktopSandbox(app.store);
  desktop.runner = async () => { const error = new Error("not found"); error.code = "ENOENT"; throw error; };
  const check = await desktop.available("local");
  assert.equal(check.ok, false);
  assert.match(check.reason, /Docker is not installed/);
  await assert.rejects(desktop.start("local"), /Docker is not installed/);
});

/** A sandbox wired to a fake docker/xdotool and a VNC probe that answers on the second try. The
 * notice window is a stand-in too, so no real popup appears on whoever's screen the tests run on. */
function sandboxFixture(app) {
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  const { calls, runner } = fakeRunner();
  const banner = { shown: 0, hidden: 0, async show() { this.shown += 1; }, async hide() { this.hidden += 1; } };
  const desktop = new LinuxDesktopSandbox(app.store, { banner });
  desktop.runner = runner;
  desktop.feeder = async () => {}; // mock password feeder
  desktop.spawnerFn = () => ({
    stdin: { write: () => {}, end: () => {} },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
    pid: 12345,
  });
  desktop.password = () => "test-pass";
  desktop.pauseMs = 1;
  let probes = 0;
  desktop.probe = async (containerId, runner) => { probes += 1; return probes >= 2; };
  // Mock listener creation to return a fake server
  desktop.createListener = async (containerId, tunnels) => {
    const { createServer } = await import("node:net");
    return new Promise((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  };
  tracked(desktop);
  return { desktop, calls };
}

test("starting the shared desktop runs Xvfb/x11vnc in a container and hands back where to connect", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  const info = await desktop.start("local");
  assert.equal(info.host, "127.0.0.1", "host is localhost");
  assert(info.port > 0, "port is a valid positive number");
  assert.equal(info.password, "test-pass", "password is test-pass");
  const run = calls.find((call) => call.args[0] === "run");
  assert.ok(run, "docker run was called");
  assert.ok(run.args.join(" ").includes("Xvfb"), "Xvfb draws the desktop");
  assert.ok(run.args.join(" ").includes("x11vnc"), "x11vnc serves it over VNC");
  // Starting again while it is already up hands back the same session instead of another container.
  const again = await desktop.start("local");
  assert.equal(again.host, info.host, "same host");
  assert.equal(again.port, info.port, "same port");
  assert.equal(again.password, info.password, "same password");
  assert.equal(calls.filter((call) => call.args[0] === "run").length, 1);
});

test("the assistant can operate a test application on the shared desktop while it holds control", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  await desktop.start("local");
  assert.equal(desktop.controlOf("local"), "agent");
  const answer = await desktop.act("local", { type: "open", app: "xterm" });
  assert.equal(answer.ran, "open");
  const exec = calls.find((call) => call.args[0] === "exec");
  assert.deepEqual(exec.args, ["exec", "-e", "DISPLAY=:1", "abcdef012345", "xdotool", "exec", "--", "xterm"]);
});

test("the owner taking over the shared desktop stops the assistant from acting on it until it is handed back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  await desktop.start("local");
  await desktop.act("local", { type: "open", app: "xterm" }); // the assistant is mid-task on the desktop
  const before = calls.filter((call) => call.args[0] === "exec").length;

  await desktop.takeOver("local"); // <-- the owner takes over (the notice's "Take over" button does the same)
  assert.equal(desktop.controlOf("local"), "user");
  // takeOver kills any in-flight xdotool process, which counts as one additional exec call
  const afterTakeOver = calls.filter((call) => call.args[0] === "exec").length;
  assert.equal(afterTakeOver, before + 1, "takeOver sends a pkill to abort in-flight actions");

  await assert.rejects(desktop.act("local", { type: "type", text: "hello" }), (error) => {
    assert.equal(error.message, takenOverMessage);
    return true;
  });
  assert.equal(calls.filter((call) => call.args[0] === "exec").length, afterTakeOver, "no new commands sent after takeOver while owner holds it");

  await desktop.handBack("local"); // the owner hands it back
  assert.equal(desktop.controlOf("local"), "agent");
  const after = await desktop.act("local", { type: "key", chord: "Return" });
  assert.equal(after.ran, "key");
});

test("stopping the shared desktop tears the container down and refuses further actions", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  await desktop.start("local");
  await desktop.stop("local");
  assert.deepEqual(calls.find((call) => call.args[0] === "stop").args, ["stop", "abcdef012345"]);
  await assert.rejects(desktop.act("local", { type: "key", chord: "Return" }), (error) => {
    assert.equal(error.message, notRunningMessage);
    return true;
  });
});

// -------------------------------------------------------------- wired into the product, not just a class

test("the shared desktop is reachable as tools, and takeOver reaches through them the same way", async (t) => {
  const { app } = await fixture(t);
  // `desktop.shared.*` is already registered on the running app (src/index.ts); wiring the fakes
  // onto that same instance, rather than making a second one, is what proves the tools reach it.
  const desktop = app.linuxDesktop;
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  const { calls, runner } = fakeRunner();
  desktop.runner = runner;
  desktop.feeder = async () => {}; // mock password feeder
  desktop.spawnerFn = () => ({
    stdin: { write: () => {}, end: () => {} },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
    pid: 12345,
  });
  desktop.password = () => "test-pass";
  desktop.pauseMs = 1;
  desktop.banner = { async show() {}, async hide() {} };
  let probes = 0;
  desktop.probe = async () => { probes += 1; return probes >= 2; };
  // Mock listener creation to return a fake server
  desktop.createListener = async (containerId, tunnels) => {
    const { createServer } = await import("node:net");
    return new Promise((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  };
  tracked(desktop);
  const permissions = ["desktop.control"];
  const ctx = () => runContext("run-1", "local", permissions);

  const started = await app.registry.execute("desktop.shared.start", {}, ctx());
  assert(started.port > 0, "port is assigned");
  const opened = await app.registry.execute("desktop.shared.open", { app: "xterm" }, ctx());
  assert.equal(opened.ran, "open");

  desktop.takeOver("local");
  await assert.rejects(app.registry.execute("desktop.shared.type", { text: "hi" }, ctx()), /Branch has let go of it/);

  await desktop.handBack("local");
  const typed = await app.registry.execute("desktop.shared.type", { text: "hi" }, ctx());
  assert.equal(typed.ran, "type");

  const stopped = await app.registry.execute("desktop.shared.stop", {}, ctx());
  assert.deepEqual(stopped, { stopped: true });
  assert.ok(calls.some((call) => call.args[0] === "stop"));
});

// -------------------------------------------------------------- review fixes: the switch, the owner's hold, races

/** A promise the test settles itself, so an interleaving is written down rather than timed. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Like `sandboxFixture`, but `docker run` and `docker stop` can be held until the test lets them go,
 * and the notice stand-in says whether it is showing. */
function heldFixture(app, desktop = new LinuxDesktopSandbox(app.store), windowFactory = null) {
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  const calls = [];
  const hold = { run: null, stop: null, exec: null };
  let started = 0;
  desktop.runner = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs });
    if (args[0] === "image") return "ok";
    if (args[0] === "run") { started += 1; if (hold.run) await hold.run.promise; return `abcdef01234${started}\n`; }
    if (args[0] === "exec" && hold.exec) await hold.exec.promise;
    if (args[0] === "stop" && hold.stop) await hold.stop.promise;
    return "";
  };
  desktop.feeder = async () => {}; // mock password feeder
  desktop.spawnerFn = () => ({
    stdin: { write: () => {}, end: () => {} },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
    pid: 12345,
  });
  if (windowFactory) {
    desktop.banner = new TakeOverBanner(undefined, { platform: "linux", window: windowFactory });
  } else {
    const banner = { visible: false, shown: 0, async show() { this.shown += 1; this.visible = true; }, async hide() { this.visible = false; } };
    desktop.banner = banner;
  }
  desktop.port = async () => 15902;
  desktop.password = () => "test-pass";
  desktop.pauseMs = 1;
  desktop.probe = async () => true;
  const ran = (verb) => calls.filter((call) => call.args[0] === verb);
  tracked(desktop);
  return { desktop, calls, hold, banner: desktop.banner, ran };
}
const settle = async (until) => { for (let i = 0; i < 200 && !until(); i++) await new Promise((done) => setTimeout(done, 5)); };

test("switching the feature off stops a desktop that is running, and start no longer hands its password back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app);
  await desktop.start("local");
  saveLinuxDesktop(app.store, "local", { mode: "off" }); // saved anywhere, not only through the Settings route
  await assert.rejects(desktop.act("local", { type: "key", chord: "Return" }), (error) => {
    assert.equal(error.message, switchedOffMessage);
    return true;
  });
  assert.deepEqual(ran("stop").map((call) => call.args), [["stop", "abcdef012341"]], "the container was taken down");
  assert.equal(desktop.controlOf("local"), "none");
  await assert.rejects(desktop.start("local"), (error) => { assert.equal(error.message, switchedOffMessage); return true; });
});

test("start checks the switch too: a desktop still running when the switch went off is stopped, not handed back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app);
  await desktop.start("local");
  saveLinuxDesktop(app.store, "local", { mode: "off" });
  await assert.rejects(desktop.start("local"), (error) => { assert.equal(error.message, switchedOffMessage); return true; });
  assert.equal(ran("stop").length, 1);
  assert.equal(desktop.controlOf("local"), "none");
});

test("saving only the mode keeps the image the owner chose", async (t) => {
  const { app } = await fixture(t);
  saveLinuxDesktop(app.store, "local", { mode: "on", image: "my-desktop:1" });
  saveLinuxDesktop(app.store, "local", { mode: "when-needed" });
  assert.equal(readLinuxDesktop(app.store, "local").image, "my-desktop:1");
});

test("turning Lockdown on stops a running shared desktop at once, and it reads as off while Lockdown is on", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app, app.linuxDesktop);
  await desktop.start("local");
  setLockdown(app.store, "local", { on: true });
  await settle(() => ran("stop").length > 0);
  assert.equal(ran("stop").length, 1, "Lockdown took the container down without waiting for the next action");
  assert.equal(desktop.controlOf("local"), "none");
  assert.equal(readLinuxDesktop(app.store, "local").mode, "off");
  await assert.rejects(desktop.start("local"), (error) => { assert.equal(error.message, lockdownToolRefusalText); return true; });
  setLockdown(app.store, "local", { on: false });
  assert.equal(readLinuxDesktop(app.store, "local").mode, "on", "the owner's own switch comes back after Lockdown");
});

test("while the owner holds the desktop the assistant can neither stop it, start it again, nor act, until the owner hands it back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app, app.linuxDesktop);
  const ctx = () => runContext("run-2", "local", ["desktop.control"]);
  await desktop.start("local");
  await desktop.takeOver("local");
  for (const [name, input] of [["desktop.shared.stop", {}], ["desktop.shared.start", {}], ["desktop.shared.type", { text: "hi" }]])
    await assert.rejects(app.registry.execute(name, input, ctx()), (error) => { assert.equal(error.message, takenOverMessage); return true; }, name);
  await assert.rejects(desktop.stop("local"), (error) => { assert.equal(error.message, takenOverMessage); return true; });
  await assert.rejects(desktop.start("local"), (error) => { assert.equal(error.message, takenOverMessage); return true; });
  assert.equal(ran("stop").length, 0, "the owner's desktop was not taken down");
  assert.equal(ran("run").length, 1, "no second desktop was started with control back at the assistant");
  assert.equal(desktop.controlOf("local"), "user");
  await desktop.handBack("local");
  assert.equal((await app.registry.execute("desktop.shared.type", { text: "hi" }, ctx())).ran, "type");
});

test("handing back is the owner's alone: no tool does it, and the refusal names only places that exist", async (t) => {
  const { app } = await fixture(t);
  const tools = app.registry.names().filter((name) => name.startsWith("desktop.shared."));
  assert.deepEqual(tools.sort(), ["desktop.shared.key", "desktop.shared.open", "desktop.shared.start", "desktop.shared.stop", "desktop.shared.type"]);
  assert.doesNotMatch(takenOverMessage, /desktop\.shared\.release/);
  // unhold-control: Hand back lives in the new window's computer view (public/app/chat/stage.js), in the prototype's words.
  assert.match(takenOverMessage, /"Hand back to …" at the top of the computer view/);
  const stage = await readFile(new URL("../public/app/chat/stage.js", import.meta.url), "utf8");
  assert.match(stage, /data-act="handback">\$\{t\("window\.chat\.stage\.hand-back-to"/, "the Hand back to … button the refusal points to is drawn in the computer view");
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  assert.equal(english["window.chat.stage.hand-back-to"], "Hand back to {name}", "in the prototype's words");
  assert.match(stage, /api\(path, \{\}\)/, "and it calls the hand-back route");
  assert.match(stage, /"linux-desktop\/hand-back"/);
});

test("the Settings routes: switching off stops the desktop at once, hand back is the owner's, and no key reaches either", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const call = (method, path, key, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const { desktop, ran } = heldFixture(app, app.linuxDesktop);
  await desktop.start("local");
  // unhold-control: the window's computer view, which draws Take over and Hand back, is served.
  const card = await fetch(server.url + "/app/chat/stage.js");
  assert.equal(card.status, 200, "the computer view's own script is served, so its buttons work");
  assert.match(await card.text(), /linux-desktop\/take-over/);

  const shown = await call("GET", "/api/linux-desktop", server.token);
  assert.equal(shown.status, 200);
  assert.deepEqual({ mode: shown.body.mode, running: shown.body.running, control: shown.body.control }, { mode: "on", running: true, control: "agent" });
  assert.equal(JSON.stringify(shown.body).includes("test-pass"), false, "reading the card never hands out the VNC password");

  const run = app.sessionTokens.create(app.runtime.owner, { name: "run", scope: "run", minutes: 5 }).token;
  for (const path of ["/api/linux-desktop", "/api/linux-desktop/take-over", "/api/linux-desktop/hand-back"])
    assert.equal((await call("POST", path, run, { mode: "off" })).status, 401, `a short-lived key is refused ${path}`);

  assert.equal((await call("POST", "/api/linux-desktop/take-over", server.token)).body.control, "user");
  await assert.rejects(desktop.act("local", { type: "key", chord: "Return" }), /let go of it/);
  assert.equal((await call("POST", "/api/linux-desktop/hand-back", server.token)).body.control, "agent");
  assert.equal((await desktop.act("local", { type: "key", chord: "Return" })).ran, "key");

  const off = await call("POST", "/api/linux-desktop", server.token, { mode: "off" });
  assert.equal(off.status, 200);
  assert.equal(off.body.running, false);
  assert.equal(ran("stop").length, 1, "the container was taken down as the switch went off, not at the next action");
});

test("two starts at once share one container", async (t) => {
  const { app } = await fixture(t);
  const { desktop, hold, ran } = heldFixture(app);
  hold.run = deferred();
  const first = desktop.start("local"), second = desktop.start("local");
  await settle(() => ran("run").length > 0);
  hold.run.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(ran("run").length, 1, "only one docker run");
});

test("stopping while a start is still under way takes that container down too", async (t) => {
  const { app } = await fixture(t);
  const { desktop, hold, ran } = heldFixture(app);
  hold.run = deferred();
  const starting = desktop.start("local");
  starting.catch(() => undefined);
  await settle(() => ran("run").length > 0);
  const stopping = desktop.stop("local");
  hold.run.resolve();
  await assert.rejects(starting);
  await stopping;
  assert.deepEqual(ran("stop").map((call) => call.args), [["stop", "abcdef012341"]], "docker stop was issued for the container the start made");
  assert.equal(desktop.controlOf("local"), "none");
});

test("the app closing while a start is under way takes that container down too", async (t) => {
  const { app } = await fixture(t);
  const { desktop, hold, ran } = heldFixture(app);
  hold.run = deferred();
  const starting = desktop.start("local");
  starting.catch(() => undefined);
  await settle(() => ran("run").length > 0);
  const closing = desktop.close();
  hold.run.resolve();
  await closing;
  await assert.rejects(starting);
  assert.deepEqual(ran("stop").map((call) => call.args), [["stop", "abcdef012341"]]);
});

test("a start asked for in the same moment the app closes leaves no container behind", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app);
  const starting = desktop.start("local");
  starting.catch(() => undefined);
  await desktop.close();
  await assert.rejects(starting);
  assert.equal(desktop.controlOf("local"), "none");
  assert.ok(ran("run").length === 0 || ran("stop").length === ran("run").length, "every container started was stopped again");
});

test("a start made while a stop is still under way ends with the Take over notice showing", async (t) => {
  const { app } = await fixture(t);
  const { desktop, hold, banner, ran } = heldFixture(app);
  await desktop.start("local");
  hold.stop = deferred();
  const stopping = desktop.stop("local");
  await settle(() => ran("stop").length > 0);
  const again = desktop.start("local");
  // Give the new start every chance to put its notice up before the old stop finishes; the old
  // stop taking the notice down after that is exactly the bug.
  await settle(() => banner.shown >= 2);
  hold.stop.resolve();
  await stopping;
  await again;
  assert.equal(desktop.controlOf("local"), "agent");
  assert.equal(banner.visible, true, "the new desktop has its notice");
});

test("the notice on a Mac or Linux is the app's own window, with Take over words, and the app hands its window maker in", async (t) => {
  const made = [];
  const factory = async (closed, notice) => {
    const window = { showing: true, close() { this.showing = false; } };
    made.push({ closed, notice, window });
    return window;
  };
  const banner = new TakeOverBanner(undefined, { platform: "linux", window: factory });
  let takenOver = 0;
  await banner.show(() => { takenOver += 1; });
  assert.deepEqual(made[0].notice, takeOverNotice);
  made[0].closed(); // the owner pressed Take over
  assert.equal(takenOver, 1);
  const page = decodeURIComponent(bannerPage(takeOverNotice));
  assert.match(page, />Take over</);
  assert.doesNotMatch(page, />Stop</);

  const root = await mkdtemp(join(tmpdir(), "branch-shared-desktop-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), bannerWindow: factory,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.linuxDesktop.banner.options.window, factory, "createBranch hands its notice window maker to the shared desktop");
});

// -------------------------------------------------------------- review 2 (Mac mini): each fix guarded on its own

test("taking over stops a command the assistant already has running, not only the next one", async (t) => {
  const { app } = await fixture(t);
  const { desktop } = sandboxFixture(app);
  await desktop.start("local");
  const plain = desktop.runner;
  // The typed text hangs until something aborts it, as a long xdotool run would.
  desktop.runner = (file, args, timeoutMs, signal) => args.includes("type")
    ? new Promise((resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    : plain(file, args, timeoutMs, signal);
  const acting = desktop.act("local", { type: "type", text: "a long message" });
  await new Promise((resolve) => setImmediate(resolve));
  await desktop.takeOver("local");
  const settled = await Promise.race([acting.then(() => "ran", (error) => error.message), new Promise((resolve) => setTimeout(() => resolve("still running"), 2000))]);
  assert.notEqual(settled, "still running", "the running command was stopped");
  assert.notEqual(settled, "ran");
});

test("an in-flight action rejects with takenOverMessage when the owner takes over during its execution", async (t) => {
  const { app } = await fixture(t);
  const { desktop } = sandboxFixture(app);
  await desktop.start("local");
  const plain = desktop.runner;
  // The typed text hangs until something aborts it, as a long xdotool run would.
  desktop.runner = (file, args, timeoutMs, signal) => args.includes("type")
    ? new Promise((resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    : plain(file, args, timeoutMs, signal);
  const acting = desktop.act("local", { type: "type", text: "a long message" });
  await new Promise((resolve) => setImmediate(resolve));
  await desktop.takeOver("local");
  await assert.rejects(acting, (error) => {
    assert.equal(error.message, takenOverMessage);
    return true;
  });
});

test("a new action called while pkill is hanging rejects with takenOverMessage and never reaches the runner", async (t) => {
  const { app } = await fixture(t);
  const { desktop } = sandboxFixture(app);
  await desktop.start("local");
  const plain = desktop.runner;
  const execCalls = [];
  // Track exec calls and make pkill hang
  desktop.runner = (file, args, timeoutMs, signal) => {
    if (args[0] === "exec") execCalls.push({ args });
    // Make pkill hang until the test resolves it
    if (args[4] === "pkill") {
      return new Promise(() => {}); // never resolves
    }
    return plain(file, args, timeoutMs, signal);
  };
  // Start takeOver without awaiting it so it gets stuck on pkill
  const takingOver = desktop.takeOver("local");
  // Give takeOver a chance to get to the pkill call
  await new Promise((resolve) => setImmediate(resolve));
  // Now try to act while pkill is hanging
  await assert.rejects(desktop.act("local", { type: "type", text: "hello" }), (error) => {
    assert.equal(error.message, takenOverMessage);
    return true;
  });
  // Verify the exec call for the act never happened (only the pkill is in the list)
  const typeExecCalls = execCalls.filter((call) => call.args.some((arg) => arg.includes("type")));
  assert.equal(typeExecCalls.length, 0, "the act never reached the runner");
});

test("the programs the shared desktop starts get their arguments as they are, with no shell to read them", { skip: process.platform === "win32" && "a POSIX echo is used" }, async (t) => {
  const { runProgram } = await import("../dist/integrations/linux-desktop.js");
  const root = await mkdtemp(join(tmpdir(), "branch-shared-desktop-shell-"));
  t.after(() => discardTemp(root));
  const marker = join(root, "made-by-a-shell");
  const said = await runProgram("/bin/echo", [`a; touch ${marker}`], 5000);
  assert.equal(said.trim(), `a; touch ${marker}`);
  await assert.rejects(readFile(marker), /ENOENT/, "no shell ran the second command");
});

test("somebody switched in on this computer cannot read the viewer password", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  const call = async (path, body) => {
    const response = await fetch(server.url + path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  const kim = app.store.profiles.create({ name: "Kim", pin: "1234" });
  assert.equal((await call("/api/profiles/switch", { profileId: kim.id, pin: "1234" })).status, 200);
  const answer = await call("/api/linux-desktop/viewer");
  assert.notEqual(answer.status, 200);
  assert.match(answer.text, /belongs to the owner/, "refused as the owner's, not only because nothing is running");
});

// -------------------------------------------------------------- Q94 desktop minors: banner race and long types

/** A notice window whose making is held until the test lets it go, so a take-over, a stop or a hand-back can land meanwhile. */
function heldWindows() {
  const waiting = [], made = [];
  const factory = (closed) => new Promise((resolve) => waiting.push(() => {
    const window = { showing: true, close() { this.showing = false; } };
    made.push(window);
    resolve(window);
  }));
  return { factory, made, release: () => { for (const go of waiting.splice(0)) go(); } };
}

test("Q94(a) A1: a take-over while start's notice is still being made refuses the start, and no notice stays up", async (t) => {
  const { app } = await fixture(t);
  const windows = heldWindows();
  const { desktop, banner } = heldFixture(app, undefined, windows.factory);
  const starting = desktop.start("local");
  await settle(() => desktop.controlOf("local") === "agent");
  await desktop.takeOver("local");
  windows.release();
  await assert.rejects(starting, (error) => { assert.equal(error.message, takenOverMessage); return true; });
  assert.equal(banner.visible, false, "the notice made after the take-over was closed");
  assert.equal(windows.made.every((window) => !window.showing), true);
});

test("Q94(a) A2: a stop while the hand-back's notice is still being made leaves no notice up", async (t) => {
  const { app } = await fixture(t);
  const windows = heldWindows();
  const { desktop, banner } = heldFixture(app, undefined, windows.factory);
  const starting = desktop.start("local");
  await settle(() => desktop.controlOf("local") === "agent");
  windows.release();
  await starting;
  await desktop.takeOver("local");
  const handingBack = desktop.handBack("local");
  await settle(() => desktop.controlOf("local") === "agent");
  await desktop.stop("local");
  windows.release();
  await handingBack.catch(() => undefined);
  assert.equal(desktop.controlOf("local"), "none");
  assert.equal(banner.visible, false, "the notice asked for before the stop is not left up after it");
});

test("Q94(a): a stop while the first notice is still being made refuses the start as not running", async (t) => {
  const { app } = await fixture(t);
  const windows = heldWindows();
  const { desktop, banner } = heldFixture(app, undefined, windows.factory);
  const starting = desktop.start("local");
  await settle(() => desktop.controlOf("local") === "agent");
  // A stop waits for the start under way to finish (it takes its own container down), so the notice is let go after it is asked.
  const stopping = desktop.stop("local");
  windows.release();
  await stopping;
  await assert.rejects(starting, (error) => { assert.equal(error.message, notRunningMessage); return true; });
  assert.equal(banner.visible, false);
});

test("Q94(b): a type that fails on its own kills xdotool before act reports it; one a take-over stopped does not", async (t) => {
  const { app } = await fixture(t);
  const { desktop } = sandboxFixture(app);
  await desktop.start("local");
  const plain = desktop.runner;
  const order = [];
  let held = null;
  desktop.runner = (file, args, timeoutMs, signal) => {
    if (args[4] === "pkill") { order.push("pkill"); return Promise.resolve(""); }
    if (args[0] === "exec" && args.includes("type")) {
      order.push("type");
      if (held) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return Promise.reject(new Error("Command failed"));
    }
    return plain(file, args, timeoutMs, signal);
  };
  await assert.rejects(desktop.act("local", { type: "type", text: "hello" }), /Command failed/);
  assert.deepEqual(order, ["type", "pkill"], "the pkill ran before act rejected");
  order.length = 0;
  held = true;
  const acting = desktop.act("local", { type: "type", text: "hello" });
  await new Promise((resolve) => setImmediate(resolve));
  await desktop.takeOver("local");
  await assert.rejects(acting, (error) => { assert.equal(error.message, takenOverMessage); return true; });
  assert.deepEqual(order, ["type", "pkill"], "only the take-over's own pkill, none of act's");
});

test("Q94: a Take over pressed while a hand-back waits wins, and the assistant does not get the desktop", async (t) => {
  const { desktop, release } = await heldPkill(t);
  const first = desktop.takeOver("local");
  await new Promise((resolve) => setImmediate(resolve));
  const handingBack = desktop.handBack("local");
  await new Promise((resolve) => setImmediate(resolve));
  const second = desktop.takeOver("local");
  release();
  await first; await handingBack; await second;
  assert.equal(desktop.controlOf("local"), "user", "the last press was Take over");
  await assert.rejects(desktop.act("local", { type: "type", text: "x" }), (error) => { assert.equal(error.message, takenOverMessage); return true; });
});

test("B: long type timeout scales with text length, up to 65 s", async (t) => {
  assert.equal(execTimeoutMs({ type: "key", chord: "Return" }), 15_000, "key should use 15s");
  assert.equal(execTimeoutMs({ type: "open", app: "xterm" }), 15_000, "open should use 15s");

  // 100 chars: 5000 + 100*15 = 6500
  assert.equal(execTimeoutMs({ type: "type", text: "x".repeat(100) }), 6_500, "100 chars");
  // 1000 chars: 5000 + 1000*15 = 20000
  assert.equal(execTimeoutMs({ type: "type", text: "x".repeat(1000) }), 20_000, "1000 chars");
  // 4000 chars (the most desktop.shared.type takes): 5000 + 4000*15 = 65000
  assert.equal(execTimeoutMs({ type: "type", text: "x".repeat(4000) }), 65_000, "4000 chars");
  // Longer text is capped at the same 65 s.
  assert.equal(execTimeoutMs({ type: "type", text: "x".repeat(5000) }), 65_000, "5000 chars, capped");
});

test("B: act uses scaled timeout for long types", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls, ran } = heldFixture(app);
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  await desktop.start("local");

  // Type with 1000 characters should use ~20s timeout
  const longText = "x".repeat(1000);
  await desktop.act("local", { type: "type", text: longText });

  const typeCalls = ran("exec").filter((call) => call.args.includes("type"));
  assert.ok(typeCalls.length > 0, "type was executed");
  const typeCall = typeCalls[0];
  const timeoutMs = typeCall.timeoutMs;
  assert.ok(timeoutMs >= 20_000, `timeout ${timeoutMs}ms should be at least 20s for 1000 chars`);
});

test("B: dockerExecKillArgv has the correct pkill argv for xdotool", () => {
  const killArgv = dockerExecKillArgv("abcdef012341");
  assert.deepEqual(killArgv, ["exec", "-e", "DISPLAY=:1", "abcdef012341", "pkill", "-x", "xdotool"]);
});

/** Q96: a desktop whose take-over pkill is held until the test lets it go, with the notice's shows and hides in order. */
async function heldPkill(t) {
  const { app } = await fixture(t);
  const { desktop } = sandboxFixture(app);
  const banner = desktop.banner, notice = [];
  banner.show = async () => { notice.push("show"); };
  banner.hide = async () => { notice.push("hide"); };
  await desktop.start("local");
  const plain = desktop.runner;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  desktop.runner = (file, args, timeoutMs, signal) => (args[4] === "pkill" ? held.then(() => "") : plain(file, args, timeoutMs, signal));
  return { app, desktop, notice, release: () => release() };
}

test("Q96: a hand-back while the take-over's pkill is held waits for it, and the notice shown last stays", async (t) => {
  const { desktop, notice, release } = await heldPkill(t);
  const takingOver = desktop.takeOver("local");
  await new Promise((resolve) => setImmediate(resolve));
  const handingBack = desktop.handBack("local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(desktop.controlOf("local"), "user", "the hand-back waits for the take-over under way");
  notice.length = 0;
  release();
  await takingOver; await handingBack;
  assert.equal(desktop.controlOf("local"), "agent");
  assert.deepEqual(notice, ["hide", "show"], "the take-over's hide comes before the hand-back's notice, never after");
});

test("Q96: a take-over that lands after the desktop was switched off and started again leaves the new notice alone", async (t) => {
  const { app, desktop, notice, release } = await heldPkill(t);
  const takingOver = desktop.takeOver("local");
  await new Promise((resolve) => setImmediate(resolve));
  saveLinuxDesktop(app.store, "local", { mode: "off" });
  await desktop.act("local", { type: "key", chord: "Return" }).catch(() => undefined);
  assert.equal(desktop.controlOf("local"), "none", "switching off ended the desktop the owner held");
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  await desktop.start("local");
  assert.equal(desktop.controlOf("local"), "agent");
  notice.length = 0;
  release();
  await takingOver;
  assert.deepEqual(notice, [], "the old take-over does not hide the new desktop's notice");
});
