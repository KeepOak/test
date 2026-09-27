// The owner's Downloads, Desktop and Documents (src/owner-folders.ts): asked once per folder, the question naming the
// real path; never outside the named folder, never silent, never under Lockdown, never for someone else's task.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { listOwnerFolder, moveInOwnerFolder, ownerFolderVerdict, ownerPathOf, ownerFolderTool } from "../dist/owner-folders.js";
import { bestRecommendation } from "../dist/local-hardware.js";
import { savePolicy } from "../dist/policy.js";

const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: "c" + Math.random().toString(36).slice(2, 8), name, arguments: JSON.stringify(args) }] });

/** A home folder of the test's own (the engine reads the home folder each time), and an engine with a scripted model. */
async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-folders-"));
  const home = join(root, "home"), downloads = join(home, "Downloads");
  for (const dir of [downloads, join(home, "Desktop"), join(home, "Documents"), join(root, "elsewhere")]) mkdirSync(dir, { recursive: true });
  for (const name of ["a.pdf", "b.jpg"]) writeFileSync(join(downloads, name), name);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  const requests = [];
  let at = 0;
  const provider = { name: "scripted", async complete(request) {
    requests.push(request);
    const step = steps[Math.min(at++, steps.length - 1)];
    return typeof step === "function" ? step(request) : step;
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => {
    await app.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await discardTemp(root);
  });
  return { app, root, home, downloads, requests };
}
const events = (app, run, kind) => app.store.events(run.id).filter((event) => event.kind === kind).map((event) => event.data);
const lastResult = (app, run) => {
  const rows = app.store.messages(run.sessionId).filter((message) => message.role === "tool");
  return JSON.parse(rows.at(-1).content);
};

test("a path a model writes is read as the owner's folder, the workspace, or outside reach", () => {
  const home = process.platform === "win32" ? "C:\\Users\\me" : "/home/me";
  assert.deepEqual(ownerPathOf("~/Downloads/a.pdf", home), { folder: { name: "Downloads", path: join(home, "Downloads") }, parts: ["a.pdf"] });
  assert.equal(ownerPathOf(join(home, "Desktop", "x.txt"), home).folder.name, "Desktop");
  assert.equal(ownerPathOf("Documents/x.txt", home, true).folder.name, "Documents", "a bare name when the workspace has none");
  assert.equal(ownerPathOf("Documents/x.txt", home, false), null, "the workspace's own Documents otherwise");
  assert.equal(ownerPathOf("src/x.txt", home, true), null);
  assert.equal(ownerPathOf("~/Pictures/x.jpg", home), "outside");
  assert.equal(ownerPathOf("/etc/passwd", home), "outside");
  assert.equal(ownerPathOf("C:/Windows/win.ini", home), "outside");
  assert.throws(() => ownerPathOf("~/Downloads/../.ssh/id_rsa", home), /step out/);
  assert.throws(() => ownerPathOf("~/Downloads/*.pdf", home), /wildcard.*files\.list/);
  assert.throws(() => ownerPathOf("~/Downloads/.env", home), /keys or passwords/);
});

test("listing ~/Downloads asks once, naming the real path; after a yes for the conversation it lists and moves", async (t) => {
  const { app, downloads } = await fixture(t, [
    call("files.list", { path: "~/Downloads" }),
    call("files.list", { path: "~/Downloads" }),
    call("files.move", { from: "~/Downloads", moves: [{ from: "a.pdf", to: "Documents/a.pdf" }, { from: "b.jpg", to: "~/Downloads/Pictures/b.jpg" }] }),
    say("Sorted."),
    call("files.list", { path: "~/Downloads" }),
  ]);
  const first = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  assert.equal(first.status, "needs_input");
  const [asked] = events(app, first, "policy.ask");
  assert.equal(asked.name, ownerFolderTool);
  assert.equal(asked.target, downloads, "the question names the real folder");
  assert.match(asked.question, new RegExp(downloads.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  assert.ok(existsSync(join(downloads, "a.pdf")), "nothing happens before the yes");
  app.runtime.approve(first.sessionId, "allow", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(second.status, "completed", second.output);
  assert.equal(events(app, second, "policy.ask").length, 0, "asked once for the folder, not for each call");
  assert.ok(existsSync(join(downloads, "Documents", "a.pdf")));
  assert.ok(existsSync(join(downloads, "Pictures", "b.jpg")));
  assert.ok(!existsSync(join(downloads, "a.pdf")));
  const other = await app.runtime.run({ prompt: "Tidy my Downloads folder again" });
  assert.equal(other.status, "needs_input", "a new conversation is asked again");
});

test("No is kept for the conversation: the task is told, and nothing moves", async (t) => {
  const { app, downloads } = await fixture(t, [call("files.list", { path: "~/Downloads" }), call("files.move", { from: "~/Downloads/a.pdf", to: "~/Downloads/x/a.pdf" }), say("Understood.")]);
  const first = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  app.runtime.approve(first.sessionId, "deny", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(events(app, second, "policy.ask").length, 0);
  assert.match(lastResult(app, second).error, /chose not to let Branch work in/);
  assert.ok(existsSync(join(downloads, "a.pdf")));
});

test("Lockdown refuses without asking, and so does a task nobody is there to answer", async (t) => {
  const { app } = await fixture(t, [call("files.list", { path: "~/Downloads" }), say("ok"), call("files.list", { path: "~/Downloads" }), say("ok")]);
  app.store.save("settings", "local", "lockdown", { on: true });
  const locked = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  app.store.save("settings", "local", "lockdown", { on: false });

  assert.equal(events(app, locked, "policy.ask").length, 0);
  assert.match(lastResult(app, locked).error, /Lockdown is on/);
  const scheduled = await app.runtime.run({ prompt: "Tidy my Downloads folder", source: "schedule" });
  assert.equal(events(app, scheduled, "policy.ask").length, 0);
  assert.match(lastResult(app, scheduled).error, /Only the owner's own tasks/);
});

test("a place outside reach is an error in plain words, never an empty list", async (t) => {
  const elsewhere = join(tmpdir(), "branch-owner-folders-nowhere");
  const { app } = await fixture(t, [
    call("files.list", { path: "~/Pictures" }), call("files.list", { path: elsewhere }),
    call("files.write", { path: "*.txt", content: "x" }), call("files.read", { path: "~/Downloads/a.pdf" }), say("ok"),
  ]);
  const run = await app.runtime.run({ prompt: "look around" });
  const results = app.store.messages(run.sessionId).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
  assert.match(results[0].error, /~\/Pictures is outside what I can reach/);
  assert.match(results[1].error, /is outside what I can reach/);
  assert.match(results[2].error, /wildcard.*files\.list.*files\.move/);
  assert.match(results[3].error, /Downloads folder, where I can only list files \(files\.list\) and move them \(files\.move\)/);
  assert.ok(results.every((result) => result.ok === false));
});

test("a move never leaves its folder, never replaces a file and never goes through a link", async (t) => {
  const { app, downloads, root } = await fixture(t, [
    call("files.list", { path: "~/Downloads" }),
    call("files.move", { from: "~/Downloads/a.pdf", to: "~/Desktop/a.pdf" }),
    call("files.move", { from: "~/Downloads/a.pdf", to: "~/Downloads/b.jpg" }),
    call("files.move", { from: "~/Downloads/a.pdf", to: "~/Downloads/away/a.pdf" }),
    call("files.move", { from: "~/Downloads/a.pdf", to: "a.pdf" }),
    say("done"),
  ]);
  symlinkSync(join(root, "elsewhere"), join(downloads, "away"), "junction");
  const first = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  app.runtime.approve(first.sessionId, "allow", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  const results = app.store.messages(second.sessionId).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content)).slice(-4);
  assert.match(results[0].error, /moved within one folder/);
  assert.match(results[1].error, /already exists, so nothing was moved/);
  assert.match(results[2].error, /is a link, so Branch leaves it alone/);
  // A bare name beside a path in the person's folder is read as in that folder, so the workspace cannot be reached from it.
  assert.match(results[3].error, /already exists, so nothing was moved/, "a bare name stays in the person's folder");
  assert.ok(!existsSync(join(root, "workspace", "a.pdf")));
  assert.ok(existsSync(join(downloads, "a.pdf")) && existsSync(join(downloads, "b.jpg")));
  assert.ok(!existsSync(join(root, "elsewhere", "a.pdf")));
});

test("the folder checks hold on their own, behind the ones the tools and the rules make first", async (t) => {
  const { app, home, downloads, root } = await fixture(t, [say("ok")]);
  const host = { store: app.store, owner: "local", approvals: { answer: () => "allow", takeOnce: () => true }, sessionOf: () => "s" };
  const place = ownerPathOf("~/Downloads", home);
  app.store.save("settings", "local", "lockdown", { on: true });
  assert.match(ownerFolderVerdict(host, { source: "owner", askable: true }, place.folder).refuse, /Lockdown is on/, "even with a yes kept");
  app.store.save("settings", "local", "lockdown", { on: false });
  await assert.rejects(moveInOwnerFolder([{ from: ownerPathOf("~/Downloads/a.pdf", home), to: ownerPathOf("~/Desktop/a.pdf", home) }]), /within one folder/);
  symlinkSync(join(root, "elsewhere"), join(downloads, "out"), "junction");
  await assert.rejects(moveInOwnerFolder([{ from: ownerPathOf("~/Downloads/a.pdf", home), to: ownerPathOf("~/Downloads/out/deep/a.pdf", home) }]), /is a link/);
  assert.ok(existsSync(join(downloads, "a.pdf")));
});

test("a file task is not shown the memory tools, and files.move travels with the core file tools", async (t) => {
  const { app, requests } = await fixture(t, [say("ok")]);
  await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  const names = requests[0].tools.map((tool) => tool.name);
  assert.ok(names.includes("files.move"));
  assert.ok(!names.some((name) => name.startsWith("memory.")), names.join(", "));
  assert.match(requests[0].messages[0].content, /~\/Downloads, ~\/Desktop and ~\/Documents/);
});

test("the first task's model is qwen2.5:7b whenever it fits, and 3b only when nothing bigger does", () => {
  const machine = (gb) => ({ totalMemoryBytes: gb * 1024 ** 3, cores: 8, graphics: null });
  assert.equal(bestRecommendation(machine(16)).model, "qwen2.5:7b");
  assert.equal(bestRecommendation(machine(64)).model, "qwen2.5:7b", "not the slow large one for a first task");
  assert.equal(bestRecommendation(machine(8)).model, "qwen2.5:3b");
  assert.equal(bestRecommendation(machine(4)).model, "qwen2.5:3b", "the smallest when nothing really fits");
});

test("from and to written as lists move the files they pair, or into the one folder named; a mismatch is the tool's error", async (t) => {
  const { app, downloads } = await fixture(t, [
    call("files.list", { path: "~/Downloads" }),
    call("files.move", { from: ["~/Downloads/a.pdf"], to: ["~/Downloads/Documents/a.pdf"] }),
    call("files.move", { from: ["~/Downloads/b.jpg"], to: "~/Downloads/Pictures" }),
    call("files.move", { from: ["~/Downloads/Pictures/b.jpg", "~/Downloads/Documents/a.pdf"], to: ["~/Downloads/b.jpg"] }),
    say("done"),
  ]);
  const first = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  app.runtime.approve(first.sessionId, "allow", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(second.status, "completed", second.output);
  assert.ok(existsSync(join(downloads, "Documents", "a.pdf")) && existsSync(join(downloads, "Pictures", "b.jpg")));
  assert.match(lastResult(app, second).error, /same number of files/);
});

test("in the person's folders a file keeps its kind, and a device name is not a file name", async (t) => {
  const { app, downloads } = await fixture(t, [
    call("files.list", { path: "~/Downloads" }),
    call("files.move", { from: "~/Downloads/a.pdf", to: "~/Downloads/a.txt" }),
    call("files.move", { from: "~/Downloads/b.jpg", to: "~/Downloads/x/b" }),
    call("files.move", { from: "~/Downloads/a.pdf", to: "~/Downloads/con.pdf" }),
    say("done"),
  ]);
  const first = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  app.runtime.approve(first.sessionId, "allow", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  const results = app.store.messages(second.sessionId).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content)).slice(-3);
  assert.match(results[0].error, /keeps its kind/);
  assert.match(results[1].error, /keeps its kind/);
  assert.match(results[2].error, /not a file name/);
  assert.ok(existsSync(join(downloads, "a.pdf")) && existsSync(join(downloads, "b.jpg")));
});

test("an allow-everything rule, a chat's task and Lockdown with a bare folder name never reach the folder unasked", async (t) => {
  const { app, downloads } = await fixture(t, [call("files.list", { path: "~/Downloads" }),
    call("files.list", { path: "~/Downloads" }), say("ok"), call("files.move", { from: "Downloads/a.pdf", to: "Downloads/x/a.pdf" }), say("ok")]);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "*", decision: "allow" }] });
  const open = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  assert.equal(open.status, "needs_input", "a rule for every tool is not a yes for the person's folder");
  const chat = await app.runtime.run({ prompt: "Tidy my Downloads folder", source: "channel" });
  assert.equal(events(app, chat, "policy.ask").length, 0, JSON.stringify(events(app, chat, "policy.ask")));
  assert.match(lastResult(app, chat).error, /Only the owner's own tasks/);
  app.store.save("settings", "local", "lockdown", { on: true });
  const locked = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  app.store.save("settings", "local", "lockdown", { on: false });
  assert.equal(events(app, locked, "policy.ask").length, 0, JSON.stringify(events(app, locked, "policy.ask")));
  assert.match(lastResult(app, locked).error, /Lockdown is on/);
  assert.ok(existsSync(join(downloads, "a.pdf")));
});

test("a workspace move is weighed at the place it goes too, not only the file it takes", async (t) => {
  const { app, root } = await fixture(t, [call("files.move", { from: "notes.txt", to: "kept/notes.txt" }), say("ok")]);
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(join(root, "workspace", "notes.txt"), "x");
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "files.move", match: "kept/**", decision: "deny" }] });
  const run = await app.runtime.run({ prompt: "move my notes" });
  assert.ok(existsSync(join(root, "workspace", "notes.txt")), "the rule about where it goes held");
  assert.ok(!existsSync(join(root, "workspace", "kept", "notes.txt")));
  assert.ok(events(app, run, "policy.denied").length + events(app, run, "tool.failed").length > 0);
});

test("a listing leaves out links and names that look like keys or passwords", async (t) => {
  const { home, downloads, root } = await fixture(t, [say("ok")]);
  writeFileSync(join(downloads, ".env"), "KEY=1");
  writeFileSync(join(downloads, "id_rsa"), "x");
  symlinkSync(join(root, "elsewhere"), join(downloads, "out"), "junction");
  const listed = await listOwnerFolder(ownerPathOf("~/Downloads", home));
  assert.deepEqual(listed.entries.map((entry) => entry.name).sort(), ["a.pdf", "b.jpg"]);
  // A folder reached through a link on the way is refused, not listed.
  mkdirSync(join(root, "elsewhere", "inner"), { recursive: true });
  writeFileSync(join(root, "elsewhere", "inner", "private.txt"), "x");
  await assert.rejects(listOwnerFolder(ownerPathOf("~/Downloads/out/inner", home)), /is a link/);
});

test("a bare name beside a path in the person's folder is in that folder, and a folder ending in a slash takes the file", async (t) => {
  const { app, downloads } = await fixture(t, [
    call("files.list", { path: "~/Downloads" }),
    call("files.move", { from: ["a.pdf"], to: ["~/Downloads/Documents/a.pdf"] }),
    call("files.move", { from: "b.jpg", to: "~/Downloads/Pictures/" }),
    say("done"),
  ]);
  const first = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  app.runtime.approve(first.sessionId, "allow", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(second.status, "completed", second.output);
  assert.ok(existsSync(join(downloads, "Documents", "a.pdf")), JSON.stringify(app.store.messages(second.sessionId).filter((m) => m.role === "tool").map((m) => m.content)));
  assert.ok(existsSync(join(downloads, "Pictures", "b.jpg")));
});

test("a move out to ~/Pictures or into another of the person's folders is refused with the path inside that stays put", async (t) => {
  const { app, downloads } = await fixture(t, [
    call("files.list", { path: "~/Downloads" }),
    call("files.move", { from: "~/Downloads/b.jpg", to: "~/Pictures/b.jpg" }),
    call("files.move", { from: ["~/Downloads/a.pdf"], to: ["~/Documents"] }),
    say("done"),
  ]);
  const first = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  app.runtime.approve(first.sessionId, "allow", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  const results = app.store.messages(second.sessionId).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content)).slice(-2);
  assert.match(results[0].error, /outside what I can reach.*from ~\/Downloads\/b\.jpg to ~\/Downloads\/Pictures\/b\.jpg/);
  assert.match(results[1].error, /within one folder.*from ~\/Downloads\/a\.pdf to ~\/Downloads\/Documents\/a\.pdf/);
  assert.ok(existsSync(join(downloads, "a.pdf")) && existsSync(join(downloads, "b.jpg")));
});

test("the folder question names the call that asked, so after a yes the task is told that call did not run", async (t) => {
  // Mutation: throw the question without its call id in Runtime.askApproval → attention.needed has no callId, red.
  const { app } = await fixture(t, [call("files.list", { path: "~/Downloads" }), say("ok")]);
  const first = await app.runtime.run({ prompt: "Tidy my Downloads folder" });
  const asked = events(app, first, "policy.ask")[0];
  assert.ok(asked.id);
  assert.equal(events(app, first, "attention.needed")[0].callId, asked.id);
});
