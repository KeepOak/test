# Telegram Settings readout

Gateway → Chat apps, in depth → Telegram, in depth now opens the local engine's metadata snapshot. It reports each loaded Telegram adapter's health state, configured group activation, pairing, allowlist count, concrete typing/reaction/edit/button/voice-reply methods, and message limit. Shared live-status, commands, steering, splitting and steps switches are shown with their actual three-way value.

These are configuration and adapter capabilities, not delivery proof or enabled permissions. The readout makes no Telegram/model calls and shows no sender IDs, bot names, message bodies, provider errors or webhook secrets. The endpoint uses the existing owner-only channels gate; the window checks the active owner before and after reading. No data is retained in window state.

CHAT-257 remains partial: delivery already has its own readout, but voice-note records, broadcast setup, router-rule UI and secret-address review are separate gaps. This change does not relax chat approvals, reveal addresses or claim voice-transcription availability from a voice-send method.

Source and diff review only. Tests, builds and runtime checks are deferred by the owner.
