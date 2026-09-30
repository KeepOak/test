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
