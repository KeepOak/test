import type { Message, ToolCall } from "./contracts.js";

/**
 * Fill interrupted protocol gaps with uncertainty, without executing any tool. `known` gives the result for a call
 * whose outcome is known after all (the call a task stopped on to ask the person, which never ran): the model is told
 * what really happened rather than that side effects may have occurred.
 */
export function reconcileTranscript(messages: Message[], reason: string, known: ReadonlyMap<string, string> = new Map()) {
  const repaired: Message[] = [];
  let pending: ToolCall[] = [];
  let added = 0;
  const flush = () => {
    for (const call of pending) {
      const said = known.get(call.id);
      repaired.push({
        role: "tool",
        toolCallId: call.id,
        content: said ?? JSON.stringify({
          ok: false,
          status: "interrupted",
          outcome: "unknown",
          error: `No durable tool result was recorded (${reason}). Side effects may have occurred. Check actual state before retrying.`,
        }),
      });
      added++;
    }
    pending = [];
  };
  for (const message of messages) {
    if (message.role === "tool") {
      pending = pending.filter((call) => call.id !== message.toolCallId);
    } else {
      flush();
      if (message.role === "assistant")
        pending = [...(message.toolCalls ?? [])];
    }
    repaired.push(message);
  }
  flush();
  return { messages: repaired, added };
}
