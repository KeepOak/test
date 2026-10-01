import { randomUUID } from 'node:crypto';
import type { Page, Request } from 'playwright';
import { z } from 'zod';

export const NetworkCaptureSchema = z.object({
  origin: z.string().url().max(250), path: z.string().regex(/^\/[A-Za-z0-9/_.,~-]*$/).max(200),
  method: z.enum(['GET', 'POST']), seconds: z.number().int().min(5).max(120).default(30),
}).strict();
export type NetworkCaptureOptions = z.infer<typeof NetworkCaptureSchema>;
export interface CapturedRequestShape {
  id: string; origin: string; path: string; method: 'GET' | 'POST'; query: string[]; body: string[];
  needsCredentials: boolean; unsupported: string | null;
}
const field = /^[a-z][a-z0-9_]{0,30}$/;
const sensitive = /pass|secret|token|auth|cookie|session|csrf|xsrf|otp|code|key|credential|signature|jwt|nonce/i;
const fieldNames = (names: string[]): string[] => names.filter(name => field.test(name) && !sensitive.test(name));

/** No request or response values or headers are retained. Each value must be supplied afresh at test time. */
export function requestShape(request: Request, options: NetworkCaptureOptions): CapturedRequestShape | null {
  const url = new URL(request.url());
  if (!['fetch', 'xhr'].includes(request.resourceType()) || url.origin !== options.origin || url.pathname !== options.path
    || request.method() !== options.method) return null;
  const query = [...url.searchParams.keys()], headers = request.headers();
  const body = bodyShape(request, headers['content-type'] ?? '');
  const queryUnsupported = new Set(query).size !== query.length || fieldNames(query).length !== query.length;
  return { id: randomUUID(), origin: options.origin, path: options.path, method: options.method,
    query: fieldNames(query).slice(0, 20), body: body.names,
    needsCredentials: ['authorization', 'cookie', 'x-api-key'].some(name => !!headers[name]),
    unsupported: queryUnsupported ? 'Sensitive, repeated or unsupported query fields are omitted; this request cannot become a skill.' : body.unsupported };
}
function bodyShape(request: Request, contentType: string): { names: string[]; unsupported: string | null } {
  if (request.method() === 'GET') return { names: [], unsupported: null };
  const raw = request.postData();
  if (!raw || Buffer.byteLength(raw) > 8192 || !contentType.toLowerCase().startsWith('application/json'))
    return { names: [], unsupported: 'Only JSON POST bodies smaller than 8 KB are supported.' };
  try {
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    const entries = Object.entries(body), names = fieldNames(entries.map(([name]) => name));
    if (entries.length > 20 || names.length !== entries.length || entries.some(([, value]) => typeof value !== 'string')) throw new Error();
    return { names, unsupported: null };
  } catch { return { names: [], unsupported: 'Nested, non-string or sensitive body fields are unsupported and were omitted.' }; }
}

/** A short, selected-tab observation. Revoked controls, closed pages and expiry all detach the listener. */
export class BrowserNetworkCapture {
  private records: CapturedRequestShape[] = [];
  private active = true;
  private timer: ReturnType<typeof setTimeout>;
  private readonly heard: (request: Request) => void;
  private readonly closed = () => this.stop();
  constructor(private readonly page: Page, readonly options: NetworkCaptureOptions, private readonly authorize: () => void) {
    authorize();
    if (!/^https?:/.test(options.origin) || new URL(options.origin).origin !== options.origin) throw new Error('Choose an HTTP origin without a path or credentials.');
    this.heard = request => this.capture(request);
    page.on('request', this.heard); page.once('close', this.closed);
    this.timer = setTimeout(() => this.stop(), options.seconds * 1000); this.timer.unref?.();
  }
  private capture(request: Request): void {
    if (!this.active) return;
    try {
      this.authorize();
      if (request.frame() !== this.page.mainFrame()) return;
      const shape = requestShape(request, this.options);
      if (shape && this.records.length < 20) this.records.push(shape);
      if (this.records.length >= 20) this.stop();
    } catch { this.stop(); }
  }
  view() { this.authorize(); return { active: this.active, requests: structuredClone(this.records) }; }
  isActive(): boolean { return this.active; }
  stop(): void {
    this.active = false; clearTimeout(this.timer); this.page.off('request', this.heard); this.page.off('close', this.closed);
  }
}
