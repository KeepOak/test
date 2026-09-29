/* tools.from_openapi takes the description itself, as Settings › Developer sends a file the owner chose (the window reads
   it; the engine never opens a path of the person's computer). A dry run with no allowlist lists every operation the
   description has, so the owner can choose; adding still needs the operations named, and nothing else is registered.
   Mutation: in src/openapi-tools.ts drop the "Name the operations" refine and the add-without-allowlist case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

const DOC = JSON.stringify({
  openapi: "3.0.0", info: { title: "Tiny notes", version: "1" }, servers: [{ url: "http://127.0.0.1:9/v1" }],
  paths: {
    "/notes": { get: { operationId: "listNotes", summary: "List the notes" }, post: { operationId: "addNote", summary: "Add a note" } },
    "/notes/{id}": { delete: { operationId: "removeNote", summary: "Remove a note", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
  },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-openapi-doc-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("a chosen description lists its operations, and only the named ones become tools", async (t) => {
  const app = await fixture(t);
  app.web.policy.configure({ allowPrivateAddresses: true }); // the service is on this computer here; nothing is called
  const shown = await app.runtime.executeTool("tools.from_openapi", { name: "notes", document: DOC, label: "notes.json", dryRun: true });
  assert.equal(shown.dryRun, true);
  assert.equal(shown.service, "Tiny notes");
  assert.equal(shown.base, "http://127.0.0.1:9/v1");
  assert.deepEqual(shown.available.map((one) => `${one.method.toUpperCase()} ${one.path} ${one.operation}`),
    ["GET /notes listNotes", "POST /notes addNote", "DELETE /notes/{id} removeNote"]);
  assert.deepEqual(shown.tools, [], "a dry run with nothing named previews nothing");
  assert.equal(app.registry.names().some((name) => name.startsWith("api.notes.")), false, "and registers nothing");

  await assert.rejects(app.runtime.executeTool("tools.from_openapi", { name: "notes", document: DOC }), /Name the operations/);
  await assert.rejects(app.runtime.executeTool("tools.from_openapi", { name: "notes", document: DOC, file: "x.json", allowlist: ["listNotes"] }), /Give one of/);

  const done = await app.runtime.executeTool("tools.from_openapi", { name: "notes", document: DOC, label: "notes.json", allowlist: ["listNotes"] });
  assert.deepEqual(done.registered, ["api.notes.list_notes"]);
  assert.equal(app.registry.names().includes("api.notes.add_note"), false, "an operation left unticked is not registered");
  const services = await app.runtime.executeTool("tools.services", {});
  assert.deepEqual(services.services.map((one) => [one.name, one.tools]), [["notes", ["api.notes.list_notes"]]]);
  assert.equal(app.registry.targetOf("tools.from_openapi", { name: "notes", document: DOC, label: "notes.json", allowlist: ["listNotes"] }),
    "tools from notes.json as api.notes", "the question names the file, not undefined");
});
