import { DatabaseSync } from "node:sqlite";
import type { Run, Event } from "./contracts.js";
import { estimateCost, type ModelPrice } from "./pricing.js";

export interface UsageAggregate {
  date: string;
  runs: number;
  toolCalls: number;
  tokens: { input: number; output: number };
  /** US dollars for the tasks whose model has a price; tasks without one are counted separately. */
  estimatedCost: number;
  /** Tasks whose model has a price on file, and tasks that have none. Never show 0 for the latter. */
  pricedRuns: number;
  unpricedRuns: number;
  failures: number;
  topFailures: Array<{ reason: string; count: number }>;
  presets: Array<{ id: string; model: string; runs: number; tokens: { input: number; output: number }; cost: number | null }>;
  byConversation: Array<{ sessionId: string; runs: number; tokens: { input: number; output: number }; cost: number | null }>;
  byChannel: Array<{ source: string; runs: number; cost: number | null }>;
}

export interface UsageStats {
  currentMonthlyTokens: number;
  monthStart: string;
  budgetAlert80Percent: boolean;
  /** US dollars for the tasks this month that have a price, and how many had none. */
  estimatedCost: number;
  unpricedRuns: number;
  /**
   * hardening-3: dollars already spent on something still being made by a task that has not finished
   * (a video), included in `estimatedCost` so the month is never understated while it runs.
   */
  stillBeingMade: number;
}

/** One finished task reduced to what the usage views need: who ran it, on what, for how many tokens. */
interface RunCost {
  date: string;
  sessionId: string;
  source: string;
  presetId: string;
  model: string;
  tokens: { input: number; output: number };
  toolCalls: number;
  failures: number;
  cost: number | null;
}

export interface TimelineEntry {
  timestamp: string;
  type: "model.started" | "model.completed" | "tool.started" | "tool.completed" | "permission" | "retry" | "stall" | "delegation";
  title: string;
  duration: number | undefined;
  result: "success" | "failed" | "timeout" | undefined;
  inputClipped: string | undefined;
  outputClipped: string | undefined;
  details: Record<string, unknown> | undefined;
}

export class UsageStore {
  private cacheTableReady = false;

  constructor(readonly db: DatabaseSync) {
    this.initCache();
  }

  private initCache(): void {
    if (this.cacheTableReady) return;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_cache(
        date TEXT PRIMARY KEY,
        runs INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL,
        tokens_input INTEGER NOT NULL,
        tokens_output INTEGER NOT NULL,
        estimated_cost REAL NOT NULL,
        failures INTEGER NOT NULL,
        top_failures TEXT NOT NULL,
        by_preset TEXT NOT NULL,
        by_conversation TEXT NOT NULL,
        by_channel TEXT NOT NULL,
        last_event_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );`
    );
    this.cacheTableReady = true;
  }

  private getDate(timestamp: string): string {
    return timestamp.split("T")[0] || timestamp;
  }

  /** Tokens as the provider reported them, falling back to the runtime's own estimate. */
  private runTokens(runId: string): { input: number; output: number } {
    const usage = this.db
      .prepare(`SELECT estimated_input, estimated_output, reported_input, reported_output FROM usage WHERE run_id = ?`)
      .get(runId) as
      | { estimated_input: number; estimated_output: number; reported_input: number; reported_output: number }
      | undefined;
    if (!usage) return { input: 0, output: 0 };
    return {
      input: usage.reported_input || usage.estimated_input || 0,
      output: usage.reported_output || usage.estimated_output || 0,
    };
  }

  /** Dollars this task spent on something that is not tokens, from its `spend.recorded` events. */
  private runSpend(runId: string): number {
    const rows = this.db.prepare(`SELECT data FROM events WHERE run_id = ? AND kind = 'spend.recorded'`).all(runId) as Array<{ data: string }>;
    let total = 0;
    for (const row of rows) {
      const data = JSON.parse(row.data) as { dollars?: unknown };
      total += Number(data.dollars ?? 0) || 0;
    }
    return total;
  }

  /**
   * hardening-3: money recorded by tasks that have not finished yet (running or waiting for a person).
   * mac7/residuals: every one of them, whatever month it began: a task started last month and still
   * going has not been counted in any month's finished figures, so it belongs in this one's.
   */
  private inFlightSpend(): number {
    const runs = this.db
      .prepare(`SELECT id FROM tasks WHERE status IN ('running', 'needs_input')`)
      .all() as Array<{ id: string }>;
    return runs.reduce((total, run) => total + this.runSpend(run.id), 0);
  }

  /** Which model answered, how many tools ran, and how many of them failed, from the run's events. */
  private runEvents(runId: string): { presetId: string; model: string; toolCalls: number; failures: number } {
    const events = this.db
      .prepare(`SELECT kind, data FROM events WHERE run_id = ? ORDER BY id`)
      .all(runId) as Array<{ kind: string; data: string }>;
    let presetId = "", model = "", started = 0, finished = 0, failures = 0;
    for (const event of events) {
      // One call writes a start and an end; counting both made every call count twice (bucket 14).
      if (event.kind === "tool.started") started += 1;
      if (event.kind === "tool.completed" || event.kind === "tool.failed") finished += 1;
      if (event.kind === "tool.failed") failures += 1;
      // model.started also names the model, so tasks recorded before model.completed carried it
      // are still attributed correctly.
      if (event.kind !== "model.completed" && event.kind !== "model.started") continue;
      const data = JSON.parse(event.data) as Record<string, unknown>;
      // The last round wins: after a fallback the task finished on the model named here.
      if (data.preset !== undefined) presetId = String(data.preset);
      if (data.model !== undefined) model = String(data.model);
    }
    return { presetId, model, toolCalls: Math.max(started, finished), failures };
  }

  /**
   * Every finished task in the range with its tokens and, when the model has a price, its cost.
   * Cost is worked out once per task from its single usage row, never once per model round.
   */
  private runCosts(cutoff: string, overrides: Record<string, ModelPrice>): RunCost[] {
    const runs = this.db
      .prepare(
        `SELECT id, session_id, status, created_at, source FROM tasks
         WHERE created_at >= ? AND status NOT IN ('running', 'needs_input')
         ORDER BY created_at DESC`
      )
      .all(cutoff) as Array<{ id: string; session_id: string; status: string; created_at: string; source: string }>;
    return runs.map((run) => {
      const tokens = this.runTokens(run.id);
      const { presetId, model, toolCalls, failures } = this.runEvents(run.id);
      const estimate = model ? estimateCost(model, tokens, overrides) : null;
      return {
        date: this.getDate(run.created_at),
        sessionId: run.session_id,
        source: run.source,
        presetId,
        model,
        tokens,
        toolCalls,
        failures: failures + (run.status === "failed" || run.status === "budget_exceeded" ? 1 : 0),
        cost: estimate?.amount ?? null,
      };
    });
  }

  private static emptyAggregate(date: string): UsageAggregate {
    return {
      date, runs: 0, toolCalls: 0, tokens: { input: 0, output: 0 }, estimatedCost: 0,
      pricedRuns: 0, unpricedRuns: 0, failures: 0, topFailures: [],
      presets: [], byConversation: [], byChannel: [],
    };
  }

  /** Adds one task's cost to a group, keeping "no price on file" (null) distinct from zero. */
  private static addCost(group: { cost: number | null }, cost: number | null): void {
    if (cost === null) return;
    group.cost = (group.cost ?? 0) + cost;
  }

  private static foldTotals(agg: UsageAggregate, run: RunCost): void {
    agg.runs += 1;
    agg.toolCalls += run.toolCalls;
    agg.failures += run.failures;
    agg.tokens.input += run.tokens.input;
    agg.tokens.output += run.tokens.output;
    if (run.cost === null) agg.unpricedRuns += 1;
    else { agg.pricedRuns += 1; agg.estimatedCost += run.cost; }
  }

  private static foldGroups(agg: UsageAggregate, run: RunCost): void {
    const key = run.presetId || run.model;
    if (key) {
      let preset = agg.presets.find((p) => p.id === key);
      if (!preset) { preset = { id: key, model: run.model, runs: 0, tokens: { input: 0, output: 0 }, cost: null }; agg.presets.push(preset); }
      preset.runs += 1;
      preset.tokens.input += run.tokens.input;
      preset.tokens.output += run.tokens.output;
      UsageStore.addCost(preset, run.cost);
    }
    let conversation = agg.byConversation.find((c) => c.sessionId === run.sessionId);
    if (!conversation) { conversation = { sessionId: run.sessionId, runs: 0, tokens: { input: 0, output: 0 }, cost: null }; agg.byConversation.push(conversation); }
    conversation.runs += 1;
    conversation.tokens.input += run.tokens.input;
    conversation.tokens.output += run.tokens.output;
    UsageStore.addCost(conversation, run.cost);
    let channel = agg.byChannel.find((s) => s.source === run.source);
    if (!channel) { channel = { source: run.source, runs: 0, cost: null }; agg.byChannel.push(channel); }
    channel.runs += 1;
    UsageStore.addCost(channel, run.cost);
  }

  /**
   * Finished tasks grouped by day, with tokens and estimated cost. `overrides` are the owner's own
   * prices; a model with no price in them and none in the built-in table is counted as unpriced
   * rather than as costing nothing, so the screens never show a made-up $0.00.
   */
  aggregateUsage(
    range: "7d" | "30d" | "90d" | "all" = "30d",
    groupBy: "day" | "model" | "conversation" | "source" = "day",
    overrides: Record<string, ModelPrice> = {},
    /** Q259: only the tasks of these conversations (a household person's own); every task when left out. */
    inConversation?: (sessionId: string) => boolean,
  ): UsageAggregate[] {
    void groupBy; // Each day's record carries every grouping, so the caller picks one to display.
    const daysBack = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 36500;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const aggregates = new Map<string, UsageAggregate>();
    for (const run of this.runCosts(cutoff, overrides)) {
      if (inConversation && !inConversation(run.sessionId)) continue;
      let agg = aggregates.get(run.date);
      if (!agg) { agg = UsageStore.emptyAggregate(run.date); aggregates.set(run.date, agg); }
      UsageStore.foldTotals(agg, run);
      UsageStore.foldGroups(agg, run);
    }
    for (const agg of aggregates.values()) agg.estimatedCost = Math.round(agg.estimatedCost * 1_000_000) / 1_000_000;
    return Array.from(aggregates.values()).sort((a, b) => b.date.localeCompare(a.date));
  }

  getRunTimeline(runId: string): TimelineEntry[] {
    const events = this.db
      .prepare(`SELECT kind, data, created_at FROM events WHERE run_id = ? ORDER BY id`)
      .all(runId) as Array<{ kind: string; data: string; created_at: string }>;

    const timeline: TimelineEntry[] = [];
    const startTimes = new Map<string, string>();
    let lastToolId: string | null = null;

    for (const event of events) {
      const data = JSON.parse(event.data) as Record<string, unknown>;

      if (event.kind === "model.started") {
        startTimes.set("model", event.created_at);
      } else if (event.kind === "model.completed") {
        const start = startTimes.get("model");
        const duration = start
          ? Math.round((new Date(event.created_at).getTime() - new Date(start).getTime()) / 1000)
          : undefined;
        timeline.push({
          timestamp: event.created_at,
          type: "model.completed",
          title: `Model: ${data.model || "unknown"} (${data.provider || "?"})`,
          duration: duration,
          result: "success",
          inputClipped: undefined,
          outputClipped: undefined,
          details: { preset: data.preset, provider: data.provider, model: data.model, reasoning: data.reasoning },
        });
      } else if (event.kind === "tool.started") {
        lastToolId = String(data.id ?? "");
        startTimes.set(`tool:${lastToolId}`, event.created_at);
      } else if (event.kind === "tool.completed") {
        const toolId = String(data.id ?? lastToolId ?? "");
        const start = startTimes.get(`tool:${toolId}`);
        const duration = start
          ? Math.round((new Date(event.created_at).getTime() - new Date(start).getTime()) / 1000)
          : undefined;
        timeline.push({
          timestamp: event.created_at,
          type: "tool.completed",
          title: `Tool: ${data.name || "unknown"}`,
          duration: duration,
          result: "success",
          inputClipped: undefined,
          outputClipped: undefined,
          details: { id: toolId, name: data.name },
        });
      } else if (event.kind === "tool.failed") {
        timeline.push({
          timestamp: event.created_at,
          type: "tool.completed",
          title: `Tool failed: ${data.name || "unknown"}`,
          duration: undefined,
          result: "failed",
          inputClipped: undefined,
          outputClipped: undefined,
          details: { error: data.error },
        });
      } else if (event.kind === "model.retry_scheduled") {
        timeline.push({
          timestamp: event.created_at,
          type: "retry",
          title: `Retry scheduled (${data.attempt || 1})`,
          duration: undefined,
          result: undefined,
          inputClipped: undefined,
          outputClipped: undefined,
          details: { preset: data.preset, afterMs: data.afterMs },
        });
      } else if (event.kind === "model.stall_recovery") {
        timeline.push({
          timestamp: event.created_at,
          type: "stall",
          title: `Stall detected and recovered`,
          duration: undefined,
          result: undefined,
          inputClipped: undefined,
          outputClipped: undefined,
          details: { action: data.action, stalls: data.stalls, afterMs: data.afterMs },
        });
      } else if (event.kind === "delegation.fanout") {
        timeline.push({
          timestamp: event.created_at,
          type: "delegation",
          title: `Delegated ${data.count || 1} tasks in parallel`,
          duration: undefined,
          result: undefined,
          inputClipped: undefined,
          outputClipped: undefined,
          details: { count: data.count, ids: data.ids },
        });
      }
    }

    return timeline;
  }

  /** This calendar month's tokens and, for the tasks whose model has a price, the money they cost. */
  getMonthlyStats(maxMonthlyTokens?: number, overrides: Record<string, ModelPrice> = {}): UsageStats {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const runs = this.db
      .prepare(`SELECT id FROM tasks WHERE status NOT IN ('running', 'needs_input') AND created_at >= ? ORDER BY created_at DESC`)
      .all(monthStart) as Array<{ id: string }>;

    let total = 0, cost = 0, unpricedRuns = 0;
    for (const run of runs) {
      const tokens = this.runTokens(run.id);
      total += tokens.input + tokens.output;
      const { model } = this.runEvents(run.id);
      const amount = model ? estimateCost(model, tokens, overrides).amount : null;
      if (amount === null) unpricedRuns += 1;
      else cost += amount;
      // mac7/reach-leftovers: what a task spent outside the model's tokens (a video) is money too.
      cost += this.runSpend(run.id);
    }

    // hardening-3: a task still running has already paid for what it asked a service to make (a video
    // is recorded before the service is asked), so that money is in the month now, not when it ends.
    const stillBeingMade = this.inFlightSpend();
    const alert80 = maxMonthlyTokens ? total >= maxMonthlyTokens * 0.8 : false;
    return {
      currentMonthlyTokens: total,
      monthStart: monthStart.split("T")[0] || monthStart,
      budgetAlert80Percent: alert80,
      estimatedCost: Math.round((cost + stillBeingMade) * 1_000_000) / 1_000_000,
      unpricedRuns,
      stillBeingMade: Math.round(stillBeingMade * 1_000_000) / 1_000_000,
    };
  }

  /**
   * The few numbers that say how this copy of Branch is behaving, rather than what it cost: the
   * middle round's size (the middle, not the average, so one enormous task does not colour it),
   * how often a tool worked, and how many times a conversation had to be shortened.
   */
  statistics(owner: string, sinceDays = 30): {
    medianTokensPerRound: number | null; rounds: number;
    toolCalls: number; toolFailures: number; toolSuccessRate: number | null; compactions: number;
  } {
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(
      `SELECT e.data AS data FROM events e JOIN tasks t ON t.id = e.run_id
       WHERE t.owner = ? AND e.created_at >= ? AND e.kind = 'model.completed'`
    ).all(owner, cutoff) as Array<{ data: string }>;
    const sizes: number[] = [];
    for (const row of rows) {
      const data = JSON.parse(row.data) as { reported?: { input?: number; output?: number }; estimatedInput?: number; estimatedOutput?: number };
      const size = (data.reported?.input ?? data.estimatedInput ?? 0) + (data.reported?.output ?? data.estimatedOutput ?? 0);
      if (size > 0) sizes.push(size);
    }
    sizes.sort((a, b) => a - b);
    const middle = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)]! : null;
    const count = (kinds: string) => Number((this.db.prepare(
      `SELECT COUNT(*) AS n FROM events e JOIN tasks t ON t.id = e.run_id
       WHERE t.owner = ? AND e.created_at >= ? AND e.kind IN (${kinds})`
    ).get(owner, cutoff) as { n: number }).n);
    const done = count("'tool.completed'"), failed = count("'tool.failed','tool.stalled'");
    let compactions = 0;
    try {
      compactions = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM compactions WHERE created_at >= ?`)
        .get(cutoff) as { n: number }).n);
    } catch { /* an older install has no compactions table yet, which counts as none */ }
    return {
      medianTokensPerRound: middle, rounds: sizes.length,
      toolCalls: done + failed, toolFailures: failed,
      toolSuccessRate: done + failed > 0 ? done / (done + failed) : null,
      compactions,
    };
  }

  updateCache(date: string, aggregate: UsageAggregate, lastEventId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO usage_cache VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(date) DO UPDATE SET runs=excluded.runs, tool_calls=excluded.tool_calls,
         tokens_input=excluded.tokens_input, tokens_output=excluded.tokens_output,
         estimated_cost=excluded.estimated_cost, failures=excluded.failures,
         top_failures=excluded.top_failures, by_preset=excluded.by_preset,
         by_conversation=excluded.by_conversation, by_channel=excluded.by_channel,
         last_event_id=excluded.last_event_id`
      )
      .run(
        date,
        aggregate.runs,
        aggregate.toolCalls,
        aggregate.tokens.input,
        aggregate.tokens.output,
        aggregate.estimatedCost,
        aggregate.failures,
        JSON.stringify(aggregate.topFailures),
        JSON.stringify(aggregate.presets),
        JSON.stringify(aggregate.byConversation),
        JSON.stringify(aggregate.byChannel),
        lastEventId,
        now
      );
  }

  private static fromCacheRow(row: Record<string, unknown>): UsageAggregate {
    const presets = JSON.parse(String(row.by_preset)) as UsageAggregate["presets"];
    return {
      date: String(row.date),
      runs: Number(row.runs),
      toolCalls: Number(row.tool_calls),
      tokens: { input: Number(row.tokens_input), output: Number(row.tokens_output) },
      estimatedCost: Number(row.estimated_cost),
      // The cache predates price tracking and records no price confidence, so its tasks count as
      // unpriced. Claiming they were priced would let a cached day render a cost nobody worked out.
      pricedRuns: 0,
      unpricedRuns: Number(row.runs),
      failures: Number(row.failures),
      topFailures: JSON.parse(String(row.top_failures)),
      presets,
      byConversation: JSON.parse(String(row.by_conversation)),
      byChannel: JSON.parse(String(row.by_channel)),
    };
  }

  getCachedUsage(date?: string): UsageAggregate | UsageAggregate[] | null {
    if (date) {
      const row = this.db
        .prepare(`SELECT * FROM usage_cache WHERE date = ?`)
        .get(date) as Record<string, unknown> | undefined;
      return row ? UsageStore.fromCacheRow(row) : null;
    }
    const rows = this.db.prepare(`SELECT * FROM usage_cache ORDER BY date DESC`).all() as Record<string, unknown>[];
    return rows.map((row) => UsageStore.fromCacheRow(row));
  }
}
