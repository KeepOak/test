import type { ToolContext } from "./contracts.js";

/**
 * Helper lifecycle: which live task started which, so a stop reaches every helper a task started and theirs; how many
 * background helpers one conversation has working at once; and what a helper is not given unless its lead says so.
 *
 * The shape follows, rewritten for Branch (no code copied):
 * - Hermes Agent (https://github.com/NousResearch/hermes-agent, commit a9a5424, MIT): tools/delegate_tool_child_run.py
 *   :64-79 (a child is registered with its parent, and one attached after the parent's stop landed is stopped at once),
 *   tools/delegate_tool_config.py:121-130 (at capacity a background hand-off is refused, not queued) and
 *   tools/delegate_tool_toolsets.py:14-22 (what a child never has: more hand-offs, asking the user, sending messages,
 *   scheduling more work).
 * - OpenClaw (https://github.com/openclaw/openclaw, commit 1794d8b4, MIT): src/agents/subagents/registry/
 *   subagent-control-kill.ts:134-165 (a stop walks the descendants), src/config/agent-limits.ts:27 with
 *   src/agents/spawn-plan.ts:325 (children at once per requester) and src/auto-reply/reply/session-reset-cleanup.ts:41
 *   (a reset stops the session's children).
 * - Codex (https://github.com/openai/codex, commit bd4204efc2, Apache-2.0; design only): codex-rs/core/src/agent/
 *   registry.rs:89-110, a slot reserved before the spawn and given back when it ends or fails.
 */

/** Taken out of a helper's tools when its lead names none: nothing sent to people, no questions, no work scheduled. */
export const helperWithheldPermissions: readonly string[] = ["channels.send", "trunks.message", "brief.manage", "user.ask", "schedules.manage"];
/** From this depth on, a task hands no work on (below) unless its lead let it (`ToolContext.delegates`). */
export const helperSpawnDepth = 1;
/** What handing work on means: starting helpers, and messaging other Branches and Trunks. */
const handOnTools = new Set([
  "helpers.start", "fleet.send", "trunks.remote.message",
  "specialists.delegate", "specialists.fanout", "specialists.evaluate", "mode.task",
  "delegate.parallel", "delegate.handoff", "delegate.supervise", "delegate.swarm", "delegate.route",
]);
export const nestedHelperRefusal = "A helper does not start helpers or message other Branches and Trunks unless its lead allowed it "
  + "(helpers.start with delegates). Tell your lead with helpers.tell_lead instead.";

/** A helper's tools when its lead names none: all of the lead's, less the withheld ones. */
export function defaultHelperPermissions(lead: ReadonlySet<string>): string[] {
  return [...lead].filter((permission) => !helperWithheldPermissions.includes(permission));
}

/** Why this task may not run this tool, when it is a helper that hands work on without leave; else null. */
export function handOnRefusal(name: string, context: Pick<ToolContext, "depth" | "delegates">): string | null {
  return handOnTools.has(name) && !mayHandOn(context) ? nestedHelperRefusal : null;
}
export const mayHandOn = (context: Pick<ToolContext, "depth" | "delegates">): boolean => context.depth < helperSpawnDepth || context.delegates === true;

export class HelperTree {
  private readonly children = new Map<string, Set<string>>();
  private readonly parentOf = new Map<string, string>();
  /** The conversation a background helper counts against: its top lead's. */
  private readonly homes = new Map<string, string>();
  /** Background helpers working, or reserved to start, per conversation. */
  private readonly slots = new Map<string, Set<symbol>>();

  /** A child task started by `parent`; it stays in the tree until it ends, whether or not its parent has. */
  adopt(parent: string, child: string): void {
    this.parentOf.set(child, parent);
    const kids = this.children.get(parent) ?? new Set<string>();
    kids.add(child);
    this.children.set(parent, kids);
  }
  /** A child task ended. */
  release(child: string): void {
    const parent = this.parentOf.get(child);
    this.parentOf.delete(child);
    this.homes.delete(child);
    if (parent === undefined) return;
    const kids = this.children.get(parent);
    kids?.delete(child);
    if (kids && !kids.size) this.children.delete(parent);
  }
  /** Every live task under `id`, nearest first. */
  descendants(id: string): string[] {
    const found: string[] = [], seen = new Set([id]);
    for (let queue = [id]; queue.length;) {
      for (const kid of this.children.get(queue.shift()!) ?? []) {
        if (seen.has(kid)) continue;
        seen.add(kid); found.push(kid); queue.push(kid);
      }
    }
    return found;
  }
  /** The tasks that have live children, for stopping a whole conversation's helpers. */
  parents(): string[] { return [...this.children.keys()]; }

  /** The conversation a helper started by `lead` counts against; `leadConversation` when the lead is no helper. */
  homeFor(lead: string, leadConversation: string): string { return this.homes.get(lead) ?? leadConversation; }
  setHome(helper: string, conversation: string): void { this.homes.set(helper, conversation); }
  /**
   * Reserves a background helper's place in `conversation` before anything starts, so helpers asked for in one step
   * cannot all pass the check. Null when `limit` already work; otherwise the call that gives the place back (once).
   */
  reserve(conversation: string, limit: number): (() => void) | null {
    const held = this.slots.get(conversation) ?? new Set<symbol>();
    if (held.size >= limit) return null;
    const slot = Symbol(conversation);
    held.add(slot);
    this.slots.set(conversation, held);
    return () => {
      held.delete(slot);
      if (!held.size && this.slots.get(conversation) === held) this.slots.delete(conversation);
    };
  }
}
