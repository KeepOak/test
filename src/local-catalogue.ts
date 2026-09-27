import { readFileSync } from "node:fs";
import { z } from "zod";
import { chooseContext, type Fit, type MachineRoom } from "./local-fit.js";
import { hfRepoName } from "./local-files.js";
import type { RuntimeId } from "./local-launch.js";
import { localModelName } from "./local-models.js";

/**
 * Wave mac5 (local models): the curated list of models offered with one click (`data/local-models.json`),
 * each in several sizes, and searching the runtime's own library where its API allows.
 *
 * - Hugging Face publishes a search (`/api/models?search=`), and it is the library LM Studio,
 *   llama.cpp and MLX all download from, so those three search there.
 * - Ollama's library has no search API. Its registry does answer for one exact name
 *   (`registry.ollama.ai/v2/library/<name>/manifests/<tag>`), so a typed name is looked up
 *   there and its real download size shown before anything is downloaded.
 */
const text = z.object({ en: z.string().min(1).max(200), fr: z.string().min(1).max(200), de: z.string().min(1).max(200), es: z.string().min(1).max(200) });
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const VariantSchema = z.object({
  quant: z.string().regex(/^[A-Za-z0-9_]{2,16}$/),
  label: z.enum(["small", "balanced", "full"]),
  ollama: z.object({ tag: localModelName, bytes: z.number().int().positive() }).optional(),
  gguf: z.object({ repo: hfRepoName, file: z.string().regex(/^[A-Za-z0-9._-]+\.gguf$/), bytes: z.number().int().positive(), sha256: sha }).optional(),
  mlx: z.object({ repo: hfRepoName, bytes: z.number().int().positive() }).optional(),
}).strict();
const EntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,40}$/),
  name: z.string().min(1).max(60),
  params: z.string().max(12),
  tools: z.boolean(),
  vision: z.boolean(),
  maxContext: z.number().int().min(2048),
  arch: z.object({ layers: z.number().int().positive(), kvHeads: z.number().int().positive(), headDim: z.number().int().positive() }).strict(),
  summary: text,
  variants: z.array(VariantSchema).min(1).max(6),
}).strict();
const CatalogueSchema = z.object({ $comment: z.string().optional(), checked: z.string(), models: z.array(EntrySchema).min(1).max(60) }).strict();
export type CatalogueEntry = z.infer<typeof EntrySchema>;
export type CatalogueVariant = z.infer<typeof VariantSchema>;

let loaded: CatalogueEntry[] | null = null;
/** The curated list, read once from the data folder that ships with Branch. */
export function localCatalogue(): CatalogueEntry[] {
  if (loaded) return loaded;
  for (const url of [new URL("./local-models.json", import.meta.url), new URL("../data/local-models.json", import.meta.url)]) {
    try { return (loaded = CatalogueSchema.parse(JSON.parse(readFileSync(url, "utf8")) as unknown).models); } catch { /* try the next place */ }
  }
  throw new Error("The list of models for this computer (local-models.json) is missing from this installation");
}

/** How big the download is for this runtime, or null when this runtime cannot use this size. */
export function variantBytes(variant: CatalogueVariant, runtime: RuntimeId): number | null {
  if (runtime === "ollama") return variant.ollama?.bytes ?? null;
  if (runtime === "mlx") return variant.mlx?.bytes ?? null;
  return variant.gguf?.bytes ?? null;
}

export interface OfferVariant {
  quant: string;
  label: CatalogueVariant["label"];
  downloadBytes: number;
  fit: Fit;
  context: number;
  needsBytes: number;
  note: string;
}
export interface Offer {
  id: string;
  name: string;
  params: string;
  summary: z.infer<typeof text>;
  tools: boolean;
  vision: boolean;
  /** Shown when the model cannot call tools, so nobody expects it to act. */
  warning: string | null;
  variants: OfferVariant[];
  /** The size to suggest on this computer: the biggest that fits well, else the smallest. */
  suggested: string | null;
}

/** Every curated model, sized for this computer and this runtime. */
export function offers(room: MachineRoom, runtime: RuntimeId): Offer[] {
  return localCatalogue().map((entry) => {
    const variants = entry.variants.flatMap((variant): OfferVariant[] => {
      const bytes = variantBytes(variant, runtime);
      if (bytes === null) return [];
      const { context, report } = chooseContext(room, bytes, entry.arch, entry.maxContext);
      return [{ quant: variant.quant, label: variant.label, downloadBytes: bytes, fit: report.fit, context, needsBytes: report.needsBytes, note: report.note }];
    });
    const well = variants.filter((variant) => variant.fit === "well");
    return {
      id: entry.id, name: entry.name, params: entry.params, summary: entry.summary, tools: entry.tools, vision: entry.vision,
      warning: entry.tools ? null : "This model cannot use tools, so the assistant can only talk with it, not act.",
      variants, suggested: (well[well.length - 1] ?? variants[0])?.quant ?? null,
    };
  }).filter((offer) => offer.variants.length > 0);
}

/** The one curated model and size asked for. */
export function findVariant(id: string, quant: string): { entry: CatalogueEntry; variant: CatalogueVariant } {
  const entry = localCatalogue().find((one) => one.id === id);
  const variant = entry?.variants.find((one) => one.quant === quant);
  if (!entry || !variant) throw new Error("That model is not on Branch's list");
  return { entry, variant };
}

/* ---------- searching a library ---------- */

export interface SearchHit { runtime: RuntimeId; name: string; downloads: number; bytes: number | null; note: string }
const hfSearchSchema = z.array(z.object({ id: z.string().max(200), downloads: z.number().optional() }).loose()).max(100);
const manifestSchema = z.object({ layers: z.array(z.object({ mediaType: z.string(), size: z.number().nonnegative() }).loose()) }).loose();
export const searchQuery = z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9 ._:/-]+$/, "Search with letters, numbers, dots and dashes");

/** Hugging Face models that LM Studio, llama.cpp (GGUF) or MLX can run. */
export async function searchHuggingFace(query: string, runtime: Exclude<RuntimeId, "ollama">, call: typeof globalThis.fetch): Promise<SearchHit[]> {
  const q = searchQuery.parse(query);
  const filter = runtime === "mlx" ? "&filter=mlx" : "&filter=gguf";
  const response = await call(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}${filter}&sort=downloads&limit=20`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status}`);
  return hfSearchSchema.parse(JSON.parse(await response.text()) as unknown)
    .filter((hit) => hfRepoName.safeParse(hit.id).success)
    .map((hit) => ({ runtime, name: hit.id, downloads: hit.downloads ?? 0, bytes: null, note: "From Hugging Face. Branch cannot tell ahead whether it can use tools." }));
}

/** Ollama: whether this exact name exists in its library, and how big it is. */
export async function lookUpOllama(name: string, call: typeof globalThis.fetch): Promise<SearchHit[]> {
  const model = localModelName.parse(name.trim());
  const [base, tag = "latest"] = model.split(":") as [string, string?];
  const path = base.includes("/") ? base : `library/${base}`;
  const response = await call(`https://registry.ollama.ai/v2/${path}/manifests/${encodeURIComponent(tag)}`, {
    headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" }, signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Ollama's library answered ${response.status}`);
  const bytes = manifestSchema.parse(JSON.parse(await response.text()) as unknown).layers
    .filter((layer) => /image\.(model|projector)$/.test(layer.mediaType)).reduce((sum, layer) => sum + layer.size, 0);
  return [{ runtime: "ollama", name: model, downloads: 0, bytes, note: `In Ollama's library; about ${Math.round(bytes / 1024 ** 3 * 10) / 10} GB to download.` }];
}

/** Ollama's registry size for one name, used for the disk check before a typed name is pulled. */
export async function ollamaDownloadBytes(name: string, call: typeof globalThis.fetch): Promise<number | null> {
  const hit = await lookUpOllama(name, call).catch(() => [] as SearchHit[]);
  return hit[0]?.bytes ?? null;
}
