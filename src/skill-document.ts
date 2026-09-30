import { parseDocument } from "yaml";
import { z } from "zod";
import { normalizeSkillMetadata } from "./skill-metadata.js";

export const skillDocumentLimit = 16000;
export const skillMetadataSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
  license: z.string().max(1024).optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string().min(1).max(128), z.string().max(1024))
    .refine(value => Object.keys(value).length <= 32, "At most 32 metadata entries").optional(),
  "allowed-tools": z.string().max(2048).optional(),
}).strict();
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export const skillDocumentInput = z.object({ document: z.string().max(skillDocumentLimit) }).strict();
export const skillRevisionInput = z.object({ expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1) }).strict();
export const skillVersionInput = z.object({ version: z.number().int().min(1).max(20) }).strict();

export function parseSkillDocument(document: string): SkillMetadata {
  if (document.length > skillDocumentLimit || Buffer.byteLength(document, "utf8") > 48 * 1024)
    throw new Error("Skill document must be at most 16000 characters and 48 KiB");
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(document);
  if (!match) throw new Error("Skill document needs YAML frontmatter between --- lines");
  if (match[1]!.length > 8192) throw new Error("Skill metadata exceeds 8192 characters");
  if (!match[2]!.trim()) throw new Error("Skill instructions cannot be empty");
  const parsed = parseDocument(match[1]!, { strict: true, uniqueKeys: true });
  if (parsed.errors.length || parsed.warnings.length) throw new Error("Invalid skill YAML metadata");
  const metadata = skillMetadataSchema.parse(normalizeSkillMetadata(parsed.toJS({ maxAliasCount: 0 })));
  if (JSON.stringify({ document, metadata }).length > 60000)
    throw new Error("Encoded skill document exceeds the tool response limit");
  return metadata;
}
