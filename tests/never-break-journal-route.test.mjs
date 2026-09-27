/**
 * p17: the never-break journal in Settings › Gateway. GET /api/never-break/journal lists every update tried, kept
 * or rolled back, newest first, read without writing; it is the owner's alone, like last-update.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { ActivationJournal, recentActivations } from "../dist/never-break/activation.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const entry = (dataDir) => ({ kind: "update", target: join(dataDir, "app"), previous: null, candidate: null, launcher: null,
  executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] });

test("the journal lists activations newest first, with how each ended, and looking creates nothing", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-nb-journal-"));
  t.after(() => discardTemp(dataDir));
  assert.deepEqual(recentActivations(dataDir), [], "nothing recorded");
  assert.equal(existsSync(join(dataDir, "activation.sqlite")), false, "and no journal is created by looking");
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  journal.activated(journal.stage({ ...entry(dataDir), fromVersion: "0.19.2", toVersion: "0.19.3" }));
  journal.failed(journal.stage({ ...entry(dataDir), fromVersion: "0.19.3", toVersion: "9.9.9" }));
  journal.close();
  const listed = recentActivations(dataDir);
  assert.deepEqual(listed.map(({ fromVersion, toVersion, state }) => [fromVersion, toVersion, state]),
    [["0.19.3", "9.9.9", "failed"], ["0.19.2", "0.19.3", "activated"]]);
  assert.equal(listed[0].kind, "update");
  assert.equal(typeof listed[0].startedAt, "string");
  assert.equal(Object.keys(listed[0]).includes("target"), false, "no paths go out");
});

test("the route answers the owner, and refuses a household person and a short-lived key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-nb-journal-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const journal = new ActivationJournal(join(root, "data", "activation.sqlite"));
  journal.activated(journal.stage({ ...entry(root), fromVersion: "1.0.0", toVersion: "1.1.0" }));
  journal.close();
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const mine = await call("GET", "/api/never-break/journal");
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.entries.map((e) => [e.fromVersion, e.toVersion, e.state]), [["1.0.0", "1.1.0", "activated"]]);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 5 }).token;
  const byKey = await fetch(server.url + "/api/never-break/journal", { headers: { authorization: `Bearer ${key}` } });
  assert.equal(byKey.status, 401, "a short-lived key is refused");
  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "4321" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "4321" })).status, 200);
  const refused = await call("GET", "/api/never-break/journal");
  assert.notEqual(refused.status, 200);
  assert.match(refused.body.error, /belongs to the owner/);
});

/* Mutation note: deleting the journal regex from src/short-lived-keys.ts makes the key and household checks in the
   second test fail (both are answered 200); changing ORDER BY id DESC to ASC in recentActivations fails the first. */
