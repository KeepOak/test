import { createHash } from "node:crypto";
import type { Store } from "./store.js";

function safeTitle(title: string, hide: (text: string) => string): string {
  return hide(title).replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[email]")
    .replace(/\b(?:password|token|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_+\/=-]{32,}\b/g, "[redacted]")
    .replace(/[\r\n\t\u0000-\u001f]/g, " ").trim().slice(0, 160);
}

/** Deterministic suggestions, not a claim that a task remains undone or that a result was verified. */
export function historyIdeas(store: Store, owner: string, hide: (text: string) => string) {
  const sources = store.ideaHistory(owner).map((row) => ({ ...row, title: safeTitle(row.title, hide) }))
    .filter((row) => row.title && row.title !== "[redacted]");
  const seen = new Set<string>();
  const ideas = [];
  for (const source of sources) {
    const key = source.title.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const related = sources.filter((row) => row.title.toLocaleLowerCase() === key).slice(0, 3);
    const recurring = related.length > 1;
    const title = recurring ? `Make a reusable checklist for ${source.title}` : `Review ${source.title}`;
    const references = related.map((row) => `Task ${row.id}, chat ${row.sessionId}, recorded status ${row.status}`).join("\n");
    ideas.push({ id: createHash("sha256").update(related.map((r) => r.id).join("|")).digest("hex"), title,
      reason: recurring ? "This explicit title appears more than once in eligible history." : "A recent explicitly titled task may be useful to review.",
      sources: related, draft: `${title}.\nReview the referenced history first and ask me before taking further action. Recorded status does not prove the outcome.\n${references}` });
    if (ideas.length === 5) break;
  }
  return { ideas, window: "Up to 100 recent owner tasks with explicit titles; private bodies and temporary, archived, deleted, shared or helper chats are excluded." };
}
