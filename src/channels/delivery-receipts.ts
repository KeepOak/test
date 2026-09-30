import type { Delivery } from "./deliveries.js";

/** Transport acceptance, not a read receipt. Pending chunks may retry; dead chunks need owner attention. */
export interface DeliveryReceipt {
  key: string; channel: string; chatId: string;
  outcome: "delivered" | "queued" | "failed";
  total: number; delivered: number; queued: number; failed: number;
  createdAt: string; updatedAt: string; deliveredAt: string | null;
}

export function deliveryReceipt(rows: readonly Delivery[]): DeliveryReceipt | null {
  const first = rows[0];
  if (!first) return null;
  const delivered = rows.filter(row => row.status === "sent").length;
  const queued = rows.filter(row => row.status === "pending").length;
  const failed = rows.filter(row => row.status === "dead").length;
  const outcome = failed ? "failed" : queued ? "queued" : "delivered";
  return { key: first.key, channel: first.channel, chatId: first.chatId, outcome,
    total: rows.length, delivered, queued, failed,
    createdAt: rows.map(row => row.createdAt).sort()[0]!, updatedAt: rows.map(row => row.updatedAt).sort().at(-1)!,
    deliveredAt: outcome === "delivered" ? rows.flatMap(row => row.sentAt ? [row.sentAt] : []).sort().at(-1) ?? null : null };
}

/** Uses only this owner's existing ledger. Delivered records expire under its existing seven-day retention. */
export function recentDeliveryReceipts(rows: readonly Delivery[], limit = 50): DeliveryReceipt[] {
  const groups = new Map<string, Delivery[]>();
  for (const row of rows) {
    const id = JSON.stringify([row.key, row.channel, row.chatId]);
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  return [...groups.values()].flatMap(group => { const receipt = deliveryReceipt(group); return receipt ? [receipt] : []; })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(0, Math.min(50, limit)));
}
