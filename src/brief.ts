import { briefOwnerOnly, chatOwnerOnly, startedFromChat } from "./key-context.js";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { DocumentLibrary } from "./documents.js";
import type { Monitors } from "./monitors.js";
import type { DeliveryHandler } from "./scheduler.js";
import { nextDailyOccurrence } from "./scheduler.js";
import { placeholders, substitute } from "./recipes.js";
import { optionalFields } from "./feature-switches.js";
import { markChosen, savedFields, shippedUnlessChosen } from "./ship-on.js";
import { briefSources, BriefSourcesSchema } from "./brief-sources.js";

/**
 * One message first thing: what is planned today, what was left unfinished, documents that arrived,
 * watches that noticed something, and anything the person asked to be reminded of. Everything comes
 * from what the app already knows — no calendar account and nothing read aloud — and the wording is
 * a template the person can change.
 */
const originalSections = ["schedules", "tasks", "documents", "watches", "reminders"] as const;
export const briefSections = [...originalSections, "news", "health"] as const;
export type BriefSection = (typeof briefSections)[number];
export const defaultTemplate = `Good morning. Here is {{date}}.

**Planned today**
{{schedules}}

**Still open**
{{tasks}}

**New documents**
{{documents}}

**Watches that changed**
{{watches}}

**Reminders**
{{reminders}}`;
const zone = z.string().min(1).max(64).refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}, "Unknown timezone");
/** This computer's own time zone, so a morning brief nobody has set comes in the morning here. */
const localZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};
export const BriefSettingsSchema = z.object({
  /** Read through `MorningBrief.settings`, which ships it on (see `briefShipsOn`). */
  enabled: z.boolean().default(false),
  /** Local time of day to send it, 24-hour. */
  dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("07:30"),
  timezone: zone.default(localZone),
  deliverTo: z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict().nullable().default(null),
  template: z.string().max(4000).default(defaultTemplate),
  sections: z.array(z.enum(briefSections)).max(7).default([...originalSections]),
  nextAt: z.iso.datetime().nullable().default(null),
  lastSentAt: z.iso.datetime().nullable().default(null),
}).strict();
export type BriefSettings = z.infer<typeof BriefSettingsSchema>;
export type BriefContent = Record<BriefSection, string[]>;
const nothing = "Nothing today.";

/**
 * Refuses a wording that asks for something the brief cannot fill in. Without this a single typo
 * would be saved happily and then throw every morning where nobody could see it.
 */
export function checkTemplate(template: string): void {
  const allowed = new Set<string>(["date", ...briefSections]);
  const unknown = [...placeholders(template)].filter((name) => !allowed.has(name));
  if (unknown.length)
    throw new Error(`The brief has nothing called "${unknown[0]}" to fill in. You can use: ${[...allowed].map((name) => `{{${name}}}`).join(", ")}`);
}

/** Turns gathered lines into the finished message; a section the person turned off is left out. */
export function assembleBrief(settings: BriefSettings, content: BriefContent, now: Date): string {
  const bound: Record<string, string> = {
    date: new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, weekday: "long", day: "numeric", month: "long" }).format(now),
  };
  for (const section of briefSections)
    bound[section] = settings.sections.includes(section) && (content[section] ?? []).length
      ? (content[section] ?? []).map((line) => `- ${line}`).join("\n")
      : settings.sections.includes(section) ? nothing : "";
  const text = substitute(settings.template, bound);
  // A section that was switched off leaves its heading with an empty body; drop both.
  return text.replace(/\n\*\*[^*]+\*\*\n(?=\n|$)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The owner's rule (2026-09-27): the morning brief is made from what Branch already holds and written into the owner's
 * own conversation list; it goes to a chat only when the owner names one. None of (a)–(f), so it ships on.
 */
export const briefShipsOn: Partial<BriefSettings> = { enabled: true };

export class MorningBrief {
  constructor(
    readonly store: Store,
    private readonly monitors?: Monitors,
    private readonly documents?: DocumentLibrary,
    private readonly deliver?: DeliveryHandler,
  ) {}
  sources(owner: string) { return briefSources(this.store, owner); }
  configureSources(owner: string, input: unknown) {
    this.store.profiles.requireOwner("Choosing morning brief sources");
    const value = BriefSourcesSchema.extend({ approveBriefSources: z.literal(true) }).parse(input);
    const available = new Set((this.monitors?.list(owner) ?? []).filter(w => w.kind === "search").map(w => w.id));
    if (value.newsWatchIds.some(id => !available.has(id))) throw new Error("Select existing news search watches");
    const settings = this.settings(owner);
    const sections: BriefSection[] = settings.sections.filter(s => s !== "news" && s !== "health");
    if (value.newsWatchIds.length) sections.push("news");
    if (value.healthSource !== "off") sections.push("health");
    let template = settings.template;
    for (const section of ["news", "health"] as const) if (sections.includes(section) && !placeholders(template).has(section)) template += `\n\n**${section === "news" ? "Selected news watches" : "Private health review"}**\n{{${section}}}`;
    this.configure(owner, { sections, template });
    this.store.save("settings", owner, "brief-sources", { newsWatchIds: value.newsWatchIds, healthSource: value.healthSource });
    return this.sources(owner);
  }
  settings(owner: string): BriefSettings {
    const saved = BriefSettingsSchema.safeParse(this.store.get("settings", owner, "brief")?.data ?? {});
    if (!saved.success) return BriefSettingsSchema.parse({});
    // A record that names a chat keeps its own switch: sending the brief there is sending out (b), so an off beside a
    // chat is never read as on. Otherwise an "off" beside the time and the sections may be the old default (src/ship-on.ts).
    return saved.data.deliverTo ? saved.data : shippedUnlessChosen(this.store, owner, "brief", saved.data, briefShipsOn);
  }
  configure(owner: string, input: unknown, now = new Date()): BriefSettings {
    const before = this.store.get("settings", owner, "brief")?.data;
    const merged = BriefSettingsSchema.parse({ ...this.settings(owner), ...(input as object) });
    checkTemplate(merged.template);
    const value: BriefSettings = { ...merged,
      nextAt: merged.enabled ? nextDailyOccurrence(now, merged.dailyAt, merged.timezone).toISOString() : null };
    this.store.save("settings", owner, "brief", value);
    markChosen(this.store, owner, "brief", savedFields(before, BriefSettingsSchema.safeParse(before ?? {}).success, input, briefShipsOn));
    return value;
  }
  /** Everything the brief can talk about, gathered from what the app already holds. */
  gather(owner: string, now = new Date()): BriefContent {
    const sources = this.sources(owner);
    const since = new Date(now.getTime() - 86400000).toISOString();
    const endOfDay = new Date(now.getTime() + 86400000).toISOString();
    return {
      news: this.monitors?.news(owner, sources.newsWatchIds, now) ?? [],
      health: sources.healthSource === "off" ? [] : [`Review your selected ${sources.healthSource.toUpperCase()} source in Morning brief & watch history. Connection status is not verified by this reminder. A separate owner click approves each private date read; no metrics are included in this saved or delivered brief.`],
      schedules: this.store.list("schedules", owner)
        .filter((record) => record.data.status === "pending" && String(record.data.dueAt ?? "") <= endOfDay)
        .slice(0, 8).map((record) => `${String(record.data.prompt).slice(0, 120)} (${String(record.data.dueAt).slice(11, 16)})`),
      tasks: this.store.runs(owner)
        .filter((run) => ["needs_input", "failed", "interrupted", "budget_exceeded"].includes(run.status))
        .slice(0, 8).map((run) => `${run.prompt.slice(0, 120)} — ${run.status.replace(/_/g, " ")}`),
      documents: (this.documents?.list(owner) ?? []).filter((document) => document.updatedAt >= since)
        .slice(0, 8).map((document) => `${document.name} (${document.chunks} passage${document.chunks === 1 ? "" : "s"})`),
      watches: (this.monitors?.list(owner) ?? [])
        .filter((monitor) => monitor.changes > 0 && (monitor.lastCheckedAt ?? "") >= since)
        .slice(0, 8).map((monitor) => `${monitor.label} changed ${monitor.changes} time${monitor.changes === 1 ? "" : "s"}`),
      reminders: this.store.list("memory", owner)
        .filter((record) => /remind/i.test(`${String(record.data.attribute ?? "")} ${String(record.data.text ?? "")}`) && !record.data.validTo)
        .slice(0, 5).map((record) => String(record.data.text).slice(0, 160)),
    };
  }
  preview(owner: string, now = new Date()): { markdown: string; content: BriefContent } {
    const settings = this.settings(owner);
    return { markdown: assembleBrief(settings, this.gather(owner, now), now), content: this.gather(owner, now) };
  }
  /** Writes the brief into the conversation list and sends it on, when a chat was chosen. */
  async send(owner: string, now = new Date()): Promise<{ markdown: string; delivered: string | null; runId: string }> {
    const settings = this.settings(owner);
    const markdown = assembleBrief(settings, this.gather(owner, now), now);
    const run = this.store.createRun(owner, "Morning brief");
    this.store.message(run.sessionId, { role: "assistant", content: markdown });
    this.store.event(run.id, "brief.sent", { sections: settings.sections });
    this.store.finish(run.id, "completed", markdown);
    let delivered: string | null = null;
    if (settings.deliverTo && this.deliver) {
      await this.deliver(settings.deliverTo.channel, settings.deliverTo.chatId, markdown, `brief:${run.id}`);
      delivered = `${settings.deliverTo.channel}:${settings.deliverTo.chatId}`;
    }
    this.store.save("settings", owner, "brief", { ...settings, lastSentAt: now.toISOString(),
      nextAt: settings.enabled ? nextDailyOccurrence(now, settings.dailyAt, settings.timezone).toISOString() : null });
    return { markdown, delivered, runId: run.id };
  }
  /** Called on every scheduler beat; sends the brief once its chosen time has come round. */
  async tick(owner: string, now = new Date()): Promise<boolean> {
    const settings = this.settings(owner);
    // On as it ships, with no time worked out yet: the first one is the next morning, never one sent at once.
    if (settings.enabled && !settings.nextAt) {
      this.store.save("settings", owner, "brief", { ...settings, nextAt: nextDailyOccurrence(now, settings.dailyAt, settings.timezone).toISOString() });
      return false;
    }
    if (!settings.enabled || !settings.nextAt || settings.nextAt > now.toISOString()) return false;
    await this.send(owner, now);
    return true;
  }
}

export function registerBrief(registry: ToolRegistry, brief: MorningBrief): void {
  registry.register({
    name: "brief.preview", permission: "brief.read",
    description: "Put together the morning brief for right now and show it, without sending it anywhere.",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => { briefOwnerOnly(context); return brief.preview(context.owner); },
  });
  registry.register({
    name: "brief.configure", permission: "brief.manage",
    description: "Turn the morning brief on or off, choose the time of day and timezone, choose which parts it covers, change its wording, and choose the chat it is sent to.",
    parameters: optionalFields(BriefSettingsSchema),
    execute: async (input, context) => {
      briefOwnerOnly(context);
      if (startedFromChat(context, brief.store)) throw chatOwnerOnly("Changing the morning brief");
      // The chat the brief goes to is the owner's to choose, as sending to it now is (channels.broadcast).
      if ((input as { deliverTo?: unknown }).deliverTo) {
        brief.store.profiles.requireOwner("Sending messages to your chats");
        if (context.trunk || context.agent?.startsWith("trunk:")) throw new Error("The chat the morning brief goes to is the owner's to choose.");
        if (!context.permissions.has("channels.send")) throw new Error("Permission denied: channels.send");
      }
      return brief.configure(context.owner, input);
    },
  });
  registry.register({
    name: "brief.send", reach: "outbound", permission: "brief.manage",
    description: "Send the morning brief now: it appears in the conversation list and goes to the chosen chat.",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => {
      briefOwnerOnly(context);
      if (startedFromChat(context, brief.store)) throw chatOwnerOnly("Sending the morning brief to a chat");
      // With a chat chosen, sending the brief is sending to that chat, which asks what sending asks.
      if (brief.settings(context.owner).deliverTo) {
        brief.store.profiles.requireOwner("Sending messages to your chats");
        if (!context.permissions.has("channels.send")) throw new Error("Permission denied: channels.send");
      }
      return brief.send(context.owner);
    },
  });
}
