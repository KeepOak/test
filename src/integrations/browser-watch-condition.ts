import { z } from 'zod';

/** A task waits on one explicit page condition; it never claims an arbitrary visual change or a scheduled watch. */
export const WatchConditionSchema = z.object({
  text: z.string().trim().min(1).max(300),
  state: z.enum(['appears', 'disappears']),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
}).strict();
