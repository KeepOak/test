/* One personal main thread shared between the owner window and the owner's own Telegram DM, only by the owner's explicit
   choice, and held the moment the account, access or default Trunk changes (src/channels/personal-main.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { PersonalMainThread } from "../dist/channels/personal-main.js";

test("the owner's DM joins the exact default-Trunk conversation only while it is still the owner's, live, direct chat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-personal-main-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, sessionId = app.store.createSession(owner), trunkId = randomUUID();
  let main = { sessionId, trunkId }, eligible = true;
  const thread = new PersonalMainThread(app.store, owner, () => main, () => eligible);
  assert.equal(thread.session("tg", "123"), undefined, "nothing is shared until the owner chooses");
  assert.throws(() => thread.set({ on: true, channel: "tg", sender: "123", sessionId: app.store.createSession(owner), trunkId }), /default-Trunk conversation/,
    "only the current default-Trunk conversation");
  thread.set({ on: true, channel: "tg", sender: "123", sessionId, trunkId });
  assert.equal(thread.session("tg", "123"), sessionId);
  assert.equal(thread.session("tg", "999"), undefined, "another chat keeps its own conversation");
  assert.throws(() => thread.assertMessage({ channel: "tg", chatId: "123", senderId: "123", chatKind: "direct", caughtUp: true }), /live message/);
  assert.throws(() => thread.assertMessage({ channel: "tg", chatId: "123", senderId: "456", chatKind: "direct" }), /exact owner Telegram DM/);
  thread.assertMessage({ channel: "tg", chatId: "123", senderId: "123", chatKind: "direct" });
  eligible = false;
  assert.throws(() => thread.session("tg", "123"), /held/, "revoked access holds the sharing");
  eligible = true; main = { sessionId: app.store.createSession(owner), trunkId };
  assert.throws(() => thread.session("tg", "123"), /held/, "a changed default Trunk conversation holds it too");
  thread.set({ on: false });
  assert.equal(thread.saved(), null);
});
