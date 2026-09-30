import { z } from "zod";
import { Day, WearableAccount, WearableRange, wearableJson, type WearableDeps } from "./wearable-account.js";

const Metric = z.object({ day: Day, score: z.number().min(0).max(100).nullable().optional(), steps: z.number().int().nonnegative().optional() }).passthrough();
const Page = z.object({ data: z.array(Metric).max(100), next_token: z.string().max(2000).nullable().optional() }).passthrough();
/** Owner-window only; no health tool exposed to models and no automatic ingestion. */
export class OuraDaily {
  readonly account: WearableAccount;
  constructor(private readonly deps: WearableDeps) { this.account = new WearableAccount(deps, "oura"); }
  guard() { this.account.guard(); }
  configure(input: unknown, guard: () => void) { return this.account.configure(input, guard); }
  disable(guard: () => void) { return this.account.disable(guard); }
  status(guard: () => void) { return this.account.status(guard); }
  start(guard: () => void) { return this.account.start(guard); }
  async read(input: unknown, requestGuard: () => void) {
    const v = WearableRange.parse(input);
    return this.account.authorized(requestGuard, async (token, guard) => {
      const sleep = await this.collection("daily_sleep", v, token, guard), readiness = await this.collection("daily_readiness", v, token, guard), activity = await this.collection("daily_activity", v, token, guard);
      guard(); return { range: { start: v.start, end: v.end }, sleep, readiness, activity,
        note: "Private provider daily scores, not clinical interpretation. Missing data can mean no sync, no measurements, permission or membership limits. This form sends no data to models and persists no metrics." };
    });
  }
  private async collection(kind: "daily_sleep" | "daily_readiness" | "daily_activity", range: z.infer<typeof WearableRange>, token: string, guard: () => void) {
    const rows: { day: string; score: number | null; steps?: number }[] = []; let next: string | null = null;
    for (let page = 0; page < 2; page++) {
      const query = new URLSearchParams({ start_date: range.start, end_date: range.end, fields: kind === "daily_activity" ? "day,score,steps" : "day,score" }); if (next) query.set("next_token", next);
      guard(); const response = await this.deps.fetch(`https://api.ouraring.com/v2/usercollection/${kind}?${query}`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Oura daily read failed (${response.status}); check consent, membership and rate limits. No automatic retry.`);
      const body = Page.parse(await wearableJson(response)); guard();
      rows.push(...body.data.filter(r => r.day >= range.start && r.day <= range.end).map(r => ({ day: r.day, score: r.score ?? null, ...(kind === "daily_activity" && r.steps !== undefined ? { steps: r.steps } : {}) })));
      next = body.next_token ?? null; if (!next) break;
    }
    return { rows, truncated: next !== null };
  }
}
