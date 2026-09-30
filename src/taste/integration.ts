import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";
import type { Trunks } from "../trunks/index.js";
import { learningTask } from "../skill-authoring.js";
import { trunkAgent } from "../trunks/memory-scope.js";
import { TasteLearning } from "./learning.js";
import type { TasteAsk } from "./extraction.js";
import { sameScope, type TasteScope } from "./schemas.js";

/** Use Branch's configured model and usage accounting, with no tools or inherited personal context. */
export function tasteModel(store: Store, runtime: Runtime): TasteAsk {
  return async (owner, instructions, question) => {
    const { parent, context } = learningTask(store, owner, "Learn from your feedback", runtime);
    try {
      const child = await runtime.delegate(question, { ...context, isolated: true }, [], instructions, { timeoutMs: 120000 });
      if (child.status !== "completed") throw new Error(`Preference analysis did not finish (${child.status}).`);
      store.finish(parent.id, "completed", "Preference analysis finished.");
      return child.output;
    } catch (error) {
      store.finish(parent.id, "failed", "Preference analysis failed.");
      throw error;
    }
  };
}
/** Reconstruct scope from recorded runs. An ambiguous or imported reply teaches nothing. */
function sourceScope(store: Store, runtime: Runtime, owner: string, sessionId: string, messageId: number): TasteScope | null {
  const reply = store.sessionView(owner, sessionId).messages.find(item => item.messageId === messageId);
  if (!reply || reply.role !== "assistant" || runtime.learningRules(sessionId)) return null;
  const rows = store.sqlite.prepare("SELECT id FROM tasks WHERE owner=? AND session_id=? AND status='completed' AND output=?")
    .all(owner, sessionId, reply.content);
  const scopes: TasteScope[] = [];
  for (const row of rows) {
    const run = store.run(String(row.id))!, events = store.events(run.id);
    const started = events.find(item => item.kind === "run.started")?.data;
    if (!started || started.parentRunId || started.agent || started.personProfileId || started.dryRun || !events.some(item => item.kind === "identity.applied")) return null;
    const trunk = events.find(item => item.kind === "trunk.turn")?.data.trunkId;
    scopes.push({ memoryOwner: owner, project: run.project ?? null, agent: typeof trunk === "string" ? trunkAgent(trunk) : null });
  }
  return scopes.length && scopes.every(scope => sameScope(scope, scopes[0]!)) ? scopes[0]! : null;
}
export function createTasteLearning(store: Store, runtime: Runtime, trunks: Pick<Trunks, "trunkForConversation">): TasteLearning {
  return new TasteLearning(store, tasteModel(store, runtime), (owner, sessionId, messageId) => {
    if (owner !== runtime.owner || !store.profiles.isOwner() || runtime.learningRules(sessionId)) return null;
    const trunk = trunks.trunkForConversation(sessionId)?.trunkId;
    const scope = { memoryOwner: owner, project: store.sessionProject(sessionId) ?? null, agent: trunk ? trunkAgent(trunk) : null };
    if (messageId === undefined) return scope;
    const source = sourceScope(store, runtime, owner, sessionId, messageId);
    return source && sameScope(source, scope) ? source : null;
  });
}
