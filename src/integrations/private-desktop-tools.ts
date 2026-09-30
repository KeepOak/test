import { z } from 'zod';
import type { ToolContext } from '../contracts.js';
import type { ToolRegistry } from '../registry.js';
import type { PrivateDesktops } from './private-desktops.js';

const agentOf = (context: ToolContext): string => {
  if (!context.trunk) throw new Error('Private computer tools require a named Trunk context; an agent cannot choose another Trunk’s computer.');
  return context.trunk;
};
const Action = z.discriminatedUnion('type', [
  z.object({type: z.literal('open'), app: z.string().trim().min(1).max(100).regex(/^[a-z0-9 ._-]+$/i)}).strict(),
  z.object({type: z.literal('type'), text: z.string().min(1).max(4000)}).strict(),
  z.object({type: z.literal('key'), chord: z.string().trim().min(1).max(60)}).strict(),
]);

export function registerPrivateDesktops(registry: ToolRegistry, desktops: PrivateDesktops): void {
  registry.register({name: 'desktop.private.start', permission: 'desktop.control', group: 'settings',
    description: 'Start your own private Linux desktop only after the owner enabled it for this Trunk. Never pulls an image or shares host files. Returns status, not viewer credentials.',
    parameters: z.object({}).strict(), execute: (_input, context) => desktops.start(context.owner, agentOf(context))});
  registry.register({name: 'desktop.private.act', permission: 'desktop.control',
    description: 'Open a program, type, or press a key in your own private computer. Refused while the owner has taken over. Cannot target another Trunk’s computer.',
    parameters: Action, execute: (input, context) => desktops.act(context.owner, agentOf(context), input)});
  registry.register({name: 'desktop.private.stop', permission: 'desktop.control',
    description: 'Stop your own private computer. Unsnapshotted filesystem changes are discarded. Refused while the owner holds it.',
    parameters: z.object({}).strict(), execute: async (_input, context) => {
      await desktops.stop(context.owner, agentOf(context)); return {stopped: true};
    }});
}
