import type { Store } from './store.js';

export type RunObserver = (id: string) => () => Promise<void>;
type RequestChannel = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  notify: (notification: { method: 'notifications/progress'; params: {
    progressToken: string | number; progress: number; message: string;
  } }) => Promise<unknown>;
  log: (level: 'info' | 'warning', data: unknown, logger?: string) => Promise<unknown>;
};
const stages = new Set(['tool.started', 'tool.completed', 'tool.failed', 'policy.ask',
  'attention.needed', 'run.paused', 'run.stopped_to_ask', 'run.continued']);

/** Only real events from this request's recorded run; never forwards event payloads. */
export function observeMcpRun(store: Store, request: RequestChannel, allowed: () => boolean): RunObserver {
  let progress = 0, queued = 0, tail = Promise.resolve();
  const token = request._meta?.progressToken;
  const validToken = typeof token === 'string' && token.length <= 128
    || typeof token === 'number' && Number.isFinite(token);
  const publish = (id: string, stage: string) => {
    if (progress >= 256 || queued >= 8 || request.signal.aborted || !allowed()) return;
    const count = ++progress; queued++;
    tail = tail.then(async () => {
      if (request.signal.aborted || !allowed()) return;
      if (validToken) await request.notify({ method: 'notifications/progress',
        params: { progressToken: token!, progress: count, message: stage } });
      if (!request.signal.aborted && allowed()) await request.log(stage === 'tool.failed' ? 'warning' : 'info',
        { runId: id, stage }, 'branch.run');
    }).catch(() => undefined).finally(() => { queued--; });
  };
  return (id) => {
    publish(id, 'run.started');
    const stop = store.onEvent((runId, kind) => {
      if (runId === id && stages.has(kind)) publish(id, kind);
    });
    return async () => {
      stop();
      const run = store.run(id);
      if (run) publish(id, `run.${run.status}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
        void tail.finally(() => { clearTimeout(timer); resolve(); });
      });
    };
  };
}
