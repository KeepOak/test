import type { ToolRegistry } from './registry.js';
import type { Runtime } from './runtime.js';
import { AdaptAnswerInput } from './answer-adapters.js';

/** Ordinary helper permission, the initiating task's budget, and no new provider connection. */
export function registerAnswerAdapters(registry: ToolRegistry, runtime: Runtime): void {
  registry.register({
    name: 'answers.adapt', permission: 'specialists.use',
    description: 'Ask this task’s model for typed chat, JSON or XML output. Declare primitive or nested object fields (objects require fields), primitive/object arrays, optional and nullable flags, and optional typed demonstrations. Uses the task budget with no tools; at most one formatting repair.',
    parameters: AdaptAnswerInput,
    execute: (input, context) => runtime.adapted(context, input),
  });
}
