// A coding assistant's sign-in finished by hand: `claude auth login` prints its sign-in page's address and reads one
// pasted code. Branch keeps only that address, and only on the maker's own sign-in page; it forwards one pasted line,
// only to a sign-in that is running, only from the app on this computer and never under Lockdown; a program that ends
// or closes its input never takes the engine down with it. Codex, which reads nothing typed into it, is given no input.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { checkProgram, pasteSignInCode, signInAddress, startLogin, startProgramSignIn, stopProgramSignIn } from "../dist/accounts/sign-ins.js";
import { hereOnly } from "../dist/remote/window-key.js";

const PAGE = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc";
/** The address line as the program prints it when it draws a terminal link, with colours. */
const linked = (url) => `If the browser didn't open, visit: \x1b]8;;${url}\x07\x1b[94m${url}\x1b[39m\x1b]8;;\x07`;

/** Writes a stand-in `claude` into `root` that runs `script` (CommonJS), on Windows as npm's launcher would. */
async function standIn(root, script) {
  if (process.platform === "win32") {
    await writeFile(join(root, "fake-cli.js"), script);
    await writeFile(join(root, "claude.cmd"), '@"%dp0%\\fake-cli.js" %*\r\n');
  } else {
    await writeFile(join(root, "claude"), "#!/usr/bin/env node\n" + script);
    await chmod(join(root, "claude"), 0o755);
  }
}
/**
 * A sign-in that prints `junk` bytes, then the address and the prompt, and writes the line it is given to got.txt. It
 * reads its input only once all it printed has been taken, as a program blocked on a full pipe would.
 */
const signInScript = (junk = 0) => `const fs = require("fs"), path = require("path");
process.stdout.write("x".repeat(${junk}) + "\\n");
process.stdout.write("Opening browser to sign in\\u2026\\n");
process.stdout.write(${JSON.stringify(linked(PAGE))} + "\\n");
process.stdout.write("Paste code here if prompted > ", () => {
  require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
    fs.writeFileSync(path.join(__dirname, "got.txt"), line);
    process.exit(line === "abc123#state456" ? 0 : 3);
  });
});
`;

/** Asks `fn` again until it answers, for at most `ms`. */
async function until(fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** An engine whose PATH holds only the stand-in (and node), plus its accounts service. */
async function engine(t, script) {
  const root = await mkdtemp(join(tmpdir(), "sign-in-code-"));
  const saved = process.env.PATH;
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  t.after(async () => { process.env.PATH = saved; await app.close(); await discardTemp(root); });
  if (script) await standIn(root, script);
  process.env.PATH = [root, dirname(process.execPath)].join(delimiter);
  return { app, root, service: accountsServiceFor(app.runtime.models) };
}
const notSignedIn = async () => ({ code: 1, missing: false });

test("only the maker's own sign-in page is taken from what the program prints", () => {
  assert.equal(signInAddress("claude-code", linked(PAGE)), PAGE, "a terminal link with colours");
  assert.equal(signInAddress("claude-code", `If the browser didn't open, visit: ${PAGE}\r`), PAGE, "plain");
  const platform = "https://platform.claude.com/oauth/authorize?code=true&state=s";
  assert.equal(signInAddress("claude-code", `If the browser didn't open, visit: ${platform}`), platform);
  for (const other of ["http://claude.com/cai/oauth/authorize?x=1", "https://claude.com.evil.example/cai/oauth/authorize",
    "https://evil.example/oauth/authorize", "https://user:pw@claude.com/cai/oauth/authorize", "https://claude.com:8443/cai/oauth/authorize",
    "https://claude.com/somewhere/else", "https://claude.com/cai/oauth/authorize/../../x"])
    assert.equal(signInAddress("claude-code", `If the browser didn't open, visit: ${other}`), null, other);
  assert.equal(signInAddress("claude-code", PAGE), null, "only the program's own address line");
  assert.equal(signInAddress("codex", `If the browser didn't open, visit: ${PAGE}`), null, "codex takes no code");
});

test("the page is shown while the sign-in runs, and the pasted code reaches the program, which finishes", async (t) => {
  const { root, service } = await engine(t, signInScript());
  const started = await startProgramSignIn({ service }, { id: "claude-code" }, notSignedIn);
  t.after(() => stopProgramSignIn({ service }, { id: "claude-code" }));
  assert.equal(started.signingIn, true);
  const shown = await until(async () => { const now = await checkProgram({ service }, { id: "claude-code" }, notSignedIn); return now.url ? now : null; });
  assert.equal(shown?.url, PAGE);
  assert.equal(shown.takesCode, true);
  for (const bad of ["abc123#state456\nsecond", "abc 123#state", "no-hash", "#state", "abc#", "a#b\r"])
    await assert.rejects(pasteSignInCode({ service }, { id: "claude-code", code: bad }), (error) => Array.isArray(error.issues), JSON.stringify(bad));
  assert.deepEqual(await pasteSignInCode({ service }, { id: "claude-code", code: "abc123#state456" }), { id: "claude-code", sent: true });
  assert.equal(await until(() => readFile(join(root, "got.txt"), "utf8").catch(() => "")), "abc123#state456");
  const ended = await until(async () => { const now = await checkProgram({ service }, { id: "claude-code" }, notSignedIn); return now.signingIn ? null : now; });
  assert.equal(ended.signingIn, undefined);
  assert.doesNotMatch(ended.message, /ended without signing in/, "it finished with exit 0");
  await assert.rejects(pasteSignInCode({ service }, { id: "claude-code", code: "abc123#state456" }), /is not running/, "nothing to paste into once it ended");
});

test("a program that prints a lot never stalls; past the first 64 KB nothing it prints is kept", async (t) => {
  const { root, service } = await engine(t, signInScript(4 * 1024 * 1024));
  await startProgramSignIn({ service }, { id: "claude-code" }, notSignedIn);
  t.after(() => stopProgramSignIn({ service }, { id: "claude-code" }));
  // Its address comes after 4 MB, so it is not looked for; the program still reads its input.
  assert.equal(await until(async () => pasteSignInCode({ service }, { id: "claude-code", code: "abc123#state456" }).then(() => true, () => false)), true);
  assert.equal(await until(() => readFile(join(root, "got.txt"), "utf8").catch(() => "")), "abc123#state456");
  assert.equal((await checkProgram({ service }, { id: "claude-code" }, notSignedIn)).url, undefined);
});

test("a program that ends while a code is being sent: sending fails plainly and the engine stays up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sign-in-code-closed-"));
  t.after(() => discardTemp(root));
  // It never reads its input and ends a moment after it starts, so the lines sent meet a closed pipe.
  await standIn(root, 'process.stdout.write("ready\\n"); setTimeout(() => process.exit(0), 300);\n');
  const env = { PATH: [root, dirname(process.execPath)].join(delimiter), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const heard = [];
  const child = startLogin({ id: "claude-code", name: "Claude Code", command: "claude" }, ["auth", "login"], env, () => undefined, (line) => heard.push(line));
  t.after(() => child.stop());
  assert.ok(await until(() => heard.includes("ready")), "the program started");
  // Sent as fast as the event loop turns, so some lines are written after it ended and before Branch hears it closed.
  let sent = 0;
  const stopped = await new Promise((resolve) => {
    const end = Date.now() + 5_000;
    const tick = () => { if (!child.send("abc123#state456")) return resolve(true); sent++; if (Date.now() > end) return resolve(false); setImmediate(tick); };
    tick();
  });
  assert.equal(stopped, true, "sending stops once the program has ended");
  assert.ok(sent > 0, "lines were sent while it ran");
  // A pipe error arrives a turn later; the engine is still here to hear the program close.
  assert.ok(await until(async () => { await new Promise((resolve) => setImmediate(resolve)); return true; }));
});

test("codex, which reads nothing typed into it, gets no input and no reading of what it prints", async (t) => {
  const { root, service } = await engine(t);
  for (const name of ["codex", "codex.cmd"]) await writeFile(join(root, name), "", { mode: 0o755 });
  const heards = {};
  const launch = (row, _args, _env, _done, heard) => { heards[row.id] = heard; return { stop: () => undefined, send: null }; };
  await startProgramSignIn({ service }, { id: "codex" }, notSignedIn, launch);
  t.after(() => stopProgramSignIn({ service }, { id: "codex" }));
  assert.equal(heards.codex, undefined);
  await assert.rejects(pasteSignInCode({ service }, { id: "codex", code: "abc123#state456" }), /does not take a code from Branch/);
});

test("over HTTP the code is the owner's, from this computer's window only, and never under Lockdown", async (t) => {
  const { app, root, service } = await engine(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body, key = server.token, headers = {}) => {
    const response = await fetch(server.url + "/api/" + path, { method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const body = { id: "claude-code", code: "abc123#state456" };
  const idle = await call("accounts/sign-ins/code", body);
  assert.equal(idle.status, 409, JSON.stringify(idle.data));
  assert.match(idle.data.error, /sign-in is not running, so there is nothing to paste the code into/);
  assert.equal((await call("accounts/sign-ins/code", { ...body, code: "a\nb#c" })).status, 400);
  assert.equal((await call("accounts/sign-ins/code", { ...body, extra: 1 })).status, 400, "the body is strict");
  const door = await call("accounts/sign-ins/code", body, server.token, { "x-branch-tunnel": "1" });
  assert.equal(door.status, 403);
  assert.equal(door.data.error, hereOnly);
  const short = (await call("tokens", { scope: "run", minutes: 5 })).data.token;
  assert.ok((await call("accounts/sign-ins/code", body, short)).status >= 400, "a short-lived key is refused");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.ok((await call("accounts/sign-ins/code", body)).status >= 400, "a household person is refused");
  app.store.profiles.switch({ profileId: null });
  assert.equal((await call("lockdown", { on: true })).status, 200);
  const locked = await call("accounts/sign-ins/code", body);
  assert.equal(locked.status, 409);
  assert.match(locked.data.error, /^Lockdown is on/);
  assert.equal(service.deps.store, app.store);
});
