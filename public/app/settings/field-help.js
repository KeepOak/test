/* Original Branch field copy, keyed by the actual store and field, not a translated row title.
   Pattern reference: Hermes field-copy.ts at f42f579 (MIT); no upstream implementation copied.
   These explanations follow src/knobs/apply.ts and src/settings-kit/catalogue.ts. */
const COPY = {
  "knobs.compaction.contextWindowTokens": "Sets the token room used to decide when this conversation needs compacting. An unset value uses the model's built-in context budget.",
  "knobs.compaction.autoCompact": "Allows older conversation content to be folded when it reaches the compaction threshold. Turning this off leaves the conversation as it is.",
  "knobs.compaction.compactAtPercent": "Starts compacting at this percentage of the context budget. An unset value uses the model's normal threshold.",
  "knobs.compaction.keepRecentMessages": "Keeps this many recent messages word for word when older conversation content is compacted.",
  "knobs.limits.maxSteps": "Limits how many steps a new task can take before stopping. This is read from the owner's saved task budget.",
  "knobs.limits.maxTaskTokens": "Limits the token budget for a new task. An unset value uses 200,000 tokens.",
  "knobs.limits.apiRetries": "Changes the maximum retries for model service requests. An unset value keeps the launch retry policy.",
  "settings-kit.os-sandbox.network": "Chooses what a program inside the system sandbox may reach: no network, limited access, named sites, or open access. This does not grant access to files outside its sandbox.",
};

export const fieldHelp = path => COPY[path] ?? "";
