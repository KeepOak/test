import type { Event, Run } from "./contracts.js";
import type { AuditEntry } from "./audit.js";
import { estimateCost, type ModelPrice } from "./pricing.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const sha = (value: unknown): string | null => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
export interface PullRequestResult {
  repository: string; number: number; key: string; address: string | null;
  openedAt: string | null; mergeObservedAt: string | null; mergeSha: string | null; reviewedHead: string | null;
  state: "opened" | "merged"; mergeEvidence: "tool result" | "remote read" | "owner audit" | null;
}

/** Accept only the repository and identifier returned by the opening tool, including computer gh's URL. */
export function pullRequestReference(repository: unknown, result: unknown): { repository: string; number: number; address: string | null } | null {
  const value = row(result), repo = typeof repository === "string" ? repository : value.repository ?? value.repo;
  if (typeof repo !== "string" || !/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  let number = value.number, address: string | null = null;
  const link = value.address ?? value.url ?? value.html_url;
  if (typeof link === "string") {
    try {
      const url = new URL(link), found = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
      if (url.protocol !== "https:" || url.username || url.password || !found || found[1]!.toLowerCase() !== repo.toLowerCase()) return null;
      const linkedNumber = Number(found[2]);
      if (number !== undefined && number !== linkedNumber) return null;
      number = linkedNumber; url.search = ""; url.hash = ""; address = url.href;
    } catch { return null; }
  }
  return Number.isSafeInteger(number) && Number(number) > 0 ? { repository: repo, number: Number(number), address } : null;
}

const openings = new Set(["github.open_pull_request", "github.pull_request_from_changes"]);
const merges = new Set(["github.merge_pull_request", "branch.finish_source_change"]);

/** The task's own server-recorded results, without treating a proposed PR as checked, reviewed or installed. */
export function taskPullRequests(events: Event[], audits: AuditEntry[] = []): PullRequestResult[] {
  const found = new Map<string, PullRequestResult>();
  for (const event of events) {
    const name = String(event.data.name ?? ""), value = row(event.data.result);
    const nested = row(value.pullRequest);
    const opening = event.kind === "pull_request.opened" || (event.kind === "tool.completed" && openings.has(name));
    const merged = event.kind === "tool.completed" && ((merges.has(name) && value.merged === true && sha(value.sha) !== null)
      || (name === "github.wait_for_checks" && value.state === "merged"));
    if (!opening && !merged) continue;
    const reference = event.kind === "pull_request.opened" ? pullRequestReference(event.data.repository, event.data)
      : pullRequestReference(value.repository ?? value.repo, Object.keys(nested).length ? nested : value);
    if (!reference) continue;
    const key = `${reference.repository.toLowerCase()}#${reference.number}`;
    const previous = found.get(key);
    const entry: PullRequestResult = previous ?? { ...reference, key, openedAt: null, mergeObservedAt: null,
      mergeSha: null, reviewedHead: null, state: "opened", mergeEvidence: null };
    if (reference.address) entry.address = reference.address;
    if (opening && (!entry.openedAt || event.createdAt < entry.openedAt)) entry.openedAt = event.createdAt;
    if (merged) {
      entry.state = "merged"; entry.mergeObservedAt ??= event.createdAt; entry.mergeSha ??= sha(value.sha);
      entry.mergeEvidence = merges.has(name) ? "tool result" : "remote read";
    }
    found.set(key, entry);
  }
  for (const audit of audits) {
    if (audit.action !== "self_development.merge" || audit.outcome !== "merged") continue;
    const match = /^([^ ]+#\d+) ([a-f0-9]{40})$/.exec(audit.subject), entry = match ? found.get(match[1]!.toLowerCase()) : null;
    if (!entry) continue;
    entry.state = "merged"; entry.mergeObservedAt ??= audit.at; entry.mergeEvidence = "owner audit";
    // The audit pins the reviewed head, not the commit GitHub produced by merging.
    entry.reviewedHead = match![2]!;
  }
  return [...found.values()];
}

const elapsed = (from: string, to: string | null): number | null => {
  const duration = to ? Date.parse(to) - Date.parse(from) : NaN;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
};

function reviewRounds(events: Event[], requests: PullRequestResult[]) {
  const commits = new Set<string>(), known = new Map(requests.map((request) => [request.key, false]));
  let readCalls = 0;
  for (const event of events) {
    if (event.kind !== "tool.completed" || event.data.name !== "github.pull_request_reviews") continue;
    const value = row(event.data.result);
    const reference = pullRequestReference(value.repository, value);
    const key = reference ? `${reference.repository.toLowerCase()}#${reference.number}` : "";
    if (!known.has(key)) continue;
    readCalls++;
    const recent = Array.isArray(value.recentReviews) ? value.recentReviews : [];
    for (const one of recent) {
      const review = row(one), commit = sha(review.commit);
      if (commit && typeof review.at === "string" && Number.isFinite(Date.parse(review.at)) && review.state !== "PENDING") commits.add(`${key}:${commit}`);
    }
    known.set(key, value.reviewsComplete === true && value.reviewsOmitted === 0);
  }
  return { recorded: commits.size, complete: known.size > 0 && [...known.values()].every(Boolean), readCalls,
    basis: "distinct PR commits with submitted reviews in recorded reads" };
}

function costOf(events: Event[], overrides: Record<string, ModelPrice>) {
  let total = 0, completedCalls = 0, unpricedCalls = 0, estimatedCalls = 0;
  for (const event of events) {
    if (event.kind !== "model.completed") continue;
    const value = event.data, reported = row(value.reported);
    const hasReport = typeof reported.input === "number" && typeof reported.output === "number";
    const input = hasReport ? reported.input : value.estimatedInput, output = hasReport ? reported.output : value.estimatedOutput;
    completedCalls++;
    if (!hasReport) estimatedCalls++;
    if (typeof input !== "number" || typeof output !== "number" || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) { unpricedCalls++; continue; }
    const cached = typeof reported.cachedInput === "number" && Number.isFinite(reported.cachedInput) && reported.cachedInput >= 0 ? reported.cachedInput : 0;
    const amount = value.cached === true ? 0 : estimateCost(String(value.model ?? ""), { input, output, cached }, overrides).amount;
    if (amount === null) unpricedCalls++; else total += amount;
  }
  const incompleteCalls = Math.max(0, events.filter((event) => event.kind === "model.started").length - completedCalls);
  return { amount: completedCalls && !unpricedCalls && !incompleteCalls ? Math.round(total * 1_000_000) / 1_000_000 : null,
    pricedSubtotal: Math.round(total * 1_000_000) / 1_000_000, currency: "USD", kind: "estimate", completedCalls, unpricedCalls,
    estimatedCalls, incompleteCalls, includesHelpers: false, basis: "recorded completed model calls; incomplete calls are not costed" };
}

/** Durations use the moment a result was recorded, rather than inventing GitHub's unrecorded timestamps. */
export function sourceChangeMetrics(run: Run, events: Event[], requests: PullRequestResult[], overrides: Record<string, ModelPrice> = {}) {
  return { pullRequests: requests.map((request) => ({ key: request.key, timeToPrMs: elapsed(run.createdAt, request.openedAt),
    timeToMergeObservedMs: elapsed(run.createdAt, request.mergeObservedAt) })), reviews: reviewRounds(events, requests), cost: costOf(events, overrides) };
}
