import type { Message } from "../contracts.js";
import { isCommandTool, type PolicyResource } from "../policy-resources.js";
import type { Store } from "../store.js";
import { needsCode } from "./code-approvals.js";
import { findingSentence, scanCommand, tightenForFindings, type Decision } from "./command-scan.js";
import { stopRefusal } from "./emergency-stop.js";
import { repairHistory } from "./history-repair.js";
import { safetyMode } from "./settings.js";

/**
 * mac7/r17-g: the few places the rest of Branch calls into the safety extras. Each one is a single
 * marked line where it is called, and each one can only make things stricter (or, for the history,
 * only change the copy that is sent). With every part off, each returns its input untouched.
 */
type Reader = Pick<Store, "get">;
export interface CallAbout { tool: string; permission: string; resource: PolicyResource | null; source: string }
/** `exact`: only a yes given for these very bytes counts. `code`: that yes needs an authenticator code. */
export interface Tightened { decision: Decision; reason: string | null; note: string | null; exact: boolean; code: boolean }

/**
 * Called by `Runtime.checkPolicy` on the rules' answer, before an earlier yes is looked up:
 *  - the emergency stop refuses;
 *  - a command carrying hidden codes is refused, one with look-alike letters or a piped download
 *    is asked about ("when needed": only commands the rules would have run without asking);
 *  - a tool whose yes needs an authenticator code is asked about, and only a yes given for these
 *    very bytes counts (`exact`).
 */
export function tightenCheck(store: Reader, owner: string, call: CallAbout, decision: Decision): Tightened {
  const stopped = stopRefusal(store, owner, call.tool, call.permission, call.resource);
  if (stopped) return { decision: "deny", reason: stopped, note: null, exact: false, code: false };
  let result: Tightened = { decision, reason: null, note: null, exact: false, code: false };
  const scan = safetyMode(store, owner, "command-scan");
  // Owner ruling 2026-09-30: a program on another computer is read too, as Hermes Agent reads its SSH backend's commands.
  if (scan !== "off" && decision !== "deny" && (isCommandTool(call.tool) || call.tool === "remote.run") && call.resource?.kind === "command"
    && (scan === "on" || decision === "allow")) {
    const findings = scanCommand(call.resource.value);
    const tightened = tightenForFindings(decision, findings);
    if (findings.length) {
      const sentence = findingSentence(findings);
      // Integration review: a finding is asked about afresh; only a yes for these very bytes stands in for it.
      result = tightened === "deny" ? { ...result, reason: sentence } : { ...result, note: sentence, exact: tightened === "ask" };
      result.decision = tightened;
    }
  }
  if (result.decision !== "deny" && needsCode(store, owner, call.tool, call.source))
    return { ...result, decision: "ask", exact: true, code: true, note: [result.note, "needs the code from your authenticator app"].filter(Boolean).join("; ") };
  return result;
}

/** Called by `Runtime.complete` on the copy it is about to send. */
export function repairForSending(store: Store, owner: string, runId: string, messages: Message[]): Message[] {
  const mode = safetyMode(store, owner, "history-repair");
  if (mode === "off") return messages;
  const { messages: repaired, fixes } = repairHistory(messages, mode === "on" ? "full" : "needed");
  if (fixes.length) {
    try { store.event(runId, "history.repaired", { fixes: [...new Set(fixes)].slice(0, 20) }); } catch { /* a note never fails a round */ }
  }
  return repaired;
}

/** An answer without its tool calls, for keeping what was said when the task stops before they run; null when it said nothing. */
export function wordsOnly(message: Message): Message | null {
  return message.content.trim() ? { role: "assistant", content: message.content } : null;
}

export { forgetProgress, watchProgress } from "./progress-judge.js";
export { guardApproval, confirmWithCode } from "./code-approvals.js";
export { assertAddressNotStopped } from "./emergency-stop.js";
