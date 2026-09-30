const fields = new Set(["name", "description", "license", "compatibility", "allowed-tools"]);

/** Keep extensions as bounded string metadata, without weakening the standard fields. */
export function normalizeSkillMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Skill metadata must be an object");
  const standard: Record<string, unknown> = {}, extra: Record<string, string> = Object.create(null);
  const put = (key: string, value: unknown, depth: number): void => {
    if (depth > 8) throw new Error("Skill metadata nesting exceeds eight levels");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [part, item] of Object.entries(value)) put(key ? `${key}.${part}` : part, item, depth + 1);
      return;
    }
    if (!key || key.length > 128 || Object.hasOwn(extra, key)) throw new Error("Skill metadata has an ambiguous or oversized key");
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined || text.length > 1024) throw new Error("Skill metadata value exceeds 1024 characters");
    extra[key] = text;
    if (Object.keys(extra).length > 32) throw new Error("At most 32 metadata entries");
  };
  for (const [key, value] of Object.entries(input)) {
    if (fields.has(key)) standard[key] = value;
    else if (key === "metadata") {
      let nested = value;
      if (typeof value === "string") {
        try { nested = JSON.parse(value); } catch { put("metadata", value, 0); continue; }
      }
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) throw new Error("Skill metadata extensions must be an object");
      put("", nested, 0);
    } else put(key, value, 0);
  }
  return { ...standard, ...(Object.keys(extra).length ? { metadata: extra } : {}) };
}

const list = (value: string | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string").map(entry => entry.trim()).filter(Boolean);
  } catch { /* A single string or comma-separated list is also accepted upstream. */ }
  return value.split(",").map(entry => entry.trim()).filter(Boolean);
};

/** Adapted from OpenClaw resolveSkillManifestMetadata / resolveOpenClawManifestRequires (MIT).
 * Pinned source and copyright are recorded in THIRD_PARTY_NOTICES.md. Install declarations are never run. */
export function skillRequirements(metadata: Record<string, string> = {}) {
  const prefixes = ["", "openclaw.", "clawdbot.", "moltbot."];
  return {
    os: prefixes.flatMap(prefix => [list(metadata[`${prefix}os`]), list(metadata[`${prefix}platforms`])]).filter(group => group.length),
    bins: prefixes.flatMap(prefix => list(metadata[`${prefix}requires.bins`])),
    anyBins: prefixes.flatMap(prefix => list(metadata[`${prefix}requires.anyBins`])),
  };
}
