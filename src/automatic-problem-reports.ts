import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { optionalFields } from "./feature-switches.js"; // Q65
import { redactForLog, type LogLine } from "./diagnostic-log.js";
import { reportItemIds, type ReportItem } from "./diagnostic-report.js";
import type { Store } from "./store.js";

export type AutomaticProblemKind = "crash" | "update";

export function automaticProblemKind(line: Pick<LogLine, "component" | "level" | "message">): AutomaticProblemKind | null {
  if (line.level !== "error") return null;
  if (line.message.startsWith("Crashed:")) return "crash";
  return line.component === "updater" ? "update" : null;
}

const ChannelDestinationSchema = z.object({
  kind: z.literal("channel"),
  channel: z.string().trim().min(1).max(64),
  chatId: z.string().trim().min(1).max(128),
}).strict();

const GitHubDestinationSchema = z.object({
  kind: z.literal("github"),
  repository: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
}).strict();

export const AutomaticProblemReportSettingsSchema = z.object({
  mode: z.enum(["off", "on"]).default("off"),
  destination: z.discriminatedUnion("kind", [ChannelDestinationSchema, GitHubDestinationSchema]).nullable().default(null),
  events: z.array(z.enum(["crash", "update"])).min(1).max(2).default(["crash", "update"]),
  items: z.array(z.enum(reportItemIds)).min(1).max(reportItemIds.length).default(["about", "log", "crashes", "updates"]),
}).strict();
export type AutomaticProblemReportSettings = z.infer<typeof AutomaticProblemReportSettingsSchema>;
const settingsKey = "automatic-problem-reports";

export function automaticProblemReportSettings(store: Pick<Store, "get">, owner: string): AutomaticProblemReportSettings {
  const saved = AutomaticProblemReportSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : AutomaticProblemReportSettingsSchema.parse({});
}

export function saveAutomaticProblemReportSettings(
  store: Pick<Store, "get" | "save">,
  owner: string,
  input: unknown,
): AutomaticProblemReportSettings {
  const changed = optionalFields(AutomaticProblemReportSettingsSchema).parse(input ?? {}); // Q65: only what was sent
  const next = AutomaticProblemReportSettingsSchema.parse({ ...automaticProblemReportSettings(store, owner), ...changed });
  store.save("settings", owner, settingsKey, next);
  return next;
}

export interface ProblemReportPreview {
  title: string;
  body: string;
  items: string[];
  destination: string;
}

export interface AutomaticProblemReportResult {
  sent: boolean;
  retryable: boolean;
  key: string;
  preview: ProblemReportPreview;
  reason?: string;
}

export interface AutomaticProblemReportRecord {
  kind: AutomaticProblemKind;
  destination: string;
  items: string[];
  key: string;
  outcome: "sent" | "failed";
  reason?: string;
}

export interface AutomaticProblemReportDeps {
  settings: () => AutomaticProblemReportSettings;
  linkedChannels: () => { channel: string; chatId: string }[];
  gather: (items: readonly string[]) => Promise<ReportItem[]>;
  deliverChannel: (channel: string, chatId: string, text: string, key: string) => Promise<unknown>;
  createGitHubIssue: (repository: string, title: string, body: string, key: string) => Promise<unknown>;
  /** Recheck the current owner, lock and outbound policy before admitting a report to delivery. */
  requireDelivery?: (settings: AutomaticProblemReportSettings) => void;
  record: (entry: AutomaticProblemReportRecord) => void;
}

function destinationLabel(settings: AutomaticProblemReportSettings): string {
  const destination = settings.destination;
  if (!destination) return "not chosen";
  return destination.kind === "channel"
    ? `${destination.channel}:${destination.chatId}`
    : `github:${destination.repository}`;
}

/** The exact redacted text an opted-in automatic report would send. */
export function problemReportPreview(
  settings: AutomaticProblemReportSettings,
  kind: AutomaticProblemKind,
  summary: string,
  available: readonly ReportItem[],
): ProblemReportPreview {
  const chosen = new Set<string>(settings.items);
  const items = available.filter((item) => chosen.has(item.id));
  const cleanSummary = redactForLog(summary.trim()).slice(0, 500) || "No further detail was recorded.";
  const label = kind === "crash" ? "crash" : "update problem";
  const noticed = kind === "crash" ? "a crash" : "an update problem";
  const maxBody = settings.destination?.kind === "github" ? 8_000 : 24_000;
  const body = [
    `Branch Agent noticed ${noticed}.`,
    "",
    `Summary: ${cleanSummary}`,
    "",
    ...items.flatMap((item) => [`## ${redactForLog(item.title)}`, redactForLog(item.text), ""]),
  ].join("\n").slice(0, maxBody);
  return {
    title: `Branch Agent ${label}: ${cleanSummary.slice(0, 100)}`,
    body,
    items: items.map((item) => item.id),
    destination: destinationLabel(settings),
  };
}

export class AutomaticProblemReports {
  constructor(private readonly deps: AutomaticProblemReportDeps) {}

  async report(
    kind: AutomaticProblemKind,
    summary: string,
    key = `problem-report:${randomUUID()}`,
  ): Promise<AutomaticProblemReportResult> {
    const settings = AutomaticProblemReportSettingsSchema.parse(this.deps.settings());
    const destination = settings.destination;
    if (settings.mode !== "on" || !settings.events.includes(kind) || !destination)
      return { sent: false, retryable: false, key, preview: problemReportPreview(settings, kind, summary, []),
        reason: "Automatic reports are off for this problem." };
    if (destination.kind === "channel" && !this.linked(destination.channel, destination.chatId))
      return { sent: false, retryable: false, key, preview: problemReportPreview(settings, kind, summary, []),
        reason: "That owner chat is no longer linked." };
    let preview = problemReportPreview(settings, kind, summary, []);
    let deliveryStarted = false;
    let consentChanged = false;
    try {
      preview = problemReportPreview(settings, kind, summary, await this.deps.gather(settings.items));
      // Gathering can wait on health/network checks. Its old consent never authorizes a later send.
      const current = AutomaticProblemReportSettingsSchema.parse(this.deps.settings());
      consentChanged = consentFingerprint(current) !== consentFingerprint(settings);
      if (consentChanged) throw new Error("Automatic report settings changed while the report was prepared; nothing was sent.");
      if (destination.kind === "channel" && !this.linked(destination.channel, destination.chatId))
        throw new Error("That owner chat is no longer linked.");
      this.deps.requireDelivery?.(current);
      deliveryStarted = true;
      if (destination.kind === "channel")
        await this.deps.deliverChannel(destination.channel, destination.chatId, preview.body, key);
      else await this.deps.createGitHubIssue(destination.repository, preview.title, preview.body, key);
      this.record({ kind, destination: preview.destination, items: preview.items, key, outcome: "sent" });
      return { sent: true, retryable: false, key, preview };
    } catch (error) {
      const reason = redactForLog(error instanceof Error ? error.message : String(error)).slice(0, 300);
      this.record({ kind, destination: preview.destination, items: preview.items, key, outcome: "failed", reason });
      // Owner chats accept the stable key and can safely deduplicate a retry. GitHub's create-issue
      // API has no idempotency key, so an uncertain response after sending must never create a
      // second public issue. Preparation/admission failures are safe to retry with the same consent;
      // changed consent is discarded, and the outbox also compares its capture-time fingerprint.
      return { sent: false, retryable: !consentChanged && (!deliveryStarted || destination.kind === "channel"), key, preview, reason };
    }
  }

  private linked(channel: string, chatId: string): boolean {
    return this.deps.linkedChannels().some((target) => target.channel === channel && target.chatId === chatId);
  }

  /** An external send cannot be undone, so a local audit failure must never cause it to repeat. */
  private record(entry: AutomaticProblemReportRecord): void {
    try { this.deps.record(entry); } catch { /* the delivery result remains authoritative */ }
  }
}

const IncidentSchema = z.object({
  op: z.literal("put"),
  key: z.string().min(1).max(200),
  kind: z.enum(["crash", "update"]),
  summary: z.string().max(1000),
  consent: z.string().max(2000),
  at: z.string().max(40),
}).strict();
const DoneSchema = z.object({ op: z.literal("done"), key: z.string().min(1).max(200) }).strict();
type ProblemIncident = z.infer<typeof IncidentSchema>;
const outboxLimit = 20;

/**
 * A tiny append-only crash-safe journal. Capturing is synchronous, so a fatal process exit cannot
 * outrun it. Delivery stays asynchronous and a `done` line removes an incident after it was sent.
 */
export class AutomaticProblemOutbox {
  readonly file: string;
  private turn: Promise<void> = Promise.resolve();

  constructor(dir: string, private readonly settings: () => AutomaticProblemReportSettings) {
    this.file = join(dir, "automatic-problem-reports.jsonl");
  }

  capture(line: Pick<LogLine, "at" | "component" | "level" | "message">): ProblemIncident | null {
    const kind = automaticProblemKind(line);
    if (!kind) return null;
    let settings: AutomaticProblemReportSettings;
    try { settings = AutomaticProblemReportSettingsSchema.parse(this.settings()); } catch { return null; }
    if (settings.mode !== "on" || !settings.destination || !settings.events.includes(kind)) return null;
    const incident = IncidentSchema.parse({
      op: "put", key: `problem-report:${kind}:${line.at}`, kind,
      summary: redactForLog(line.message).slice(0, 1000), consent: consentFingerprint(settings), at: line.at,
    });
    try {
      const pending = this.pending();
      if (pending.some((one) => one.key === incident.key)) return incident;
      if (pending.length >= outboxLimit) this.append({ op: "done", key: pending[0]!.key });
      this.append(incident);
      this.compactIfLarge();
      return incident;
    } catch { return null; }
  }

  pending(): ProblemIncident[] {
    const pending = new Map<string, ProblemIncident>();
    for (const entry of this.entries()) {
      if (entry.op === "put") pending.set(entry.key, entry);
      else pending.delete(entry.key);
    }
    return [...pending.values()].slice(-outboxLimit);
  }

  flush(service: Pick<AutomaticProblemReports, "report">): Promise<{ sent: number; kept: number; discarded: number }> {
    const run = this.turn.then(() => this.flushNow(service), () => this.flushNow(service));
    this.turn = run.then(() => undefined, () => undefined);
    return run;
  }

  private async flushNow(service: Pick<AutomaticProblemReports, "report">): Promise<{ sent: number; kept: number; discarded: number }> {
    let sent = 0, kept = 0, discarded = 0;
    const consent = this.currentConsent();
    for (const incident of this.pending()) {
      if (!consent || incident.consent !== consent) {
        this.finish(incident.key); discarded += 1; continue;
      }
      try {
        const result = await service.report(incident.kind, incident.summary, incident.key);
        if (result.sent) { this.finish(incident.key); sent += 1; }
        else if (result.retryable) kept += 1;
        else { this.finish(incident.key); discarded += 1; }
      } catch { kept += 1; }
    }
    this.compactIfLarge();
    return { sent, kept, discarded };
  }

  private currentConsent(): string | null {
    try {
      const settings = AutomaticProblemReportSettingsSchema.parse(this.settings());
      return settings.mode === "on" && settings.destination ? consentFingerprint(settings) : null;
    } catch { return null; }
  }

  private entries(): (ProblemIncident | z.infer<typeof DoneSchema>)[] {
    let text = "";
    try { text = readFileSync(this.file, "utf8"); } catch { return []; }
    return text.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const raw = JSON.parse(line);
        const parsed = raw?.op === "put" ? IncidentSchema.safeParse(raw) : DoneSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      } catch { return []; }
    });
  }

  private append(entry: ProblemIncident | z.infer<typeof DoneSchema>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  private finish(key: string): void { this.append({ op: "done", key }); }

  private compactIfLarge(): void {
    try { if (statSync(this.file).size <= 64 * 1024) return; } catch { return; }
    const temporary = `${this.file}.${randomUUID()}.saving`;
    try {
      writeFileSync(temporary, this.pending().map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
    } catch { try { unlinkSync(temporary); } catch { /* original journal remains */ } }
  }
}

const consentFingerprint = (settings: AutomaticProblemReportSettings): string => JSON.stringify(settings);
