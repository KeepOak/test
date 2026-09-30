// `npm run build`'s card step (PLAT-191, src/tool-cards.ts): the tools of each part built on first use, written down
// the way the registry lists them, so the engine lists them from the start without loading their code. A throwaway
// Branch is made in a temporary folder, each part is built with every switch on, and its real tools are read.
// tests/tool-cards.test.mjs checks what the engine lists from the cards against what the real tools say.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { personalParts, personalTools } from "../dist/personal/settings.js";
import { purchaseToolNames } from "../dist/purchases/index.js";

/* Each part built on first use: how to build it with every switch on, and the names of its tools. */
export const parts = [
  { name: "personal", tools: () => [...personalParts.flatMap((part) => personalTools[part]), ...purchaseToolNames],
    build: async (app) => { for (const part of personalParts) await app.personal.setMode(part, { mode: "on" }); } },
];

export function cardOf(tool) {
  const answers = ["target", "targets", "command"].filter((answer) => typeof tool[answer] === "function");
  return {
    name: tool.name, description: tool.description, permission: tool.permission,
    schema: tool.inputSchema ?? z.toJSONSchema(tool.parameters),
    ...Object.fromEntries(["group", "external", "source", "screen", "reach"].filter((key) => tool[key] !== undefined).map((key) => [key, tool[key]])),
    answers,
  };
}

/** Every card, from a throwaway Branch. */
export async function writeCards(out = new URL("../dist/tool-cards.json", import.meta.url)) {
  const root = await mkdtemp(join(tmpdir(), "branch-tool-cards-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  try {
    const cards = [];
    for (const part of parts) {
      await part.build(app);
      for (const name of part.tools()) {
        const tool = app.registry.registered(name);
        if (!tool) throw new Error(`tool-cards: ${part.name} did not register ${name}`);
        cards.push(cardOf(tool));
      }
    }
    await writeFile(out, `${JSON.stringify(cards)}\n`);
    return cards;
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href || process.argv[1]?.endsWith("tool-cards.mjs")) {
  const cards = await writeCards();
  console.log(`tool-cards: ${cards.length} tools written down`);
}
