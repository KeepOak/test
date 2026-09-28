import type { Message, ToolCall } from "./contracts.js";

/**
 * What a call with no result was, for a task that stopped to ask the person: it never ran (Dogfood F8), and the answer
 * decides whether it runs. Written as "side effects may have occurred", the record contradicted the note that tells the model
 * how the person answered (runtime continueNote), and a local model read it as a failure (QA retest 2026-09-28, M2). What
 * to do next is said by that note alone: a yes to a request, a reply to a question (a push to a shared branch is sent
 * again with confirmed), or a no.
 */
const waitingOnAnswer = JSON.stringify({
  ok: false,
  status: "waiting",
  outcome: "not_run",
  error: "Not run: the task stopped to ask the person before this call ran. Carry on from their answer.",
});
/** The question the model itself put to the person (user.ask): asked, and the answer is their next message. */
const askedThePerson = JSON.stringify({ ok: true, status: "asked", note: "Asked. The person's next message in this conversation is their answer." });

/** Fill interrupted protocol gaps with uncertainty, without executing any tool. */
export function reconcileTranscript(messages: Message[], reason: string) {
  const repaired: Message[] = [];
  let pending: ToolCall[] = [];
  let added = 0;
  const flush = () => {
    for (const call of pending) {
      repaired.push({
        role: "tool",
        toolCallId: call.id,
        content: reason === "needs_input" ? (call.name === "user.ask" ? askedThePerson : waitingOnAnswer) : JSON.stringify({
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
