/**
 * Trunk voice: each Trunk speaks in its own voice, or the owner's if empty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startServer } from "../dist/server.js";
import { fixture, on } from "./trunks-helpers.mjs";

test("voice schema: trimmed, max 80 chars, with default empty", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const trunk = app.trunks.create({ name: "Va" });
  assert.equal(trunk.voice, "", "defaults to empty string");

  const withVoice = app.trunks.edit(trunk.id, { voice: "  British Female  " });
  assert.equal(withVoice.voice, "British Female", "trimmed");

  assert.throws(
    () => app.trunks.edit(trunk.id, { voice: "x".repeat(81) }),
    /voice/,
    "rejects >80 chars"
  );

  assert.doesNotThrow(() => {
    app.trunks.edit(trunk.id, { voice: "x".repeat(80) });
  }, "accepts exactly 80 chars");

  await app.trunks.introduced();
});

test("voice travels in export and import; empty voice is preserved", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const vb = app.trunks.create({ name: "Vb", title: "Speaker" });

  // Export with default (empty) voice
  const fileDefault = app.trunks.exportFile(vb.id);
  assert.equal(fileDefault.trunk.voice, "", "empty voice exported");

  // Add voice and export
  app.trunks.edit(vb.id, { voice: "Deep Male" });
  const fileWithVoice = app.trunks.exportFile(vb.id);
  assert.equal(fileWithVoice.trunk.voice, "Deep Male", "voice exported");

  // Import file with voice
  const imported = app.trunks.importFile(fileWithVoice);
  assert.equal(imported.voice, "Deep Male", "voice imported");
  assert.equal(imported.id !== vb.id, true, "imported has new id");

  // Import file with empty voice
  const importedDefault = app.trunks.importFile(fileDefault);
  assert.equal(importedDefault.voice, "", "empty voice imported");

  await app.trunks.introduced();
});

test("TrunkBrief includes voice", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const vc = app.trunks.create({ name: "Vc" });
  app.trunks.edit(vc.id, { voice: "English Female" });

  const roster = app.trunks.roster();
  const brief = roster.trunks.find((t) => t.id === vc.id);
  assert.equal(brief.voice, "English Female", "TrunkBrief has voice");
  assert.equal(typeof brief.voice, "string");

  await app.trunks.introduced();
});

test("voice in conversation info: /api/trunks/conversations includes Trunk voice", async (t) => {
  const { app, root } = await fixture(t);
  on(app, "conversations");

  const ve = app.trunks.create({ name: "Ve" });
  app.trunks.edit(ve.id, { voice: "Australian" });
  await app.trunks.introduced();

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());

  const ask = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };

  // Start a conversation with the Trunk
  const convResult = await ask("/api/trunks/conversations", { trunkId: ve.id });
  const sessionId = convResult.body.sessionId;

  // Fetch conversation info
  const infoResult = await ask(`/api/trunks/conversations/${sessionId}`);
  assert.equal(infoResult.status, 200, "conversation info retrieved");
  assert.equal(infoResult.body.trunk.voice, "Australian", "voice in TrunkBrief");
});

test("a Trunk saved before voices existed reads as your own voice everywhere the window looks", async (t) => {
  const { app, root } = await fixture(t);
  on(app, "conversations");
  const old = app.trunks.create({ name: "Old" });
  await app.trunks.introduced();
  // Saved as a Trunk from before this change was: no voice at all.
  const key = `trunk:${old.id}`;
  const { voice: _gone, ...legacy } = app.store.get("governance", app.runtime.owner, key).data;
  app.store.save("governance", app.runtime.owner, key, legacy);
  assert.equal("voice" in app.store.get("governance", app.runtime.owner, key).data, false);
  assert.equal(app.trunks.roster().trunks.find((one) => one.id === old.id).voice, "", "the roster");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const ask = async (path, body) => (await fetch(server.url + path, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const { sessionId } = await ask("/api/trunks/conversations", { trunkId: old.id });
  assert.equal((await ask(`/api/trunks/conversations/${sessionId}`)).trunk.voice, "", "the conversation");
  assert.equal(app.trunks.exportFile(old.id).trunk.voice, "", "the Trunk's file");
});
