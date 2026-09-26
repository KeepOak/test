/**
 * accounts-wizard-plans: the sign-ins that could be made (GET /api/accounts/sign-ins), a program's own status command
 * (POST /api/accounts/sign-ins/check) and Google's sign-in for Gemini (POST /api/accounts/sign-ins/gemini), with several
 * accounts per connection switched off. No program is started: the status command is a stand-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ChatGPTAuth, FileTokenVault } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { checkProgram, programStatusArgs } from "../dist/accounts/sign-ins.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "accounts-sign-ins-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body) => {
    const response = await fetch(new URL(path, server.url), { method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test("the sign-ins are listed with the switch off, hold no account, and are the owner's", async (t) => {
  const { app, call } = await fixture(t);
  assert.equal((await call("GET", "/api/accounts")).body.mode, "off");
  const listed = await call("GET", "/api/accounts/sign-ins");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.programs.map((p) => p.id), ["claude-code", "codex", "copilot", "gemini-cli"]);
  assert.deepEqual(listed.body.programs.map((p) => p.label), ["Claude Code", "Codex", "GitHub Copilot CLI", "Gemini CLI"]);
  assert.equal(listed.body.gemini.signInSetUp, false, "no Google client id saved, so Gemini takes a key");
  assert.equal(JSON.stringify(listed.body).includes("accounts"), false, "no account is in it");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.ok((await call("GET", "/api/accounts/sign-ins")).status >= 400, "a household person sees none of the owner's sign-ins");
  assert.ok((await call("POST", "/api/accounts/sign-ins/check", { id: "claude-code" })).status >= 400);
  app.store.profiles.switch({ profileId: null });
  assert.equal((await call("POST", "/api/accounts/sign-ins/check", { id: "claude-code", extra: 1 })).status, 400, "the body is strict");
  const google = await call("POST", "/api/accounts/sign-ins/gemini", {});
  assert.ok(google.status >= 400 && /No Google sign-in is set up/.test(google.body.error), "Google sign-in needs the owner's saved client id");
});

test("a program's sign-in is read from its own documented status command, and only where it has one", async (t) => {
  const { app } = await fixture(t);
  const service = accountsServiceFor(app.runtime.models);
  const seen = [];
  const exits = (code) => async (row, args, env) => { seen.push({ command: row.command, args: [...args], home: env.CLAUDE_CONFIG_DIR }); return { code, missing: false }; };
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = "";
  const absent = await checkProgram({ service }, { id: "claude-code" }, exits(0));
  assert.equal(absent.installed, false);
  assert.match(absent.message, /"claude" is not on this computer/);
  assert.equal(seen.length, 0, "nothing is started for a program that is not on the path");
  assert.deepEqual(programStatusArgs, { "claude-code": ["auth", "status"], codex: ["login", "status"] });
  await assert.rejects(checkProgram({ service }, { id: "nope" }, exits(0)), /does not know a coding assistant/);
  // Present on the path (onPath only looks for the file; the stand-in answers instead of the program).
  const bin = await mkdtemp(join(tmpdir(), "accounts-sign-ins-bin-"));
  t.after(() => discardTemp(bin));
  for (const name of ["claude", "claude.cmd", "gemini", "gemini.cmd"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  process.env.PATH = bin;
  assert.equal((await checkProgram({ service }, { id: "claude-code" }, exits(0))).signedIn, true);
  const out = await checkProgram({ service }, { id: "claude-code" }, exits(1));
  assert.equal(out.signedIn, false);
  assert.match(out.message, /is not signed in/);
  assert.equal((await checkProgram({ service }, { id: "claude-code" }, exits(7))).signedIn, null, "any other answer is not guessed at");
  await checkProgram({ service }, { id: "claude-code", account: "0a1b2c3d" }, exits(0));
  assert.deepEqual(seen.at(-1), { command: "claude", args: ["auth", "status"], home: service.homeOf("cli-claude-code", "0a1b2c3d") });
  const before = seen.length;
  const gemini = await checkProgram({ service }, { id: "gemini-cli" }, exits(0));
  assert.equal(gemini.signedIn, null, "Gemini CLI documents no status command, so Branch cannot tell");
  assert.equal(seen.length, before, "and it is not started to find out");
});

test("a coding assistant the owner added comes back after a restart, and one taken out stays out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accounts-sign-ins-restart-"));
  let engine = null;
  t.after(async () => { await engine?.close(); await discardTemp(root); });
  const open = async () => {
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
    const call = async (method, path, body) => {
      const response = await fetch(new URL(path, server.url), { method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    let closed = false;
    return { app, call, close: async () => { if (closed) return; closed = true; await server.close(); await app.close(); } };
  };
  engine = await open();
  assert.equal((await engine.call("POST", "/api/providers/cli-agents", { id: "claude-code" })).status, 200);
  assert.ok((await engine.call("POST", "/api/providers/cli-agents", { id: "custom-bad" })).status >= 400, "the add route's checks still refuse an unknown program with no command");
  await engine.close();
  engine = await open();
  assert.ok(engine.app.runtime.models.presets.has("cli-claude-code"), "Claude Code is a connection again after the restart");
  const lists = (await engine.call("GET", "/api/accounts")).body;
  assert.equal(lists.mode, "off");
  assert.ok(lists.pools.some((pool) => pool.pool === "cli-claude-code"), "and its list is back with several accounts per connection off");
  assert.equal((await engine.call("GET", "/api/accounts/sign-ins")).body.programs.find((p) => p.id === "claude-code").connected, true);
  assert.equal((await engine.call("POST", "/api/connections/forget", { id: "cli-claude-code" })).status, 200);
  await engine.close();
  engine = await open();
  assert.equal(engine.app.runtime.models.presets.has("cli-claude-code"), false, "a connection taken out stays out");
});

test("Gemini signed in with Google comes back after a restart while its client id and sign-in are kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accounts-sign-ins-gemini-"));
  const first = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = first.runtime.owner;
  first.store.save("settings", owner, "gemini-signin", { clientId: "stand-in.apps.example", model: "gemini-2.5-flash" });
  const later = new Date(Date.now() + 3_600_000).toISOString();
  await first.store.secrets.put(owner, "default", "OAUTH_GOOGLE_GEMINI",
    JSON.stringify({ accessToken: "stand-in-token", refreshToken: null, tokenType: "Bearer", expiresAt: later, scope: null, obtainedAt: new Date().toISOString() }));
  assert.equal(first.runtime.models.presets.has("google-gemini"), false);
  await first.close();
  const again = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await again.close(); await discardTemp(root); });
  for (let i = 0; i < 50 && !again.runtime.models.presets.has("google-gemini"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(again.runtime.models.presets.has("google-gemini"), "the Gemini sign-in is a connection again");
});

test("GET /api/chatgpt/status is the owner's alone: short-lived keys and household people are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accounts-sign-ins-status-"));
  const chatgpt = new ChatGPTAuth(new FileTokenVault(join(root, "chatgpt-auth.json")));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), chatgpt });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const get = (key) => fetch(new URL("/api/chatgpt/status", server.url), { headers: { authorization: `Bearer ${key}` } }).then((r) => r.status);
  assert.equal(await get(server.token), 200, "the owner reads it");
  for (const scope of ["read", "run"])
    assert.ok(await get(app.sessionTokens.create(app.runtime.owner, { name: scope, scope, minutes: 5 }).token) >= 400, `a ${scope} key is refused`);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.ok(await get(server.token) >= 400, "a household person is refused");
  app.store.profiles.switch({ profileId: null });
});
