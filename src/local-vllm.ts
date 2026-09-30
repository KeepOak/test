import { open, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import type { LaunchEnv } from "./local-launch.js";

const modelConfig = z.object({ max_position_embeddings: z.number().int().positive().optional() }).loose();
export const vllmToolParsers = ["hermes", "llama3_json", "qwen3_coder", "qwen3_xml"] as const;

/** Existing local Hugging Face directory only; no repository id, code opt-in or download. */
export async function localVllmModel(path: string, at: Pick<LaunchEnv, "platform">): Promise<{ path: string; context: number; label: string }> {
  if (at.platform !== "linux") throw new Error("Branch starts vLLM only on Linux with an installed, compatible GPU runtime.");
  if (path.length > 300 || !posix.isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path))
    throw new Error("vLLM needs an existing absolute local model directory, not a repository name.");
  const chosen = await realpath(path);
  if (chosen.length > 300 || /[\x00-\x1f\x7f]/.test(chosen) || !(await stat(chosen)).isDirectory()) throw new Error("That vLLM model directory is not available.");
  const handle = await open(posix.join(chosen, "config.json"), "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536) throw new Error("vLLM needs a bounded local config.json.");
    const bytes = Buffer.alloc(65537);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 65536) throw new Error("The local vLLM config.json is too large.");
    const config = modelConfig.parse(JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")) as unknown);
    return { path: chosen, context: Math.min(8192, config.max_position_embeddings ?? 8192), label: `vLLM · ${posix.basename(chosen)}`.slice(0, 80) };
  } finally { await handle.close(); }
}

/** Only built-in runtime components, with Hugging Face offline mode and usage telemetry off. */
export const vllmEnvironment = {
  HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", VLLM_NO_USAGE_STATS: "1", VLLM_DO_NOT_TRACK: "1", VLLM_PLUGINS: "",
};
