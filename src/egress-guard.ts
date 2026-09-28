import { detectPii } from "./pii.js";

/**
 * What a task can carry out in the addresses it opens. The network rules judge where a request goes, never what the
 * address itself says, so a task that may only open pages can still move data out: a secret or a card number in a
 * query string, or a file cut into small pieces, each piece put into a new address on one site or into a short link.
 *
 * This guard reads each address a task asks for:
 * - a value from the owner's locker (whole, a piece of eight characters or more, or base64/hex encoded) or a card,
 *   IBAN or national id number in the address is put to the owner as a question every time, whatever the rules say;
 * - many different addresses on one site in a minute, or making short links, are written into the task's record, and
 *   past a limit the task is refused until the minute has passed.
 * It is cheap by design: string checks on one address, and a small count per task.
 */
export const shortenerHosts: ReadonlySet<string> = new Set([
  "bit.ly", "bitly.com", "tinyurl.com", "is.gd", "v.gd", "t.ly", "tiny.cc", "cutt.ly", "rebrand.ly", "ow.ly", "shorturl.at",
  "rb.gy", "s.id", "t2m.io", "bl.ink", "short.io", "clck.ru", "u.nu", "shorte.st", "goo.gl", "buff.ly", "tiny.one", "x.gd",
  "da.gd", "kutt.it", "snip.ly", "soo.gd", "shorturl.com", "tny.im", "chilp.it", "qr.ae", "lnk.to",
]);
/** A secret is looked for in pieces this long, so a value cut into chunks is still recognised. */
const pieceLength = 8;
const windowMs = 60_000;

export interface EgressLimits {
  /** Different addresses on one site within a minute before the task's record says so. */
  burstNote: number;
  /** Different addresses on one site within a minute before the task is refused until the minute has passed. */
  burstLimit: number;
  /** Short links a task may make before it is refused. */
  shortLinks: number;
}
export const defaultEgressLimits: EgressLimits = { burstNote: 12, burstLimit: 30, shortLinks: 3 };

export interface EgressVerdict {
  /** Put to the owner as a question before the address is opened (never answered by a standing yes). */
  ask: string | null;
  /** The task may not open the address now, in plain words. */
  refuse: string | null;
}
type Record_ = (runId: string, kind: string, detail: Record<string, unknown>) => void;

export class EgressGuard {
  /** The secret values this launch has unlocked; set by the launch (src/index.ts). */
  secrets: () => readonly string[] = () => [];
  limits: EgressLimits = defaultEgressLimits;
  now: () => number = Date.now;
  private readonly seen = new Map<string, Map<string, Map<string, number>>>();
  private readonly shortLinks = new Map<string, number>();
  private readonly told = new Set<string>();
  constructor(private readonly record: Record_) {}

  /** The verdict for one address a task asks to open. Counting is per task and per site. */
  check(runId: string | undefined, address: string): EgressVerdict {
    let url: URL;
    try { url = new URL(address); } catch { return { ask: null, refuse: null }; }
    if (!/^https?:$/.test(url.protocol)) return { ask: null, refuse: null };
    const carried = carriedData(address, this.secrets());
    if (carried && runId) this.note(runId, "egress.flagged", { kind: "data", host: url.hostname, carries: carried }, false);
    const refuse = runId ? this.count(runId, url) : null;
    return { ask: carried, refuse };
  }
  /** Forgets a finished task's counts. */
  forget(runId: string): void {
    this.seen.delete(runId);
    this.shortLinks.delete(runId);
  }
  private count(runId: string, url: URL): string | null {
    const host = url.hostname.toLowerCase(), now = this.now();
    if (makesShortLink(url)) {
      const made = (this.shortLinks.get(runId) ?? 0) + 1;
      this.shortLinks.set(runId, made);
      this.note(runId, "egress.flagged", { kind: "short-link", host, made }, false);
      if (made > this.limits.shortLinks)
        return `This task has asked to make ${made} short links. Short links are a way to carry data out a piece at a time, so it was stopped here. Ask the owner if this is really wanted.`;
    }
    const sites = this.seen.get(runId) ?? new Map<string, Map<string, number>>();
    this.seen.set(runId, sites);
    const addresses = sites.get(host) ?? new Map<string, number>();
    sites.set(host, addresses);
    for (const [seen, at] of addresses) if (now - at > windowMs) addresses.delete(seen);
    const key = url.pathname + url.search;
    if (!addresses.has(key) && addresses.size >= this.limits.burstLimit)
      return `This task has opened ${addresses.size} different addresses on ${host} within a minute. Many small addresses are a way to carry data out, so no more are opened there until the minute has passed.`;
    addresses.set(key, now);
    if (addresses.size >= this.limits.burstNote)
      this.note(runId, "egress.flagged", { kind: "burst", host, addresses: addresses.size, withinMs: windowMs }, true);
    return null;
  }
  private note(runId: string, kind: string, detail: Record<string, unknown>, once: boolean): void {
    const key = JSON.stringify([runId, detail.kind, detail.host]);
    if (once && this.told.has(key)) return;
    if (this.told.size > 2000) this.told.clear();
    this.told.add(key);
    try { this.record(runId, kind, detail); } catch { /* the record never stops the task */ }
  }
}

/** Whether an address asks a link shortener to make a link (following one somebody made is ordinary). */
export function makesShortLink(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!shortenerHosts.has(host)) return false;
  const carriesAddress = /https?(?::|%3A)/i.test(url.search) || /https?(?::|%3A)/i.test(url.pathname.slice(1));
  return carriesAddress || /(?:^|\/)(?:api|create|shorten|links?|new)(?:[./-]|$)/i.test(url.pathname);
}

/** What private data an address carries, said without the data itself, or null. */
export function carriedData(address: string, secrets: readonly string[]): string | null {
  const texts = readings(address);
  if (secrets.some((secret) => secret.length >= pieceLength && texts.some((text) => holdsPiece(text, secret))))
    return "a value from your locker";
  const found = texts.flatMap((text) => detectPii(text, ["card", "iban", "national-id"]));
  if (found.length) return `a ${found[0]!.kind === "card" ? "card number" : found[0]!.kind === "iban" ? "bank account number" : "national id number"}`;
  return null;
}
function holdsPiece(text: string, secret: string): boolean {
  if (text.includes(secret)) return true;
  for (let at = 0; at + pieceLength <= secret.length; at++) if (text.includes(secret.slice(at, at + pieceLength))) return true;
  return false;
}
/** The address as sent, decoded, and every part of it that decodes from base64 or hex to readable text. */
function readings(address: string): string[] {
  const decoded = decodeAll(address);
  const tokens = decoded.split(/[^A-Za-z0-9+_-]+/).filter((token) => token.length >= 12);
  const extra = tokens.flatMap((token) => [fromBase64(token), fromHex(token)]).filter((text): text is string => text !== null);
  return [address, decoded, ...extra];
}
function decodeAll(text: string): string {
  let plain = text.replace(/\+/g, " ");
  for (let round = 0; round < 3 && /%[0-9a-f]{2}/i.test(plain); round++) {
    try { plain = decodeURIComponent(plain); } catch { break; }
  }
  return plain;
}
function fromBase64(token: string): string | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(token)) return null;
  const text = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return readable(text) ? text : null;
}
function fromHex(token: string): string | null {
  if (token.length % 2 || !/^[0-9a-f]+$/i.test(token)) return null;
  const text = Buffer.from(token, "hex").toString("utf8");
  return readable(text) ? text : null;
}
function readable(text: string): boolean {
  return text.length >= 6 && /^[\x20-\x7e\t\r\n]+$/.test(text);
}
