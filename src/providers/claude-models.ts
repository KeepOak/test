/** Included Claude Code subscription choices; aliases follow the current version, fixed ids keep the owner's choice. */
export const claudeCodePool = "cli-claude-code";
export const claudeSubscriptionModels = [
  // The pool's own connection is Branch's default model (claudeDefaultModel in cli-agent.ts), Opus 5.5.
  { id: "claude-opus-5-5", presetId: claudeCodePool, label: "Claude · Opus 5.5" },
  { id: "sonnet", presetId: "cli-claude-code-sonnet", label: "Claude · Sonnet (latest)" },
  { id: "opus", presetId: "cli-claude-code-opus", label: "Claude · Opus (latest)" },
  { id: "haiku", presetId: "cli-claude-code-haiku", label: "Claude · Haiku (latest)" },
  { id: "claude-sonnet-5", presetId: "cli-claude-code-sonnet-5", label: "Claude · Sonnet 5" },
  { id: "claude-haiku-4-5", presetId: "cli-claude-code-haiku-4-5", label: "Claude · Haiku 4.5" },
] as const;

/** Exact known ids only: a custom program whose name shares this prefix keeps its own connection. */
export const claudeSubscriptionPreset = (id: string) => claudeSubscriptionModels.find((entry) => entry.presetId === id);

/*
 * provider-audit: the context window of a Claude subscription route. Behind Branch's relay Claude Code applies its
 * gateway default, 200K, unless the long-context route is named with the `[1m]` suffix; then the known long-context
 * models have 1M. The table follows Hermes Agent's DirectSDK plugin (`model_catalog.py`, MIT) and OpenClaw's Claude
 * backend (`extensions/anthropic/cli-backend.ts`, MIT), which select 1M the same way. Haiku has no 1M route.
 */
export const claudeStandardWindow = 200_000;
export const claudeLongWindow = 1_000_000;
const claudeAliases: Readonly<Record<string, string>> = { sonnet: "claude-sonnet-5", opus: "claude-opus-5-5", fable: "claude-fable-5-1" };
const claudeLongContext: ReadonlySet<string> =
  new Set(["claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-fable-5-1"]);
/** The model a subscription id names (an alias follows the current version), without any `[1m]`. */
export const claudeCanonicalModel = (model: string): string => {
  const base = model.replace(/\[1m\]$/i, "");
  return claudeAliases[base] ?? base;
};
export const claudeHasLongContext = (model: string): boolean => claudeLongContext.has(claudeCanonicalModel(model));

/** A subscription plan that includes the 1M routes (Max, Team, Enterprise). Pro, Free and an unknown plan do not. */
export const planIncludesLongContext = (plan: string | null | undefined): boolean => /max|team|enterprise/i.test(plan ?? "");
/** One row of the model list Claude Code's `initialize` answer carries (the account's own model picker). */
export interface ClaudePickerRow { value?: string; resolvedModel?: string; description?: string }
/**
 * Whether this account's 1M route of `model` is included in its plan: the plan says so, and the account's own model
 * picker does not mark that route as drawing usage credits (Claude Code marks Opus 1M so on some plans).
 */
export function longContextIncluded(model: string, plan: string | null | undefined, picker: readonly ClaudePickerRow[] = []): boolean {
  if (!claudeHasLongContext(model) || !planIncludesLongContext(plan)) return false;
  const canonical = claudeCanonicalModel(model);
  return !picker.some((row) => {
    const named = [row.resolvedModel, row.value].filter((one): one is string => typeof one === "string");
    const long = named.some((one) => /\[1m\]$/i.test(one) && claudeCanonicalModel(one) === canonical);
    return long && /usage credit/i.test(row.description ?? "");
  });
}
/** The route the native program is started with: the long-context one when it is included, else the model as named. */
export const claudeNativeRoute = (model: string, longContext: boolean): string =>
  longContext && claudeHasLongContext(model) ? `${claudeCanonicalModel(model)}[1m]` : model;
/** The window a Claude subscription preset budgets for. */
export const claudeSubscriptionWindow = (model: string, longContext: boolean): number =>
  longContext && claudeHasLongContext(model) ? claudeLongWindow : claudeStandardWindow;
