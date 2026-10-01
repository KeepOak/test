import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { check, has, toolCalls } from "../tasks/util.mjs";

/** An explicit, offline export; never opens the owner's live database or discovers credentials. */
export async function ownerSkillTasks(file) {
  if (!file) return [];
  if ((await stat(file)).size > 1024 * 1024) throw new Error("Owner skill eval export exceeds 1 MiB");
  const bundle = JSON.parse(await readFile(file, "utf8"));
  if (bundle?.version !== 1 || !Array.isArray(bundle.skills) || !bundle.skills.length || bundle.skills.length > 50)
    throw new Error("Owner skill eval export needs version 1 and 1–50 skills");
  const ids = new Set();
  return bundle.skills.flatMap((skill) => {
    validateSkill(skill);
    if (ids.has(skill.id)) throw new Error("Duplicate owner skill eval id");
    ids.add(skill.id);
    const digest = createHash("sha256").update(skill.document).digest("hex");
    return skill.cases.map((example, index) => skillTask(skill, example, index, digest));
  });
}

function validateSkill(skill) {
  if (!skill || typeof skill.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.id)
    || typeof skill.document !== "string" || !skill.document.trim() || skill.document.length > 100_000
    || !Array.isArray(skill.cases) || !skill.cases.length || skill.cases.length > 20)
    throw new Error("Each owner skill needs a safe id, document, and 1–20 cases");
  for (const example of skill.cases) {
    if (!example || typeof example.prompt !== "string" || !example.prompt.trim() || example.prompt.length > 10_000
      || !Array.isArray(example.answerContains) || !example.answerContains.length || example.answerContains.length > 20
      || example.answerContains.some((value) => typeof value !== "string" || !value.trim() || value.length > 1000))
      throw new Error("Each skill case needs a prompt and 1–20 nonempty answerContains checks");
  }
}

function skillTask(skill, example, index, digest) {
  return {
    id: `owner-skill-${skill.id}-${index + 1}`, area: "owner-skills",
    title: `Owner skill ${skill.id}, case ${index + 1}`, needsTools: true, timeoutMs: 300_000,
    async run(ctx) {
      const installed = await ctx.api("skills/install", { document: skill.document });
      if (installed.activeVersion !== 1) return { status: "n/a", reason: "skill scan requires owner review", checks: [] };
      const result = await ctx.ask(`Use the installed skill ${installed.name} (id ${installed.id}, version 1).\n${example.prompt}`);
      const calls = await toolCalls(ctx, result.id);
      const read = calls.some((call) => call.name === "skills.read" && call.ok
        && (typeof call.output === "string" ? call.output : JSON.stringify(call.output)).includes(installed.id));
      return {
        checks: [check("run completed", result.status === "completed"), check("selected skill was read", read),
          ...example.answerContains.map((value, n) => check(`answer check ${n + 1}`, has(result.answer, value)))],
        detail: `document sha256 ${digest}; case ${index + 1}`,
      };
    },
  };
}
