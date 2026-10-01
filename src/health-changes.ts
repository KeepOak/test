/** Ephemeral notifications for explicit account checks; no credential values or persistent grants. */
export interface HealthChange { kind: "setting" | "credential"; owner: string; id: string; project?: string }
const watchers = new WeakMap<object, Set<(change: HealthChange) => void>>();
export function watchHealthChanges(database: object, listener: (change: HealthChange) => void): () => void {
  const listeners = watchers.get(database) ?? new Set();
  watchers.set(database, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) watchers.delete(database); };
}
export function healthChanged(database: object, change: HealthChange): void {
  for (const listener of watchers.get(database) ?? []) {
    try { listener(change); } catch { /* A notification must not undo the owner's completed write. */ }
  }
}
