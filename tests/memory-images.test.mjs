import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/* TRUNK-106: a private fact can point at a picture kept in its conversation; no copy is made, and it can be let go. */
test("a fact is tied to a picture from its own conversation, checked, and untied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-memory-images-"));
  let next = null;
  const results = [];
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "tool") { results.push(JSON.parse(last.content)); return { content: "Done.", toolCalls: [] }; }
    const call = next; next = null;
    return call ? { content: "", toolCalls: [{ id: "c1", name: call.name, arguments: JSON.stringify(call.args) }] } : { content: "Kept.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });

  const first = await app.runtime.run({ prompt: "This is the shed.", attachments: [{ name: "shed.png", mediaType: "image/png", data: png.toString("base64") }] });
  const [picture] = await app.attachments.list(first.sessionId);
  assert.equal(picture.kind, "picture");
  const fact = await app.runtime.executeTool("memory.put", { text: "The shed is the green one", source: "Owner" });
  const revision = app.store.get("memory", "local", fact.id).revision;

  // Tied from a different conversation: refused, the fact is unchanged.
  next = { name: "memory.attach_image", args: { id: fact.id, attachmentId: picture.id, expectedRevision: revision } };
  await app.runtime.run({ prompt: "tie the shed picture" });
  assert.equal(app.store.get("memory", "local", fact.id).data.image, undefined, "another conversation's picture is not tied");

  next = { name: "memory.attach_image", args: { id: fact.id, attachmentId: picture.id, expectedRevision: revision } };
  await app.runtime.run({ prompt: "tie the shed picture", sessionId: first.sessionId });
  const tied = app.store.get("memory", "local", fact.id);
  assert.deepEqual(tied.data.image, { sessionId: first.sessionId, attachmentId: picture.id });
  assert.equal(tied.data.text, "The shed is the green one");

  const seen = await app.runtime.executeTool("memory.image", { id: fact.id });
  assert.equal(seen.available, true);
  assert.equal(seen.mediaType, "image/png");
  assert.match(seen.open, new RegExp(`session=${first.sessionId}&id=${picture.id}$`));

  const untied = await app.runtime.executeTool("memory.detach_image", { id: fact.id, expectedRevision: tied.revision });
  assert.equal(untied.detached, true);
  assert.equal(app.store.get("memory", "local", fact.id).data.image, undefined);
  assert.equal((await app.attachments.list(first.sessionId)).length, 1, "the original stays with its conversation");
});
