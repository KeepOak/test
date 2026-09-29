import { z } from "zod";
import type { Store } from "./store.js";

/** How the workspace looks. Every field has a default so older saved records keep working. */
export const PreferencesSchema = z
  .object({
    appearance: z.enum(["forest", "daylight"]).default("forest"),
    followSystem: z.boolean().default(false),
    accent: z
      .enum(["copper", "leaf", "earth", "slate", "ink"])
      .default("copper"),
    textSize: z.enum(["small", "medium", "large"]).default("medium"),
    density: z.enum(["comfortable", "compact"]).default("comfortable"),
    font: z.enum(["geist", "system"]).default("geist"),
    /** Optional installed reading face; the theme's stack remains behind it for missing fonts/glyphs. */
    readingFont: z.enum(["Atkinson Hyperlegible", "OpenDyslexic", "Lexend", "Arial", "Georgia", "Verdana", "Segoe UI"]).nullable().default(null),
    reduceMotion: z.boolean().default(false),
    /** The acorn toy in the side pane. Off unless the owner switches it on. */
    showAcorn: z.boolean().default(false),
    /** The full window (every tab, meter and switch) instead of the calm one. Off by default. */
    showEverything: z.boolean().default(false),
    /** The microphone and Talk buttons beside the message box. Off by default. */
    showVoice: z.boolean().default(false),
    /** phase2/settings: how much Settings shows. Unset means "regular", or "advanced" for someone who had Show everything on. */
    settingsLevel: z.enum(["regular", "advanced", "technical"]).optional(),
    /** phase2/panels: how see-through the message box is, 0 (solid) to 100; never so clear that text is hard to read. */
    seeThrough: z.number().int().min(0).max(100).default(30),
    /** phase2/panels: how wide the conversation and the message box may grow on a wide screen (pass 18: 720px Comfortable first). */
    conversationWidth: z.enum(["comfortable", "wide", "full"]).default("comfortable"),
    /** phase2/panels: the parts of the window the person chose to hide (Settings › Appearance › What's on screen). */
    hidden: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(60).default([]),
    /** phase2/panels: right-clicking a part of the window offers "Hide this". Off until switched on. */
    rightClickHide: z.boolean().default(false),
  })
  .strict();
export type Preferences = z.infer<typeof PreferencesSchema>;
export function preferences(store: Store, owner: string) {
  return PreferencesSchema.parse(
    store.get("settings", owner, "preferences")?.data ?? {},
  );
}
