import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import { mimeParts, textOf } from "../personal/mime.js";

/**
 * Just enough IMAP and SMTP, over Node's own TLS, to read new mail and answer it: no library, no
 * mailbox syncing. The IMAP side logs in, opens the inbox, asks which messages are unread, fetches
 * their headers and text, and marks them read; the text is read through src/personal/mime.ts, so a
 * formatted or multipart message gives its words and its attached files. The SMTP side sends one
 * message, threading it onto the one it answers, with any files attached.
 */
export interface MailServer {
  host: string;
  port: number;
  user: string;
  password: string;
  /**
   * true (the default) connects with TLS from the start, which is what a hosted mailbox needs.
   * false connects in the clear and upgrades with STARTTLS when the server offers it, which is
   * only sensible for a mail server on this computer or on the same network.
   */
  tls?: boolean;
  /** Set only in tests, where the fake server has a self-signed certificate. */
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}
export interface MailMessage {
  /** The IMAP sequence number, only meaningful while the mailbox stays open. */
  seq: number;
  from: string;
  fromName: string;
  subject: string;
  messageId: string;
  references: string;
  text: string;
  /** First Authentication-Results header, in receiving-server order; later copies are untrusted. */
  authenticationResults?: string;
  /** Files attached to the message, at most `maxMailFiles` of them, already decoded. */
  attachments?: MailFile[];
}
/** One attached file, in or out. */
export interface MailFile { name: string; mediaType: string; bytes: Uint8Array }
export const maxMailFiles = 10;

/** A socket that speaks in lines and can be read until a caller-chosen point. */
class LineSocket {
  private buffer = "";
  private waiting: (() => void) | undefined;
  private failure: Error | undefined;
  constructor(private socket: Socket | TLSSocket) { this.listen(); }
  private listen(): void {
    // One character per byte: IMAP counts a literal in bytes, so reading UTF-8 here made any message with accents or
    // emoji overrun its literal and the inbox wait forever (CHAT-003). Literal contents are decoded where they are read.
    this.socket.setEncoding("latin1");
    this.socket.on("data", (chunk: string) => { this.buffer += chunk; this.waiting?.(); });
    this.socket.on("error", (error: Error) => { this.failure = error; this.waiting?.(); });
    this.socket.on("close", () => { this.failure ??= new Error("The mail server closed the connection"); this.waiting?.(); });
  }
  send(line: string): void { this.socket.write(line + "\r\n"); }
  write(raw: string): void { this.socket.write(raw); }
  /** Waits until `end` finds a stopping point in what has arrived, then hands back that much. */
  async until(end: (text: string) => number | null, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = end(this.buffer);
      if (at !== null) { const taken = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at); return taken; }
      if (this.failure) throw this.failure;
      if (Date.now() > deadline) throw new Error("The mail server did not answer in time");
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now())));
      });
    }
  }
  /** Swaps the plain socket for an encrypted one after STARTTLS. */
  async upgrade(server: MailServer): Promise<void> {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("close");
    const secure = tlsConnect({ socket: this.socket, servername: server.host, rejectUnauthorized: server.rejectUnauthorized ?? true });
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    this.socket = secure;
    this.buffer = "";
    this.listen();
  }
  close(): void { this.socket.destroy(); }
}
/**
 * Opens the connection, giving up on a server that never answers. Without this bound a mail host
 * that swallows the connection would hold up every later look at the inbox for good.
 */
async function open(server: MailServer, secure: boolean): Promise<LineSocket> {
  const socket = secure
    ? tlsConnect({ host: server.host, port: server.port, servername: server.host, rejectUnauthorized: server.rejectUnauthorized ?? true })
    : netConnect({ host: server.host, port: server.port });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${server.host} did not answer in time`)); }, server.timeoutMs ?? 20000);
    socket.once(secure ? "secureConnect" : "connect", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); });
  });
  return new LineSocket(socket);
}

/**
 * Finds where a tagged IMAP response ends, stepping over literal blocks ("{123}" followed by that
 * many bytes) so text inside a message is never mistaken for the end of the answer.
 */
export function taggedEnd(text: string, tag: string): number | null {
  let at = 0;
  while (at < text.length) {
    const eol = text.indexOf("\r\n", at);
    if (eol === -1) return null;
    const line = text.slice(at, eol);
    at = eol + 2;
    const literal = /\{(\d+)\}$/.exec(line);
    if (literal) { at += Number(literal[1]); if (at > text.length) return null; continue; }
    if (line.startsWith(tag + " ")) return at;
  }
  return null;
}

/** One IMAP conversation: log in, read what is unread, mark it read, log out. */
export class ImapClient {
  private socket: LineSocket | undefined;
  private counter = 0;
  constructor(private readonly server: MailServer) {}
  private get timeout(): number { return this.server.timeoutMs ?? 20000; }
  async connect(readOnly = false): Promise<void> {
    this.socket = await open(this.server, this.server.tls !== false);
    await this.socket.until((text) => (text.includes("\r\n") ? text.indexOf("\r\n") + 2 : null), this.timeout);
    await this.command(`LOGIN ${quote(this.server.user)} ${quote(this.server.password)}`);
    const mailbox = await this.command(readOnly ? "EXAMINE INBOX" : "SELECT INBOX");
    // RFC 9051 §6.3.3: EXAMINE returns metadata and must confirm a read-only mailbox.
    if (readOnly && !/^b\d+ OK \[READ-ONLY\]/im.test(mailbox))
      throw new Error("The mail server did not confirm a read-only inbox.");
  }
  /** Reads every unread message, marks each read, and returns what was found. */
  async unread(limit = 10): Promise<MailMessage[]> {
    const search = await this.command("SEARCH UNSEEN");
    const ids = (/^\* SEARCH([\d ]*)/m.exec(search)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number).slice(0, limit);
    const messages: MailMessage[] = [];
    for (const seq of ids) {
      const raw = await this.command(`FETCH ${seq} (BODY.PEEK[HEADER] BODY.PEEK[TEXT])`);
      messages.push(parseFetched(seq, raw));
      await this.command(`STORE ${seq} +FLAGS (\\Seen)`);
    }
    return messages;
  }
  /**
   * mac6/bucket-23 (A0612): the messages after a known UID, oldest first, without marking them read.
   * UIDs only grow within a mailbox, so the highest one seen is a cursor that never repeats an item.
   */
  async sinceUid(uid: number, limit = 20): Promise<(MailMessage & { uid: number })[]> {
    const search = await this.command(`UID SEARCH UID ${Math.max(1, Math.floor(uid) + 1)}:*`);
    const uids = (/^\* SEARCH([\d ]*)/m.exec(search)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number)
      .filter((found) => found > uid).sort((a, b) => a - b).slice(0, limit);
    const messages: (MailMessage & { uid: number })[] = [];
    for (const found of uids) {
      const raw = await this.command(`UID FETCH ${found} (BODY.PEEK[HEADER] BODY.PEEK[TEXT])`);
      messages.push({ ...parseFetched(0, raw), uid: found });
    }
    return messages;
  }
  // ---- R17-C (R17-031): searching the inbox and reading a whole message, never marking it read.
  /** UIDs matching search keys already built and quoted by src/personal/mail-search.ts, newest first. */
  async searchUids(keys: string, limit = 20): Promise<number[]> {
    if (/[\r\n]/.test(keys)) throw new Error("A search cannot contain a line break");
    const found = await this.command(`UID SEARCH ${keys}`);
    return (/^\* SEARCH([\d ]*)/m.exec(found)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number)
      .sort((a, b) => b - a).slice(0, limit);
  }
  /** One message's headers and the start of its text, by UID. */
  async summary(uid: number): Promise<MailMessage> {
    return parseFetched(0, await this.command(`UID FETCH ${Math.floor(uid)} (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.2000>)`));
  }
  /** The whole message as the server holds it, refused when it is larger than `maxBytes`. */
  async whole(uid: number, maxBytes: number): Promise<string> {
    const sized = await this.command(`UID FETCH ${Math.floor(uid)} (RFC822.SIZE)`);
    const size = Number(/RFC822\.SIZE (\d+)/.exec(sized)?.[1] ?? NaN);
    if (!Number.isFinite(size)) throw new Error("The mail server has no message with that number");
    if (size > maxBytes) throw new Error(`That message is ${Math.ceil(size / 1048576)} MB, larger than Branch will open`);
    const raw = await this.command(`UID FETCH ${Math.floor(uid)} (BODY.PEEK[])`);
    const literal = /\{(\d+)\}\r\n/.exec(raw);
    return literal ? fromBytes(raw.slice(literal.index + literal[0].length, literal.index + literal[0].length + Number(literal[1]))) : "";
  }
  // ---- end R17-C ----
  async close(): Promise<void> {
    try { await this.command("LOGOUT"); } catch { /* the server may hang up first, which is fine */ }
    this.socket?.close();
    this.socket = undefined;
  }
  private async command(text: string): Promise<string> {
    if (!this.socket) throw new Error("The mail connection is not open");
    const tag = `b${++this.counter}`;
    this.socket.send(`${tag} ${text}`);
    const answer = await this.socket.until((buffer) => taggedEnd(buffer, tag), this.timeout);
    const status = new RegExp(`^${tag} (OK|NO|BAD)(.*)$`, "m").exec(answer);
    // The command name is kept out of the error so a password never reaches a log.
    if (!status || status[1] !== "OK") throw new Error(`The mail server refused ${text.split(" ")[0]}:${(status?.[2] ?? "").slice(0, 120)}`);
    return answer;
  }
}
/** A literal as read off the socket (one character per byte) back to the UTF-8 text it carries. */
const fromBytes = (bytes: string) => Buffer.from(bytes, "latin1").toString("utf8");
const quote = (value: string) => `"${value.replace(/([\\"])/g, "\\$1")}"`;

/** Preserve duplicate-header order and unfold continuation lines before interpreting any identity. */
function mailHeaders(raw: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) break;
    if (/^[ \t]/.test(line) && current) { current[current.length - 1] += ` ${line.trim()}`; continue; }
    const field = /^([a-zA-Z0-9-]+):[ \t]*(.*)$/.exec(line);
    current = undefined;
    if (!field) continue;
    const name = field[1]!.toLowerCase();
    current = fields.get(name) ?? [];
    current.push(field[2]!.trim());
    fields.set(name, current);
  }
  return fields;
}

/**
 * Splits one FETCH answer into the headers we thread on and the plain text body. Each part is found by its name: a
 * server may answer the items in any order (RFC 3501 7.4.2), and GreenMail sends the text first about half the time,
 * which read the headers as the message and dropped it (found by tests/real-chat.test.mjs, CHAT-003).
 */
export function parseFetched(seq: number, raw: string): MailMessage {
  // Literals are stepped over, so a subject or body that spells "BODY[TEXT] {5}" cannot pose as a part.
  const literals: Record<string, string> = {};
  const literal = /(BODY\[(HEADER|TEXT)\](?:<\d+>)? )?\{(\d+)\}\r\n/g;
  for (let match = literal.exec(raw); match; match = literal.exec(raw)) {
    const start = match.index + match[0].length, end = start + Number(match[3]);
    if (match[2] && literals[match[2]] === undefined) literals[match[2]] = fromBytes(raw.slice(start, end));
    literal.lastIndex = end;
  }
  const headers = literals.HEADER ?? "";
  const body = literals.TEXT ?? "";
  const fields = mailHeaders(headers);
  const header = (name: string) => fields.get(name.toLowerCase())?.[0] ?? "";
  const from = header("From");
  const candidate = /^(?:[^<>]*)<([^<>\s]+)>\s*$/.exec(from)?.[1] ?? from.trim();
  // Ambiguous senders cannot become a paired identity. Full RFC mailbox syntax is deliberately not guessed.
  const address = (from.length <= 2048 && fields.get("from")?.length === 1 && /^[^\s<>(),;"@]+@[^\s<>(),;"@]+$/.test(candidate)
    && (from.match(/@/g)?.length === 1)) ? candidate : "";
  // The body is read with the message's own headers, so a formatted, encoded or multipart message gives its words and its files.
  const parts = mimeParts(`${headers.split(/\r?\n\r?\n/)[0]}\r\n\r\n${body}`);
  const attachments = parts.filter((part) => part.filename || part.disposition === "attachment").slice(0, maxMailFiles)
    .map((part, index) => ({ name: part.filename || `attachment-${index + 1}`, mediaType: part.contentType, bytes: new Uint8Array(part.body) }));
  return {
    seq, from: address.toLowerCase(), fromName: from.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || address,
    subject: header("Subject"), messageId: header("Message-ID"), references: header("References"),
    text: textOf(parts).replace(/\r\n/g, "\n").trim(),
    authenticationResults: header("Authentication-Results"),
    ...(attachments.length ? { attachments } : {}),
  };
}

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  messageId: string;
  date?: Date;
  /** Files to attach; the message then goes as multipart/mixed with the words first. */
  attachments?: MailFile[];
}
/** Sends one message and hangs up. */
export async function sendMail(server: MailServer, mail: OutgoingMail): Promise<void> {
  const implicit = server.tls !== false;
  const socket = await open(server, implicit);
  const timeout = server.timeoutMs ?? 20000;
  const expect = async (codes: string[]) => {
    const answer = await socket.until(finishedReply, timeout);
    if (!codes.some((code) => answer.startsWith(code))) throw new Error(`The mail server answered ${answer.slice(0, 80).trim()}`);
    return answer;
  };
  try {
    await expect(["220"]);
    socket.send("EHLO branch-agent");
    const greeting = await expect(["250"]);
    // On a plain connection, encrypt as soon as the server says it can.
    if (!implicit && /STARTTLS/i.test(greeting)) {
      socket.send("STARTTLS");
      await expect(["220"]);
      await socket.upgrade(server);
      socket.send("EHLO branch-agent");
      await expect(["250"]);
    }
    await authenticate(socket, server, expect);
    socket.send(`MAIL FROM:<${mail.from}> BODY=8BITMIME`);
    await expect(["250"]);
    socket.send(`RCPT TO:<${mail.to}>`);
    await expect(["250", "251"]);
    socket.send("DATA");
    await expect(["354"]);
    socket.write(messageBody(mail));
    await expect(["250"]);
    socket.send("QUIT");
  } finally { socket.close(); }
}
/** An SMTP reply ends at the first line whose code is followed by a space rather than a dash. */
function finishedReply(text: string): number | null {
  let at = 0;
  while (at < text.length) {
    const eol = text.indexOf("\r\n", at);
    if (eol === -1) return null;
    if (/^\d{3} /.test(text.slice(at, eol))) return eol + 2;
    at = eol + 2;
  }
  return null;
}
async function authenticate(socket: LineSocket, server: MailServer, expect: (codes: string[]) => Promise<string>): Promise<void> {
  const plain = Buffer.from(`\0${server.user}\0${server.password}`, "utf8").toString("base64");
  socket.send(`AUTH PLAIN ${plain}`);
  try { await expect(["235"]); return; } catch { /* some servers only offer AUTH LOGIN */ }
  socket.send("AUTH LOGIN");
  await expect(["334"]);
  socket.send(Buffer.from(server.user, "utf8").toString("base64"));
  await expect(["334"]);
  socket.send(Buffer.from(server.password, "utf8").toString("base64"));
  await expect(["235"]);
}
/** Builds the message, protecting any line that starts with a dot from ending the transmission. */
export function messageBody(mail: OutgoingMail): string {
  const headers = [
    `From: ${mail.from}`, `To: ${mail.to}`, `Subject: ${mail.subject}`,
    `Date: ${(mail.date ?? new Date()).toUTCString()}`, `Message-ID: ${mail.messageId}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`] : []),
    ...(mail.references ? [`References: ${mail.references}`] : []),
    "MIME-Version: 1.0",
  ];
  const words = mail.text.replace(/\r?\n/g, "\r\n");
  const plain = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"];
  let body: string;
  if (!mail.attachments?.length) { headers.push(...plain); body = words; } else {
    const boundary = `branch-${randomUUID()}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    body = [`--${boundary}`, ...plain, "", words, ...mail.attachments.flatMap((file) => [`--${boundary}`, ...fileHeaders(file), "",
      Buffer.from(file.bytes).toString("base64").replace(/.{76}/g, "$&\r\n").replace(/\r\n$/, "")]), `--${boundary}--`].join("\r\n");
  }
  return `${headers.join("\r\n")}\r\n\r\n${body.replace(/^\./gm, "..")}\r\n.\r\n`;
}
/** An attachment's own headers: its type checked, its name quoted plainly or, when it is not plain ASCII, as RFC 2231 says. */
function fileHeaders(file: MailFile): string[] {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.mediaType) ? file.mediaType : "application/octet-stream";
  const cleaned = file.name.replace(/[\u0000-\u001f"\\]+/g, "_").slice(0, 150) || "file";
  const name = /^[\x20-\x7e]*$/.test(cleaned) ? `filename="${cleaned}"` : `filename*=UTF-8''${encodeURIComponent(cleaned)}`;
  return [`Content-Type: ${type}`, `Content-Disposition: attachment; ${name}`, "Content-Transfer-Encoding: base64"];
}
