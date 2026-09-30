# Discord voice (CHAT-097 / RES-175)

Settings → Voice offers one explicitly approved join, with exact connected
Discord source, server, voice channel, consenting user IDs, purpose, duration,
clip count and model token reservation. It never autojoins or restores a lease.
Only the unlocked local owner may join/leave; tasks, remote callers, household
profiles and short-lived keys cannot. The saved audit contains terms/counts,
not recordings. The room roster must contain only approved participants before
joining; an unapproved participant joining later ends the lease.

The existing authenticated Discord Gateway supplies an optional SDK adapter.
Enabling the GUILD_VOICE_STATES intent requires a fresh Identify and roster
snapshot. Voice Server/State updates stay bound to the selected guild/source;
SDK signalling permits one selected-channel join and departure only. Voice
endpoints must be Discord media hosts and pass Branch's address policy. The
SDK handles its own TLS/UDP transport: this is not an HTTP-network-guard tunnel
or a claim that all SDK DNS/UDP hops are pinned by Branch. Source disconnection,
channel movement, SDK state loss, App lock, privacy changes and deadlines stop
capture/playback and require another explicit owner join. Adapter replacement
and delayed callback checks fence every operation to its original lease.

A prepared @discordjs/voice 0.19.2 bundle, DAVE dependency, @discordjs/opus and
FFmpeg are required. Node 24.17 or newer is required by the reviewed SDK. Optional
modules load only for an owner join; missing/incompatible components hold the
operation. This delivery adds no install, download, mandatory dependency or
fabricated lockfile. Packaging/provisioning those components and their notices
remains a separate owner-approved prerequisite. The SDK is Apache-2.0, the
reviewed Opus binding is MIT; neither is incorrectly treated as Node built-in.
DAVE is explicitly enabled. No plaintext compatibility switch is exposed.

The bot announces its AI/transcription/provider behavior before listening.
Only approved speakers receive subscriptions. One clip at a time is decoded
with Opus into bounded 48 kHz stereo WAV, transcribed by the existing VoiceService,
answered through the existing isolated channel-source remote-voice runtime,
then spoken by the existing TTS and SDK audio player. Owner context/memory/tools
are absent, incoming words are untrusted and replies are secret-scrubbed. Session
length is 30–300 seconds, clips are capped at eight/six seconds each and model
tokens are conservatively reserved before each turn. Capture packets/decoded
bytes/output audio are bounded. SDK playback streams and capture/model work are
closed on stop. Speech/model settings and provider costs still apply; these
usage caps are not an invoice-total dollar guarantee. Local-audio-only privacy
mode refuses joining because Discord necessarily exchanges audio externally.

Receive behavior is not documented by Discord and the SDK explicitly warns
that receive stability is not guaranteed. This implements a bounded turn-based
conversation, not full realtime barge-in, simultaneous mixing or tool-capable
voice agents. Arbitrary participants, automatic room following, restart/rejoin
and owner authority over tools are not implemented. No live connection,
recording, model/provider/DB/credential operation, app, test or build was run in
this delivery. Source/diff inspection is not runtime proof. Authorized DAVE,
codec/playback, roster/cancellation and billing validation remains outstanding.

Stacked on #1205 to reuse its no-owner-context/no-tools runtime isolation;
telephone behavior is retained and its fixed role wording now says 'spoken
conversation'. Separate #1200 Discord threading changes must be preserved when
integrating the narrow Gateway intent/event/stop seam.

References read: [official Discord voice contract](https://docs.discord.com/developers/topics/voice-connections),
[SDK source/requirements](https://github.com/discordjs/discord.js/tree/main/packages/voice)
(including Apache-2.0 license), [Opus API/license](https://github.com/discordjs/opus),
OpenClaw MIT voice SDK/worker/channel docs and Hermes MIT voice mixer. Existing
runtime boundaries and SDK interfaces are reused; no larger upstream voice
manager or codec implementation is copied or invented.
