/* SCREEN-162: a finished reply shows the browser frame its task recorded, but only one backed by a successful screenshot
   receipt that matches the task's own stored PNG (path, size, digest). The file route serves it only to the profile
   whose task made it. A headless window on a temporary Branch; no site is visited. */
import test from "node:test";
import assert from "node:assert/strict";

import { newWindow } from "./new-window-places.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("SCREEN-162: only a receipt that matches the task's stored picture counts as proof", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  const picked = await page.evaluate(async () => {
    const { browserProofReceipt } = await import("/app/chat/browser-proof.js");
    const run = { id: "r1" }, sha = "a".repeat(64);
    const kept = [{ runId: "r1", path: "/k/r1/shot.png", mediaType: "image/png", bytes: 100 }, { runId: "r2", path: "/k/r2/other.png", mediaType: "image/png", bytes: 100 }];
    const call = (id, name) => ({ role: "assistant", toolCalls: [{ id, name }] });
    const answer = (id, body) => ({ role: "tool", toolCallId: id, content: JSON.stringify(body) });
    const good = { ok: true, result: { path: "/k/r1/shot.png", bytes: 100, sha256: sha } };
    return {
      good: browserProofReceipt(run, [call("c1", "browser.screenshot"), answer("c1", good)], kept),
      failed: browserProofReceipt(run, [call("c1", "browser.screenshot"), answer("c1", { ...good, ok: false })], kept),
      otherTask: browserProofReceipt(run, [call("c1", "browser.screenshot"), answer("c1", { ok: true, result: { path: "/k/r2/other.png", bytes: 100, sha256: sha } })], kept),
      wrongSize: browserProofReceipt(run, [call("c1", "browser.screenshot"), answer("c1", { ok: true, result: { ...good.result, bytes: 99 } })], kept),
      otherTool: browserProofReceipt(run, [call("c1", "files.read"), answer("c1", good)], kept),
      flow: browserProofReceipt(run, [call("c2", "browser.flow"), answer("c2", { ok: true, result: { steps: [{}, { screenshot: good.result }] } })], kept),
    };
  });
  assert.deepEqual(picked.good, { path: "/k/r1/shot.png", bytes: 100, sha256: "a".repeat(64), mediaType: "image/png" });
  assert.deepEqual([picked.failed, picked.otherTask, picked.wrongSize, picked.otherTool], [null, null, null, null]);
  assert.equal(picked.flow?.path, "/k/r1/shot.png", "a flow's last step's screenshot counts too");
  assert.deepEqual(errors, []);
});

test("SCREEN-162: the task's picture file is served to its own profile, not to another one", { timeout: 180000 }, async (t) => {
  const { app, server } = await newWindow(t);
  const run = app.store.createRun(app.runtime.owner, "look at the page");
  const kept = await app.artifacts.write(run.id, "screenshot-aa.png", "image/png", png);
  const status = async () => (await fetch(`${server.url}/api/artifacts/file?path=${encodeURIComponent(kept.path)}`,
    { headers: { authorization: `Bearer ${server.token}` } })).status;
  assert.equal(await status(), 200, "the owner's window gets its task's picture");
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  assert.notEqual(await status(), 200, "another profile does not");
});
