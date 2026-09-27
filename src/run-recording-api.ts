/**
 * The routes behind "Seeing what it did, step by step, afterwards" (public list, bucket 13).
 *
 *   GET  /api/recordings                      the switch, and recent tasks to pick from
 *   POST /api/recordings                      changes the switch or the picture setting
 *   GET  /api/runs/:id/recording              one task's recording, as JSON
 *   GET  /api/runs/:id/recording/page         the same as a page to save and play anywhere
 *   GET  /api/runs/:id/recording/path         the picture of the path it took, as SVG
 *   GET  /api/runs/:id/recording/flow         the workflow it would make; POST saves it
 *   GET  /api/runs/:id/monitor?after=N        boxes, exchanges and words used, since event N
 *   GET  /api/event-loop                      whether Branch is keeping up; POST changes its switch
 *
 * Every route answers only for the profile that is switched on, and a task that is not theirs is
 * "not found". Everything leaving passes through the runtime's secret remover.
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, resolve } from "node:path";
import { audit } from "./audit.js";
import { eventLoopSettings, eventLoopWatch, saveEventLoopSettings } from "./event-loop-watch.js";
import { preferences } from "./preferences.js";
import { recordingFlowDraft } from "./recording-to-flow.js";
import { runMonitor } from "./run-monitor.js";
import { pageWordKeys, pathPicture, recordingPage } from "./run-recording-page.js";
import {
  buildRecording, recordingSettings, requireRecordings, saveRecordingSettings, withPictures, type RunRecording,
} from "./run-recording.js";
import type { Store } from "./store.js";
import { LOOK_LANGUAGES } from "./terminal-theme.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48

export interface RecordingApp {
  store: Store;
  runtime: { owner: string; hideSecrets: <T>(value: T) => T; artifacts: { read(path: string): Promise<Buffer> } | null };
  workflows: { forOwner(owner: string): string; create(owner: string, input: unknown): { id: string; name: string } };
}
export interface RecordingApiOptions {
  readBody: () => Promise<unknown>;
  /** Reads a file from the app's public folder; tests hand in their own. */
  readPublic?: (name: string) => Promise<string>;
}

const runPath = /^\/api\/runs\/([a-f0-9-]{36})\/(recording|recording\/page|recording\/path|recording\/flow|monitor)$/;

export function handlesRecordingPath(path: string): boolean {
  return path === "/api/recordings" || path === "/api/event-loop" || runPath.test(path);
}

const defaultReadPublic = (name: string): Promise<string> => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}

/** Answers one request. Errors are answered here too, with the status they carry. */
export async function recordingApi(app: RecordingApp, request: IncomingMessage, response: ServerResponse, path: string, options: RecordingApiOptions): Promise<void> {
  try {
    const answer = await route(app, request, response, path, options);
    if (answer !== undefined) sendJson(response, 200, answer);
  } catch (error) {
    const status = Number((error as { status?: unknown }).status) || 400;
    if (!response.headersSent) sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function route(app: RecordingApp, request: IncomingMessage, response: ServerResponse, path: string, options: RecordingApiOptions): Promise<unknown> {
  const owner = app.store.profiles.scope();
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST") throw Object.assign(new Error("Use GET or POST"), { status: 405 });
  if (path === "/api/event-loop") return eventLoop(app, method, options, new URL(request.url ?? "/", "http://local").searchParams.has("read"));
  if (path === "/api/recordings") {
    if (method === "POST") {
      const input = await options.readBody();
      recordedWrite(app.store, owner, byCard("run-recording"), ["run-recording"], () => saveRecordingSettings(app.store, owner, input));
    }
    const settings = recordingSettings(app.store, owner);
    const tasks = settings.mode === "off" ? [] : app.store.runs(owner).slice(0, 30)
      .map((run) => ({ id: run.id, prompt: app.runtime.hideSecrets(run.prompt).slice(0, 160), status: run.status, createdAt: run.createdAt }));
    return { settings, tasks };
  }
  const [, runId, part] = runPath.exec(path)!;
  const run = app.store.run(runId!);
  if (!run || run.owner !== owner) throw Object.assign(new Error("There is no task of yours with that number"), { status: 404 });
  const settings = recordingSettings(app.store, owner);
  requireRecordings(settings.mode);
  const scrub = app.runtime.hideSecrets;
  if (part === "monitor") {
    const after = Number(new URL(request.url ?? "/", "http://local").searchParams.get("after") ?? 0);
    return runMonitor(app.store, run.id, { after: Number.isInteger(after) && after > 0 ? after : 0, scrub });
  }
  if (part === "recording/flow") return flow(app, method, run.id, options);
  const recording = shareable(buildRecording(app.store, run.id, { scrub }));
  if (part === "recording") return recording;
  if (part === "recording/path") return { runId: run.id, svg: pathPicture(recording) };
  await sendPage(app, response, run.id, options, pageLanguage(request));
  return undefined;
}

/** Picture frames name their file and nothing more; where it sits on this computer stays here. */
function shareable(recording: RunRecording): RunRecording {
  for (const frame of recording.frames) if (frame.kind === "picture") frame.ref = frame.picture?.name ?? "";
  return recording;
}

const pictureTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** The language the window asked the page to be written in; only a language file the app ships. */
const pageLanguages = new Set<string>(LOOK_LANGUAGES);
function pageLanguage(request: IncomingMessage): string {
  const asked = new URL(request.url ?? "/", "http://local").searchParams.get("lang") ?? "en";
  return pageLanguages.has(asked) ? asked : "en";
}

async function sendPage(app: RecordingApp, response: ServerResponse, runId: string, options: RecordingApiOptions, language: string): Promise<void> {
  const owner = app.store.profiles.scope();
  const settings = recordingSettings(app.store, owner);
  let recording = buildRecording(app.store, runId, { scrub: app.runtime.hideSecrets });
  const artifacts = app.runtime.artifacts;
  if (settings.pictures && artifacts)
    recording = await withPictures(recording, settings.keepPictures, async (path) => {
      const mediaType = pictureTypes[extname(path).toLowerCase()];
      // Only this task's own pictures, from the app's own picture folder (artifacts.read checks that).
      if (!mediaType || basename(dirname(resolve(path))) !== runId) return null;
      return { bytes: await artifacts.read(path), mediaType };
    });
  const readPublic = options.readPublic ?? defaultReadPublic;
  const words = await localeWords(readPublic, language);
  const html = recordingPage({
    recording: shareable(recording), tokensCss: await readPublic("tokens.css"),
    theme: preferences(app.store, owner).appearance, t: (key) => words[key] ?? key, language,
  });
  // A saved page leaves the app with what the task did in it, so it is written into the record (A1931).
  audit(app.store, owner, { action: "data.exported", actor: owner, runId, subject: "a recording of one task",
    reason: settings.pictures ? "Saved as a page, with its newest pictures" : "Saved as a page, without pictures", outcome: "saved" });
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="task-recording-${runId.slice(0, 8)}.html"`,
  });
  response.end(html);
}

/** The page's fixed words, in the window's language, with English behind any word not yet translated. */
async function localeWords(readPublic: (name: string) => Promise<string>, language: string): Promise<Record<string, string>> {
  const load = async (code: string) => JSON.parse(await readPublic(`locales/${code}.json`).catch(() => "{}")) as Record<string, unknown>;
  const english = await load("en");
  const chosen = language === "en" ? english : await load(language);
  const pick = (key: string) => [chosen[key], english[key]].find((word) => typeof word === "string") as string | undefined;
  return Object.fromEntries(pageWordKeys.map((key) => [key, pick(key) ?? key]));
}

async function flow(app: RecordingApp, method: string, runId: string, options: RecordingApiOptions): Promise<unknown> {
  const owner = app.workflows.forOwner(app.store.profiles.scope());
  if (method === "GET") return recordingFlowDraft(app.store, runId, "", app.runtime.hideSecrets);
  const body = (await options.readBody()) as { name?: unknown } | null;
  const draft = recordingFlowDraft(app.store, runId, typeof body?.name === "string" ? body.name : "", app.runtime.hideSecrets);
  const saved = app.workflows.create(owner, draft.definition);
  app.store.event(runId, "recording.saved_as_workflow", { workflowId: saved.id, steps: draft.definition.steps.length });
  return { workflow: { id: saved.id, name: saved.name }, steps: draft.definition.steps.length, leftOut: draft.leftOut };
}

/**
 * The switch and, when there is one to give, a reading. "On" always has one ready. "When needed"
 * measures only when the reading is asked for (`?read`), so opening Settings never costs a pause.
 */
async function eventLoop(app: RecordingApp, method: string, options: RecordingApiOptions, asked: boolean): Promise<unknown> {
  // The watch is one for the whole app, so its switch is the owner's alone: a household profile
  // cannot turn it off under the owner, and every profile reads the owner's setting.
  const owner = app.runtime.owner;
  if (method === "POST") {
    if (!app.store.profiles.isOwner())
      throw Object.assign(new Error("The check on whether Branch is keeping up belongs to the owner. Switch back to the owner's profile to change it."), { status: 400 });
    const input = await options.readBody();
    eventLoopWatch.follow(recordedWrite(app.store, owner, byCard("event-loop-watch"), ["event-loop-watch"],
      () => saveEventLoopSettings(app.store, owner, input)));
  }
  const settings = eventLoopSettings(app.store, owner);
  if (settings.mode === "off") {
    if (asked) await eventLoopWatch.reading(settings);
    return { settings, reading: null };
  }
  if (settings.mode === "when-needed" && !asked) return { settings, reading: null };
  return { settings, reading: await eventLoopWatch.reading(settings) };
}

/** Called once when the server starts: the watch runs from the start when the owner has it on. */
export function startEventLoopWatch(app: Pick<RecordingApp, "store" | "runtime">): void {
  try { eventLoopWatch.follow(eventLoopSettings(app.store, app.runtime.owner)); } catch { /* never worth failing a launch */ }
}
