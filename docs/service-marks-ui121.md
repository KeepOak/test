# Service marks: UI121 and CHAT154

The shared mark catalogue retains existing supported provider/chat drawings. OpenAI and ChatGPT use the existing square Blossom symbol (`public/art/providers/openai.svg`, `viewBox="0 0 24 24"`), not a wordmark. Every mark is centred inside a square light tile with 19% clear space on each side and `object-fit:contain`; non-square marks keep their intrinsic ratio. No recolouring, filtering or transforms are applied.

Gotify now uses the original small colour logo from the project's official logo repository, pinned at `25c1d2c08894fcb0ed39c36a2816316a161c0e57`. The file is copied unchanged. CC BY 4.0 licence and attribution are shipped beside the asset and in THIRD_PARTY_NOTICES. There is no package dependency or downloaded executable.

Unknown providers/services get the existing neutral globe drawing, and IRC gets a neutral chat drawing. No fallback constructs letters from a service ID or name. Microsoft Teams, Outlook, Azure and Apple services retain neutral drawings because the existing catalogue's mark policy requires express permission. These are explicitly gaps in **real logo** coverage, even though the no-letter requirement is addressed. IRC names a protocol rather than a single branded service; no vendor/network logo is assigned to all IRC connections.

Secrets sign-ins use a fixed exact-host map for 17 recognised service hosts. Every other host uses the neutral key drawing. Host metadata comes from the existing saved sign-in settings; the display never fetches favicons, inspects credentials or guesses by suffix/substring. The existing host name remains visible next to the decorative icon. The map does not broaden autofill's exact-host authorization.

Provider-ID lookup no longer matches arbitrary embedded provider strings such as `notopenai`; it supports existing exact IDs and start-of-ID separators or `cli-agent:` namespaces. Chat apps remain exact-ID matches. Existing SVGs remain decorative beside their visible service names.

Primary sources checked: https://github.com/gotify/logo and its pinned LICENSE/README, https://openai.com/brand/, and https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks. Drawing licences are not blanket trademark permission. No logo has been fabricated to fill a catalogue gap.

Tests: `tests/service-marks.test.mjs`. Other services with no accepted mark remain neutral; full real-logo coverage is not claimed.
