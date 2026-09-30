/**
 * UP-SCREEN-001: WebSockets opened by a page's background workers.
 *
 * Playwright's socket route (browser-session.ts `answerSocket`) is put into frames only, so a dedicated worker opens
 * its sockets where no route sees them: measured, a worker a page made from a blob reached a website off the list.
 * Holding a worker at start-up over the debugging protocol loses a race with Playwright, which lets it go first
 * (measured, about one run in six), so the guard goes in before the worker's own code instead, in the page itself.
 *
 * This runs in every frame before the page's scripts. It replaces `Worker`, fixed in place, with one that puts this
 * same guard at the top of any worker made from a blob or a data: address, read at once so a revoked address still
 * works. A worker from an address is the website's own file (browsers allow only the page's own website there), so it
 * is left as it is. Inside a worker the guard gives `WebSocket` a check against `allowed` (http(s) origins) and does
 * the same for the worker's own workers. A worker whose words cannot be read is refused rather than started unchecked.
 *
 * It is serialised on its own into the page, so it uses nothing from outside itself.
 */
export function branchWorkerGuard(allowed: string[]): void {
  const scope = globalThis as any;
  if (scope.__branchWorkerGuard) return;
  Object.defineProperty(scope, '__branchWorkerGuard', { value: true, writable: false, configurable: false });
  const source = `(${branchWorkerGuard.toString()})(${JSON.stringify(allowed)});\n`;
  const fix = (owner: object, name: string, value: unknown): void => {
    Object.defineProperty(owner, name, { value, writable: false, configurable: false });
  };
  if (typeof scope.WorkerGlobalScope === 'function' && scope instanceof scope.WorkerGlobalScope && typeof scope.WebSocket === 'function') {
    const Native = scope.WebSocket, list = new Set(allowed);
    const originOf = (address: URL): string =>
      `${address.protocol === 'wss:' ? 'https:' : address.protocol === 'ws:' ? 'http:' : address.protocol}//${address.host}`;
    const Guarded: any = new Proxy(Native, { construct(target, args, newTarget) {
      const at = originOf(new URL(String(args[0]), scope.location.href));
      if (!list.has(at)) throw new DOMException(`Branch refused this WebSocket from a background worker: ${at} is not an allowed website`, 'SecurityError');
      return Reflect.construct(target, args, newTarget === Guarded ? target : newTarget);
    } });
    fix(Native.prototype, 'constructor', Guarded);
    fix(scope, 'WebSocket', Guarded);
  }
  const NativeWorker = scope.Worker;
  if (typeof NativeWorker !== 'function') return;
  // The page's own blobs by address, so a worker's code can be put behind the guard without reading it (a strict page
  // policy may forbid reading a blob) and after the page has let the address go.
  const blobs = new Map<string, Blob>(), makeUrl = scope.URL.createObjectURL, dropUrl = scope.URL.revokeObjectURL;
  fix(scope.URL, 'createObjectURL', function createObjectURL(this: unknown, object: unknown) {
    const address = makeUrl.call(scope.URL, object);
    if (object instanceof scope.Blob) blobs.set(address, object as Blob);
    return address;
  });
  fix(scope.URL, 'revokeObjectURL', function revokeObjectURL(this: unknown, address: string) {
    blobs.delete(String(address));
    return dropUrl.call(scope.URL, address);
  });
  const blobOf = (address: string): Blob => new scope.Blob([contents(address)], { type: 'text/javascript' });
  const contents = (address: string): string => {
    const data = /^data:([^,]*),(.*)$/is.exec(address);
    if (data) return /;base64$/i.test(data[1]!) ? scope.atob(data[2]) : decodeURIComponent(data[2]!);
    const request = new scope.XMLHttpRequest();
    request.open('GET', address, false);
    request.send();
    if (request.status !== 200 && request.status !== 0) throw new Error('unreadable');
    return String(request.responseText);
  };
  const toUrl = (blob: Blob): string => makeUrl.call(scope.URL, blob);
  /**
   * A classic worker: the guard, then its code. Its words are read when they can be, so a "use strict" at the top stays
   * first; otherwise the page's own blob is joined behind the guard unread. A module worker imports the guard before
   * its own code, so the guard runs before anything the code imports; a page policy that forbids that stops the worker.
   */
  const guardedWorker = (address: string, module: boolean): string => {
    const known = blobs.get(address);
    if (module) {
      const inner = toUrl(known ?? blobOf(address));
      const guard = `data:text/javascript,${encodeURIComponent(source)}`;
      const lines = [`import ${JSON.stringify(guard)};`, `import ${JSON.stringify(inner)};`, ''];
      return toUrl(new scope.Blob([lines.join('\n')], { type: 'text/javascript' }));
    }
    let text: string | null = null;
    try { text = contents(address); } catch { if (!known) throw new Error('unreadable'); }
    if (text === null) return toUrl(new scope.Blob([source, known!], { type: 'text/javascript' }));
    const strict = /^\s*(['"])use strict\1\s*;?/.exec(text);
    const body = strict ? [strict[0], `${source}${text.slice(strict[0].length)}`].join('\n') : `${source}${text}`;
    // A data: worker stays a data: worker, so it keeps the empty origin it would have had.
    return /^data:/i.test(address) ? `data:text/javascript,${encodeURIComponent(body)}` : toUrl(new scope.Blob([body], { type: 'text/javascript' }));
  };
  const Wrapped: any = new Proxy(NativeWorker, { construct(target, args, newTarget) {
    const address = String(args[0]), made = [...args];
    if (/^(blob|data):/i.test(address)) {
      try { made[0] = guardedWorker(address, (args[1] as { type?: string } | undefined)?.type === 'module'); } catch {
        throw new DOMException('Branch could not check this background worker, so it was not started', 'SecurityError');
      }
    }
    return Reflect.construct(target, made, newTarget === Wrapped ? target : newTarget);
  } });
  fix(NativeWorker.prototype, 'constructor', Wrapped);
  fix(scope, 'Worker', Wrapped);
}
