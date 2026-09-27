/**
 * Whether Branch itself is keeping up (public list, bucket 13, "event-loop diagnostics").
 *
 * Everything Branch does — answering the window, running tasks, reading chat apps — takes turns on
 * one line of work. When one piece holds that line too long, everything else waits: the window
 * freezes, a chat message is answered late. This watch measures how late those turns start and how
 * much of the time the line is busy, and says in one sentence whether that is fine, slow or stuck.
 *
 * The owner's three-way switch, off by default:
 * - off: nothing is measured and the reading refuses;
 * - when-needed: a short measurement is taken only when the reading is asked for;
 * - on: the watch runs all the time from the moment Branch starts, and counts every stall.
 *
 * Node's own measuring tools are handed in, so tests use fakes and nothing real is timed.
 */
import { monitorEventLoopDelay, performance, type EventLoopUtilization, type IntervalHistogram } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { FeatureModeSchema, optionalFields, type FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";
import { markChosen, sentKeys, shippedUnlessChosen } from "./ship-on.js";

export const EventLoopSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  /** A turn that starts later than this counts as a stall. */
  stallMs: z.number().int().min(50).max(10000).default(250),
}).strict();
export type EventLoopSettings = z.infer<typeof EventLoopSettingsSchema>;
const settingsKey = "event-loop-watch";

// The owner's rule (ships on, 2026-09-26): it reads Branch's own timing, which is measured anyway, and only says fine, slow or stuck; none of (a)–(f).
export const eventLoopShipsAs: FeatureMode = "when-needed";

export function eventLoopSettings(store: Pick<Store, "get">, owner: string): EventLoopSettings {
  const saved = EventLoopSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, settingsKey, saved.data, { mode: eventLoopShipsAs }) : EventLoopSettingsSchema.parse({});
}
export function saveEventLoopSettings(store: Store, owner: string, input: unknown): EventLoopSettings {
  const change = optionalFields(EventLoopSettingsSchema).parse(input);
  const next = EventLoopSettingsSchema.parse({ ...eventLoopSettings(store, owner), ...change });
  store.save("settings", owner, settingsKey, next);
  markChosen(store, owner, settingsKey, sentKeys(change));
  return next;
}

export interface EventLoopReading {
  mode: FeatureMode;
  /** How late turns started, in milliseconds. */
  delay: { mean: number; p50: number; p99: number; max: number };
  /** Share of the time the line of work was busy, from 0 to 1. */
  busy: number;
  /** Measurements that showed a turn starting later than the stall limit, since the watch started. */
  stalls: number;
  sampledSeconds: number;
  verdict: "fine" | "slow" | "stuck";
  words: string;
}

export interface LoopTools {
  histogram: (resolution: number) => Pick<IntervalHistogram, "enable" | "disable" | "reset" | "mean" | "max" | "percentile">;
  utilization: (previous?: EventLoopUtilization) => EventLoopUtilization;
  now: () => number;
  wait: (ms: number) => Promise<unknown>;
}
export const realLoopTools: LoopTools = {
  histogram: (resolution) => monitorEventLoopDelay({ resolution }),
  utilization: (previous) => performance.eventLoopUtilization(previous),
  now: () => Date.now(),
  wait: (ms) => delay(ms, undefined, { ref: false }),
};

const round = (value: number): number => (Number.isFinite(value) ? Math.round(value * 10) / 10 : 0);
const nsToMs = (value: number): number => round(value / 1e6);

/** The verdict and its sentence, from the numbers. Kept apart so every edge is tested. */
export function judge(p99: number, busy: number, stallMs: number): Pick<EventLoopReading, "verdict" | "words"> {
  if (p99 >= stallMs * 4)
    return { verdict: "stuck", words: `Branch is stalling: some of its work waited ${Math.round(p99)} ms to start. The window and chat apps will feel frozen.` };
  if (p99 >= stallMs || busy >= 0.9)
    return { verdict: "slow", words: `Branch is busy: work waits up to ${Math.round(p99)} ms to start and it is occupied ${Math.round(busy * 100)}% of the time.` };
  return { verdict: "fine", words: `Branch is keeping up: work starts within ${Math.round(p99)} ms and it is occupied ${Math.round(busy * 100)}% of the time.` };
}

/** One watch for the whole app. `start` and `stop` may be called any number of times. */
export class EventLoopWatch {
  private histogram: ReturnType<LoopTools["histogram"]> | null = null;
  private since: EventLoopUtilization | null = null;
  private startedAt = 0;
  private stalls = 0;
  private sampler: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly tools: LoopTools = realLoopTools) {}

  get running(): boolean { return this.histogram !== null; }

  start(stallMs: number, checkEveryMs = 5000): void {
    if (this.histogram) return;
    this.histogram = this.tools.histogram(20);
    this.histogram.enable();
    this.since = this.tools.utilization();
    this.startedAt = this.tools.now();
    this.stalls = 0;
    this.sampler = setInterval(() => this.countStall(stallMs), checkEveryMs);
    this.sampler.unref();
  }

  stop(): void {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
    this.histogram?.disable();
    this.histogram = null;
    this.since = null;
  }

  /** Checks the last few seconds for a stall, then starts the next few seconds afresh. */
  countStall(stallMs: number): void {
    if (!this.histogram) return;
    if (nsToMs(this.histogram.max) >= stallMs) this.stalls += 1;
    this.histogram.reset();
  }

  read(mode: FeatureMode, stallMs: number): EventLoopReading {
    if (!this.histogram || !this.since) throw new Error("The watch is not running");
    const busy = round(this.tools.utilization(this.since).utilization * 100) / 100;
    const p99 = nsToMs(this.histogram.percentile(99));
    return {
      mode, busy, stalls: this.stalls + (p99 >= stallMs ? 1 : 0),
      delay: { mean: nsToMs(this.histogram.mean), p50: nsToMs(this.histogram.percentile(50)), p99, max: nsToMs(this.histogram.max) },
      sampledSeconds: round((this.tools.now() - this.startedAt) / 1000),
      ...judge(p99, busy, stallMs),
    };
  }

  /** The reading the owner asked for, honouring the switch. */
  async reading(settings: EventLoopSettings, sampleMs = 2000): Promise<EventLoopReading> {
    if (settings.mode === "off") throw Object.assign(new Error("The check on whether Branch is keeping up is switched off. Turn it on under Settings, Advanced."), { status: 403 });
    if (this.running) return this.read(settings.mode, settings.stallMs);
    this.start(settings.stallMs);
    try {
      await this.tools.wait(sampleMs);
      return this.read(settings.mode, settings.stallMs);
    } finally {
      /* "On" keeps watching from here; "when needed" measured only for this one reading. */
      if (settings.mode !== "on") this.stop();
    }
  }

  /** Brings the watch in line with a saved switch: running only while it is on. */
  follow(settings: EventLoopSettings): void {
    if (settings.mode === "on") this.start(settings.stallMs);
    else this.stop();
  }
}

/** The app's one watch. */
export const eventLoopWatch = new EventLoopWatch();
