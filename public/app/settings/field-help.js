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
  "settings-kit.policy.preset": "settings.help.policy-preset",
  "settings-kit.policy.unmatchedCommands": "settings.help.unmatched-commands",
  "settings-kit.voice.autoReadAloud": "settings.help.voice-auto",
  "settings-kit.voice.readAloudWhen": "settings.help.voice-aloud",
  "settings-kit.voice.keepAudioOnThisComputer": "settings.help.voice-local-audio",
  "settings-kit.voice.replyWithVoiceOnChannels": "settings.help.voice-channel-reply",
  "settings-kit.live-dictation.mode": "settings.help.dictation-mode",
  "settings-kit.live-dictation.silenceSeconds": "settings.help.dictation-silence",
  "settings-kit.wake-word.sureness": "settings.help.wake-sureness",
  "settings-kit.retention.enabled": "settings.help.retention-enabled",
  "settings-kit.retention.keepDays": "settings.help.retention-days",
  "settings-kit.comfort-keys.vim": "settings.help.vim-keys",
  "settings-kit.comfort-display.timestamps": "settings.help.message-times",
  "settings-kit.comfort-display.hideTimes": "settings.help.hide-times",
  "settings-kit.comfort-notify.method": "settings.help.notification-method",
  "settings-kit.comfort-notify.sound": "settings.help.notification-sound",
  "settings-kit.comfort-notify.needsYes": "settings.help.notification-approval",
  "settings-kit.comfort-notify.taskDone": "settings.help.notification-task-done",
  "settings-kit.comfort-files.respectGitignore": "settings.help.respect-gitignore",
  "settings-kit.comfort-mcp.startupTimeoutSeconds": "settings.help.tool-server-timeout",
};

export const fieldHelp = path => COPY[path] ? t(COPY[path]) : "";
