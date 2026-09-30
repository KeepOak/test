import { HttpError } from "../server-http.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Store } from "../store.js";
import type { DesktopControl } from "../integrations/desktop.js";
import { currentCaller } from "../caller.js";
import { currentTaskRun } from "../task-scope.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { signInShowing } from "../sign-in-showing.js";
import { liveScreenRefusal } from "../live-screen.js";
import { NativeWatchSchema } from "./driver.js";
import { portalWindowWatch, PortalWatchSchema } from "./portal.js";
const activeViews = new Set<AbortController>();
let discovering = false;
export function stopNativeViewers(): void { for (const controller of activeViews) controller.abort(); activeViews.clear(); }
export const nativeViewerPrefix = "/api/panels/native-window";
export const NativeViewerSchema = z.discriminatedUnion("source", [NativeWatchSchema.extend({ source: z.literal("native") }), PortalWatchSchema.extend({ source: z.literal("portal"), ownerWindowConsent: z.literal(true) })]);
export interface NativeViewerDeps { store: Store; owner: string; desktop: DesktopControl; viaDoor: boolean; locked(): string | null }
function ownerLocal(deps: NativeViewerDeps): void {
  if (currentCaller().kind !== "owner-here" || currentTaskRun() || startedWithShortLivedKey()) throw new HttpError(403, "Native viewer is confined to the owner app on this computer.");
  const refusal = liveScreenRefusal({ ...deps, profiles: deps.store.profiles }); if (refusal) throw new HttpError(refusal.status, refusal.message);
  if (signInShowing()) throw new Error("Native capture pauses while Branch handles a sign-in.");
}
export async function nativeViewerTargets(deps: NativeViewerDeps): Promise<unknown> {
  ownerLocal(deps); if (discovering || activeViews.size) throw new HttpError(409, "Finish the active native discovery/view first."); discovering = true;
  try { const answer = await deps.desktop.nativeViewerTargets(deps.owner, AbortSignal.timeout(20_000)); ownerLocal(deps); return answer; } finally { discovering = false; }
}
/** No stored grant, artifact, model image or phone action is produced by this local viewer. */
export async function streamNativeViewer(deps: NativeViewerDeps, request: IncomingMessage, response: ServerResponse, input: unknown): Promise<void> {
  ownerLocal(deps); const terms = NativeViewerSchema.parse(input), profile = deps.store.profiles.active()?.id;
  const ready = async () => { if (terms.source === "native") await deps.desktop.nativeViewerReady(deps.owner); else if (!deps.desktop.enabled(deps.owner)) throw new Error("Screen access switched off."); };
  await ready();
  const controller = new AbortController(), signal = controller.signal, authorize = () => { ownerLocal(deps); if (deps.store.profiles.active()?.id !== profile) throw new Error("Viewer profile changed."); signal.throwIfAborted(); };
  if (discovering || activeViews.size) throw new HttpError(409, "Only one owner-native view may run at a time."); activeViews.add(controller);
  const end = () => controller.abort(); response.once("close", end); request.once("aborted", end);
  const watchdog = setInterval(() => { try { authorize(); if (!deps.desktop.enabled(deps.owner)) throw new Error("Screen access switched off."); } catch { end(); } }, 250);
  const timer = setTimeout(end, terms.source === "portal" ? 120_000 : 30_000);
  response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const emit = async (value: unknown) => { authorize(); await ready(); authorize(); await writeLine(response, value, signal); };
  try {
    if (terms.source === "portal") await portalWindowWatch({ frames: terms.frames, intervalMs: terms.intervalMs }, signal, authorize, emit);
    else {
      const { source: _source, ...watch } = terms;
      await emit({ kind: "grant", target: watch.target, exclude: watch.exclude, source: "native" });
      for (let index = 0; index < watch.frames; index++) {
        authorize(); const frame = await deps.desktop.nativeViewerFrame(deps.owner, watch, signal); authorize();
        await emit({ kind: "frame", ...frame }); if (index + 1 < watch.frames) await pause(watch.intervalMs, signal);
      }
      await emit({ kind: "end" });
    }
  } catch (error) { if (!signal.aborted && !response.destroyed) await writeLine(response, { kind: "error", message: String(error).slice(0, 1000) }, signal).catch(() => undefined); }
  finally { activeViews.delete(controller); clearInterval(watchdog); clearTimeout(timer); end(); response.off("close", end); request.off("aborted", end); response.end(); }
}
async function writeLine(response: ServerResponse, value: unknown, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); if (response.destroyed) throw new Error("Viewer disconnected.");
  if (response.write(JSON.stringify(value) + "\n")) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { response.off("drain", done); response.off("close", stop); signal.removeEventListener("abort", stop); };
    const done = () => { cleanup(); resolve(); }, stop = () => { cleanup(); reject(new Error("Viewer stopped.")); };
    response.once("drain", done); response.once("close", stop); signal.addEventListener("abort", stop, { once: true });
  });
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(); };
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(new Error("Viewer stopped.")); };
    const timer = setTimeout(finish, ms); signal.addEventListener("abort", stop, { once: true });
  });
}