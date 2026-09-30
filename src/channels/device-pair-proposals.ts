import { randomBytes } from "node:crypto";

export interface PairProposal {
  id: string; channel: string; chatId: string; senderId: string; senderName: string;
  messageId: string; kind: "phone" | "computer"; label: string; expiresAt: string;
}

/** Requests only. Invitation secrets and device approval remain in the local window. */
export class DevicePairProposals {
  private readonly pending = new Map<string, PairProposal>();
  private readonly recent = new Map<string, number>();
  constructor(private readonly allowed: (proposal: PairProposal) => boolean, private readonly now = Date.now) {}

  private prune(): void {
    const now = this.now();
    for (const [id, proposal] of this.pending)
      if (Date.parse(proposal.expiresAt) <= now || !this.allowed(proposal)) this.pending.delete(id);
    for (const [key, at] of this.recent) if (now - at >= 60_000) this.recent.delete(key);
  }

  request(from: Omit<PairProposal, "id" | "kind" | "label" | "expiresAt">, argument: string): string {
    this.prune();
    const match = /^(phone|computer)(?:\s+([^\r\n]{1,80}))?$/.exec(argument.trim());
    if (!match) return "Use /pair phone [device name] or /pair computer [device name]. Approval and the pairing code stay in the window on this computer.";
    const proposal: PairProposal = { ...from, id: randomBytes(16).toString("hex"),
      kind: match[1] as PairProposal["kind"], label: (match[2] ?? "").trim(), expiresAt: new Date(this.now() + 120_000).toISOString() };
    if (!this.allowed(proposal)) return "Device pairing requests need your own approved direct chat, while Branch is unlocked and outside Lockdown.";
    if ([...this.pending.values()].some((p) => p.channel === from.channel && p.messageId === from.messageId && p.chatId === from.chatId))
      return "That pairing request is already waiting in the local window.";
    const key = JSON.stringify([from.channel, from.senderId]);
    if (this.recent.has(key) || this.recent.size >= 20 || this.pending.size >= 8)
      return "A pairing request is already waiting, or too many arrived recently. Wait a minute and try again.";
    this.recent.set(key, this.now());
    this.pending.set(proposal.id, proposal);
    return "Pairing requested. Within two minutes, review it in the window on this computer. The code stays there; compare the new device’s check code before letting it in. No device has been paired.";
  }

  list(): PairProposal[] { this.prune(); return [...this.pending.values()]; }
  consume(id: string, kind: PairProposal["kind"]): void {
    this.prune();
    const proposal = this.pending.get(id);
    if (!proposal || proposal.kind !== kind) throw new Error("That chat pairing request expired or its sender is no longer authorized.");
    this.pending.delete(id);
  }
}
