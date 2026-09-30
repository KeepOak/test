import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { protectedAreas } from "../dist/never-break/protected.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

/*
 * FQ-collaboration: the raw bytes route (`/api/media-comments/media`) the Files browser's video
 * player opens (public/code-editor.js), and the comment a moment is pinned to reopens through. Held
 * to the same switch, the same traversal and secret-name walls, and the same protected-areas guard
 * as the rest of the code editor (bucket-18, tests/code-editor.test.mjs) — this file only adds the
 * cases specific to serving a video's bytes rather than its text.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-media-file-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const media = async (fileId, key = server.token) => {
    const response = await fetch(`${server.url}/api/media-comments/media?fileId=${encodeURIComponent(fileId)}`,
      { headers: { authorization: `Bearer ${key}` } });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const editorSettings = async (mode) => {
    await fetch(`${server.url}/api/workspace-editor/settings`, {
      method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  };
  return { app, server, media, editorSettings, workspace, root };
}
const clip = await readFile(join(import.meta.dirname, "fixtures", "tiny-video.mp4"));

test("A0098/FQ-collaboration: switched off it refuses, and a video's own bytes come back once it is on", async (t) => {
  const { media, editorSettings, workspace } = await fixture(t);
  await writeFile(join(workspace, "clip.mp4"), clip);

  // The ship-on rule: the workspace editor ships "when needed"; the owner switches it off to see the refusal.
  await editorSettings("off");
  const off = await media("clip.mp4");
  assert.equal(off.status, 403);

  await editorSettings("on");
  const on = await media("clip.mp4");
  assert.equal(on.status, 200);
  assert.equal(on.headers.get("content-type"), "video/mp4");
  assert.ok(on.bytes.equals(clip), "the bytes served are exactly the file on disk");
  await writeFile(join(workspace, "日本の動画.mp4"), clip);
  assert.equal((await media("日本の動画.mp4")).status, 200, "a name outside Latin-1 still opens (the header is encoded)");
});

test("FQ-collaboration: only a video's own kinds are served; everything else is 415, 404 or 403", async (t) => {
  const { media, editorSettings, workspace, root } = await fixture(t);
  await editorSettings("on");
  await writeFile(join(workspace, "notes.txt"), "not a video");
  await writeFile(join(workspace, ".env"), "SECRET=1");
  await writeFile(join(root, "outside.mp4"), clip);

  assert.equal((await media("notes.txt")).status, 415, "a non-video extension is refused");
  assert.equal((await media("missing.mp4")).status, 404, "a video that does not exist is 404, not a crash");
  assert.equal((await media(".env")).status, 415, "a secret-looking file is refused by its extension before its name is even checked");
  for (const outside of ["../outside.mp4", "/etc/hosts.mp4"])
    assert.notEqual((await media(outside)).status, 200, `${outside} must not escape the workspace`);
});

test("FQ-collaboration: a short-lived key cannot open a video through this route either", async (t) => {
  const { app, media, editorSettings, workspace } = await fixture(t);
  await editorSettings("on");
  await writeFile(join(workspace, "clip.mp4"), clip);
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 }).token;
  const denied = await media("clip.mp4", key);
  assert.equal(denied.status, 401);
});

test("FQ-collaboration: Branch's own program inside the workspace can still be watched, the same as it can be read", async (t) => {
  // Matches bucket-18's own rule (tests/code-editor.test.mjs): reading Branch's program is allowed,
  // since watching a video is not a key or saved work either; only writing over it is refused.
  const { app, media, editorSettings, workspace, root } = await fixture(t);
  await editorSettings("on");
  await mkdir(join(workspace, "prog", "dist"), { recursive: true });
  await writeFile(join(workspace, "prog", "dist", "demo.mp4"), clip);
  app.runtime.protectedAreas = protectedAreas({ workspace, dataDir: join(root, "data"), installRoot: join(workspace, "prog") });
  const opened = await media("prog/dist/demo.mp4");
  assert.equal(opened.status, 200);
  assert.ok(opened.bytes.equals(clip));
});

if (process.platform !== "win32") {
  test("FQ-collaboration: a symlink out of the workspace is not followed to serve a video", async (t) => {
    const { media, editorSettings, workspace, root } = await fixture(t);
    await editorSettings("on");
    await writeFile(join(root, "outside.mp4"), clip);
    await symlink(join(root, "outside.mp4"), join(workspace, "link.mp4"));
    assert.notEqual((await media("link.mp4")).status, 200);
  });
}
