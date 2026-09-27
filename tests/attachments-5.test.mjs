/**
 * Attachments, fifth round: a message that names a file an earlier run left waiting waits for the start-up restore of
 * those files (src/attachments.ts restoreIncoming, `restored`; awaited in src/runtime.ts run), however long it takes:
 * it is neither refused as gone nor loses the file. The restore is held open here through the reader of the waiting
 * list (createBranch's readWaitingList), so nothing depends on timing.
 * Sending a file ahead and taking one off wait for the restore too (Codex P2 on #550): a file taken off while the
 * restore runs is never brought back by it, and a file sent meanwhile is counted with the restored ones.
 * Mutations, each turns a test red:
 * - src/runtime.ts run: drop the await of `restored`: the message is refused ("no longer waiting").
 * - src/attachments.ts unstage: drop the await of `restored`: the file is not taken off, and comes back.
 * - src/attachments.ts stage: drop the await of `restored`: a file sent meanwhile is not counted with the restored ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { Attachments } from "../dist/attachments.js";

test("a message naming a restored file waits for the restore, then takes the file whole", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attach-5-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const seen = [];
  const start = (extra = {}) => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...extra,
    provider: { name: "scripted", async complete(request) { seen.push(request.messages); return { content: "Got it.", toolCalls: [] }; } } });

  const before = await start();
  const who = before.store.profiles.scope();
  const { upload } = await before.attachments.stage(who, { name: "notes.txt", mediaType: "text/plain" }, [Buffer.from("The boat is moored at pier 9.")]);
  await before.close();

  // The next start reads the waiting list only when the test lets it.
  let reading, letRead;
  const asked = new Promise((done) => { reading = done; });
  const gate = new Promise((done) => { letRead = done; });
  const after = await start({ readWaitingList: async (path) => { reading(); await gate; return readFile(path, "utf8"); } });
  closing.push(() => after.close());
  await asked;
  assert.equal(after.attachments.restoringNow, true, "control: the restore is held open");

  let outcome = null;
  const sending = after.runtime.run({ prompt: "Where is the boat?", uploads: { who, ids: [upload] } });
  sending.then((run) => { outcome = run; }, (error) => { outcome = error; });
  // One turn of the event loop: a refusal (made without waiting on anything) would have come by now.
  await new Promise((done) => setImmediate(done));
  assert.equal(outcome, null, "the message waits for the restore: it is not refused");

  letRead();
  const run = await sending;
  assert.ok(!(run instanceof Error));
  const kept = after.store.messages(run.sessionId).find((one) => one.role === "user").attachments;
  assert.equal(kept?.length, 1, "the file went with its message");
  assert.equal((await after.attachments.read(run.sessionId, kept[0].id)).bytes.toString(), "The boat is moored at pier 9.", "whole");
});

/** A folder an earlier run left with `count` files waiting, and Attachments whose restore waits for `letRead`. */
async function heldRestore(t, count = 1) {
  const root = await mkdtemp(join(tmpdir(), "branch-attach-5-held-"));
  t.after(() => discardTemp(root));
  const now = Date.now(), words = "a copied picture";
  const ids = Array.from({ length: count }, (_, at) => "7".repeat(16) + at.toString(16).padStart(8, "0"));
  const id = ids[0];
  await mkdir(join(root, ".incoming"), { recursive: true });
  for (const one of ids) await writeFile(join(root, ".incoming", one), words);
  await writeFile(join(root, ".incoming", "waiting.json"), JSON.stringify(ids.map((one) =>
    ({ id: one, who: "local", name: "pasted.png", mediaType: "image/png", kind: "picture", bytes: Buffer.byteLength(words), at: now }))));
  let reading, letRead;
  const asked = new Promise((done) => { reading = done; });
  const gate = new Promise((done) => { letRead = done; });
  const files = new Attachments(root, undefined, undefined, undefined, undefined,
    { now: () => now, readList: async (path) => { reading(); await gate; return readFile(path, "utf8"); } });
  const restoring = files.restoreIncoming();
  await asked;
  return { root, id, files, restoring, letRead };
}
const listed = async (root) => JSON.parse(await readFile(join(root, ".incoming", "waiting.json"), "utf8")).map((one) => one.id).sort();

test("a file taken off while the restore runs is taken off once it is back, and never comes back", async (t) => {
  const { root, id, files, restoring, letRead } = await heldRestore(t);
  const takingOff = files.unstage("local", id);
  letRead();
  await restoring;
  assert.equal(await takingOff, true, "taken off");
  assert.throws(() => files.staged("local", [id]), /no longer waiting/, "it does not come back");
  assert.equal((await readdir(join(root, ".incoming"))).includes(id), false, "nor do its bytes");
  assert.deepEqual(await listed(root), [], "nor its place on the list");
});

test("a file sent while the restore runs is counted with the restored ones", async (t) => {
  // As many files as one person may have waiting (maximumUploadsPerTurn * 2), all left by the earlier run.
  const { root, files, restoring, letRead } = await heldRestore(t, 40);
  const sending = files.stage("local", { name: "next.txt", mediaType: "text/plain" }, [Buffer.from("the next file")]);
  letRead();
  await restoring;
  await assert.rejects(sending, /Too many files are waiting/, "one more is refused, as it would be with them all back");
  assert.equal((await listed(root)).length, 40, "and the list still names every restored file");
});
