/**
 * SELF-052: "Try a bad change" runs a real rollback on throwaway programs. The bad program fails, the
 * real rollback puts the previous one back, the real gateway starts it, and the report is kept.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { discardTemp } from "./temp-dir.mjs";
import { lastRecoveryDrill, runRecoveryDrill } from "../dist/never-break/drill.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("SELF-052: the isolated drill rolls a bad fixture back and keeps its report", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-drill-"));
  t.after(() => discardTemp(dataDir));
  assert.equal(await lastRecoveryDrill(dataDir), null);
  const [drill, second] = await Promise.allSettled([runRecoveryDrill(dataDir), runRecoveryDrill(dataDir)]);
  assert.equal(second.status, "rejected", "a second drill at once is refused");
  assert.equal(drill.value.ok, true, drill.value.detail);
  assert.ok(drill.value.ledger.length > 0, "the rollback ledger is reported");
  assert.deepEqual(await lastRecoveryDrill(dataDir), drill.value);
});

/* Review of #1139: the owner and door checks ran before the body was read, and the drill launched after that wait with
   nothing asked again. Each case holds the body back until the first check has run, changes who may act, then sends it. */
async function drillAfter(t, change) {
  const root = await mkdtemp(join(tmpdir(), "branch-drill-route-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  let asked = 0;
  const requireOwner = app.store.profiles.requireOwner.bind(app.store.profiles);
  app.store.profiles.requireOwner = (what) => { asked++; return requireOwner(what); };
  const answer = await new Promise((resolve, reject) => {
    const req = httpRequest(new URL("/api/never-break/drill", server.url), { method: "POST", headers: {
      authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url, "transfer-encoding": "chunked" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.flushHeaders();
    const whenChecked = () => {
      if (asked === 0) { setImmediate(whenChecked); return; }
      change(app);
      req.end(JSON.stringify({ confirm: true }));
    };
    whenChecked();
  });
  return { answer, report: await lastRecoveryDrill(dataDir) };
}

test("SELF-052: App lock turned on while the drill request's body is pending stops the launch", async (t) => {
  const { answer, report } = await drillAfter(t, (app) => app.sessionLock.lock());
  assert.equal(answer.status, 423, answer.text);
  assert.equal(report, null, "the drill ran and wrote its report after App lock");
});

test("SELF-052: a switch to a household profile while the drill request's body is pending stops the launch", async (t) => {
  const { answer, report } = await drillAfter(t, (app) => {
    const profile = app.store.profiles.create({ name: "Sam", pin: "2468" });
    app.store.profiles.switch({ profileId: profile.id, pin: "2468" });
  });
  assert.ok(answer.status >= 400 && answer.status < 500, `${answer.status} ${answer.text}`);
  assert.match(answer.text, /belongs to the owner/);
  assert.equal(report, null, "the drill ran and wrote its report for another profile");
});
