import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { clip, partSettings, personalMode, requirePersonal, savePartSettings } from "./settings.js";
import { briefOwnerOnly } from "../key-context.js";

/**
 * R17-025: a daily briefing read aloud, built from what the owner has connected: today's events and
 * new mail from Google and Microsoft (whichever of those parts is switched on and signed in), and the
 * morning brief Branch already writes. With nothing connected it is simply the morning brief, spoken.
 * It is spoken with the owner's own voice settings, played in the window, or sent to one chat as a
 * voice note through the chat app's own adapter — to a chat that has already talked to the assistant.
 *
 * The spec said this "needs R17-028" (Spotify); a briefing built from connectors needs the calendar
 * and mail connectors (R17-029, R17-030) instead, so those are what it reads.
 */
export const SpokenBriefSettingsSchema = z.object({
  calendar: z.boolean().default(true),
  mail: z.boolean().default(true),
  morningBrief: z.boolean().default(true),
  /** Longest briefing, in characters, so a busy day is still a short listen. */
  maxCharacters: z.number().int().min(200).max(4000).default(1500),
}).strict();
const settingsKey = "personal-spoken-brief-settings";

export const SpokenBriefSchema = z.object({
  /** A chat to send it to as a voice note; left out, it is only written and spoken here. */
  channel: z.string().trim().min(1).max(64).optional(),
  chatId: z.string().trim().min(1).max(64).optional(),
}).strict().refine((v) => (v.channel === undefined) === (v.chatId === undefined), "Name both the chat app and the chat, or neither");

interface Event { title: string; starts: string }
interface Mail { unread: boolean }
export interface BriefSources {
  morningBrief: () => string;
  googleEvents: () => Promise<{ events: Event[] }>;
  googleMail: () => Promise<{ messages: Mail[] }>;
  outlookEvents: () => Promise<{ events: Event[] }>;
  outlookMail: () => Promise<{ messages: Mail[] }>;
}
export interface SpokenBriefDeps {
  store: Store;
  owner: string;
  sources: BriefSources;
  speak: (text: string) => Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Sends a voice note, after the same recipient and outbound checks a file send has. */
  sendVoice: (channel: string, chatId: string, audio: { bytes: Uint8Array; mediaType: string }, text: string) => Promise<void>;
}

const time = (value: string): string => (/T(\d{2}:\d{2})/.exec(value)?.[1] ?? "all day");
/** Markdown and list marks read badly aloud, so they are taken out. */
export const speakable = (text: string): string =>
  text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|]/g, " ").replace(/^\s*[-•]\s+/gm, "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();

export function eventLine(service: string, events: Event[]): string {
  if (!events.length) return `Nothing is on your ${service} calendar for the next day.`;
  const first = events.slice(0, 5).map((event) => `${time(event.starts)} ${event.title}`).join("; ");
  return `${events.length} event${events.length === 1 ? "" : "s"} on your ${service} calendar: ${first}.`;
}
export function mailLine(service: string, messages: Mail[]): string {
  const unread = messages.filter((message) => message.unread).length;
  return unread ? `${unread}${unread >= 10 ? " or more" : ""} unread message${unread === 1 ? "" : "s"} in ${service}.` : `No unread mail in ${service}.`;
}

export class SpokenBrief {
  constructor(private readonly deps: SpokenBriefDeps) {}
  settings() { return partSettings(this.deps.store, this.deps.owner, settingsKey, SpokenBriefSettingsSchema); }
  save(input: unknown) { return savePartSettings(this.deps.store, this.deps.owner, settingsKey, SpokenBriefSettingsSchema, input); }

  /** One line per source; a source that cannot be reached says so and the rest carry on. */
  async script(): Promise<string> {
    const { store, owner, sources } = this.deps;
    const settings = this.settings();
    const lines: string[] = [];
    const tryLine = async (what: string, make: () => Promise<string>) => {
      lines.push(await make().catch(() => `${what} could not be reached just now.`));
    };
    const google = personalMode(store, owner, "google") !== "off", outlook = personalMode(store, owner, "microsoft") !== "off";
    if (settings.calendar && google) await tryLine("Google Calendar", async () => eventLine("Google", (await sources.googleEvents()).events));
    if (settings.calendar && outlook) await tryLine("Outlook", async () => eventLine("Outlook", (await sources.outlookEvents()).events));
    if (settings.mail && google) await tryLine("Gmail", async () => mailLine("Gmail", (await sources.googleMail()).messages));
    if (settings.mail && outlook) await tryLine("Outlook mail", async () => mailLine("Outlook", (await sources.outlookMail()).messages));
    if (settings.morningBrief || !lines.length) lines.push(speakable(sources.morningBrief()));
    return clip(lines.filter(Boolean).join("\n"), settings.maxCharacters);
  }

  /** The briefing written, spoken, and — when a chat is named — sent there as a voice note. */
  async run(input: unknown): Promise<{ text: string; audio: { bytes: Uint8Array; mediaType: string }; sentTo: string | null }> {
    requirePersonal(this.deps.store, this.deps.owner, "spoken-brief");
    const target = SpokenBriefSchema.parse(input);
    // Playing it here ships on; sending it into a chat is sending out (b), so it also needs the owner's own switch for that.
    if (target.channel && target.chatId) requirePersonal(this.deps.store, this.deps.owner, "chat-files");
    const text = await this.script();
    const audio = await this.deps.speak(text);
    if (target.channel && target.chatId) await this.deps.sendVoice(target.channel, target.chatId, audio, text);
    return { text, audio, sentTo: target.channel ? `${target.chatId} on ${target.channel}` : null };
  }
}

/**
 * Two tools, so that sending is its own permission. Neither `personal.read` nor `channels.send` is
 * given to a task a chat started, so nobody writing from a chat can hear or forward the owner's day.
 */
export function registerSpokenBrief(registry: Pick<ToolRegistry, "register">, brief: SpokenBrief): void {
  registry.register({ name: "brief.spoken", permission: "personal.read",
    description: "Make the owner's daily briefing from their connected calendars and mail and the morning brief, and read it aloud.",
    parameters: z.object({}).strict(), execute: async (_input, context) => {
      briefOwnerOnly(context); // Q134: it carries the owner's morning brief
      const { text, audio } = await brief.run({});
      return { text, spokenBytes: audio.bytes.byteLength };
    } });
  registry.register({ name: "brief.send_voice", permission: "channels.send",
    description: "Make the owner's daily briefing, read it aloud, and send it to one linked chat as a voice note.",
    parameters: SpokenBriefSchema,
    // The chat it goes to, written as a broadcast writes each of its chats, so the owner's rules about
    // that chat, or its account, hold here too. With no chat named it goes nowhere.
    targets: (input) => (input.channel && input.chatId ? [{ kind: "write", path: `${input.channel}:${input.chatId}` }] : []),
    execute: async (input, context) => {
      briefOwnerOnly(context); // Q134
      const { text, sentTo } = await brief.run(input);
      return { text, sentTo };
    } });
}
