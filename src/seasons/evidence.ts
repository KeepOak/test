import type { Run } from "../contracts.js";
import { runOrigin } from "../key-context.js";
import { learningTaskPrefix } from "../skill-authoring.js";
import type { Store } from "../store.js";

/**
 * What Seasons learns from: only requests a person typed themselves. Never a chat app's message (a chat cannot prove
 * who is typing), a short-lived key's, another program's, a schedule's or trigger's, a helper task, a learning pass,
 * a typed command ("/..."), or a temporary conversation. `person` is null for the owner, or a household profile id.
 */
export function typedBy(store: Store, run: Pick<Run, "id" | "prompt" | "sessionId">, person: string | null): boolean {
  if (run.prompt.startsWith(learningTaskPrefix) || run.prompt.trim().startsWith("/") || store.sessionTemporary(run.sessionId)) return false;
  const origin = runOrigin(store, run.id);
  return origin.source === "owner" && !origin.parentRunId && !origin.shortLivedKey && !origin.lentTo && origin.personProfileId === person;
}
