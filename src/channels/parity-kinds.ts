/**
 * The kinds of the added chat services (parity-services.ts), known without loading them: the connections file's shape
 * and the setup recipes need only the names. tests/idle-memory-footprint.test.mjs keeps this list equal to the
 * services' own kinds, in their order.
 */
export const PARITY_KINDS = [
  "irc", "twitch", "gotify", "imessage", "msteams-bot", "webex", "synology-chat", "zalo", "flock", "pumble",
  "mastodon", "bluesky", "reddit", "discourse", "x-dm", "twist", "nextcloud-talk", "sms", "ntfy", "pushover",
  "threema", "homeassistant", "xmpp", "mqtt", "keybase", "simplex", "deltachat", "nostr", "vk", "qq-bot",
  "guilded", "revolt", "mumble", "kook", "wechat-mp", "wecom-app", "bluebubbles",
] as const;

/**
 * The added services bound to some systems, with the name each is set up under, known without loading the services: the
 * Set up panel and the catalog read it as they draw (src/channel-setup/service.ts). tests/parity-platforms.test.mjs keeps
 * it equal to the services' own `platforms` (parity-services.ts), so the two cannot drift.
 */
export const PARITY_PLATFORMS: Readonly<Record<string, { readonly name: string; readonly platforms: readonly NodeJS.Platform[] }>> = {
  imessage: { name: "iMessage", platforms: ["darwin"] },
};
