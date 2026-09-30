import { z } from "zod";
import { currentCaller } from "./caller.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { currentTaskRun } from "./task-scope.js";
import { lockdownActive } from "./lockdown.js";
import { HttpError } from "./server-http.js";
import type { SelfDevelopmentDeps } from "./self-development.js";
import { qaJourneys } from "./continuous-qa-native.js";
import { TestCopyJobs } from "./self-development-test-copy-jobs.js";
import { draftQaFix, type QaFixModel } from "./continuous-qa-fix.js";

export const QaSettings = z.object({ enabled: z.boolean().default(false), copyId: z.string().uuid().nullable().default(null),
  target: z.enum(["web", "desktop-copy", "native-copy"]).default("web"),
  journeys: z.array(z.enum(qaJourneys)).max(3).default([]),
  intervalMinutes: z.number().int().min(30).max(1440).default(120), maxCyclesPerDay: z.number().int().min(1).max(12).default(2),
  modelFixes: z.boolean().default(false), preset: z.string().max(64).default(""),
  fixTokens: z.number().int().min(1000).max(50_000).default(10_000), dailyFixTokens: z.number().int().min(1000).max(200_000).default(20_000),
  fixPaths: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).max(200).refine((path) => !path.split("/").includes(".."))).max(8).default([]),
}).strict();
type Settings = z.infer<typeof QaSettings>;
const key = "continuous-qa";

/** Opt-in continuous observations, reusing the exact Test copy runner. Never an installed-app runner. */
export class ContinuousQa {
  private readonly jobs: TestCopyJobs;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private jobId: string | undefined;
  private problem: string | null = null;
  private closed = false;
  constructor(private readonly deps: SelfDevelopmentDeps, private readonly locked: () => boolean, private readonly model: QaFixModel) {
    this.jobs = new TestCopyJobs(deps);
    this.arm();
  }
  private settings(): Settings { return QaSettings.parse(this.deps.store.get("settings", this.deps.owner, key)?.data ?? {}); }
  private ownerHere(): void {
    this.deps.store.profiles.requireOwner("Continuous QA");
    if (currentCaller().kind !== "owner-here" || startedWithShortLivedKey() || currentTaskRun()) throw new HttpError(403, "Configure QA in the owner app on this computer.");
    if (this.locked() || lockdownActive(this.deps.store, this.deps.owner)) throw new HttpError(423, "Unlock Branch and leave Lockdown off before enabling QA.");
  }
  status(): unknown {
    this.ownerHere();
    return { settings: this.settings(), running: !!this.controller, problem: this.problem,
      job: this.jobId ? this.jobs.status({ id: this.jobId }) : null,
      findings: this.deps.store.get("governance", this.deps.owner, `${key}-findings`)?.data ?? {} };
  }
  async configure(input: unknown): Promise<unknown> {
    this.ownerHere(); const settings = QaSettings.parse(input);
    if (settings.enabled && !settings.copyId) throw new Error("Prepare and select an isolated Test copy first.");
    if (settings.target === "native-copy" && settings.enabled && (!settings.journeys.length || new Set(settings.journeys).size !== settings.journeys.length)) throw new Error("Approve explicit native read-only journeys first.");
    if (settings.modelFixes && (!settings.preset || !settings.fixPaths.length || settings.dailyFixTokens < settings.fixTokens))
      throw new Error("Model fix drafts need an explicit preset, file scope and sufficient daily token budget.");
    if (settings.copyId) await this.jobs.verifiedReceipt(settings.copyId);
    this.ownerHere(); this.stop();
    this.deps.store.save("settings", this.deps.owner, key, { ...settings }); this.arm();
    return this.status();
  }
  private arm(): void {
    if (this.closed || this.timer || !this.settings().enabled) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.cycle().catch((error) => { this.problem = String(error); }).finally(() => this.arm()); }, this.settings().intervalMinutes * 60_000);
    this.timer.unref();
  }
  private reserve(settings: Settings): boolean {
    const today = new Date().toISOString().slice(0, 10), previous = this.deps.store.get("governance", this.deps.owner, `${key}-budget`)?.data ?? {};
    const cycles = previous.day === today ? Number(previous.cycles ?? 0) : 0, tokens = previous.day === today ? Number(previous.reservedTokens ?? 0) : 0;
    if (cycles >= settings.maxCyclesPerDay || settings.modelFixes && tokens + settings.fixTokens > settings.dailyFixTokens) return false;
    this.deps.store.save("governance", this.deps.owner, `${key}-budget`, { day: today, cycles: cycles + 1, reservedTokens: tokens + (settings.modelFixes ? settings.fixTokens : 0) });
    return true;
  }
  private async cycle(): Promise<void> {
    const settings = this.settings();
    if (!settings.enabled || !settings.copyId || this.controller || this.locked() || lockdownActive(this.deps.store, this.deps.owner)) return;
    if (!this.reserve(settings)) { this.problem = "The daily QA/model budget is exhausted; no work started."; return; }
    const controller = new AbortController(); this.controller = controller;
    try {
      const copy = await this.jobs.verifiedReceipt(settings.copyId);
      const job = await this.jobs.start({ id: copy.id, mode: "dogfood", target: settings.target, journeys: settings.journeys }); this.jobId = job.id;
      let result = job;
      while (result.status === "running") {
        await new Promise<void>((resolve) => setTimeout(resolve, 5000));
        if (controller.signal.aborted || this.locked() || lockdownActive(this.deps.store, this.deps.owner)) { this.jobs.cancel({ id: job.id }); controller.abort(); break; }
        result = this.jobs.status({ id: job.id });
      }
      controller.signal.throwIfAborted();
      if (result.status === "failed") {
        this.deps.store.save("settings", this.deps.owner, key, { ...settings, enabled: false });
        await this.finding(settings, copy, { jobId: job.id, sha: job.sha,
          evidence: (result.problem ?? `${result.result?.stdout ?? ""}\n${result.result?.stderr ?? ""}`).slice(-8000) }, controller.signal);
        this.problem = "QA found a failure and prepared an isolated draft. Review it before resuming.";
      } else this.problem = result.status === "held" ? result.problem ?? "QA dependencies are held; inspect the isolated job." : null;
    } finally { this.controller = undefined; }
  }
  private async finding(settings: Settings, copy: Awaited<ReturnType<TestCopyJobs["verifiedReceipt"]>>, evidence: unknown, signal: AbortSignal): Promise<void> {
    let draft = await draftQaFix(this.deps, copy, evidence, settings.fixPaths, undefined, settings.preset, settings.fixTokens, signal);
    this.deps.store.save("governance", this.deps.owner, `${key}-findings`, { latest: draft });
    if (!settings.modelFixes) return;
    try {
      draft = await draftQaFix(this.deps, copy, evidence, settings.fixPaths, this.model, settings.preset, settings.fixTokens, signal);
      this.deps.store.save("governance", this.deps.owner, `${key}-findings`, { latest: draft });
    } catch (error) {
      this.deps.store.save("governance", this.deps.owner, `${key}-findings`, { latest: draft, draftProblem: String(error) });
    }
  }
  private stop(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.controller?.abort();
    if (this.jobId && this.jobs.status({ id: this.jobId }).status === "running") this.jobs.cancel({ id: this.jobId });
  }
  close(): void { this.closed = true; this.stop(); }
}
