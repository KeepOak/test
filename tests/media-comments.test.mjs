/**
 * FQ-collaboration: a comment pinned to a moment in a media file, reopened at the same position.
 *
 * The owner API (add + list) is checked directly; the reopening itself is checked through the real
 * screen it was wired into — the Files browser's video player (public/code-editor.js), opened from
 * the workspace it already lists, headless, with a tiny generated clip Chromium can decode. See
 * tests/media-file.test.mjs for the bytes route that player opens (`/api/media-comments/media`),
 * checked apart from the browser because it is plain HTTP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { MediaCommentSchema } from "../dist/media-comments.js";

const here = dirname(fileURLToPath(import.meta.url));

async function fixture(t) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "media-comments-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, options = {}) => fetch(new URL(path, server.url), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${server.token}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call, workspace };
}

test("a comment added at 12.5s on a video file is returned by the list, in order", async (t) => {
  const { call } = await fixture(t);
  const added = await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: 12.5, text: "the turn happens here" } });
  assert.equal(added.status, 200);
  assert.equal(added.body.atSeconds, 12.5);
  assert.equal(added.body.fileId, "videos/clip.mp4");
  assert.equal(added.body.text, "the turn happens here");
  assert.ok(added.body.id && added.body.createdAt);

  // A second comment, earlier in the file, to check the list comes back ordered by moment, not by
  // when it was written.
  await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: 2, text: "intro" } });
  const listed = await call("/api/media-comments?fileId=" + encodeURIComponent("videos/clip.mp4"));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.comments.map((c) => c.atSeconds), [2, 12.5]);
  assert.equal(listed.body.comments[1].text, "the turn happens here");

  // A different file's list stays empty: comments belong to the file they were left on.
  const other = await call("/api/media-comments?fileId=" + encodeURIComponent("videos/other.mp4"));
  assert.deepEqual(other.body.comments, []);
});

test("a negative time is rejected over the API; NaN is rejected by the schema JSON cannot carry", async (t) => {
  const { call } = await fixture(t);
  const negative = await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: -1, text: "before the file starts" } });
  assert.equal(negative.status, 400);
  assert.match(negative.body.error, /"atSeconds" must be at least 0\./);

  const empty = await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: 0, text: "" } });
  assert.equal(empty.status, 400, "an empty comment is rejected too");

  // JSON has no NaN literal, so a NaN atSeconds can never actually arrive over HTTP as valid JSON;
  // the schema itself is what has to refuse it. `z.number()` treats NaN as the wrong type outright.
  assert.equal(MediaCommentSchema.safeParse({ fileId: "f", atSeconds: NaN, text: "x" }).success, false);
  assert.equal(MediaCommentSchema.safeParse({ fileId: "f", atSeconds: Infinity, text: "x" }).success, false);
  assert.equal(MediaCommentSchema.safeParse({ fileId: "f", atSeconds: 12.5, text: "x" }).success, true);

  const listed = await call("/api/media-comments?fileId=" + encodeURIComponent("videos/clip.mp4"));
  assert.deepEqual(listed.body.comments, [], "neither rejected write made it into the list");
});

