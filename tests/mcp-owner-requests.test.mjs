/**
 * RES-134: a tool server may ask the owner a question (a form) or ask for a model reply (sampling) only
 * when the owner switched that on for that server AND the owner's question window is open right now.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { McpOwnerRequests } from "../dist/mcp-owner-requests.js";

test("RES-134: nothing is offered by default, and a switched-on form is offered only while the owner's window is open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-asks-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const asks = new McpOwnerRequests(app.store, () => app.runtime.owner, app.runtime.models);
  asks.window();
  assert.deepEqual(asks.capabilities("files"), {}, "off by default");
  assert.throws(() => asks.save({ server: "files", settings: { sampling: true } }), /allowed model/);
  asks.save({ server: "files", settings: { elicitation: true } });
  assert.deepEqual(asks.capabilities("files"), { elicitation: { form: {} } });
  assert.deepEqual(asks.capabilities("other"), {}, "only the server it was switched on for");
  asks.closeWindow();
  assert.deepEqual(asks.capabilities("files"), {}, "no open window, nothing offered");
  await assert.rejects(asks.answer({ id: "00000000-0000-4000-8000-000000000000", action: "accept" }), /no longer available/);
});
