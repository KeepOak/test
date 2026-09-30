/**
 * RES-125: the scheduled GitHub backup. When it is due it uploads the owner's memory and nothing of the
 * conversations, moves its next time on, and a failure is written down and waits for the next turn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { ScheduledGitHubBackup } from "../dist/scheduled-backup.js";

test("RES-125: a due backup carries memory but no conversation, and a refused upload is recorded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gh-backup-"));
  const provider = { name: "scripted", async complete() { return { content: "Private words in a chat.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  await app.runtime.run({ prompt: "Tell me something private" });
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "x").id });
  await app.registry.execute("memory.put", { text: "Prefers tea to coffee", source: "said so", kind: "preference" }, context);
  const uploads = [];
  let refuse = false;
  const github = { backupRepository: async () => ({ id: 9, private: true, push: true }),
    createBackup: async (_repo, _id, text, beforeSend) => {
      beforeSend();
      if (refuse) throw new Error("GitHub refused it");
      uploads.push(text);
      return { commit: "c".repeat(40), blob: "b".repeat(40) };
    } };
  const backup = new ScheduledGitHubBackup(app.store, app.runtime.owner, join(root, "data"), "test", () => github, (v) => v);
  const due = new Date(Date.now() - 1000).toISOString();
  app.store.save("settings", app.runtime.owner, "scheduled-github-backup", { enabled: true, repo: "me/backups", repositoryId: 9,
    project: app.store.projects.active(app.runtime.owner).id, hours: 24, nextAt: due });
  await backup.tick(new Date());
  assert.equal(uploads.length, 1, JSON.stringify(backup.status()));
  assert.match(uploads[0], /Prefers tea to coffee/);
  assert.doesNotMatch(uploads[0], /Private words in a chat|Tell me something private/);
  assert.ok(Date.parse(backup.settings().nextAt) > Date.now() + 23 * 3_600_000, "the next backup is a day away");
  await backup.tick(new Date());
  assert.equal(uploads.length, 1, "not due again yet");
  refuse = true;
  await backup.tick(new Date(Date.now() + 25 * 3_600_000));
  assert.match(backup.status().problem, /refused/);
});
