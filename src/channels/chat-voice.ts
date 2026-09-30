import type { Store } from "../store.js";
import { voiceSettings } from "../voice.js";

/**
 * CHAT-096 / CHAT-200: `/voice` in a chat, for how that chat's replies are spoken. The owner's own switch in Settings ›
 * Voice ("Answer a voice note with a voice note") and "Keep audio on this computer" still decide whether anything is
 * spoken at all; this only says, for one chat, when:
 *
 * - `voice` (the default, shown as "on"): a voice note is answered with a voice note, as the switch has always done;
 * - `always`: every reply here is spoken as well as written (Hermes `/voice tts`, OpenClaw `/tts always`). Spoken
 *   replies can cost money with a paid speech service, so only one of the owner's own accounts may choose it;
 * - `off`: never in this chat, whatever the switch says.
 *
 * The words are always sent first; a spoken reply only follows them.
 */
export type ChatVoiceMode = "voice" | "always" | "off";
const key = (channel: string, chatId: string) => `channel-voice:${channel}:${chatId}`;

export function chatVoiceMode(store: Pick<Store, "get">, owner: string, channel: string, chatId: string): ChatVoiceMode {
  const saved = (store.get("settings", owner, key(channel, chatId))?.data as { mode?: unknown } | undefined)?.mode;
  return saved === "always" || saved === "off" ? saved : "voice";
}

/** Whether a reply in this chat is spoken too: `cameAsVoice` is whether the message it answers was a voice note. */
export function speaksHere(mode: ChatVoiceMode, cameAsVoice: boolean): boolean {
  return mode === "always" || (mode === "voice" && cameAsVoice);
}

const said: Record<ChatVoiceMode, string> = {
  voice: "Voice notes here are answered with a voice note as well as words.",
  always: "Every reply here is spoken as well as written.",
  off: "Replies here are words only.",
};

/** `/voice`, `/voice on|always|off` for one chat. `ownAccount`: the sender is one the owner named as their own. */
export function voiceCommand(store: Store, owner: string, channel: string, chatId: string, argument: string, ownAccount: boolean): string {
  const word = argument.trim().toLowerCase();
  const mode: ChatVoiceMode | null = word === "on" || word === "voice" ? "voice" : word === "always" || word === "tts" ? "always"
    : word === "off" ? "off" : null;
  if (word && !mode) return "Send /voice on (answer voice notes with voice), /voice always (every reply), or /voice off.";
  if (mode === "always" && !ownAccount) return "Only the owner can have every reply here spoken, because a speech service can cost money.";
  if (mode) store.save("settings", owner, key(channel, chatId), { mode });
  const now = mode ?? chatVoiceMode(store, owner, channel, chatId);
  const settings = voiceSettings(store, owner);
  const held = now === "off" ? ""
    : settings.keepAudioOnThisComputer ? " Keep audio on this computer is on in Settings › Voice, so for now replies stay as words."
      : !settings.replyWithVoiceOnChannels ? " Spoken replies are off in Settings › Voice (Answer a voice note with a voice note), so for now replies stay as words."
        : "";
  return said[now] + held;
}
