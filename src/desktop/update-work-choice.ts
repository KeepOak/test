import type { UpdateChannel } from "./updater.js";

export interface WaitingUpdate { tag: string; channel: UpdateChannel; confirmed: string | null }
interface QueueState { tag: string | null; channel: UpdateChannel; busyTasks: number; installing: boolean }
export interface UpdateQueueOptions {
  state: () => Promise<QueueState>;
  install: (request: WaitingUpdate) => Promise<void>;
  cancelled: (words: string) => void;
  failed: (words: string) => void;
}

/** A session-scoped owner request, pinned to a release and channel. It never silently follows a newer release. */
export class OwnerUpdateQueue {
  private request: WaitingUpdate | null = null;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private lastProblem = "";
  constructor(private readonly options: UpdateQueueOptions) {}
  get pending(): boolean { return this.request !== null; }
  start(request: WaitingUpdate): void {
    this.stop();
    this.request = request;
    this.lastProblem = "";
    this.schedule(this.generation);
  }
  stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.request = null;
  }
  private schedule(generation: number): void {
    this.timer = setTimeout(() => { this.timer = null; void this.look(generation); }, 10_000);
  }
  private async look(generation: number): Promise<void> {
    const request = this.request;
    if (!request || generation !== this.generation) return;
    try {
      const state = await this.options.state();
      if (generation !== this.generation) return;
      this.lastProblem = "";
      if (state.tag !== request.tag || state.channel !== request.channel) {
        this.stop(); this.options.cancelled("The waiting update was cancelled because its release or channel changed."); return;
      }
      if (!state.installing && state.busyTasks === 0) {
        this.stop();
        await this.options.install(request);
        return;
      }
    } catch (error) {
      const words = `The waiting update could not check or install: ${error instanceof Error ? error.message : String(error)}`;
      if (words !== this.lastProblem) { this.lastProblem = words; this.options.failed(words); }
    }
    if (generation === this.generation && this.request) this.schedule(generation);
  }
}

/** Plain wording from the authenticated engine's task count, rather than a renderer's estimate. */
export function updateWorkQuestion(count: number, queued: boolean) {
  return { type: "question" as const, title: "Install the update?",
    message: queued ? "An update is waiting for your tasks." : count === 1 ? "A task is still working or waiting for your answer." : `${count} tasks are working or waiting for your answer.`,
    detail: "Let them finish first keeps this update waiting. Install now uses the checked handover so work can carry on; a copy without this support refuses Install now.",
    buttons: ["Let them finish first", "Install now", "Cancel update"], defaultId: 0, cancelId: 2 };
}
