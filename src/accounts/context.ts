import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which conversation a model call belongs to. A connection only sees the request, so the runtime
 * marks each call with its conversation, and the account pools read it to honour the account the
 * owner chose for that conversation and to note which account answered.
 */
export interface AccountCall {
  owner: string;
  sessionId: string;
  runId: string;
  /** A maintenance call must use the account that answered, with no account fallback or retry. */
  pinnedAccount?: { pool: string; account: string };
  /**
   * mac7/lockdown-fix: set when the call is a Trunk's (its conversation, a room seat, a routine, or
   * work under them). A sign-in account never answers it, and a key is chosen by the Trunk's own pick.
   */
  trunk?: {
    keys: { copyFromOwner: boolean; accounts: Record<string, string>; next?: Record<string, string[]> | undefined };
    /**
     * trunks-use-subscriptions: true only when the owner is behind this work (the owner's own window, a
     * routine or trigger the owner set up), worked out once where the mark is made (Runtime.trunkSignIns).
     * Absent means false: a household person, another computer, a short-lived key, a chat app or another
     * program never reaches the owner's sign-in through a Trunk.
     */
    signIns?: boolean;
    /** FQ-routing.isolated-agents: which Trunk, so work it sets going (a workflow or flow step) remembers as it. */
    id?: string;
  };
  /** Writes a line on the task's record (never a key or a token). */
  note?: (kind: string, data: Record<string, unknown>) => void;
}
const calls = new AsyncLocalStorage<AccountCall>();

export function withAccountCall<T>(call: AccountCall, work: () => Promise<T>): Promise<T> {
  return calls.run(call, work);
}
export function currentAccountCall(): AccountCall | undefined {
  return calls.getStore();
}

/**
 * trunks-use-subscriptions: what a Trunk's call is told when someone other than the owner is behind it
 * and only a sign-in is left (see trunk-guard.ts). The owner's sign-in is theirs alone: the providers'
 * terms forbid sharing a login with anyone else.
 */
export const trunkSignInRefusal =
  "A Trunk answers through your sign-in accounts only for your own work, not for someone else on this computer, another computer, a chat app or another program, and there is no connection with an API key for it to use. Add a connection with an API key in Settings › Models.";

/** True when this call is a Trunk's and the owner is not behind it, so no sign-in may answer it. */
export function signInRefusedForTrunk(): boolean {
  const trunk = calls.getStore()?.trunk;
  return !!trunk && trunk.signIns !== true;
}

/**
 * Integration review (mac7/lockdown-fix): the last check, inside each connection that answers through
 * somebody's sign-in. A Trunk's work (its turns, the tools and side jobs they start, the workflows and
 * flows it sets going, a mixture's members, keep-alive pings) is marked, and a sign-in refuses it here
 * whichever way the call arrived, unless the owner is behind it (trunks-use-subscriptions).
 */
export function refuseSignInForTrunk(): void {
  if (signInRefusedForTrunk()) throw new Error(trunkSignInRefusal);
}

/** Handing a job to the owner's Claude Code or Codex (src/coding/hand-off.ts) stays the owner's own: no Trunk, ever. */
export const handOffTrunkRefusal = "A Trunk cannot hand a job to your Claude Code or Codex: that works on your folders with your own sign-in.";
export function refuseAnyTrunk(): void {
  if (calls.getStore()?.trunk) throw new Error(handOffTrunkRefusal);
}
