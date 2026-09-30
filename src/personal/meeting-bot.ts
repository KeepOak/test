import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";

const Ref = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const Plan = z.object({ enabled: z.literal(true), platform: z.enum(["meet", "teams", "zoom"]), meetingUrl: z.string().url().max(2000),
  purpose: z.string().trim().min(1).max(300), minutes: z.number().int().min(1).max(120), region: z.enum(["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"]),
  apiSecret: Ref, verificationSecret: Ref, callbackOrigin: z.string().url().max(300) }).strict();
type PlanValue = z.infer<typeof Plan>;
const Session = z.object({ id: z.string().uuid(), plan: Plan, bot: z.string().uuid().nullable(), status: z.string().max(100),
  recordingApproved: z.boolean(), text: z.string().max(6000), truncated: z.boolean(), at: z.number(), eventAt: z.number(), seen: z.array(z.string().max(200)).max(200) });
type SessionValue = z.infer<typeof Session>;
const Input = z.object({ session: z.string().uuid() }).strict();
const notice = (plan: PlanValue) => `Branch notes bot: ${plan.purpose}. Audio transcription via Recall.ai requires everyone's consent. Host: do not start without consent; remove this bot on objection or a new participant who has not consented.`;
const terminal = (status: string) => ["bot.done", "bot.fatal", "bot.call_ended", "left"].includes(status);
async function boundedJson(response: Response): Promise<unknown> {
  if (response.status === 204 || !response.body) return {};
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 256000) { await reader.cancel(); throw new Error("Recall response is too large."); }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(parts).toString("utf8"); return text ? JSON.parse(text) as unknown : {};
}

/** Owner-granted guest joins, never a calendar trigger or model-callable tool. */
export class MeetingBot {
  private readonly previews = new Map<string, { plan: PlanValue; at: number }>();
  private readonly inflight = new Set<string>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetch: typeof fetch,
    private readonly secret: (name: string, purpose: string) => Promise<string>, private readonly guard: () => void) {}
  private sessions(): SessionValue[] {
    const saved = this.store.get("settings", this.owner, "meeting-bot-sessions")?.data;
    return z.object({ sessions: z.array(Session).max(16) }).strict().parse(saved ?? { sessions: [] }).sessions;
  }
  private save(item: SessionValue): void {
    const all = this.sessions().filter(x => x.id !== item.id);
    while (all.length >= 16) {
      const index = all.findIndex(x => terminal(x.status));
      if (index < 0) throw new Error("Leave an active bot before opening another session.");
      all.splice(index, 1);
    }
    this.store.save("settings", this.owner, "meeting-bot-sessions", { sessions: [...all, Session.parse(item)] });
  }
  private session(id: string): SessionValue {
    const item = this.sessions().find(x => x.id === id);
    if (!item) throw new Error("Unknown approved meeting session.");
    return item;
  }
  preview(input: unknown) {
    this.guard(); const plan = Plan.parse(input), url = new URL(plan.meetingUrl), callback = new URL(plan.callbackOrigin);
    const hosts = { meet: /^meet\.google\.com$/, teams: /^teams\.(microsoft|live)\.com$/, zoom: /^(?:[a-z0-9-]+\.)?zoom\.us$/ };
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts[plan.platform].test(url.hostname)) throw new Error("Use an HTTPS meeting URL on the selected platform.");
    if (callback.protocol !== "https:" || callback.username || callback.password || callback.port || callback.pathname !== "/" || callback.search || callback.hash)
      throw new Error("Use the stable public HTTPS callback origin, without a path.");
    plan.callbackOrigin = callback.origin;
    for (const [id, p] of this.previews) if (p.at + 600000 < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 8) throw new Error("Too many open previews.");
    const ticket = randomUUID(); this.previews.set(ticket, { plan, at: Date.now() });
    return { ticket, plan, callback: `${plan.callbackOrigin}/webhooks/meeting-notes/recall/${ticket}`, notice: notice(plan), price: "Unknown; Recall/provider charges may apply. No price or spending cap is verified.",
      timing: "At most 120 seconds waiting room, 180 seconds awaiting recording consent, plus the approved recording minutes. Provider enforcement is not locally verified." };
  }
  private async call(item: SessionValue, path: string, body: unknown, guard: () => void) {
    guard(); const key = await this.secret(item.plan.apiSecret, "approved guest meeting bot"); guard();
    const response = await this.fetch(`https://${item.plan.region}.recall.ai/api/v1/bot/${path}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: `Token ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Recall request failed (${response.status}); inspect the provider dashboard before retrying an ambiguous join.`);
    return boundedJson(response);
  }
  async join(input: unknown, requestGuard: () => void) {
    const guard = () => { this.guard(); requestGuard(); }; guard();
    const v = z.object({ ticket: z.string().uuid(), approveJoinAndUnknownPrice: z.literal(true), dashboardEndpointConfigured: z.literal(true) }).strict().parse(input), held = this.previews.get(v.ticket);
    if (!held || held.at + 600000 < Date.now()) throw new Error("Review the exact guest join again.");
    this.previews.delete(v.ticket);
    const item: SessionValue = { id: v.ticket, plan: held.plan, bot: null, status: "join_requested", recordingApproved: false, text: "", truncated: false, at: Date.now(), eventAt: 0, seen: [] };
    this.save(item);
    const message = notice(item.plan), created = z.object({ id: z.string().uuid() }).passthrough().parse(await this.call(item, "", {
      meeting_url: item.plan.meetingUrl, bot_name: "Branch notes — consent required", recording_config: null,
      metadata: { branch_session: item.id }, chat: { on_bot_join: { send_to: "everyone", message }, on_participant_join: { message } },
      automatic_leave: { waiting_room_timeout: 120, noone_joined_timeout: 120, in_call_not_recording_timeout: 180, in_call_recording_timeout: item.plan.minutes * 60, recording_permission_denied_timeout: 30 },
    }, guard));
    const latest = this.session(item.id);
    if (latest.bot && latest.bot !== created.id) throw new Error("Provider join receipt and signed event disagree. Inspect the provider dashboard.");
    latest.bot = created.id; this.save(latest);
    return this.view(item.id);
  }
  view(id?: string) {
    this.guard(); return { sessions: this.sessions().filter(x => !id || x.id === id).map(x => ({ session: x.id, bot: x.bot, status: x.status,
      plan: x.plan, text: x.text, truncated: x.truncated, recordingApproved: x.recordingApproved, lastEventAt: x.eventAt })) };
  }
  async control(action: "record" | "leave", input: unknown, requestGuard: () => void) {
    const guard = () => { this.guard(); requestGuard(); }; guard();
    const v = action === "record" ? Input.extend({ noticeVisible: z.literal(true), allParticipantsConsented: z.literal(true), monitorLateArrivals: z.literal(true) }).strict().parse(input) : Input.parse(input);
    const item = this.session(v.session);
    if (!item.bot || this.inflight.has(item.id)) throw new Error("Wait for the join receipt or the current action; use the provider dashboard if the join outcome is unknown.");
    if (action === "record" && (item.recordingApproved || item.status !== "bot.in_call_not_recording")) throw new Error("Recording requires a verified in-call-not-recording event and a fresh owner consent grant.");
    this.inflight.add(item.id);
    try {
      if (action === "record") { item.recordingApproved = true; this.save(item); }
      const recording = { start_recording_on: "call_join", video_mixed_mp4: null, transcript: { provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } } },
        realtime_endpoints: [{ type: "webhook", url: `${item.plan.callbackOrigin}/webhooks/meeting-notes/recall/${item.id}`, events: ["transcript.data"] }] };
      await this.call(item, `${item.bot}/${action === "record" ? "start_recording" : "leave_call"}/`, action === "record" ? recording : {}, guard);
      return { acknowledged: true, note: "Provider accepted the request. Verified lifecycle events report actual state; no automatic retry.", ...this.view(item.id) };
    } finally { this.inflight.delete(item.id); }
  }
  async event(id: string, headers: Record<string, string | string[] | undefined>, raw: Buffer) {
    const item = this.session(z.string().uuid().parse(id)), key = await this.secret(item.plan.verificationSecret, "verify approved meeting events");
    const messageId = headers["webhook-id"], stamp = headers["webhook-timestamp"], signatures = headers["webhook-signature"];
    if (!key.startsWith("whsec_") || typeof messageId !== "string" || messageId.length > 200 || typeof stamp !== "string" || !/^\d{10}$/.test(stamp) || typeof signatures !== "string" || signatures.length > 2000 || Math.abs(Date.now() / 1000 - Number(stamp)) > 300) throw new Error("Invalid meeting webhook authentication.");
    const expected = createHmac("sha256", Buffer.from(key.slice(6), "base64")).update(`${messageId}.${stamp}.`).update(raw).digest();
    if (!signatures.split(" ").some(s => { const [version, signature] = s.split(","), bytes = Buffer.from(signature ?? "", "base64"); return version === "v1" && bytes.length === expected.length && timingSafeEqual(bytes, expected); })) throw new Error("Invalid meeting webhook signature.");
    // Verification precedes decoding, JSON parsing, storage, or processing.
    const v = z.object({ event: z.string().max(100), data: z.object({ bot: z.object({ id: z.string().uuid(), metadata: z.object({ branch_session: z.string().uuid() }).passthrough() }).passthrough(), data: z.unknown() }).passthrough() }).passthrough().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
    const latest = this.session(id);
    if (v.data.bot.metadata.branch_session !== id || (latest.bot && latest.bot !== v.data.bot.id)) throw new Error("Meeting event is not bound to this owner grant.");
    if (latest.seen.includes(messageId)) return { accepted: true };
    latest.bot = v.data.bot.id; latest.seen = [...latest.seen.slice(-199), messageId];
    if (v.event.startsWith("bot.")) {
      const status = z.object({ updated_at: z.string().datetime({ offset: true }) }).passthrough().parse(v.data.data), at = Date.parse(status.updated_at);
      if (at >= latest.eventAt && (!terminal(latest.status) || terminal(v.event))) { latest.status = v.event; latest.eventAt = at; }
    }
    if (v.event === "transcript.data" && latest.recordingApproved) {
      const data = z.object({ words: z.array(z.object({ text: z.string().max(1000) }).passthrough()).max(1000), participant: z.object({ name: z.string().max(200).nullable() }).passthrough() }).passthrough().parse(v.data.data);
      const line = `${data.participant.name ?? "Participant"}: ${data.words.map(w => w.text).join(" ")}\n`;
      latest.truncated ||= latest.text.length + line.length > 6000; latest.text = (latest.text + line).slice(0, 6000);
    }
    this.save(latest); return { accepted: true };
  }
  excerpt(input: unknown) {
    this.guard(); const { session } = Input.parse(input), item = this.session(session);
    if (!item.recordingApproved || !item.text) throw new Error("No verified consent-granted live transcript has arrived.");
    return { id: item.id, title: item.plan.purpose, text: item.text, truncated: item.truncated };
  }
}
