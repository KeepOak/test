import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";

/**
 * FQ-execution.host-bridge: the owner names a computer explicitly and gets back which computer the
 * program was sent to, right alongside what it said. The Settings card's door
 * (`src/host-bridge-api.ts`, `public/host-bridge.js`) runs `remote.run` through the same hand-pressed
 * gate as "Try a tool" (`/api/tools/try`): Lockdown, the owner's own rules, a household person's
 * role and the secret scrub all apply to it exactly as they do there.
 *
 * No SSH connection is ever made: `RemoteWorkspaces` takes an `SshRun` it calls instead, and the
 * fake here answers by which computer's alias appears on the command line — the only way to prove
 * the identity that comes back really tracks the computer that was asked, rather than being echoed
 * straight from the request. The fake stands behind both `app.remotes` and the registry's
 * `remote.*` tools, so whichever path the door takes, it can only ever reach the fake.
 */

const owner = "local";
const GITHUB_TOKEN = "ghp_aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5"; // not-a-real-secret

/** The owner's own SSH files, written where the test can point at them; never touched otherwise. */
async function sshHome(root, config, knownHosts) {
  const folder = join(root, `ssh-${Math.random().toString(36).slice(2)}`);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "config"), config, "utf8");
  await writeFile(join(folder, "known_hosts"), knownHosts, "utf8");
  return { config: join(folder, "config"), knownHosts: join(folder, "known_hosts") };
}

/**
 * A stand-in for the OpenSSH programs. It answers by whichever computer's alias is on the command
 * line, so two computers configured at once can never be told apart by coincidence.
 */
function fakeSshByHost(outputs) {
  const calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    const alias = Object.keys(outputs).find((name) => args.includes(name));
    return { status: "completed", stdout: alias ? outputs[alias] : "", stderr: "", exitCode: 0 };
  };
  return { calls, run };
}

/** A real Branch whose other computers are "tower" and "pi", both reached only through the fake. */
async function fixture(t, outputs = { tower: "built on tower\n", pi: "built on pi\n" }) {
  const root = await mkdtemp(join(tmpdir(), "branch-host-bridge-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const { createBranch } = await import("../dist/index.js");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const { RemoteWorkspaces, registerRemoteWorkspaces } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root,
    "Host tower\n  HostName tower.lan\nHost pi\n  HostName pi.lan\n",
    "tower.lan ssh-ed25519 AAAA\npi.lan ssh-ed25519 AAAA\n");
  const ssh = fakeSshByHost(outputs);
  const remotes = new RemoteWorkspaces(app.store, owner, ssh.run, home);
  await remotes.add({ alias: "tower", root: "/srv/work", executables: ["make"] });
  await remotes.add({ alias: "pi", root: "/srv/work", executables: ["make"] });
  for (const name of ["remote.list", "remote.files", "remote.read", "remote.run"]) app.registry.unregister(name);
  registerRemoteWorkspaces(app.registry, remotes);
  app.remotes = remotes;
  // Only the calls made after setup count; `remotes.add` itself never runs ssh, but be exact.
  ssh.calls.length = 0;
  return { app, root, ssh };
}

const { hostBridgeApi, handlesHostBridgePath, HostBridgeApiError } = await import("../dist/host-bridge-api.js");
const { savePolicy, setLockdown } = await import("../dist/index.js");
const request = { method: "POST" };
const bodyOf = (body) => async () => body;
const run = (app, body) => hostBridgeApi(app, request, "/api/host-bridge/run", bodyOf(body));
const rule = (app, decision) =>
  savePolicy(app.store, owner, { preset: "custom", rules: [{ tool: "remote.run", decision, remember: "always" }] });

test("FQ-execution.host-bridge: an explicitly chosen host's identity travels back with its result", async (t) => {
  const { app, ssh } = await fixture(t);
  rule(app, "allow");

  assert.equal(handlesHostBridgePath("/api/host-bridge/run"), true);
  assert.equal(handlesHostBridgePath("/api/host-bridge"), false);
  assert.equal(handlesHostBridgePath("/api/remotes"), false);

  // Asking "tower" explicitly gets tower's own answer back, with tower's own name on it.
  const fromTower = await run(app, { computer: "tower", program: "make", args: ["build"] });
  assert.equal(fromTower.computer, "tower");
  assert.equal(fromTower.program, "make");
  assert.equal(fromTower.output.trim(), "built on tower");

  // Asking "pi" explicitly — the other computer, same program — gets pi's own name and pi's own
  // answer, never tower's: the identity that comes back is asserted, not assumed.
  const fromPi = await run(app, { computer: "pi", program: "make", args: ["build"] });
  assert.equal(fromPi.computer, "pi");
  assert.equal(fromPi.output.trim(), "built on pi");
  assert.notEqual(fromPi.computer, fromTower.computer);
  assert.notEqual(fromPi.output, fromTower.output);

  // Every call actually named the computer it was asked to reach, on the wire, and no other.
  assert.equal(ssh.calls.length, 2);
  assert.ok(ssh.calls[0].args.includes("tower") && !ssh.calls[0].args.includes("pi"));
  assert.ok(ssh.calls[1].args.includes("pi") && !ssh.calls[1].args.includes("tower"));

  // A computer that was never added is refused plainly, not silently ignored.
  await assert.rejects(run(app, { computer: "nowhere", program: "make", args: [] }),
    (error) => error instanceof HostBridgeApiError && error.status === 400 && /not one of the computers/.test(error.message));

  // A program that computer was never allowed to run is refused, and names the computer.
  await assert.rejects(run(app, { computer: "tower", program: "ls", args: ["-la"] }),
    (error) => error instanceof HostBridgeApiError && /not one of the programs tower is allowed to run/.test(error.message));
  // One that reads as wrecking a folder is stopped even earlier, by the gate's own guard.
  await assert.rejects(run(app, { computer: "tower", program: "rm", args: ["-rf", "/"] }),
    (error) => error instanceof HostBridgeApiError && error.status === 403);

  // A malformed body, and the wrong method or address, are both refused before anything is asked.
  await assert.rejects(run(app, { computer: "tower" }),
    (error) => error instanceof HostBridgeApiError && error.status === 400);
  await assert.rejects(hostBridgeApi(app, { method: "GET" }, "/api/host-bridge/run", bodyOf({})),
    (error) => error instanceof HostBridgeApiError && error.status === 404);
  await assert.rejects(hostBridgeApi(app, request, "/api/host-bridge/other", bodyOf({})),
    (error) => error instanceof HostBridgeApiError && error.status === 404);

  assert.equal(ssh.calls.length, 2, "the refused calls never reached OpenSSH at all");
});

test("host-bridge: Lockdown refuses the card outright, whatever the rules say, and ssh is never called", async (t) => {
  const { app, ssh } = await fixture(t);
  setLockdown(app.store, owner, { on: true });
  rule(app, "allow"); // saved during Lockdown, as if the owner had tried to get round it
  await assert.rejects(run(app, { computer: "tower", program: "make", args: ["build"] }),
    (error) => error instanceof HostBridgeApiError && error.status === 403 && /Lockdown is on/.test(error.message));
  assert.equal(ssh.calls.length, 0, "Lockdown on: nothing reached OpenSSH");
});

test("host-bridge: the owner's own deny rule for remote.run is honoured, and ssh is never called", async (t) => {
  const { app, ssh } = await fixture(t);
  rule(app, "deny");
  await assert.rejects(run(app, { computer: "tower", program: "make", args: ["build"] }),
    (error) => error instanceof HostBridgeApiError && error.status === 403 && /remote\.run/.test(error.message));
  assert.equal(ssh.calls.length, 0, "a denied remote.run never reached OpenSSH");
});

test("host-bridge: with no rule of the owner's, for an owner who keeps commands asking, the card asks first and only runs once confirmed", async (t) => {
  const { app, ssh } = await fixture(t);
  // Owner ruling 2026-09-30: commands no rule covers ship as "allow"; this owner keeps them asking.
  const { savePolicy } = await import("../dist/policy.js");
  savePolicy(app.store, app.runtime.owner, { unmatchedCommands: "ask" });
  const asked = await run(app, { computer: "tower", program: "make", args: ["build"] });
  assert.equal(asked.status, "asked");
  assert.match(asked.question, /remote\.run/);
  assert.equal(ssh.calls.length, 0, "a question is not a yes");
  const ran = await run(app, { computer: "tower", program: "make", args: ["build"], confirm: true });
  assert.equal(ran.status, "ran");
  assert.equal(ran.computer, "tower");
  assert.equal(ran.output.trim(), "built on tower");
  assert.equal(ssh.calls.length, 1);
});

test("host-bridge: what the other computer printed is scrubbed of secrets before it comes back", async (t) => {
  const { app, ssh } = await fixture(t, { tower: `token=${GITHUB_TOKEN}\n` });
  rule(app, "allow");
  const answer = await run(app, { computer: "tower", program: "make", args: ["print-token"] });
  assert.equal(ssh.calls.length, 1);
  assert.equal(answer.computer, "tower");
  assert.ok(!answer.output.includes(GITHUB_TOKEN), `the raw key came back: ${answer.output}`);
  assert.match(answer.output, /hidden/);
});

test("host-bridge over HTTP: a short-lived key and a household profile are refused, and ssh is never called", async (t) => {
  const { app, root, ssh } = await fixture(t);
  rule(app, "allow");
  const { startServer } = await import("../dist/server.js");
  const { householdRefusalFor } = await import("../dist/household-routes.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  try { await overHttp(app, server, ssh, householdRefusalFor); } finally { await server.close(); }
});

async function overHttp(app, server, ssh, householdRefusalFor) {
  const call = (key, path, body) => fetch(server.url + path, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const body = { computer: "tower", program: "make", args: ["build"] };

  // A "run" key may start tasks, but this is the owner's own button: refused, and it cannot confirm.
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  for (const sent of [body, { ...body, confirm: true }]) {
    const refused = await call(key, "/api/host-bridge/run", sent);
    assert.equal(refused.status, 401, JSON.stringify(refused.body));
    assert.match(refused.body.error, /short-lived key/);
  }

  // The window switched to a household person meets the household sentence, confirm or not.
  const sam = (await call(server.token, "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call(server.token, "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  for (const sent of [body, { ...body, confirm: true }]) {
    const refused = await call(server.token, "/api/host-bridge/run", sent);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, householdRefusalFor("/api/host-bridge/run"));
  }
  assert.equal(ssh.calls.length, 0, "neither reached OpenSSH");

  // Switched back, the owner's own key still runs it, and the answer names the computer it ran on.
  assert.equal((await call(server.token, "/api/profiles/switch", { profileId: null })).status, 200);
  const ran = await call(server.token, "/api/host-bridge/run", body);
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.computer, "tower");
  assert.equal(ran.body.output.trim(), "built on tower");
  assert.equal(ssh.calls.length, 1);
}
