import { readdir, rm, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { forgetLocalConnection, savedLocalConnections, type LocalConnectionDeps } from "./local-connections.js";
import { modelsFolder } from "./local-files.js";
import { runtimeIds, runtimeInfo, type RuntimeId, type RuntimeLauncher } from "./local-launch.js";
import { LmStudioClient, OllamaClient, OpenAiServerClient, type LoadedModel } from "./local-models.js";
import { localRuntimeFetch } from "./local-policy.js";

/**
 * Wave mac5 (local models): what is in memory, taking it out, stopping a runtime Branch started,
 * and removing a downloaded model with the space that frees. Removing never reaches outside the
 * folder the runtime keeps its models in.
 */
export interface ManageDeps extends LocalConnectionDeps {
  dataDir: string;
  launcher: RuntimeLauncher;
}
const runtimeEnum = z.enum(runtimeIds as [RuntimeId, ...RuntimeId[]]);
export const UnloadSchema = z.object({ runtime: runtimeEnum, id: z.string().trim().min(1).max(400) }).strict();
export const RuntimeSchema = z.object({ runtime: runtimeEnum }).strict();

export interface DiskModel { runtime: RuntimeId; name: string; sizeBytes: number; connectionId: string | null }

export class LocalManager {
  private readonly ollama: OllamaClient;
  private readonly lmStudio: LmStudioClient;
  constructor(private readonly deps: ManageDeps) {
    const call = deps.fetch ?? globalThis.fetch;
    this.ollama = new OllamaClient(runtimeInfo.ollama.baseUrl, localRuntimeFetch(deps.policy, call, runtimeInfo.ollama.baseUrl));
    this.lmStudio = new LmStudioClient(runtimeInfo["lm-studio"].baseUrl, localRuntimeFetch(deps.policy, call, runtimeInfo["lm-studio"].baseUrl));
  }
  private server(runtime: "llama-cpp" | "mlx" | "vllm"): OpenAiServerClient {
    const base = this.deps.launcher.baseUrl(runtime) ?? runtimeInfo[runtime].baseUrl;
    return new OpenAiServerClient(base, localRuntimeFetch(this.deps.policy, this.deps.fetch ?? globalThis.fetch, () => this.deps.launcher.baseUrl(runtime)));
  }
  private join(...parts: string[]): string {
    return (this.deps.launcher.at.platform === "win32" ? win32 : posix).join(...parts);
  }

  /** Everything in memory now, across the runtimes that are answering. */
  async loaded(): Promise<LoadedModel[]> {
    const found: LoadedModel[] = [];
    found.push(...await this.ollama.loaded().catch(() => []));
    const studio = await this.lmStudio.list().catch(() => ({ running: false, models: [] }));
    for (const model of studio.models) for (const one of model.instances)
      found.push({ runtime: "lm-studio", name: model.name, instanceId: one.id, sizeBytes: model.sizeBytes, graphicsBytes: 0, contextLength: one.contextLength });
    for (const runtime of ["llama-cpp", "mlx", "vllm"] as const) {
      if (!this.deps.launcher.owns(runtime)) continue;
      for (const name of await this.server(runtime).models() ?? [])
        found.push({ runtime, name, instanceId: name, sizeBytes: 0, graphicsBytes: 0, contextLength: null });
    }
    return found;
  }

  /** Takes one model out of memory; for llama.cpp and MLX that means stopping their server. */
  async unload(input: unknown): Promise<{ unloaded: string }> {
    const { runtime, id } = UnloadSchema.parse(input);
    if (runtime === "ollama") return this.ollama.unload(id);
    if (runtime === "lm-studio") return this.lmStudio.unload(id);
    const { stopped } = await this.deps.launcher.stopRuntime(runtime);
    if (!stopped) throw new Error(`Branch did not start ${runtimeInfo[runtime].name}, so it will not stop it`);
    return { unloaded: id };
  }

  /** Stops a runtime: LM Studio's server, or a program Branch started itself. */
  async stop(input: unknown): Promise<{ stopped: boolean; message: string }> {
    const { runtime } = RuntimeSchema.parse(input);
    const { stopped } = await this.deps.launcher.stopRuntime(runtime);
    return { stopped, message: stopped ? `${runtimeInfo[runtime].name} was stopped.` : `Branch did not start ${runtimeInfo[runtime].name}, so it left it running. Quit it from its own window.` };
  }

  /** Downloaded models Branch can see, with their size and the connection that uses them. */
  async onDisk(): Promise<DiskModel[]> {
    const connections = savedLocalConnections(this.deps.store, this.deps.owner);
    const using = (runtime: RuntimeId, name: string) =>
      connections.find((c) => c.runtime === runtime && (c.model === name || c.model.startsWith(`${name.split(":")[0]}:`) && c.model.includes(name.split(":")[1] ?? "")))?.id ?? null;
    const list: DiskModel[] = [];
    for (const model of await this.ollama.list().catch(() => []))
      list.push({ runtime: "ollama", name: model.name, sizeBytes: model.size, connectionId: using("ollama", model.name) });
    for (const runtime of ["llama-cpp", "mlx"] as const) {
      const folder = modelsFolder(runtime, this.deps.launcher.at, this.deps.dataDir);
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        if (name.endsWith(".partial")) continue;
        const path = this.join(folder, name);
        list.push({ runtime, name, sizeBytes: await sizeOf(path), connectionId: using(runtime, path) });
      }
    }
    return list;
  }

  /** Removes a downloaded model and the connection that used it; says how much space it freed. */
  async remove(input: unknown): Promise<{ removed: string; freedBytes: number; message: string }> {
    const { runtime, id } = UnloadSchema.parse(input);
    if (runtime === "vllm") throw new Error("Branch did not download this vLLM directory, so it will not delete it. Stop the runtime and manage your model files yourself.");
    if (runtime === "lm-studio") throw new Error("LM Studio has no way for another program to delete a model. Delete it in LM Studio, under My Models.");
    // Integration review: the name is checked before anything else, and "." or ".." never pass.
    if (runtime !== "ollama" && !/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(id)) throw new Error("That is not a model Branch downloaded");
    const disk = (await this.onDisk()).find((model) => model.runtime === runtime && model.name === id);
    if (!disk) throw new Error("That model is not on this computer");
    if (runtime === "ollama") {
      const copies = (await this.ollama.list()).filter((model) => model.name.startsWith(`${id.split(":")[0]}:`) && model.name.includes("-branch") && model.name.includes(id.split(":")[1] ?? ""));
      for (const copy of copies) await this.ollama.remove(copy.name);
      await this.ollama.remove(id);
    } else {
      const folder = modelsFolder(runtime, this.deps.launcher.at, this.deps.dataDir);
      if (this.deps.launcher.owns(runtime)) await this.deps.launcher.stopRuntime(runtime);
      await rm(this.join(folder, id), { recursive: true, force: true });
      await rm(this.join(folder, `${id}.partial`), { force: true });
    }
    if (disk.connectionId) forgetLocalConnection(this.deps, disk.connectionId);
    return { removed: id, freedBytes: disk.sizeBytes, message: `Removed ${id}; about ${Math.round(disk.sizeBytes / 1024 ** 3 * 10) / 10} GB is free again.` };
  }
}

async function sizeOf(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) total += (await stat(`${path}/${name}`).catch(() => null))?.size ?? 0;
  return total;
}
