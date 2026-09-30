import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { skillAvailability } from "./skill-availability.js";
import { SkillScanPolicySchema, describeFindings, scanSkill, type SkillFinding, type SkillScanPolicy } from "./skill-scan.js";
import {
  parseSkillDocument, skillDocumentInput, skillRevisionInput, skillVersionInput,
  type SkillMetadata,
} from "./skill-document.js";

type Row = Record<string, unknown>;
export interface SkillCatalogEntry { id: string; version: number; name: string; description: string }
export class InstalledSkills {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS installed_skills(
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL,
      head_version INTEGER NOT NULL, active_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_versions(
      skill_id TEXT NOT NULL REFERENCES installed_skills(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, document TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(skill_id,version));`);
    if (!db.prepare("PRAGMA table_info(skill_versions)").all().some((row) => row.name === "scan"))
      db.exec("ALTER TABLE skill_versions ADD COLUMN scan TEXT NOT NULL DEFAULT '[]'");
  }
  /** The owner's choice for risky skills: block them (default) or hold them for review. */
  policy(owner: string): SkillScanPolicy {
    const row = this.db.prepare("SELECT data FROM settings WHERE owner=? AND id='skill-scan'").get(owner);
    const parsed = SkillScanPolicySchema.safeParse(row ? JSON.parse(String(row.data)) : {});
    return parsed.success ? parsed.data.policy : "block";
  }
  private scanned(owner: string, document: string): SkillFinding[] {
    const findings = scanSkill(document);
    if (findings.length && this.policy(owner) === "block")
      throw new Error(`This skill was not saved because it ${describeFindings(findings)}. Change the skill, or set the skill policy to review.`);
    return findings;
  }
  private row(owner: string, id: string): Row {
    const row = this.db.prepare("SELECT * FROM installed_skills WHERE owner=? AND id=?").get(owner, id);
    if (!row) throw new Error("Skill not found");
    return row;
  }
  private version(id: string, version: number) {
    const row = this.db.prepare("SELECT * FROM skill_versions WHERE skill_id=? AND version=?").get(id, version);
    if (!row) throw new Error("Skill version not found");
    return { id, version, document: String(row.document), metadata: JSON.parse(String(row.metadata)) as SkillMetadata,
      createdAt: String(row.created_at), findings: JSON.parse(String(row.scan ?? "[]")) as SkillFinding[] };
  }
  private summary(row: Row) {
    const id = String(row.id), head = this.version(id, Number(row.head_version));
    const activeVersion = row.active_version === null ? null : Number(row.active_version);
    return { id, revision: Number(row.revision), name: head.metadata.name, description: head.metadata.description,
      headVersion: head.version, activeVersion, findings: head.findings, needsReview: head.findings.length > 0 && activeVersion !== head.version,
      availability: skillAvailability((activeVersion === null ? head : this.version(id, activeVersion)).metadata.metadata),
      activeName: activeVersion === null ? null : this.version(id, activeVersion).metadata.name };
  }
  list(owner: string) {
    return this.db.prepare("SELECT * FROM installed_skills WHERE owner=? ORDER BY created_at,id")
      .all(owner).map(row => this.summary(row));
  }
  view(owner: string, id: string) {
    const summary = this.summary(this.row(owner, id));
    const versions = this.db.prepare("SELECT version FROM skill_versions WHERE skill_id=? ORDER BY version DESC")
      .all(id).map(row => {
        const entry = this.version(id, Number(row.version));
        return { version: entry.version, name: entry.metadata.name, description: entry.metadata.description, createdAt: entry.createdAt, findings: entry.findings };
      });
    return { ...summary, document: this.version(id, summary.headVersion).document, versions };
  }
  read(owner: string, id: string, input: unknown) {
    this.row(owner, id);
    const { version } = skillVersionInput.parse(input);
    const entry = this.version(id, version);
    return { id, version, metadata: entry.metadata, document: entry.document };
  }
  catalog(owner: string, includeUnavailable = false): SkillCatalogEntry[] {
    return this.db.prepare("SELECT id,active_version FROM installed_skills WHERE owner=? AND active_version IS NOT NULL ORDER BY id")
      .all(owner).flatMap(row => {
        const entry = this.version(String(row.id), Number(row.active_version));
        if (!includeUnavailable && !skillAvailability(entry.metadata.metadata).available) return [];
        return [{ id: entry.id, version: entry.version, name: entry.metadata.name, description: entry.metadata.description }];
      });
  }
  install(owner: string, input: unknown) {
    const { document } = skillDocumentInput.parse(input), metadata = parseSkillDocument(document);
    const findings = this.scanned(owner, document);
    return this.transaction(() => {
      if (this.list(owner).length >= 50) throw new Error("At most 50 installed skills");
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare("INSERT INTO installed_skills VALUES(?,?,1,1,?,?,?)").run(id, owner, findings.length ? null : 1, now, now);
      this.insertVersion(id, 1, document, metadata, now, findings);
      this.validateCatalog(owner);
      return this.view(owner, id);
    });
  }
  update(owner: string, id: string, input: unknown) {
    const parsed = skillDocumentInput.merge(skillRevisionInput).parse(input);
    const metadata = parseSkillDocument(parsed.document);
    const findings = this.scanned(owner, parsed.document);
    return this.transaction(() => {
      const row = this.expected(owner, id, parsed.expectedRevision), version = Number(row.head_version) + 1;
      if (version > 20) throw new Error("At most 20 retained versions; install a new skill to continue");
      const now = new Date().toISOString();
      this.insertVersion(id, version, parsed.document, metadata, now, findings);
      this.db.prepare("UPDATE installed_skills SET head_version=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(version, now, id);
      return this.view(owner, id);
    });
  }
  activate(owner: string, id: string, input: unknown) {
    const parsed = skillVersionInput.merge(skillRevisionInput).extend({ acknowledge: z.boolean().optional() }).parse(input);
    return this.transaction(() => {
      this.expected(owner, id, parsed.expectedRevision);
      const { findings } = this.version(id, parsed.version);
      if (findings.length && this.policy(owner) === "block")
        throw new Error(`This version cannot be enabled under your skill policy: it ${describeFindings(findings)}.`);
      if (findings.length && !parsed.acknowledge)
        throw new Error(`This version needs your review first: it ${describeFindings(findings)}. Tick the acknowledgement to enable it anyway.`);
      this.select(id, parsed.version);
      this.validateCatalog(owner);
      return this.view(owner, id);
    });
  }
  disable(owner: string, id: string, input: unknown) {
    const { expectedRevision } = skillRevisionInput.parse(input);
    return this.transaction(() => {
      this.expected(owner, id, expectedRevision);
      this.select(id, null);
      return this.view(owner, id);
    });
  }
  remove(owner: string, id: string, input: unknown) {
    const { expectedRevision } = skillRevisionInput.parse(input);
    return this.transaction(() => {
      this.expected(owner, id, expectedRevision);
      this.db.prepare("DELETE FROM installed_skills WHERE owner=? AND id=?").run(owner, id);
      return { removed: true };
    });
  }
  private expected(owner: string, id: string, revision: number) {
    const row = this.row(owner, id);
    if (Number(row.revision) !== revision) throw new Error("Skill changed; reload before saving (stale revision)");
    return row;
  }
  private select(id: string, version: number | null): void {
    this.db.prepare("UPDATE installed_skills SET active_version=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(version, new Date().toISOString(), id);
  }
  private insertVersion(id: string, version: number, document: string, metadata: SkillMetadata, now: string, findings: SkillFinding[]) {
    this.db.prepare("INSERT INTO skill_versions(skill_id,version,document,metadata,created_at,scan) VALUES(?,?,?,?,?,?)")
      .run(id, version, document, JSON.stringify(metadata), now, JSON.stringify(findings));
  }
  private validateCatalog(owner: string): void {
    const catalog = this.catalog(owner, true);
    // Fifty, as many as can be installed: a skill on "load when needed" costs one short line of a request, not its whole
    // description, so the old limit of twenty (there to keep requests small) no longer has to hold skills back.
    if (catalog.length > 50) throw new Error("At most 50 enabled skills");
    if (new Set(catalog.map(entry => entry.name)).size !== catalog.length)
      throw new Error("An enabled skill already uses that name");
    if (Buffer.byteLength(JSON.stringify(catalog), "utf8") > 64 * 1024)
      throw new Error("Enabled skill metadata catalog exceeds 64 KiB");
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
