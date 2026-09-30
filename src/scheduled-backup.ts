import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { Store } from "./store.js";
import type { GitHubAccess } from "./integrations/github.js";
import { repositoryPath } from "./integrations/github.js";
import { backupTables, parseBackupArchive, type BackupArchive } from "./backup.js";
import { exportSettings, SettingsFileSchema } from "./settings-kit/transfer.js";
import { redactLeaksIn } from "./leak-guard.js";
import { lockdownActive } from "./lockdown.js";
import { runOrigin, startedFromChat, startedWithShortLivedKey } from "./key-context.js";
import { accessAgent } from "./trunks/memory-scope.js";
import { underProject } from "./project-scope.js";
import { specFor } from "./settings-kit/catalogue.js";
import { acceptValue } from "./settings-kit/changes.js";

const key = "scheduled-github-backup", statusKey = "scheduled-github-backup-status";
const maxBytes = 128 * 1024;
const Settings = z.object({ enabled: z.boolean(), repo: repositoryPath, repositoryId: z.number().int().positive(),
  project: z.string().min(1).max(200), hours: z.number().int().min(24).max(720), nextAt: z.string().datetime() }).strict();
const Configure = z.object({ enabled: z.boolean(), repo: repositoryPath,
  hours: z.number().int().min(24).max(720).default(24) }).strict();
const Pin = z.object({ id: z.string().uuid(), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict();
const Envelope = z.object({ format: z.literal("branch-scheduled-backup"), version: z.literal(1),
  archive: z.unknown(), settings: SettingsFileSchema }).strict();
const carried = new Set(["memory", "installed_skills", "skill_versions"]);

/** Fixed, secret-excluding subset; never copy conversations, credentials, trust or automation records. */
function narrow(archive: BackupArchive, owner: string): BackupArchive {
  const skills = new Set(archive.tables.installed_skills.filter(r => r.owner === owner).map(r => r.id));
  for (const [table, rows] of Object.entries(archive.tables)) {
    if (!rows) continue;
    const keep = !carried.has(table) ? [] : rows.filter(r => table === "skill_versions" ? skills.has(r.skill_id) : r.owner === owner)
      .map(r => table === "installed_skills" ? { ...r, active_version: null } : r);
    (archive.tables as Record<string, typeof keep>)[table] = keep;
  }
  return archive;
}

export function scheduledBackupHold(tool: string): { reason: string; onceOnly: true } | null {
  return ["backup.github_configure", "backup.github_restore_prepare", "backup.github_restore"].includes(tool)
    ? { reason: "Confirm this backup destination and schedule, or prepare this exact recovery copy", onceOnly: true } : null;
}

export class ScheduledGitHubBackup {
  private running = false;
  constructor(private readonly store: Store, private readonly owner: string, private readonly dataDir: string,
    private readonly version: string, private readonly github: () => GitHubAccess,
    private readonly scrub: <T>(value: T) => T) {}
  settings(): z.infer<typeof Settings> | null {
    const parsed = Settings.safeParse(this.store.get("settings", this.owner, key)?.data);
    return parsed.success ? parsed.data : null;
  }
  status() { return this.store.get("settings", this.owner, statusKey)?.data ?? {}; }
  private permitted(): void {
    this.store.profiles.requireOwner("GitHub backups");
    if (lockdownActive(this.store, this.owner)) throw new Error("GitHub backups are held during Lockdown.");
  }
  guard(context: ToolContext): void {
    this.permitted();
    if (accessAgent(context) || startedWithShortLivedKey() || startedFromChat(context, this.store)
      || (context.source ?? "owner") !== "owner" || runOrigin(this.store, context.runId).source !== "owner")
      throw new Error("Manage backups in an owner-started conversation in the app window.");
  }
  async configure(input: z.infer<typeof Configure>) {
    this.permitted();
    if (!input.enabled) { this.store.delete("settings", this.owner, key); return { enabled: false }; }
    const gh = this.github(), repo = await gh.backupRepository(input.repo);
    this.permitted();
    if (!repo.private || !repo.push) throw new Error("Choose a private GitHub repository with Contents write access.");
    const settings = Settings.parse({ ...input, repositoryId: repo.id, project: this.store.projects.active(this.owner).id,
      nextAt: new Date(Date.now() + input.hours * 3_600_000).toISOString() });
    this.store.save("settings", this.owner, key, settings);
    return { ...settings, note: "Scheduled while Branch is running. Only owner memory, inactive installed skills and catalogued settings travel; no credentials or workspace files." };
  }
  private snapshot(): string {
    const tables = Object.fromEntries(backupTables.map(table => [table, []])) as unknown as BackupArchive["tables"];
    const selected = (sql: string) => this.store.sqlite.prepare(sql).all(this.owner)
      .map(row => Object.fromEntries(Object.entries(row).map(([field, value]) =>
        [field, typeof value === "bigint" ? Number(value) : value])) as Record<string, string | number | null>);
    tables.memory = selected("SELECT * FROM memory WHERE owner=? ORDER BY id LIMIT 10001");
    tables.installed_skills = selected("SELECT * FROM installed_skills WHERE owner=? ORDER BY id LIMIT 51");
    tables.skill_versions = selected("SELECT v.* FROM skill_versions v JOIN installed_skills s ON s.id=v.skill_id WHERE s.owner=? ORDER BY v.skill_id,v.version LIMIT 1001");
    if (tables.memory.length > 10000 || tables.installed_skills.length > 50 || tables.skill_versions.length > 1000)
      throw new Error("This backup exceeds its bounded memory or skill count; no partial backup was sent.");
    const archive = narrow({ format: "branch-agent-backup", version: 1, appVersion: this.version,
      exportedAt: new Date().toISOString(), tables }, this.owner);
    const settings = exportSettings(this.store, this.owner, this.version);
    const cleaned = this.scrub(redactLeaksIn({ format: "branch-scheduled-backup", version: 1, archive, settings }).value);
    const text = JSON.stringify(cleaned);
    if (Buffer.byteLength(text) > maxBytes) throw new Error("This selected backup exceeds the 128 KiB limit.");
    parseBackupArchive(Envelope.parse(JSON.parse(text)).archive);
    return text;
  }
  /** Scheduler callback, serialized and persisted: failures wait for the next approved interval. */
  async tick(now: Date): Promise<void> {
    const saved = this.settings();
    if (this.running || !saved?.enabled || Date.parse(saved.nextAt) > now.getTime()) return;
    this.running = true;
    const config = saved;
    try {
      this.permitted();
      const bumped = { ...config, nextAt: new Date(now.getTime() + config.hours * 3_600_000).toISOString() };
      this.store.save("settings", this.owner, key, bumped);
      await underProject(config.project, async () => {
        const gh = this.github(), repo = await gh.backupRepository(config.repo);
        if (!repo.private || !repo.push || repo.id !== config.repositoryId) throw new Error("The backup repository or access changed.");
        const unchanged = () => {
          this.permitted();
          if (this.github() !== gh || JSON.stringify(this.settings()) !== JSON.stringify(bumped))
            throw new Error("The backup schedule or GitHub connection changed.");
        };
        unchanged();
        const text = this.snapshot(), id = randomUUID();
        const result = await gh.createBackup(config.repo, id, text, unchanged);
        this.store.save("settings", this.owner, statusKey, { ...result, id, repo: config.repo,
          at: now.toISOString(), bytes: Buffer.byteLength(text), digest: createHash("sha256").update(text).digest("hex") });
      });
    } catch (error) {
      const problem = this.scrub(redactLeaksIn(error instanceof Error ? error.message : "Backup failed").value);
      this.store.save("settings", this.owner, statusKey, { ...this.status(), problem: problem.slice(0, 300), failedAt: now.toISOString() });
    } finally { this.running = false; }
  }
  private async load(pin: z.infer<typeof Pin>) {
    this.permitted();
    const saved = this.settings();
    if (!saved) throw new Error("Configure the private backup repository first.");
    return underProject(saved.project, async () => {
      const gh = this.github(), repo = await gh.backupRepository(saved.repo);
      if (!repo.private || repo.id !== saved.repositoryId) throw new Error("The backup repository changed.");
      const text = await gh.readBackup(saved.repo, pin.id, pin.commit);
      this.permitted();
      if (this.github() !== gh || JSON.stringify(saved) !== JSON.stringify(this.settings()))
        throw new Error("The backup schedule or GitHub connection changed. Inspect it again.");
      const envelope = Envelope.parse(JSON.parse(text)), archive = parseBackupArchive(envelope.archive);
      // Re-narrow untrusted restored content; skills stay inactive, settings are proposals only.
      return { archive: narrow(archive, this.owner), settings: envelope.settings,
        digest: createHash("sha256").update(text).digest("hex"), repo: saved.repo };
    });
  }
  async inspect(pin: z.infer<typeof Pin>) {
    const v = await this.load(pin);
    return { ...pin, repo: v.repo, digest: v.digest, exportedAt: v.archive.exportedAt,
      facts: v.archive.tables.memory.length, skills: v.archive.tables.installed_skills.length,
      settings: Object.keys(v.settings.settings).length, note: "Inspection changes nothing. Skills restore inactive and settings require their existing proposal review." };
  }
  async prepare(pin: z.infer<typeof Pin>) {
    const v = await this.load(pin);
    this.permitted();
    const folder = join(this.dataDir, "backup-recovery", randomUUID());
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, "backup.json"), JSON.stringify(v.archive), { flag: "wx", mode: 0o600 });
    await writeFile(join(folder, "settings.json"), JSON.stringify(v.settings), { flag: "wx", mode: 0o600 });
    return { folder, digest: v.digest, restored: false, note: "Recovery copies prepared. Use backup.json with the existing fresh-install restore; import settings.json through settings proposal review. Your live state and workspace were not replaced." };
  }
  /** Apply only into a newly generated, empty data folder; never accept an arbitrary destination. */
  async restoreFresh(pin: z.infer<typeof Pin>) {
    const v = await this.load(pin);
    this.permitted();
    const root = join(this.dataDir, "backup-restores"), folder = join(root, randomUUID());
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(folder, { mode: 0o700 }); // Fails if it exists: no old directory is reused.
    const path = join(folder, "branch.sqlite");
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    const restored = new Store(path);
    try {
      const result = restored.restore(v.archive, { replaceExisting: false });
      const held = Object.entries(v.settings.settings).flatMap(([id, fields]) => {
        const spec = specFor(id);
        if (!spec) return [];
        const data: Record<string, unknown> = {};
        for (const field of spec.fields) {
          const value = acceptValue(field, fields[field.field]);
          if (value === undefined) continue;
          const names = field.field.split(".");
          let node = data;
          for (const name of names.slice(0, -1)) { node[name] ??= {}; node = node[name] as Record<string, unknown>; }
          node[names.at(-1)!] = value;
        }
        return Object.keys(data).length ? [{ owner: this.owner, id, data: JSON.stringify(data) }] : [];
      });
      const configuration = restored.restoreHeld.merge(held);
      return { ...result, folder, restored: true, configurationPendingReview: configuration, digest: v.digest,
        note: "Memory and inactive skills restored into this new data folder only. Launch a separate Branch with BRANCH_DATA_DIR set to this folder, then review restored settings and skills there. The running install was not replaced." };
    } finally { restored.close(); }
  }
}

export function registerScheduledBackup(registry: ToolRegistry, backup: ScheduledGitHubBackup): void {
  registry.register({ name: "backup.github_configure", permission: "github.manage", reach: "outbound", parameters: Configure,
    description: "Opt in to scheduled private GitHub backups of owner memory, inactive installed skills and safe catalogued config; always asks confirmation. No credentials or workspace files; 128 KiB limit, daily or slower, while Branch runs.",
    target: v => `GitHub ${v.repo}: ${v.enabled ? `copy selected owner memory, skills and config every ${v.hours} hours` : "disable backup uploads"}`,
    execute: async (v, c) => { backup.guard(c); return backup.configure(v); } });
  registry.register({ name: "backup.github_status", permission: "github.manage", reach: "local", parameters: z.object({}).strict(),
    description: "Show the approved backup schedule and last successful snapshot pin or last failure.",
    target: () => "owner GitHub backup status", execute: async (_v, c) => { backup.guard(c); return { settings: backup.settings(), status: backup.status() }; } });
  registry.register({ name: "backup.github_inspect", permission: "github.manage", reach: "outbound", parameters: Pin,
    description: "Validate and count one exact GitHub backup id and commit. Changes no live state.",
    target: v => `owner private backup ${v.id} at ${v.commit}`,
    execute: async (v, c) => { backup.guard(c); return backup.inspect(v); } });
  registry.register({ name: "backup.github_restore_prepare", permission: "github.manage", reach: "outbound", parameters: Pin,
    description: "After one-time confirmation, prepare a validated recovery copy of an exact GitHub backup in Branch's data folder. Never replaces live state; use existing fresh-install restore and settings review.",
    target: v => `prepare recovery files for private backup ${v.id} at ${v.commit}; no live-state replacement`,
    execute: async (v, c) => { backup.guard(c); return backup.prepare(v); } });
  registry.register({ name: "backup.github_restore", permission: "github.manage", reach: "outbound", parameters: Pin,
    description: "After one-time confirmation, actually restore an exact GitHub snapshot into a new empty Branch data folder. Memory restored, skills inactive, configuration held for owner review. Cannot overwrite the running install or a chosen directory.",
    target: v => `restore private backup ${v.id} at ${v.commit} into a new empty data folder; hold configuration and skills for review`,
    execute: async (v, c) => { backup.guard(c); return backup.restoreFresh(v); } });
}
