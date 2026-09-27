/**
 * A recording of one task (public list, bucket 13): every step it took, in order, with how long
 * after the start each one happened, so the task can be played back afterwards like a video of what
 * it did — the question, each round with the model, each action and what came back, each step of a
 * flow, each helper it sent off, each picture it looked at, and how it ended.
 *
 * Nothing new is recorded to make this: the task's own event log already holds all of it. This file
 * only reads that log back as frames. Everything written out passes through `scrub` (the runtime's
 * secret remover) first, and pictures are left out unless the owner asked for them.
 *
 * It has the owner's three-way switch and ships off:
 * - off: no recording can be read, played or saved;
 * - when-needed: a recording is put together when the owner opens one, and at no other time;
 * - on: the same, and the recording screen also lists recent tasks by itself when it opens.
 */
import { basename } from "node:path";
import { z } from "zod";
import type { Event, Run } from "./contracts.js";
import { FeatureModeSchema, optionalFields, type FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";
import { markChosen, sentKeys, shippedUnlessChosen } from "./ship-on.js";

export const recordingFormat = "branch-agent-recording";
export const recordingVersion = 1;

export const RecordingSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  /** Put the pictures a task looked at into a saved recording. Off: a picture is only named. */
  pictures: z.boolean().default(false),
  /** Most pictures one saved recording carries, newest kept. */
  keepPictures: z.number().int().min(1).max(20).default(3),
}).strict();
export type RecordingSettings = z.infer<typeof RecordingSettingsSchema>;
const settingsKey = "run-recording";

// The owner's rule (ships on, 2026-09-26): plays a task back from the log Branch already keeps; nothing new is recorded; none of (a)–(f).
export const recordingShipsAs: FeatureMode = "when-needed";

export function recordingSettings(store: Pick<Store, "get">, owner: string): RecordingSettings {
  const saved = RecordingSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, settingsKey, saved.data, { mode: recordingShipsAs }) : RecordingSettingsSchema.parse({});
}

export function saveRecordingSettings(store: Store, owner: string, input: unknown): RecordingSettings {
  const change = optionalFields(RecordingSettingsSchema).parse(input);
  const next = RecordingSettingsSchema.parse({ ...recordingSettings(store, owner), ...change });
  store.save("settings", owner, settingsKey, next);
  markChosen(store, owner, settingsKey, sentKeys(change));
  return next;
}

/** The sentence an owner reads when the switch is off. */
export const recordingOffWords = "Recordings of tasks are switched off. Turn them on under Inbox, History.";
export function requireRecordings(mode: FeatureMode): void {
  if (mode === "off") throw Object.assign(new Error(recordingOffWords), { status: 403 });
}

export type FrameKind = "asked" | "model" | "tool" | "step" | "helper" | "picture" | "note" | "ended";
export type FrameStatus = "working" | "done" | "failed" | "stopped" | "waiting" | "info";
export interface RecordingFrame {
  /** Milliseconds after the task started. */
  at: number;
  kind: FrameKind;
  status: FrameStatus;
  /** What happened, in a few plain words. */
  label: string;
  /** What came back, or why it failed, cut short. */
  detail: string;
  /** The call, flow step or helper task this frame is about, so a later frame can finish it. */
  ref: string;
  /** How long the step took, once it has finished. */
  seconds: number | null;
  tokens?: { input: number; output: number };
  /** The picture's file name; `data` only when the owner asked for pictures in recordings. */
  picture?: { name: string; data?: string; mediaType?: string };
  /** The fixed part of `label` as a key in public/locales, so the player can say it in the owner's language. */
  words?: { key: string; values?: Record<string, string> };
}
export interface RunRecording {
  format: typeof recordingFormat;
  formatVersion: typeof recordingVersion;
  runId: string;
  prompt: string;
  status: Run["status"];
  startedAt: string;
  seconds: number;
  frames: RecordingFrame[];
  counts: { rounds: number; actions: number; failed: number; steps: number; helpers: number; pictures: number };
  /** True when the task had more steps than a recording keeps. */
  truncated: boolean;
}

export interface RecordingOptions {
  scrub?: <T>(value: T) => T;
  maxFrames?: number;
  clip?: number;
}

const clipText = (value: unknown, limit: number): string => {
  const text = (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value))
    .replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)} … (${text.length - limit} more characters)`;
};
const time = (iso: string): number => new Date(iso).getTime();

/** Reads one task's event log back as frames. Throws when there is no such task. */
export function buildRecording(store: Store, runId: string, options: RecordingOptions = {}): RunRecording {
  const run = store.run(runId);
  if (!run) throw Object.assign(new Error("There is no task with that number"), { status: 404 });
  const scrub = options.scrub ?? (<T>(value: T) => value);
  const limit = options.maxFrames ?? 400;
  const reader = new FrameReader(time(run.createdAt), options.clip ?? 240);
  reader.push({ at: 0, kind: "asked", status: "info", label: "Asked", detail: clipText(scrub(run.prompt), 600), ref: "", seconds: null, words: { key: "recording.frame.asked" } });
  for (const event of store.events(runId)) reader.read(event, scrub);
  const frames = reader.frames;
  const truncated = frames.length > limit;
  const kept = truncated ? [...frames.slice(0, limit - 1), frames.at(-1)!] : frames;
  return {
    format: recordingFormat, formatVersion: recordingVersion,
    runId: run.id, prompt: scrub(run.prompt), status: run.status, startedAt: run.createdAt,
    seconds: Math.max(0, Math.round((time(run.updatedAt) - time(run.createdAt)) / 100) / 10),
    frames: kept, counts: countFrames(frames), truncated,
  };
}

function countFrames(frames: readonly RecordingFrame[]): RunRecording["counts"] {
  const of = (kind: FrameKind) => frames.filter((frame) => frame.kind === kind).length;
  return {
    rounds: of("model"), actions: of("tool"), steps: of("step"), helpers: of("helper"), pictures: of("picture"),
    failed: frames.filter((frame) => frame.status === "failed").length,
  };
}

const toolEnd: Record<string, FrameStatus> = { "tool.completed": "done", "tool.failed": "failed", "tool.stalled": "stopped" };
const stepEnd: Record<string, FrameStatus> = {
  "flow.node.finished": "done", "flow.node.failed": "failed", "flow.node.waiting": "waiting", "flow.node.interrupted": "stopped",
};
const modelEnd: Record<string, FrameStatus> = {
  "model.completed": "done", "model.failed": "failed", "model.stalled": "stopped", "model.cancelled": "stopped",
};
/** How a task's own ending (`run.finished`, by its status) is shown. */
const ended: Record<string, FrameStatus> = {
  completed: "done", failed: "failed", cancelled: "stopped", interrupted: "stopped", needs_input: "waiting",
};

const stepWords = (name: string): RecordingFrame["words"] => ({ key: "recording.frame.step", values: { name } });

/** Turns events into frames, pairing each start with its finish so a frame knows how long it took. */
class FrameReader {
  readonly frames: RecordingFrame[] = [];
  private readonly open = new Map<string, RecordingFrame>();
  private modelStarted: number | null = null;
  private scrub: <T>(value: T) => T = (value) => value;
  constructor(private readonly start: number, private readonly clip: number) {}

  push(frame: RecordingFrame): void { this.frames.push(frame); }

  read(event: Event, scrub: <T>(value: T) => T): void {
    const at = Math.max(0, time(event.createdAt) - this.start);
    const data = event.data as Record<string, unknown>;
    this.scrub = scrub;
    if (event.kind === "tool.started") return this.begin(`tool:${String(data.id ?? event.id)}`, at, "tool", String(data.label ?? data.name ?? "An action"));
    if (toolEnd[event.kind]) return this.finish(`tool:${String(data.id ?? event.id)}`, at, toolEnd[event.kind]!, scrub(data.result ?? data.error), "tool", String(data.name ?? "An action"));
    const step = String(data.name ?? data.node);
    if (event.kind === "flow.node.started") return this.begin(`step:${String(data.node)}:${String(data.seq)}`, at, "step", `Step: ${step}`, stepWords(this.said(step)));
    if (stepEnd[event.kind]) return this.finish(`step:${String(data.node)}:${String(data.seq)}`, at, stepEnd[event.kind]!, scrub(data.output ?? data.error), "step", `Step: ${step}`, stepWords(this.said(step)));
    if (event.kind === "model.started") { this.modelStarted = at; return; }
    if (modelEnd[event.kind]) return this.round(event.kind, at, data, scrub);
    this.other(event, at, data, scrub);
  }

  /** Words that came from the task (an action's settings, a box's name) never leave with a secret in them. */
  private said(text: string): string { return clipText(this.scrub(text), 120); }

  private begin(ref: string, at: number, kind: FrameKind, label: string, words?: RecordingFrame["words"]): void {
    const frame: RecordingFrame = { at, kind, status: "working", label: this.said(label), detail: "", ref, seconds: null, ...(words ? { words } : {}) };
    this.open.set(ref, frame);
    this.push(frame);
  }

  private finish(ref: string, at: number, status: FrameStatus, detail: unknown, kind: FrameKind, label: string, words?: RecordingFrame["words"]): void {
    const frame = this.open.get(ref);
    this.open.delete(ref);
    if (!frame) return this.push({ at, kind, status, label: this.said(label), detail: clipText(detail, this.clip), ref, seconds: null, ...(words ? { words } : {}) });
    frame.status = status;
    frame.detail = clipText(detail, this.clip);
    frame.seconds = Math.round((at - frame.at) / 100) / 10;
  }

  private round(kind: string, at: number, data: Record<string, unknown>, scrub: <T>(value: T) => T): void {
    const began = this.modelStarted ?? at;
    this.modelStarted = null;
    const reported = (data.reported ?? null) as { input?: number; output?: number } | null;
    const tokens = { input: Number(reported?.input ?? data.estimatedInput ?? 0) || 0, output: Number(reported?.output ?? data.estimatedOutput ?? 0) || 0 };
    const model = this.said(String(data.model ?? "the model"));
    const calls = Number(data.toolCalls ?? 0);
    const detail = kind === "model.completed"
      ? (data.cached ? "Answered from a kept answer; nothing was sent." : calls ? `Asked for ${calls} action${calls === 1 ? "" : "s"}.` : "Wrote the answer.")
      : clipText(scrub(data.error ?? kind), this.clip);
    this.push({ at: began, kind: "model", status: modelEnd[kind]!, label: `Thought with ${model}`, detail, ref: "", seconds: Math.round((at - began) / 100) / 10, tokens,
      words: { key: "recording.frame.model", values: { model } } });
  }

  private other(event: Event, at: number, data: Record<string, unknown>, scrub: <T>(value: T) => T): void {
    const note = (label: string, key: string, detail: unknown = "", status: FrameStatus = "info") =>
      this.push({ at, kind: "note", status, label, detail: clipText(scrub(detail), this.clip), ref: "", seconds: null, words: { key: `recording.frame.${key}` } });
    if (event.kind === "image.attached") {
      const path = String(data.path ?? "");
      this.push({ at, kind: "picture", status: "info", label: "Looked at a picture", detail: "", ref: path, seconds: null, picture: { name: basename(path) }, words: { key: "recording.frame.picture" } });
    } else if (event.kind === "delegation.background_started") {
      this.push({ at, kind: "helper", status: "working", label: "Sent a helper off", detail: clipText(scrub(data.prompt), this.clip), ref: String(data.childRunId ?? ""), seconds: null, words: { key: "recording.frame.helper" } });
    } else if (event.kind === "delegation.fanout") note("Sent several helpers at once", "helpers", Object.keys((data.tasks ?? {}) as object).join(", "));
    else if (event.kind === "plan.created") note("Wrote a plan", "plan", (data.steps as unknown[] | undefined)?.join("; "));
    else if (event.kind === "run.steered" || event.kind === "run.steer_applied") note("You steered it", "steered", data.text ?? data.note);
    else if (event.kind === "verify.verdict") note("Checked its own work", "checked", `${String(data.verdict ?? "")} ${String(data.reason ?? "")}`);
    else if (event.kind === "attention.needed") note("Stopped to ask you", "asked-you", data.question, "waiting");
    else if (event.kind === "run.finished") {
      const status = ended[String(data.status)] ?? "info";
      const waiting = status === "waiting";
      this.push({ at, kind: "ended", status, label: waiting ? "Stopped to wait for you" : "Finished", detail: clipText(scrub(data.output ?? ""), this.clip),
        ref: "", seconds: null, words: { key: waiting ? "recording.frame.waiting" : "recording.frame.finished" } });
    }
  }
}

/**
 * Puts the newest pictures' bytes into a recording the owner is saving, when they asked for that.
 * Older pictures stay named only, so a long task's file does not grow without end.
 */
export async function withPictures(
  recording: RunRecording, keep: number, read: (path: string) => Promise<{ bytes: Buffer; mediaType: string } | null>,
): Promise<RunRecording> {
  const pictures = recording.frames.filter((frame) => frame.kind === "picture").slice(-keep);
  for (const frame of pictures) {
    const found = await read(frame.ref).catch(() => null);
    if (found && frame.picture) {
      frame.picture.data = found.bytes.toString("base64");
      frame.picture.mediaType = found.mediaType;
    }
  }
  return recording;
}

/** Whether a document is a recording of a shape this version understands. */
export function isRecording(value: unknown): value is RunRecording {
  const document = value as Partial<RunRecording> | null;
  return document?.format === recordingFormat && document.formatVersion === recordingVersion && Array.isArray(document.frames);
}
