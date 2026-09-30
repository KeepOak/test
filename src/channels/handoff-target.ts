import { z } from "zod";

/** Both conversation pointers come from the chooser snapshot; neither is resolved by app kind. */
export const ChatHandoffSchema = z.object({
  channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64),
  sourceSessionId: z.string().uuid(), expectedSessionId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
}).strict();
export interface ChatHandoffTarget {
  channel: string; chatId: string; title: string; sessionId: string; updatedAt: string;
}
export function parseChatHandoff(argument: string): Omit<z.infer<typeof ChatHandoffSchema>, "sourceSessionId"> | null {
  const parts = argument.trim().split(/\s+/);
  if (parts.length !== 4) return null;
  try {
    const [channel, chatId, expectedSessionId, expectedUpdatedAt] = parts.map(decodeURIComponent);
    const parsed = ChatHandoffSchema.omit({ sourceSessionId: true }).safeParse({ channel, chatId, expectedSessionId, expectedUpdatedAt });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
