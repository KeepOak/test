#!/usr/bin/env node
/**
 * How many tokens a task's first request carries for tools and skills, with ten stand-in MCP servers (eight tools
 * each, the shape a real server's tools register in: `mcp.<server>.<hash>`, external, permission = own name) and fifty
 * installed skills. Prints one JSON line: the tool section, the system text and their sum, all estimated the way the
 * engine estimates them (src/contracts.ts estimateTokens). Run it after `npm run build`:
 *
 *   node scripts/measure-tool-context.mjs            the defaults (load when needed)
 *   node scripts/measure-tool-context.mjs --always   every stand-in source set to "Always in context"
 *   node scripts/measure-tool-context.mjs --servers=1  one stand-in server instead of ten
 *   node scripts/measure-tool-context.mjs --skills=20 fewer skills (before this change at most 20 could be enabled)
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { createBranch, estimateTokens } from "../dist/index.js";

const verbs = ["search", "read", "create", "update", "list", "delete", "comment on", "export"];
const things = ["issues", "pages", "files", "messages", "tickets", "rows", "events", "notes", "orders", "contacts"];
let servers = things.map((thing, at) => ({ id: `stand-in-${at}`, thing }));

function standInTools(app) {
  for (const { id, thing } of servers)
    for (const [n, verb] of verbs.entries()) {
      const name = `mcp.${id}.${(n + 1).toString(16).padStart(16, "0")}`;
      app.registry.register({
        name, external: true, permission: name,
        description: `${verb[0].toUpperCase()}${verb.slice(1)} ${thing} in the connected ${thing} service. Returns the matching ${thing} with their ids, titles and when they last changed.`,
        parameters: z.object({ query: z.string().describe(`Words to find the ${thing} by`), limit: z.number().int().optional(),
          id: z.string().optional().describe(`The id of one of the ${thing}`), fields: z.array(z.string()).optional() }).strict(),
        execute: async () => ({ ok: true }),
      });
    }
}
const skillDoc = (n) => `---\nname: stand-in-skill-${n}\ndescription: Use when the person asks for the house style number ${n}, with its headings, tone, the order of sections and what to leave out of a finished report.\n---\n\n# Steps\n1. Read the task.\n2. Apply house style ${n}.\n`;

export async function measure({ always = false, skills = 50, count = 10 } = {}) {
  servers = things.slice(0, count).map((thing, at) => ({ id: `stand-in-${at}`, thing }));
  const root = await mkdtemp(join(tmpdir(), "branch-measure-"));
  const first = [];
  const provider = { name: "measure", async complete(request) {
    if (!first.length) first.push(request);
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  try {
    standInTools(app);
    for (let n = 0; n < skills; n++) app.store.skills.install(app.runtime.owner, { document: skillDoc(n) });
    if (always) {
      const modes = Object.fromEntries([...servers.map(({ id }) => [`mcp:${id}`, "always"]),
        ...app.store.skills.catalog(app.runtime.owner).map((skill) => [`skill:${skill.id}`, "always"])]);
      app.store.save("settings", app.runtime.owner, "tool-context-modes", { modes });
    }
    await app.runtime.run({ prompt: "Write a short note to myself about tomorrow." });
    const request = first[0];
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const tools = estimateTokens(request.tools), systemTokens = estimateTokens([{ role: "system", content: system }]);
    if (process.env.SHOW_NAMES) console.error(request.tools.map((t) => t.name).join(" "));
    return { tools: request.tools.length, toolTokens: tools, systemTokens, total: tools + systemTokens };
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}`)
  console.log(JSON.stringify(await measure({ always: process.argv.includes("--always"),
    skills: Number(process.argv.find((arg) => arg.startsWith("--skills="))?.slice(9) ?? 50),
    count: Number(process.argv.find((arg) => arg.startsWith("--servers="))?.slice(10) ?? 10) })));
