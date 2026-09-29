import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import { trialRefusal, type TrialReport, type TrialTask } from "./skill-revisions.js";
import { parseSkillDocument } from "./skill-document.js";
import { detectInjection } from "./content-guard.js";
import { describeFindings, scanSkill } from "./skill-scan.js";

/**
 * Help with writing skills. The first part reads several tasks that went well and proposes one
 * improved set of instructions from all of them, saved as a new version that is not switched on.
 * The second part takes the examples the skill lists under an "## Examples" heading, runs each one
 * with the skill in place, and reports what happened, so a change can be judged before it is used.
 */
export const DraftFromRunsSchema = z.object({
  skillId: z.string().uuid(),
  /** Two or more finished tasks where this skill was used and the result was good. */
  runIds: z.array(z.string().uuid()).min(2).max(6),
}).strict();
export const SkillTestSchema = z.object({
  version: z.number().int().min(1).max(20).optional(),
  /** Overrides the examples in the document; each one is run as a task with the skill in place. */
  examples: z.array(z.string().trim().min(1).max(500)).max(6).optional(),
}).strict();

/** The example tasks a skill lists under an "## Examples" heading, one per bullet. */
export function skillExamples(document: string): string[] {
  const lines = document.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,}\s*Examples?\s*$/i.test(line));
  if (start < 0) return [];
  const examples: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,}\s/.test(line)) break;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim();
    if (bullet && bullet.length > 3) examples.push(bullet);
  }
  return examples.slice(0, 6);
}

function transcriptOf(store: Store, owner: string, runId: string): string {
  const run = store.run(runId);
  if (!run || run.owner !== owner) throw new Error(`Task ${runId} was not found`);
  return store.messages(run.sessionId).filter((message) => message.role !== "system")
    .map((message) => `${message.role}: ${message.content.slice(0, 600)}`).join("\n").slice(0, 4000);
}

/** Proposes one improved version of a skill from several tasks that went well; the version in use does not change. */
export async function draftFromRuns(store: Store, owner: string, runtime: Runtime, input: unknown) {
  const spec = DraftFromRunsSchema.parse(input);
  const skill = store.skills.view(owner, spec.skillId);
  const examples = spec.runIds.map((runId, index) => `Task ${index + 1} (${runId}):\n${transcriptOf(store, owner, runId)}`).join("\n\n");
  const parent = await runtime.run({ prompt: `Draft an improved version of skill "${skill.name}" from ${spec.runIds.length} tasks` });
  const child = await runtime.delegate(
    `Current SKILL.md:\n${skill.document}\n\nTasks where this skill was used and things went well:\n${examples}\n\n` +
    "Write one improved SKILL.md covering what all of these tasks needed. Keep the same name line. Reply with the full document only, starting with ---.",
    runtime.context({ runId: parent.id }), [], "You improve skill documents from real task traces. Output only the document.", { timeoutMs: 120000 });
  if (child.status !== "completed") throw new Error(`The draft could not be produced (${child.status})`);
  const document = child.output.replace(/^```[a-z]*\n?|```$/g, "").trim();
  const updated = store.skills.update(owner, spec.skillId, { document, expectedRevision: skill.revision });
  store.save("settings", owner, `skill-candidate:${spec.skillId}:${updated.headVersion}`, { fromRunIds: spec.runIds, draftRunId: child.id, createdAt: new Date().toISOString() });
  store.event(parent.id, "skill.candidate_drafted", { skillId: spec.skillId, version: updated.headVersion, fromRunIds: spec.runIds, activeVersion: updated.activeVersion });
  return { skill: updated, candidateVersion: updated.headVersion, originalVersion: skill.headVersion, fromRunIds: spec.runIds };
}

/** Runs a skill's own examples with that skill in place and reports how each one went. */
export async function testSkill(store: Store, owner: string, runtime: Runtime, skillId: string, input: unknown) {
  const spec = SkillTestSchema.parse(input);
  const skill = store.skills.view(owner, skillId);
  const version = spec.version ?? skill.activeVersion ?? skill.headVersion;
  const document = store.skills.read(owner, skillId, { version }).document;
  const examples = spec.examples ?? skillExamples(document);
  if (!examples.length) throw new Error('This skill lists no examples. Add an "## Examples" heading with one task per bullet, or send examples with the request.');
  const parent = await runtime.run({ prompt: `Test skill "${skill.name}" v${version} on ${examples.length} example(s)` });
  const context = runtime.context({ runId: parent.id });
  const results: { example: number; prompt: string; runId: string; status: string; passed: boolean; output: string; ms: number }[] = [];
  for (const [index, example] of examples.entries()) {
    const started = Date.now();
    const run = await runtime.delegate(example, context, [...context.permissions].filter((p) => !["shell.execute", "remote.execute", "git.remote", "github.manage", "gitlab.manage"].includes(p)),
      `Skill under test (v${version}):\n${document}`, { timeoutMs: 120000 });
    results.push({ example: index, prompt: example, runId: run.id, status: run.status, passed: run.status === "completed", output: run.output.slice(0, 600), ms: Date.now() - started });
  }
  const report = { id: randomUUID(), skillId, name: skill.name, version, parentRunId: parent.id, results,
    summary: { passed: results.filter((result) => result.passed).length, total: results.length }, createdAt: new Date().toISOString() };
  store.save("governance", owner, `skill-test:${report.id}`, report);
  store.event(parent.id, "skill.tested", { skillId, version, summary: report.summary });
  return report;
}

/*
 * mac3/reflection-skills: drafting from a note, drafting a brand-new skill, and trying a new skill
 * against having none. The criteria for when something deserves to be a skill at all follow Gemini
 * CLI's skill-extraction agent (Apache-2.0) and Hermes Agent's skill review (MIT), written again in
 * Branch's words; see THIRD_PARTY_NOTICES.md.
 */

/**
 * A task row that only groups the model calls below; it never runs a conversation of its own. A
 * writing call gets no tools; a practice run gets the usual ones, each only saying what it would do.
 */
export const learningTaskPrefix = "Learning: ";
export function learningTask(store: Store, owner: string, prompt: string, runtime: Runtime, practice = false) {
  const parent = store.createRun(owner, (learningTaskPrefix + prompt).slice(0, 300));
  // fix399: its conversation (and each helper it starts, src/runtime.ts) is kept out of Recent, and kept, so the records
  // that point back to it (a candidate's draftRunId, a suggestion's runId) still find it.
  store.markAside(parent.id, { recent: false });
  // Marked as nobody's own request, so the daily look over finished tasks (MemoryReview.consolidate)
  // passes it by the same way it passes a handed-off sub-task: the learning passes never learn from
  // their own work.
  store.event(parent.id, "run.started", { parentRunId: "learning", source: "learning" });
  return { parent, context: practice ? runtime.context({ runId: parent.id, dryRun: true }) : runtime.context({ runId: parent.id, permissions: [] }) };
}
const unfence = (text: string): string => text.trim().replace(/^```[a-z]*\r?\n?|\r?\n?```$/g, "").trim();
/**
 * A drafted skill file is refused when any line reads like an order slipped in from outside, or
 * when the skill scan finds anything at all (a secret, sending data out, overriding the rules).
 * The owner's "review" skill policy is for skills a person chose; a skill the assistant wrote never
 * gets a finding waved through, so its drafts can only be as safe as the strictest policy.
 */
function refuseInjected(document: string): void {
  const warnings = detectInjection(document);
  if (warnings.length)
    throw new Error(`The draft was not kept: a line in it ${warnings[0]!.reason} ("${warnings[0]!.excerpt}").`);
  const findings = scanSkill(document);
  if (findings.length) throw new Error(`The draft was not kept: ${describeFindings(findings)}.`);
}

export const DraftFromNoteSchema = z.object({
  skillId: z.string().min(1).max(200),
  note: z.string().trim().min(1).max(4000),
  runId: z.string().max(200).default(""),
}).strict();
const reviseInstructions = "You revise one skill file so that it carries a note the owner agreed with. Change only what the note calls for and keep everything else, including the name line. Output only the whole file, starting with ---.";

/**
 * Writes a note the owner accepted into a new version of the skill. The version in use does not
 * change: the draft is recorded where `SkillRevisions` lists drafts, so it is tried and shown as a
 * diff before anything switches over.
 */
/** Seasons: which connection writes the draft; the overnight work passes the free one it chose. */
export interface DraftOptions { model?: string }
export async function draftFromNote(store: Store, owner: string, runtime: Runtime, input: unknown, options: DraftOptions = {}) {
  const spec = DraftFromNoteSchema.parse(input);
  const skill = store.skills.view(owner, spec.skillId);
  const { parent, context } = learningTask(store, owner, `Work a note into skill "${skill.name}"`, runtime);
  try {
    const child = await runtime.delegate(`The skill file now:\n${skill.document}\n\nThe note to work in:\n${spec.note}`,
      context, [], reviseInstructions, { timeoutMs: 120000, ...options });
    if (child.status !== "completed") throw new Error(`The draft could not be written (${child.status})`);
    const document = unfence(child.output);
    refuseInjected(document);
    if (parseSkillDocument(document).name !== skill.name) throw new Error("The draft renamed the skill, so it was not kept.");
    const updated = store.skills.update(owner, spec.skillId, { document, expectedRevision: skill.revision });
    store.save("settings", owner, `skill-candidate:${spec.skillId}:${updated.headVersion}`,
      { fromRunId: spec.runId, note: spec.note, draftRunId: child.id, createdAt: new Date().toISOString() });
    store.event(parent.id, "skill.candidate_drafted", { skillId: spec.skillId, version: updated.headVersion, fromNote: true, activeVersion: updated.activeVersion });
    store.finish(parent.id, "completed", `Drafted version ${updated.headVersion} of ${skill.name}`);
    return { skillId: spec.skillId, candidateVersion: updated.headVersion, activeVersion: updated.activeVersion };
  } catch (error) {
    store.finish(parent.id, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export const DraftNewSkillSchema = z.object({
  /** What happened, in words: a conversation's turns, a pattern of steps that kept working, or notes. */
  evidence: z.string().trim().min(1).max(12000),
  /** Anything the owner added when asking ("call it…", "leave out…"). */
  notes: z.string().trim().max(2000).default(""),
  fromRunId: z.string().max(200).default(""),
}).strict();
const newSkillInstructions = [
  "You decide whether what happened is worth keeping as a skill, and if it is, you write the skill file.",
  "A skill is a procedure: numbered steps concrete enough to follow, that will come up again, and that is not already covered by a skill listed.",
  "It is not a fact or a preference (those are notes), not a one-off fix tied to one error or one date, and not general knowledge any assistant has.",
  "When in doubt, answer with the single word NONE.",
  "Otherwise output only the file: a --- block with name (lowercase words joined by hyphens) and description (one sentence saying when to use it), then ---,",
  "then a title, a 'When to use' list, numbered 'Steps', 'Pitfalls', and an 'Examples' heading with one or two example requests as bullets.",
].join(" ");

/**
 * Drafts a brand-new skill and installs it switched off, so it can be tried before anyone uses it.
 * Answers `null` when the model judged there was nothing worth a skill.
 */
export async function draftNewSkill(store: Store, owner: string, runtime: Runtime, input: unknown, options: DraftOptions = {}) {
  const spec = DraftNewSkillSchema.parse(input);
  const existing = store.skills.list(owner).map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") || "(none)";
  const { parent, context } = learningTask(store, owner, "Draft a new skill from what happened", runtime);
  try {
    const child = await runtime.delegate(
      `Skills already installed:\n${existing}\n\nWhat happened:\n${spec.evidence}${spec.notes ? `\n\nThe owner adds: ${spec.notes}` : ""}`,
      context, [], newSkillInstructions, { timeoutMs: 120000, ...options });
    if (child.status !== "completed") throw new Error(`The draft could not be written (${child.status})`);
    const document = unfence(child.output);
    if (/^none\.?$/i.test(document)) { store.finish(parent.id, "completed", "Nothing worth a skill"); return null; }
    refuseInjected(document);
    const { name } = parseSkillDocument(document);
    if (store.skills.list(owner).some((skill) => skill.name === name)) throw new Error(`There is already a skill called ${name}, so the draft was not kept.`);
    // install() switches a clean skill on at once; it is switched off again in the same turn of
    // the event loop, so no task can pick it up before the owner has said yes.
    const installed = store.skills.install(owner, { document });
    const skill = installed.activeVersion === null ? installed : store.skills.disable(owner, installed.id, { expectedRevision: installed.revision });
    store.event(parent.id, "skill.new_drafted", { skillId: skill.id, name, fromRunId: spec.fromRunId });
    store.finish(parent.id, "completed", `Drafted a new skill, ${name}, switched off`);
    return { skillId: skill.id, name, description: skill.description, document, draftRunId: child.id };
  } catch (error) {
    store.finish(parent.id, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** finish-soon-a: the owner's own words for a new skill ("Write one with Branch"). */
export const WriteSkillSchema = z.object({ what: z.string().trim().min(1).max(2000) }).strict();
const writeSkillInstructions = [
  "You write one skill file from what the owner says the skill should know how to do.",
  "Output only the file: a --- block with name (lowercase words joined by hyphens) and description (one sentence saying when to use it), then ---,",
  "then a title, a 'When to use' list, numbered 'Steps' concrete enough to follow, 'Pitfalls', and an 'Examples' heading with one or two example requests as bullets.",
  "Use only what the owner said; where something is not said, write a step that asks the owner instead of guessing.",
].join(" ");

/**
 * Drafts a skill file from the owner's words and hands it back for review. Nothing is installed: the
 * owner reads it and adds it with POST /api/skills/install, which checks and scans it again.
 */
export async function writeSkill(store: Store, owner: string, runtime: Runtime, input: unknown) {
  const { what } = WriteSkillSchema.parse(input);
  const existing = store.skills.list(owner).map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") || "(none)";
  const { parent, context } = learningTask(store, owner, "Write a skill from the owner's words", runtime);
  try {
    const child = await runtime.delegate(`Skills already installed:\n${existing}\n\nThe owner's words:\n${what}`,
      context, [], writeSkillInstructions, { timeoutMs: 120000 });
    if (child.status !== "completed") throw new Error(child.output?.trim() || `The draft could not be written (${child.status})`);
    const document = unfence(child.output);
    refuseInjected(document);
    const { name, description } = parseSkillDocument(document);
    if (store.skills.list(owner).some((skill) => skill.name === name)) throw new Error(`There is already a skill called ${name}, so the draft was not kept.`);
    store.finish(parent.id, "completed", `Drafted a skill, ${name}, for review`);
    return { name, description, document };
  } catch (error) {
    store.finish(parent.id, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Tries a new skill against having no skill at all, on the task it came from and a few like it, as
 * a practice run where anything that would change something only says what it would have done.
 */
export async function trialNewSkill(store: Store, owner: string, runtime: Runtime, skillId: string, tasks: TrialTask[]): Promise<TrialReport> {
  if (!tasks.length) throw new Error("There is no past task to try this skill on yet.");
  const skill = store.skills.view(owner, skillId);
  const { parent, context } = learningTask(store, owner, `Try the new skill "${skill.name}" on ${tasks.length} task(s)`, runtime, true);
  const sides = { baseline: { finished: 0, ms: 0, tokens: 0, errors: 0 }, candidate: { finished: 0, ms: 0, tokens: 0, errors: 0 } };
  const instructions = { baseline: "No skill is being tried. Do the task as you normally would.", candidate: `The skill being tried:\n${skill.document}` };
  for (const task of tasks) for (const side of ["baseline", "candidate"] as const) {
    const started = Date.now();
    // A model wrote this skill from conversation turns, so it is tried without the tools that reach
    // outside, as testSkill does, even though a practice run only says what a change would do.
    const permissions = [...context.permissions].filter((p) => !["shell.execute", "remote.execute", "git.remote", "github.manage", "gitlab.manage"].includes(p));
    const run = await runtime.delegate(task.prompt, context, permissions, instructions[side], { timeoutMs: 120000 }).catch(() => null);
    const usage = run ? store.usage(run.id) as { estimatedInput?: number; estimatedOutput?: number } : {};
    // mac7/eval-honesty: a try that produced no result at all is counted apart from one that
    // finished badly, so an outage on one side cannot make the other look better.
    if (!run) sides[side].errors += 1;
    sides[side].finished += run?.status === "completed" ? 1 : 0;
    sides[side].ms += Date.now() - started;
    sides[side].tokens += (usage.estimatedInput ?? 0) + (usage.estimatedOutput ?? 0);
  }
  const report: TrialReport = { tasks: tasks.length, baseline: sides.baseline, candidate: sides.candidate,
    noWorse: sides.candidate.finished >= sides.baseline.finished,
    unreadable: trialRefusal(sides.baseline, sides.candidate), ranAt: new Date().toISOString(), parentRunId: parent.id };
  store.event(parent.id, "skill.new_tried", { skillId, ...report });
  store.finish(parent.id, "completed", `Tried ${skill.name}: ${sides.candidate.finished} of ${tasks.length} finished with it, ${sides.baseline.finished} without`);
  return report;
}
