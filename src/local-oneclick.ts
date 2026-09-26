import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { errorText } from "./contracts.js";
import { findVariant, ollamaDownloadBytes, variantBytes, type CatalogueEntry, type CatalogueVariant } from "./local-catalogue.js";
import { registerLocalConnection, smokeTest, type LocalConnectionDeps } from "./local-connections.js";
import { assertRoomOnDisk, downloadFile, freeDiskBytes, mlxFilesWanted, modelsFolder, repoFiles, resolveUrl, type StatFs } from "./local-files.js";
import { chooseContext, judgeFit, type MachineRoom } from "./local-fit.js";
import { SetupJobs, SetupRequestSchema, assertLocalModelsOn, type SetupJob, type SetupRequest } from "./local-jobs.js";
import { runtimeIds, runtimeInfo, type RuntimeId, type RuntimeLauncher } from "./local-launch.js";
import { LmStudioClient, OllamaClient, OpenAiServerClient, lmStudioModelName, localModelName } from "./local-models.js";
import { localRuntimeFetch } from "./local-policy.js";
import { detectTools, installPlan, isInstallable, planSize, runInstall, type InstallPlan, type InstallableRunner } from "./local-install.js";
import {
  ButtonGoSchema, ButtonPlanSchema, installGuard, needsAgreementNote, notInstalledNote, planChangedNote, sizeChoices,
  systemWideAllowed,
  type ButtonGo, type PressContext, type SizeChoice,
} from "./local-one-button.js";

/**
 * Wave mac5 (local models): one click, from "I want this model" to a connection that answers.
 *
 *   1. check   the runtime is installed (or say where the official installer is), the model fits
 *              this computer's free memory, and the disk has room for the download
 *   2. start   the runtime, if it is installed and not already running
 *   3. fetch   the model, with progress; a stopped or interrupted download carries on later
 *   4. load    it with the room for words that fits this computer
 *   5. connect it as a model connection that "runs on this computer", after one small question
 *
 * Every step is written down as it happens (`SetupJobs`), so the screen can show it and a restart
 * picks the setup up again.
 */
export interface OneClickDeps extends LocalConnectionDeps {
  dataDir: string;
  launcher: RuntimeLauncher;
  /** Reaches the model libraries on the internet, under the ordinary network rules. */
  library: typeof globalThis.fetch;
  room: () => Promise<MachineRoom>;
  statfs?: StatFs;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  test?: typeof smokeTest;
}

/** mac7/one-click: what the button would do, before anything is done. */
export interface OneButtonView {
  runner: InstallableRunner;
  name: string;
  alreadyInstalled: boolean;
  install: InstallPlan | null;
  downloadNote: string;
  /** mac7/clean-uninstall: where the models this button downloads will be kept. */
  modelsFolder: string;
  /** Free bytes on the disk that folder is on, or null when it cannot be told. */
  freeBytes: number | null;
  choices: SizeChoice[];
  recommended: SizeChoice["size"] | null;
  /** Why this caller may not press it, or null. The plan itself is only ever a description. */
  refusal: string | null;
}
export interface OneButtonAnswer {
  done: boolean;
  runner: InstallableRunner;
  message: string;
  job: SetupJob | null;
  chose: SizeChoice | null;
  /** Set when Branch is waiting for the owner to agree to exactly this plan. */
  needsAgreement?: InstallPlan;
}

interface Resolved {
  runtime: RuntimeId;
  label: string;
  /** What the runtime calls the download: an Ollama tag, a Hugging Face address, a repository. */
  source: string;
  entry: CatalogueEntry | null;
  variant: CatalogueVariant | null;
  bytes: number | null;
  context: number;
}

export class OneClick {
  readonly jobs: SetupJobs;
  private readonly running = new Map<string, AbortController>();
  private closing = false;
  private readonly ollama: OllamaClient;
  private readonly lmStudio: LmStudioClient;
  constructor(private readonly deps: OneClickDeps) {
    this.jobs = new SetupJobs(deps.store, deps.owner);
    const call = deps.fetch ?? globalThis.fetch;
    this.ollama = new OllamaClient(runtimeInfo.ollama.baseUrl, localRuntimeFetch(deps.policy, call, runtimeInfo.ollama.baseUrl));
    this.lmStudio = new LmStudioClient(runtimeInfo["lm-studio"].baseUrl, localRuntimeFetch(deps.policy, call, runtimeInfo["lm-studio"].baseUrl));
  }
  private now(): string { return (this.deps.now ?? (() => new Date()))().toISOString(); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? ((wait) => new Promise((done) => setTimeout(done, wait))))(ms); }

  /** Starts a setup and returns at once; the screen follows it through `jobs.all()`. */
  async begin(input: unknown): Promise<SetupJob | { needsRuntime: true; runtimes: typeof runtimeInfo[RuntimeId][]; message: string }> {
    assertLocalModelsOn(this.deps.store, this.deps.owner);
    const request = SetupRequestSchema.parse(input);
    const runtime = request.runtime ?? await this.pickRuntime();
    if (!runtime) return { needsRuntime: true, runtimes: runtimeIds.map((id) => runtimeInfo[id]), message: "No program that runs models is installed yet. Install one from its official page, then try again." };
    if (!(await this.deps.launcher.find(runtime)))
      return { needsRuntime: true, runtimes: [runtimeInfo[runtime]], message: `${runtimeInfo[runtime].name} is not installed on this computer. ${runtimeInfo[runtime].installNote}` };
    const resolved = await this.resolve(request, runtime);
    const busy = this.jobs.unfinished().find((job) => job.label === resolved.label && job.runtime === runtime && this.running.has(job.id));
    if (busy) return busy;
    const job = this.jobs.put({
      id: randomUUID(), runtime, request: request as Record<string, unknown>, label: resolved.label, stage: "checking",
      message: "Checking this computer…", completed: 0, total: resolved.bytes ?? 0, percent: 0, context: resolved.context,
      connectionId: null, startedAt: this.now(), finishedAt: null,
    });
    this.launch(job.id, resolved);
    return job;
  }
  private launch(id: string, resolved: Resolved): void {
    const controller = new AbortController();
    this.running.set(id, controller);
    void this.run(id, resolved, controller.signal).finally(() => this.running.delete(id));
  }

  /** The first installed runtime, in the order most people have them. */
  private async pickRuntime(): Promise<RuntimeId | null> {
    for (const id of runtimeIds) if (await this.deps.launcher.find(id)) return id;
    return null;
  }

  /** What exactly to fetch, and with how much room for words. Refuses what will not fit. */
  private async resolve(request: SetupRequest, runtime: RuntimeId): Promise<Resolved> {
    const room = await this.deps.room();
    if ("model" in request) {
      const { entry, variant } = findVariant(request.model, request.quant);
      const bytes = variantBytes(variant, runtime);
      if (bytes === null) throw new Error(`${entry.name} ${variant.quant} is not offered for ${runtimeInfo[runtime].name}. Pick another size or program.`);
      const { context, report } = chooseContext(room, bytes, entry.arch, entry.maxContext);
      if (report.fit === "no" && !request.force) throw new Error(report.note);
      return { runtime, label: `${entry.name} ${variant.quant}`, source: sourceFor(variant, runtime), entry, variant, bytes, context };
    }
    return this.resolveTyped(request.name, runtime, room, request.force);
  }
  private async resolveTyped(name: string, runtime: RuntimeId, room: MachineRoom, force: boolean): Promise<Resolved> {
    const plain = runtime === "ollama" ? localModelName.parse(name) : lmStudioModelName.parse(name);
    // LM Studio takes an exact Hugging Face address for anything outside its own catalogue.
    const source = runtime === "lm-studio" && /^[^/]+\/[^/]+$/.test(plain) ? `https://huggingface.co/${plain}` : plain;
    const bytes = runtime === "ollama" ? await ollamaDownloadBytes(source, this.deps.library) : null;
    // With no published layout, plan as a typical model of this size: 32 layers, 8 heads of 128.
    const report = bytes ? judgeFit(room, bytes, { layers: 32, kvHeads: 8, headDim: 128 }, 8192) : null;
    if (report?.fit === "no" && !force) throw new Error(report.note);
    return { runtime, label: source, source, entry: null, variant: null, bytes, context: 8192 };
  }

  private async run(id: string, resolved: Resolved, signal: AbortSignal): Promise<void> {
    const step = (change: Partial<SetupJob>) => this.jobs.update(id, change);
    try {
      await this.checkDisk(resolved);
      if (resolved.runtime === "ollama" || resolved.runtime === "lm-studio") await this.ensureRunning(resolved, step);
      step({ stage: "downloading", message: "Downloading…" });
      let shown = -1;
      const local = await this.fetchModel(resolved, signal, (completed, total) => {
        const percent = total ? Math.min(99, Math.floor((completed / total) * 100)) : 0;
        if (percent !== shown) { shown = percent; step({ completed, total, percent }); }
      });
      signal.throwIfAborted();
      step({ stage: "loading", message: "Loading it with room for about " + Math.round(resolved.context / 1000) + ",000 words…", percent: 100 });
      const model = await this.load(resolved, local, step);
      step({ stage: "connecting", message: "Asking it a small question…" });
      const record = await registerLocalConnection({ ...this.deps, endpoint: (runtime) => this.deps.launcher.baseUrl(runtime) }, { runtime: resolved.runtime, model, contextLength: resolved.context, label: resolved.label }, this.deps.test ?? smokeTest);
      step({ stage: "done", connectionId: record.id, finishedAt: this.now(), message: `Ready: ${record.name}.` });
    } catch (error) {
      // Closing Branch is not the owner stopping it: leave the setup open so it resumes next time.
      if (this.closing) { step({ message: "Waiting for Branch to open again…" }); return; }
      const stopped = signal.aborted;
      step({ stage: stopped ? "stopped" : "failed", finishedAt: this.now(),
        message: stopped ? "Stopped. Click again to carry on from where it was." : errorText(error).slice(0, 400) });
    }
  }

  private async checkDisk(resolved: Resolved): Promise<void> {
    if (!resolved.bytes) return;
    const folder = await this.modelsGoTo(resolved.runtime);
    await assertRoomOnDisk(folder, resolved.bytes, this.deps.launcher.at.platform, this.deps.statfs);
  }

  /** mac7/clean-uninstall: where this runtime's models land, inside Branch when Branch fetched it. */
  async modelsGoTo(runtime: RuntimeId): Promise<string> {
    return modelsFolder(runtime, this.deps.launcher.at, this.deps.dataDir, await this.deps.launcher.isOwn(runtime));
  }

  /** How much room is left where the models go, before anything is downloaded. The card says it. */
  async roomLeft(runtime: RuntimeId): Promise<number | null> {
    const folder = await this.modelsGoTo(runtime);
    return freeDiskBytes(folder, this.deps.launcher.at.platform, this.deps.statfs).catch(() => null);
  }

  /** Whether Ollama or LM Studio is answering now. */
  isUp(runtime: "ollama" | "lm-studio"): Promise<boolean> {
    return runtime === "ollama" ? this.ollama.version().then(Boolean) : this.lmStudio.list().then((list) => list.running, () => false);
  }
  /** Starts Ollama or LM Studio if it is installed and not answering; does not wait. */
  async wake(runtime: "ollama" | "lm-studio"): Promise<void> {
    if (!(await this.isUp(runtime))) await this.deps.launcher.start(runtime);
  }
  /** Starts Ollama or LM Studio when it is installed and not answering, then waits for it. */
  private async ensureRunning(resolved: Resolved, step: (change: Partial<SetupJob>) => unknown): Promise<void> {
    const runtime = resolved.runtime as "ollama" | "lm-studio";
    const up = () => this.isUp(runtime);
    if (await up()) return;
    step({ stage: "starting", message: `Starting ${runtimeInfo[resolved.runtime].name}…` });
    const started = await this.deps.launcher.start(resolved.runtime);
    if (!started.started) throw new Error(started.message);
    await this.waitFor(up, `${runtimeInfo[resolved.runtime].name} did not start within a minute`);
  }
  private async waitFor(check: () => Promise<boolean>, failure: string, seconds = 60): Promise<void> {
    for (let tried = 0; tried < seconds; tried++) {
      if (await check().catch(() => false)) return;
      await this.sleep(1000);
    }
    throw new Error(failure);
  }

  /** Downloads through whichever route the runtime has; returns the local path where there is one. */
  private async fetchModel(resolved: Resolved, signal: AbortSignal, progress: (completed: number, total: number) => void): Promise<string> {
    if (resolved.runtime === "ollama") {
      await this.ollama.pull(resolved.source, (report) => progress(report.completed, report.total), signal);
      return resolved.source;
    }
    if (resolved.runtime === "lm-studio") return this.lmStudioDownload(resolved, signal, progress);
    const folder = modelsFolder(resolved.runtime, this.deps.launcher.at, this.deps.dataDir);
    const join = this.deps.launcher.at.platform === "win32" ? win32.join : posix.join;
    if (resolved.runtime === "llama-cpp") {
      const gguf = resolved.variant?.gguf;
      if (!gguf) throw new Error("llama.cpp needs a model from Branch's list");
      return downloadFile({ url: resolveUrl(gguf.repo, gguf.file), target: join(folder, gguf.file), bytes: gguf.bytes, sha256: gguf.sha256,
        fetch: this.deps.library, signal, onProgress: (p) => progress(p.completed, p.total) });
    }
    return this.mlxDownload(resolved.source, join(folder, resolved.source.replace("/", "--")), signal, progress);
  }
  private async mlxDownload(repo: string, target: string, signal: AbortSignal, progress: (completed: number, total: number) => void): Promise<string> {
    const files = mlxFilesWanted(await repoFiles(repo, this.deps.library));
    if (!files.some((file) => file.path.endsWith(".safetensors"))) throw new Error("That repository has no MLX weights");
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    // Integration review: a typed name has no size ahead, so the disk is checked once the list is known.
    await assertRoomOnDisk(target, total, this.deps.launcher.at.platform, this.deps.statfs);
    const join = this.deps.launcher.at.platform === "win32" ? win32.join : posix.join;
    let before = 0;
    for (const file of files) {
      signal.throwIfAborted();
      await downloadFile({ url: resolveUrl(repo, file.path), target: join(target, file.path), bytes: file.bytes, sha256: file.sha256,
        fetch: this.deps.library, signal, onProgress: (p) => progress(before + p.completed, total) });
      before += file.bytes;
      progress(before, total);
    }
    return target;
  }
  private async lmStudioDownload(resolved: Resolved, signal: AbortSignal, progress: (completed: number, total: number) => void): Promise<string> {
    const quant = resolved.variant?.quant;
    let job = await this.lmStudio.download(resolved.source, quant);
    while (job.status === "downloading" || job.status === "paused") {
      progress(job.downloadedBytes, job.totalBytes);
      if (signal.aborted || !job.jobId) break;
      await this.sleep(2000);
      job = await this.lmStudio.downloadStatus(job.jobId);
    }
    signal.throwIfAborted();
    if (job.status === "failed") throw new Error("LM Studio could not download the model");
    return resolved.source;
  }

  /** Brings the model into memory with its room for words; returns the name the connection uses. */
  private async load(resolved: Resolved, local: string, step: (change: Partial<SetupJob>) => unknown): Promise<string> {
    switch (resolved.runtime) {
      case "ollama": {
        const sized = await this.ollama.sized(local, resolved.context);
        await this.ollama.warm(sized.model, resolved.context);
        return sized.model;
      }
      case "lm-studio": {
        const key = await this.lmStudioKey(resolved);
        return (await this.lmStudio.load(key, resolved.context)).loaded;
      }
      default: {
        step({ stage: "starting", message: `Starting ${runtimeInfo[resolved.runtime].name} with this model…` });
        const started = await this.deps.launcher.start(resolved.runtime, resolved.runtime === "mlx" ? { repo: local, context: resolved.context } : { file: local, context: resolved.context });
        if (!started.started) throw new Error(started.message);
        const base = this.deps.launcher.baseUrl(resolved.runtime);
        if (!base) throw new Error(`${runtimeInfo[resolved.runtime].name} did not start`);
        const server = new OpenAiServerClient(base, localRuntimeFetch(this.deps.policy, this.deps.fetch ?? globalThis.fetch, base));
        await this.waitFor(async () => (await server.models()) !== null, `${runtimeInfo[resolved.runtime].name} did not answer within two minutes`, 120);
        return local;
      }
    }
  }
  /** LM Studio names a downloaded model its own way; find the one that matches what was fetched. */
  private async lmStudioKey(resolved: Resolved): Promise<string> {
    const { models } = await this.lmStudio.list();
    const stem = (resolved.variant?.gguf?.file ?? resolved.source).toLowerCase().replace(/\.gguf$/, "").replace(/[-_.]?(q\d.*|f16|bf16|mxfp4)$/i, "");
    const wanted = stem.split("/").pop()!.replace(/[^a-z0-9]/g, "");
    const match = models.find((model) => model.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(wanted))
      ?? models.find((model) => model.name === resolved.source);
    if (!match) throw new Error("LM Studio finished the download but Branch could not find the model in its list. Load it in LM Studio once.");
    return match.name;
  }

  /* ------------------------------------------- mac7/one-click (issue #107): the one button */

  /**
   * What pressing the button would do, with nothing done yet: the program that would be installed
   * (where from, how big, how it is checked), and a small, a middle and a large model sized for
   * this computer. The owner reads this, then presses again with the plan's own line to agree.
   */
  async buttonPlan(input: unknown, context: PressContext): Promise<OneButtonView> {
    ButtonPlanSchema.parse(input ?? {});
    const refusal = installGuard(this.deps.store, this.deps.owner, context);
    const runner = ((input as { runner?: InstallableRunner } | null)?.runner) ?? await this.pickInstallable();
    const program = await this.deps.launcher.find(runner);
    const room = await this.deps.room();
    const { choices, recommended } = sizeChoices(room, runner);
    // mac7/clean-uninstall: the copy outside Branch is only ever offered when the owner switched
    // "Allow installing outside Branch" on, or where it is the only honest option (LM Studio).
    const wanted = ((input as { systemWide?: boolean } | null)?.systemWide ?? false)
      && systemWideAllowed(this.deps.store, this.deps.owner);
    const plan = program ? null : installPlan(runner, this.deps.launcher.at,
      await detectTools(this.deps.launcher.at, this.deps.launcher.fileExists), this.deps.dataDir, wanted);
    return {
      runner, name: runtimeInfo[runner].name, alreadyInstalled: Boolean(program), install: plan,
      downloadNote: plan ? `${planSize(plan)} from ${plan.source}.` : "",
      // mac7/clean-uninstall: where the download lands and how much of this disk is left for it.
      modelsFolder: await this.modelsGoTo(runner), freeBytes: await this.roomLeft(runner),
      choices, recommended: recommended?.size ?? null, refusal,
    };
  }

  /** The program to offer: one that is installed, else Ollama, which Branch can install everywhere. */
  private async pickInstallable(): Promise<InstallableRunner> {
    for (const id of runtimeIds) if (isInstallable(id) && await this.deps.launcher.find(id)) return id;
    return "ollama";
  }

  /**
   * The button itself. Installs the program when it is missing — only the plan the owner agreed to,
   * and only after saying so — then checks the program really arrived, and hands straight over to
   * the ordinary setup, which downloads the model, loads it, asks it one question and connects it.
   */
  async buttonGo(input: unknown, context: PressContext): Promise<OneButtonAnswer> {
    const wanted = ButtonGoSchema.parse(input ?? {});
    const refusal = installGuard(this.deps.store, this.deps.owner, context);
    if (refusal) throw new Error(refusal);
    const view = await this.buttonPlan({ ...(wanted.runner ? { runner: wanted.runner } : {}), ...(wanted.systemWide ? { systemWide: true } : {}) }, context);
    if (!view.alreadyInstalled) {
      const outcome = await this.install(view.install, wanted);
      if (outcome) return outcome;
    }
    // The owner named the exact model: that one is set up, not a size from Branch's own list.
    if (wanted.name) {
      const job = await this.begin({ runtime: view.runner, name: wanted.name });
      return { done: false, runner: view.runner, message: `Setting up ${wanted.name}…`, chose: null, ...("id" in job ? { job } : { job: null }) };
    }
    const pick = this.pickSize(view.choices, wanted.size);
    if (!pick) throw new Error("Branch's list has no model that fits this computer and can use tools.");
    const job = await this.begin({ runtime: view.runner, model: pick.model, quant: pick.quant, force: pick.fit !== "no" ? false : true });
    return { done: false, runner: view.runner, message: `Setting up ${pick.name} ${pick.quant}…`, chose: pick, ...("id" in job ? { job } : { job: null }) };
  }

  /** Installs the program, or says what is still needed. Null means it is installed and Branch may go on. */
  private async install(plan: InstallPlan | null, wanted: ButtonGo): Promise<OneButtonAnswer | null> {
    if (!plan) throw new Error("Branch could not work out how to install that program on this computer.");
    if (plan.instead) throw new Error(plan.instead);
    if (wanted.agreedPlan !== plan.fingerprint)
      return { done: false, runner: plan.runner, message: wanted.agreedPlan ? planChangedNote : needsAgreementNote(plan.name),
        needsAgreement: plan, job: null, chose: null };
    const outcome = await runInstall(plan, {
      at: this.deps.launcher.at, run: this.deps.launcher.program, exists: this.deps.launcher.fileExists,
      library: this.deps.library, scratchDir: this.installFolder(), dataDir: this.deps.dataDir,
    });
    if (!outcome.installed) throw new Error(outcome.message);
    if (!(await this.deps.launcher.find(plan.runner))) throw new Error(notInstalledNote(plan.name));
    return null;
  }
  private installFolder(): string {
    const join = this.deps.launcher.at.platform === "win32" ? win32.join : posix.join;
    return join(this.deps.dataDir, "local-installers");
  }
  private pickSize(choices: SizeChoice[], size: ButtonGo["size"]): SizeChoice | null {
    if (size) return choices.find((one) => one.size === size) ?? null;
    return [...choices].reverse().find((one) => one.fit === "well") ?? choices[0] ?? null;
  }

  /** Stops a setup that is still going; what was downloaded stays for next time. */
  stop(id: string): { stopped: boolean } {
    const controller = this.running.get(id);
    controller?.abort(new Error("You stopped this setup"));
    return { stopped: Boolean(controller) };
  }

  /** Picks up setups that were still going when Branch closed. Returns how many. */
  async resume(): Promise<number> {
    let count = 0;
    for (const job of this.jobs.unfinished()) {
      if (this.running.has(job.id)) continue;
      try {
        const request = SetupRequestSchema.parse(job.request);
        const resolved = await this.resolve({ ...request, runtime: job.runtime, force: true } as SetupRequest, job.runtime);
        this.jobs.update(job.id, { message: "Carrying on after Branch restarted…" });
        this.launch(job.id, resolved);
        count++;
      } catch (error) {
        this.jobs.update(job.id, { stage: "failed", finishedAt: this.now(), message: errorText(error).slice(0, 400) });
      }
    }
    return count;
  }
  /** Stops every setup, when the app closes. The record stays, so they resume next time. */
  closeAll(): void {
    this.closing = true;
    for (const controller of this.running.values()) controller.abort(new Error("Branch is closing"));
  }
}

function sourceFor(variant: CatalogueVariant, runtime: RuntimeId): string {
  if (runtime === "ollama") return variant.ollama!.tag;
  if (runtime === "mlx") return variant.mlx!.repo;
  return runtime === "lm-studio" ? `https://huggingface.co/${variant.gguf!.repo}` : variant.gguf!.repo;
}
