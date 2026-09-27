/**
 * Attachments, fourth round: files sent ahead that wait again after a restart (attach-3) are never lost to the start-up
 * sweep, however slow it is, and still go after their time.
 * Mutations, each turns a test here red:
 * - src/attachments.ts clearIncoming: stop skipping files being moved (`moving`): the sweep takes a file a message is
 *   moving into its conversation, and the message fails.
 * - src/attachments.ts restoreIncoming: keep a time ahead of the clock as it is: the file never goes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Attachments, stagedLifeMs } from "../dist/attachments.js";

/** A folder as an earlier run left it: one file still waiting (listed) and one stray. */
async function leftBehind(t, at) {
  const root = await mkdtemp(join(tmpdir(), "branch-attach-4-"));
  t.after(() => discardTemp(root));
  const id = "5".repeat(24), words = "a copied picture";
  await mkdir(join(root, ".incoming"), { recursive: true });
  await writeFile(join(root, ".incoming", id), words);
  await writeFile(join(root, ".incoming", "0".repeat(24)), "a stray from a run that stopped");
  await writeFile(join(root, ".incoming", "waiting.json"), JSON.stringify([
    { id, who: "local", name: "pasted.png", mediaType: "image/png", kind: "picture", bytes: Buffer.byteLength(words), at }]));
  return { root, id, words };
}

test("a message moving a restored file into its conversation while the start-up sweep runs keeps it", async (t) => {
  const now = Date.now();
  const { root, id, words } = await leftBehind(t, now);
  let moving, letGo;
  const held = new Promise((done) => { letGo = done; });
  const started = new Promise((done) => { moving = done; });
  const files = new Attachments(root, undefined, undefined, undefined, undefined,
    { now: () => now, move: async (from, to) => { moving(); await held; await rename(from, to); } });
  await files.restoreIncoming();
  const keeping = files.keep("a-conversation", [], { uploads: { who: "local", ids: [id] } });
  await started;
  // The sweep runs its whole course while the move is under way.
  await files.clearIncoming();
  assert.deepEqual((await readdir(join(root, ".incoming"))).sort(), [id, "waiting.json"].sort(), "the stray went, the file being moved did not");
  letGo();
  const [ref] = await keeping;
  assert.equal((await files.read("a-conversation", ref.id)).bytes.toString(), words, "and its message took it whole");
});

test("a restored file whose time is ahead of the clock still goes once its time is up", async (t) => {
  let now = Date.now();
  const { root, id } = await leftBehind(t, now + 10 * stagedLifeMs);
  const files = new Attachments(root, undefined, undefined, undefined, undefined, { now: () => now });
  await files.sweepIncoming();
  assert.equal(files.staged("local", [id]).length, 1, "control: it waits again");
  now += stagedLifeMs + 1;
  // Any send looks for files past their time first.
  await files.stage("local", { name: "next.txt", mediaType: "text/plain" }, [Buffer.from("the next file")]);
  assert.throws(() => files.staged("local", [id]), /no longer waiting/, "it went with the others past their time");
  assert.equal((await readdir(join(root, ".incoming"))).includes(id), false, "and its bytes with it");
});
