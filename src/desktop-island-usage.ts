import type { createBranch } from "./index.js";
import { pricingSettings } from "./pricing.js";
import type { UsageAggregate } from "./usage.js";
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { HttpError } from "./server-http.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;
function guard(app: Branch, owner: string): void {
  if (app.sessionLock.locked()) throw new HttpError(423, "Unlock Branch to view recorded usage.");
  if (currentPerson() || startedWithShortLivedKey() || !app.store.profiles.isOwner()
    || app.store.profiles.scope() !== owner || owner !== app.runtime.owner)
    throw new HttpError(403, "Recorded desktop usage belongs to the current owner.");
}
function sum(days: UsageAggregate[]) {
  return days.reduce((total, day) => ({ tasks: total.tasks + day.runs,
    input: total.input + day.tokens.input, output: total.output + day.tokens.output,
    estimatedCost: total.estimatedCost + day.estimatedCost, priced: total.priced + day.pricedRuns,
    unpriced: total.unpriced + day.unpricedRuns }), { tasks: 0, input: 0, output: 0, estimatedCost: 0, priced: 0, unpriced: 0 });
}
/** Owner-conversation receipts only: no account login, provider refresh or balance inference. */
export function desktopIslandUsage(app: Branch, now = new Date()) {
  const owner = app.store.profiles.scope(); guard(app, owner);
  const prices = pricingSettings(app.store, owner).overrides;
  const days = app.store.usageStore().aggregateUsage("90d", "day", prices, id => app.store.ownsSession(owner, id));
  const date = now.toISOString().slice(0, 10), month = date.slice(0, 7);
  const history = [...days].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7)
    .map(day => ({ date: day.date, ...sum([day]) }));
  guard(app, owner);
  return { scope: owner, measuredAt: now.toISOString(), currency: "USD", dayBasis: "UTC task ledger dates",
    tokenBasis: "Recorded task input/output; includes engine estimates when the provider did not report tokens",
    costBasis: "Estimated from recorded task usage and saved prices; not a provider bill or remaining balance",
    today: sum(days.filter(day => day.date === date)), month: sum(days.filter(day => day.date.startsWith(month))), history };
}
