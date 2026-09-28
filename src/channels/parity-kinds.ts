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
