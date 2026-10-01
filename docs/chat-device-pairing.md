# Device pairing requested from chat

Type `/pair phone [device name]` or `/pair computer [device name]` in an approved account the owner explicitly marked as their own, in a direct chat on a transport whose servers vouch for senders (the existing `ownerDmHere` contract). Email, SMS and posted webhooks cannot request pairing. Group, voice, edited and catch-up messages cannot request pairing. Branch must be unlocked and outside Lockdown, and current sender access must allow the request.

The request expires after two minutes and does not create a code, key, device record or invitation. The local owner window offers **Create invitation here**, showing the channel, direct chat, sender and intended device kind/name. This uses the existing `/api/devices/invite` route with a one-time proposal identifier. The server checks expiry, original sender approval/owner identity/current access, local-window origin and target kind again. The proposal identifier is not a device credential and is never returned to chat.

Only the local window displays the actual invitation code and link. Devices remain subject to their existing off/on mode, five-minute invitation, attempt limits, device signature, and **Let it in** confirmation after comparing the new device's check code. Device names in proposals are descriptive; the actual cryptographic device identity is verified by the existing pairing flow. Nothing automatically opens Tailscale, enables Devices or approves a device.

There are at most eight pending requests, twenty requesting accounts per minute, and one request per account per minute. Proposals live in memory: restart discards them. Dismissed proposals disappear from this window's prompts and expire; it is safe to send a fresh request after the rate limit. If Devices is off when consent is given, switch it on explicitly and send a fresh `/pair` request. Chat never receives pairing secrets.

Source-only delivery: no live pairing or native-window behavior was exercised in the implementation session.
