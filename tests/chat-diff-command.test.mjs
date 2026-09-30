import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatFixture, last } from "./chat-fixture.mjs";

/* CHAT-195: /diff in the owner's own direct chat shows the workspace's tracked Git changes in one fenced reply, through
   the read-only git.diff tool and only when the owner let this chat read Git. */
function repo(workspace) {
  mkdirSync(workspace, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
  writeFileSync(join(workspace, "notes.txt"), "one\n");
  git("add", "notes.txt");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "notes");
  writeFileSync(join(workspace, "notes.txt"), "one\ntwo ```fence```\n");
}

test("/diff needs git.read for the chat, then shows the change fenced; a friend gets nothing", async (t) => {
  const { app, sent, say, root } = await chatFixture(t);
  repo(join(root, "workspace"));
  // With "Your own chats have your full access" on (the default) the owner's own chat reads Git as the window does.
  await say("owner-1", "/diff");
  assert.match(last(sent), /^Tracked Git changes \(workspace folder\):/);
  app.channels.setPermissionSettings({ ownerChats: false });
  await say("owner-1", "/diff");
  assert.match(last(sent), /cannot read Git changes\. Allow git\.read/);
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: "tg", sender: "owner-1", allow: ["git.read"], note: "my phone" }] });
  await say("owner-1", "/diff");
  const reply = last(sent);
  assert.match(reply, /^Tracked Git changes \(workspace folder\):\n```diff\n/);
  assert.match(reply, /\+two ``​`fence``​`/, "the diff's own fences cannot close ours");
  assert.ok(reply.endsWith("\n```"));
  await say("owner-1", "/diff ../outside");
  assert.doesNotMatch(last(sent), /```diff/, "a folder outside the workspace is refused");
  const before = sent.length;
  await say("friend-2", "/diff");
  assert.doesNotMatch(sent.slice(before).map((s) => s.text).join("\n"), /```diff/);
});
