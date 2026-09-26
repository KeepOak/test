/* Service marks: each service's own official mark, shown only to say which service a person connects, never to suggest
   that its maker endorses Branch. The owner decided to show them after being told each maker's rules. Each is shown as
   published: unmodified, in its own colours, on a plain light tile with clear space around it (public/art/providers/,
   public/art/channels/; source, licence and brand page of every file in THIRD_PARTY_NOTICES.md).
   Two makers forbid any use of their marks without a licence, even to identify a service: Microsoft ("Don't use
   Microsoft's logos, icons, or designs, in any manner") and Apple (no Apple-owned icon "for any other purpose except
   pursuant to an express written trademark license"). Their services get a neutral glyph, as Email does. A service
   with no mark in the licensed sets gets its initials on a steady colour. */

import { esc } from "./dom.js";
import { ICONS } from "./icons.js";

const P = "art/providers/", C = "art/channels/";
/* The engine's service, pool, program and channel ids -> the mark's file. */
const MARKS = {
  openai: P + "openai", chatgpt: P + "openai", "openai-responses": P + "openai", codex: P + "codex", "cli-codex": P + "codex",
  anthropic: P + "anthropic", claude: P + "claude", "anthropic-vertex": P + "claude", "claude-code": P + "claudecode", "cli-claude-code": P + "claudecode",
  gemini: P + "gemini", google: P + "gemini", "gemini-cli": P + "geminicli", "cli-gemini-cli": P + "geminicli", "vertex-ai": P + "vertexai", "google-palm": P + "palm",
  mistral: P + "mistral", groq: P + "groq", openrouter: P + "openrouter", together: P + "together", fireworks: P + "fireworks",
  deepseek: P + "deepseek", xai: P + "xai", perplexity: P + "perplexity", cohere: P + "cohere", cerebras: P + "cerebras",
  sambanova: P + "sambanova", huggingface: P + "huggingface", cloudflare: P + "cloudflare", bedrock: P + "bedrock", ollama: P + "ollama",
  "lm-studio": P + "lmstudio", vllm: P + "vllm", "vercel-ai-gateway": P + "vercel", moonshot: P + "moonshot", zhipu: P + "zhipu",
  zai: P + "zai", dashscope: P + "qwen", minimax: P + "minimax", modelscope: P + "modelscope", doubao: P + "doubao",
  qianfan: P + "baiducloud", voyageai: P + "voyage",
  github: P + "github", "github-models": P + "github", "github-copilot": P + "github", copilot: P + "github", "cli-copilot": P + "github",
  telegram: C + "telegram", discord: C + "discord", slack: C + "slack", whatsapp: C + "whatsapp", messenger: C + "messenger",
  instagram: C + "instagram", matrix: C + "matrix", signal: C + "signal", mattermost: C + "mattermost", rocketchat: C + "rocketdotchat",
  googlechat: C + "googlechat", zulip: C + "zulip", line: C + "line", viber: C + "viber", twitch: C + "twitch", webex: C + "webex",
  "synology-chat": C + "synology", zalo: C + "zalo", mastodon: C + "mastodon", bluesky: C + "bluesky", reddit: C + "reddit",
  discourse: C + "discourse", "x-dm": C + "x", "nextcloud-talk": C + "nextcloud", ntfy: C + "ntfy", threema: C + "threema",
  homeassistant: C + "homeassistant", xmpp: C + "xmpp", mqtt: C + "mqtt", keybase: C + "keybase", simplex: C + "simplex", vk: C + "vk",
  "qq-bot": C + "qq", guilded: C + "guilded", revolt: C + "revoltdotchat", mumble: C + "mumble", "wechat-mp": C + "wechat", drive: C + "googledrive",
};
/* Not a brand (Email), or a maker that allows no use of its marks at all (Microsoft, Apple): the window's own glyph. */
const GLYPHS = { email: "mail", outlook: "mail", imessage: "chat", msteams: "chat", "msteams-bot": "chat", "azure-openai": "globe", "azure-openai-v1": "globe" };
const PALETTE = ["#2E6A8A", "#6B4A8A", "#8A4F2A", "#3A5A99", "#2F7A4A", "#8A2F4F", "#4F6B2A", "#2A6B6B"];
/* A connection or model id often starts or contains its service's id ("openai-work", "cli-agent:claude-code").
   Only model services are matched this way; a chat app is matched by its exact id ("line" is in "pipeline"). */
const SERVICES = Object.keys(MARKS).filter((k) => MARKS[k].startsWith(P)).sort((a, b) => b.length - a.length);
const markFor = (key) => MARKS[key] ?? MARKS[SERVICES.find((k) => key.startsWith(`${k}-`) || (k.length >= 5 && key.includes(k))) ?? ""];

function tint(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* id: the engine's service, pool, program or channel id; size in px. */
export function logo(id, name = id, size = 30) {
  const key = String(id ?? "").toLowerCase();
  const box = `width:${size}px;height:${size}px;background:`;
  const inner = Math.round(size * 0.62);
  const glyph = GLYPHS[key] ?? GLYPHS[Object.keys(GLYPHS).find((k) => key.startsWith(`${k}-`)) ?? ""];
  const file = glyph ? "" : markFor(key);
  if (file) return `<span class="logo mark14" data-css="${box}#fff"><img src="/${file}.svg" alt="" width="${inner}" height="${inner}"></span>`;
  if (glyph) return `<span class="logo" data-css="${box}#56616B"><svg class="i" viewBox="0 0 24 24" aria-hidden="true" data-css="color:#fff;width:${inner}px;height:${inner}px">${ICONS[glyph] ?? ""}</svg></span>`;
  const text = (key || String(name)).replace(/^cli-/, "").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return `<span class="logo" data-css="${box}${tint(key)}"><b data-css="font:700 11px var(--sans);color:#fff">${esc(text)}</b></span>`;
}
