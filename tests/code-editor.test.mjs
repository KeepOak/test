import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { protectedAreas } from "../dist/never-break/protected.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

/* bucket-18 (A0098): the code editor's routes, exercised over HTTP against a real app. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-code-editor-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir, provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(`${server.url}/api/workspace-editor/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, call, workspace, root, owner: app.runtime.owner };
}
const put = async (workspace, path, content) => {
  await mkdir(join(workspace, path, ".."), { recursive: true });
  await writeFile(join(workspace, path), content);
};
const read = (path) => `read?path=${encodeURIComponent(path)}`;
const list = (path) => `list?path=${encodeURIComponent(path)}`;

test("A0098 ships off: every route but the switch refuses, and a short-lived key cannot turn it on", async (t) => {
  const { call, app, owner, workspace } = await fixture(t);
  await put(workspace, "a.txt", "hello\n");
  assert.deepEqual((await call("settings")).body, { mode: "off" });
  for (const path of [list("."), read("a.txt")]) assert.equal((await call(path)).status, 403);
  const refused = await call("save", { path: "a.txt", content: "x", opened: null });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /switched off/);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "hello\n");

  const key = app.sessionTokens.create(owner, { scope: "run", minutes: 5 }).token;
  const scripted = await call("settings", { mode: "on" }, key);
  assert.equal(scripted.status, 401);
  assert.match(scripted.body.error, /short-lived key/);
  assert.equal((await call("settings", { mode: "always" })).status, 400);
  assert.equal((await call("settings", { mode: "when-needed" })).body.mode, "when-needed");
});

test("A0098 on: list, open and save, and a save can be put back", async (t) => {
  const { call, app, workspace } = await fixture(t);
  await call("settings", { mode: "on" });
  await put(workspace, "src/app.ts", "export const a = 1;\n");
  await put(workspace, ".env", "SECRET=1\n");

  const top = await call(list("."));
  assert.equal(top.status, 200);
  const names = top.body.entries.map((entry) => entry.name);
  assert.ok(names.includes("src"));
  assert.equal(names.includes(".env"), false, "a secret-looking file is not even listed");
  const inside = await call(list("src"));
  assert.deepEqual(inside.body.entries.map((entry) => [entry.path, entry.type]), [["src/app.ts", "file"]]);

  const opened = await call(read("src/app.ts"));
  assert.equal(opened.body.content, "export const a = 1;\n");
  assert.match(opened.body.opened, /^[0-9a-f]{64}$/);
  const saved = await call("save", { path: "src/app.ts", content: "export const a = 2;\n", opened: opened.body.opened });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(join(workspace, "src/app.ts"), "utf8"), "export const a = 2;\n");
  const again = await call("save", { path: "src/app.ts", content: "export const a = 3;\n", opened: saved.body.opened });
  assert.equal(again.status, 200, "the checksum a save hands back opens the next save");

  const history = await app.runtime.executeTool("files.history", { path: "src/app.ts" });
  assert.ok(JSON.stringify(history).length > 2);
  const created = await call("save", { path: "notes/new.md", content: "# New\n", opened: null });
  assert.equal(created.status, 200, "a new file is saved with no checksum");
  assert.equal(await readFile(join(workspace, "notes/new.md"), "utf8"), "# New\n");
});

test("A0098 a stale save is refused with 409 and nothing is overwritten", async (t) => {
  const { call, workspace } = await fixture(t);
  await call("settings", { mode: "on" });
  await put(workspace, "notes.txt", "first\n");
  const opened = await call(read("notes.txt"));
  await put(workspace, "notes.txt", "changed by someone else\n");
  const stale = await call("save", { path: "notes.txt", content: "mine\n", opened: opened.body.opened });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since you opened it/);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "changed by someone else\n");

  const blind = await call("save", { path: "notes.txt", content: "mine\n", opened: null });
  assert.equal(blind.status, 409, "an existing file cannot be saved without saying which version was opened");
  const gone = await call("save", { path: "vanished.txt", content: "x", opened: "0".repeat(64) });
  assert.equal(gone.status, 409);
  assert.match(gone.body.error, /removed/);
});

test("A0098 the workspace's walls hold: outside paths, secret names, ignored and read-only files are refused", async (t) => {
  const { call, workspace, root } = await fixture(t);
  await call("settings", { mode: "on" });
  await writeFile(join(root, "outside.txt"), "private\n");
  await put(workspace, ".env", "SECRET=1\n");
  await put(workspace, "id_rsa", "-----BEGIN KEY-----\n");
  await put(workspace, "hidden/plan.txt", "hidden\n");
  await put(workspace, ".branchignore", "hidden/\n");
  await put(workspace, "big.txt", "x".repeat(40000));
  await put(workspace, "picture.bin", "PNG\u0000\u0001");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await put(workspace, "memory/README.md", "mirror\n");

  for (const path of ["../outside.txt", "/etc/hosts", "C:\\Windows\\win.ini", ".env", "id_rsa", "hidden/plan.txt"]) {
    const opened = await call(read(path));
    assert.ok([403, 404].includes(opened.status), `${path} was opened (${opened.status})`);
    assert.equal(JSON.stringify(opened.body).includes("private") || JSON.stringify(opened.body).includes("SECRET"), false);
    const saved = await call("save", { path, content: "overwritten", opened: null });
    assert.ok([403, 409].includes(saved.status), `${path} was saved (${saved.status})`);
  }
  assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "private\n");
  assert.equal(await readFile(join(workspace, ".env"), "utf8"), "SECRET=1\n");
  assert.equal((await call(list("../"))).status, 403);
  assert.equal((await call(read("big.txt"))).status, 413);
  assert.equal((await call(read("picture.bin"))).status, 415);

  const mirror = await call(read("memory/README.md"));
  assert.equal(mirror.body.readOnly, true, "the memory mirror opens read-only");
  const refused = await call("save", { path: "memory/README.md", content: "x", opened: mirror.body.opened });
  assert.equal(refused.status, 403);

  if (process.platform !== "win32") {
    await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
    assert.notEqual((await call(read("link.txt"))).status, 200, "a link out of the workspace is not followed");
    const through = await call("save", { path: "link.txt", content: "x", opened: null });
    assert.notEqual(through.status, 200);
    assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "private\n");
  }
});

// Redesign: the old Files pane's workspace editor (public/code-editor.js, #wsedit in public/index.html) is not in
// prototype.html; the nearest thing it has is "Edit the files it reads" (instruction files with every earlier version,
// Settings › Instructions & personality, tests/agent-files.test.mjs). The editor's routes are still exercised over
// HTTP by the tests above and below.
test.skip("A0098 the window's files use the editor routes and name every label", async () => {
  const here = join(import.meta.dirname, "..", "public");
  const html = await readFile(join(here, "index.html"), "utf8");
  const script = await readFile(join(here, "code-editor.js"), "utf8");
  const en = JSON.parse(await readFile(join(here, "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(here, "locales", "fr.json"), "utf8"));
  assert.match(html, /<script src="\/code-editor\.js" type="module"><\/script>/);
  assert.match(html, /<div class="context-block" data-pane="files">\s*<!--|<div class="context-block" data-pane="files">\s*<details id="wsedit">/);
  for (const key of new Set([...html.matchAll(/data-t="(wsedit\.[^"]+)"/g), ...script.matchAll(/t\("(wsedit\.[^"]+)"\)/g)].map((m) => m[1]))) {
    assert.ok(en[key], `${key} has English`);
    assert.ok(fr[key] && fr[key] !== en[key], `${key} has real French`);
  }
  assert.doesNotMatch(script, /#[0-9a-f]{3,6}\b|rgb\(/i, "no literal colours");
});

test("A0098 review: a short-lived key can neither read nor save through the editor, even while it is on", async (t) => {
  const { call, app, owner, workspace } = await fixture(t);
  await call("settings", { mode: "on" });
  await put(workspace, "a.txt", "hello\n");
  const opened = (await call(read("a.txt"))).body.opened;
  const key = app.sessionTokens.create(owner, { scope: "run", minutes: 5 }).token;
  for (const path of [list("."), read("a.txt"), "settings"]) {
    const answer = await call(path, undefined, key);
    assert.equal(answer.status, 401, path);
    assert.match(answer.body.error, /short-lived key/);
  }
  const save = await call("save", { path: "a.txt", content: "overwritten", opened }, key);
  assert.equal(save.status, 401);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "hello\n");
});

test("A0098 review: Branch's own program inside the workspace can be neither opened nor saved over", async (t) => {
  const { call, app, workspace, root } = await fixture(t);
  await call("settings", { mode: "on" });
  await put(workspace, "prog/dist/index.js", "original\n");
  app.runtime.protectedAreas = protectedAreas({ workspace, dataDir: join(root, "data"), installRoot: join(workspace, "prog") });
  const opened = await call(read("prog/dist/index.js"));
  // Reading the program is allowed (it is not a key or saved work); changing it never is.
  assert.equal(opened.status, 200);
  const save = await call("save", { path: "prog/dist/index.js", content: "changed\n", opened: opened.body.opened });
  assert.equal(save.status, 403);
  assert.match(save.body.error, /Branch's own files/);
  assert.equal(await readFile(join(workspace, "prog/dist/index.js"), "utf8"), "original\n");
});
