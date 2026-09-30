import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Completion, Message } from "./contracts.js";
import { FeatureModeSchema, optionalFields, type FeatureMode } from "./feature-switches.js";

/**
 * Asking the same thing twice. When this is switched on, the exact request that went to the model —
 * every message, every tool description, the model, the effort — is reduced to one hash, and the
 * answer is kept against it for a while. The next identical request is answered from here: nothing
 * leaves the computer and nothing is charged.
 *
 * Three rules keep it honest. An answer that asks for a tool is never kept, because replaying it
 * would replay whatever that tool does; only plain text answers are. Nothing that carried a picture
 * or the name of a saved secret is kept at all. And the answers are filed under whoever is using
 * the app, so a second person in the household never reads one of the owner's answers back out.
 */
export const CacheSettingsSchema = z.object({
  /** Off until the owner turns it on: the same question can have a new answer. */
  enabled: z.boolean().default(false),
  /**
   * w911: the three-way switch. "when-needed" keeps only the answers to Branch's own side questions —
   * the ones asked with no tools on offer, such as a summary or a rewritten search question — so an
   * ordinary turn of a conversation is always asked afresh. "on" keeps every plain answer. A save from
   * before this switch had only `enabled`, and a yes there kept every plain answer, so it reads as "on".
   */
  mode: FeatureModeSchema.optional(),
  /** How long a kept answer counts, in minutes. */
  ttlMinutes: z.number().int().min(1).max(10080).default(60),
  /** How many answers to keep before the oldest are let go. */
  maxEntries: z.number().int().min(1).max(5000).default(500),
}).strict();
export type CacheSettings = z.infer<typeof CacheSettingsSchema>;
const settingsKey = "request-cache";

export function cacheSettings(store: Store, owner: string): CacheSettings {
  const saved = CacheSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : CacheSettingsSchema.parse({});
}
export function saveCacheSettings(store: Store, owner: string, input: unknown): CacheSettings {
  const current = cacheSettings(store, owner);
  const given = optionalFields(CacheSettingsSchema).parse(input ?? {});
  const merged = CacheSettingsSchema.parse({ ...current, ...given });
  // A bare yes turns it back on as it was, or fully on: that is what a yes meant before the three-way switch.
  const was = cacheMode(current);
  const mode = given.mode ?? (given.enabled === false ? "off" : given.enabled === true ? (was === "off" ? "on" : was) : was);
  const next = { ...merged, mode, enabled: mode !== "off" };
  store.save("settings", owner, settingsKey, next);
  return next;
}
/** The mode a saved record stands for; an older yes meant every plain answer was kept, so it is "on". */
export function cacheMode(settings: Pick<CacheSettings, "enabled" | "mode">): FeatureMode {
  return settings.mode ?? (settings.enabled ? "on" : "off");
}
/** Whether this request may be answered from, or written to, the kept answers under this mode. */
export function cacheApplies(mode: FeatureMode, parts: CacheKeyParts): boolean {
  if (mode === "off" || neverKeep(parts)) return false;
  return mode === "on" || parts.tools.length === 0;
}

/** What identifies one request: everything the model was actually shown, and nothing else. */
export interface CacheKeyParts {
  provider: string;
  model: string;
  reasoning: string | null;
  maxTokens: number;
  messages: Message[];
  tools: { name: string; description?: string }[];
  /** The name of the reply shape that was asked for, when one was; a shaped ask is its own request. */
  shape?: string | null;
}

/**
 * The hash. Messages keep their role, their text and any tool call they carry; pictures are left
 * out of the hash by their bytes and counted instead, so a request with a screenshot never matches
 * one with a different screenshot but the hash stays small. Each tool goes in by name *and* by the
 * words describing it, because those words are part of what the model was shown: a tool whose
 * description changed is a different request even though its name did not.
 */
export function requestHash(parts: CacheKeyParts): string {
  const shape = {
    provider: parts.provider, model: parts.model, reasoning: parts.reasoning, maxTokens: parts.maxTokens,
    messages: parts.messages.map((message) => ({
      role: message.role, content: message.role === "system" ? withoutClock(message.content) : message.content, toolCallId: message.toolCallId ?? null,
      toolCalls: (message.toolCalls ?? []).map((call) => ({ name: call.name, arguments: call.arguments })),
      images: (message.images ?? []).map((image) => createHash("sha256").update(image.data).digest("hex").slice(0, 16)),
    })),
    tools: parts.tools.map((tool) => `${tool.name}\u0000${tool.description ?? ""}`).sort(),
    answerShape: parts.shape ?? null,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

/**
 * Requests that are never kept however plain the answer looks: one carrying a picture (the bytes
 * would be kept with it, and the next screenshot is never the same picture anyway) and one that
 * names a saved secret, so nothing that stands for a password is written into a second place.
 *
 * A secret is named as `secret://project/NAME`, and the place it most often appears is not the
 * words of a message but the arguments of a tool call the model asked for earlier in the same
 * conversation — a deploy command, a header, a sign-in. Those arguments are part of the request, so
 * they are read here too; looking only at the words let a whole conversation carrying a secret
 * reference be kept.
 */
export function neverKeep(parts: CacheKeyParts): boolean {
  return asksTheTime(parts) || parts.messages.some((message) =>
    (message.images?.length ?? 0) > 0 || namesSecret(message.content)
    || (message.toolCalls ?? []).some((call) => namesSecret(call.arguments) || namesSecret(call.name)));
}

/**
 * The environment line (src/environment.ts) ends its local time with the hour and minute. The key leaves the clock
 * out, so the same request a minute later is still the same request; the date stays in, so a new day never matches.
 */
export function withoutClock(content: string): string {
  return content.replace(/(Local time: [^()\n]*?),? \d{1,2}:\d{2}( \()/g, "$1$2");
}
/**
 * A question about the time or the date is never answered from, or kept in, the kept answers: its right answer
 * changes by the minute even though the key no longer does. Read from the newest question in the request.
 */
const timeQuestion = /\b(what(?:'s| is)? (?:the )?(?:time|date|day)|what time|which day|today|tonight|tomorrow|yesterday|right now|now|current (?:time|date)|o'?clock|this (?:morning|afternoon|evening))\b/i;
function asksTheTime(parts: CacheKeyParts): boolean {
  const question = [...parts.messages].reverse().find((message) => message.role === "user");
  return !!question && timeQuestion.test(question.content);
}
/** An answer that says a clock time (14:05, 2 pm, 3 o'clock) is never kept: it would be wrong a minute later. */
export function saysAClockTime(text: string): boolean {
  return /\b\d{1,2}:\d{2}\b|\bo'?clock\b|\b\d{1,2}\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/i.test(text);
}
/** Whether a piece of a request stands for something in the locker rather than saying it outright. */
const namesSecret = (text: string): boolean => text.includes("secret://");

interface CacheRow { completion: Completion; savedAt: string }

/**
 * The kept answers. They live in the ordinary settings store under their own prefix, so they are
 * backed up, scoped to the owner and thrown away with everything else when the owner clears up.
 */
export class RequestCache {
  constructor(private readonly store: Store, private readonly owner: string, private readonly now: () => number = Date.now) {}
  private get settings(): CacheSettings { return cacheSettings(this.store, this.owner); }
  /**
   * Whose kept answers these are. A task started while somebody else's profile is switched on runs
   * under the owner's runtime, so the owner's name alone would let two people in the household read
   * each other's answers back; the profile in use is asked for instead, and it is the owner's own
   * name when nobody has switched.
   */
  private get scope(): string { return this.store.profiles.scope(); }
  private key(hash: string): string { return `cache:${hash}`; }

  /** The kept answer for this request, or null: switched off, never seen, or too old. */
  look(parts: CacheKeyParts): Completion | null {
    const settings = this.settings;
    if (!cacheApplies(cacheMode(settings), parts)) return null;
    const hash = requestHash(parts);
    const record = this.store.get("settings", this.scope, this.key(hash));
    if (!record) return null;
    const row = record.data as unknown as CacheRow;
    if (this.now() - new Date(row.savedAt).getTime() > settings.ttlMinutes * 60000) {
      this.store.delete("settings", this.scope, this.key(hash));
      return null;
    }
    return row.completion;
  }

  /**
   * Keeps a plain text answer. An answer that asks for a tool is never kept, and neither is one to
   * a request carrying a picture or the name of a saved secret; it returns false.
   */
  keep(parts: CacheKeyParts, completion: Completion): boolean {
    const settings = this.settings;
    if (!cacheApplies(cacheMode(settings), parts)) return false;
    if (completion.toolCalls?.length || saysAClockTime(completion.content ?? "")) return false;
    this.store.save("settings", this.scope, this.key(requestHash(parts)),
      { completion: { content: completion.content, toolCalls: [] }, savedAt: new Date(this.now()).toISOString() });
    this.prune(settings.maxEntries);
    return true;
  }

  /** How many answers are kept, and when the oldest was kept. */
  summary(): { enabled: boolean; mode: FeatureMode; entries: number; ttlMinutes: number } {
    const settings = this.settings;
    return { enabled: cacheMode(settings) !== "off", mode: cacheMode(settings), entries: this.rows().length, ttlMinutes: settings.ttlMinutes };
  }

  /** Throws every kept answer away. */
  clear(): { cleared: number } {
    const rows = this.rows();
    for (const row of rows) this.store.delete("settings", this.scope, row.id);
    return { cleared: rows.length };
  }

  private rows() {
    return this.store.list("settings", this.scope).filter((record) => record.id.startsWith("cache:"));
  }
  /** Keeps the newest and lets the rest go, so the store cannot grow without end. */
  private prune(limit: number): void {
    const rows = this.rows().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const row of rows.slice(limit)) this.store.delete("settings", this.scope, row.id);
  }
}
