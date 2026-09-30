/**
 * mac7/r17-g (R17-061): a script that calls several Branch tools. Every call goes through the one
 * gate with the calling task's permissions; the script itself runs behind the wall. The macOS tests
 * start it for real behind macOS's own sandbox (`/usr/bin/sandbox-exec`, which changes nothing on
 * the computer), with a web server on this computer standing in for the internet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readScriptAnswer, ToolScripts } from "../dist/safety-extras/tool-scripts.js";
import { wslProbe, wslReadiness } from "../dist/integrations/wsl-held.js";
import { evaluateBud } from "../dist/seasons/bud-evaluation.js";
import { scriptAnswerMarker } from "../dist/safety-extras/script-host.js";

const mac = { skip: process.platform !== "darwin" && "macOS's own sandbox is only on macOS" };

test("only the host's marked last line is the script's answer", () => {
  assert.deepEqual(readScriptAnswer(`printed${scriptAnswerMarker}{"ok":true,"result":{"n":2}}\n`, []),
    { ok: true, result: { n: 2 }, calls: [], output: "printed" });
  assert.match(readScriptAnswer("it just stopped", []).error, /stopped without answering/);
  assert.match(readScriptAnswer(`${scriptAnswerMarker}not json\n`, []).error, /could not be read/);
});

async function served(t, steps = []) {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-scripts-"));
  let turn = 0;
  const provider = { name: "scripted", async complete() { return steps[Math.min(turn++, steps.length - 1)] ?? { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const looked = [], ran = [];
  app.registry.register({ name: "notes.lookup", permission: "memory.read", description: "look a note up",
    parameters: z.object({ q: z.string() }).strict(), execute: async ({ q }) => { looked.push(q); return { note: `about ${q}` }; } });
  if (!app.registry.names().includes("shell.execute"))
    app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "run",
      parameters: z.object({ executable: z.string(), args: z.array(z.string()).default([]) }).strict(),
      execute: async (args) => { ran.push(args.executable); return { ok: true }; } });
  const api = async (path, body) => (await fetch(server.url + path, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  return { app, api, root, looked, ran };
}

test("ships when needed; switched off refuses, and missing WSL explains setup", async (t) => {
  const { app, api } = await served(t);
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "x").id });
  assert.equal(app.registry.names().includes("tools.script"), true, "ships when needed: the tool is in the catalog");
  await api("/api/safety-extras/switch", { part: "tool-scripts", mode: "off" });
  await assert.rejects(app.safetyExtras.scripts.run({ source: "export default 1", tools: ["notes.lookup"], timeoutMs: 5000 }, context), /switched off/);
  assert.equal(app.registry.names().includes("tools.script"), false);
  await api("/api/safety-extras/switch", { part: "tool-scripts", mode: "on" });
  assert.equal(app.registry.names().includes("tools.script"), true);
  const windows = new ToolScripts({ host: app.runtime, registry: app.registry, unreadable: () => [],
    wallDeps: { platform: "win32", probe: async () => ({ missing: true, code: null, stdout: "", stderr: "" }) } });
  await assert.rejects(windows.run({ source: "export default 1", tools: ["notes.lookup"], timeoutMs: 5000 }, context), /WSL is not set up/);
});

const wslReady = process.platform === "win32" && await wslReadiness(wslProbe) === null;
test("Windows scripts use real WSL with gated RPC and cannot read Windows data or reach the network", { skip: !wslReady && "needs WSL Node and bubblewrap" }, async (t) => {
  const { app, api, root, looked } = await served(t);
  await api("/api/safety-extras/switch", { part: "tool-scripts", mode: "on" });
  const secret = join(root, "data", "secret.txt");
  await writeFile(secret, "private");
  const linuxSecret = secret.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "x").id });
  const source = `import { readFile } from 'node:fs/promises'; import { networkInterfaces } from 'node:os';
    export default async branch => ({ platform: process.platform, note: await branch.call('notes.lookup', { q: 'WSL' }),
      secret: await readFile(${JSON.stringify(linuxSecret)}, 'utf8').then(() => 'leaked', () => 'blocked'),
      network: await fetch('http://127.0.0.1:9', { signal: AbortSignal.timeout(1000) }).then(() => 'reached', () => 'blocked'),
      isolatedNetwork: Object.keys(networkInterfaces()).every(name => name === 'lo'),
      unnamed: await branch.call('files.write', {}).then(() => 'ran', () => 'blocked') });`;
  const result = await app.safetyExtras.scripts.run({ source, tools: ["notes.lookup"], timeoutMs: 60000 }, context);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { platform: "linux", note: { note: "about WSL" }, secret: "blocked", network: "blocked", isolatedNetwork: true, unnamed: "blocked" });
  assert.deepEqual(looked, ["WSL"]);
  const candidate = { source: "async function build(input, branch) { return branch.call('notes.lookup', input); }", tools: ["notes.lookup"] };
  const cases = [{ input: { q: "simulation" }, expected: "simulated", replies: [{ tool: "notes.lookup", args: { q: "simulation" }, result: "simulated" }] }];
  const evaluation = await evaluateBud(app.safetyExtras.scripts, candidate, undefined, cases, context);
  assert.equal(evaluation.promoted, true, JSON.stringify(evaluation));
  assert.deepEqual(looked, ["WSL"], "evaluation does not call the live tool");
  const undeclared = await evaluateBud(app.safetyExtras.scripts, { ...candidate, tools: ["files.read"] }, undefined, cases, context);
  assert.equal(undeclared.promoted, false);
});

// Kept apart from the refusals above so that the two of them still run on Windows: only the plan
// for a Mac's wall needs a computer whose own folders are POSIX paths.
test("what would be started is the wall with none of Branch's environment",
  { skip: process.platform === "win32" && "the macOS wall is planned around this computer's own folders, which are not POSIX paths here" }, async (t) => {
  const { app, api } = await served(t);
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "x").id });
  await api("/api/safety-extras/switch", { part: "tool-scripts", mode: "on" });

  process.env.BRANCH_TEST_ONLY_SECRET = "do-not-pass";
  t.after(() => { delete process.env.BRANCH_TEST_ONLY_SECRET; });
  let started;
  const fake = new ToolScripts({ host: app.runtime, registry: app.registry, unreadable: () => ["/branch-data"],
    wallDeps: { platform: "darwin", exists: async () => true, realpath: async (path) => path },
    start: (start) => {
      started = start;
      return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${scriptAnswerMarker}{"ok":true,"result":7}\n`)})`],
        { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    } });
  const answer = await fake.run({ source: "export default 7", tools: ["notes.lookup"], timeoutMs: 5000 }, context);
  assert.deepEqual(answer, { ok: true, result: 7, calls: [], output: "" });
  assert.equal(started.executable, "/usr/bin/sandbox-exec");
  assert.ok(started.args.includes("--max-old-space-size=256"));
  assert.equal(Object.keys(started.env).some((name) => name.startsWith("BRANCH_")), false, "no environment of Branch's");
  assert.equal(started.env.HOME, started.cwd, "its home is its own throwaway folder");
});

async function localSite(t) {
  const hits = [];
  const server = createServer((request, response) => { hits.push(request.url); response.end("reached"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { hits, url: `http://127.0.0.1:${server.address().port}/` };
}

const probe = (site, secret) => `import { readFile } from "node:fs/promises";
const attempt = async (work) => { try { return await work(); } catch (error) { return "refused: " + (error.code ?? error.cause?.code ?? error.message); } };
export default async (branch) => ({
  looked: await attempt(() => branch.call("notes.lookup", { q: "first" })),
  again: await attempt(() => branch.call("notes.lookup", { q: "second" })),
  unnamed: await attempt(() => branch.call("files.write", { path: "x", content: "y" })),
  itself: await attempt(() => branch.call("tools.script", { source: "1", tools: ["notes.lookup"] })),
  asked: await attempt(() => branch.call("shell.execute", { executable: "git", args: ["push"] })),
  web: await attempt(async () => (await fetch(${JSON.stringify(site)}, { signal: AbortSignal.timeout(3000) })).status),
  secret: await attempt(() => readFile(${JSON.stringify(secret)}, "utf8")),
  env: Object.keys(process.env).filter((name) => name.startsWith("BRANCH_")),
});
`;

test("macOS for real: calls go through the gate, and the script reaches no web, no data and no environment", mac, async (t) => {
  const { app, api, root, looked, ran } = await served(t);
  await api("/api/safety-extras/switch", { part: "tool-scripts", mode: "on" });
  await api("/api/policy", { preset: "ask-before-changes" });
  const site = await localSite(t);
  const secret = join(root, "data", "planted-secret.txt");
  await writeFile(secret, "top secret");
  process.env.BRANCH_TEST_ONLY_SECRET = "do-not-pass";
  t.after(() => { delete process.env.BRANCH_TEST_ONLY_SECRET; });
  const run = app.store.createRun(app.runtime.owner, "script");
  const context = app.runtime.context({ runId: run.id });
  const answer = await app.safetyExtras.scripts.run({ source: probe(site.url, secret),
    tools: ["notes.lookup", "shell.execute", "tools.script"], timeoutMs: 30_000 }, context);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const result = answer.result;
  assert.deepEqual(result.looked, { note: "about first" });
  assert.deepEqual(result.again, { note: "about second" });
  assert.match(result.unnamed, /files\.write was not named/);
  assert.match(result.itself, /tools\.script was not named/, "never a script from a script");
  assert.match(result.asked, /a script cannot stop to ask/);
  assert.match(String(result.web), /^refused/);
  assert.equal(result.secret, "refused: EPERM", "Branch's data folder is unreadable");
  assert.deepEqual(result.env, []);
  assert.deepEqual(looked, ["first", "second"]);
  assert.deepEqual(ran, [], "the asked-about command never ran");
  assert.deepEqual(site.hits, []);
  assert.deepEqual(answer.calls.map((call) => call.outcome), ["done", "done", "refused", "refused", "needs a yes"]);
  assert.equal(app.store.events(run.id).filter((event) => event.kind === "script.called").length, 3);
});

test("macOS for real: the model's script runs as a tool in a task, and a script that never ends is stopped", mac, async (t) => {
  const script = { source: "export default async (branch) => (await branch.call('notes.lookup', { q: 'from a task' })).note", tools: ["notes.lookup"] };
  const { app, api, looked } = await served(t, [
    { content: "", toolCalls: [{ id: "s1", name: "tools.script", arguments: JSON.stringify(script) }] },
    { content: "Done.", toolCalls: [] },
  ]);
  await api("/api/safety-extras/switch", { part: "tool-scripts", mode: "when-needed" });
  const run = await api("/api/run", { prompt: "use a script" });
  assert.equal(run.status, "completed", run.output);
  assert.deepEqual(looked, ["from a task"]);
  const finished = app.store.events(run.id).find((event) => event.kind === "tool.completed" && event.data.name === "tools.script");
  assert.ok(finished, "the script ran as a tool");
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "x").id });
  const started = Date.now();
  const stuck = await app.safetyExtras.scripts.run({ source: "while (true) {}", tools: ["notes.lookup"], timeoutMs: 1500 }, context);
  assert.equal(stuck.ok, false);
  assert.match(stuck.error, /stopped without answering/);
  assert.ok(Date.now() - started < 15_000);
});
