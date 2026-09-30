import type { ChannelAdapter } from "../channels/router.js";
import type { WorkspaceFiles } from "../files.js";
import type { OAuthConnections } from "../oauth.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { CalendarAvailability, availabilityEnabled, registerCalendarAvailability } from "./calendar-availability.js";
import { ChatFiles, registerChatFiles } from "./chat-files.js";
import { GoogleConnector, registerGoogle } from "./google.js";
import { HomeControl, registerHomeControl } from "./home-control.js";
import { MailSearch, registerMailSearch, type MailClient } from "./mail-search.js";
import { MicrosoftConnector, registerMicrosoft } from "./microsoft.js";
import { personalMode, personalParts, personalTools, savePersonalMode, type PersonalMode, type PersonalPart } from "./settings.js";
import { SignIn } from "./signin.js";
import { registerSpokenBrief, SpokenBrief } from "./spoken-brief.js";
import { registerSpotify, SpotifyConnector } from "./spotify.js";
import { WebhookTunnel, type TunnelSpawn } from "./tunnel.js";
import { VoiceApprovals } from "./voice-approvals.js";
import { registerXSearch, XSearch } from "./x-search.js";
import { opensTheHouse, ownerOnlyTools } from "./guard.js";
import { categoryOf } from "../tool-categories.js";
import type { MailServer } from "../channels/mail-client.js";

/**
 * R17-C (re-audit 2026-09-17): files, voice, devices and personal connectors. `createBranch` makes
 * one of these; the server hands it /api/personal/. Every part ships off. See docs/configuration.md,
 * "Files, voice, devices and personal connectors".
 */
export interface PersonalDeps {
  runtime: Runtime;
  registry: ToolRegistry;
  files: WorkspaceFiles;
  oauth: Pick<OAuthConnections, "start" | "waitFor" | "saved" | "accessToken">;
  /** A fetch that follows the owner's network rules. */
  fetch: typeof fetch;
  /** A named secret from the locker, filled in at the moment it is needed. */
  secret: (name: string, purpose: string) => Promise<string>;
  /** The owner's network rules for an address not reached with `fetch` (a mail server). */
  assertHost: (host: string, port: number) => Promise<void>;
  channels: {
    adapter: (channel: string) => ChannelAdapter | undefined;
    reachable: (channel: string, chatId: string) => boolean;
    outboundGuard: (text: string) => Promise<{ text: string; blocked: boolean; reason?: string }>;
  };
  holdsKnownSecret: (text: string) => boolean;
  requireOwner: (what: string) => void;
  morningBrief: () => string;
  speak: (text: string) => Promise<{ bytes: Uint8Array; mediaType: string }>;
  transcribe: (clip: { bytes: Uint8Array; mediaType: string }) => Promise<string>;
  /** A sentence when starting a program is refused right now (Lockdown), or null. */
  lockdownRefusal: () => string | null;
  /** Replaced in tests so nothing real is started or dialled. */
  tunnelSpawn?: TunnelSpawn;
  imap?: (server: MailServer) => MailClient;
}

/** Integration review: a spoken yes to anything past looking and changing workspace files needs a press too. */
function riskyQuestion(tool: string, permission: string, target: string): boolean {
  return opensTheHouse(tool, target) || !["read", "files"].includes(categoryOf(tool, permission));
}

export class Personal {
  readonly signIns: { google: SignIn; microsoft: SignIn; spotify: SignIn };
  readonly availability: CalendarAvailability;
  readonly google: GoogleConnector;
  readonly microsoft: MicrosoftConnector;
  readonly spotify: SpotifyConnector;
  readonly x: XSearch;
  readonly home: HomeControl;
  readonly chatFiles: ChatFiles;
  readonly mail: MailSearch;
  readonly brief: SpokenBrief;
  readonly voiceApprovals: VoiceApprovals;
  readonly tunnel: WebhookTunnel;
  private readonly registrars: Partial<Record<PersonalPart, () => void>>;

  constructor(private readonly deps: PersonalDeps) {
    const { runtime, registry } = deps;
    const store = runtime.store, owner = runtime.owner;
    const signIn = { store, owner, oauth: deps.oauth, secret: deps.secret };
    this.signIns = { google: new SignIn(signIn, "google", "google"), microsoft: new SignIn(signIn, "microsoft", "microsoft"),
      spotify: new SignIn(signIn, "spotify", "spotify") };
    this.availability = new CalendarAvailability({ store, owner, fetch: deps.fetch, signIns: this.signIns, requireOwner: deps.requireOwner });
    this.google = new GoogleConnector(store, owner, deps.fetch, this.signIns.google);
    this.microsoft = new MicrosoftConnector(store, owner, deps.fetch, this.signIns.microsoft);
    this.spotify = new SpotifyConnector(store, owner, deps.fetch, this.signIns.spotify);
    this.x = new XSearch(store, owner, deps.fetch, (name) => deps.secret(name, "searching X"));
    this.home = new HomeControl(store, owner, deps.fetch, (name) => deps.secret(name, "Home Assistant"));
    this.chatFiles = new ChatFiles({ store, owner, files: deps.files, ...deps.channels,
      holdsKnownSecret: deps.holdsKnownSecret, requireOwner: deps.requireOwner });
    this.mail = new MailSearch({ store, owner, files: deps.files, secret: (name) => deps.secret(name, "searching the inbox"),
      assertHost: deps.assertHost, ...(deps.imap ? { imap: deps.imap } : {}) });
    this.brief = this.makeBrief();
    this.voiceApprovals = new VoiceApprovals({ store, owner, transcribe: deps.transcribe,
      question: (sessionId, fingerprint) => runtime.approvals.questionFor(sessionId, fingerprint),
      risky: (question) => riskyQuestion(question.tool, registry.permissionOf(question.tool), question.target),
      // A spoken yes is for this once only; a spoken no is kept for the conversation, as the No button is.
      approve: (sessionId, decision, fingerprint) => runtime.approve(sessionId, decision, decision === "allow" ? "never" : "session", fingerprint) });
    this.tunnel = new WebhookTunnel({ store, owner, refusal: deps.lockdownRefusal, ...(deps.tunnelSpawn ? { spawn: deps.tunnelSpawn } : {}) });
    // Integration review: every personal tool refuses anybody but the owner before it runs (src/personal/guard.ts).
    const tools = ownerOnlyTools(registry, store, deps.requireOwner);
    this.registrars = {
      "chat-files": () => registerChatFiles(tools, this.chatFiles),
      "home-control": () => registerHomeControl(tools, this.home),
      "spoken-brief": () => registerSpokenBrief(tools, this.brief),
      "x-search": () => registerXSearch(tools, this.x),
      spotify: () => registerSpotify(tools, this.spotify),
      google: () => registerGoogle(tools, this.google),
      microsoft: () => registerMicrosoft(tools, this.microsoft),
      "mail-search": () => registerMailSearch(tools, this.mail),
    };
    for (const part of personalParts) this.sync(part);
    this.syncAvailability();
  }

  private makeBrief(): SpokenBrief {
    const { deps } = this;
    return new SpokenBrief({ store: deps.runtime.store, owner: deps.runtime.owner, speak: deps.speak,
      sources: { morningBrief: deps.morningBrief,
        googleEvents: () => this.google.events({}), googleMail: () => this.google.searchMail({ query: "is:unread newer_than:1d", max: 10 }),
        outlookEvents: () => this.microsoft.events({}), outlookMail: () => this.microsoft.search({ max: 10 }) },
      sendVoice: async (channel, chatId, audio, text) => {
        deps.requireOwner("Sending the briefing to your chats");
        const adapter = deps.channels.adapter(channel);
        if (!adapter?.sendVoice) throw new Error(`${channel} is not connected, or cannot take voice notes`);
        if (!deps.channels.reachable(channel, chatId)) throw new Error("That chat has never talked to the assistant, so nothing is sent to it");
        const checked = await deps.channels.outboundGuard(text);
        if (checked.blocked) throw new Error(checked.reason ?? "The briefing was held back before it was sent");
        await adapter.sendVoice(chatId, audio.bytes, audio.mediaType);
      } });
  }

  /** Stops what keeps running: the tunnel program and its door, and any spoken answers still open. */
  async close(): Promise<void> {
    this.voiceApprovals.clear();
    await this.tunnel.stop();
  }

  /** A part's tools are in the catalog exactly while its switch is not off. */
  private sync(part: PersonalPart): void {
    for (const name of personalTools[part]) this.deps.registry.unregister(name);
    if (personalMode(this.deps.runtime.store, this.deps.runtime.owner, part) !== "off") this.registrars[part]?.();
  }

  private syncAvailability(): void {
    const { runtime, registry, requireOwner } = this.deps;
    registry.unregister("calendars.free_slots");
    if (availabilityEnabled(runtime.store, runtime.owner))
      registerCalendarAvailability(ownerOnlyTools(registry, runtime.store, requireOwner), this.availability);
  }

  modes(): Record<PersonalPart, PersonalMode> {
    return Object.fromEntries(personalParts.map((part) => [part, personalMode(this.deps.runtime.store, this.deps.runtime.owner, part)])) as Record<PersonalPart, PersonalMode>;
  }

  /** Saves a switch and puts the part's tools in or takes them out at once; off also stops what runs. */
  async setMode(part: PersonalPart, input: unknown): Promise<PersonalMode> {
    const mode = savePersonalMode(this.deps.runtime.store, this.deps.runtime.owner, part, input);
    this.sync(part);
    this.syncAvailability();
    if (mode === "off" && part === "tunnel") await this.tunnel.stop();
    if (mode === "off" && part === "voice-approvals") this.voiceApprovals.clear();
    return mode;
  }
}

export { personalParts, personalTools, personalLabels } from "./settings.js";
