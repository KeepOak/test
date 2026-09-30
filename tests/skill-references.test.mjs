// A skill's text references stay separate and are read a page at a time, at the skill's pinned
// version, only after the skill is on. Scripts are never readable or run.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { zipWrite } from "../dist/skill-package.js";
import { agentSkillPackage, readAgentSkill } from "../dist/agent-skills.js";

const skill = "---\nname: tidy-summary\ndescription: Tidy summaries of long notes.\n---\n\n# tidy-summary\n\nUse the style guide.\n";

test("a pinned skill's reference is listed by skills.read and loaded by skills.read_file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-skill-refs-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const read = readAgentSkill(zipWrite([["tidy-summary/SKILL.md", skill],
    ["tidy-summary/references/style guide.md", "Short sentences. No jargon."], ["tidy-summary/scripts/run.py", "print(1)"]]));
  assert.doesNotMatch(read.document, /Short sentences/, "the reference is not pasted into the instructions");
  app.skillPackages.install(agentSkillPackage(read), true);
  const [installed] = app.store.skills.list("local");
  app.store.skills.activate("local", installed.id, { version: 1, expectedRevision: installed.revision });
  const context = app.runtime.context();

  const loaded = await app.registry.execute("skills.read", { id: installed.id, version: 1 }, context);
  assert.deepEqual(loaded.resources, ["references/style-guide.md"]);
  const page = await app.registry.execute("skills.read_file",
    { id: installed.id, version: 1, path: "references/style-guide.md" }, context);
  assert.equal(page.text, "Short sentences. No jargon.");
  assert.equal(page.nextOffset, null);
  await assert.rejects(app.registry.execute("skills.read_file",
    { id: installed.id, version: 1, path: "scripts/run.py" }, context), /not in this skill version/);
});
