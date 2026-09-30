import { z } from "zod";
import { WearableAccount, WearableRange, wearableJson, type WearableDeps } from "./wearable-account.js";

const Recovery = z.object({ created_at: z.string().datetime({ offset: true }), score_state: z.string().max(40),
  score: z.object({ recovery_score: z.number().min(0).max(100) }).passthrough().nullable().optional() }).passthrough();
const Sleep = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), nap: z.boolean(), score_state: z.string().max(40),
  score: z.object({ sleep_performance_percentage: z.number().min(0).max(100).nullable().optional(), stage_summary: z.object({ total_light_sleep_time_milli: z.number().nonnegative(), total_slow_wave_sleep_time_milli: z.number().nonnegative(), total_rem_sleep_time_milli: z.number().nonnegative() }).passthrough() }).passthrough().nullable().optional() }).passthrough();

/** Official v2 only; no private WHOOP endpoints, clinical inference or offline scope. */
export class WhoopDaily {
  readonly account: WearableAccount;
  constructor(private readonly deps: WearableDeps) { this.account = new WearableAccount(deps, "whoop"); }
  async revoke(input: unknown, requestGuard: () => void) {
    z.object({ approveProviderRevocation: z.literal(true) }).strict().parse(input);
    let providerRevoked = false, note = "WHOOP acknowledged revocation; local access is disabled.";
    try {
      await this.account.authorized(requestGuard, async (token, guard) => {
        guard(); const response = await this.deps.fetch("https://api.prod.whoop.com/developer/v2/user/access", { method: "DELETE", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
        if (response.status !== 204) throw new Error(`WHOOP revocation was not acknowledged (${response.status})`);
        providerRevoked = true;
      });
    } catch { note = "Local access is disabled, but provider revocation is unverified. Remove app access in WHOOP yourself (the token may have expired)."; }
    await this.account.disable(requestGuard);
    return { providerRevoked, enabled: false, note };
  }
  async read(input: unknown, requestGuard: () => void) {
    const range = WearableRange.parse(input);
    return this.account.authorized(requestGuard, async (token, guard) => {
      const query = { start: `${range.start}T00:00:00.000Z`, end: new Date(Date.parse(range.end) + 86400000).toISOString() };
      const recovery = await this.collection("recovery", query, Recovery, token, guard), sleep = await this.collection("activity/sleep", query, Sleep, token, guard);
      guard(); return { range: query, recovery: { truncated: recovery.truncated, rows: recovery.records.map(r => ({ recordedAt: r.created_at, scoreState: r.score_state, score: r.score?.recovery_score ?? null })) },
        sleep: { truncated: sleep.truncated, rows: sleep.records.map(r => ({ start: r.start, end: r.end, nap: r.nap, scoreState: r.score_state, performance: r.score?.sleep_performance_percentage ?? null,
          sleepMinutes: r.score ? Math.round((r.score.stage_summary.total_light_sleep_time_milli + r.score.stage_summary.total_slow_wave_sleep_time_milli + r.score.stage_summary.total_rem_sleep_time_milli) / 60000) : null })) },
        note: "UTC interval and provider range semantics; recovery recordedAt is its creation time, not the related sleep start. Missing scores can mean unscored/no data/consent/sync limits. Private display only; no model, retention or clinical interpretation." };
    });
  }
  private async collection<T>(path: string, range: { start: string; end: string }, schema: z.ZodType<T>, token: string, guard: () => void) {
    const records: T[] = []; let next: string | null = null;
    const Page = z.object({ records: z.array(schema).max(25), next_token: z.string().max(2000).nullable().optional() }).passthrough();
    for (let page = 0; page < 2; page++) {
      const query = new URLSearchParams({ ...range, limit: "25" }); if (next) query.set("nextToken", next);
      guard(); const response = await this.deps.fetch(`https://api.prod.whoop.com/developer/v2/${path}?${query}`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`WHOOP private read failed (${response.status}); check grant, sync and limits. No automatic retry.`);
      const body = Page.parse(await wearableJson(response)); guard(); records.push(...body.records);
      next = body.next_token ?? null; if (!next) break;
    }
    return { records, truncated: next !== null };
  }
}
