import { z } from "zod";
import type { Store } from "../store.js";
import type { WebhookNotifier } from "../webhooks.js";
import type { FeatureSwitch } from "./chat-live-settings.js";

/**
 * The delivery ledger: every outbound channel message is written down before it is sent, split
 * into ordered chunks with stable keys, so a message survives an unavailable channel and is sent
 * in order after reconnect. Delivery is at-least-once: a chunk is marked sent only after the chat
 * service took it, so if Branch stops in that moment the chunk is sent again after the restart.
 * A chunk that keeps failing is kept as a dead letter the owner can see and retry.
 */
export const DeliverySchema = z.object({
  key: z.string().min(1).max(200),
  channel: z.string().min(1).max(64),
  chatId: z.string().min(1).max(64),
  seq: z.number().int().min(0),
  /** Position in the queue; later messages never overtake earlier ones. */
  order: z.number().int().min(0).default(0),
  text: z.string().min(1).max(4096),
  replyTo: z.string().max(64).nullable().default(null),
  status: z.enum(["pending", "sent", "dead"]),
  attempts: z.number().int().min(0),
  nextAt: z.string(),
  lastError: z.string().max(500).nullable().default(null),
  messageId: z.string().max(64).nullable().default(null),
  sentAt: z.string().nullable().default(null),
  editedText: z.string().min(1).max(4096).optional(),
  editedAt: z.string().optional(),
  deletedAt: z.string().optional(),
  /** Sent only while whoever asked may still be answered (an inline shortcut's answer); after a restart it stays unsent. */
  gated: z.boolean().optional(),
}).strict();
export type Delivery = z.infer<typeof DeliverySchema> & { id: string; createdAt: string; updatedAt: string };
export type Sender = (chatId: string, text: string, replyTo?: string) => Promise<string | undefined>;

export const chunkLimit = 3500;
export const maxAttempts = 5;
const keepSentDays = 7;

/**
 * Splits long text so every chunk fits a channel message. Channels with a shorter message limit
 * than the default (Discord allows 2000 characters) pass their own limit.
 *
 * `splitting` is the owner's switch (see chat-live-settings.ts). Off, text is cut at the last line
 * break or space, as it always was. On, a paragraph break is the first choice, then a line break,
 * then a space, and a block of code is never left open: when a cut has to fall inside one, the
 * chunk closes it and the next chunk opens it again with the same fence, so each message still
 * shows code as code, keeping the indentation of the line it starts with. "When needed" does that
 * only for text that contains a code fence.
 */
export function chunkText(text: string, limit = chunkLimit, splitting: FeatureSwitch = "off"): string[] {
  const careful = splitting === "on" || (splitting === "when-needed" && /^ {0,3}(```|~~~)/m.test(text));
  return careful ? chunkCarefully(text, limit) : chunkPlainly(text, limit);
}
function chunkPlainly(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length || !chunks.length) chunks.push(rest || "(empty message)");
  return chunks;
}
function chunkCarefully(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  // Room for the closing fence a chunk may need. Below 200 characters a reopened fence could eat
  // the progress a cut makes, so such tiny limits split as plain text.
  const fences = limit >= 200;
  while (rest.length > limit) {
    const at = cutAt(rest, fences ? limit - fenceRoom : limit, fences);
    const open = fences ? openFenceAt(rest, at) : null;
    if (open) {
      chunks.push(`${rest.slice(0, at).trimEnd()}\n${open.close}`);
      rest = `${open.line}\n${rest.slice(at).replace(/^\r?\n/, "")}`;
    } else {
      chunks.push(rest.slice(0, at).trimEnd());
      rest = rest.slice(at).trimStart();
    }
  }
  if (rest.length || !chunks.length) chunks.push(rest || "(empty message)");
  return chunks;
}
/** The longest fence line a split adds to either side: a newline, a marker and a short language. */
const fenceRoom = 30;
const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** Where to cut `text` so the first piece is at most `limit` long, preferring the gentlest break. */
function cutAt(text: string, limit: number, fences: boolean): number {
  const window = text.slice(0, limit);
  const half = limit / 2;
  const inCode = (index: number) => fences && openFenceAt(text, index) !== null;
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph > half && !inCode(paragraph)) return paragraph;
  const line = window.lastIndexOf("\n");
  if (line > half) return line;
  const space = window.lastIndexOf(" ");
  if (space > half && !inCode(space)) return space;
  return limit;
}
/**
 * The fence still open at `index`, if any: the line to open it again with (marker and language,
 * kept short) and the marker that closes it. A closing fence uses the same character and is at
 * least as long as the opening one, as CommonMark has it.
 */
export function openFenceAt(text: string, index: number): { line: string; close: string } | null {
  let open: { marker: string; info: string } | null = null;
  let position = 0;
  for (const row of text.split("\n")) {
    if (position >= index) break;
    const match = fenceLine.exec(row.replace(/\r$/, ""));
    position += row.length + 1;
    if (!match) continue;
    const marker = match[1]!, info = match[2]!.trim();
    if (!open) open = { marker, info };
    else if (!info && marker[0] === open.marker[0] && marker.length >= open.marker.length) open = null;
  }
  if (!open) return null;
  const language = (open.info.split(/\s+/)[0] ?? "").slice(0, Math.max(0, fenceRoom - open.marker.length - 2));
  return { line: `${open.marker}${language}`, close: open.marker };
}
/** Retry delay after `attempts` failures: 5 s, 10 s, 20 s, 40 s ... capped at ten minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(600000, 5000 * 2 ** Math.max(0, attempts - 1));
}

export class Deliveries {
  private next: number | undefined;
  /** The live check for each gated message, by key. Kept in memory only, so a gated row never outlives the process. */
  private readonly gates = new Map<string, () => boolean>();
  /** Announces a given-up chunk to outbound webhooks; a no-op until `createBranch` connects them. */
  notifyEvent: WebhookNotifier = () => undefined;
  /**
   * Wave 6: when the owner's quiet hours are on, this says the moment they end, and new messages
   * wait until then instead of arriving in the night. Nothing is held until it is connected.
   */
  holdUntil: (at: Date) => string | null = () => null;
  /** The owner's switch for careful splitting; the router connects it. Off until then. */
  splitting: () => FeatureSwitch = () => "off";
  constructor(private readonly store: Store, private readonly owner: string, public now: () => Date = () => new Date()) {}
  private nextOrder(): number {
    this.next ??= this.list().reduce((max, d) => Math.max(max, d.order + 1), 0);
    return this.next++;
  }
  /** Records the chunks of one message; a key seen before is not queued again. */
  enqueue(channel: string, chatId: string, text: string, key: string, replyTo?: string, limit?: number, allowed?: () => boolean): Delivery[] {
    if (allowed) this.gates.set(key, allowed);
    const chunks = chunkText(text, Math.min(limit ?? chunkLimit, chunkLimit), this.splitting());
    const rows: Delivery[] = [];
    const held = this.holdUntil(this.now());
    for (const [seq, chunk] of chunks.entries()) {
      const id = `${key}#${seq}`;
      const existing = this.get(id);
      if (existing) { rows.push(existing); continue; }
      const data = DeliverySchema.parse({ key, channel, chatId, seq, order: this.nextOrder(), text: chunk, replyTo: seq === 0 ? replyTo ?? null : null,
        status: "pending", attempts: 0, nextAt: held ?? this.now().toISOString(), ...(allowed ? { gated: true } : {}) });
      rows.push(this.save(id, data));
    }
    return rows;
  }
  /**
   * Sends what is due on one channel, chat by chat and in order. A failure stops that chat for
   * now so later chunks never overtake earlier ones; the fifth failure parks the chunk as dead.
   */
  async flush(channel: string, send: Sender): Promise<{ sent: number; failed: number; dead: number }> {
    const due = this.now().toISOString();
    const totals = { sent: 0, failed: 0, dead: 0 };
    const byChat = new Map<string, Delivery[]>();
    for (const row of this.list().filter((d) => d.channel === channel && d.status === "pending"))
      byChat.set(row.chatId, [...(byChat.get(row.chatId) ?? []), row]);
    for (const rows of byChat.values()) {
      rows.sort((a, b) => a.order - b.order);
      if (rows[0]!.nextAt > due) continue;
      for (const row of rows) {
        // Checked right before sending: an answer whoever asked may no longer have is held back, not sent late.
        if (row.gated && !this.gates.get(row.key)?.()) {
          this.save(row.id, { ...this.data(row), status: "dead", lastError: "Held back: the chat may no longer be answered" });
          continue;
        }
        const outcome = await this.attempt(row, send);
        totals[outcome]++;
        if (outcome !== "sent") break;
      }
    }
    this.prune();
    const waiting = new Set(this.list().filter((d) => d.status === "pending").map((d) => d.key));
    for (const key of [...this.gates.keys()]) if (!waiting.has(key)) this.gates.delete(key);
    return totals;
  }
  private async attempt(row: Delivery, send: Sender): Promise<"sent" | "failed" | "dead"> {
    try {
      const messageId = await send(row.chatId, row.text, row.replyTo ?? undefined);
      this.save(row.id, { ...this.data(row), status: "sent", messageId: messageId ?? null, sentAt: this.now().toISOString(), lastError: null });
      return "sent";
    } catch (error) {
      const attempts = row.attempts + 1, dead = attempts >= maxAttempts;
      const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.save(row.id, { ...this.data(row), status: dead ? "dead" : "pending", attempts, lastError,
        nextAt: new Date(this.now().getTime() + backoffMs(attempts)).toISOString() });
      if (dead) this.notifyEvent("delivery.failed", { deliveryId: row.id, channel: row.channel, chatId: row.chatId, attempts, error: lastError });
      return dead ? "dead" : "failed";
    }
  }
  /**
   * Writes down a reply that already reached the chat another way (the live progress message was
   * edited into it), so the ledger still shows it and a repeat of the same key sends nothing.
   */
  recordSent(channel: string, chatId: string, text: string, key: string, messageId: string, replyTo?: string): Delivery {
    const id = `${key}#0`;
    const existing = this.get(id);
    if (existing) return existing;
    const at = this.now().toISOString();
    return this.save(id, DeliverySchema.parse({ key, channel, chatId, seq: 0, order: this.nextOrder(), text: text.slice(0, 4096) || "(empty message)",
      replyTo: replyTo ?? null, status: "sent", attempts: 0, nextAt: at, messageId, sentAt: at }));
  }
  /** Puts a dead or waiting chunk back at the front of the line. */
  retry(id: string): Delivery {
    const row = this.get(id);
    if (!row) throw new Error("No such delivery");
    if (row.status === "sent") throw new Error("That message was already sent");
    return this.save(id, { ...this.data(row), status: "pending", attempts: 0, nextAt: this.now().toISOString(), lastError: null });
  }
  /** Chunks that are waiting or gave up, oldest first. */
  outstanding(): Delivery[] {
    return this.list().filter((d) => d.status !== "sent").sort((a, b) => a.order - b.order);
  }
  list(): Delivery[] {
    return this.store.list("deliveries", this.owner).flatMap((record) => {
      const parsed = DeliverySchema.safeParse(record.data);
      return parsed.success ? [{ ...parsed.data, id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt }] : [];
    });
  }
  /** Preserve the original send and its deduplication key after a confirmed remote edit or deletion. */
  recordMessageAction(id: string, action: "edit" | "delete", text?: string): Delivery {
    const row = this.get(id);
    if (!row || row.status !== "sent" || !row.messageId || row.deletedAt) throw new Error("That own sent message is unavailable or already deleted.");
    const at = this.now().toISOString();
    return this.save(id, DeliverySchema.parse({ ...this.data(row), ...(action === "edit"
      ? { editedText: text, editedAt: at } : { deletedAt: at }) }));
  }
  private get(id: string): Delivery | undefined {
    const record = this.store.get("deliveries", this.owner, id);
    const parsed = record && DeliverySchema.safeParse(record.data);
    return parsed && parsed.success ? { ...parsed.data, id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt } : undefined;
  }
  private save(id: string, data: z.infer<typeof DeliverySchema>): Delivery {
    const record = this.store.save("deliveries", this.owner, id, data);
    return { ...data, id, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }
  private data(row: Delivery): z.infer<typeof DeliverySchema> {
    const { id, createdAt, updatedAt, ...data } = row;
    void id; void createdAt; void updatedAt;
    return data;
  }
  private prune(): void {
    const cutoff = new Date(this.now().getTime() - keepSentDays * 86400000).toISOString();
    for (const row of this.list()) if (row.status === "sent" && (row.sentAt ?? row.updatedAt) < cutoff) this.store.delete("deliveries", this.owner, row.id);
  }
}
