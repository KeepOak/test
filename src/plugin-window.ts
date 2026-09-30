import { z } from "zod";

/** Data only: the host owns rendering and actions. No callbacks, markup or model routing. */
const common = { id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), sessionId: z.string().uuid() };
const label = z.string().trim().min(1).max(80);
export const PluginWindowSchema = z.array(z.discriminatedUnion("slot", [
  z.object({ ...common, slot: z.literal("row-badge"), messageId: z.number().int().positive(), text: label }).strict(),
  z.object({ ...common, slot: z.literal("model-pill"), text: label }).strict(),
  z.object({ ...common, slot: z.literal("composer-draft"), label, text: z.string().min(1).max(4000) }).strict(),
])).max(20).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, "Contribution ids must be unique");
export type BranchPluginWindow = z.infer<typeof PluginWindowSchema>[number];
