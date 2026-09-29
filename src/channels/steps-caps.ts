import type { StepsDisplay } from "./steps-display.js";

/**
 * What each chat app can do for the steps message, and what Branch does there. It covers every chat app Branch
 * connects to: the ones with an adapter of their own, the ones in src/channels/connectors.ts, and the team-chat
 * services in data/channels.json. tests/chat-steps-channels.test.mjs builds every adapter and checks each row against
 * it, so a row cannot claim an edit, a reaction or a length the app's adapter does not have.
 *
 * `code` is how a command or a path is marked: Telegram's own code entities (a labelled block with a copy button),
 * Markdown fences with the language (Discord), fences without one (Slack prints a language as a line of code, as
 * Hermes Agent found), Matrix's HTML, or plain words.
 *
 * `hermes` and `openclaw` are what those projects do by default in that app (Hermes Agent's gateway/display_config.py
 * tier table and OpenClaw's docs/concepts/streaming.md and progress-drafts.md), where they support it at all.
 */
export type StepsCode = "telegram" | "fence" | "fence-plain" | "html" | "plain";
export interface StepsCaps {
  kind: string;
  name: string;
  edit: boolean;
  code: StepsCode;
  /** The longest message the adapter sends; 3500 where the adapter leaves it to Branch's default. */
  maxText: number;
  reactions: boolean;
  typing: boolean;
  /** The steps message and the reply answer the person's own message (a reply or a thread) rather than float free. */
  replies: boolean;
  /** Each message costs the owner money (SMS): nothing is added that was not asked for. */
  paid?: boolean;
  hermes?: string;
  openclaw?: string;
}
const plainApp = (kind: string, name: string, maxText: number, extra: Partial<StepsCaps> = {}): StepsCaps =>
  ({ kind, name, edit: false, code: "plain", maxText, reactions: false, typing: false, replies: false, ...extra });
const HERMES_NO_EDIT = "off: no edits, so no progress";
export const STEPS_CAPS: readonly StepsCaps[] = [
  { kind: "telegram", name: "Telegram", edit: true, code: "telegram", maxText: 3500, reactions: true, typing: true, replies: true,
    hermes: "off by default; all when on, one bubble edited every 1.5 s", openclaw: "progress draft edited in place (default)" },
  { kind: "discord", name: "Discord", edit: true, code: "fence", maxText: 2000, reactions: true, typing: true, replies: true,
    hermes: "all, one bubble edited", openclaw: "off by default; progress draft when chosen, deleted after the answer" },
  { kind: "slack", name: "Slack", edit: true, code: "fence-plain", maxText: 3000, reactions: true, typing: false, replies: true,
    hermes: "off (Bolt posts are permanent)", openclaw: "native progress card in threads; typing reaction outside them" },
  { kind: "matrix", name: "Matrix", edit: true, code: "html", maxText: 3500, reactions: true, typing: true, replies: true,
    hermes: "new (only when the tool changes)", openclaw: "draft preview edited in place" },
  plainApp("whatsapp", "WhatsApp", 4000, { replies: true, reactions: true, typing: true, hermes: "new through the Baileys bridge; off on the Cloud API", openclaw: "final answer only" }),
  plainApp("signal", "Signal", 2000, { replies: true, reactions: true, typing: true, hermes: HERMES_NO_EDIT, openclaw: "final answer only" }),
  plainApp("email", "Email", 3500, { replies: true, hermes: "off (batch delivery)", openclaw: "final answer only" }),
  plainApp("messenger", "Facebook Messenger", 1900),
  plainApp("instagram", "Instagram", 1900),
  plainApp("sms", "SMS (Twilio)", 1600, { paid: true, hermes: "off (batch delivery)" }),
  plainApp("imessage", "iMessage", 3000, { hermes: HERMES_NO_EDIT, openclaw: "final answer only" }),
  plainApp("msteams-bot", "Microsoft Teams (bot)", 3500, { replies: true, openclaw: "native progress stream in personal chats" }),
  plainApp("irc", "IRC", 2000), plainApp("twitch", "Twitch chat", 2000), plainApp("gotify", "Gotify", 3500),
  plainApp("webex", "Webex", 3500, { replies: true }), plainApp("synology-chat", "Synology Chat", 2000),
  plainApp("zalo", "Zalo", 2000), plainApp("flock", "Flock", 3500), plainApp("pumble", "Pumble", 3500, { replies: true }),
  plainApp("mastodon", "Mastodon", 420, { replies: true }), plainApp("bluesky", "Bluesky", 1000),
  plainApp("reddit", "Reddit", 3500, { replies: true }), plainApp("discourse", "Discourse", 3500, { replies: true }),
  plainApp("x-dm", "X direct messages", 3500), plainApp("twist", "Twist", 3500),
  plainApp("nextcloud-talk", "Nextcloud Talk", 3500, { replies: true }), plainApp("ntfy", "ntfy", 3500),
  plainApp("pushover", "Pushover", 1024), plainApp("threema", "Threema", 3500),
  plainApp("homeassistant", "Home Assistant", 3500, { hermes: "off (batch delivery)" }), plainApp("xmpp", "XMPP", 3500),
  plainApp("mqtt", "MQTT", 3500), plainApp("keybase", "Keybase", 3500), plainApp("simplex", "SimpleX", 3500),
  plainApp("deltachat", "Delta Chat", 3500), plainApp("nostr", "Nostr", 3500, { replies: true }),
  plainApp("vk", "VK", 3500, { replies: true }), plainApp("qq-bot", "QQ bot", 3500, { replies: true }),
  plainApp("guilded", "Guilded", 3500, { replies: true }), plainApp("revolt", "Revolt", 2000, { replies: true }),
  plainApp("mumble", "Mumble", 3500), plainApp("kook", "KOOK", 4000, { replies: true }),
  plainApp("bluebubbles", "iMessage through BlueBubbles", 3000, { hermes: HERMES_NO_EDIT, openclaw: "final answer only" }),
  plainApp("whatsapp-web", "WhatsApp (personal number)", 4000, { replies: true, hermes: "new through the Baileys bridge", openclaw: "final answer only" }),
  plainApp("wechat-mp", "WeChat Official Account", 600, { hermes: HERMES_NO_EDIT }),
  plainApp("wecom-app", "WeCom app", 600, { hermes: "off; native stream message type instead" }),
  plainApp("mattermost", "Mattermost", 4000, { replies: true, hermes: "new (edits in place)", openclaw: "partial draft preview" }),
  plainApp("rocketchat", "Rocket.Chat", 4000, { replies: true }), plainApp("googlechat", "Google Chat", 4000, { replies: true }),
  plainApp("msteams", "Microsoft Teams (webhook)", 4000, { replies: true }), plainApp("zulip", "Zulip", 4000, { replies: true }),
  plainApp("feishu", "Feishu / Lark", 4000, { replies: true, hermes: "new (edits in place)" }),
  plainApp("dingtalk", "DingTalk", 2000, { replies: true, hermes: HERMES_NO_EDIT }), plainApp("wecom", "WeCom (webhook)", 2000, { replies: true }),
  plainApp("line", "LINE", 4900, { replies: true }), plainApp("viber", "Viber", 7000, { replies: true }),
];
export const stepsCapsOf = (kind: string): StepsCaps | undefined => STEPS_CAPS.find((caps) => caps.kind === kind);

/** What the steps look like in an app, in words, from what it can do and the owner's knobs for it. */
export function stepsBehaviour(caps: StepsCaps, display: StepsDisplay): string {
  if (caps.paid) return "Nothing added: each message costs money";
  if (display.detail === "off") return "Off";
  if (caps.edit) {
    const how = display.grouping === "each" ? "A message per step" : "One message, edited in place";
    return `${how}${display.overflow === "roll" && display.grouping !== "each" ? ", a new one when it is full" : ""}`;
  }
  if (display.noEdit === "each") return "A message per step (plain words)";
  if (display.noEdit === "summary") return "One summary line above the reply (plain words)";
  return "Off";
}
const codeWords: Record<StepsCode, string> = {
  telegram: "code blocks with a label and copy button", fence: "Markdown fences with the language",
  "fence-plain": "fences without a language", html: "HTML code blocks", plain: "plain words",
};
const yes = (value: boolean) => (value ? "yes" : "—");
/** The capability table, as Markdown, for docs/chat-parity.md, the pull request and the status notes. */
export function stepsCapsTable(display: StepsDisplay): string {
  const rows = STEPS_CAPS.map((caps) => `| ${caps.name} (\`${caps.kind}\`) | ${yes(caps.edit)} | ${codeWords[caps.code]} | ${caps.maxText} | `
    + `${yes(caps.reactions)} | ${yes(caps.replies)} | ${caps.hermes ?? "—"} | ${caps.openclaw ?? "—"} | ${stepsBehaviour(caps, display)} |`);
  return ["| App | Edits | Code | Longest | Reactions | Replies | Hermes Agent | OpenClaw | Branch (as shipped) |",
    "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}
