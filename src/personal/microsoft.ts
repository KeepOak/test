import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { stripTags } from "./mime.js";
import { clip, outsideTextNote, requirePersonal } from "./settings.js";
import { signedCall, signedText, type SignIn } from "./signin.js";

/**
 * R17-030: the owner's Outlook mail (read, search, and drafts when allowed), Outlook calendar (read)
 * and Teams meeting transcripts, for a summary, through Microsoft Graph v1.0 and the owner's own
 * sign-in. Nothing here sends mail. What comes back was written by other people, so every answer
 * says so.
 */
const graph = "https://graph.microsoft.com/v1.0/me";

export const OutlookSearchSchema = z.object({
  query: z.string().trim().max(300).default(""),
  max: z.number().int().min(1).max(25).default(10),
}).strict();
export const OutlookReadSchema = z.object({ id: z.string().trim().regex(/^[A-Za-z0-9_=+/-]{1,400}$/) }).strict();
export const OutlookDraftSchema = z.object({
  to: z.array(z.string().trim().email().max(254)).max(20).default([]),
  cc: z.array(z.string().trim().email().max(254)).max(20).default([]),
  subject: z.string().max(300).default(""),
  text: z.string().min(1).max(50000),
  /** A message to answer; the draft is then a reply in that conversation. */
  replyTo: z.string().trim().regex(/^[A-Za-z0-9_=+/-]{1,400}$/).optional(),
}).strict().refine((v) => v.replyTo || v.to.length > 0, "Name at least one person to write to, or a message to answer");
export const OutlookEventsSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  max: z.number().int().min(1).max(50).default(20),
}).strict();
export const TeamsSummarySchema = z.object({
  /** The meeting's join address, as the calendar event gives it. */
  joinUrl: z.string().url().max(2000).regex(/^https:\/\/teams\.microsoft\.com\//, "Give the meeting's Teams join address"),
}).strict();

const Address = z.object({ emailAddress: z.object({ name: z.string().optional(), address: z.string().optional() }).passthrough() }).passthrough();
const who = (value: z.infer<typeof Address> | undefined): string =>
  value ? `${value.emailAddress.name ?? ""} <${value.emailAddress.address ?? ""}>`.trim() : "";
const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));

/** Graph's $search takes one quoted phrase; a quote inside it would end the phrase early. */
export const graphSearch = (query: string): string => `"${query.replace(/["\\]/g, " ").trim()}"`;
/** OData text in single quotes, with a quote inside doubled. */
export const odataText = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** A WebVTT transcript as "Speaker: words" lines, the timings dropped. */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const cue = block.split("\n").filter((line) => line && !/^WEBVTT|-->|^\d+$|^NOTE/.test(line)).join(" ");
    if (!cue) continue;
    const voiced = /^<v ([^>]+)>([\s\S]*?)(<\/v>)?$/.exec(cue);
    lines.push(voiced ? `${voiced[1]!.trim()}: ${voiced[2]!.trim()}` : cue.replace(/<[^>]+>/g, "").trim());
  }
  return lines.join("\n");
}

export class MicrosoftConnector {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch,
    private readonly signIn: SignIn) {}
  private call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<unknown> {
    requirePersonal(this.store, this.owner, "microsoft");
    return signedCall(this.fetcher, this.signIn, "Microsoft", `${graph}${path}`, init);
  }

  async search(input: unknown) {
    const { query, max } = OutlookSearchSchema.parse(input);
    const select = "$select=id,subject,from,receivedDateTime,isRead,bodyPreview,conversationId";
    const path = query
      ? `/messages?$search=${encodeURIComponent(graphSearch(query))}&$top=${max}&${select}`
      : `/mailFolders/inbox/messages?$top=${max}&$orderby=receivedDateTime%20desc&${select}`;
    const body = z.object({ value: z.array(z.object({ id: z.string(), subject: z.string().nullish(), from: Address.optional(),
      receivedDateTime: z.string().optional(), isRead: z.boolean().optional(), bodyPreview: z.string().optional() }).passthrough()).default([]) })
      .passthrough().parse(await this.call(path));
    return { note: outsideTextNote, messages: body.value.map((m) => ({ id: m.id, subject: m.subject ?? "", from: who(m.from),
      received: m.receivedDateTime ?? "", unread: m.isRead === false, preview: clip(m.bodyPreview ?? "", 300) })) };
  }

  async read(input: unknown) {
    const { id } = OutlookReadSchema.parse(input);
    const select = "$select=id,subject,from,toRecipients,receivedDateTime,body,hasAttachments,conversationId";
    const message = z.object({ id: z.string(), subject: z.string().nullish(), from: Address.optional(),
      toRecipients: z.array(Address).default([]), receivedDateTime: z.string().optional(),
      body: z.object({ contentType: z.string().optional(), content: z.string().optional() }).passthrough().optional(),
      hasAttachments: z.boolean().optional() }).passthrough()
      .parse(await this.call(`/messages/${encodeURIComponent(id)}?${select}`, { headers: { prefer: 'outlook.body-content-type="text"' } }));
    const content = message.body?.content ?? "";
    const text = message.body?.contentType?.toLowerCase() === "html" ? stripTags(content) : content;
    let attachments: { name: string; type: string; bytes: number }[] = [];
    if (message.hasAttachments) {
      const listed = z.object({ value: z.array(z.object({ name: z.string().optional(), contentType: z.string().nullish(), size: z.number().optional() })
        .passthrough()).default([]) }).passthrough()
        .parse(await this.call(`/messages/${encodeURIComponent(id)}/attachments?$select=name,contentType,size`));
      attachments = listed.value.slice(0, 50).map((a) => ({ name: a.name ?? "", type: a.contentType ?? "", bytes: a.size ?? 0 }));
    }
    return { id: message.id, subject: message.subject ?? "", from: who(message.from), to: message.toRecipients.map(who),
      received: message.receivedDateTime ?? "", text: clip(text, 20000), attachments, note: outsideTextNote };
  }

  async draft(input: unknown) {
    const value = OutlookDraftSchema.parse(input);
    if (!this.signIn.settings().drafts) throw new Error("Writing drafts is not allowed yet. Allow drafts on the Microsoft card, then sign in again.");
    const made = value.replyTo
      ? await this.call(`/messages/${encodeURIComponent(value.replyTo)}/createReply`, { method: "POST", json: { comment: value.text } })
      : await this.call("/messages", { method: "POST", json: { subject: value.subject, body: { contentType: "Text", content: value.text },
        toRecipients: recipients(value.to), ccRecipients: recipients(value.cc) } });
    const { id } = z.object({ id: z.string() }).passthrough().parse(made);
    return { draftId: id, sent: false, note: "The draft is in your Outlook drafts. Branch never sends it; you do." };
  }

  async events(input: unknown, now = new Date()) {
    const value = OutlookEventsSchema.parse(input);
    const from = value.from ?? now.toISOString();
    const to = value.to ?? new Date(Date.parse(from) + 86_400_000).toISOString();
    const query = new URLSearchParams({ startDateTime: from, endDateTime: to, $top: String(value.max),
      $select: "subject,start,end,location,isOnlineMeeting,onlineMeeting", $orderby: "start/dateTime" });
    const Time = z.object({ dateTime: z.string(), timeZone: z.string().optional() }).passthrough();
    const body = z.object({ value: z.array(z.object({ id: z.string(), subject: z.string().nullish(), start: Time.optional(), end: Time.optional(),
      location: z.object({ displayName: z.string().nullish() }).passthrough().nullish(),
      onlineMeeting: z.object({ joinUrl: z.string().nullish() }).passthrough().nullish() }).passthrough()).default([]) })
      .passthrough().parse(await this.call(`/calendarView?${query}`, { headers: { prefer: 'outlook.timezone="UTC"' } }));
    return { from, to, note: outsideTextNote, events: body.value.map((e) => ({ id: e.id, title: clip(e.subject ?? "(no title)", 200),
      starts: e.start?.dateTime ?? "", ends: e.end?.dateTime ?? "", location: clip(e.location?.displayName ?? "", 200),
      teamsJoinUrl: e.onlineMeeting?.joinUrl ?? null })) };
  }

  /** The newest transcript of one Teams meeting, as plain lines, for the model to summarise. */
  async meetingTranscript(input: unknown) {
    const { joinUrl } = TeamsSummarySchema.parse(input);
    const meetings = z.object({ value: z.array(z.object({ id: z.string(), subject: z.string().nullish() }).passthrough()).default([]) })
      .passthrough().parse(await this.call(`/onlineMeetings?$filter=${encodeURIComponent(`JoinWebUrl eq ${odataText(joinUrl)}`)}`));
    const meeting = meetings.value[0];
    if (!meeting) throw new Error("No Teams meeting you organised or joined has that join address.");
    const transcripts = z.object({ value: z.array(z.object({ id: z.string(), createdDateTime: z.string().optional() }).passthrough()).default([]) })
      .passthrough().parse(await this.call(`/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts`));
    const newest = [...transcripts.value].sort((a, b) => (b.createdDateTime ?? "").localeCompare(a.createdDateTime ?? ""))[0];
    if (!newest) throw new Error("That meeting has no transcript. Transcription has to be switched on during the meeting.");
    requirePersonal(this.store, this.owner, "microsoft");
    const vtt = await signedText(this.fetcher, this.signIn, "Microsoft",
      `${graph}/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts/${encodeURIComponent(newest.id)}/content?$format=text/vtt`, 1_000_000);
    return { meeting: meeting.subject ?? "", recordedAt: newest.createdDateTime ?? null, transcript: clip(vttToText(vtt), 60000),
      note: `${outsideTextNote} Summarise it for the owner: decisions, actions and who owns them.` };
  }
}

export function registerMicrosoft(registry: Pick<ToolRegistry, "register">, microsoft: MicrosoftConnector): void {
  const tool = (name: string, permission: string, description: string, parameters: z.ZodType, run: (input: unknown) => Promise<unknown>) =>
    registry.register({ name, permission, description, parameters, execute: async (input) => run(input) });
  tool("outlook.search", "personal.read", "Search the owner's Outlook mail, or list the newest in the inbox when no words are given.",
    OutlookSearchSchema, (input) => microsoft.search(input));
  tool("outlook.read", "personal.read", "Read one message from the owner's Outlook mail, by the id outlook.search gave.", OutlookReadSchema, (input) => microsoft.read(input));
  // Ships-on sweep (2026-09-26): the rules judge a draft by who it is to, or the message it answers.
  registry.register({ name: "outlook.draft", permission: "personal.write",
    description: "Write a draft in the owner's Outlook, or a draft reply to a message. It is never sent; the owner sends it.",
    parameters: OutlookDraftSchema, execute: async (input) => microsoft.draft(input),
    target: (input) => { const to = [...input.to, ...input.cc]; return to.length ? `draft to ${to.join(", ")}` : `draft reply to ${input.replyTo ?? "a message"}`; } });
  tool("outlook.events", "personal.read", "List the events in the owner's Outlook calendar between two times (the next day by default), with Teams join addresses.",
    OutlookEventsSchema, (input) => microsoft.events(input));
  tool("teams.summary", "personal.read", "Fetch the transcript of a Teams meeting, by its join address, so it can be summarised for the owner.",
    TeamsSummarySchema, (input) => microsoft.meetingTranscript(input));
}
