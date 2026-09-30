import { createHash } from "node:crypto";
import { z } from "zod";
import { lockedDown } from "../lockdown.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { currentTaskRun } from "../task-scope.js";
import { HttpError } from "../server-http.js";
import { currentPerson, throughPairedDoor } from "../people/context.js";
import { specFor } from "./catalogue.js";
import { applyWithPins, changesFor, type Proposal } from "./changes.js";
import type { SettingsKitDeps } from "./api.js";

const requestSchema = z.string().trim().min(1).max(8000);
type Rule = { key: string; field: string; value: string | boolean; words: RegExp; why: string };
const rules: readonly Rule[] = [
  { key: "goal-undo", field: "snapshots", value: "when-needed", words: /\b(edit|fix|refactor|change|rewrite)\b.*\b(code|files?|project|repo)\b/i, why: "Your task changes files; recording the previous files helps you undo it." },
  { key: "run-recording", field: "mode", value: "when-needed", words: /\b(replay|record|reproduce|debug|trace)\b/i, why: "Your task asks to trace or reproduce work; recording keeps the steps for review." },
  { key: "prompt-library", field: "mode", value: "when-needed", words: /\b(reusable|template|saved prompt|repeatable)\b/i, why: "Your task asks for reusable instructions; saved prompts keep them available." },
  { key: "asks-project-board", field: "mode", value: "when-needed", words: /\b(project plan|milestones?|task board|kanban)\b/i, why: "Your task asks for planning; a project board helps organize the work." },
  { key: "flowboards-kanban", field: "mode", value: "when-needed", words: /\b(kanban|task board)\b/i, why: "Your task mentions a board; the shared board displays its stages." },
  { key: "event-loop-watch", field: "mode", value: "when-needed", words: /\b(slow|stuck|unresponsive|performance|latency)\b/i, why: "Your task concerns responsiveness; the event-loop watch records delays." },
  { key: "usage-report", field: "mode", value: "when-needed", words: /\b(usage|token usage|cost report|spending report)\b/i, why: "Your task asks about usage; usage reports show recorded consumption without raising budgets." },
  { key: "comfort-display", field: "timestamps", value: true, words: /\b(timeline|timestamps?|chronology|when.*happened)\b/i, why: "Your task asks when things happened; message timestamps show their times." },
];

export function taskSettingsPreview(deps: SettingsKitDeps, input: unknown) {
  authorize(deps);
  const { request } = z.object({ request: requestSchema }).strict().parse(input);
  const declined = /\b(?:do not|don't|never)\s+(?:enable|turn on|change settings)|\bwithout\s+(?:enabling|recording)\b/i.test(request);
  const relevant = declined ? [] : rules.filter((rule) => rule.words.test(request));
  const proposals: Proposal[] = relevant.filter((rule) => {
    const field = specFor(rule.key)?.fields.find((field) => field.field === rule.field);
    return field && field.guard !== "reach";
  }).map(({ key, field, value }) => ({ key, field, value }));
  const preview = changesFor(deps.store, deps.owner, proposals, deps.tools);
  const changes = preview.changes.filter((change) => !change.loosens && (change.from === "off" || change.from === false)).map((change) => ({ ...change,
    why: relevant.find((rule) => rule.key === change.key && rule.field === change.field)!.why }));
  const scope = "These are persistent app settings. They do not grant task permissions, raise spending limits or configure credentials.";
  const fingerprint = createHash("sha256").update(JSON.stringify({ request, changes, refused: preview.refused })).digest("hex");
  return { request, changes, refused: preview.refused, fingerprint, scope };
}

export function applyTaskSettings(deps: SettingsKitDeps, input: unknown) {
  authorize(deps);
  if (lockedDown(deps.store, deps.owner)) throw new HttpError(409, "Turn Lockdown off before changing task settings.");
  const body = z.object({ request: requestSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    accept: z.array(z.string().max(160)).max(20) }).strict().parse(input);
  const preview = taskSettingsPreview(deps, { request: body.request });
  if (preview.fingerprint !== body.fingerprint) throw new HttpError(409, "Settings changed since this preview. Review the suggestions again.");
  if (body.accept.some((id) => !preview.changes.some((change) => change.id === id))) throw new HttpError(400, "Select only settings in this task's preview.");
  return applyWithPins(deps.store, deps.owner, preview.changes, { accept: body.accept, confirmLoosening: false,
    why: "Owner-selected settings relevant to this task", writers: deps.writers,
    record: { writer: "owner-in-window", source: "card", detail: "Task settings suggestions" } });
}

function authorize(deps: SettingsKitDeps): void {
  deps.store.profiles.requireOwner("Suggested task settings");
  if (startedWithShortLivedKey() || currentTaskRun() || currentPerson() || throughPairedDoor())
    throw new HttpError(403, "Review task settings in the owner's local app window.");
}
