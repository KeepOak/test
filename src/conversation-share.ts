import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Message } from "./contracts.js";
import { secretPatterns } from "./skill-scan.js";

/**
 * Sharing one conversation as a single page. The page is plain HTML with its colours written into
 * it, and it carries no scripts at all, so it can be opened anywhere and can do nothing. Before it
 * is written, a redaction pass blanks out anything that looks like a key, and optionally addresses
 * and long numbers, and the owner is handed a receipt saying exactly what went out and what was
 * held back. A share link is served by this app on this computer only; nothing is ever put online.
 */
export const RedactionSchema = z.object({
  /** Blank out anything that looks like a key, token or password. On by default. */
  secrets: z.boolean().default(true),
  /** Also blank out email addresses, phone-like and card-like numbers. */
  contactDetails: z.boolean().default(false),
  /** Leave out what the assistant's tools returned, keeping only what was said. */
  toolResults: z.boolean().default(false),
}).strict();
export type Redaction = z.infer<typeof RedactionSchema>;
/** Keys are always blanked out; the rest is off unless the owner asks for it. */
export const redactionDefaults = { secrets: true, contactDetails: false, toolResults: false };
export const ShareRequestSchema = z.object({
  sessionId: z.string().uuid(),
  title: z.string().trim().max(120).default(""),
  redact: RedactionSchema.default(redactionDefaults),
}).strict();
export interface ShareReceipt {
  sessionId: string;
  messagesShared: number;
  messagesHeldBack: number;
  secretsRemoved: number;
  contactDetailsRemoved: number;
  createdAt: string;
}
export const removalMarker = "[removed before sharing]";
/**
 * Extra things blanked out only when a conversation is shared. The skill scanner's list is aimed at
 * a file somebody wrote; a conversation also carries chat-app tokens and lines out of a tool's
 * output like `TELEGRAM_BOT_TOKEN=...`, where the name is one word and the scanner's pattern misses
 * it. These stay here so widening them never changes what the skill scanner calls suspicious.
 */
const sharePatterns: RegExp[] = [
  // A Telegram bot token: a handful of digits, a colon, then a long mixed string.
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
  // NAME=value or NAME: value where the name ends in KEY, TOKEN, SECRET, PASSWORD or similar.
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)\b\s*[:=]\s*["']?[A-Za-z0-9_\-/+.:]{8,}/g,
  // A bearer token handed to a website.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];
const contactPatterns: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]?\d{3,4}[ -]?\d{0,4}\b/g,
];

/** Replaces anything that looks like a secret; says how many replacements it made. */
export function redactText(text: string, redact: Redaction): { text: string; secrets: number; contactDetails: number } {
  let out = text, secrets = 0, contactDetails = 0;
  if (redact.secrets) {
    for (const [pattern] of secretPatterns)
      out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"),
        () => { secrets++; return removalMarker; });
    for (const pattern of sharePatterns)
      out = out.replace(pattern, () => { secrets++; return removalMarker; });
  }
  if (redact.contactDetails)
    for (const pattern of contactPatterns)
      out = out.replace(new RegExp(pattern.source, pattern.flags), (match) =>
        /\d/.test(match) && match.replace(/\D/g, "").length < 7 ? match : (contactDetails++, removalMarker));
  return { text: out, secrets, contactDetails };
}

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const speaker: Record<string, string> = { user: "You", assistant: "Assistant", tool: "Tool result", system: "Setup" };
/**
 * The KeepOak colours, written into the page so it needs no stylesheet of its own. Reports use the
 * same look, so a saved report and a shared conversation are plainly the same app's work.
 */
export const pageStyle = `:root{color-scheme:dark}
body{margin:0;background:#03140b;color:#edf1ea;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
h1{font-size:1.5rem;margin:0 0 .25rem}
.meta{color:rgba(237,241,234,.6);font-size:.85rem;margin:0 0 2rem}
article{background:rgba(5,24,15,.94);border:1px solid rgba(236,241,233,.12);border-radius:12px;padding:1rem 1.15rem;margin:0 0 1rem}
article.user{background:rgba(8,30,19,.7)}
h2{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:rgba(237,241,234,.6);margin:0 0 .5rem}
p{margin:0 0 .75rem;white-space:pre-wrap;word-break:break-word}
p:last-child{margin-bottom:0}
.tool{color:rgba(237,241,234,.78);font-size:.9rem}
.notice{border:1px solid rgba(242,197,114,.4);background:rgba(242,197,114,.13);border-radius:10px;padding:.75rem 1rem;margin:0 0 1.5rem;font-size:.9rem}
footer{color:rgba(237,241,234,.6);font-size:.8rem;margin-top:2rem;border-top:1px solid rgba(236,241,233,.12);padding-top:1rem}`;

/**
 * One conversation as a whole page: no scripts, no outside files, colours written in. Tool messages
 * are shown as what came back, never as something to run.
 */
export function shareHtml(
  meta: { sessionId: string; title?: string; createdAt?: string },
  messages: Message[],
  redact: Redaction = RedactionSchema.parse({}),
): { html: string; receipt: ShareReceipt } {
  const title = meta.title?.trim() || "Shared conversation";
  let secrets = 0, contactDetails = 0, shared = 0, heldBack = 0;
  const blocks: string[] = [];
  for (const message of messages.slice(0, 2000)) {
    if (message.role === "system" || (redact.toolResults && message.role === "tool")) { heldBack++; continue; }
    const cleaned = redactText(message.content.slice(0, 20000), redact);
    secrets += cleaned.secrets; contactDetails += cleaned.contactDetails; shared++;
    const used = (message.toolCalls ?? []).map((call) => `<p class="tool">used ${escape(call.name)}</p>`).join("");
    blocks.push(`<article class="${escape(message.role)}"><h2>${escape(speaker[message.role] ?? message.role)}</h2>`
      + `<p>${escape(cleaned.text) || "<em>(no words)</em>"}</p>${used}</article>`);
  }
  const receipt: ShareReceipt = { sessionId: meta.sessionId, messagesShared: shared, messagesHeldBack: heldBack,
    secretsRemoved: secrets, contactDetailsRemoved: contactDetails, createdAt: new Date().toISOString() };
  const notice = secrets + contactDetails > 0
    ? `<p class="notice">${secrets + contactDetails} thing${secrets + contactDetails === 1 ? " was" : "s were"} blanked out of this copy before it was shared.</p>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escape(title)}</title>
<style>${pageStyle}</style></head>
<body><main><h1>${escape(title)}</h1>
<p class="meta">Saved from Branch Agent${meta.createdAt ? ` · started ${escape(meta.createdAt)}` : ""} · ${shared} message${shared === 1 ? "" : "s"}</p>
${notice}${blocks.join("\n")}
<footer>A read-only copy. It cannot run anything and is not connected to the assistant.</footer>
</main></body></html>\n`;
  return { html, receipt };
}

export const ShareLinkSchema = z.object({
  sessionId: z.string().uuid(),
  title: z.string().trim().max(120).default(""),
  /** How long the link works for, in minutes. */
  expiresInMinutes: z.number().int().min(5).max(10080).default(1440),
  redact: RedactionSchema.default(redactionDefaults),
}).strict();
export interface ShareLink {
  id: string; sessionId: string; title: string; expiresAt: string; createdAt: string;
  openedAt: string | null; receipt: ShareReceipt;
}
const hashCode = (code: string, salt: string): string => createHash("sha256").update(`${salt}:${code}`).digest("hex");
/** Wrong codes allowed before a link closes itself, so nobody can sit and guess at it. */
export const maximumCodeAttempts = 5;

/**
 * Read-only links this app serves itself. Each one needs the six-character code shown to the owner
 * once, works one time, and stops working at its expiry. The page is built when the link is made,
 * so opening it never reaches back into the conversation.
 */
export class ShareLinks {
  constructor(private readonly db: DatabaseSync, public now: () => Date = () => new Date()) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_shares(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      session_id TEXT NOT NULL, title TEXT NOT NULL, salt TEXT NOT NULL, code_hash TEXT NOT NULL,
      html TEXT NOT NULL, receipt TEXT NOT NULL, expires_at TEXT NOT NULL, opened_at TEXT,
      created_at TEXT NOT NULL)`);
    if (!db.prepare("PRAGMA table_info(conversation_shares)").all().some((row) => row.name === "attempts"))
      db.exec("ALTER TABLE conversation_shares ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  }
  /** Builds the page now and returns the code once; the code itself is never stored. */
  create(owner: string, input: unknown, messages: Message[], createdAt?: string): ShareLink & { code: string; path: string } {
    const value = ShareLinkSchema.parse(input);
    const { html, receipt } = shareHtml({ sessionId: value.sessionId, title: value.title,
      ...(createdAt ? { createdAt } : {}) }, messages, value.redact);
    const id = randomUUID(), salt = randomBytes(8).toString("hex");
    const code = randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    const at = this.now();
    const expiresAt = new Date(at.getTime() + value.expiresInMinutes * 60000).toISOString();
    this.db.prepare(`INSERT INTO conversation_shares(id,owner,session_id,title,salt,code_hash,html,
      receipt,expires_at,opened_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, owner, value.sessionId, value.title, salt, hashCode(code, salt), html,
        JSON.stringify(receipt), expiresAt, null, at.toISOString());
    return { id, sessionId: value.sessionId, title: value.title, expiresAt, createdAt: at.toISOString(),
      openedAt: null, receipt, code, path: `/share/${id}` };
  }
  /** The links, without their pages: the finished page can be megabytes and is never listed. */
  list(owner: string): ShareLink[] {
    this.prune();
    return this.db.prepare(`SELECT id, session_id, title, receipt, expires_at, opened_at, created_at
      FROM conversation_shares WHERE owner=? ORDER BY created_at DESC LIMIT 200`)
      .all(owner).map((row) => ({ id: String(row.id), sessionId: String(row.session_id), title: String(row.title),
        expiresAt: String(row.expires_at), createdAt: String(row.created_at),
        openedAt: row.opened_at === null ? null : String(row.opened_at),
        receipt: JSON.parse(String(row.receipt)) as ShareReceipt }));
  }
  revoke(owner: string, id: string): { revoked: boolean } {
    return { revoked: this.db.prepare("DELETE FROM conversation_shares WHERE owner=? AND id=?").run(owner, id).changes > 0 };
  }
  /**
   * The page, if the code is right, the link has not expired and it has not been opened before.
   * After five wrong codes the link closes itself, so a six-character code cannot be guessed at.
   */
  open(id: string, code: string): string {
    const row = this.db.prepare("SELECT * FROM conversation_shares WHERE id=?").get(id);
    if (!row) throw new Error("That link is not valid");
    if (Number(row.attempts ?? 0) >= maximumCodeAttempts)
      throw new Error("That link was closed after too many wrong codes");
    const supplied = hashCode(String(code).trim().toUpperCase(), String(row.salt));
    const expected = String(row.code_hash);
    if (!timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) {
      this.db.prepare("UPDATE conversation_shares SET attempts=attempts+1 WHERE id=?").run(id);
      throw new Error("That code is not right");
    }
    if (row.opened_at !== null) throw new Error("That link has already been used once and is now closed");
    // A conversation in Recently Deleted is hidden everywhere, its links too (src/conversation-actions.ts).
    if (this.db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE name='conversation_marks'").get()
      && this.db.prepare("SELECT 1 AS found FROM conversation_marks WHERE session_id=? AND deleted_at IS NOT NULL").get(String(row.session_id)))
      throw new Error("That link is not valid");
    if (String(row.expires_at) <= this.now().toISOString()) throw new Error("That link has expired");
    this.db.prepare("UPDATE conversation_shares SET opened_at=? WHERE id=?").run(this.now().toISOString(), id);
    return String(row.html);
  }
  /** Removes links that expired more than a day ago, so old pages do not linger. */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - 86400000).toISOString();
    return Number(this.db.prepare("DELETE FROM conversation_shares WHERE expires_at<?").run(cutoff).changes);
  }
}
