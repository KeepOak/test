import type { BranchBrowser } from "./integrations/browser.js";
import type { BrowserControl } from "./browser-control.js";
import { lockedDown } from "./lockdown.js";
import type { Store } from "./store.js";

/**
 * Take over and Hand back of one running task's browser from outside Branch's window: a chat's buttons
 * (src/channels/router.ts) and the Telegram Mini App (src/miniapp/api.ts). Taking over makes the task's own window the
 * conversation's kept browser with the owner holding it, exactly as the window's Take over does, so the task waits at
 * its next browser step (at most ten minutes: browser-control.ts agentTurn); Hand back lets it carry on.
 */
export type BrowserHolder = "owner" | "task" | "none";
export interface BrowserHoldDeps {
  browser: BranchBrowser | null | undefined;
  store: Store;
  owner: string;
  locked: () => boolean;
  running: (runId: string) => boolean;
}

/** Who holds the task's browser now: the owner (taken over, or the task paused for them), the task, or nobody. */
export function browserHolder(control: BrowserControl | null): BrowserHolder {
  const view = control?.view();
  return !view || view.state === "stopped" ? "none" : view.writer?.kind === "owner" || view.paused ? "owner" : "task";
}

/** The kept browser of the task's conversation, or null. */
export function taskBrowser(deps: BrowserHoldDeps, runId: string): BrowserControl | null {
  const run = deps.store.run(runId);
  return deps.browser && run?.sessionId ? deps.browser.controls.forConversation(deps.owner, run.sessionId) : null;
}

/**
 * `clientId` is who holds it while taken over. Handing back is refused while somebody else holds it (Branch's own
 * window, say), unless `mayRelease` says that holder is one of the caller's own.
 */
export async function holdTaskBrowser(deps: BrowserHoldDeps, runId: string, op: "take" | "give" | "held", clientId: string,
  mayRelease: (holder: string) => boolean = (holder) => holder === clientId): Promise<BrowserHolder> {
  const browser = deps.browser, run = deps.store.run(runId);
  if (!browser || !run?.sessionId) throw new Error("That task has no browser open.");
  let control = taskBrowser(deps, runId);
  if (op === "held") return browserHolder(control);
  if (lockedDown(deps.store, deps.owner) || deps.locked()) throw new Error("Branch is locked, so its browser can't change hands now.");
  if (op === "take") {
    if (!deps.running(runId)) throw new Error("That task has finished.");
    control ??= await browser.adoptRun(deps.owner, run.sessionId, runId, clientId);
    const view = control.view();
    if (view.writer?.kind !== "owner" || view.writer.id !== clientId) {
      if (view.writer?.kind === "owner" && !mayRelease(view.writer.id))
        throw new Error("You're driving the browser in Branch's window; hand it back there.");
      await control.takeOver(view.epoch, clientId);
    }
    return browserHolder(control);
  }
  if (!control) return "none";
  const view = control.view(), task = view.paused ?? view.waiting ?? runId;
  if (view.writer?.kind === "owner" && !mayRelease(view.writer.id))
    throw new Error("You're driving the browser in Branch's window; hand it back there.");
  await control.handBack(view.epoch, view.writer?.kind === "owner" ? view.writer.id : clientId, task);
  return browserHolder(control);
}
