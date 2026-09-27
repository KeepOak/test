/**
 * Which model an eval run is judged on. Never a paid API: a model on this computer (Ollama), or a coding assistant
 * installed here used through Branch's own subscription connection (Claude Code, Codex), or the scripted stand-in for
 * the smoke subset. Each is connected to the eval's own engine the way a person would connect it.
 */
import { spawnSync } from "node:child_process";

const ollamaBase = process.env.EVAL_OLLAMA_URL ?? "http://127.0.0.1:11434";

/** Tool-capable local families, best first for a laptop GPU of about 8 GB. */
const preferred = [/^qwen2\.5:7b/, /^qwen3:(8b|14b)/, /^qwen2\.5:(7b|14b)/, /^qwen3/, /^llama3\.1:8b/, /^mistral-nemo/, /^qwen2\.5/, /^llama3\.2/, /^mistral/];

export async function ollamaModels() {
  const tags = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  if (!tags?.models) return null;
  const found = [];
  for (const entry of tags.models) {
    const shown = await fetch(`${ollamaBase}/api/show`, { method: "POST", body: JSON.stringify({ model: entry.name }), signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).catch(() => null);
    const tools = Array.isArray(shown?.capabilities) ? shown.capabilities.includes("tools") : null;
    found.push({ name: entry.name, tools, size: entry.size });
  }
  return found;
}

/** The best tool-capable model Ollama has, or null with the reason. */
export async function bestOllama() {
  const models = await ollamaModels();
  if (!models) return { model: null, reason: "needs local model: Ollama is not running on this computer" };
  const usable = models.filter((m) => m.tools !== false);
  if (!usable.length) return { model: null, reason: "needs local model: Ollama has no model that can call tools" };
  const rank = (name) => { const at = preferred.findIndex((re) => re.test(name)); return at === -1 ? preferred.length : at; };
  usable.sort((a, b) => rank(a.name) - rank(b.name) || b.size - a.size);
  return { model: usable[0].name, reason: null };
}

function onPath(command) {
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [command], { encoding: "utf8", windowsHide: true }).status === 0;
}

/**
 * One model description from a name on the command line: "ollama" (best found), "ollama:<tag>", "claude-code",
 * "codex" or "standin". `unavailable` says why it cannot run here; its tasks are then reported with that status.
 */
export async function describeModel(name, { standinPort } = {}) {
  if (name === "standin")
    return { id: "standin", label: "stand-in (scripted, smoke only)", kind: "standin", branchTools: true,
      env: { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: `http://127.0.0.1:${standinPort}/v1`, BRANCH_MODEL: "stand-in", BRANCH_API_KEY: "stand-in" } };
  if (name === "ollama" || name.startsWith("ollama:")) {
    const asked = name.slice("ollama:".length);
    const best = asked ? { model: asked, reason: (await ollamaModels()) ? null : "needs local model: Ollama is not running on this computer" } : await bestOllama();
    // Ollama on this computer is connected the way a person does it (Settings' Ollama line, 127.0.0.1:11434). One on
    // another machine (EVAL_OLLAMA_URL, e.g. a bigger GPU on the home network) goes in through the engine's own
    // OpenAI-shaped start-up connection, since the Ollama line only ever reaches this computer.
    const remote = ollamaBase.replace(/\/$/, "") !== "http://127.0.0.1:11434";
    return { id: `ollama:${best.model ?? "none"}`, label: `Ollama ${best.model ?? "(none)"}${remote ? ` at ${ollamaBase}` : ""}`,
      kind: remote ? "env" : "ollama", tag: best.model, branchTools: true, unavailable: best.reason,
      ...(remote ? { env: { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: `${ollamaBase.replace(/\/$/, "")}/v1`, BRANCH_MODEL: best.model ?? "", BRANCH_API_KEY: "ollama" } } : {}) };
  }
  if (name === "claude-code" || name === "codex") {
    const command = name === "claude-code" ? "claude" : "codex";
    return { id: name, label: `${name} (subscription, through Branch's own connection)`, kind: "cli", cli: name,
      // src/providers/cli-agent.ts: the program answers in words and never calls Branch's tools, by design.
      branchTools: false,
      unavailable: onPath(command) ? null : `needs sign-in: "${command}" is not installed on this computer` };
  }
  throw new Error(`unknown model "${name}"; use ollama, ollama:<tag>, claude-code, codex or standin`);
}

const numCtx = Number(process.env.EVAL_NUM_CTX ?? 8192);

/**
 * A copy of a local model that always opens with room for the whole prompt. This is exactly what Branch's own
 * "on this computer" flow does (`src/local-models.ts` `sized`): Ollama shares the weights, so it costs no disk, and
 * every conversation gets the fitted window without the chat code having to send num_ctx. A raw Ollama connection
 * would fall back to Ollama's small default window and silently truncate the tool list.
 */
async function sizedTag(tag) {
  const sized = `branch-evals-${tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${numCtx}`;
  const response = await fetch(`${ollamaBase}/api/create`, {
    method: "POST", signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model: sized, from: tag, parameters: { num_ctx: numCtx }, stream: false }),
  });
  if (!response.ok) return tag; // fall back to the raw tag; the run will note the smaller window
  await response.text();
  // Warm it and keep it resident for the run, so a fresh per-task engine does not pay a cold load (which can outrun
  // the engine's own model-test timeout and surface as "fetch failed").
  await fetch(`${ollamaBase}/api/generate`, {
    method: "POST", signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model: sized, prompt: "", keep_alive: "30m", options: { num_ctx: numCtx } }),
  }).then((r) => r.text()).catch(() => undefined);
  return sized;
}

/** Connects the model to a fresh engine and makes it the one in use. */
export async function connectModel(engine, model) {
  if (model.kind === "standin" || model.kind === "env") return;
  let id;
  if (model.kind === "ollama") {
    const tag = await sizedTag(model.tag);
    id = (await engine.api("connections/from-preset", { provider: "ollama", key: "", model: tag })).id;
  } else id = (await engine.api("providers/cli-agents", { id: model.cli })).id;
  await engine.api("models", { activePreset: id });
}

/** One tiny question through the engine, before any task: a model that cannot answer is reported, not failed 30 times. */
export async function preflight(engine) {
  const answer = await engine.api("models/test", {}, { raw: true, timeoutMs: 120_000 });
  if (answer.status === 200) return null;
  const words = String(answer.data?.error ?? answer.status);
  return /sign ?in|log ?in|login|auth|credential|not logged/i.test(words) ? `needs sign-in: ${words.slice(0, 200)}` : `model did not answer: ${words.slice(0, 200)}`;
}
