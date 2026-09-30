/**
 * SELF-302: the lead starts several background helpers at once, each on the model it chose and each in its own git
 * worktree, with the worktree switches as they ship (off: a whole copy on disk each time), because the lead asks for
 * each copy by name (helpers.start ownCopy). Each helper's writes land in its own copy only; the project itself is
 * untouched; a copy that holds work is kept and named. (Distinct saved accounts per helper are proven in
 * tests/claude-account-tools.test.mjs, "parallel helpers use distinct saved Claude accounts".)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { locateGit, GitRunner } from "../dist/integrations/git-run.js";
import { discardTemp } from "./temp-dir.mjs";

const git = await locateGit();
const needsGit = { skip: git ? false : "Git is not installed on this computer" };
const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const until = async (check, ms = 60000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (check()) return true; return false; };

/** A model that, as a helper, writes a file named for itself; as the lead, starts three helpers in one step. */
function model(name) {
  return { name, async complete(request) {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const done = request.messages.filter((m) => m.role === "tool").length;
    if (/You are a helper working in the background/.test(system)) {
      const brief = request.messages.find((m) => m.role === "user")?.content ?? "";
      const who = /Helper (\w+)/.exec(brief)?.[1] ?? "unknown";
      if (done === 0) return call("files.write", { path: `notes/${who}.md`, content: `${who} was here on ${name}` }, `w-${who}`);
      return { content: `${who} done on ${name}.`, toolCalls: [] };
    }
    if (done === 0) return { content: "", toolCalls: ["alpha", "beta", "gamma"].map((who) => ({ id: `s-${who}`, name: "helpers.start",
      arguments: JSON.stringify({ brief: `Helper ${who}: write your notes file.`, model: who, ownCopy: true, minutes: 5 }) })) };
    return { content: "Three helpers are working.", toolCalls: [] };
  } };
}

test("the lead starts three helpers at once, each on its own model and in its own worktree", needsGit, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-lead-parallel-"));
  const presets = ["alpha", "beta", "gamma"].map((id) => ({ id, name: id, provider: model(`model-${id}`), model: `model-${id}` }));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model("model-lead"), presets });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const runner = new GitRunner();
  const gitRun = async (args) => { const out = await runner.run({ cwd: app.runtime.workspace, args }, AbortSignal.timeout(30_000)); assert.equal(out.exitCode, 0, out.stderr); };
  await gitRun(["init", "--initial-branch=main"]);
  await gitRun(["config", "user.name", "Test Owner"]);
  await gitRun(["config", "user.email", "owner@example.invalid"]);
  await writeFile(join(app.runtime.workspace, "README.md"), "# Project\n");
  await gitRun(["add", "."]);
  await gitRun(["commit", "-m", "start"]);

  const home = app.trunks.ensureDefault(true);
  const lead = await app.runtime.run({ prompt: "Split this into three helpers", trunkId: home.id, mode: "full" });
  assert.equal(lead.status, "completed", lead.output);
  const helpers = app.store.events(lead.id).filter((e) => e.kind === "delegation.background_started").map((e) => e.data.childRunId);
  assert.equal(helpers.length, 3, "three helpers started in one step");
  assert.ok(await until(() => helpers.every((id) => app.store.run(id)?.status === "completed")), "all three finished");

  const places = new Set();
  for (const [i, who] of ["alpha", "beta", "gamma"].entries()) {
    const id = helpers[i];
    const events = app.store.events(id);
    assert.equal(app.store.run(id).output, `${who} done on model-${who}.`, "each helper ran on the model it was given");
    const used = events.find((e) => e.kind === "worktree.used");
    assert.ok(used, `${who} worked in a copy of its own: ${JSON.stringify(events.map((e) => e.kind))}`);
    assert.match(used.data.path, /^\.branch-worktrees\/helper-[a-f0-9]{8}$/);
    places.add(used.data.path);
    const copy = join(app.runtime.workspace, used.data.path);
    assert.equal(await readFile(join(copy, "notes", `${who}.md`), "utf8"), `${who} was here on model-${who}`, "its writes landed in its own copy");
    assert.ok(events.some((e) => e.kind === "worktree.kept"), "a copy that holds work is kept, and named");
  }
  assert.equal(places.size, 3, "three separate copies");
  assert.equal(existsSync(join(app.runtime.workspace, "notes")), false, "the project itself is untouched");
});
