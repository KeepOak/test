import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ChatScreenEntry } from './screen-entry.js';
import { ScreenAction, ScreenRefusal } from './screen-sessions.js';
import { requestSource, tunnelSource, tunnelMark } from '../auth-limits.js';

const routes = ['targets', 'start', 'frame', 'action', 'control', 'stop'] as const;
const files: Record<string, [string, string]> = {
  '/chat-screen': ['chat-screen.html', 'text/html; charset=utf-8'],
  '/chat-screen.js': ['chat-screen.js', 'text/javascript; charset=utf-8'],
  '/chat-screen.css': ['chat-screen.css', 'text/css; charset=utf-8'],
};
/** Only these page files and dedicated POST endpoints pass through the existing door. */
export function chatScreenDoorPath(method: string, path: string): boolean {
  if (method === 'GET' && Object.hasOwn(files, path)) return true;
  return method === 'POST' && routes.some(route => path === '/api/chat-screen/' + route);
}
const Request = z.object({ request: z.string().uuid(), initData: z.string().min(1).max(8192), pin: z.string().max(64).optional() });
const Key = z.string().regex(/^[\w-]{43}$/);
const Session = z.object({ key: Key });
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org" };
interface HttpParts {
  entry: ChatScreenEntry;
  publicAddress(): string | null;
  readBody(): Promise<unknown>;
  errorText(error: unknown): string;
}
/** This precedes window-key authorization and requires the dedicated tunnel plus purpose-specific body proof. */
export async function handleChatScreen(parts: HttpParts, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  if (!Object.hasOwn(files, path) && !path.startsWith('/api/chat-screen/')) return false;
  const reply = (status: number, value: unknown): void => { response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
  try {
    if (requestSource(request.socket?.remoteAddress, request.headers) !== tunnelSource || request.headers[tunnelMark] !== '1'
      || request.headers['x-forwarded-proto'] !== 'https' || !parts.publicAddress()) throw new ScreenRefusal('Open a fresh screen link through Branch’s secure door.');
    if (!chatScreenDoorPath(request.method ?? 'GET', path)) throw new ScreenRefusal('That screen request is unavailable.');
    const file = files[path];
    if (file) {
      const bytes = await readFile(new URL(`../../public/${file[0]}`, import.meta.url));
      response.writeHead(200, { ...headers, 'content-type': file[1] }); response.end(bytes); return true;
    }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ScreenRefusal('Send this screen request as JSON.');
    reply(200, await dispatch(parts.entry, path, await parts.readBody()));
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : typeof error === 'object' && error && 'status' in error && error.status === 429 ? 429 : 403;
    reply(status, { error: parts.errorText(error) });
  }
  return true;
}
async function dispatch(entry: ChatScreenEntry, path: string, body: unknown): Promise<unknown> {
  if (path === '/api/chat-screen/targets') {
    const input = Request.strict().parse(body);
    return { targets: await entry.targets(input.request, input.initData, input.pin) };
  }
  if (path === '/api/chat-screen/start') {
    const input = Request.extend({ target: z.string().regex(/^[\w-]{32}$/) }).strict().parse(body);
    return entry.start(input.request, input.initData, input.target, input.pin);
  }
  if (path === '/api/chat-screen/frame') {
    const input = Session.extend({ width: z.number().int().min(320).max(1920).default(1280) }).strict().parse(body);
    const frame = await entry.frame(input.key, input.width);
    return { frame: frame.bytes.toString('base64'), type: frame.type, width: frame.width, height: frame.height,
      session: frame.session, control: frame.control, cursor: frame.cursor, inputFrame: frame.inputFrame };
  }
  if (path === '/api/chat-screen/action') {
    const input = Session.extend({ inputFrame: z.string().regex(/^[\w-]{32}$/), action: ScreenAction }).strict().parse(body);
    await entry.action(input.key, input.inputFrame, input.action); return { ok: true };
  }
  if (path === '/api/chat-screen/control') {
    const input = Session.extend({ owner: z.boolean() }).strict().parse(body);
    entry.sessions.control(input.key, input.owner); return { ok: true };
  }
  if (path === '/api/chat-screen/stop') {
    const input = z.union([Session.strict(), Request.omit({ pin: true }).strict()]).parse(body);
    if ('key' in input) entry.sessions.stop(input.key); else entry.sessions.stopLaunch(input.request, input.initData);
    return { stopped: true };
  }
  throw new ScreenRefusal();
}
