import { errorText } from "./contracts.js";
import { bestRecommendation, readHardware, recommendModels, type Hardware } from "./local-hardware.js";
import {
  LmStudioClient, OllamaClient, lmStudioDownloadPage, localModelName, madeByBranch, ollamaDownloadPage,
  type DownloadProgress, type LocalModel,
} from "./local-models.js";

/**
 * Everything the app knows about models on this computer, in one place: whether Ollama and LM
 * Studio are running, which models are installed, and how far any download has got. Downloads take
 * minutes, far longer than one web request may last, so a download is started and then watched:
 * the screen asks how it is going and gets the latest `model.download.progress` report back.
 */
export interface DownloadState extends DownloadProgress {
  startedAt: string;
  finishedAt: string | null;
}

export class LocalRuntimes {
  readonly ollama: OllamaClient;
  readonly lmStudio: LmStudioClient;
  private readonly downloads = new Map<string, DownloadState>();
  private readonly running = new Map<string, AbortController>();
  private readonly now: () => Date;
  /** The last thing that went wrong, so the health report can say it plainly. */
  lastError: { what: string; when: string } | null = null;
  constructor(options: { ollamaBaseUrl?: string; lmStudioBaseUrl?: string; fetch?: typeof fetch; now?: () => Date } = {}) {
    const call = options.fetch ?? globalThis.fetch;
    this.ollama = new OllamaClient(options.ollamaBaseUrl, call);
    this.lmStudio = new LmStudioClient(options.lmStudioBaseUrl, call);
    this.now = options.now ?? (() => new Date());
  }
  private note(error: unknown): void {
    this.lastError = { what: errorText(error).slice(0, 200), when: this.now().toISOString() };
  }

  /** What is installed on this computer, plus where to get each runtime when it is not there. */
  async inventory(): Promise<{
    ollama: { installed: boolean; version: string | null; models: LocalModel[]; downloadPage: string };
    lmStudio: { running: boolean; models: { name: string; loaded: boolean; contextLength: number | null }[]; downloadPage: string };
  }> {
    let trouble = false;
    const version = await this.ollama.version();
    let models: LocalModel[] = [];
    if (version) {
      // QA Q071: the copies Branch made for itself are not the person's models (see madeByBranch).
      try { models = (await this.ollama.list()).filter((model) => !madeByBranch(model.name)); } catch (error) { this.note(error); trouble = true; }
    }
    const lmStudio = await this.lmStudio.list().catch((error) => { this.note(error); trouble = true; return { running: false, models: [] }; });
    // A problem that has since cleared should not keep the health report red for the rest of the day.
    if (!trouble) this.lastError = null;
    return {
      ollama: { installed: version !== null, version, models, downloadPage: ollamaDownloadPage },
      lmStudio: { ...lmStudio, downloadPage: lmStudioDownloadPage },
    };
  }

  /** What one model is: family, size, how much it can hold, whether it can be shown a picture. */
  details(name: string): Promise<LocalModel> {
    return this.ollama.show(name);
  }

  /** Starts a download and returns at once; progress is read back with `progress()`. */
  start(name: string): DownloadState {
    const model = localModelName.parse(name);
    const already = this.downloads.get(model);
    if (already && !already.finishedAt) return already;
    if (this.downloads.size >= 32) this.forgetFinished();
    const controller = new AbortController();
    const state: DownloadState = {
      event: "model.download.progress", model, status: "starting", completed: 0, total: 0,
      percent: 0, done: false, startedAt: this.now().toISOString(), finishedAt: null,
    };
    this.downloads.set(model, state);
    this.running.set(model, controller);
    void this.watch(model, controller);
    return state;
  }
  private async watch(model: string, controller: AbortController): Promise<void> {
    const record = (progress: DownloadProgress) => {
      const previous = this.downloads.get(model);
      this.downloads.set(model, { ...progress, startedAt: previous?.startedAt ?? this.now().toISOString(), finishedAt: null });
    };
    try {
      await this.ollama.pull(model, record, controller.signal);
      const latest = this.downloads.get(model)!;
      this.downloads.set(model, { ...latest, done: true, percent: 100, finishedAt: this.now().toISOString() });
    } catch (error) {
      this.note(error);
      const latest = this.downloads.get(model);
      this.downloads.set(model, {
        event: "model.download.progress", model, status: "failed", completed: latest?.completed ?? 0,
        total: latest?.total ?? 0, percent: latest?.percent ?? 0, done: true, error: errorText(error).slice(0, 200),
        startedAt: latest?.startedAt ?? this.now().toISOString(), finishedAt: this.now().toISOString(),
      });
    } finally {
      this.running.delete(model);
    }
  }
  /** Every download this session, newest first. */
  progress(): DownloadState[] {
    return [...this.downloads.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  /** Stops a download that is still going. */
  stop(name: string): { stopped: boolean } {
    const controller = this.running.get(localModelName.parse(name));
    controller?.abort(new Error("You stopped this download"));
    return { stopped: Boolean(controller) };
  }
  private forgetFinished(): void {
    for (const [model, state] of this.downloads) if (state.finishedAt) this.downloads.delete(model);
  }
  /** Removes a downloaded model from this computer. */
  async remove(name: string): Promise<{ removed: string }> {
    try { return await this.ollama.remove(name); } catch (error) { this.note(error); throw error; }
  }

  /** This computer's memory, cores and graphics card, with the models it can comfortably run. */
  async recommendations(): Promise<{ hardware: Hardware; models: ReturnType<typeof recommendModels>; suggested: string }> {
    const hardware = await readHardware();
    return { hardware, models: recommendModels(hardware), suggested: bestRecommendation(hardware).model };
  }

  /**
   * The health report's local-runtime section: running, models, last error. `needed` says a connection the owner set up
   * answers from this computer: then nothing running here is a problem, not an option.
   */
  async health(needed = false): Promise<{ ok: boolean; summary: string; fix: string }> {
    const inventory = await this.inventory().catch((error) => { this.note(error); return null; });
    const running = !!inventory && (inventory.ollama.installed || inventory.lmStudio.running);
    if (needed && !running) return { ok: false, summary: "A connection you set up answers from this computer, but no model is running here, so its tasks will fail",
      fix: `Start Ollama or LM Studio, or install Ollama from ${ollamaDownloadPage}.` };
    if (!inventory) return { ok: true, summary: "No model is running on this computer (optional)", fix: `Install Ollama from ${ollamaDownloadPage}.` };
    const parts: string[] = [];
    parts.push(inventory.ollama.installed
      ? `Ollama ${inventory.ollama.version} is running with ${inventory.ollama.models.length} model(s)`
      : "Ollama is not running");
    if (inventory.lmStudio.running) parts.push(`LM Studio is running with ${inventory.lmStudio.models.length} model(s)`);
    const busy = this.progress().filter((download) => !download.finishedAt);
    if (busy.length) parts.push(`${busy.length} download(s) in progress`);
    if (this.lastError) parts.push(`last problem: ${this.lastError.what}`);
    const ok = !inventory.ollama.installed || this.lastError === null;
    return { ok, summary: parts.join("; "), fix: `Open Settings → Models on this computer, or reinstall Ollama from ${ollamaDownloadPage}.` };
  }
}

let shared: LocalRuntimes | null = null;
/** The one the app uses. Tests build their own against a fake server instead. */
export function localRuntimes(): LocalRuntimes {
  return (shared ??= new LocalRuntimes());
}
