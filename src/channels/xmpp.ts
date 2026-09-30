import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { reconnectDelay } from "./ws-client.js";
import { defineService, secretName, ShortIds, type SocketOpener } from "./parity-common.js";
import { child, escapeAttr, escapeText, XmlStreamReader, type XmlElement, type XmlEvent } from "./xmpp-xml.js";

/**
 * XMPP (Jabber), written from RFC 6120 (the stream, TLS, SASL and resource binding), RFC 6121
 * (messages and presence), XEP-0045 (group chat rooms), XEP-0199 (ping) and XEP-0203 (delayed
 * delivery). The XML is read by our own small reader in xmpp-xml.ts.
 *
 * The password only ever travels inside TLS: either the connection is TLS from the first byte
 * (port 5223) or the server is asked to switch to TLS (STARTTLS on port 5222) before signing in.
 * `allowPlainText` exists only so the tests can talk to a stand-in server without certificates.
 *
 * A one-to-one message is always answered. In a room, a message is answered when it names the
 * assistant's nick; the room's replay of old messages (marked with a delay) and the assistant's
 * own messages echoed back by the room are ignored.
 */
export type TlsUpgrade = (socket: Duplex, servername: string) => Promise<Duplex>;
export const upgradeTls: TlsUpgrade = (socket, servername) => new Promise((resolve, reject) => {
  const secured = tlsConnect({ socket, servername }, () => resolve(secured));
  secured.once("error", reject);
});

const NS = {
  tls: "urn:ietf:params:xml:ns:xmpp-tls", sasl: "urn:ietf:params:xml:ns:xmpp-sasl", bind: "urn:ietf:params:xml:ns:xmpp-bind",
  session: "urn:ietf:params:xml:ns:xmpp-session", muc: "http://jabber.org/protocol/muc", mucUser: "http://jabber.org/protocol/muc#user",
  ping: "urn:xmpp:ping", stanzas: "urn:ietf:params:xml:ns:xmpp-stanzas",
};

export interface XmppRoom { room: string; nick: string }
export interface XmppOptions {
  id: string;
  /** The assistant's bare address, user@domain. */
  jid: string;
  password: string;
  host: string;
  port: number;
  /** "direct": TLS from the first byte. "starttls": plain first, then switched to TLS. */
  security: "direct" | "starttls";
  open: SocketOpener;
  upgrade?: TlsUpgrade;
  resource?: string;
  rooms?: XmppRoom[];
  /** Tests only: sign in without TLS. */
  allowPlainText?: boolean;
  retryBaseMs?: number;
  keepaliveMs?: number;
}

/** One live connection's progress through the sign-in steps. */
interface Session {
  socket: Duplex;
  reader: XmlStreamReader;
  decoder: StringDecoder;
  secure: boolean;
  signedIn: boolean;
  closed: Promise<void>;
  end: () => void;
}

export class XmppChannel implements ChannelAdapter {
  private readonly chatStates = new Map<string, "active" | "composing">();
  readonly id: string;
  readonly kind = "xmpp";
  readonly maxTextLength = 3500;
  private readonly domain: string;
  private readonly rooms: Map<string, string>;
  private readonly ids = new ShortIds();
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to the XMPP server" };
  private session: Session | null = null;
  private stopping = false;
  private refused = false;
  private loop: Promise<void> | null = null;
  private counter = 0;
  private onMessage: (message: InboundMessage) => Promise<void> = async () => undefined;
  constructor(private readonly options: XmppOptions) {
    this.id = options.id;
    this.domain = options.jid.split("@")[1] ?? options.jid;
    this.rooms = new Map((options.rooms ?? []).map((r) => [r.room.toLowerCase(), r.nick]));
  }
  botName(): string | null { return this.options.jid.split("@")[0] ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.onMessage = onMessage;
    this.loop = this.run();
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.session) { this.write("</stream:stream>"); this.session.end(); }
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async run(): Promise<void> {
    for (let attempt = 0; !this.stopping && !this.refused; attempt++) {
      try {
        const socket = await this.options.open({ host: this.options.host, port: this.options.port,
          tls: this.options.security === "direct", servername: this.domain });
        const session = this.attach(socket, this.options.security === "direct");
        // mac7/linux-fixes: a stop that arrived while this was still being opened found nothing to
        // close, and the loop then waited for a close nobody would ask for. Let it go straight away.
        if (this.stopping) session.end();
        this.openStream();
        const keepalive = setInterval(() => this.write(" "), this.options.keepaliveMs ?? 60000);
        await session.closed;
        clearInterval(keepalive);
        if (this.state.state === "connected") attempt = 0;
        if (!this.stopping && !this.refused) this.state = { state: "reconnecting", reason: "The XMPP server closed the connection" };
      } catch (error) {
        if (this.stopping) return;
        this.state = { state: "reconnecting", reason: `Could not reach the XMPP server: ${error instanceof Error ? error.message : String(error)}` };
      }
      this.session = null;
      if (this.stopping || this.refused) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }

  /** Starts reading a socket. Replacing the socket (after STARTTLS) keeps the same session. */
  private attach(socket: Duplex, secure: boolean, previous?: Session): Session {
    let end = () => undefined as void;
    const session: Session = previous ?? {
      socket, reader: new XmlStreamReader(), decoder: new StringDecoder("utf8"), secure, signedIn: false,
      closed: new Promise<void>((resolve) => { end = resolve; }), end: () => undefined,
    };
    if (!previous) session.end = () => { session.socket.destroy(); end(); };
    session.socket = socket;
    session.secure = secure;
    socket.on("data", (chunk: Buffer) => this.onData(session, socket, chunk));
    socket.once("close", () => { if (session.socket === socket) session.end(); });
    socket.on("error", () => { if (session.socket === socket) session.end(); });
    this.session = session;
    return session;
  }
  private onData(session: Session, socket: Duplex, chunk: Buffer): void {
    if (session.socket !== socket) return;
    try {
      session.reader.push(session.decoder.write(chunk), (event) => { if (session.socket === socket) this.onEvent(session, event); });
    } catch (error) {
      this.state = { state: "reconnecting", reason: `The XMPP server sent something unreadable: ${error instanceof Error ? error.message : String(error)}` };
      session.end();
    }
  }
  private write(xml: string): void {
    const socket = this.session?.socket;
    if (socket?.writable) socket.write(xml);
  }
  private openStream(): void {
    this.write(`<?xml version='1.0'?><stream:stream to='${escapeAttr(this.domain)}' version='1.0' xml:lang='en' `
      + `xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>`);
  }

  private onEvent(session: Session, event: XmlEvent): void {
    if (event.type === "close") { session.end(); return; }
    if (event.type !== "element") return;
    const stanza = event.element;
    switch (stanza.name) {
      case "stream:features": return this.onFeatures(session, stanza);
      case "proceed": void this.startTls(session); return;
      case "success": session.signedIn = true; session.reader.reset(); this.openStream(); return;
      case "failure": return this.onFailure(session, stanza);
      case "iq": return this.onIq(stanza);
      case "message": return this.onStanzaMessage(stanza);
      case "stream:error":
        this.state = { state: "reconnecting", reason: `The XMPP server ended the connection (${stanza.children[0]?.name ?? "error"})` };
        session.end(); return;
      default: return;
    }
  }

  private onFeatures(session: Session, features: XmlElement): void {
    if (session.signedIn) {
      this.write(`<iq type='set' id='bind1'><bind xmlns='${NS.bind}'><resource>${escapeText(this.options.resource ?? "branch")}</resource></bind></iq>`);
      return;
    }
    if (!session.secure && child(features, "starttls", NS.tls)) { this.write(`<starttls xmlns='${NS.tls}'/>`); return; }
    if (!session.secure && !this.options.allowPlainText) {
      return this.giveUp(session, "The XMPP server does not offer encryption, so the password was not sent. Use port 5223 or a server that supports STARTTLS");
    }
    const mechanisms = child(features, "mechanisms", NS.sasl)?.children.map((m) => m.text.trim().toUpperCase()) ?? [];
    if (!mechanisms.includes("PLAIN")) {
      return this.giveUp(session, "The XMPP server does not accept password sign-in (SASL PLAIN), which is the only kind Branch uses");
    }
    const user = this.options.jid.split("@")[0] ?? "";
    const token = Buffer.from(`\0${user}\0${this.options.password}`, "utf8").toString("base64");
    this.write(`<auth xmlns='${NS.sasl}' mechanism='PLAIN'>${token}</auth>`);
  }
  private async startTls(session: Session): Promise<void> {
    const old = session.socket;
    old.removeAllListeners("data");
    session.reader.clear();
    try {
      const secured = await (this.options.upgrade ?? upgradeTls)(old, this.domain);
      this.attach(secured, true, session);
      this.openStream();
    } catch (error) {
      this.state = { state: "reconnecting", reason: `The XMPP server's encryption could not be set up: ${error instanceof Error ? error.message : String(error)}` };
      session.end();
    }
  }
  private onFailure(session: Session, failure: XmlElement): void {
    if (failure.attrs.xmlns === NS.tls) return this.giveUp(session, "The XMPP server could not switch to encryption");
    this.giveUp(session, "The XMPP server did not accept the password. Save the right one as the secret named in passwordSecret (XMPP_PASSWORD by default)");
  }
  /** A problem only the owner can fix: stop retrying and say what to do. */
  private giveUp(session: Session, reason: string): void {
    this.refused = true;
    this.state = { state: "needs attention", reason };
    session.end();
  }

  private onIq(iq: XmlElement): void {
    const { type = "", id = "" } = iq.attrs;
    if (type === "result" && id === "bind1") return this.onBound();
    if (type === "error" && id === "bind1") {
      this.state = { state: "needs attention", reason: "The XMPP server would not let the assistant sign in with its resource name" };
      return;
    }
    if (type !== "get" && type !== "set") return;
    const to = iq.attrs.from ? ` to='${escapeAttr(iq.attrs.from)}'` : "";
    if (type === "get" && child(iq, "ping", NS.ping)) { this.write(`<iq type='result' id='${escapeAttr(id)}'${to}/>`); return; }
    if (type === "get" && child(iq, "query", "http://jabber.org/protocol/disco#info")) {
      this.write(`<iq type='result' id='${escapeAttr(id)}'${to}><query xmlns='http://jabber.org/protocol/disco#info'><feature var='http://jabber.org/protocol/chatstates'/></query></iq>`);
      return;
    }
    // RFC 6120 section 8.4: a request nobody here understands is answered with an error, never ignored.
    this.write(`<iq type='error' id='${escapeAttr(id)}'${to}><error type='cancel'><service-unavailable xmlns='${NS.stanzas}'/></error></iq>`);
  }
  private onBound(): void {
    this.write("<presence/>");
    for (const [room, nick] of this.rooms) {
      this.write(`<presence to='${escapeAttr(`${room}/${nick}`)}'><x xmlns='${NS.muc}'><history maxstanzas='0'/></x></presence>`);
    }
    this.state = { state: "connected" };
  }

  private onStanzaMessage(stanza: XmlElement): void {
    const from = splitJid(stanza.attrs.from ?? "")[0].toLowerCase();
    if (from && stanza.attrs.type === "chat" && !child(stanza, "delay", "urn:xmpp:delay")) {
      const state = stanza.children.find((c) => c.attrs.xmlns === "http://jabber.org/protocol/chatstates");
      if (state) {
        if (this.chatStates.size >= 1000 && !this.chatStates.has(from)) this.chatStates.delete(this.chatStates.keys().next().value!);
        if (!this.chatStates.has(from)) this.chatStates.set(from, "active");
      } else if (child(stanza, "body")) this.chatStates.delete(from);
    }
    const inbound = this.inbound(stanza);
    if (inbound) void this.onMessage(inbound).catch(() => undefined);
  }
  private inbound(stanza: XmlElement): InboundMessage | null {
    const type = stanza.attrs.type ?? "normal";
    const from = stanza.attrs.from ?? "";
    const text = child(stanza, "body")?.text ?? "";
    if (!from || !text.trim() || type === "error" || type === "headline") return null;
    // A delay marks a message stored earlier and replayed (room history, offline storage).
    if (stanza.children.some((c) => c.name === "delay" || (c.name === "x" && c.attrs.xmlns === "jabber:x:delay"))) return null;
    const [bare = "", resource = ""] = splitJid(from);
    const messageId = (stanza.attrs.id ?? "").slice(0, 64) || `${Date.now()}-${++this.counter}`;
    if (type === "groupchat") return this.roomMessage(stanza, bare, resource, text, messageId);
    if (bare.toLowerCase() === this.options.jid.toLowerCase()) return null;
    return {
      channel: this.id, chatId: this.ids.short(bare, "chat"), chatKind: "direct",
      senderId: this.ids.short(bare.toLowerCase(), "who"), senderName: bare.split("@")[0] || bare,
      text, addressed: true, messageId,
    };
  }
  private roomMessage(stanza: XmlElement, room: string, nick: string, text: string, messageId: string): InboundMessage | null {
    const mine = this.rooms.get(room.toLowerCase());
    if (!mine || !nick || nick === mine) return null;
    const real = child(child(stanza, "x", NS.mucUser), "item")?.attrs.jid;
    const who = real ? splitJid(real)[0]!.toLowerCase() : `${room}/${nick}`;
    const lower = text.toLowerCase(), me = mine.toLowerCase();
    const leading = [`${me}:`, `${me},`, `@${me}`].find((prefix) => lower.startsWith(prefix));
    const words = leading ? text.slice(leading.length).trim() : text;
    return {
      channel: this.id, chatId: this.ids.short(room.toLowerCase(), "chat"), chatKind: "group", chatTitle: room,
      senderId: this.ids.short(who, "who"), senderName: nick,
      text: words || text, addressed: !!leading || lower.includes(me), messageId,
    };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    if (!this.session || this.state.state !== "connected") throw new Error("The XMPP server is not connected, so the message could not be sent");
    const to = this.ids.long(chatId);
    const type = this.rooms.has(to.toLowerCase()) ? "groupchat" : "chat";
    const id = `branch-${Date.now().toString(36)}-${++this.counter}`;
    const active = this.chatStates.has(to.toLowerCase()) ? "<active xmlns='http://jabber.org/protocol/chatstates'/>" : "";
    this.write(`<message to='${escapeAttr(to)}' type='${type}' id='${id}'><body>${escapeText(text.slice(0, this.maxTextLength))}</body>${active}</message>`);
    if (active) this.chatStates.set(to.toLowerCase(), "active");
    return id;
  }
  async sendTyping(chatId: string): Promise<void> {
    if (!this.session || this.state.state !== "connected") throw new Error("XMPP is not connected.");
    const to = this.ids.long(chatId), key = to.toLowerCase();
    // Only direct peers that negotiated states; no room-wide presence disclosure or repeated composing stanza.
    if (!this.chatStates.has(key) || this.rooms.has(key) || this.chatStates.get(key) === "composing") return;
    this.write(`<message to='${escapeAttr(to)}' type='chat'><composing xmlns='http://jabber.org/protocol/chatstates'/></message>`);
    this.chatStates.set(key, "composing");
  }
}

/** Splits user@domain/resource into the bare address and the resource. */
export function splitJid(jid: string): [string, string] {
  const at = jid.indexOf("/");
  return at < 0 ? [jid, ""] : [jid.slice(0, at), jid.slice(at + 1)];
}

const bareJid = z.string().max(300).regex(/^[^@\s/<>&'"]+@[A-Za-z0-9.-]+$/);
export const xmppService = defineService({
  kind: "xmpp", name: "XMPP (Jabber)", docs: "https://www.rfc-editor.org/rfc/rfc6120",
  needs: ["An XMPP account for the assistant (its address, like assistant@example.org)",
    "That account's password, saved as a secret (XMPP_PASSWORD)",
    "Optionally, the group chat rooms it should join and the nick to use there"],
  receives: "socket",
  settings: z.object({
    jid: bareJid,
    passwordSecret: z.string().regex(secretName).default("XMPP_PASSWORD"),
    server: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    security: z.enum(["direct", "starttls"]).default("direct"),
    resource: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/).default("branch"),
    rooms: z.array(z.object({ room: bareJid, nick: z.string().regex(/^[^\s/<>&'"]{1,40}$/).optional() }).strict()).max(20).default([]),
    /** Only for testing against a local stand-in: allows signing in without encryption. */
    allowPlainText: z.boolean().default(false),
  }).strict(),
  async build(settings, deps) {
    const host = settings.server ?? settings.jid.split("@")[1]!;
    // A raw socket has no fetch to guard it, so the server is checked by name first.
    await deps.assertAllowed(new URL(`https://${host}`), "XMPP server");
    const nick = settings.jid.split("@")[0]!;
    return new XmppChannel({
      id: deps.id, jid: settings.jid, password: await deps.secret(settings.passwordSecret), host,
      port: settings.port ?? (settings.security === "direct" ? 5223 : 5222), security: settings.security,
      open: deps.openSocket, resource: settings.resource, allowPlainText: settings.allowPlainText,
      rooms: settings.rooms.map((r) => ({ room: r.room, nick: r.nick ?? nick })),
    });
  },
});
