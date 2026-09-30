import { z } from "zod";
import { defaultEmbeddingModel, type Embedder } from "./document-embeddings.js";

/**
 * Models that run on this computer, through Ollama, LM Studio or llama.cpp's own server. Every
 * address is checked to be on this computer first, and nothing else is allowed. The app hands each
 * client a fetch from `src/local-policy.ts`, so the owner's network rules apply to every call too;
 * a client built with the plain fetch (a test, the health check) still refuses any other address.
 */
export const lmStudioHome = "http://127.0.0.1:1234";
export const ollamaDownloadPage = "https://ollama.com/download";
export const lmStudioDownloadPage = "https://lmstudio.ai/";
/** What to use for comparing passages by meaning when the connected model runs on this computer. */
export const defaultLocalEmbeddingModel = "nomic-embed-text";

const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** Refuses any address that is not on this computer, before a single request is sent. */
export function assertOnThisComputer(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A local model address must start with http");
  if (url.username || url.password || url.search || url.hash) throw new Error("A local model address must be plain, with no key or extras");
  if (!loopback.has(url.hostname.toLowerCase())) throw new Error(`${url.hostname} is not on this computer, so it cannot be a local model server`);
  return url;
}
/**
 * Where Ollama answers: 127.0.0.1:11434, its own default. BRANCH_OLLAMA_URL moves it (a test's stand-in on a free
 * port, or an Ollama started with its own OLLAMA_HOST); it must be plain http(s) on this computer, or it is refused.
 */
export function ollamaAddress(raw: string | undefined = process.env.BRANCH_OLLAMA_URL): string {
  return raw ? assertOnThisComputer(raw).origin : "http://127.0.0.1:11434";
}
export const ollamaHome = ollamaAddress();
export const localModelName = z.string().trim().min(1).max(160)
  .regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?$/i, "That is not a model name Ollama would recognise");

export interface LocalModel {
  name: string;
  /** Bytes on disk. */
  size: number;
  family: string;
  /** For example "8B"; empty when the server does not say. */
  parameterSize: string;
  /** How much text it can hold at once, in tokens; null when the server does not say. */
  contextLength: number | null;
  /** True for the llava family and other models that can be shown a picture. */
  canSeePictures: boolean;
  /** Whether the runtime says it can call tools; null when it does not say. */
  canUseTools: boolean | null;
  modifiedAt: string;
}
/** One progress line while a model is being downloaded. The event name is `model.download.progress`. */
export interface DownloadProgress {
  event: "model.download.progress";
  model: string;
  /** The runtime's own words, for example "pulling manifest" or "downloading". */
  status: string;
  completed: number;
  total: number;
  /** 0 to 100; 100 only once the download finished. */
  percent: number;
  done: boolean;
  error?: string;
}

const detailsSchema = z.object({
  family: z.string().optional(),
  families: z.array(z.string()).nullable().optional(),
  parameter_size: z.string().optional(),
}).optional();
const tagsSchema = z.object({
  models: z.array(z.object({
    name: z.string().min(1), size: z.number().nonnegative().optional(),
    modified_at: z.string().optional(), details: detailsSchema,
    capabilities: z.array(z.string()).optional(),
  })).default([]),
});
const showSchema = z.object({
  details: detailsSchema,
  model_info: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.array(z.string()).optional(),
});
const progressSchema = z.object({
  status: z.string().optional(), total: z.number().nonnegative().optional(),
  completed: z.number().nonnegative().optional(), error: z.string().optional(),
});
const embeddingSchema = z.object({ embedding: z.array(z.number()).min(1).max(8192) });

const visionNames = /(llava|bakllava|moondream|vision|minicpm-v|gemma3)/i;
/** Whether a model on this computer can be shown a picture, from its name and what it reports. */
export function localModelSupportsImages(name: string, families: string[] = [], capabilities: string[] = []): boolean {
  if (capabilities.includes("vision")) return true;
  if (families.some((family) => /clip|mllama|vision/i.test(family))) return true;
  return visionNames.test(name);
}
/** The largest `*.context_length` figure Ollama reports for a model, or null when it reports none. */
export function contextLengthOf(info: Record<string, unknown> | undefined): number | null {
  const sizes = Object.entries(info ?? {})
    .filter(([key, value]) => key.endsWith(".context_length") && typeof value === "number" && value > 0)
    .map(([, value]) => value as number);
  return sizes.length ? Math.max(...sizes) : null;
}

/** Reads a newline-delimited JSON stream, handing over one complete line at a time. */
async function eachLine(body: ReadableStream<Uint8Array>, handle: (line: string) => void): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line) handle(line);
      }
      if (buffer.length > 65536) throw new Error("The local model server sent an unreadable progress line");
    }
    if (buffer.trim()) handle(buffer.trim());
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Turns one line from Ollama into a progress report, keeping the last known totals. */
export function describeProgress(model: string, line: z.infer<typeof progressSchema>, previous: DownloadProgress): DownloadProgress {
  if (line.error) return { ...previous, status: "failed", done: true, error: line.error.slice(0, 200) };
  const total = line.total ?? previous.total;
  const completed = line.completed ?? (line.total === undefined ? previous.completed : 0);
  const status = line.status ?? previous.status;
  const done = status === "success";
  const percent = done ? 100 : total > 0 ? Math.min(99, Math.floor((completed / total) * 100)) : previous.percent;
  return { event: "model.download.progress", model, status, completed, total, percent, done };
}

/** One model in memory, whichever runtime holds it. */
export interface LoadedModel {
  runtime: "ollama" | "lm-studio" | "llama-cpp" | "mlx" | "vllm";
  name: string;
  /** What to hand back to unload it: Ollama's model name, LM Studio's instance id. */
  instanceId: string;
  sizeBytes: number;
  graphicsBytes: number;
  contextLength: number | null;
}
const psSchema = z.object({
  models: z.array(z.object({
    name: z.string().min(1), size: z.number().nonnegative().optional(),
    size_vram: z.number().nonnegative().optional(), context_length: z.number().nonnegative().optional(),
  }).loose()).default([]),
}).loose();
/**
 * QA Q071: a copy of an installed model that Branch made for itself: the sized copy setup makes (`qwen2.5:7b-branch8k`,
 * sharing the model's files) or one Branch's own evaluations make (`branch-evals-qwen2-5-7b-8192`). Neither is one of the
 * person's models, so neither is listed as installed nor named as a model.
 */
export function madeByBranch(name: string): boolean {
  return /-branch\d+k$/.test(name) || /^branch-evals-/.test(name);
}
/** The model a copy Branch sized was made from (`qwen2.5:7b-branch8k` is `qwen2.5:7b`); any other name as it is. */
export function unsizedModelName(name: string): string {
  return name.replace(/-branch\d+k$/, "");
}
/** `qwen3:8b` with 16,384 words of room becomes `qwen3:8b-branch16k`. */
export function sizedModelName(name: string, context: number): string {
  const [base, tag = "latest"] = name.split(":");
  const plainTag = tag.replace(/-branch\d+k$/, "");
  return `${base}:${plainTag}-branch${Math.round(context / 1024)}k`;
}

/** Ollama's own API on this computer: what is installed, downloading a model, and removing one. */
export class OllamaClient {
  readonly base: string;
  constructor(baseUrl: string = ollamaHome, private readonly call: typeof fetch = globalThis.fetch) {
    this.base = assertOnThisComputer(baseUrl).origin;
  }
  private async json(path: string, init: RequestInit = {}, timeoutMs = 5000): Promise<unknown> {
    const response = await this.call(this.base + path, {
      redirect: "error", signal: AbortSignal.timeout(timeoutMs), ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
    const text = await response.text();
    if (text.length > 4_194_304) throw new Error("Ollama returned too much data");
    return text ? (JSON.parse(text) as unknown) : {};
  }
  /** The running version, or null when Ollama is not installed or has not been started. */
  async version(): Promise<string | null> {
    try {
      const body = z.object({ version: z.string().optional() }).parse(await this.json("/api/version", {}, 1500));
      return body.version ?? "unknown";
    } catch { return null; }
  }
  /** Every model already downloaded on this computer, biggest first. */
  async list(): Promise<LocalModel[]> {
    const body = tagsSchema.parse(await this.json("/api/tags", {}, 4000));
    return body.models.map((model) => ({
      name: model.name,
      size: model.size ?? 0,
      family: model.details?.family ?? model.name.split(":")[0]!,
      parameterSize: model.details?.parameter_size ?? "",
      contextLength: null,
      canSeePictures: localModelSupportsImages(model.name, model.details?.families ?? [], model.capabilities ?? []),
      canUseTools: model.capabilities ? model.capabilities.includes("tools") : null,
      modifiedAt: model.modified_at ?? "",
    })).sort((a, b) => b.size - a.size);
  }
  /** What one model is: family, size on disk, how much it can hold, whether it can see pictures. */
  async show(name: string): Promise<LocalModel> {
    const model = localModelName.parse(name);
    const body = showSchema.parse(await this.json("/api/show", { method: "POST", body: JSON.stringify({ model }) }, 8000));
    const listed = (await this.list().catch(() => [] as LocalModel[]))
      .find((entry) => entry.name === model || entry.name.split(":")[0] === model.split(":")[0]);
    return {
      name: model,
      size: listed?.size ?? 0,
      family: body.details?.family ?? listed?.family ?? "",
      parameterSize: body.details?.parameter_size ?? listed?.parameterSize ?? "",
      contextLength: contextLengthOf(body.model_info),
      canSeePictures: localModelSupportsImages(model, body.details?.families ?? [], body.capabilities ?? []),
      canUseTools: body.capabilities ? body.capabilities.includes("tools") : null,
      modifiedAt: listed?.modifiedAt ?? "",
    };
  }
  /**
   * Downloads a model, reporting progress as it goes. Ollama streams one JSON object per line;
   * each becomes a `model.download.progress` report for the screen.
   */
  async pull(name: string, onProgress: (progress: DownloadProgress) => void, signal?: AbortSignal): Promise<DownloadProgress> {
    const model = localModelName.parse(name);
    const response = await this.call(this.base + "/api/pull", {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }), ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) throw new Error(`Ollama would not start the download (${response.status})`);
    let last: DownloadProgress = { event: "model.download.progress", model, status: "starting", completed: 0, total: 0, percent: 0, done: false };
    await eachLine(response.body, (line) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return; }
      const report = progressSchema.safeParse(parsed);
      if (!report.success) return;
      last = describeProgress(model, report.data, last);
      onProgress(last);
    });
    if (last.error) throw new Error(last.error);
    if (!last.done) { last = { ...last, status: "success", percent: 100, done: true }; onProgress(last); }
    return last;
  }
  /** Removes a downloaded model from this computer. */
  async remove(name: string): Promise<{ removed: string }> {
    const model = localModelName.parse(name);
    await this.json("/api/delete", { method: "DELETE", body: JSON.stringify({ model }) }, 20000);
    return { removed: model };
  }
  /** What is in memory right now (`/api/ps`), with how much of it sits on the graphics. */
  async loaded(): Promise<LoadedModel[]> {
    const body = psSchema.parse(await this.json("/api/ps", {}, 4000));
    return body.models.map((entry) => ({
      runtime: "ollama" as const, name: entry.name, instanceId: entry.name, sizeBytes: entry.size ?? 0,
      graphicsBytes: entry.size_vram ?? 0, contextLength: entry.context_length ?? null,
    }));
  }
  /** Takes a model out of memory at once (`keep_alive: 0`); it stays downloaded. */
  async unload(name: string): Promise<{ unloaded: string }> {
    const model = localModelName.parse(name);
    await this.json("/api/generate", { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) }, 20000);
    return { unloaded: model };
  }
  /**
   * A copy of a downloaded model that always opens with `context` words of room. Ollama shares the
   * weights between the two, so it costs no disk space; the connection then names this copy, and
   * every conversation gets the fitted size without the chat code having to send it.
   */
  async sized(name: string, context: number): Promise<{ model: string }> {
    const from = localModelName.parse(name);
    const sizedModel = localModelName.parse(sizedModelName(from, context));
    const numCtx = z.number().int().min(512).max(1_048_576).parse(context);
    await this.json("/api/create", {
      method: "POST", body: JSON.stringify({ model: sizedModel, from, parameters: { num_ctx: numCtx }, stream: false }),
    }, 120000);
    return { model: sizedModel };
  }
  /** Brings a model into memory now, with its room for words, and keeps it there for `keepAlive`. */
  async warm(name: string, context: number, keepAlive = "30m"): Promise<{ loaded: string }> {
    const model = localModelName.parse(name);
    await this.json("/api/generate", {
      method: "POST", body: JSON.stringify({ model, prompt: "", keep_alive: keepAlive, options: { num_ctx: context } }),
    }, 300000);
    return { loaded: model };
  }
  /** One vector per passage, through Ollama's own embeddings route (one passage per request). */
  async embed(texts: string[], model: string, signal: AbortSignal): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (const prompt of texts) {
      const response = await this.call(this.base + "/api/embeddings", {
        method: "POST", redirect: "error", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt }),
      });
      // QA retest 2026-09-28 (m7): a 404 is Ollama saying the model is not downloaded; "could not read these passages
      // (404)" said nothing a person could act on.
      if (response.status === 404) throw new Error(`${model}, the model that compares passages by meaning, is not on this computer. Run "ollama pull ${model}" to add it.`);
      if (!response.ok) throw new Error(`The model on this computer could not read these passages (${response.status})`);
      vectors.push(Float32Array.from(embeddingSchema.parse(JSON.parse(await response.text()) as unknown).embedding));
    }
    return vectors;
  }
}

const lmV1Schema = z.object({
  models: z.array(z.object({
    type: z.string().optional(), key: z.string().min(1), display_name: z.string().optional(),
    size_bytes: z.number().nonnegative().optional(), max_context_length: z.number().nonnegative().optional(),
    quantization: z.object({ name: z.string().optional() }).loose().nullable().optional(),
    capabilities: z.object({ vision: z.boolean().optional(), trained_for_tool_use: z.boolean().optional() }).loose().nullable().optional(),
    loaded_instances: z.array(z.object({
      id: z.string().min(1), config: z.object({ context_length: z.number().optional() }).loose().optional(),
    }).loose()).default([]),
  }).loose()),
}).loose();
const lmOldSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1), state: z.string().optional(), max_context_length: z.number().nonnegative().optional(),
  })).default([]),
});
const lmJobSchema = z.object({
  job_id: z.string().max(200).optional(), status: z.string().max(40),
  total_size_bytes: z.number().nonnegative().optional(), downloaded_bytes: z.number().nonnegative().optional(),
}).loose();
export interface LmStudioModel {
  name: string;
  loaded: boolean;
  contextLength: number | null;
  sizeBytes: number;
  quantization: string;
  canUseTools: boolean | null;
  canSeePictures: boolean;
  instances: { id: string; contextLength: number | null }[];
}
export interface LmStudioJob { jobId: string | null; status: string; totalBytes: number; downloadedBytes: number }
/** LM Studio accepts its own catalogue names (`qwen/qwen3-4b`) and Hugging Face addresses. */
export const lmStudioModelName = z.string().trim().min(1).max(300)
  .regex(/^(?:https:\/\/huggingface\.co\/)?[a-z0-9][a-z0-9._@/-]*$/i, "That is not a model name LM Studio would recognise");

/**
 * LM Studio's REST API (version 1): what is downloaded and loaded, loading a model with a chosen
 * room for words, unloading one instance, and downloading with a job that can be asked about.
 * Older LM Studio builds without these routes still answer the list through `/api/v0` or `/v1`.
 */
export class LmStudioClient {
  readonly base: string;
  constructor(baseUrl: string = lmStudioHome, private readonly call: typeof fetch = globalThis.fetch) {
    this.base = assertOnThisComputer(baseUrl).origin;
  }
  private async send(path: string, body: unknown | undefined, timeoutMs: number): Promise<unknown> {
    const response = await this.call(this.base + path, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`LM Studio answered ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
    if (text.length > 4_194_304) throw new Error("LM Studio returned too much data");
    return text ? (JSON.parse(text) as unknown) : {};
  }
  async list(): Promise<{ running: boolean; models: LmStudioModel[] }> {
    try {
      const body = lmV1Schema.parse(await this.send("/api/v1/models", undefined, 2000));
      return { running: true, models: body.models.filter((entry) => entry.type !== "embedding").map(fromV1) };
    } catch { /* an older build: try the earlier routes */ }
    for (const path of ["/api/v0/models", "/v1/models"]) {
      try {
        const body = lmOldSchema.parse(await this.send(path, undefined, 2000));
        return { running: true, models: body.data.map((entry) => ({
          name: entry.id, loaded: entry.state === "loaded", contextLength: entry.max_context_length ?? null,
          sizeBytes: 0, quantization: "", canUseTools: null, canSeePictures: false, instances: [],
        })) };
      } catch { /* try the next route, then report it is not running */ }
    }
    return { running: false, models: [] };
  }
  /** Loads a model with `context` words of room (`POST /api/v1/models/load`). */
  async load(model: string, context?: number): Promise<{ loaded: string; instanceId: string; contextLength: number | null }> {
    const name = lmStudioModelName.parse(model);
    const body = z.object({ instance_id: z.string().max(300).optional(), load_config: z.object({ context_length: z.number().optional() }).loose().optional() }).loose()
      .parse(await this.send("/api/v1/models/load", { model: name, ...(context ? { context_length: context } : {}) }, 300000));
    return { loaded: name, instanceId: body.instance_id ?? name, contextLength: body.load_config?.context_length ?? context ?? null };
  }
  /** Takes one loaded instance out of memory (`POST /api/v1/models/unload`). */
  async unload(instanceId: string): Promise<{ unloaded: string }> {
    const id = lmStudioModelName.parse(instanceId);
    await this.send("/api/v1/models/unload", { instance_id: id }, 30000);
    return { unloaded: id };
  }
  /** Starts a download inside LM Studio and returns its job (`POST /api/v1/models/download`). */
  async download(model: string, quantization?: string): Promise<LmStudioJob> {
    const name = lmStudioModelName.parse(model);
    const quant = quantization ? z.string().regex(/^[a-z0-9_.-]{1,24}$/i).parse(quantization) : undefined;
    return job(lmJobSchema.parse(await this.send("/api/v1/models/download", { model: name, ...(quant ? { quantization: quant } : {}) }, 30000)));
  }
  /** How a download LM Studio is doing is going (`GET /api/v1/models/download/status/:job_id`). */
  async downloadStatus(jobId: string): Promise<LmStudioJob> {
    const id = z.string().regex(/^[a-z0-9_-]{1,100}$/i).parse(jobId);
    return job(lmJobSchema.parse(await this.send(`/api/v1/models/download/status/${id}`, undefined, 5000)));
  }
}
function fromV1(entry: z.infer<typeof lmV1Schema>["models"][number]): LmStudioModel {
  const instances = entry.loaded_instances.map((one) => ({ id: one.id, contextLength: one.config?.context_length ?? null }));
  return {
    name: entry.key, loaded: instances.length > 0, contextLength: entry.max_context_length ?? null,
    sizeBytes: entry.size_bytes ?? 0, quantization: entry.quantization?.name ?? "",
    canUseTools: entry.capabilities ? entry.capabilities.trained_for_tool_use === true : null,
    canSeePictures: entry.capabilities?.vision === true, instances,
  };
}
function job(body: z.infer<typeof lmJobSchema>): LmStudioJob {
  return { jobId: body.job_id ?? null, status: body.status, totalBytes: body.total_size_bytes ?? 0, downloadedBytes: body.downloaded_bytes ?? 0 };
}

/**
 * llama.cpp's `llama-server` (and MLX's `mlx_lm.server`, which answers the same two questions):
 * whether it is up, and which model it holds. Branch starts these itself, one model at a time.
 */
export class OpenAiServerClient {
  readonly base: string;
  constructor(baseUrl: string, private readonly call: typeof fetch = globalThis.fetch) {
    this.base = assertOnThisComputer(baseUrl).origin;
  }
  async models(): Promise<string[] | null> {
    try {
      const response = await this.call(this.base + "/v1/models", { redirect: "error", signal: AbortSignal.timeout(2000) });
      if (!response.ok) return null;
      const body = z.object({ data: z.array(z.object({ id: z.string() }).loose()).default([]) }).loose().parse(JSON.parse(await response.text()) as unknown);
      return body.data.map((entry) => entry.id).slice(0, 50);
    } catch { return null; }
  }
}

/** A passage reader backed by Ollama, used in place of the cloud one when the model runs here. */
export class OllamaEmbedder implements Embedder {
  constructor(private readonly client: OllamaClient, readonly model: string = defaultLocalEmbeddingModel) {}
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    return this.client.embed(texts, this.model, signal);
  }
}

/**
 * An Ollama-backed passage reader when the connected model is Ollama on this computer, otherwise
 * nothing, so the caller falls back to the provider's own embeddings route.
 */
export function localEmbedder(route: { endpoint: string }, model: string, call: typeof fetch = globalThis.fetch): Embedder | null {
  let url: URL;
  try { url = new URL(route.endpoint); } catch { return null; }
  if (!loopback.has(url.hostname.toLowerCase()) || url.port !== new URL(ollamaHome).port) return null;
  const chosen = model === defaultEmbeddingModel ? defaultLocalEmbeddingModel : model;
  try { return new OllamaEmbedder(new OllamaClient(url.origin, call), chosen); } catch { return null; }
}
