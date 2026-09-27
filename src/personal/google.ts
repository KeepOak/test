import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { buildPlainMail, stripTags } from "./mime.js";
import { clip, outsideTextNote, requirePersonal } from "./settings.js";
import { signedCall, signedText, type SignIn } from "./signin.js";

/**
 * R17-029: the owner's Gmail (read, search, and drafts when allowed), Google Calendar (read) and
 * Google Drive (search and read), through Google's official REST APIs and the owner's own sign-in.
 * Nothing here sends mail. What comes back was written by other people, so every answer says so.
 *
 *   Gmail     https://gmail.googleapis.com/gmail/v1/users/me/{messages,drafts}
 *   Calendar  https://www.googleapis.com/calendar/v3/calendars/primary/events
 *   Drive     https://www.googleapis.com/drive/v3/files
 */
const gmail = "https://gmail.googleapis.com/gmail/v1/users/me";
const calendar = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const drive = "https://www.googleapis.com/drive/v3/files";

export const MailSearchSchema = z.object({
  query: z.string().trim().max(500).default(""),
  max: z.number().int().min(1).max(25).default(10),
}).strict();
export const MailReadSchema = z.object({ id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict();
export const DraftSchema = z.object({
  to: z.array(z.string().trim().max(254)).min(1).max(20),
  cc: z.array(z.string().trim().max(254)).max(20).default([]),
  subject: z.string().max(300),
  text: z.string().min(1).max(50000),
  /** A thread to put the draft in, from gmail.read. */
  threadId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
}).strict();
export const EventsSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  max: z.number().int().min(1).max(50).default(20),
}).strict();
export const DriveSearchSchema = z.object({ text: z.string().trim().min(1).max(200), max: z.number().int().min(1).max(25).default(10) }).strict();
export const DriveReadSchema = z.object({ id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict();

const Header = z.object({ name: z.string(), value: z.string() }).passthrough();
type Payload = { mimeType?: string | undefined; filename?: string | undefined; headers?: z.infer<typeof Header>[] | undefined;
  body?: { data?: string | undefined; size?: number | undefined } | undefined; parts?: Payload[] | undefined };
const PayloadSchema: z.ZodType<Payload> = z.lazy(() => z.object({
  mimeType: z.string().optional(), filename: z.string().optional(), headers: z.array(Header).optional(),
  body: z.object({ data: z.string().optional(), size: z.number().optional() }).passthrough().optional(),
  parts: z.array(PayloadSchema).max(100).optional(),
}).passthrough());
const MessageSchema = z.object({ id: z.string(), threadId: z.string().optional(), snippet: z.string().optional(),
  labelIds: z.array(z.string()).optional(), payload: PayloadSchema.optional() }).passthrough();

const header = (payload: Payload | undefined, name: string): string =>
  payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const decode = (data: string | undefined): string => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

/** Walks Gmail's part tree for the plain text, the formatted text, and the attached files. */
export function gmailBody(payload: Payload | undefined, depth = 0): { plain: string; html: string; files: { filename: string; mimeType: string; bytes: number }[] } {
  const found = { plain: "", html: "", files: [] as { filename: string; mimeType: string; bytes: number }[] };
  if (!payload || depth > 6) return found;
  if (payload.filename) found.files.push({ filename: payload.filename, mimeType: payload.mimeType ?? "", bytes: payload.body?.size ?? 0 });
  else if (payload.mimeType === "text/plain") found.plain = decode(payload.body?.data);
  else if (payload.mimeType === "text/html") found.html = decode(payload.body?.data);
  for (const part of payload.parts ?? []) {
    const inner = gmailBody(part, depth + 1);
    found.plain ||= inner.plain;
    found.html ||= inner.html;
    found.files.push(...inner.files);
  }
  return found;
}

/** Drive's search language, with the owner's words quoted so they cannot change the query. */
export function driveQuery(text: string): string {
  const quoted = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `fullText contains '${quoted}' and trashed = false`;
}

const exportAs: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const readableType = (mime: string): boolean => /^text\/|^application\/(json|xml|csv)/.test(mime);

export class GoogleConnector {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch,
    private readonly signIn: SignIn) {}
  private on(): void { requirePersonal(this.store, this.owner, "google"); }
  private call(url: string, init: RequestInit & { json?: unknown } = {}): Promise<unknown> {
    this.on();
    return signedCall(this.fetcher, this.signIn, "Google", url, init);
  }

  async searchMail(input: unknown) {
    const { query, max } = MailSearchSchema.parse(input);
    const list = z.object({ messages: z.array(z.object({ id: z.string() }).passthrough()).default([]) }).passthrough()
      .parse(await this.call(`${gmail}/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`));
    const meta = "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
    const messages = [];
    for (const { id } of list.messages.slice(0, max)) {
      const message = MessageSchema.parse(await this.call(`${gmail}/messages/${encodeURIComponent(id)}?${meta}`));
      messages.push({ id: message.id, threadId: message.threadId ?? null, from: header(message.payload, "From"),
        subject: header(message.payload, "Subject"), date: header(message.payload, "Date"),
        unread: message.labelIds?.includes("UNREAD") ?? false, snippet: clip(message.snippet ?? "", 300) });
    }
    return { messages, note: outsideTextNote };
  }

  async readMail(input: unknown) {
    const { id } = MailReadSchema.parse(input);
    const message = MessageSchema.parse(await this.call(`${gmail}/messages/${encodeURIComponent(id)}?format=full`));
    const body = gmailBody(message.payload);
    return { id: message.id, threadId: message.threadId ?? null, from: header(message.payload, "From"),
      to: header(message.payload, "To"), subject: header(message.payload, "Subject"), date: header(message.payload, "Date"),
      messageId: header(message.payload, "Message-ID"),
      text: clip(body.plain || stripTags(body.html), 20000), attachments: body.files.slice(0, 50), note: outsideTextNote };
  }

  async draft(input: unknown) {
    const value = DraftSchema.parse(input);
    if (!this.signIn.settings().drafts) throw new Error("Writing drafts is not allowed yet. Allow drafts on the Google card, then sign in again.");
    const raw = Buffer.from(buildPlainMail({ to: value.to, cc: value.cc, subject: value.subject, text: value.text }), "utf8").toString("base64url");
    const made = z.object({ id: z.string() }).passthrough().parse(await this.call(`${gmail}/drafts`, {
      method: "POST", json: { message: { raw, ...(value.threadId ? { threadId: value.threadId } : {}) } } }));
    return { draftId: made.id, sent: false, note: "The draft is in your Gmail drafts. Branch never sends it; you do." };
  }

  async events(input: unknown, now = new Date()) {
    const value = EventsSchema.parse(input);
    const from = value.from ?? now.toISOString();
    const to = value.to ?? new Date(Date.parse(from) + 86_400_000).toISOString();
    const query = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: String(value.max) });
    const Time = z.object({ dateTime: z.string().optional(), date: z.string().optional() }).passthrough().optional();
    const body = z.object({ items: z.array(z.object({ id: z.string(), summary: z.string().optional(), location: z.string().optional(),
      start: Time, end: Time, htmlLink: z.string().optional() }).passthrough()).default([]) }).passthrough()
      .parse(await this.call(`${calendar}?${query}`));
    return { from, to, note: outsideTextNote, events: body.items.map((event) => ({ id: event.id, title: clip(event.summary ?? "(no title)", 200),
      starts: event.start?.dateTime ?? event.start?.date ?? "", ends: event.end?.dateTime ?? event.end?.date ?? "",
      location: clip(event.location ?? "", 200) })) };
  }

  async searchDrive(input: unknown) {
    const { text, max } = DriveSearchSchema.parse(input);
    const query = new URLSearchParams({ q: driveQuery(text), pageSize: String(max), fields: "files(id,name,mimeType,modifiedTime,size)" });
    const body = z.object({ files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(),
      modifiedTime: z.string().optional(), size: z.string().optional() }).passthrough()).default([]) }).passthrough()
      .parse(await this.call(`${drive}?${query}`));
    return { files: body.files.map((f) => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime ?? null,
      bytes: f.size ? Number(f.size) : null })), note: outsideTextNote };
  }

  async readDrive(input: unknown) {
    const { id } = DriveReadSchema.parse(input);
    const meta = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), size: z.string().optional() }).passthrough()
      .parse(await this.call(`${drive}/${encodeURIComponent(id)}?fields=id,name,mimeType,size`));
    const limit = 200_000;
    const exported = exportAs[meta.mimeType];
    let url: string;
    if (exported) url = `${drive}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exported)}`;
    else if (readableType(meta.mimeType)) url = `${drive}/${encodeURIComponent(id)}?alt=media`;
    else throw new Error(`${meta.name} is not a text file or a Google document, so it is not read here.`);
    const text = await signedText(this.fetcher, this.signIn, "Google Drive", url, limit);
    return { id: meta.id, name: meta.name, type: meta.mimeType, text: clip(text, 50000), note: outsideTextNote };
  }
}

export function registerGoogle(registry: Pick<ToolRegistry, "register">, google: GoogleConnector): void {
  const tool = (name: string, permission: string, description: string, parameters: z.ZodType, run: (input: unknown) => Promise<unknown>) =>
    registry.register({ name, permission, description, parameters, execute: async (input) => run(input) });
  tool("gmail.search", "personal.read", "Search the owner's Gmail with Gmail's own search words (from:, subject:, is:unread, newer_than:2d).",
    MailSearchSchema, (input) => google.searchMail(input));
  tool("gmail.read", "personal.read", "Read one message from the owner's Gmail, by the id gmail.search gave.", MailReadSchema, (input) => google.readMail(input));
  // Ships-on sweep (2026-09-26): the rules judge a draft by who it is to.
  registry.register({ name: "gmail.draft", permission: "personal.write", description: "Write a draft in the owner's Gmail. It is never sent; the owner sends it.",
    parameters: DraftSchema, execute: async (input) => google.draft(input), target: (input) => `draft to ${[...input.to, ...input.cc].join(", ")}` });
  tool("gcal.events", "personal.read", "List the events in the owner's Google Calendar between two times (the next day by default).",
    EventsSchema, (input) => google.events(input));
  tool("gdrive.search", "personal.read", "Find files in the owner's Google Drive by the words in them.", DriveSearchSchema, (input) => google.searchDrive(input));
  tool("gdrive.read", "personal.read", "Read a Google document, sheet or text file from the owner's Google Drive.", DriveReadSchema, (input) => google.readDrive(input));
}
