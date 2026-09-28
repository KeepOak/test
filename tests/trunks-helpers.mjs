/** R17-A: what the Trunks tests share — a model that answers by rules, and a scratch Branch. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { noteSetupOrigin } from "../dist/setup-origin.js";

/** A model that answers by rules: the first rule that returns something wins. */
export function brain(rules = []) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const last = request.messages.at(-1);
    for (const rule of rules) {
      const out = rule({ request, system, last });
      if (out) return typeof out === "string" ? { content: out, toolCalls: [] } : out;
    }
    if (/Introduce yourself/.test(last?.content ?? "")) {
      const name = /\nYou are ([^(\n]+) \(@/.exec(system)?.[1]?.trim() ?? "someone";
      return { content: `Hello, I am ${name}.`, toolCalls: [] };
    }
    return { content: "Done.", toolCalls: [] };
  } };
  return provider;
}
export async function fixture(t, rules) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunks-"));
  const provider = brain(rules);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about Trunks, not reading first
  // Q013: a new Trunk starts on what new conversations start on (Ask first). These tests are about what a Trunk may reach,
  // so its conversations follow the owner's own setting, as every Trunk did before; the start itself: qa-pass1-window.
  app.store.save("settings", app.runtime.owner, "conversation-mode-settings", { newConversation: "follow" });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
/**
 * A Trunk made the way setup's "Your first Trunk" step makes it: inside setup's own request (x-branch-origin: setup),
 * so it may become the default by being oldest. A Trunk made any other way is the owner's own and keeps its reach.
 */
export function setupTrunk(app, input) {
  noteSetupOrigin("setup");
  try { return app.trunks.create(input); } finally { noteSetupOrigin("window"); }
}
export const on = (app, ...parts) => { for (const part of ["trunks", ...parts]) app.trunks.setMode(part, { mode: "on" }); };
export const call = (name, args, id = "c1") => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });

