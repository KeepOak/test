/**
 * Attachments, fifth round: a message that names a file an earlier run left waiting waits for the start-up restore of
 * those files (src/attachments.ts restoreIncoming, `restored`; awaited in src/runtime.ts run), however long it takes:
 * it is neither refused as gone nor loses the file. The restore is held open here through the reader of the waiting
 * list (createBranch's readWaitingList), so nothing depends on timing.
 * Mutation, turns the test red:
 * - src/runtime.ts run: drop the await of `restored`: the message is refused ("no longer waiting").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

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
