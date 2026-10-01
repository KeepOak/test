/**
 * Where a chat app's stream of messages was read up to, kept in the saved-work database so that
 * after a restart the messages that arrived in the meantime are fetched and answered — and the ones
 * already answered are not answered twice. Telegram's position moves on as soon as an update is saved to its inbox
 * (src/channels/telegram-inbox.ts), which keeps a message cut off by a crash for the restart (docs/never-break.md).
 *
 * `reader` names what the position belongs to (a Telegram bot's id). A position saved by another reader, or saved
 * before readers were named, is never used: Telegram numbers each bot's updates on their own ("Update identifiers
 * start from a certain positive number and increase sequentially", https://core.telegram.org/bots/api#update), and
 * asking with an offset above an update confirms it, so a position from another bot could throw away this bot's
 * messages ("An update is considered confirmed as soon as getUpdates is called with an offset higher than its
 * update_id", https://core.telegram.org/bots/api#getupdates). Such a reader starts from 0, which asks for "the
 * earliest unconfirmed update" (the same page): nothing is skipped.
 */
export interface ChannelPosition {
  load(): number;
  save(offset: number): void;
  /** When the position loaded was saved (ms since 1970), if known. */
  savedAt?(): number | undefined;
}

interface SettingsStore {
  get(table: "settings", owner: string, id: string): { data: Record<string, unknown> } | undefined;
  save(table: "settings", owner: string, id: string, data: Record<string, unknown>): unknown;
}

export function channelPosition(store: unknown, channelId: string, owner = "local", reader?: string): ChannelPosition | undefined {
  const saved = store as Partial<SettingsStore> | null;
  if (typeof saved?.get !== "function" || typeof saved.save !== "function") return undefined;
  const settings = saved as SettingsStore;
  const key = `channel-position:${channelId}`;
  const mine = () => {
    const data = settings.get("settings", owner, key)?.data;
    return reader !== undefined && data?.reader !== reader ? undefined : data;
  };
  return {
    load: () => {
      const offset = Number(mine()?.offset ?? 0);
      return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    },
    savedAt: () => {
      const at = Date.parse(String(mine()?.savedAt ?? ""));
      return Number.isFinite(at) ? at : undefined;
    },
    save: (offset) => {
      settings.save("settings", owner, key, { offset, ...(reader !== undefined ? { reader } : {}), savedAt: new Date().toISOString() });
    },
  };
}
