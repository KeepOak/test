import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { outsideCaller } from "../dist/outside-commands.js";

/**
 * RES-253: a command asked for by someone other than the owner is held to the workspace with no network behind the
 * system's own wall, or refused where no wall can run; the owner's own work keeps Full Access.
 */
const gitPath = (() => { try { return execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim(); } catch { return null; } })();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-outside-commands-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  const config = join(root, "integrations.json");
  const executables = { node: { path: process.execPath, args: [] }, ...(gitPath ? { git: { path: gitPath, args: [] } } : {}) };
  await writeFile(config, JSON.stringify({ shell: { executables, timeoutMs: 60000 } }));
  const integrations = await loadIntegrations(app.registry, config, process.env, app.secretsFor, app.channelHost);
  t.after(async () => { await integrations.close(); await app.close(); await discardTemp(root); });
  /** A task started as `started` says (run.started's own record), then one tool call in it. */
  const asTask = async (started, name, args) => {
    const run = app.store.createRun(app.runtime.owner, "a command");
    app.store.event(run.id, "run.started", { source: "owner", ...started });
    try { return { run, result: await app.registry.execute(name, args, app.runtime.context({ runId: run.id })) }; }
    catch (error) { return { run, error: error instanceof Error ? error.message : String(error) }; }
  };
  return { app, root, workspace, asTask };
}

test("who counts as someone other than the owner is read from where the task came from", () => {
  const base = { shortLivedKey: false, source: "owner", permissions: null, parentRunId: null, keyIds: [], personProfileId: null, lentTo: null };
  assert.equal(outsideCaller(base), null, "the owner's own task");
  for (const source of ["schedule", "trigger", "channel"]) assert.equal(outsideCaller({ ...base, source }), null, `the owner's ${source}`);
  assert.equal(outsideCaller({ ...base, personProfileId: "p1" }), "a household person");
  assert.equal(outsideCaller({ ...base, shortLivedKey: true }), "a key");
  for (const source of ["a2a", "mcp", "acp"]) assert.match(outsideCaller({ ...base, source }), /another program/);
});

test("a household person's command cannot write outside the workspace or reach the network; it is walled or refused", async (t) => {
  const { app, root, asTask } = await fixture(t);
  const listener = createServer((socket) => { reached.push("connection"); socket.destroy(); });
  const reached = [];
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise((done) => listener.close(done)));
  const port = listener.address().port;
  const script = `const fs=require("fs"),net=require("net");let w="blocked";try{fs.writeFileSync("../escaped.txt","x");w="written"}catch{}`
    + `const s=net.connect(${port},"127.0.0.1");s.on("connect",()=>{console.log("net=open write="+w);process.exit(0)});`
    + `s.on("error",()=>{console.log("net=blocked write="+w);process.exit(0)});setTimeout(()=>{console.log("net=timeout write="+w);process.exit(0)},3000)`;
  const { run, result, error } = await asTask({ personProfileId: "p1" }, "shell.execute", { executable: "node", args: ["-e", script] });
  assert.equal(existsSync(join(root, "escaped.txt")), false, "nothing was written outside the workspace");
  assert.deepEqual(reached, [], "and the network was not reached");
  assert.ok(app.store.events(run.id).some((event) => event.kind === "sandbox.outside_caller"), "the hold is written down");
  if (error) assert.match(error, /WSL|bubblewrap|sandbox|wall|namespaces/i, `refused plainly where no wall can run: ${error}`);
  else assert.doesNotMatch(result.stdout, /net=open|write=written/, JSON.stringify(result));
  const program = await asTask({ shortLivedKey: true }, "code.run", { language: "javascript", source: "1" });
  assert.match(program.error ?? "", /not run for a key/, "a program other than a command is refused for someone else");
});

test("the owner's own task keeps Full Access: its node and git run as before, unwalled", async (t) => {
  const { root, asTask } = await fixture(t);
  const wrote = await asTask({}, "shell.execute", { executable: "node", args: ["-e", `require("fs").writeFileSync("../owner.txt","ok");console.log(process.version)`] });
  assert.equal(wrote.error, undefined, wrote.error);
  assert.equal(existsSync(join(root, "owner.txt")), true, "the owner's command may write where the owner can");
  assert.match(wrote.result.stdout, /^v\d+/);
  if (gitPath) {
    const git = await asTask({ source: "schedule" }, "shell.execute", { executable: "git", args: ["--version"] });
    assert.equal(git.error, undefined, git.error);
    assert.match(git.result.stdout, /git version/, "the owner's schedule runs git unwalled");
  }
});

const npmCli = (() => {
  try { return join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim(), "npm", "bin", "npm-cli.js"); } catch { return null; }
})();

test("the owner's own Trunk runs npm and git unwalled; a Trunk the owner set to run sandboxed is walled", async (t) => {
  const { app, root, asTask } = await fixture(t);
  const save = (id, sandboxed) => app.store.save("governance", app.runtime.owner, `trunk:${id}`,
    { name: id, reach: { channels: [], commands: true, sandboxed } });
  save("builder", false);
  save("careful", true);
  const asTrunk = async (trunk, args) => {
    const run = app.store.createRun(app.runtime.owner, "a Trunk's command");
    app.store.event(run.id, "run.started", { source: "owner" });
    try { return { run, result: await app.registry.execute("shell.execute", args, { ...app.runtime.context({ runId: run.id }), trunk }) }; }
    catch (error) { return { run, error: error instanceof Error ? error.message : String(error) }; }
  };
  if (npmCli && existsSync(npmCli)) {
    const npm = await asTrunk("builder", { executable: "node", args: [npmCli, "--version"] });
    assert.equal(npm.error, undefined, npm.error);
    assert.match(npm.result.stdout, /^\d+\.\d+\.\d+/m, "npm --version works for the owner's Trunk");
  }
  if (gitPath) {
    const git = await asTrunk("builder", { executable: "git", args: ["--version"] });
    assert.equal(git.error, undefined, git.error);
    assert.match(git.result.stdout, /git version/);
  }
  const free = await asTrunk("builder", { executable: "node", args: ["-e", `require("fs").writeFileSync("../builder.txt","ok")`] });
  assert.equal(free.error, undefined, free.error);
  assert.equal(existsSync(join(root, "builder.txt")), true, "the owner's Trunk keeps Full Access");
  const held = await asTrunk("careful", { executable: "node", args: ["-e", `try{require("fs").writeFileSync("../careful.txt","x")}catch{}`] });
  assert.equal(existsSync(join(root, "careful.txt")), false, "a sandboxed Trunk cannot write outside the workspace");
  assert.ok(app.store.events(held.run.id).some((event) => event.kind === "sandbox.outside_caller" && /sandboxed/.test(event.data.who)));
});

/* Q4: the owner's other computers are reached over SSH, which no wall here can hold, so only the owner's own work may use
   them. Mutation: take remoteTools out of the beforeTool check in src/index.ts and the refusals go. */
test("the owner's other computers are refused to anyone but the owner, and stay the owner's own", async (t) => {
  const { asTask } = await fixture(t);
  const own = await asTask({}, "remote.list", {});
  assert.equal(own.error, undefined, own.error);
  assert.deepEqual(own.result.computers, []);
  for (const [started, who] of [[{ personProfileId: "p1" }, /household person/], [{ shortLivedKey: true }, /a key/], [{ source: "a2a" }, /another program/], [{ lentTo: "profile:p2" }, /lent conversation/]])
    for (const tool of ["remote.list", "remote.run"]) {
      const { error } = await asTask(started, tool, tool === "remote.run" ? { computer: "tower", program: "ls", args: [] } : {});
      assert.match(error ?? "", /is not run for/, `${tool} for ${JSON.stringify(started)}`);
      assert.match(error ?? "", who);
    }
});

/* A restore cuts a Trunk down (src/trunks/restore-narrow.ts); "sandboxed" only tightens, so it stays as it was, and an
   older backup without it still restores. Mutation: drop sandboxed from HadSchema's reach and the first record is left
   out of the restore (null). */
test("a restored Trunk keeps running sandboxed, and one backed up before the flag still restores", async () => {
  const { narrowTrunk } = await import("../dist/trunks/restore-narrow.js");
  const walled = narrowTrunk(JSON.stringify({ name: "careful", reach: { channels: ["telegram"], commands: true, sandboxed: true } }));
  assert.ok(walled, "a Trunk with the flag is restored");
  assert.deepEqual(JSON.parse(walled.data).reach, { channels: [], commands: false, sandboxed: true });
  assert.equal(walled.held.had.reach.sandboxed, true);
  const older = narrowTrunk(JSON.stringify({ name: "older", reach: { channels: [], commands: false } }));
  assert.ok(older, "an older backup still restores");
  assert.equal(JSON.parse(older.data).reach.sandboxed, false);
});
