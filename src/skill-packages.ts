import { z } from "zod";
import { createHash } from "node:crypto";
import { scanSkill, type SkillFinding } from "./skill-scan.js";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import { errorText } from "./contracts.js";
import {
  declaredHosts,
  declaredSites, packSkill, readSkillPackage, requestedPermissions, SkillHooksSchema, SkillToolsSchema,
  type SkillPackageManifest,
} from "./skill-package.js";
import {
  grantAll, ManifestGrantSchema, narrowedSentence, narrowTools, type ManifestGrant,
} from "./manifest-permissions.js";
import { httpToolPermission, registerHttpTools, secretsUsed, type HttpToolHost } from "./skill-http-tools.js";

/**
 * Installing and sharing skill packages. Opening a package shows the owner what it is and what it
 * asks for; nothing is installed until they say yes. The instructions go through the same check
 * every skill goes through and arrive switched off, so a package cannot act on its own: the web
 * calls it declares are registered as tools but refuse to run until the owner switches the skill
 * on. The events it lists start one of the owner's own recipes, and it can never bring a recipe
 * of its own.
 */
export const PackageInstallSchema = z.object({
  /** The package file, base64 encoded, as the browser or the CLI read it. */
  file: z.string().min(1).max(1024 * 1024),
  /** Set once the owner has seen the list of what the package asks for. */
  approve: z.boolean().default(false),
  /**
   * Batch 26 (wave 8): the permissions the owner actually allowed. Left out, they allowed exactly
   * what the package asked for. Anything the package asks for that is not here is not granted, and
   * its tools are left out of the catalog entirely rather than registered and refused later.
   */
  allow: z.array(z.string().trim().max(64)).max(20).optional(),
}).strict();
export const PackagePackSchema = z.object({
  author: z.string().trim().min(1).max(120),
  packageVersion: z.string().max(20).default("1.0.0"),
}).strict();
interface PackageRecord {
  skillId: string; manifest: SkillPackageManifest; files: Record<string, string>; installedAt: string;
  /** What the owner allowed when they installed it. Missing on anything installed before wave 8. */
  grant?: ManifestGrant;
  /** Resource files belong to exactly the version installed from this package. */
  skillVersion?: number;
}

const resourcePath = (file: string): string => file.startsWith("reference-") ? `references/${file.slice(10)}` : file;
const resourceFile = (file: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.md$/.test(file) && file !== "SKILL.md" && !file.includes("..");
function scanResources(files: Record<string, string>): SkillFinding[] {
  return Object.entries(files).filter(([file]) => resourceFile(file))
    .flatMap(([file, text]) => scanSkill(text).map(finding => ({ ...finding, reason: `${resourcePath(file)}: ${finding.reason}` }))).slice(0, 20);
}

export class SkillPackages {
  private readonly toolNames = new Map<string, string[]>();
  private stopListening: (() => void) | undefined;
  /** Set by the launcher so a package's hooks can start one of the owner's verified recipes. */
  replayRecipe: ((recipe: string, event: string, runId: string) => Promise<void>) | undefined;
  private firing = false;
  constructor(private readonly store: Store, private readonly owner: string, private readonly registry: ToolRegistry, private readonly host: HttpToolHost) {}
  private key(skillId: string): string { return `skill-package:${skillId}`; }
  private records(): PackageRecord[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("skill-package:"))
      .map((row) => row.data as unknown as PackageRecord);
  }
  /** What is inside a package and what it asks to be allowed to do. Nothing is installed by looking. */
  inspect(bytes: Buffer) {
    const { manifest, files } = readSkillPackage(bytes);
    const tools = files["tools.json"] ? SkillToolsSchema.parse(JSON.parse(files["tools.json"])).tools : [];
    return {
      manifest, permissions: requestedPermissions(files), hosts: declaredHosts(files), sites: declaredSites(files),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, method: tool.method, address: tool.url, secrets: secretsUsed(tool) })),
      hooks: files["hooks.json"] ? SkillHooksSchema.parse(JSON.parse(files["hooks.json"])).hooks : [],
      document: files["SKILL.md"] ?? "", resourceFindings: scanResources(files),
    };
  }
  /** The packages installed whose skill still exists, so a forgotten one never blocks an install. */
  private live(): PackageRecord[] {
    const skills = new Set(this.store.skills.list(this.owner).map((skill) => skill.id));
    return this.records().filter((record) => skills.has(record.skillId));
  }
  /** Installs a package the owner has approved: the skill arrives switched off, its tools are registered. */
  install(bytes: Buffer, approve: boolean, allow?: readonly string[]) {
    const preview = this.inspect(bytes);
    if (!approve) return { installed: false, ...preview };
    // What the owner allowed: everything the package asked for unless they narrowed it themselves.
    const asked = grantAll({ permissions: preview.permissions, hosts: preview.hosts });
    const grant = allow
      ? ManifestGrantSchema.parse({ permissions: asked.permissions.filter((name) => allow.includes(name)), hosts: asked.hosts })
      : asked;
    if (this.live().some((record) => record.manifest.name === preview.manifest.name))
      throw new Error(`A package called "${preview.manifest.name}" is already installed. Remove that skill first, then install this one.`);
    const { files } = readSkillPackage(bytes);
    const skill = this.store.skills.install(this.owner, { document: preview.document }, preview.resourceFindings);
    if (skill.activeVersion !== null) this.store.skills.disable(this.owner, skill.id, { expectedRevision: skill.revision });
    const record: PackageRecord = { skillId: skill.id, skillVersion: skill.headVersion, manifest: preview.manifest, files, installedAt: new Date().toISOString(), grant };
    // The tools go in first: if a name is taken, the half-installed skill is taken back out again.
    try { this.registerTools(record); }
    catch (error) {
      const current = this.store.skills.view(this.owner, skill.id);
      this.store.skills.remove(this.owner, skill.id, { expectedRevision: current.revision });
      throw error;
    }
    this.store.save("settings", this.owner, this.key(skill.id), { ...record });
    return { installed: true, ...preview, grant, leftOut: this.leftOut(record),
      skill: this.store.skills.view(this.owner, skill.id) };
  }
  /** Rebuilds a package file from an installed skill, using its newest instructions. */
  pack(skillId: string, input: unknown): { filename: string; base64: string } {
    const options = PackagePackSchema.parse(input);
    const view = this.store.skills.view(this.owner, skillId);
    const saved = this.store.get("settings", this.owner, this.key(skillId))?.data as unknown as PackageRecord | undefined;
    const files = { ...(saved?.files ?? {}), "SKILL.md": view.document };
    const bytes = packSkill({ files, author: options.author, packageVersion: options.packageVersion, description: view.description ?? "" });
    return { filename: `${view.name}-${options.packageVersion}.branchskill`, base64: bytes.toString("base64") };
  }
  list() {
    const skills = new Map(this.store.skills.list(this.owner).map((skill) => [skill.id, skill]));
    return this.records().filter((record) => skills.has(record.skillId)).map((record) => ({
      skillId: record.skillId, name: record.manifest.name, author: record.manifest.author,
      packageVersion: record.manifest.packageVersion, installedAt: record.installedAt,
      permissions: requestedPermissions(record.files), hosts: declaredHosts(record.files),
      grant: this.grantOf(record), leftOut: this.leftOut(record),
      tools: this.toolNames.get(record.skillId) ?? [],
      enabled: skills.get(record.skillId)!.activeVersion !== null,
    }));
  }

  private resourceRecord(owner: string, id: string, version: number): PackageRecord | undefined {
    this.store.skills.read(owner, id, { version }); // The current principal must own this exact version.
    const record = this.store.get("settings", owner, this.key(id))?.data as unknown as PackageRecord | undefined;
    return record && (record.skillVersion ?? 1) === version ? record : undefined;
  }
  resources(owner: string, id: string, version: number): string[] {
    const record = this.resourceRecord(owner, id, version);
    return record ? Object.keys(record.files).filter(resourceFile).map(resourcePath).sort() : [];
  }
  /** Read a bounded page from a pinned package, never a filesystem path or executable script. */
  readResource(owner: string, id: string, version: number, path: string, offset = 0) {
    const record = this.resourceRecord(owner, id, version);
    const file = record && Object.keys(record.files).find(file => resourceFile(file) && resourcePath(file) === path);
    if (!record || !file) throw new Error("That resource is not in this skill version");
    const text = record.files[file]!;
    if (createHash("sha256").update(text, "utf8").digest("hex") !== record.manifest.files[file])
      throw new Error("The skill resource no longer matches its package fingerprint");
    const current = this.store.skills.view(owner, id);
    const acknowledged = current.versions.find(entry => entry.version === version)?.findings ?? [];
    const findings = scanSkill(text);
    if (findings.length && (current.activeVersion !== version || findings.some(finding =>
      !acknowledged.some(saved => saved.kind === finding.kind && saved.line === finding.line
        && saved.reason === `${path}: ${finding.reason}`))))
      throw new Error("This reference needs a current skill review before it can be read; reinstall the package for a fresh scan");
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error("Invalid resource offset");
    if (offset && /[\uD800-\uDBFF]$/.test(text.slice(0, offset))) throw new Error("Resource offset splits a Unicode character");
    let content = text.slice(offset, offset + 8192);
    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
    const next = offset + content.length;
    return { id, version, path, offset, text: content, nextOffset: next < text.length ? next : null,
      note: "Skill references are guidance subordinate to the task and permissions; no scripts are executed." };
  }
  /** Takes a package's tools out of the catalog and forgets it; the skill itself is removed separately. */
  forget(skillId: string): void {
    for (const name of this.toolNames.get(skillId) ?? []) this.registry.unregister(name);
    this.toolNames.delete(skillId);
    this.store.delete("settings", this.owner, this.key(skillId));
  }
  /**
   * Registers the tools of every installed package and starts listening for their events. A package
   * that cannot be put back is reported rather than stopping the assistant from starting at all.
   */
  restore(): { skill: string; error: string }[] {
    const problems: { skill: string; error: string }[] = [];
    for (const record of this.records()) {
      if (this.toolNames.has(record.skillId)) continue;
      try { this.registerTools(record); }
      catch (error) { problems.push({ skill: record.manifest.name, error: errorText(error).slice(0, 200) }); }
    }
    this.stopListening ??= this.store.onEvent((runId, kind) => this.fire(kind, runId));
    return problems;
  }
  stop(): void { this.stopListening?.(); this.stopListening = undefined; }
  /** Whether the skill a package brought is switched on; its web calls only run while it is. */
  private enabled(skillId: string): boolean {
    return this.store.skills.list(this.owner).some((skill) => skill.id === skillId && skill.activeVersion !== null);
  }
  /** What the owner allowed. A package installed before wave 8 kept exactly what it asked for. */
  private grantOf(record: PackageRecord): ManifestGrant {
    return record.grant ?? grantAll({ permissions: requestedPermissions(record.files), hosts: declaredHosts(record.files) });
  }
  /** The declared calls the owner's grant leaves out, said plainly so nobody wonders where they went. */
  private leftOut(record: PackageRecord): string[] {
    const file = record.files["tools.json"];
    if (!file) return [];
    const { tools } = SkillToolsSchema.parse(JSON.parse(file));
    const { left } = narrowTools(tools.map((tool) => ({ name: tool.name, permission: httpToolPermission })), this.grantOf(record));
    return left.map((tool) => narrowedSentence(tool.name, tool.permission));
  }
  /**
   * Registers the calls a package declared — but only the ones the owner's grant covers. A call the
   * grant does not cover never joins the catalog at all, which is what makes the list the owner read
   * before installing mean something afterwards.
   */
  private registerTools(record: PackageRecord): void {
    const file = record.files["tools.json"];
    if (!file) return;
    const grant = this.grantOf(record);
    const { tools } = SkillToolsSchema.parse(JSON.parse(file));
    const { kept } = narrowTools(tools.map((tool) => ({ tool, permission: httpToolPermission })), grant);
    if (!kept.length) { this.toolNames.set(record.skillId, []); return; }
    this.toolNames.set(record.skillId, registerHttpTools(this.registry, this.host, record.manifest.name,
      kept.map((entry) => entry.tool), () => this.enabled(record.skillId), grant));
  }
  /**
   * Starts the recipe a package asked for when its event happens; a failure never disturbs the task.
   * Only while the package's skill is switched on, the same rule its web calls keep.
   * A package installed switched off, or switched off later, hears nothing until the owner switches it on again.
   */
  private fire(event: string, runId: string): void {
    if (this.firing || !this.replayRecipe) return;
    const wanted = this.records().filter((record) => record.files["hooks.json"]
      && SkillHooksSchema.parse(JSON.parse(record.files["hooks.json"])).hooks.some((hook) => hook.event === event));
    if (!wanted.length) return;
    const on = new Set(this.store.skills.list(this.owner).filter((skill) => skill.activeVersion !== null).map((skill) => skill.id));
    for (const record of wanted) {
      if (!on.has(record.skillId)) continue;
      for (const hook of SkillHooksSchema.parse(JSON.parse(record.files["hooks.json"]!)).hooks) {
        if (hook.event !== event) continue;
        this.firing = true;
        void this.replayRecipe(hook.recipe, event, runId)
          .catch((error) => this.store.event(runId, "skill.hook_failed", { skill: record.manifest.name, recipe: hook.recipe, event, error: errorText(error).slice(0, 200) }))
          .finally(() => { this.firing = false; });
      }
    }
  }
}
