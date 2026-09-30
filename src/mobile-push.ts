import { z } from "zod";
import type { Store } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";
import { parseSecretReference } from "./vault.js";
import { knownDevices } from "./remote/gateway-auth.js";
import { decide, readSenderAllowlist } from "./channels/allowlist.js";
import { sendApns, sendFcm, type PushNotice } from "./mobile-push-providers.js";

const reference = z.string().max(120).refine((value) => !!parseSecretReference(value), "Use a locker secret reference");
export const MobilePushConfig = z.object({
  enabled: z.boolean().default(false),
  fcm: z.object({ project: z.string().regex(/^[a-z][a-z0-9-]{4,62}$/), credential: reference }).strict().optional(),
  apns: z.object({ teamId: z.string().regex(/^[A-Z0-9]{10}$/), keyId: z.string().regex(/^[A-Z0-9]{10}$/),
    topic: z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/).max(200), sandbox: z.boolean().default(false), credential: reference }).strict().optional(),
}).strict();
const DeviceInput = z.object({ provider: z.enum(["fcm", "apns"]), token: z.string().min(16).max(4096), enabled: z.boolean() }).strict();
const DeviceRecord = z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.enum(["fcm", "apns"]), tokenRef: reference, registeredAt: z.string(), expiresAt: z.string(), enabled: z.boolean() }).strict();
const Book = z.object({ devices: z.array(DeviceRecord).max(20).default([]) }).strict();
type PushDevice = z.infer<typeof DeviceRecord>;
const configKey = "mobile-push", devicesKey = "mobile-push-devices";

/** Owner opt-in only. Tokens are encrypted in the existing locker; settings contain references. */
export class MobilePush {
  private closed = false;
  private readonly active = new Set<AbortController>();
  private readonly seen = new Set<string>();
  constructor(private readonly store: Store, readonly owner: string, private readonly policy: NetworkPolicy,
    private readonly allowed: () => boolean) {}
  settings(): z.infer<typeof MobilePushConfig> {
    const value = MobilePushConfig.safeParse(this.store.get("settings", this.owner, configKey)?.data ?? {});
    return value.success ? value.data : { enabled: false };
  }
  private devices(): PushDevice[] {
    const value = Book.safeParse(this.store.get("settings", this.owner, devicesKey)?.data ?? {});
    return value.success ? value.data.devices : [];
  }
  view(): unknown { return { settings: this.settings(), devices: this.devices().map(({ tokenRef: _token, fingerprint: _key, ...device }) => device) }; }
  configure(input: unknown): unknown {
    this.guard();
    this.store.save("settings", this.owner, configKey, MobilePushConfig.parse(input));
    this.stop();
    return this.view();
  }
  async register(id: string, fingerprint: string, input: unknown): Promise<unknown> {
    this.guard();
    const body = DeviceInput.parse(input), paired = knownDevices(this.store, this.owner).find((device) => device.id === id);
    if (!paired || paired.keyFingerprint !== fingerprint) throw new Error("This phone is no longer paired");
    if (body.provider === "apns" && !/^[a-f0-9]{64}$/.test(body.token)) throw new Error("Invalid APNs device token");
    if (body.provider === "fcm" && !/^[A-Za-z0-9:_-]+$/.test(body.token)) throw new Error("Invalid FCM device token");
    const tokenRef = `secret://default/MOBILE_PUSH_${id.toUpperCase()}`;
    if (this.devices().filter((device) => device.id !== id).length >= 20) throw new Error("At most 20 phones can receive push");
    await this.store.secrets.put(this.owner, "default", `MOBILE_PUSH_${id.toUpperCase()}`, body.token);
    this.guard();
    if (!knownDevices(this.store, this.owner).some((device) => device.id === id && device.keyFingerprint === fingerprint))
      throw new Error("This phone is no longer paired");
    const devices = this.devices().filter((device) => device.id !== id);
    if (devices.length >= 20) throw new Error("At most 20 phones can receive push");
    devices.push({ id, fingerprint, provider: body.provider, tokenRef, registeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(), enabled: body.enabled });
    this.store.save("settings", this.owner, devicesKey, { devices });
    return { registered: true, enabled: body.enabled };
  }
  unregister(id: string): unknown {
    this.guard(); this.stop();
    this.store.save("settings", this.owner, devicesKey, { devices: this.devices().filter((device) => device.id !== id) });
    this.store.secrets.remove(this.owner, "default", `MOBILE_PUSH_${id.toUpperCase()}`);
    return { registered: false };
  }
  stop(): void { for (const controller of this.active) controller.abort(); }
  close(): void { this.closed = true; this.stop(); }
  private guard(): void {
    if (this.closed || !this.allowed() || this.store.profiles.scope() !== this.owner) throw new Error("Mobile push is unavailable while locked or outside the owner profile");
  }
  private live(device: PushDevice): boolean {
    return !this.closed && this.allowed() && this.store.profiles.scope() === this.owner && this.settings().enabled
      && this.devices().some((row) => row.id === device.id && row.enabled && Date.parse(row.expiresAt) > Date.now()
        && row.fingerprint === device.fingerprint && row.tokenRef === device.tokenRef)
      && knownDevices(this.store, this.owner).some((row) => row.id === device.id && row.keyFingerprint === device.fingerprint)
      && decide(readSenderAllowlist(this.store, this.owner), "remote", device.id) !== "block";
  }
  notify(event: string, data: Record<string, unknown>): void {
    const kind = event === "run.completed" ? "finished" : event === "approval.needed" ? "needs-you" : null;
    if (this.closed || !kind || typeof data.runId !== "string" || !this.allowed() || !this.settings().enabled) return;
    const run = this.store.run(data.runId);
    if (!run || run.owner !== this.owner || this.store.profiles.scope() !== this.owner) return;
    const notice: PushNotice = { kind, runId: run.id };
    const eventId = this.store.sqlite.prepare("SELECT MAX(id) AS id FROM events WHERE run_id=?").get(run.id)?.id ?? 0;
    for (const device of this.devices()) {
      const key = `${device.id}:${notice.runId}:${kind}:${eventId}`;
      if (!this.live(device) || this.seen.has(key) || this.active.size >= 20) continue;
      this.seen.add(key); if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value!);
      void this.deliver(device, notice).catch(() => {
        try { this.store.event(notice.runId, "mobile_push.delivery", { provider: device.provider, accepted: false }); }
        catch { /* Never expose credential/provider errors or block task completion. */ }
      });
    }
  }
  private async secret(reference: string, runId: string): Promise<string> {
    const ref = parseSecretReference(reference);
    if (!ref) throw new Error("Invalid push credential reference");
    const values = await this.store.secrets.resolve(this.owner, ref.project, [ref.name], { runId, purpose: "mobile push" });
    if (!values[ref.name]) throw new Error("Push credential is unavailable");
    return values[ref.name]!;
  }
  private async deliver(device: PushDevice, notice: PushNotice): Promise<void> {
    const controller = new AbortController(); this.active.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    const guard = () => { if (controller.signal.aborted || !this.live(device)) throw new Error("Push registration is no longer active"); };
    try {
      guard(); const settings = this.settings(), token = await this.secret(device.tokenRef, notice.runId); guard();
      const config = device.provider === "fcm" ? settings.fcm : settings.apns;
      if (!config) return;
      const key = await this.secret(config.credential, notice.runId); guard();
      const result = device.provider === "fcm"
        ? await sendFcm(this.policy, settings.fcm!.project, key, token, notice, controller.signal, guard)
        : await sendApns(this.policy, settings.apns!, key, token, notice, controller.signal, guard);
      if (result.invalidToken && this.live(device)) this.unregister(device.id);
      this.store.event(notice.runId, "mobile_push.delivery", { provider: device.provider, accepted: result.accepted, invalidToken: result.invalidToken });
    } finally { clearTimeout(timeout); this.active.delete(controller); }
  }
}
