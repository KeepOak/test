import { randomBytes } from "node:crypto";
import type { Store } from "../store.js";
import { audit } from "../audit.js";
import { readSenderAllowlist, saveSenderAllowlist } from "./allowlist.js";
import type { ChannelAdapter, InboundMessage } from "./router.js";

type Origin = Pick<InboundMessage, "channel" | "chatId" | "senderId" | "messageId">;
interface Proposal extends Origin { id: string; action: "allow" | "block" | "remove"; target: string; expiresAt: string; before: string }
const sendKey = (channel: string, chatId: string) => `channel-send:${JSON.stringify([channel, chatId])}`;
const outbound = new Set(["send", "sendVoice", "sendButtons", "sendTyping", "react", "setStatus", "edit", "deleteMessage", "sendFile", "sendPicture", "editPicture"]);

/** Exact chat output switch, independent of sender admission and model/tool permissions. */
export function sendEnabled(store: Store, owner: string, channel: string, chatId: string): boolean {
  return (store.get("settings", owner, sendKey(channel, chatId))?.data as { on?: boolean } | undefined)?.on !== false;
}
export function setSend(store: Store, owner: string, from: Origin, on: boolean): void {
  store.save("settings", owner, sendKey(from.channel, from.chatId), { on, channel: from.channel, chatId: from.chatId });
  audit(store, owner, { action: "policy.changed", actor: from.senderId, subject: `outgoing chat ${from.channel}:${from.chatId}`, reason: on ? "owner DM /send on" : "owner DM /send off", outcome: "saved" });
}
/** Guards the actual transport edge, including live status, files and direct adapter calls. */
export function installSendPolicy(adapter: ChannelAdapter, allowed: (chat: string) => boolean): void {
  for (const method of outbound) {
    const original: unknown = Reflect.get(adapter, method);
    if (typeof original !== "function") continue;
    Object.defineProperty(adapter, method, { configurable: true, writable: true, value: async (...args: unknown[]) => {
      if (typeof args[0] !== "string" || !allowed(args[0])) throw new Error("Outgoing messages are off for this chat. The named owner can send /send on here.");
      return Reflect.apply(original, adapter, args);
    } });
  }
}

/** Admission changes are proposals only until the local owner confirms the exact unchanged policy. */
export class OwnerAllowlistProposals {
  private readonly pending = new Map<string, Proposal>();
  private readonly recent = new Map<string, number>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly allowed: (from: Origin) => boolean) {}
  private snapshot() { return JSON.stringify(readSenderAllowlist(this.store, this.owner)); }
  private prune() {
    for (const [id, p] of this.pending) if (Date.parse(p.expiresAt) <= Date.now() || !this.allowed(p) || p.before !== this.snapshot()) this.pending.delete(id);
    for (const [id, at] of this.recent) if (Date.now() - at > 60_000) this.recent.delete(id);
  }
  list() { this.prune(); return [...this.pending.values()].map(({ before, ...p }) => { void before; return p; }); }
  request(from: Origin, argument: string): string {
    this.prune();
    if (!argument || argument === "list") {
      const list = readSenderAllowlist(this.store, this.owner);
      return `Sender admission for ${from.channel}; unknown senders: ${list.unknown}.\n` + list.rules.filter((r) => r.channel === from.channel || r.channel === "*").map((r) => `${r.channel} ${r.decision} ${r.sender}`).join("\n");
    }
    const match = /^(allow|block|remove)\s+([^\s*]{1,120})$/.exec(argument);
    if (!match) return "Use /allowlist [list] or /allowlist allow|block|remove <exact sender ID>. Changes require confirmation in Settings → Chat apps on this computer. No wildcards or other connections.";
    if (!this.allowed(from)) throw new Error("The source owner chat is no longer authorized.");
    const key = JSON.stringify([from.channel, from.senderId]);
    if (this.recent.has(key) || this.pending.size >= 8 || this.recent.size >= 20) return "A sender policy request arrived recently. Wait one minute.";
    if (match[2] === from.senderId) return "Change your own sender admission in the local window, so this chat cannot lock itself out.";
    this.recent.set(key, Date.now());
    const p: Proposal = { ...from, id: randomBytes(16).toString("hex"), action: match[1] as Proposal["action"], target: match[2]!, before: this.snapshot(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
    this.pending.set(p.id, p);
    return `Requested ${p.action} for sender ${p.target} on ${p.channel}. Within two minutes, confirm in Settings → Chat apps → Chat policy requests on this computer. No admission rule has changed.`;
  }
  confirm(id: string) {
    this.prune();
    const p = this.pending.get(id);
    if (!p) throw new Error("That request expired, policy changed, or its owner chat is no longer authorized.");
    this.pending.delete(id);
    const current = readSenderAllowlist(this.store, this.owner);
    const rules = current.rules.filter((r) => r.channel !== p.channel || r.sender !== p.target);
    if (p.action !== "remove") rules.push({ channel: p.channel, sender: p.target, decision: p.action, note: `Confirmed local request from ${p.senderId}`.slice(0, 200) });
    saveSenderAllowlist(this.store, this.owner, { ...current, rules });
    return { changed: true };
  }
}
