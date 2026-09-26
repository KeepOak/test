/**
 * eng-connectors: the connector catalogue and the owner's own MCP servers (a command asks through the approval gate
 * before it starts), command-line tools on this computer, What's new, and flagged replies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { mcpToolName } from "../dist/integrations/mcp.js";
import { OwnClis } from "../dist/own-clis.js";
import { launchFingerprint } from "../dist/mcp-own-servers.js";
import { notesFor, releaseNotesFile } from "../dist/release-notes.js";
import { mcpCatalogue } from "../dist/mcp-catalogue.js";

const notesServer = resolve("dist/examples/mcp-notes-server.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-engconn-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, root, ...server };
}
const api = (url, token, path, body) => fetch(`${url}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${token}`, origin: url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (response) => {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
});
const until = async (check, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("timed out");
};
const toolsOf = (app, id) => app.registry.names().filter((name) => name.startsWith(`mcp.${id}.`));
const notes = { name: "My notes", server: { transport: "stdio", command: process.execPath, args: [notesServer] } };

test("What's new: the notes for the installed version, and none for a version the file does not carry", async (t) => {
  const { app, url, token } = await fixture(t);
  const notesNow = await api(url, token, "/api/release-notes");
  assert.equal(notesNow.version, app.version);
  assert.ok(releaseNotesFile().releases.some((release) => release.version === app.version), "the shipped file has this version's notes");
  assert.ok(notesNow.items.length > 0);
  for (const item of notesNow.items) assert.match(item.act, /^[a-z0-9-]+$/);
  assert.deepEqual(notesFor("0.0.1").items, []);
});

test("the catalogue: every connector with what it needs, and no secret in it", () => {
  const file = mcpCatalogue();
  assert.equal(file.connectors.length, 52);
  assert.equal(new Set(file.connectors.map((entry) => entry.category)).size, 8);
  assert.equal(new Set(file.connectors.map((entry) => entry.id)).size, 52);
  for (const entry of file.connectors) {
    assert.ok(entry.needs.length > 0, entry.name);
    assert.doesNotMatch(JSON.stringify(entry), /token=|key=|secret=|password/i);
  }
});

test("a command server is saved off, starts only after the owner's yes, and asks again after it is switched off", async (t) => {
  const { app, url, token } = await fixture(t);
  const added = await api(url, token, "/api/mcp/servers", notes);
  const id = added.server.id;
  assert.equal(added.server.on, false, "a server that starts a program is saved off");
  assert.equal(toolsOf(app, id).length, 0, "nothing was started to add it");

  const asked = await api(url, token, `/api/mcp/servers/${id}/start`, {});
  assert.match(asked.said, /Before I go ahead: Start a program on this computer/);
  assert.equal(toolsOf(app, id).length, 0, "asking starts nothing");
  const question = (await api(url, token, "/api/policy")).waiting.find((q) => q.tool === "mcp.start");
  assert.ok(question && question.noStanding && question.noAlways, "only once or for the conversation may be answered");
  await assert.rejects(api(url, token, "/api/policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "always", fingerprint: question.fingerprint }));

  // The window answers with carryOn, as its approval cards do: the yes starts the program, never a model turn.
  const answered = await api(url, token, "/api/policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint, carryOn: true });
  assert.notEqual(answered.task, "carrying-on");
  await until(() => toolsOf(app, id).length === 2);
  assert.equal((await api(url, token, "/api/mcp/servers")).servers[0].on, true);
  assert.equal(app.store.runs(app.store.profiles.scope()).filter((run) => run.sessionId === question.sessionId).length, 1, "no other task started there");

  await api(url, token, `/api/mcp/servers/${id}/stop`, {});
  assert.equal(toolsOf(app, id).length, 0, "switching off takes its tools away");
  await api(url, token, `/api/mcp/servers/${id}/start`, {});
  const again = (await api(url, token, "/api/policy")).waiting.find((q) => q.tool === "mcp.start");
  assert.ok(again, "switching on again asks again");
  await api(url, token, "/api/policy/approve", { sessionId: again.sessionId, decision: "deny", remember: "never", fingerprint: again.fingerprint });
  await until(async () => (await api(url, token, "/api/mcp/servers")).servers[0].waiting === null);
  await new Promise((r) => setTimeout(r, 3000)); // time enough for a start that should not happen
  assert.equal(toolsOf(app, id).length, 0, "a no starts nothing");
  assert.equal((await api(url, token, "/api/mcp/servers")).servers[0].on, false);

  await api(url, token, `/api/mcp/servers/${id}/remove`, {});
  assert.deepEqual((await api(url, token, "/api/mcp/servers")).servers, []);
});

test("a yes from a household profile does not start it, and Lockdown refuses the start", async (t) => {
  const { app, url, token } = await fixture(t);
  const { server: { id } } = await api(url, token, "/api/mcp/servers", notes);
  await api(url, token, `/api/mcp/servers/${id}/start`, {});
  const question = (await api(url, token, "/api/policy")).waiting.find((q) => q.tool === "mcp.start");
  app.store.profiles.isOwner = () => false; // the window switched to a household person's profile
  // Q257: the owner's question is not a household person's to answer; the answer is refused before it lands.
  await assert.rejects(api(url, token, "/api/policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint }),
    /Nothing in this conversation is waiting for your answer/);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(toolsOf(app, id).length, 0, "only the owner's yes starts a program");
  delete app.store.profiles.isOwner;
  assert.ok((await api(url, token, "/api/policy")).waiting.some((q) => q.fingerprint === question.fingerprint), "the owner's question still waits");
  app.store.save("settings", app.runtime.owner, "lockdown", { on: true, since: new Date().toISOString(), before: {} });
  await assert.rejects(api(url, token, `/api/mcp/servers/${id}/start`, {}), /Lockdown is on/);
});

test("a yes holds across a restart only for the exact launch it was given for", async (t) => {
  const { app, url, token } = await fixture(t);
  const { server: { id } } = await api(url, token, "/api/mcp/servers", notes);
  await api(url, token, `/api/mcp/servers/${id}/start`, {});
  const question = (await api(url, token, "/api/policy")).waiting.find((q) => q.tool === "mcp.start");
  await api(url, token, "/api/policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint });
  await until(() => toolsOf(app, id).length === 2);

  await app.ownMcp.closeAll();
  assert.equal(toolsOf(app, id).length, 0);
  await app.ownMcp.startSaved([]);
  assert.equal(toolsOf(app, id).length, 2, "left on with the same launch, it starts again with Branch");

  await app.ownMcp.closeAll();
  const saved = app.store.get("settings", app.runtime.owner, "mcp-own-servers").data;
  saved.servers[0].server.args = [notesServer, "--changed"];
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", saved);
  await app.ownMcp.startSaved([]);
  assert.equal(toolsOf(app, id).length, 0, "a changed launch is not started on the old yes");
  assert.equal(app.ownMcp.saved()[0].on, false);
});

/* Review 2's probe: a yes is bound to the launch line, so a program in the workspace (where a task may write) could be
   swapped after the yes and run at the next start. Mutation: take `this.guard(entry.server)` out of `open()` in
   src/mcp-own-servers.ts and this goes red (the swapped script runs as Branch starts and writes the marker). */
test("a workspace program is refused when added, and one saved before is not started, as Branch starts or by a switch", async (t) => {
  const { app, root, url, token } = await fixture(t);
  const workspace = app.runtime.workspace, marker = join(root, "swapped-program-ran.txt");
  await mkdir(workspace, { recursive: true });
  const script = join(workspace, "srv.mjs");
  await writeFile(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nawait import(${JSON.stringify(pathToFileURL(notesServer).href)});\n`);
  const probe = { transport: "stdio", command: process.execPath, args: [script], envKeys: [] };
  await assert.rejects(api(url, token, "/api/mcp/servers", { name: "Probe", server: probe }), /a file inside the workspace/);
  assert.deepEqual(app.ownMcp.saved(), [], "nothing is saved");

  // Saved before this check existed, left on, with the owner's yes to this exact launch.
  const entry = { id: "probe", name: "Probe", server: probe, on: true, approved: launchFingerprint(probe), tools: [], version: null, hidden: [], addedAt: new Date().toISOString() };
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", { servers: [entry] });
  await app.ownMcp.startSaved([]);
  assert.equal(existsSync(marker), false, "the workspace program did not run as Branch started");
  assert.equal(toolsOf(app, "probe").length, 0);
  assert.equal(app.ownMcp.saved()[0].on, false);
  assert.match(app.ownMcp.list(true).servers[0].error, /a file inside the workspace/);
  assert.equal(app.runtime.approvals.waiting().length, 0, "and no question was asked");

  await assert.rejects(api(url, token, "/api/mcp/servers/probe/start", {}), /a file inside the workspace/);
  assert.equal(app.runtime.approvals.waiting().length, 0, "switching it on asks nothing: it is refused");
  assert.equal(existsSync(marker), false);
});

/* The same swap through a folder that is the program: `node <folder>` runs the folder's package. Mutation: take the
   `runsAFolder` check out of src/mcp-workspace-guard.ts and this goes red. */
test("a workspace folder given to node as the thing to run is refused, at add and as Branch starts", async (t) => {
  const { app, root, url, token } = await fixture(t);
  const folder = join(app.runtime.workspace, "srvdir"), marker = join(root, "swapped-folder-ran.txt");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  await writeFile(join(folder, "index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nawait import(${JSON.stringify(pathToFileURL(notesServer).href)});\n`);
  const probe = { transport: "stdio", command: process.execPath, args: [folder], envKeys: [] };
  await assert.rejects(api(url, token, "/api/mcp/servers", { name: "Probe", server: probe }), /the folder srvdir, inside the workspace/);
  const entry = { id: "probe", name: "Probe", server: probe, on: true, approved: launchFingerprint(probe), tools: [], version: null, hidden: [], addedAt: new Date().toISOString() };
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", { servers: [entry] });
  await app.ownMcp.startSaved([]);
  assert.equal(existsSync(marker), false, "the workspace folder's program did not run as Branch started");
  assert.equal(toolsOf(app, "probe").length, 0);
});

test("a workspace folder, program or file argument is refused; a folder argument is fine", async (t) => {
  const { app, url, token } = await fixture(t);
  const workspace = app.runtime.workspace, exe = process.platform === "win32" ? ".exe" : "";
  await mkdir(join(workspace, "bin"), { recursive: true });
  await writeFile(join(workspace, `planted${exe}`), "", { mode: 0o755 });
  await writeFile(join(workspace, "bin", `planted${exe}`), "", { mode: 0o755 });
  await writeFile(join(workspace, "settings.json"), "{}");
  const add = (server) => api(url, token, "/api/mcp/servers", { name: "Try", server: { transport: "stdio", ...server } });
  // npx in a workspace folder runs the workspace's node_modules/.bin first.
  await assert.rejects(add({ command: "npx", args: ["some-tool"], cwd: workspace }), /start in a folder inside the workspace/);
  await assert.rejects(add({ command: process.execPath, args: [notesServer], cwd: join(workspace, "bin") }), /start in a folder inside the workspace/);
  await assert.rejects(add({ command: join(workspace, `planted${exe}`) }), /program is inside the workspace/);
  await assert.rejects(add({ command: process.execPath, args: [notesServer, `--config=${join(workspace, "settings.json")}`] }), /settings\.json, a file inside the workspace/);
  const withPath = app.ownMcp.deps.env;
  app.ownMcp.deps.env = { ...process.env, PATH: join(workspace, "bin"), Path: join(workspace, "bin") };
  await assert.rejects(add({ command: "planted" }), /program is inside the workspace/, "a bare name found on PATH in the workspace");
  app.ownMcp.deps.env = withPath;
  const pointed = await add({ command: process.execPath, args: [notesServer, workspace] });
  assert.equal(pointed.server.on, false, "a server given the workspace folder itself is saved, off until the owner's yes");
});

test("only the owner at the window is shown what answering a start question takes", async (t) => {
  const { app, url, token } = await fixture(t);
  const { server: { id } } = await api(url, token, "/api/mcp/servers", notes);
  await api(url, token, `/api/mcp/servers/${id}/start`, {});
  const owner = (await api(url, token, "/api/mcp/servers")).servers[0].waiting;
  assert.ok(owner.sessionId && owner.fingerprint && owner.question);
  const readKey = app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 5 }).token;
  const byKey = (await api(url, readKey, "/api/mcp/servers")).servers[0].waiting;
  assert.deepEqual(byKey, { question: owner.question }, "a short-lived key sees the question, not its conversation or fingerprint");
  app.store.profiles.isOwner = () => false; // the window switched to a household person's profile
  // Q261: reading fails closed for a household person at the window; the tool servers are not in householdReads.
  const byHousehold = await fetch(`${url}/api/mcp/servers`, { headers: { authorization: `Bearer ${token}` } });
  delete app.store.profiles.isOwner;
  assert.equal(byHousehold.status, 400, "nor does a household profile: the whole list is refused");
});

/* Who answered is read when the answer is given. Mutation: read `store.profiles.isOwner()` in `check()` again instead of
   `pending.byOwner`, and this goes red (the look after the switch back sees the owner and starts the program). */
test("a household yes followed by a switch back to the owner before the answer is looked at starts nothing", async (t) => {
  const { app, url, token } = await fixture(t);
  app.ownMcp.deps.pollMs = 1500; // the answer is looked at well after the switch back
  const { server: { id } } = await api(url, token, "/api/mcp/servers", notes);
  await api(url, token, `/api/mcp/servers/${id}/start`, {});
  const question = (await api(url, token, "/api/policy")).waiting.find((q) => q.tool === "mcp.start");
  app.store.profiles.isOwner = () => false;
  // Q257: refused at the route now, before it can land; the check below still shows nothing started after the switch back.
  await assert.rejects(api(url, token, "/api/policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint }),
    /Nothing in this conversation is waiting for your answer/);
  delete app.store.profiles.isOwner; // back to the owner before the look
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(toolsOf(app, id).length, 0, "the household person's yes stays a no");
});

test("the malware check refuses a server before it is saved", async (t) => {
  const { app, url, token } = await fixture(t);
  app.security.malware.vet = async () => { throw new Error("That package is listed as harmful."); };
  await assert.rejects(api(url, token, "/api/mcp/servers", notes), /listed as harmful/);
  assert.deepEqual(app.ownMcp.saved(), []);
});

test("a web-address server is saved on, and a tool the approval settings refuse is left out", async (t) => {
  const { app, url, token } = await fixture(t);
  const remote = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "2.0.0" } };
    if (message.method === "tools/list") result = { tools: ["echo", "wipe"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  t.after(() => new Promise((done) => remote.close(done)));
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: mcpToolName("web-fixture", "wipe"), match: "*", decision: "deny" }] });
  const added = await api(url, token, "/api/mcp/servers", { name: "Web fixture", server: { transport: "http", url: `http://127.0.0.1:${remote.address().port}` } });
  assert.equal(added.server.on, true);
  assert.deepEqual(added.server.hidden, ["wipe"]);
  assert.deepEqual(toolsOf(app, "web-fixture"), [mcpToolName("web-fixture", "echo")]);
});

test("command-line tools: found without running them, allowed by name, never a batch file or one in the workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-clis-"));
  const bin = join(root, "bin"), workspace = join(root, "workspace");
  await mkdir(bin); await mkdir(workspace);
  const exe = process.platform === "win32" ? ".exe" : "";
  await writeFile(join(bin, `kubectl${exe}`), "", { mode: 0o755 });
  await writeFile(join(bin, "tool.cmd"), "");
  await writeFile(join(workspace, `planted${exe}`), "", { mode: 0o755 });
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const clis = new OwnClis({ store: app.store, owner: () => app.runtime.owner, workspace: () => workspace, env: { PATH: bin } });
  assert.deepEqual(clis.found().map((entry) => entry.name), ["kubectl"]);
  const shell = { extra: () => ({}) };
  clis.attach(shell, ["git"]);
  const added = clis.add({ name: "kubectl" });
  assert.match(added.said, /It asks before every command/);
  assert.equal(shell.extra().kubectl.path, join(bin, `kubectl${exe}`), "the shell runs it from the next command");
  assert.throws(() => clis.add({ name: "kubectl" }), /already/);
  assert.throws(() => clis.add({ name: "git" }), /not found|already/);
  assert.throws(() => clis.add({ path: join(bin, "tool.cmd") }), /cannot be added/);
  assert.throws(() => clis.add({ path: join(workspace, `planted${exe}`) }), /outside the workspace/);
  clis.remove({ name: "kubectl" });
  assert.deepEqual(shell.extra(), {});
});

test("flag a reply: kept on this computer, listed, exported only by a POST, and removed", async (t) => {
  const { app, url, token } = await fixture(t);
  const run = app.store.createRun(app.runtime.owner, "hello");
  app.store.message(run.sessionId, { role: "user", content: "hello" });
  app.store.message(run.sessionId, { role: "assistant", content: "The answer is 41." });
  const [asked, replied] = app.store.sessionView(app.runtime.owner, run.sessionId).messages;
  await assert.rejects(api(url, token, "/api/reply-flags", { sessionId: run.sessionId, messageId: asked.messageId, reasons: ["wrong"] }), /Only a reply/);
  const kept = await api(url, token, "/api/reply-flags", { sessionId: run.sessionId, messageId: replied.messageId, reasons: ["unsafe", "wrong", "wrong"], note: "It is 42." });
  assert.equal(kept.said, "Flagged. Kept on this computer only.");
  assert.deepEqual(kept.flag.reasons, ["wrong", "unsafe"], "each reason once, in the dialog's order");
  assert.equal(kept.flag.reply, "The answer is 41.", "the reply's words come from the conversation");
  const listed = await api(url, token, "/api/reply-flags");
  assert.equal(listed.flags.length, 1);
  assert.ok(!("note" in listed.flags[0]) && !("reply" in listed.flags[0]), "reading the list never hands back the reply or the note");
  const out = await api(url, token, "/api/reply-flags/export", {});
  assert.equal(out.flags[0].note, "It is 42.");
  assert.ok(!JSON.stringify(out).includes("hello"), "no other message of the conversation goes out");
  await api(url, token, `/api/reply-flags/${kept.flag.id}/remove`, {});
  assert.deepEqual((await api(url, token, "/api/reply-flags")).flags, []);
});

test("Branch closes cleanly with a command server of the owner's still running", async (t) => {
  const { app, url, token } = await fixture(t);
  const { server: { id } } = await api(url, token, "/api/mcp/servers", notes);
  await api(url, token, `/api/mcp/servers/${id}/start`, {});
  const question = (await api(url, token, "/api/policy")).waiting.find((q) => q.tool === "mcp.start");
  await api(url, token, "/api/policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint });
  await until(() => toolsOf(app, id).length === 2);
});
