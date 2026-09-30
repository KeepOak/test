import type { ModelRouter } from "./models.js";
import { unwrapProvider } from "./accounts/pool-provider.js";
import { CliAgentProvider } from "./providers/cli-agent.js";
import { codexCandidates, codexChosen, codexModelsFor, codexOffered, codexVerified, type CodexModels } from "./codex-models.js";

/* QA 2026-09-28: GET/POST /api/codex-models and POST /api/codex-models/check, the owner's. Settings › Models ›
   Connections draws Codex's model picker from it (public/app/settings/pages/models.js). */
const connection = "cli-codex";
function codexOf(models: ModelRouter): { codex: CodexModels; provider: CliAgentProvider | null } {
  const codex = codexModelsFor(models);
  if (!codex) throw new Error("Codex's model choice is not connected in this Branch");
  const preset = models.presets.get(connection), provider = preset ? unwrapProvider(preset.provider) : null;
  return { codex, provider: provider instanceof CliAgentProvider ? provider : null };
}
export function codexModelsView(models: ModelRouter) {
  const { codex, provider } = codexOf(models), settings = codex.settings();
  return { connected: provider !== null, ...settings, offered: codexOffered(settings), inUse: codexChosen(settings),
    candidates: [...codexCandidates], verified: [...codexVerified] };
}
export function chooseCodexModel(models: ModelRouter, input: unknown) {
  codexOf(models).codex.choose(input);
  return codexModelsView(models);
}
/** Checks every candidate now through the Codex connection: one tiny request for each model it takes. */
export async function checkCodexModels(models: ModelRouter) {
  const { codex, provider } = codexOf(models);
  if (!provider) throw new Error("Add Codex under Settings › Accounts first; there is no Codex connection to check.");
  const kept = await codex.check(provider.probe(), "all");
  return { ...codexModelsView(models), checked: kept !== null,
    ...(kept ? {} : { note: "Codex could not be checked just now (its sign-in, its folder's trust or its plan limit), so nothing changed. Try again once it answers." }) };
}
