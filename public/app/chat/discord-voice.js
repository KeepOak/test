import { api } from "../core/api.js";
import { esc, render } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { E } from "../core/state.js";
import { toast } from "../core/ui.js";
let state = null, initialized = false;
export async function loadDiscordVoice() { if (E.profiles?.isOwner === false) return; try { state = await api("discord-voice"); } catch (error) { state = { problem: error.message }; } render(); }
export function initDiscordVoice() {
  if (initialized) return; initialized = true;
  markLive(["discord-voice-join", "discord-voice-leave", "discord-voice-refresh", ...["source", "guild", "channel", "speakers", "purpose", "seconds", "clips", "tokens", "consent"].map((x) => "sw:discord-voice-" + x)]);
  const field = (id) => document.getElementById("discord-voice-" + id);
  on("discord-voice-join", async () => { try {
    await api("discord-voice/join", { source: field("source").value.trim(), guildId: field("guild").value.trim(), channelId: field("channel").value.trim(),
      speakers: field("speakers").value.split(/\s+/).filter(Boolean), purpose: field("purpose").value.trim(), maxSeconds: Number(field("seconds").value), maxClips: Number(field("clips").value), maxModelTokens: Number(field("tokens").value), consent: field("consent").checked });
    await loadDiscordVoice();
  } catch (error) { toast(error.message); await loadDiscordVoice(); } });
  on("discord-voice-leave", async () => { try { await api("discord-voice/leave", {}); await loadDiscordVoice(); } catch (error) { toast(error.message); } });
  on("discord-voice-refresh", () => loadDiscordVoice());
}
export function discordVoiceSection() {
  if (E.profiles?.isOwner === false) return "";
  const input = (id, label, value = "", type = "text") => `<label>${esc(label)}<input id="discord-voice-${id}" type="${type}" value="${esc(value)}"></label>`;
  return `<section class="sec"><h2>One bounded Discord voice session</h2><p>No automatic joins. Select exact IDs from your connected Discord bot source. Every room participant must be listed and consent. An unapproved participant causes departure. Uses prepared SDK/DAVE/Opus/FFmpeg and your existing speech/model routes; missing components hold joining.</p>
    ${input("source", "Connected Discord source ID")}${input("guild", "Exact server ID")}${input("channel", "Exact voice channel ID")}${input("speakers", "Consenting speaker user IDs, separated by spaces")}${input("purpose", "Approved conversation purpose")}
    ${input("seconds", "Maximum session seconds (30–300)", 120, "number")}${input("clips", "Maximum speech clips (1–8, six seconds each)", 4, "number")}${input("tokens", "Total model token reservation", 2000, "number")}
    <label><input id="discord-voice-consent" type="checkbox">Everyone listed consents to audio capture/transcription and shared spoken replies, including configured provider use.</label>
    <p>No tools, owner memory, purchases or settings changes are available to voice participants. Token/clip/duration caps limit use; provider charges are not an invoice-total dollar guarantee. The connection leaves on disconnect, movement, lock or limits; joining again requires your press.</p>
    <button class="btn" data-act="discord-voice-join">Approve these exact terms and join once</button><button class="btn ghost" data-act="discord-voice-leave">Leave now</button><button class="btn ghost" data-act="discord-voice-refresh">Refresh voice state</button>
    <p>${esc(state?.problem ?? "Off until you explicitly join")}</p><pre>${esc(JSON.stringify(state?.active ?? null, null, 2))}</pre></section>`;
}
