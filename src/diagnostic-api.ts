import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  activeDiagnosticLog, DiagnosticLog, diagnose, diagnosticLogSettings, logLevels, redactForLog, saveDiagnosticLogSettings, setDiagnosticLog,
  watchProcessCrashes, withoutQuotedText, componentOf, writeLogSettingsMark, type Level, type LogFilter,
} from "./diagnostic-log.js";
import { dnsResolve, gatherReport, issueUrl, keptItems, reportZip, type ReportItem, type ReportSources } from "./diagnostic-report.js";
import { redactEvent, redactSpan } from "./diagnostics.js";
import {
  AutomaticProblemOutbox, AutomaticProblemReportSettingsSchema, AutomaticProblemReports,
  automaticProblemReportSettings, problemReportPreview, saveAutomaticProblemReportSettings,
  type AutomaticProblemReportSettings,
} from "./automatic-problem-reports.js";
import { audit } from "./audit.js";
import { levelFor } from "./log-bridge.js";
import { lockdownActive } from "./lockdown.js";
import { optionalFields } from "./feature-switches.js"; // Q65
import { healthReport } from "./health.js";
import { localRuntimes } from "./local-runtimes.js";
import type { createBranch } from "./index.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;

/**
 * mac7/diagnostics: the `/api/diagnostics/...` routes other than the older diagnostics folder.
 * Everything is the owner's own: a short-lived key or a household profile is refused before this
 * runs (src/server.ts, offLimitsToShortLivedKeys), and each route asks `requireOwner` again here.
 * Lockdown does not stop the owner reading their own log or making a report; it only stops the
 * report looking anything up outside this computer.
 */
export const handlesDiagnosticPath = (path: string): boolean =>
  path.startsWith("/api/diagnostics/") && path !== "/api/diagnostics/bundle";

export interface DiagnosticContext { app: Branch; dataDir: string; installType: string; startedAt: number }

/** Sets up the one log for this engine: the folder, the owner's mode, the task events and crashes. */
export function startDiagnosticLog(
  app: Branch,
  dataDir: string,
  installType = "package",
  startedAt = Date.now(),
): () => void {
  // The owner's own saved keys and passwords are hidden too, whatever shape they have.
  const clean = (text: string): string => app.runtime.hideSecrets(redactForLog(text));
  let reporter: AutomaticProblemReports | null = null;
  let stopped = false;
  const outbox = new AutomaticProblemOutbox(
    join(dataDir, "logs"), () => automaticProblemReportSettings(app.store, app.runtime.owner),
  );
  const log = new DiagnosticLog({
    dir: join(dataDir, "logs"),
    settings: () => diagnosticLogSettings(app.store, app.runtime.owner),
    clean,
    onLine: (line) => {
      if (stopped || !reporter) return;
      if (outbox.capture(line)) void outbox.flush(reporter).catch(() => undefined);
    },
  });
  reporter = automaticProblemReporter({ app, dataDir, installType, startedAt }, log);
  void outbox.flush(reporter).catch(() => undefined);
  setDiagnosticLog(log);
  // mac7/coding-next: the desktop app reads the crash-capture switch from this file at its next start, and its main
  // process the log settings each time it writes a line (src/desktop/main-log.ts).
  writeLogSettingsMark(dataDir, diagnosticLogSettings(app.store, app.runtime.owner));
  log.prune();
  const stopCrashes = watchProcessCrashes(log, "engine");
  // Every stored task event, reduced to its shape exactly as the diagnostics folder does it.
  const stopEvents = app.store.onEvent((runId, kind, data) => {
    const level = levelFor(kind);
    if (level === "debug") return;
    const shaped = redactEvent({ id: 0, runId, kind, data, createdAt: "" }).data as Record<string, unknown>;
    log.write({ level, component: componentOf(kind), message: kind, taskId: runId, fields: shaped });
  });
  const prune = setInterval(() => log.prune(), 6 * 3_600_000);
  prune.unref();
  diagnose("engine", "info", "Branch started", { fields: { version: app.version } });
  return () => { stopped = true; clearInterval(prune); stopEvents(); stopCrashes(); setDiagnosticLog(null); };
}

function automaticProblemReporter(ctx: DiagnosticContext, log: DiagnosticLog): AutomaticProblemReports {
  const { app } = ctx;
  const owner = app.runtime.owner;
  return new AutomaticProblemReports({
    settings: () => automaticProblemReportSettings(app.store, owner),
    linkedChannels: () => app.channels.summary().chats.map(({ channel, chatId }) => ({ channel, chatId })),
    gather: (items) => gatherReport(reportSources(ctx, log), items),
    requireDelivery: (settings) => {
      app.store.profiles.requireOwner("Automatic problem reports");
      if (app.store.profiles.scope() !== owner) throw new Error("The owner profile changed before the report could be sent.");
      if (app.sessionLock.locked()) throw new Error("Unlock Branch before automatic problem reports can be sent.");
      if (lockdownActive(app.store, owner)) throw new Error("Lockdown is on, so automatic problem reports cannot be sent.");
      requireLinkedDestination(app, settings);
    },
    deliverChannel: (channel, chatId, text, key) => app.channels.deliver(channel, chatId, text, key),
    createGitHubIssue: async (repository, title, body) => {
      await app.runtime.executeTool(
        "github.create_issue",
        { repo: repository, title, body },
        { mode: "owner", source: "trigger", approvalKey: "automatic-problem-reports" },
      );
    },
    record: (entry) => audit(app.store, owner, {
      action: "data.exported",
      actor: "automatic problem reports",
      subject: entry.destination,
      reason: `${entry.kind}: ${entry.items.join(", ")}${entry.reason ? `; ${entry.reason}` : ""}`,
      source: "system",
      origin: "system",
      outcome: entry.outcome,
    }),
  });
}

/**
 * The items the owner previewed come back with the request, so what is saved or described is
 * exactly what they read, less what they removed. They are cleaned once more on the way in.
 */
const ItemSchema = z.object({ id: z.string().max(40), title: z.string().max(200), why: z.string().max(400), text: z.string().max(4_000_000) }).strict();
const RemoveSchema = z.object({
  removed: z.array(z.string().max(40)).max(40).default([]), summary: z.string().max(500).default(""),
  items: z.array(ItemSchema).max(40).optional(),
}).strict();
async function chosenItems(ctx: DiagnosticContext, log: DiagnosticLog, input: z.infer<typeof RemoveSchema>): Promise<ReportItem[]> {
  const items = input.items?.map((item) => ({ ...item, text: redactForLog(item.text) })) ?? await gatherReport(reportSources(ctx, log));
  return keptItems(items, input.removed);
}
const WindowErrorSchema = z.object({
  message: z.string().max(2000), stack: z.string().max(8000).default(""), where: z.string().max(200).default(""),
  kind: z.enum(["error", "unhandledrejection"]).default("error"),
}).strict();
const AutomaticPreviewSchema = z.object({
  settings: AutomaticProblemReportSettingsSchema,
  kind: z.enum(["crash", "update"]),
  summary: z.string().max(500).default(""),
}).strict();

export async function diagnosticApi(ctx: DiagnosticContext, method: string, path: string, url: URL, body: () => Promise<unknown>): Promise<unknown> {
  const { app } = ctx;
  app.store.profiles.requireOwner("The activity log and problem reports");
  const log = activeDiagnosticLog() ?? currentLog(ctx);
  if (path === "/api/diagnostics/log/settings") {
    if (method !== "POST") return diagnosticLogSettings(app.store, app.runtime.owner);
    const saved = saveDiagnosticLogSettings(app.store, app.runtime.owner, await body());
    writeLogSettingsMark(ctx.dataDir, saved); // mac7/coding-next; and the main process reads the log settings from it
    return saved;
  }
  // Reading your own log is never blocked by Lockdown: it reaches nothing outside this computer.
  if (method === "GET" && path === "/api/diagnostics/log") return readLog(ctx, log, url);
  if (method === "POST" && path === "/api/diagnostics/log/clear") { log.clear(); return { cleared: true }; }
  if (method === "POST" && path === "/api/diagnostics/window-error") {
    // A script error in the window is not a crash: it is a log line, so with the log off nothing
    // reaches the disk (it is still kept in memory, for the note of a real crash that follows).
    const report = WindowErrorSchema.parse(await body());
    log.write({ level: "error", component: "window", message: withoutQuotedText(report.message),
      fields: { kind: report.kind, where: report.where, stack: withoutQuotedText(report.stack).slice(0, 4000) } });
    return { recorded: diagnosticLogSettings(app.store, app.runtime.owner).mode !== "off" };
  }
  if (method === "POST" && path === "/api/diagnostics/report") return { items: await gatherReport(reportSources(ctx, log)) };
  if (method === "POST" && path === "/api/diagnostics/report/automatic/preview") {
    const input = AutomaticPreviewSchema.parse(await body());
    if (input.settings.mode === "on") requireLinkedDestination(app, input.settings);
    return problemReportPreview(input.settings, input.kind, input.summary,
      await gatherReport(reportSources(ctx, log), input.settings.items));
  }
  if (path === "/api/diagnostics/report/automatic") return automaticReportSettingsApi(ctx, method, body);
  if (method === "POST" && path === "/api/diagnostics/report/save") return saveReport(ctx, log, await body());
  if (method === "POST" && path === "/api/diagnostics/report/issue") {
    const input = RemoveSchema.parse(await body());
    return { url: issueUrl(await chosenItems(ctx, log, input), input.summary) };
  }
  throw new Error("That is not something Branch can do with the activity log");
}

async function automaticReportSettingsApi(ctx: DiagnosticContext, method: string, body: () => Promise<unknown>): Promise<unknown> {
  const { app } = ctx, owner = app.runtime.owner;
  if (method === "GET") return { settings: automaticProblemReportSettings(app.store, owner), destinations: automaticDestinations(app) };
  if (method !== "POST") throw new Error("That is not something Branch can do with automatic problem reports");
  const raw = await body();
  const changed = optionalFields(AutomaticProblemReportSettingsSchema).parse(raw ?? {}); // Q65: only what was sent
  const candidate = AutomaticProblemReportSettingsSchema.parse({ ...automaticProblemReportSettings(app.store, owner), ...changed });
  requireLinkedDestination(app, candidate);
  return { settings: saveAutomaticProblemReportSettings(app.store, owner, raw), destinations: automaticDestinations(app) };
}

function automaticDestinations(app: Branch): { channels: { channel: string; chatId: string; title: string }[]; github: boolean } {
  const channels = app.channels.summary().chats.map((chat) => ({
    channel: chat.channel, chatId: chat.chatId, title: chat.title,
  }));
  return { channels, github: app.registry.names().includes("github.create_issue") };
}

function requireLinkedDestination(app: Branch, settings: AutomaticProblemReportSettings): void {
  if (settings.mode !== "on") return;
  const destination = settings.destination;
  if (!destination) throw new Error("Choose an owner destination before automatic problem reports are switched on.");
  if (destination.kind === "github" && !app.registry.names().includes("github.create_issue"))
    throw new Error("GitHub is no longer linked, so it cannot receive automatic problem reports.");
  if (destination.kind === "channel" && !app.channels.summary().chats.some((chat) =>
    chat.channel === destination.channel && chat.chatId === destination.chatId))
    throw new Error("That owner chat is no longer linked, so it cannot receive automatic problem reports.");
}

function currentLog(ctx: DiagnosticContext): DiagnosticLog {
  return new DiagnosticLog({ dir: join(ctx.dataDir, "logs"), settings: () => diagnosticLogSettings(ctx.app.store, ctx.app.runtime.owner) });
}

function readLog(ctx: DiagnosticContext, log: DiagnosticLog, url: URL): unknown {
  const level = url.searchParams.get("level");
  const filter: LogFilter = {
    ...(url.searchParams.get("component") ? { component: url.searchParams.get("component")! } : {}),
    ...(level && (logLevels as readonly string[]).includes(level) ? { level: level as Level } : {}),
    ...(url.searchParams.get("task") ? { task: url.searchParams.get("task")! } : {}),
    limit: Number(url.searchParams.get("limit") ?? 300) || 300,
  };
  const lines = log.read(filter);
  const components = [...new Set(log.read({ limit: 2000 }).map((line) => line.component))].sort();
  return { settings: diagnosticLogSettings(ctx.app.store, ctx.app.runtime.owner), lines, components, crashes: log.crashes(5).length };
}

async function saveReport(ctx: DiagnosticContext, log: DiagnosticLog, input: unknown): Promise<unknown> {
  const items = await chosenItems(ctx, log, RemoveSchema.parse(input));
  const zip = reportZip(items);
  const folder = join(ctx.dataDir, "diagnostics");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const name = `branch-report-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  await writeFile(join(folder, name), zip, { mode: 0o600 });
  return { name, path: redactForLog(join(folder, name)), items: items.map((item) => item.id), base64: zip.toString("base64") };
}

/** Where every item's facts come from, for this running engine. */
export function reportSources(ctx: DiagnosticContext, log: DiagnosticLog | null): ReportSources {
  const { app } = ctx;
  const owner = app.runtime.owner;
  return {
    version: app.version, dataDir: ctx.dataDir, installType: ctx.installType, log,
    logMode: diagnosticLogSettings(app.store, owner).mode,
    health: () => healthReport(app),
    settings: () => settingsSummary(app),
    services: async () => ({
      engine: { pid: process.pid, uptimeMinutes: Math.round((Date.now() - ctx.startedAt) / 60000), memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
      channels: app.channels.summary().channels.map((channel) => ({ kind: channel.kind, health: channel.health })),
      mcpServers: app.mcpConnections.health().map((server) => ({ id: server.id, state: server.state, lastError: server.lastError })),
      localModels: await localRuntimes().health(),
    }),
    events: () => ({
      events: app.store.recentEvents(owner, 150).map(redactEvent),
      spans: app.store.spans.recent(owner, 100).map(redactSpan),
    }),
    crashDumpsDir: process.env.BRANCH_CRASH_DUMPS ?? null,
    resolve: lockdownActive(app.store, owner) ? null : dnsResolve,
  };
}

/**
 * Which settings are saved and their switch-like values only: yes/no, numbers, and one-word
 * choices. Free text (a name, instructions, an address) is left out whatever it holds.
 */
export function settingsSummary(app: Pick<Branch, "store" | "runtime">): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const record of app.store.list("settings", app.runtime.owner).slice(0, 200)) {
    const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (/(key|token|secret|password|pin)/i.test(key)) continue;
      if (typeof value === "boolean" || typeof value === "number") kept[key] = value;
      else if (typeof value === "string" && /^[\w.-]{1,32}$/.test(value)) kept[key] = value;
    }
    out[record.id] = kept;
  }
  return out;
}

/** What kind of install this is, in plain words, for the report. */
export function installTypeOf(options: { installRoot?: string | null; presence?: string; packageRoot: string }): string {
  if (options.installRoot) return "installed app";
  if (existsSync(join(options.packageRoot, ".git"))) return "from source";
  return options.presence === "daemon" ? "background engine" : "package";
}

/** A short id for one request, so a failure in the log can be matched to what the window saw. */
export const newRequestId = (): string => randomUUID().slice(0, 8);
