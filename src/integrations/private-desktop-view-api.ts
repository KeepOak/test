import { z } from 'zod';
import type { PrivateDesktopViews } from './private-desktop-views.js';

const Open = z.object({conversation: z.string().uuid(), agent: z.string().uuid(), control: z.boolean().default(false)}).strict();
const Revoke = z.object({id: z.string().uuid()}).strict();
export function privateDesktopViewApi(views: PrivateDesktopViews, method: string, input: unknown): unknown {
  if (method === 'POST') { const body = Open.parse(input); return views.open(body.conversation, body.agent, body.control); }
  if (method === 'DELETE') { views.revoke(Revoke.parse(input).id); return {revoked: true}; }
  throw new Error('Use POST to open a private view, or DELETE to revoke it.');
}
