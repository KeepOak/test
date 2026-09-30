import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HttpError, readJsonBody } from './server-http.js';
import { LocalScreen, LocalScreenRefusal, localScreenPaths, type LocalScreenAccess } from './local-screen.js';

const Session = z.string().min(1).max(200), Id = z.string().regex(/^[a-f0-9]{32}$/);
const View = z.object({ sessionId: Session, viewId: Id }).strict();
const Frame = View.extend({ frameId: Id }).strict();
function answer(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Called only after the server's caller policy; the view checks the caller again after every await. */
export async function localScreenHttp(screen: LocalScreen, accessFor: (sessionId: string) => LocalScreenAccess,
  request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://local'), path = url.pathname;
  if (!(localScreenPaths as readonly string[]).includes(path)) return false;
  const life = new AbortController();
  const disconnected = () => { if (!response.writableFinished) life.abort(); };
  response.once('close', disconnected);
  try {
    if (request.method === 'GET') {
      const query = Object.fromEntries(url.searchParams);
      if (path.endsWith('/targets')) {
        const input = z.object({ session: Session }).strict().parse(query);
        answer(response, await screen.targets(accessFor(input.session), life.signal));
      } else if (path === '/api/panels/screen') {
        const input = z.object({ session: Session, view: Id, width: z.coerce.number().int().min(320).max(1280) }).strict().parse(query);
        await screen.stream(accessFor(input.session), input.view, input.width, request, response);
      } else throw new HttpError(405, 'Use POST for this screen action.');
      return true;
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Use GET or POST for this screen action.');
    const body = await readJsonBody(request);
    if (path.endsWith('/target')) {
      const input = z.object({ sessionId: Session, targetId: Id }).strict().parse(body);
      answer(response, await screen.select(accessFor(input.sessionId), input.targetId, life.signal));
    } else await action(screen, accessFor, path, body, response, life.signal);
    return true;
  } catch (error) {
    throw error instanceof LocalScreenRefusal ? new HttpError(error.status, error.message) : error;
  } finally { response.removeListener('close', disconnected); }
}

async function action(screen: LocalScreen, accessFor: (sessionId: string) => LocalScreenAccess,
  path: string, body: unknown, response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (path.endsWith('/stop')) {
    const input = View.parse(body);
    screen.view(accessFor(input.sessionId), input.viewId);
    await screen.close(); answer(response, { stopped: true }); return;
  }
  if (path.endsWith('/painted')) {
    const input = Frame.parse(body);
    answer(response, screen.painted(accessFor(input.sessionId), input.viewId, input.frameId)); return;
  }
  if (path.endsWith('/control')) {
    const input = Frame.extend({ held: z.boolean() }).strict().parse(body);
    answer(response, await screen.control(accessFor(input.sessionId), input.viewId, input.frameId, input.held)); return;
  }
  if (path.endsWith('/input')) {
    const input = Frame.extend({ input: z.unknown() }).strict().parse(body);
    answer(response, await screen.input(accessFor(input.sessionId), input.viewId, input.frameId, input.input, signal)); return;
  }
  throw new HttpError(405, 'This screen route does not accept that action.');
}
