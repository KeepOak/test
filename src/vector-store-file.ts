import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { errorText } from "./contracts.js";
import { SqliteVectors, type VectorBackend } from "./vector-store.js";
import { ChromaVectors, QdrantVectors } from "./vector-store-remote.js";
import { PineconeVectors } from "./vector-store-pinecone.js";
import { MilvusVectors } from "./vector-store-milvus.js";

/**
 * Somewhere else to keep the lists of numbers: a database file of your own choosing, anywhere on
 * this computer, instead of inside the one Branch keeps everything else in.
 *
 * Qdrant and Chroma are also explicit choices for an owner who already runs either service. Their
 * native HTTP adapters use an injected guarded fetch and locker reference; no server, SDK or model
 * is installed. Without this explicit choice the vectors stay in the built-in SQLite database.
 *
 * Why anyone would want this. A large personal library's vectors can be bigger than everything else
 * Branch stores put together; putting them on another drive keeps the main database small and quick
 * to copy, and keeps them out of the whole-application backup, which never carried them anyway
 * because a button rebuilds them.
 *
 * Two promises. When the file cannot be opened Branch says so in one sentence and carries on with
 * its own database — it never starts up broken and it never fails a search silently. And nothing is
 * ever deleted by switching: the vectors you already had stay where they were, and the new place
 * fills up the next time you press **Read it again**.
 */
export const VectorStoreSettingsSchema = z.object({
  /** External services are opt-in; the built-in database remains the default. */
  vectorsIn: z.enum(["database", "file", "qdrant", "chroma", "pinecone", "milvus"]).default("database"),
  /** The full path of that file, such as `D:/branch/vectors.db`. Only read when `vectorsIn` is `file`. */
  vectorsFile: z.string().trim().max(400).default(""),
  vectorsUrl: z.string().trim().max(500).default(""),
  vectorsRemoteBehindLoopback: z.boolean().default(false),
  vectorsSecret: z.string().trim().max(200).regex(/^([A-Z][A-Z0-9_]*)?$/).default(""),
  /** Captured when the owner saves the connection; changing the active project never changes its key. */
  vectorsProject: z.string().trim().max(100).default(""),
  vectorsHeader: z.enum(["", "api-key", "Api-Key", "x-chroma-token", "Authorization"]).default(""),
  vectorsTimeoutMs: z.number().int().min(500).max(30000).default(8000),
  chromaTenant: z.string().trim().min(1).max(120).default("default_tenant"),
  chromaDatabase: z.string().trim().min(1).max(120).default("default_database"),
  milvusDatabase: z.string().trim().min(1).max(120).default("default"),
}).strict();
export type VectorStoreSettings = z.infer<typeof VectorStoreSettingsSchema>;
export const externalVectorStore = (settings: VectorStoreSettings): boolean => ["qdrant", "chroma", "pinecone", "milvus"].includes(settings.vectorsIn);
export interface VectorServiceDependencies {
  fetchFor(endpoint: string): typeof fetch;
  key(owner: string, settings: VectorStoreSettings): Promise<string>;
  current(owner: string, settings: VectorStoreSettings): boolean;
  assertAllowed(endpoint: string, target: string): void;
}

/** What a knowledge base shows when the vectors are somewhere the owner chose. */
export const fileBackendName = (path: string): string => `a database file you chose (${path})`;

/**
 * The backend for one file, or the sentence saying why not. A folder that is not there is made,
 * because asking somebody to create an empty folder by hand before a setting will take is a poor
 * way to treat them; a path that cannot be written to is refused rather than guessed at.
 */
export function openVectorFile(path: string): { backend: VectorBackend } | { refusal: string } {
  const wanted = path.trim();
  if (!wanted) return { refusal: "No file was named for your vectors, so Branch is using its own database." };
  if (!isAbsolute(wanted))
    return { refusal: `"${wanted}" is not a full path, so Branch cannot tell where you meant. Give the whole path, such as D:/branch/vectors.db. Branch is using its own database instead.` };
  try {
    const folder = dirname(wanted);
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    const backend = new SqliteVectors(new DatabaseSync(wanted), fileBackendName(wanted), true);
    // Proves it can actually be written to now rather than at the end of a long reading.
    backend.countNow("", "");
    return { backend };
  } catch (error) {
    return { refusal: cannotOpen(wanted, errorText(error)) };
  }
}

/** The sentence a person reads when the file they chose is not reachable. */
export const cannotOpen = (path: string, reason: string): string =>
  `Branch could not open ${path}, the file you chose for your vectors: ${reason.slice(0, 160)}. `
  + "It is using its own database instead. Nothing you have already read has been lost, and nothing "
  + "was written to that file.";

/**
 * Where this owner's vectors should go, and the note the Documents panel shows. Called once when
 * the app starts, so a wrong setting is one sentence on the panel rather than a failure per search.
 */
export function chooseVectorStore(
  settings: VectorStoreSettings, shipped: VectorBackend, remote?: { owner: string; dependencies: VectorServiceDependencies },
): { backend: VectorBackend; note: string } {
  if (externalVectorStore(settings)) {
    if (!remote || !settings.vectorsUrl) return { backend: shipped, note: "The chosen vector service needs an address and guarded connection; vectors are kept in this computer's database for now." };
    try {
      const config = { url: settings.vectorsUrl, fetch: remote.dependencies.fetchFor(settings.vectorsUrl),
        active: () => remote.dependencies.current(remote.owner, settings),
        assertAllowed: (target: string) => remote.dependencies.assertAllowed(settings.vectorsUrl, target),
        timeoutMs: settings.vectorsTimeoutMs, header: settings.vectorsHeader || (settings.vectorsIn === "milvus" ? "Authorization" : settings.vectorsIn === "chroma" ? "x-chroma-token" : "api-key"),
        remoteBehindLoopback: settings.vectorsRemoteBehindLoopback,
        ...(settings.vectorsIn === "pinecone" ? { headers: { "X-Pinecone-Api-Version": "2026-07" } } : {}),
        tenant: settings.chromaTenant, database: settings.vectorsIn === "milvus" ? settings.milvusDatabase : settings.chromaDatabase,
        ...(settings.vectorsSecret ? { key: () => remote.dependencies.key(remote.owner, settings) } : {}) };
      const constructors = { qdrant: QdrantVectors, chroma: ChromaVectors, pinecone: PineconeVectors, milvus: MilvusVectors };
      const Provider = constructors[settings.vectorsIn as keyof typeof constructors];
      if (!Provider) throw new Error("The selected vector service has no native adapter");
      const backend = new Provider(config);
      return { backend, note: "" };
    } catch (error) { return { backend: shipped, note: `The vector service could not be configured: ${errorText(error).slice(0, 160)}. Vectors stay in this computer's database.` }; }
  }
  if (settings.vectorsIn !== "file") return { backend: shipped, note: "" };
  const opened = openVectorFile(settings.vectorsFile);
  return "backend" in opened
    ? { backend: opened.backend, note: "" }
    : { backend: shipped, note: opened.refusal };
}
