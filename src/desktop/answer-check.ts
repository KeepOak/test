import { answerHeader, markHolds, newAsk } from "../engine-proof.js";

/**
 * The window's side of the engine's marks (src/engine-proof.ts): each request to the engine's address asks with a fresh
 * value, and its answer is taken only when it carries the engine's mark for that value, at the window's port, under the
 * session key the request was signed with. Anything else answering there (a program that took the port while the engine
 * restarted) is refused before the page reads it. Kept apart from main.ts so it can be checked without Electron.
 */
export class AnswerCheck {
  private readonly asked = new Map<number, { ask: string; key: string; boot: string }>();
  constructor(private readonly port: number, private readonly most = 2000) {}

  /** What request `id` asks with, signed for the engine's process `boot` with its session `key`. */
  ask(id: number, key: string, boot: string): string {
    const ask = newAsk();
    this.asked.delete(id); // a redirect asks again under the same id
    this.asked.set(id, { ask, key, boot });
    // A request whose answer never came back through here (a socket that closed first) is let go of in time.
    if (this.asked.size > this.most) this.asked.delete(this.asked.keys().next().value!);
    return ask;
  }

  /** Whether the answer to request `id` carries the engine's mark. The request is forgotten either way. */
  holds(id: number, headers: Record<string, string | string[]> | undefined): boolean {
    const asked = this.asked.get(id);
    this.asked.delete(id);
    if (!asked || !headers) return false;
    const found = Object.entries(headers).filter(([name]) => name.toLowerCase() === answerHeader).map(([, value]) => value);
    if (found.length !== 1) return false;
    const values = Array.isArray(found[0]) ? found[0] : [found[0]];
    return values.length === 1 && markHolds(values[0], asked.key, asked.ask, this.port, asked.boot);
  }

  forget(id: number): void { this.asked.delete(id); }

  get open(): number { return this.asked.size; }
}
