import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { audit } from "./audit.js";
import { zipRead, zipWrite, type ZipLimits } from "./skill-package.js";
import { recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import type { ChangeOrigin } from "./settings-kit/history.js";

/**
 * Handing the assistant itself to someone else, or to another computer. One file holds the
 * specialists, the saved procedures, the installed skills, which model does what, the approval
 * rules, and — only if it is asked for — what the assistant remembers.
 *
 * Nothing that is a secret ever goes in. The locker is not read at all, and everything written is
 * put through the same scrubber that keeps saved passwords out of the event log, so a fact that
 * happens to quote a key comes out with the key replaced by its name.
 */
export const agentSections = ["specialists", "procedures", "skills", "routing", "permissions", "memory"] as const;
export type AgentSection = (typeof agentSections)[number];
export const agentManifestEntry = "branch-agent.json";
export const agentZipLimits: ZipLimits = { entries: 12, entryBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 };

export const AgentManifestSchema = z.object({
  format: z.literal("branch-agent"),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  appVersion: z.string().max(40),
  /** What is inside, so the person sees the list before anything is brought in. */
  sections: z.array(z.object({
    name: z.enum(agentSections),
    items: z.number().int().nonnegative(),
    file: z.string().max(80),
    sha256: z.string().length(64),
    /** One line the person can read, such as "3 specialists". */
    summary: z.string().max(200),
  })).max(agentSections.length),
  /** True when the memory section was written with personal details taken out. */
  memoryRedacted: z.boolean().default(false),
}).strict();
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const settingKeys: Record<"routing" | "permissions", string[]> = {
  routing: ["routing", "model-profiles", "models"],
  permissions: ["policy", "governance", "ask-first"],
};

export interface ExportOptions {
  /** Include what the assistant remembers. Off unless the person asks for it. */
  memory?: boolean;
  /** Take personal details out of remembered facts on the way out. */
  redact?: (text: string) => string;
  /** p17 (whole-agent export from the window): only these sections; every section when left out. */
  sections?: readonly AgentSection[];
}

/** Everything one section holds, as the text that goes into the file. */
function sectionData(store: Store, owner: string, section: AgentSection, options: ExportOptions): { items: number; text: string; summary: string } {
  if (section === "specialists" || section === "procedures") {
    const records = store.list(section, owner).map((record) => ({ id: record.id, data: record.data }));
    return { items: records.length, text: JSON.stringify(records), summary: `${records.length} ${section === "specialists" ? "specialist" : "saved procedure"}${records.length === 1 ? "" : "s"}` };
  }
  if (section === "skills") {
    const skills = store.skills.catalog(owner).map((entry) => ({
      name: entry.name, document: String((store.skills.read(owner, entry.id, { version: entry.version }) as { document?: unknown }).document ?? ""),
    }));
    return { items: skills.length, text: JSON.stringify(skills), summary: `${skills.length} skill${skills.length === 1 ? "" : "s"}` };
  }
  if (section === "memory") {
    // p17: the memory archive keeps its facts under "records" (src/memory.ts); "facts" read nothing.
    const exported = store.exportMemory(owner) as { records?: unknown[]; facts?: unknown[] } | unknown[];
    const facts = Array.isArray(exported) ? exported : (exported.records ?? exported.facts ?? []);
    const text = options.redact ? options.redact(JSON.stringify(facts)) : JSON.stringify(facts);
    return { items: facts.length, text, summary: `${facts.length} remembered fact${facts.length === 1 ? "" : "s"}` };
  }
  const keys = settingKeys[section];
  const found = keys.map((key) => ({ key, data: store.get("settings", owner, key)?.data ?? null })).filter((entry) => entry.data !== null);
  const what = section === "routing" ? "model choice" : "approval rule";
  return { items: found.length, text: JSON.stringify(found), summary: `${found.length} saved ${what} setting${found.length === 1 ? "" : "s"}` };
}

/**
 * p17 (whole-agent export from the window): what each section would hold, counted and named the way
 * the file's manifest names it, without writing a file or a record. Memory is counted, not read out.
 */
export function agentSummary(store: Store, owner: string): { name: AgentSection; items: number; summary: string }[] {
  return agentSections.map((section) => {
    const { items, summary } = sectionData(store, owner, section, {});
    return { name: section, items, summary };
  });
}

/** Writes the one file. The locker is never touched, so no secret can be inside it. */
export function exportAgent(store: Store, owner: string, appVersion: string, options: ExportOptions = {}): { bytes: Buffer; manifest: AgentManifest } {
  const entries: [string, string][] = [];
  const sections: AgentManifest["sections"] = [];
  for (const section of agentSections) {
    if (section === "memory" && !options.memory) continue;
    if (options.sections && !options.sections.includes(section)) continue;
    const collected = sectionData(store, owner, section, options);
    const { items, summary } = collected;
    const text = store.secrets.scrubber.text(collected.text);
    const file = `${section}.json`;
    entries.push([file, text]);
    sections.push({ name: section, items, file, sha256: sha256(text), summary });
  }
  const manifest: AgentManifest = {
    format: "branch-agent", version: 1, exportedAt: new Date().toISOString(),
    appVersion: appVersion.slice(0, 40), sections, memoryRedacted: !!(options.memory && options.redact),
  };
  // Batch 20 (wave 8): handing the whole assistant to somebody else is the largest export there
  // is, so it is written into the record of what it was allowed to do like every smaller one.
  audit(store, owner, {
    action: "data.exported", actor: owner, subject: "the whole assistant, as one file",
    reason: `${sections.map((section) => section.name).join(", ")}${options.memory ? "" : "; what it remembers was left out"}`,
    outcome: "saved",
  });
  return { bytes: zipWrite([[agentManifestEntry, JSON.stringify(manifest, null, 1)], ...entries]), manifest };
}

export interface OpenedAgent { manifest: AgentManifest; files: Map<string, string> }

/** Opens the file and checks every part against the fingerprint in its manifest. */
export function openAgent(bytes: Buffer): OpenedAgent {
  if (bytes.byteLength > agentZipLimits.totalBytes) throw new Error("That file is larger than an exported assistant may be.");
  const files = zipRead(bytes, agentZipLimits);
  const text = files.get(agentManifestEntry);
  if (!text) throw new Error("That file is not an exported assistant (no branch-agent.json inside).");
  const manifest = AgentManifestSchema.parse(JSON.parse(text));
  for (const section of manifest.sections) {
    const body = files.get(section.file);
    if (body === undefined) throw new Error(`${section.file} is named in the manifest but missing from the file.`);
    if (sha256(body) !== section.sha256) throw new Error(`${section.file} does not match its fingerprint, so nothing was brought in.`);
  }
  return { manifest, files };
}

export interface AgentImportReport { section: AgentSection; brought: number; note: string }

/** How a settings change made by bringing in an assistant file is written down when the caller does not say. */
const importedFrom: ChangeOrigin = { writer: "unknown", source: "import", detail: "an assistant file" };

/**
 * Brings in only the sections that were chosen; anything not chosen is left where it is. `origin`
 * is who brought the file in, for the change record of any Settings setting it replaces (Q48).
 */
export function importAgent(store: Store, owner: string, opened: OpenedAgent, chosen: readonly AgentSection[],
  origin: ChangeOrigin = importedFrom): AgentImportReport[] {
  const wanted = new Set(chosen);
  const reports: AgentImportReport[] = [];
  for (const section of opened.manifest.sections) {
    if (!wanted.has(section.name)) { reports.push({ section: section.name, brought: 0, note: "left out" }); continue; }
    const parsed = JSON.parse(opened.files.get(section.file)!) as unknown;
    reports.push(bringIn(store, owner, section.name, parsed, origin));
  }
  return reports;
}

function bringIn(store: Store, owner: string, section: AgentSection, parsed: unknown, origin: ChangeOrigin): AgentImportReport {
  const rows = Array.isArray(parsed) ? parsed : [];
  if (section === "specialists" || section === "procedures") {
    for (const row of rows.slice(0, 500)) {
      const record = row as { id?: unknown; data?: unknown };
      if (typeof record.id === "string" && record.data && typeof record.data === "object")
        store.save(section, owner, record.id, record.data as Record<string, unknown>);
    }
    return { section, brought: rows.length, note: "added, replacing any with the same name" };
  }
  if (section === "skills") return bringInSkills(store, owner, rows);
  if (section === "memory") {
    // p17: the facts go back in as the memory archive they came out of (src/memory.ts parseMemoryArchive).
    const result = store.importMemory(owner, { format: "branch-agent-memory", version: 1, exportedAt: new Date().toISOString(), records: rows }) as { imported?: number } | undefined;
    return { section, brought: Number(result?.imported ?? rows.length), note: "added to what is already remembered" };
  }
  // Q48: "When to check with me" is a Settings setting, so replacing it is written down like any change.
  recordedWrite(store, owner, origin, ["policy"], () => {
    for (const row of rows.slice(0, 20)) {
      const entry = row as { key?: unknown; data?: unknown };
      if (typeof entry.key === "string" && settingKeys[section as "routing" | "permissions"].includes(entry.key) && entry.data && typeof entry.data === "object")
        store.save("settings", owner, entry.key, entry.data as Record<string, unknown>);
    }
  });
  return { section, brought: rows.length, note: "replaced the settings of the same name" };
}

/** A skill arrives as its own document, so it is installed the ordinary way and scanned as usual. */
function bringInSkills(store: Store, owner: string, rows: unknown[]): AgentImportReport {
  let brought = 0;
  for (const row of rows.slice(0, 50)) {
    const skill = row as { document?: unknown };
    if (typeof skill.document !== "string" || !skill.document.trim()) continue;
    try { store.skills.install(owner, { document: skill.document }); brought++; } catch { /* one bad skill does not stop the rest */ }
  }
  return { section: "skills", brought, note: `${brought} of ${rows.length} installed; each was scanned as usual` };
}
