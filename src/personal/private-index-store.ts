import type { Store } from "../store.js";

export const privateIndexTable = "personal_private_search";
export type CachedItem = { kind: "message" | "calendar"; id: string; title: string; text: string; sourceTime: string };
export class PrivateIndexStore {
  constructor(private readonly store: Store, private readonly owner: string) {}
  exists(): boolean {
    return !!this.store.sqlite.prepare("SELECT name FROM sqlite_temp_master WHERE name=?").get(privateIndexTable);
  }
  ensure(): void {
    this.store.sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${privateIndexTable} USING fts5(
      owner UNINDEXED, service UNINDEXED, account UNINDEXED, kind UNINDEXED, source_id UNINDEXED,
      title, text, source_time UNINDEXED, indexed_at UNINDEXED, expires_at UNINDEXED, tokenize='unicode61')`);
  }
  purge(service?: string, account?: string): void {
    if (!this.exists()) return;
    this.store.sqlite.prepare(`DELETE FROM ${privateIndexTable} WHERE owner=? AND (? IS NULL OR service=?) AND (? IS NULL OR account=?)`)
      .run(this.owner, service ?? null, service ?? null, account ?? null, account ?? null);
    this.store.sqlite.exec(`INSERT INTO ${privateIndexTable}(${privateIndexTable}) VALUES('optimize')`);
  }
  expire(): void {
    if (!this.exists()) return;
    this.store.sqlite.prepare(`DELETE FROM ${privateIndexTable} WHERE owner=? AND expires_at<=?`).run(this.owner, new Date().toISOString());
    this.store.sqlite.exec(`INSERT INTO ${privateIndexTable}(${privateIndexTable}) VALUES('optimize')`);
  }
  replace(service: string, account: string, items: CachedItem[]): void {
    this.ensure();
    const now = new Date(), expires = new Date(now.getTime() + 86400000).toISOString();
    this.store.sqlite.exec("BEGIN");
    try {
      this.store.sqlite.prepare(`DELETE FROM ${privateIndexTable} WHERE owner=? AND service=? AND account=?`).run(this.owner, service, account);
      const insert = this.store.sqlite.prepare(`INSERT INTO ${privateIndexTable} VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const item of items.slice(0, 75)) insert.run(this.owner, service, account, item.kind, item.id,
        item.title, item.text, item.sourceTime, now.toISOString(), expires);
      this.store.sqlite.exec("COMMIT");
    } catch (error) { this.store.sqlite.exec("ROLLBACK"); throw error; }
  }
  count(): number {
    return this.exists() ? Number(this.store.sqlite.prepare(`SELECT count(*) AS n FROM ${privateIndexTable} WHERE owner=?`).get(this.owner)?.n ?? 0) : 0;
  }
  search(query: string) {
    this.expire();
    const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
    if (!this.exists() || !terms.length) return [];
    const match = terms.map((term) => `"${term}"`).join(" AND ");
    return this.store.sqlite.prepare(`SELECT service,account,kind,source_id AS sourceId,title,
      substr(text,1,400) AS excerpt,source_time AS sourceTime,indexed_at AS indexedAt,expires_at AS expiresAt
      FROM ${privateIndexTable} WHERE ${privateIndexTable} MATCH ? AND owner=? ORDER BY rank LIMIT 20`).all(match, this.owner);
  }
}
