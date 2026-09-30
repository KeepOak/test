import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Store } from "./store.js";
import { pluginId, type Plugins } from "./plugins.js";
import { PluginCatalog, readPluginOffer, pluginSourceHash } from "./plugin-catalog.js";
import { WalledPlugins, type WalledPluginOptions } from "./add-ons/walled-plugin.js";
import { readOffer, readPackageSource, sha256 } from "./add-ons/formats.js";
import type { AddOnShelf } from "./add-ons/package-shelf.js";
import { checkApiVersion } from "./add-ons/sdk.js";

const value = z.union([z.string(), z.number(), z.boolean()]);
const fixture = z.object({ id: z.string().min(1).max(80), tool: z.string().min(1).max(80),
  args: z.record(z.string(), value).default({}), expected: z.unknown() }).strict()
  .refine(row => Object.hasOwn(row, "expected"), "Every fixture needs an expected result.");
export const PluginSuiteSchema = z.object({ id: z.string().min(1).max(80), cases: z.array(fixture).min(1).max(30) }).strict()
  .refine(suite => new Set(suite.cases.map(row => row.id)).size === suite.cases.length, "Fixture ids must be unique.");
export const PluginEvaluateSchema = z.object({ id: pluginId, source: z.string().min(1).max(1000), suite: PluginSuiteSchema,
  kind: z.enum(["catalog", "add-on"]).optional() }).strict();
type Suite = z.infer<typeof PluginSuiteSchema>;
interface Source { id: string; code: string; sha256: string; sourceHash: string; permissions: string[]; hosts: string[]; kind: "catalog" | "add-on" }
interface Score { passed: number; total: number; cases: { id: string; passed: boolean; error?: string }[] }
export interface PluginEvaluation {
  id: string; pluginId: string; source: string; kind: Source["kind"]; createdAt: string;
  baselineHash: string; candidateHash: string; baselineSourceHash: string; candidateSourceHash: string;
  suite: Suite; suiteHash: string; grantsHash: string; baseline: Score; candidate: Score; passed: boolean;
  candidatePermissions: string[]; candidateHosts: string[];
  baselineUnavailable: boolean;
}
export interface PluginEvaluationOptions {
  store: Store; owner: string; catalog: PluginCatalog; plugins: Plugins; shelf: AddOnShelf;
  wall: Pick<WalledPluginOptions, "unreadable" | "spawn" | "wallDeps" | "timeoutMs">;
}
const digest = (value: unknown): string => sha256(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

/** Installed plugin comparisons: staged code only; no global registry, hooks, providers or channels. */
export class PluginEvaluations {
  private readonly busy = new Set<string>();
  constructor(private readonly options: PluginEvaluationOptions) {}
  private rows(id: string): PluginEvaluation[] {
    return this.options.store.list("settings", this.options.owner).filter(row => row.id.startsWith(`plugin-evaluation:${id}:`))
      .map(row => row.data as unknown as PluginEvaluation);
  }
  async status(id: string) {
    pluginId.parse(id);
    const current = await this.installed(id);
    const versions = current?.kind === "add-on" ? this.options.shelf.versions(id) : await this.options.catalog.versions(id);
    return { id, currentSha256: current?.sourceHash ?? null, kind: current?.kind ?? "catalog", pending: this.pending(id), evaluations: this.rows(id), versions,
      activation: "Promotion and restore leave the plugin switched off. Network access requires the existing separate activation approval." };
  }
  private grants(id: string): string[] { return this.options.plugins.granted(id).sort(); }
  private pending(id: string): boolean { return this.options.store.get("settings", this.options.owner, `plugin-review:${id}`)?.data.pending === true; }
  private async installed(id: string): Promise<Source | null> {
    try { return await this.current(id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async current(id: string): Promise<Source> {
    const record = this.options.shelf.record(id);
    if (record) {
      const offer = readOffer(await this.options.shelf.currentFiles(id));
      if (!offer.plugin) throw new Error("This add-on has no executable plugin to evaluate.");
      return { id, code: offer.plugin.code, sha256: offer.sha256, sourceHash: offer.sha256,
        permissions: offer.plugin.permissions, hosts: offer.plugin.hosts, kind: "add-on" };
    }
    const { entry, code } = await this.options.catalog.current(id);
    return { id, code, sha256: entry.sha256, sourceHash: pluginSourceHash(entry, code), permissions: entry.permissions, hosts: [], kind: "catalog" };
  }
  private async candidate(source: string, kind: Source["kind"]): Promise<Source> {
    if (kind === "add-on") {
      const offer = readOffer(await readPackageSource(source));
      if (!offer.plugin) throw new Error("Candidate package has no executable plugin.");
      return { id: offer.id, code: offer.plugin.code, sha256: offer.sha256, sourceHash: offer.sha256,
        permissions: offer.plugin.permissions, hosts: offer.plugin.hosts, kind };
    }
    const { offer, code } = await readPluginOffer(source);
    if (!offer.matchesDeclared) throw new Error("Candidate does not match its declared fingerprint.");
    return { id: offer.manifest.id, code, sha256: offer.sha256, sourceHash: pluginSourceHash(offer.manifest, code),
      permissions: offer.manifest.permissions, hosts: [], kind };
  }
  private async exclusive<T>(id: string, run: () => Promise<T>, mutation = false): Promise<T> {
    if (this.busy.has(id)) throw new Error("A lifecycle operation is already running for this plugin.");
    this.busy.add(id);
    let release: (() => void) | undefined;
    try { if (mutation) release = this.options.plugins.holdLifecycle?.(id); return await run(); }
    finally { release?.(); this.busy.delete(id); }
  }
  async evaluate(input: unknown): Promise<PluginEvaluation> {
    const body = PluginEvaluateSchema.parse(input);
    return this.exclusive(body.id, async () => {
      const baseline = await this.installed(body.id), candidate = await this.candidate(body.source, baseline?.kind ?? body.kind ?? "catalog");
      if (candidate.id !== body.id) throw new Error("Candidate names a different plugin.");
      const grants = this.grants(body.id);
      const baselineUnavailable = !baseline || this.pending(body.id);
      const permissions = baselineUnavailable ? candidate.permissions : grants.filter(p => baseline!.permissions.includes(p) && candidate.permissions.includes(p));
      const before = baselineUnavailable ? { passed: 0, total: body.suite.cases.length,
        cases: body.suite.cases.map(task => ({ id: task.id, passed: false, error: "No previously approved baseline is installed." })) }
        : await this.score(baseline!, body.suite, permissions);
      const after = await this.score(candidate, body.suite, permissions);
      const record: PluginEvaluation = { id: randomUUID(), pluginId: body.id, source: body.source, kind: candidate.kind,
        createdAt: new Date().toISOString(), baselineHash: baseline?.sha256 ?? "", candidateHash: candidate.sha256,
        baselineSourceHash: baseline?.sourceHash ?? "", candidateSourceHash: candidate.sourceHash, baselineUnavailable,
        suite: body.suite, suiteHash: digest(body.suite), grantsHash: digest(grants), baseline: before, candidate: after,
        candidatePermissions: candidate.permissions, candidateHosts: candidate.hosts,
        passed: after.passed === after.total && after.total > 0 && after.passed >= before.passed };
      this.options.store.save("settings", this.options.owner, `plugin-evaluation:${body.id}:${record.id}`, { ...record });
      return record;
    });
  }
  private async score(source: Source, suite: Suite, permissions: string[]): Promise<Score> {
    const root = await mkdtemp(join(tmpdir(), "branch-plugin-eval-"));
    const cases: Score["cases"] = [];
    try {
      const file = join(root, `${source.id}.mjs`); await writeFile(file, source.code, { mode: 0o600 });
      const host = new WalledPlugins({ ...this.options.wall, evaluation: true,
        policy: () => ({ walled: true, hosts: [], sha256: sha256(source.code), permissions }) });
      const plugin = await host.load(source.id, file);
      checkApiVersion(plugin.apiVersion, `The plugin ${source.id}`);
      if (plugin.id !== source.id) throw new Error("Executable plugin id differs from its manifest.");
      for (const task of suite.cases) {
        try {
          const tool = plugin.tools?.find(tool => tool.name === task.tool && permissions.includes(tool.permission));
          if (!tool) throw new Error("Fixture tool is missing or outside the current permission intersection.");
          const result = await tool.run(task.args, { runId: "plugin-evaluation" } as never);
          cases.push({ id: task.id, passed: isDeepStrictEqual(result, task.expected) });
        } catch (error) { cases.push({ id: task.id, passed: false, error: String(error).slice(0, 500) }); }
      }
    } catch (error) {
      for (const task of suite.cases) cases.push({ id: task.id, passed: false, error: String(error).slice(0, 500) });
    } finally { await rm(root, { recursive: true, force: true }); }
    return { passed: cases.filter(row => row.passed).length, total: suite.cases.length, cases };
  }
  async promote(id: string, evaluationId: string) {
    pluginId.parse(id);
    return this.exclusive(id, async () => {
      const evidence = this.rows(id).find(row => row.id === evaluationId);
      if (!evidence?.passed || !evidence.candidate.total || evidence.candidate.passed !== evidence.candidate.total ||
        evidence.candidate.cases.some(row => !row.passed) || evidence.candidate.cases.length !== evidence.candidate.total)
        throw new Error("Promotion requires a complete successful executable evaluation.");
      const suite = PluginSuiteSchema.parse(evidence.suite);
      const current = await this.installed(id), candidate = await this.candidate(evidence.source, current?.kind ?? evidence.kind);
      if (digest(suite) !== evidence.suiteHash || digest(this.grants(id)) !== evidence.grantsHash ||
        (current?.sourceHash ?? "") !== evidence.baselineSourceHash || candidate.sourceHash !== evidence.candidateSourceHash || candidate.id !== id)
        throw new Error("Source, suite or owner permissions changed; evaluate again before promotion.");
      this.options.plugins.disable(id);
      const result = await this.installEvidence(id, evidence, current);
      this.options.store.delete("settings", this.options.owner, `plugin-review:${id}`);
      return result;
    }, true);
  }
  private async installEvidence(id: string, evidence: PluginEvaluation, current: Source | null) {
    if (current && this.pending(id) && current.sourceHash === evidence.candidateSourceHash)
      return current.kind === "add-on" ? this.options.shelf.record(id)! : (await this.options.catalog.current(id)).entry;
    const origin = evidence.kind === "add-on" ? this.options.shelf.candidateOrigin(id, evidence.source, evidence.candidateHash) : undefined;
    if (!current) return evidence.kind === "add-on"
      ? this.options.shelf.install(evidence.source, { expectSha256: evidence.candidateHash, ...(origin ? { origin } : {}) })
      : this.options.catalog.install(evidence.source, { expectSha256: evidence.candidateHash, expectSourceHash: evidence.candidateSourceHash });
    return current.kind === "add-on"
      ? this.options.shelf.replace(id, evidence.source, evidence.baselineHash, evidence.candidateHash, { evaluated: true, ...(origin ? { origin } : {}) })
      : this.options.catalog.replace(evidence.source, evidence.baselineHash, evidence.candidateHash,
        { current: evidence.baselineSourceHash, candidate: evidence.candidateSourceHash });
  }
  async restore(id: string, sha256: string, expectedCurrent: string) {
    pluginId.parse(id);
    return this.exclusive(id, async () => {
      const current = await this.current(id);
      if (current.sourceHash !== expectedCurrent) throw new Error("Installed plugin changed before restore.");
      const approved = this.rows(id).some(row => row.passed && (row.candidateSourceHash === sha256 ||
        (!row.baselineUnavailable && row.baselineSourceHash === sha256)));
      if (!approved) throw new Error("That retained version has no successful evaluation or previously approved baseline.");
      this.options.plugins.disable(id);
      const result = await (current.kind === "add-on" ? this.options.shelf.restore(id, sha256, expectedCurrent)
        : this.options.catalog.restore(id, sha256, expectedCurrent));
      this.options.store.delete("settings", this.options.owner, `plugin-review:${id}`);
      return result;
    }, true);
  }
}
