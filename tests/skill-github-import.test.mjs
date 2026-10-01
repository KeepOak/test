// Importing a skill from GitHub: files are read at one pinned tree, each checked against the
// tree's own fingerprint, scripts are left out, and the preview is held once for the owner.
// GitHub is a stand-in here: the network policy's sender is replaced, so nothing leaves this computer.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchGitHubSkill, quarantineGitHubSkill, takeGitHubSkill } from "../dist/skill-github.js";

const gitSha = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
const skill = "---\nname: tidy-notes\ndescription: Tidy notes.\n---\nKeep it short.\n";
const reference = "Short sentences.";
const treeSha = "a".repeat(40);

function host({ locked = false, tamper = false } = {}) {
  const asked = [];
  const blobs = { [gitSha(skill)]: skill, [gitSha(reference)]: tamper ? "Changed." : reference };
  const tree = { sha: treeSha, truncated: false, tree: [
    { path: "tidy-notes", mode: "040000", type: "tree", sha: "b".repeat(40) },
    { path: "tidy-notes/SKILL.md", mode: "100644", type: "blob", sha: gitSha(skill), size: Buffer.byteLength(skill) },
    { path: "tidy-notes/references/style.md", mode: "100644", type: "blob", sha: gitSha(reference), size: Buffer.byteLength(reference) },
    { path: "tidy-notes/scripts/run.py", mode: "100755", type: "blob", sha: "c".repeat(40), size: 9 },
  ] };
  const answer = (url) => {
    asked.push(url);
    const blob = /\/git\/blobs\/([a-f0-9]{40})$/.exec(url)?.[1];
    if (blob) return new Response(blobs[blob]);
    if (url.includes(`/git/trees/${treeSha}`)) return new Response(JSON.stringify(tree));
    return new Response("not found", { status: 404 });
  };
  const store = { profiles: { requireOwner() {} } };
  return { asked, app: { store, runtime: { owner: "local" }, sessionLock: { state: () => ({ locked }) },
    web: { policy: { guard: () => async (url) => answer(String(url)) } } } };
}
const request = { owner: "someone", repo: "skills", path: "tidy-notes", treeSha };

test("a pinned GitHub skill is read file by file against its tree, and its scripts are left out", async () => {
  const { app, asked } = host();
  const fetched = await fetchGitHubSkill(app, request);
  assert.equal(fetched.folder.name, "tidy-notes");
  assert.deepEqual(Object.values(fetched.folder.notes), [reference]);
  assert.deepEqual(fetched.leftOut, ["scripts/run.py"]);
  assert.equal(fetched.origin.treeSha, treeSha);
  assert.ok(asked.every((url) => url.startsWith("https://api.github.com/repos/someone/skills/")));
  assert.ok(!asked.some((url) => url.includes("c".repeat(40))), "a left-out script is never downloaded");

  await assert.rejects(fetchGitHubSkill(host({ tamper: true }).app, request), /did not match the pinned tree/);
  const locked = host({ locked: true });
  await assert.rejects(fetchGitHubSkill(locked.app, request), /Unlock Branch/);
  assert.deepEqual(locked.asked, [], "nothing is asked of GitHub while Branch is locked");
});

test("a held preview is used once, and only as it was held", () => {
  const { app } = host();
  const bytes = Buffer.from("package bytes");
  const origin = { owner: "someone", repo: "skills", path: "tidy-notes", treeSha, url: "u",
    digest: createHash("sha256").update(bytes).digest("hex") };
  const ticket = quarantineGitHubSkill(app, bytes, origin);
  bytes.fill(0);
  assert.equal(takeGitHubSkill(app, ticket).bytes.toString(), "package bytes", "the held copy is the server's own");
  assert.throws(() => takeGitHubSkill(app, ticket), /expired/, "a preview is used once");
});
