import { t } from "../../i18n.js";
/* Original Branch field copy, keyed by the actual store and field, not a translated row title.
   Pattern reference: Hermes field-copy.ts at f42f579 (MIT); no upstream implementation copied.
   These explanations follow src/knobs/apply.ts and src/settings-kit/catalogue.ts. */
const COPY = {
  "settings-kit.os-sandbox.mode": "settings.help.settings-kit.os-sandbox.mode",
  "knobs.compaction.contextWindowTokens": "settings.help.knobs.compaction.contextWindowTokens",
  "knobs.compaction.autoCompact": "settings.help.knobs.compaction.autoCompact",
  "knobs.compaction.compactAtPercent": "settings.help.knobs.compaction.compactAtPercent",
  "knobs.compaction.keepRecentMessages": "settings.help.knobs.compaction.keepRecentMessages",
  "knobs.limits.maxSteps": "settings.help.knobs.limits.maxSteps",
  "knobs.limits.maxTaskTokens": "settings.help.knobs.limits.maxTaskTokens",
  "knobs.limits.apiRetries": "settings.help.knobs.limits.apiRetries",
  "settings-kit.os-sandbox.network": "settings.help.settings-kit.os-sandbox.network",
};

export const fieldHelp = path => COPY[path] ? t(COPY[path]) : "";
