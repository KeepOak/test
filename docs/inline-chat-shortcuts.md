# Inline read-only chat shortcuts

CHAT-210 adds `/status` and `/whoami` inside an original authored Telegram or Discord direct message, for example `Please continue /status with the report`. The existing sender admission, platform pause, ceiling, command switches and standalone command availability apply. Replies bypass the task queue and model; the remaining text starts or steers the ordinary task. Token removal preserves the original surrounding whitespace and line endings. Neither shortcut grants tools or changes permissions.

Only these two exact lowercase tokens are recognized, bounded to 16 occurrences in 16 KiB. Each distinct shortcut replies once, with a distinct delivery key. Arguments, aliases, bot suffixes, punctuation-attached tokens and arbitrary slash commands are not inline commands. Remaining text is never rescanned as an approval, saved command, owner command or button.

The adapter supplies the exact original text and native code, quote and link spans. Telegram forwards, voice/media, mentions transformed by the adapter, native button payloads and unknown provenance receive no authored-text claim. Markdown quote lines, indentation, code fences, inline code, literal quotes, links and URLs remain text. Malformed spans refuse the fast path. Edits and catch-up messages are excluded. A lock, revoked sender admission or changed command switch stops further dispatch. A working turn belonging to another sender is not inspected by this path; groups are excluded.

Discord vouches only for a plain direct message: a default user message with no reply, forward, webhook, embed, attachment, mention or Markdown marks. Other adapters remain unchanged and fail closed for inline shortcuts until they explicitly supply authored-text provenance with quote/code/link spans. Existing standalone command handling remains as before.

Primary references inspected: [OpenClaw command detection](https://github.com/openclaw/openclaw/blob/main/src/auto-reply/command-detection.ts), [slash command fast-path documentation](https://docs.openclaw.ai/tools/slash-commands), and [MIT licence](https://github.com/openclaw/openclaw/blob/main/LICENSE). OpenClaw's coarse detector identifies candidates for later authorization; Branch's parser is independently written with exact tokens and transport provenance. No copied source or new dependency.

Tests: `tests/inline-shortcuts.test.mjs`.
