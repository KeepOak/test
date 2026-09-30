/**
 * QA retest 2026-09-28 (m6): with a CSV attached to the message, the model's data.load {"path":"branch-qa-sample.csv"}
 * failed with ENOENT: attached files are kept outside the workspace and data.load read only workspace paths, addresses
 * or text. data.load now opens a file attached to the task's own conversation, by the id its message named or, when a
 * bare name is no workspace file, by that exact name. Another conversation's file is never reached.
 * Node only: the real dist/, a scripted model, temporary folders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

const csv = "item,qty,price\napple,2,3\npear,4,1\nplum,1,6\n";
const attached = { name: "branch-qa-sample.csv", mediaType: "text/csv", data: Buffer.from(csv).toString("base64") };

test("data.load opens a file attached to this conversation, by id or by name, and no other", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-data-attached-"));
  let plan = [];
  const provider = { name: "scripted", async complete(request) {
    const said = request.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    const id = /id ([a-f0-9]{16})/.exec(said)?.[1];
    const step = plan.shift();
    return step ? { content: "", toolCalls: [{ id: `c${plan.length}`, name: "data.load", arguments: JSON.stringify(step(id)) }] } : { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const results = (run) => app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => String(m.content));

  plan = [() => ({ path: "branch-qa-sample.csv" }), (id) => ({ attachment: id, name: "sales" }), () => ({ path: "sub/branch-qa-sample.csv" })];
  const first = await app.runtime.run({ prompt: "Subtotals, please.", attachments: [attached], onTextDelta: () => undefined });
  const [byName, byId, nested] = results(first);
  assert.match(byName, /"table":"branch_qa_sample"/, byName);
  assert.match(byName, /"rows":3/);
  assert.match(byId, /"table":"sales"/, byId);
  assert.match(byId, /apple/);
  assert.doesNotMatch(nested, /"rows":3/, "a path with a folder is a workspace path only");

  plan = [() => ({ path: "branch-qa-sample.csv" })];
  const other = await app.runtime.run({ prompt: "And here?", onTextDelta: () => undefined });
  assert.doesNotMatch(results(other)[0], /"rows":3/, "another conversation's file is not reached by name");
  const theirs = app.store.messages(first.sessionId).find((m) => m.attachments?.length).attachments[0].id;
  plan = [() => ({ attachment: theirs })];
  const byOtherId = await app.runtime.run({ prompt: "Or by its id?", onTextDelta: () => undefined });
  assert.match(results(byOtherId)[0] ?? byOtherId.output, /not attached to this conversation/);
});
