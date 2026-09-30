import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import type { LaunchEnv } from "./local-launch.js";

export interface LocalAIModel { file: string; backend: string; label: string; model: string }
export interface LocalAIWorkspace extends LocalAIModel { root: string; parent: string }

/** Only an existing GGUF and a local llama.cpp gRPC executable, never arbitrary model YAML. */
export async function localAIModel(file: string, backend: string, at: Pick<LaunchEnv, "platform">): Promise<LocalAIModel> {
  if (at.platform !== "linux") throw new Error("Branch manages this LocalAI route only on Linux.");
  for (const path of [file, backend]) if (!posix.isAbsolute(path) || path.length > 300 || /[\x00-\x1f\x7f]/.test(path))
    throw new Error("Choose absolute local GGUF and llama.cpp gRPC executable paths for LocalAI.");
  const [modelPath, backendPath] = await Promise.all([realpath(file), realpath(backend)]);
  for (const path of [modelPath, backendPath]) if (path.length > 300 || /[\x00-\x1f\x7f]/.test(path)) throw new Error("That LocalAI path cannot be used.");
  if (backendPath.includes(",")) throw new Error("The LocalAI backend path cannot contain a comma, which separates its backend options.");
  const [modelInfo, backendInfo] = await Promise.all([stat(modelPath), stat(backendPath)]);
  if (!modelInfo.isFile() || !backendInfo.isFile()) throw new Error("LocalAI needs a model file and a backend executable file.");
  await access(backendPath, constants.X_OK);
  const handle = await open(modelPath, "r");
  try {
    const magic = Buffer.alloc(4), read = await handle.read(magic, 0, 4, 0);
    if (read.bytesRead !== 4 || magic.toString("ascii") !== "GGUF") throw new Error("That LocalAI model is not a GGUF file.");
  } finally { await handle.close(); }
  const id = createHash("sha256").update(JSON.stringify([modelPath, backendPath])).digest("hex").slice(0, 16);
  return { file: modelPath, backend: backendPath, model: `branch-localai-${id}`, label: `LocalAI · ${posix.basename(modelPath)}`.slice(0, 80) };
}

/** Isolated writable state contains one generated config and a link to the unchanged model file. */
export async function prepareLocalAI(dataDir: string, selected: LocalAIModel, context: number): Promise<LocalAIWorkspace> {
  if (!posix.isAbsolute(dataDir)) throw new Error("LocalAI needs Branch's absolute private data folder.");
  const parent = posix.join(posix.resolve(dataDir), "local-models", "localai-sessions");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(posix.join(parent, "server-")), workspace = { ...selected, root, parent };
  try {
    for (const name of ["models", "backends", "generated", "uploads", "data", "config", "home"])
      await mkdir(posix.join(root, name), { mode: 0o700 });
    await symlink(selected.file, posix.join(root, "models", "model.gguf"));
    const config = { name: selected.model, backend: "llama-cpp", context_size: context, parameters: { model: "model.gguf" },
      template: { use_tokenizer_template: true } };
    await writeFile(posix.join(root, "models", "model.yaml"), JSON.stringify(config), { mode: 0o600 });
    return workspace;
  } catch (error) { await removeLocalAIWorkspace(workspace); throw error; }
}

export async function removeLocalAIWorkspace(workspace: Pick<LocalAIWorkspace, "root" | "parent">): Promise<void> {
  if (posix.dirname(workspace.root) !== workspace.parent || !posix.basename(workspace.root).startsWith("server-"))
    throw new Error("LocalAI cleanup refused a folder outside its private generated session.");
  await rm(workspace.root, { recursive: true, force: true }); // Unlinks model.gguf; never removes its target.
}

export function localAIArgs(program: string, workspace: LocalAIWorkspace, port: string): string[] {
  const path = (name: string) => posix.join(workspace.root, name);
  return [program, "run", "--address", `127.0.0.1:${port}`, "--models-path", path("models"),
    "--backends-path", path("backends"), "--backends-system-path", path("backends"),
    "--external-grpc-backends", `llama-cpp:${workspace.backend}`, "--galleries", "[]", "--backend-galleries", "[]",
    "--autoload-galleries=false", "--autoload-backend-galleries=false", "--auto-upgrade-backends=false",
    "--disable-gallery-endpoint", "--disable-mcp", "--disable-agents", "--disable-local-ai-assistant", "--disable-web-ui", "--disable-runtime-settings",
    "--generated-content-path", path("generated"), "--upload-path", path("uploads"), "--data-path", path("data"),
    "--localai-config-dir", path("config"), "--max-active-backends", "1"];
}

/** The engine receives system lookup/GPU variables only, never inherited LocalAI configuration. */
export function localAIChildEnv(env: Record<string, string | undefined>, home: string): Record<string, string> {
  const clean: Record<string, string> = { HOME: home, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
  for (const [key, value] of Object.entries(env)) if (value !== undefined && /^(PATH|LANG|LC_[A-Z_]+|LD_LIBRARY_PATH|CUDA_VISIBLE_DEVICES|NVIDIA_VISIBLE_DEVICES|HIP_VISIBLE_DEVICES|ROCR_VISIBLE_DEVICES)$/.test(key)) clean[key] = value;
  return clean;
}
