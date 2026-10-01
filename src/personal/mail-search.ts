import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { z } from "zod";
import { ImapClient, type MailMessage, type MailServer } from "../channels/mail-client.js";
import type { WorkspaceFiles } from "../files.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import type { ConnectionHealth } from "./probe.js";
import { attachmentsOf, mimeParts, textOf } from "./mime.js";
import { clip, outsideTextNote, partSettings, requirePersonal, savePartSettings, secretNameSchema } from "./settings.js";
import { assertHealthCurrent, currentHealthCheck } from "../health-check.js";

/**
 * R17-031: the email channel's inbox, searched and opened on request — who wrote, about what, since
 * when — and the files attached to a message listed and, when asked, saved into the workspace.
 * Nothing is marked read and nothing is sent. The mailbox is the one the email channel answers
 * from, given again here (server, user, and the name of the saved password), so this works whether
 * or not the channel is connected right now. The server is checked against the network rules
 * before every connection, exactly as the channel's own servers are.
 */
export const MailSearchSettingsSchema = z.object({
  host: z.string().trim().regex(/^[A-Za-z0-9.-]{1,253}$/).nullable().default(null),
  port: z.number().int().min(1).max(65535).default(993),
  user: z.string().trim().max(254).default(""),
  passwordName: secretNameSchema.default("EMAIL_PASSWORD"),
  /** Where saved attachments go, inside the workspace. */
  folder: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9 _.-]+(\/[A-Za-z0-9 _.-]+)*$/).default("mail-attachments"),
}).strict();
const settingsKey = "personal-mail-search-settings";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates look like 2026-09-17");
const words = z.string().trim().min(1).max(200).regex(/^[\x20-\x7e]+$/, "Mail servers are searched with plain letters, digits and punctuation");
export const InboxSearchSchema = z.object({
  from: words.optional(), subject: words.optional(), text: words.optional(),
  since: day.optional(), before: day.optional(),
  unread: z.boolean().optional(),
  max: z.number().int().min(1).max(25).default(10),
}).strict();
export const AttachmentsSchema = z.object({ uid: z.number().int().min(1) }).strict();
export const SaveAttachmentSchema = z.object({ uid: z.number().int().min(1), index: z.number().int().min(0).max(99) }).strict();

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-09-17 as IMAP writes it: 17-Sep-2026. */
export function imapDate(value: string): string {
  const [year, month, date] = value.split("-").map(Number) as [number, number, number];
  if (!months[month - 1] || date < 1 || date > 31) throw new Error(`${value} is not a real date`);
  return `${date}-${months[month - 1]}-${year}`;
}
const quote = (value: string): string => `"${value.replace(/([\\"])/g, "\\$1")}"`;

/** IMAP search keys, every word quoted, so nothing the owner or the model typed becomes a command. */
export function searchKeys(input: z.infer<typeof InboxSearchSchema>): string {
  const keys: string[] = [];
  if (input.from) keys.push(`FROM ${quote(input.from)}`);
  if (input.subject) keys.push(`SUBJECT ${quote(input.subject)}`);
  if (input.text) keys.push(`TEXT ${quote(input.text)}`);
  if (input.since) keys.push(`SINCE ${imapDate(input.since)}`);
  if (input.before) keys.push(`BEFORE ${imapDate(input.before)}`);
  if (input.unread !== undefined) keys.push(input.unread ? "UNSEEN" : "SEEN");
  return keys.length ? keys.join(" ") : "ALL";
}

/** A name that is safe as one file in one folder. */
export function safeFileName(name: string, index: number): string {
  const plain = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return plain || `attachment-${index}`;
}

export type MailClient = Pick<ImapClient, "connect" | "close" | "searchUids" | "summary" | "whole"> & Partial<Pick<ImapClient, "abort">>;
export interface MailSearchDeps {
  store: Store;
  owner: string;
  files: WorkspaceFiles;
  secret: (name: string) => Promise<string>;
  /** The owner's network rules for the mail server. */
  assertHost: (host: string, port: number) => Promise<void>;
  imap?: (server: MailServer) => MailClient;
}

export class MailSearch {
  private readonly imap: (server: MailServer) => MailClient;
  constructor(private readonly deps: MailSearchDeps) { this.imap = deps.imap ?? ((server) => new ImapClient(server)); }
  settings() { return partSettings(this.deps.store, this.deps.owner, settingsKey, MailSearchSettingsSchema); }
  save(input: unknown) { return savePartSettings(this.deps.store, this.deps.owner, settingsKey, MailSearchSettingsSchema, input); }

  /** Opens the inbox, does one thing, and always closes it again. */
  private async withInbox<T>(work: (client: MailClient) => Promise<T>, readOnly = false): Promise<T> {
    assertHealthCurrent();
    requirePersonal(this.deps.store, this.deps.owner, "mail-search");
    const settings = this.settings();
    if (!settings.host || !settings.user) throw new Error("Give the mail server and the user name on the inbox card first.");
    await this.deps.assertHost(settings.host, settings.port);
    assertHealthCurrent();
    const password = await this.deps.secret(settings.passwordName);
    assertHealthCurrent();
    const client = this.imap({ host: settings.host, port: settings.port, user: settings.user, password });
    const check = currentHealthCheck();
    const cancel = () => { if (client.abort) client.abort(); else void client.close().catch(() => undefined); };
    check?.signal.addEventListener("abort", cancel, { once: true });
    try {
      assertHealthCurrent();
      await client.connect(readOnly);
      assertHealthCurrent();
      const result = await work(client);
      assertHealthCurrent();
      return result;
    } finally { await client.close().catch(() => undefined); check?.signal.removeEventListener("abort", cancel); }
  }

  /** An authenticated EXAMINE reads inbox metadata only; no search, message fetch or flag writes. */
  async test(): Promise<ConnectionHealth> {
    requirePersonal(this.deps.store, this.deps.owner, "mail-search");
    let ok = false, reason: string | null = null;
    try { await this.withInbox(async () => { ok = true; }, true); }
    catch { assertHealthCurrent(); reason = "Inbox access could not be verified. Check the mail server, network rules and saved credentials."; }
    assertHealthCurrent();
    return { checkedAt: new Date().toISOString(), ok, checks: [{ capability: "IMAP read-only inbox access", ok, reason }] };
  }

  async search(input: unknown) {
    const value = InboxSearchSchema.parse(input);
    const keys = searchKeys(value);
    const found = await this.withInbox(async (client) => {
      const uids = await client.searchUids(keys, value.max);
      const rows: (MailMessage & { uid: number })[] = [];
      for (const uid of uids) rows.push({ ...(await client.summary(uid)), uid });
      return rows;
    });
    return { note: outsideTextNote, messages: found.map((m) => ({ uid: m.uid, from: m.from, name: m.fromName,
      subject: clip(m.subject, 200), snippet: clip(m.text.replace(/\s+/g, " "), 240) })) };
  }

  async open(input: unknown) {
    const { uid } = AttachmentsSchema.parse(input);
    const raw = await this.withInbox((client) => client.whole(uid, 25 * 1024 * 1024));
    const parts = mimeParts(raw);
    return { uid, text: clip(textOf(parts), 20000), attachments: attachmentsOf(parts), note: outsideTextNote };
  }

  async saveAttachment(input: unknown) {
    const { uid, index } = SaveAttachmentSchema.parse(input);
    const raw = await this.withInbox((client) => client.whole(uid, 25 * 1024 * 1024));
    const parts = mimeParts(raw);
    const found = attachmentsOf(parts).find((item) => item.index === index);
    if (!found) throw new Error("That message has no attachment with that number. Use mail.attachments to see them.");
    const target = await this.freePath(`${this.settings().folder}/${safeFileName(found.filename, index)}`);
    const path = await this.deps.files.checkedForWrite(target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, parts[index]!.body, { flag: "wx" });
    return { saved: target, bytes: found.bytes, note: "Saved from somebody else's mail. Open it with care." };
  }

  /** The name itself, or the name with (2), (3)… when a file is already there. */
  private async freePath(wanted: string): Promise<string> {
    const extension = extname(wanted), stem = wanted.slice(0, wanted.length - extension.length);
    for (let n = 1; n <= 50; n++) {
      const candidate = n === 1 ? wanted : `${stem} (${n})${extension}`;
      const taken = await stat(await this.deps.files.checked(candidate)).then(() => true, () => false);
      if (!taken) return candidate;
    }
    throw new Error("There are already fifty files with that name; tidy the folder first.");
  }
}

export function registerMailSearch(registry: Pick<ToolRegistry, "register">, mail: MailSearch): void {
  registry.register({ name: "mail.search", permission: "personal.read",
    description: "Search the email channel's inbox by sender, subject, words, dates, or unread. Nothing is marked read.",
    parameters: InboxSearchSchema, execute: async (input) => mail.search(input) });
  registry.register({ name: "mail.attachments", permission: "personal.read",
    description: "Open one message from the email channel's inbox (by the uid mail.search gave): its text and the files attached to it.",
    parameters: AttachmentsSchema, execute: async (input) => mail.open(input) });
  registry.register({ name: "mail.save_attachment", permission: "files.write",
    description: "Save one attached file from a message in the email channel's inbox into the workspace's mail attachments folder.",
    // mac7/residuals: it writes into the owner's attachments folder, so a folder rule judges it. The
    // file's own name is only known once the message is fetched, so the folder is what is declared.
    target: () => mail.settings().folder,
    parameters: SaveAttachmentSchema, execute: async (input) => mail.saveAttachment(input) });
}
