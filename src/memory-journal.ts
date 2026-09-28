import { isDeepStrictEqual } from "node:util";
import type { Store } from "./store.js";
import type { MemoryWriteReceipt } from "./memory-backend.js";

function original(store: Store, owner: string, id: string, receipt: MemoryWriteReceipt) {
  if (receipt.destination.kind !== "built-in" || receipt.record.owner !== owner || receipt.record.id !== id)
    throw new Error("This receipt belongs to a different fact or memory service");
  const archived = store.sqlite.prepare("SELECT data FROM memory_archive WHERE owner=? AND id=?").get(owner, id);
  const current = store.get("memory", owner, id);
  for (const data of [current?.data, archived ? JSON.parse(String(archived.data)) : undefined])
    if (data && !isDeepStrictEqual(data, receipt.record.data)) throw new Error("This fact changed after acceptance, so the journal did not alter it");
  return { current, archived };
}

/** Built-in journal actions use the same accepted receipt and content guards as outside actions. */
export function archiveBuiltIn(store: Store, owner: string, id: string, receipt: MemoryWriteReceipt, note: string): void {
  const { current, archived } = original(store, owner, id, receipt);
  if (current) store.setAsideMemory(owner, id, note);
  else if (!archived) throw new Error("The fact cannot be found in its original memory archive");
}
export function restoreBuiltIn(store: Store, owner: string, id: string, receipt: MemoryWriteReceipt): void {
  const { current, archived } = original(store, owner, id, receipt);
  if (current) return;
  if (!archived) throw new Error("The fact cannot be found in its original memory archive");
  store.restoreMemory(owner, id, true);
  if (!isDeepStrictEqual(store.get("memory", owner, id)?.data, receipt.record.data))
    throw new Error("The original memory archive did not confirm the restored fact");
}
