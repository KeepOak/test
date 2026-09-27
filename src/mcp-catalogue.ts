/**
 * The connector catalogue: well-known MCP servers by category, with what each needs, kept as data in
 * `data/mcp-catalogue.json` (copied beside the program by scripts/copy-data.mjs). It holds no secret and connects
 * nothing: an entry only fills in the "Add your own MCP server" form. An address or a command is listed only where it
 * was checked against the maker's published server (see `checked`); the rest carry their name, what they do and what
 * they need, and the owner types how to reach them.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const words = (max: number) => z.string().trim().min(1).max(max);
const EntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: words(60),
  category: words(40),
  description: words(160),
  needs: words(160),
  address: z.string().url().startsWith("https://").optional(),
  command: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
}).strict();
export const McpCatalogueSchema = z.object({
  format: z.literal(1),
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  connectors: z.array(EntrySchema).min(1).max(200),
}).strict();
export type McpCatalogue = z.infer<typeof McpCatalogueSchema>;

const bundled = [new URL("./mcp-catalogue.json", import.meta.url), new URL("../data/mcp-catalogue.json", import.meta.url)];
let loaded: McpCatalogue | undefined;

/** The catalogue, read once and checked; a damaged file fails loudly. */
export function mcpCatalogue(): McpCatalogue {
  if (loaded) return loaded;
  for (const source of bundled) {
    let text: string;
    try { text = readFileSync(source, "utf8"); } catch { continue; }
    return (loaded = McpCatalogueSchema.parse(JSON.parse(text) as unknown));
  }
  throw new Error("The connector catalogue (mcp-catalogue.json) is missing from this installation");
}

/** The categories in the file's order, each with its connectors. */
export function catalogueByCategory(file: McpCatalogue = mcpCatalogue()): { category: string; connectors: McpCatalogue["connectors"] }[] {
  const order: string[] = [];
  for (const entry of file.connectors) if (!order.includes(entry.category)) order.push(entry.category);
  return order.map((category) => ({ category, connectors: file.connectors.filter((entry) => entry.category === category) }));
}
