import { z } from 'zod';
import type { PrivateDesktops } from './private-desktops.js';
import { LinuxDesktopSchema } from './linux-desktop.js';

const Input = z.discriminatedUnion('operation', [
  z.object({operation: z.literal('create'), agent: z.string().min(1).max(100), image: LinuxDesktopSchema.shape.image}).strict(),
  z.object({operation: z.enum(['start', 'stop', 'snapshot', 'takeOver', 'handBack', 'viewerInfo']), agent: z.string().min(1).max(100)}).strict(),
  z.object({operation: z.enum(['restore', 'removeSnapshot']), agent: z.string().min(1).max(100), snapshot: z.string().uuid()}).strict(),
]);

export async function privateDesktopApi(desktops: PrivateDesktops, owner: string, method: string, input?: unknown): Promise<unknown> {
  if (method === 'GET') return {desktops: await desktops.view(owner)};
  if (method !== 'POST') throw new Error('Use GET or POST for private computers.');
  const body = Input.parse(input);
  if (body.operation === 'create') return desktops.create(owner, body.agent, body.image);
  if (body.operation === 'start') return desktops.start(owner, body.agent, true);
  if (body.operation === 'stop') { await desktops.stop(owner, body.agent, true); return {stopped: true}; }
  if (body.operation === 'snapshot') return desktops.snapshot(owner, body.agent);
  if (body.operation === 'restore') return desktops.restore(owner, body.agent, body.snapshot);
  if (body.operation === 'removeSnapshot') { await desktops.removeSnapshot(owner, body.agent, body.snapshot); return {removed: true}; }
  return desktops.control(owner, body.agent, body.operation);
}
