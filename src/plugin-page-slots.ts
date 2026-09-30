import { z } from 'zod';

/** Named static page slots. The renderer never imports a plugin callback or script. */
export const pluginPageSlots = ['conversation-aside', 'composer-aside'] as const;
export const PluginPageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), sessionId: z.string().uuid(),
  slot: z.enum(pluginPageSlots), title: z.string().trim().min(1).max(80),
  html: z.string().min(1).max(40000).refine(value => Buffer.byteLength(value) <= 40000, 'Page exceeds 40 KB'),
}).strict();
export type BranchPluginPage = z.infer<typeof PluginPageSchema>;
export type RegisteredPluginPage = BranchPluginPage & { source: string; pluginName: string };

export class PluginPageSlots {
  private readonly pages = new Map<string, RegisteredPluginPage[]>();
  register(source: string, pluginName: string, input: unknown): string[] {
    this.forget(source);
    if (!Array.isArray(input)) return ['UI pages must be a bounded data array.'];
    const kept: RegisteredPluginPage[] = [], errors: string[] = [];
    for (const raw of input.slice(0, 8)) {
      const parsed = PluginPageSchema.safeParse(raw);
      if (!parsed.success) { errors.push('A malformed UI page was left out.'); continue; }
      if (kept.some(page => page.id === `${source}:${parsed.data.id}`)) { errors.push('A duplicate UI page was left out.'); continue; }
      kept.push({ ...parsed.data, id: `${source}:${parsed.data.id}`, source, pluginName });
    }
    if (input.length > 8) errors.push('Only eight UI pages per plugin are supported.');
    this.pages.set(source, kept); return errors;
  }
  forget(source: string): void { this.pages.delete(source); }
  list(sessionId: string, enabled: (source: string) => boolean): RegisteredPluginPage[] {
    return [...this.pages.values()].flat().filter(page => page.sessionId === sessionId && enabled(page.source)).slice(0, 12);
  }
}
