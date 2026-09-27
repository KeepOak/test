/**
 * The bounded diff of a change to Branch itself, before the owner's yes (GET
 * /api/self-development/requests/<id>/diff; src/self-development-diff.ts). Before a request is prepared
 * there is nothing to show and it says so; once prepared, the worktree's changes since the contract's
 * commit are shown file by file, bounded, with files outside the allowed paths named. A real Git
 * repository in a temporary folder; nothing reaches a network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { parsePatch, nothingPreparedYet } from "../dist/self-development-diff.js";

const terms = { allowedPaths: ["src/ui/**", "tests/ui.test.mjs"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The Export button is gone", sideEffects: [], rollbackPlan: "Remove the worktree and its branch" };
const worktree = "branch-agent-source/.branch-worktrees/self-remove-export";
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

test("a unified diff becomes marked lines per file, bounded per file", () => {
  const patch = ["diff --git a/src/ui/panel.ts b/src/ui/panel.ts", "index 1..2 100644", "--- a/src/ui/panel.ts", "+++ b/src/ui/panel.ts",
    "@@ -1,2 +1,2 @@", " keep", "-old", "+new", "\\ No newline at end of file",
    "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "diff --git a/big.txt b/big.txt", "--- a/big.txt", "+++ b/big.txt", "@@ -0,0 +1,500 @@", ...Array.from({ length: 500 }, (_, i) => `+line ${i}`)].join("\n");
  const [panel, gone, big] = parsePatch(patch);
  assert.deepEqual(panel, { path: "src/ui/panel.ts", added: 1, removed: 1, cut: false,
    lines: [{ m: " ", t: "@@ -1,2 +1,2 @@" }, { m: " ", t: "keep" }, { m: "-", t: "old" }, { m: "+", t: "new" }] });
  assert.deepEqual([gone.path, gone.removed], ["gone.txt", 1]);
  assert.deepEqual([big.added, big.lines.length, big.cut], [500, 400, true], "counted in full, shown up to the bound, and marked cut");
});

test("the owner reads the bounded diff of a prepared change; before the yes it says nothing has changed; keys and household are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-diff-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, key = server.token) => {
    const response = await fetch(server.url + path, { headers: { authorization: "Bearer " + key } });
    return { status: response.status, body: await response.json() };
  };
  // Branch's source checked out, and a self-development worktree made from it at a known commit.
  const source = join(workspace, "branch-agent-source");
  await mkdir(join(source, "src", "ui"), { recursive: true });
  await writeFile(join(source, "src", "ui", "panel.ts"), "export const buttons = [\"Share\", \"Export\"];\n");
  await writeFile(join(source, "README.md"), "Branch\n");
  git(source, "init", "-q", "-b", "main");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "start");
  const sha = git(source, "rev-parse", "HEAD");
  git(source, "worktree", "add", "-q", "-b", "branch/self-remove-export", ".branch-worktrees/self-remove-export", sha);
  new ContractBook(app.store.sqlite).create(app.runtime.owner, { taskRunId: "", sourceSha: sha, worktreePath: worktree, terms });
  const insert = (status, answer) => {
    const id = randomUUID();
    app.store.sqlite.prepare("INSERT INTO self_development_requests(id, owner, text, sender, status, created_at, answer) VALUES(?,?,?,?,?,?,?)")
      .run(id, app.runtime.owner, "Take the Export button out", JSON.stringify({ channel: "chat", chatId: "1", senderId: "sam", senderName: "Sam", messageId: "m1" }),
        status, new Date().toISOString(), answer ? JSON.stringify(answer) : null);
    return id;
  };
  const waiting = insert("waiting", null);
  const prepared = insert("approved", { at: new Date().toISOString(), worktree, revision: 1, sourceSha: sha });

  const before = await call(`/api/self-development/requests/${waiting}/diff`);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual([before.body.files, before.body.note], [[], nothingPreparedYet]);
  const unchanged = await call(`/api/self-development/requests/${prepared}/diff`);
  assert.deepEqual([unchanged.body.files, unchanged.body.untracked], [[], []]);
  assert.match(unchanged.body.note, /has changed yet/);

  const copy = join(workspace, worktree);
  await writeFile(join(copy, "src", "ui", "panel.ts"), "export const buttons = [\"Share\"];\n");
  await writeFile(join(copy, "README.md"), "Branch, changed outside the contract\n");
  await writeFile(join(copy, "src", "ui", "new-panel.ts"), "export {};\n");
  const shown = await call(`/api/self-development/requests/${prepared}/diff`);
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  const panel = shown.body.files.find((f) => f.path === "src/ui/panel.ts");
  assert.deepEqual([panel.added, panel.removed], [1, 1]);
  assert.ok(panel.lines.some((l) => l.m === "-" && l.t.includes("\"Export\"")));
  assert.deepEqual(shown.body.untracked, ["src/ui/new-panel.ts"], "new files by name only");
  assert.deepEqual(shown.body.outside, ["README.md"], "a file outside the allowed paths is named");
  assert.deepEqual([shown.body.truncated, shown.body.note, shown.body.allowedPaths], [false, null, terms.allowedPaths]);
  assert.equal(shown.body.warning, "These changed files are outside the contract's allowed paths: README.md.");
  assert.equal(git(copy, "ls-files", "src/ui/new-panel.ts"), "", "showing it added nothing to Git's index");

  assert.equal((await call(`/api/self-development/requests/${randomUUID()}/diff`)).status, 400);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call(`/api/self-development/requests/${prepared}/diff`, key)).status, 401);
  const person = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: person.id, pin: "2468" });
  assert.equal((await call(`/api/self-development/requests/${prepared}/diff`)).status, 400, "a household person is refused");
  app.store.profiles.switch({ profileId: null });
});
