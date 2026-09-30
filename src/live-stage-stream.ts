import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { liveStage, type LiveStage, type LiveStageDeps } from './live-stage.js';

const active = new Set<string>();
const MAX_LINE = 2 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
type Wake = { close(): Promise<void>; current(): boolean };

/** No queued frames: a slow consumer must drain within three seconds or the connection ends. */
async function send(response: ServerResponse, value: LiveStage, signal: AbortSignal, remaining: number): Promise<number> {
  let line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > MAX_LINE && value.browser) {
    line = JSON.stringify({ ...value, browser: { ...value.browser, frame: null, preview: 'unavailable' } }) + '\n';
  }
  const bytes = Buffer.byteLength(line);
  if (signal.aborted || bytes > MAX_LINE || bytes > remaining || response.writableLength > MAX_LINE) throw new Error('Stream unavailable');
  if (!response.write(line)) await new Promise<void>((resolve, reject) => {
    const done = (): void => { clean(); resolve(); }, failed = (): void => { clean(); reject(new Error('Stream ended')); };
    const timer = setTimeout(failed, 3000);
    const clean = (): void => { clearTimeout(timer); response.off('drain', done); signal.removeEventListener('abort', failed); };
    response.once('drain', done); signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted) failed();
  });
  return bytes;
}

/** Authenticated task view: paint wakes request separately masked frames, at most five per second. */
export async function streamLiveStage(deps: LiveStageDeps, session: string, response: ServerResponse,
  readable: () => boolean): Promise<void> {
  const scope = deps.profiles.scope(), key = JSON.stringify([scope, session]);
  if (active.size >= 4 || active.has(key)) throw new Error('A live view is already open or the live-view limit was reached.');
  active.add(key);
  const stop = new AbortController(), signal = stop.signal, closed = (): void => { stop.abort(); };
  response.once('close', closed);
  let wake: Wake | null = null, boundRun: string | null = null, dirty = true, total = 0, last = 0, lastSent = 0, sent = '', retryPaintAt = 0;
  const current = () => !signal.aborted && !response.destroyed && !response.writableEnded && readable() && deps.profiles.scope() === scope;
  const until = Date.now() + 30_000;
  try {
    if (!current()) return;
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' });
    response.flushHeaders();
    while (current() && Date.now() < until && total < MAX_TOTAL) {
      const run = deps.store.runs(scope).find(one => one.sessionId === session);
      const runId = run && ['running', 'needs_input'].includes(run.status) ? run.id : null;
      if (boundRun !== runId || (wake && !wake.current())) {
        await wake?.close(); wake = null; boundRun = runId; dirty = true; retryPaintAt = 0;
      }
      if (!wake && runId && deps.browser?.paintWake && Date.now() >= retryPaintAt) {
        wake = await deps.browser.paintWake(deps.owner, runId, signal, () => { dirty = true; }, current); retryPaintAt = Date.now() + 5000;
      }
      if (!current()) break;
      if (dirty || Date.now() - last >= (wake ? 1000 : 500)) {
        dirty = false; const view = await liveStage(deps, session);
        if (!current()) break;
        if (wake && !wake.current()) { dirty = true; await delay(200, undefined, { signal }); continue; }
        const newest = deps.store.runs(scope).find(one => one.sessionId === session);
        if (view.browser && newest?.id !== view.browser.runId) { dirty = true; await delay(200, undefined, { signal }); continue; }
        if (view.browser && newest && !['running', 'needs_input'].includes(newest.status)) view.browser.live = false;
        const mark = JSON.stringify({ ...view, browser: view.browser ? { ...view.browser, at: '' } : null });
        if (mark !== sent || Date.now() - lastSent >= 5000) {
          total += await send(response, view, signal, MAX_TOTAL - total); sent = mark; lastSent = Date.now();
        }
        last = Date.now();
      }
      await delay(200, undefined, { signal });
    }
  } catch { /* No page errors or stale frame details leave this connection. The client falls back to ordinary reads. */ }
  finally { stop.abort(); await wake?.close(); response.off('close', closed); active.delete(key); response.end(); }
}
