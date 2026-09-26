import { extname, basename, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { ImagePart } from "./contracts.js";
import { parseImages } from "./contracts.js";
import { conversationMarkdown } from "./memory-export.js";
import { estimateCost, formatCost, pricingSettings } from "./pricing.js";
import { nextPolicy, policyPresets, readPolicy, savePolicy, type PolicyPresetName } from "./policy.js";
import { recordedWrite } from "./settings-kit/recorded-write.js";
import { policyChangeRefusal } from "./policy-change-guard.js"; // Q257, Q258
import type { Runtime } from "./runtime.js";

/**
 * The parts of the terminal view that are worth keeping away from the drawing code: the status
 * line's figures, attaching a file to the next message, the approval presets, and writing a
 * conversation out. Each one is a plain function over the runtime, so it can be tested on its own.
 */
export interface SessionTotals {
  input: number;
  output: number;
  cost: string;
}
const short = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));

/** Tokens used and money spent so far in one conversation, across every task in it. */
export function sessionTotals(runtime: Runtime, sessionId: string | undefined, model: string): SessionTotals {
  let input = 0, output = 0;
  for (const run of sessionId ? runtime.store.runs(runtime.owner).filter((r) => r.sessionId === sessionId) : []) {
    const usage = runtime.store.usage(run.id);
    input += usage.reportedInput || usage.estimatedInput || 0;
    output += usage.reportedOutput || usage.estimatedOutput || 0;
  }
  const { overrides } = pricingSettings(runtime.store, runtime.owner);
  return { input, output, cost: formatCost(estimateCost(model, { input, output }, overrides)) };
}

/**
 * What one answer used and cost on its own. The status line has always carried the running totals
 * for the whole conversation; this is the same reckoning for the task that has just finished, so
 * the terminal says what each answer cost as well as what the conversation has cost so far.
 */
export function runTotals(runtime: Runtime, runId: string, model: string): SessionTotals {
  const usage = runtime.store.usage(runId);
  const input = usage.reportedInput || usage.estimatedInput || 0;
  const output = usage.reportedOutput || usage.estimatedOutput || 0;
  const { overrides } = pricingSettings(runtime.store, runtime.owner);
  return { input, output, cost: formatCost(estimateCost(model, { input, output }, overrides)) };
}
/** The one line printed under an answer; empty when nothing was counted, so nothing is said. */
export function answerLine(totals: SessionTotals): string {
  if (!totals.input && !totals.output) return "";
  return `[this answer: ${short(totals.input)} in / ${short(totals.output)} out · ${totals.cost}]`;
}
/** The model behind a named preset, which is what the prices are looked up under. */
export function activeModel(runtime: Runtime, presetId: string | undefined): string {
  const summary = runtime.models.summary(runtime.owner);
  const active = presetId ?? summary.activePreset ?? summary.defaultPreset;
  return runtime.models.presets.get(active)?.model ?? active;
}

/** The one line that always sits above what the person is typing. */
export function statusLine(runtime: Runtime, sessionId: string | undefined, presetId: string | undefined, width: number): string {
  const summary = runtime.models.summary(runtime.owner);
  const active = presetId ?? summary.activePreset ?? summary.defaultPreset;
  const preset = runtime.models.find(active);
  const totals = sessionTotals(runtime, sessionId, preset?.model ?? active);
  const policy = readPolicy(runtime.store, runtime.owner);
  const label = policyPresets().find((entry) => entry.id === policy.preset)?.label ?? "Rules I set myself";
  const line = `${preset?.name ?? active} · ${short(totals.input)} in / ${short(totals.output)} out · ${totals.cost} · ${label}`;
  return line.length > width ? line.slice(0, Math.max(10, width - 1)) + "…" : line;
}

/** Every approval preset, one line each, with a mark against the one in force. */
export function presetLines(runtime: Runtime): string[] {
  const current = readPolicy(runtime.store, runtime.owner).preset;
  return policyPresets().map((preset) => `${preset.id === current ? "*" : " "} ${preset.id} — ${preset.label}: ${preset.description}`);
}

/**
 * Changes which approval preset is in force, exactly as the app's settings screen does: `<name>`, or `<name> confirm`
 * for a preset that makes Branch less careful.
 */
export function choosePreset(runtime: Runtime, argument: string,
  // Q259: how the yes is typed where the command was: `/preset <name> confirm`, or `branch permissions <name> confirm`.
  howToConfirm = (name: string): string => `Send /preset ${name} confirm to go ahead.`): string {
  const known = policyPresets().map((preset) => preset.id);
  const [name = "", word, ...rest] = argument.trim().split(/\s+/);
  if (!known.includes(name as PolicyPresetName) || (word !== undefined && word !== "confirm") || rest.length)
    throw new Error(`Pick one of: ${known.join(", ")}`);
  // Q257: under Lockdown the saved rules are Lockdown's own and it puts the owner's back when it ends, so a preset
  // chosen now would loosen Lockdown or be lost. Q258: a preset that makes Branch less careful needs the owner's
  // separate yes, as POST /api/policy does: the command says what would loosen, and `confirm` after the name goes
  // ahead. Both are weighed on exactly the policy it would save (src/policy-change-guard.ts).
  const after = nextPolicy(readPolicy(runtime.store, runtime.owner), { preset: name });
  const refusal = policyChangeRefusal(runtime.store, runtime.owner, after, word === "confirm", runtime.registry, howToConfirm(name));
  if (refusal) throw new Error(refusal);
  const saved = recordedWrite(runtime.store, runtime.owner, { writer: "owner-by-command", source: "command", detail: `/preset ${name}` }, ["policy"],
    () => savePolicy(runtime.store, runtime.owner, { preset: name }));
  const label = policyPresets().find((preset) => preset.id === saved.preset)?.label ?? saved.preset;
  return `[when to check with me: ${label}]`;
}

export interface Attachment {
  name: string;
  /** A picture the model can look at, when the file is one. */
  image?: ImagePart;
  /** The words of a text file, added to the message instead. */
  text?: string;
}
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const maxAttachedText = 20000;

/** Reads a file to send with the next message: a picture as a picture, anything else as words. */
export async function readAttachment(path: string): Promise<Attachment> {
  const full = resolve(path), name = basename(full), mediaType = imageTypes[extname(full).toLowerCase()];
  if (mediaType) {
    const [image] = parseImages([{ mediaType, data: (await readFile(full)).toString("base64"), name }]);
    return { name, image: image! };
  }
  const text = await readFile(full, "utf8");
  if (text.length > maxAttachedText) throw new Error(`${name} is too long to attach; paste the part that matters instead`);
  return { name, text };
}

/** What the attached files add to the message the person typed. */
export function attachedText(attachments: Attachment[]): string {
  const files = attachments.filter((attachment) => attachment.text !== undefined);
  if (!files.length) return "";
  return "\n\n" + files.map((file) => `--- attached file: ${file.name} ---\n${file.text}`).join("\n\n");
}

/** The turns of this conversation so far, shortest useful form, newest last. */
export function historyLines(runtime: Runtime, sessionId: string | undefined, limit = 20): string[] {
  if (!sessionId) return ["Nothing yet in this conversation."];
  const turns = runtime.store.messages(sessionId).filter((message) => message.role === "user" || message.role === "assistant");
  if (!turns.length) return ["Nothing yet in this conversation."];
  return turns.slice(-limit).map((turn) => {
    const text = turn.content.replace(/\s+/g, " ").trim();
    return `${turn.role === "user" ? "you" : "assistant"}: ${text.length > 160 ? text.slice(0, 159) + "…" : text}`;
  });
}

/** Writes the conversation out as Markdown and answers with the file it wrote. */
export async function exportConversation(runtime: Runtime, sessionId: string | undefined, target?: string): Promise<string> {
  if (!sessionId) throw new Error("There is nothing to save yet; send a message first");
  const messages = runtime.store.messages(sessionId);
  const path = resolve(target ?? resolve(runtime.workspace, `conversation-${sessionId.slice(0, 8)}.md`));
  await writeFile(path, conversationMarkdown({ sessionId }, messages), { mode: 0o600 });
  return path;
}
