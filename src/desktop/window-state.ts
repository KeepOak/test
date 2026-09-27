import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

/**
 * DG-177: how the window opens. The first time it opens maximised, filling the screen; after that it opens the way
 * the owner left it: maximised, or at the size and place they chose, as long as that place is still on a screen
 * (a laptop unplugged from its second monitor would otherwise open Branch off every screen).
 */
export interface Area { x: number; y: number; width: number; height: number }
export interface Opening { maximized: boolean; bounds?: Area }

export const minimumSize = { width: 760, height: 540 };
const whole = z.number().int().min(-100000).max(100000);
const stateSchema = z.object({
  maximized: z.boolean(),
  bounds: z.object({ x: whole, y: whole, width: whole, height: whole }).optional(),
}).strict();

/** Enough of the window's top edge on a screen to take hold of it. */
function onScreen(bounds: Area, screens: Area[]): boolean {
  return screens.some((screen) => bounds.x < screen.x + screen.width - 80 && bounds.x + bounds.width > screen.x + 80
    && bounds.y >= screen.y - 8 && bounds.y < screen.y + screen.height - 80);
}

export function openingFor(saved: unknown, screens: Area[]): Opening {
  const parsed = stateSchema.safeParse(saved);
  if (!parsed.success) return { maximized: true };
  const { maximized, bounds } = parsed.data;
  if (!bounds || bounds.width < minimumSize.width || bounds.height < minimumSize.height || !onScreen(bounds, screens))
    return { maximized };
  return { maximized, bounds };
}

/**
 * Puts a window back at the size it was left at. A display scaled by a fraction reads a size back off from the one
 * set: at 150 % a window set to 901 wide reads 902 (one set to 900 reads 901, which is what was saved). Restoring
 * what was read then grew the window on every reopen (901, 905, 909, 913), so the size set is nudged once by
 * however far off it read, which lands it on the size that was saved.
 */
export function restoreBounds(window: { setBounds(bounds: Area): void; getBounds(): Area }, bounds: Area): void {
  window.setBounds(bounds);
  const read = window.getBounds();
  const nudged = { ...bounds, width: 2 * bounds.width - read.width, height: 2 * bounds.height - read.height };
  if (nudged.width !== bounds.width || nudged.height !== bounds.height) window.setBounds(nudged);
}

export function readWindowState(path: string): unknown {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > 4096 ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function writeWindowState(path: string, state: { maximized: boolean; bounds: Area }): void {
  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) return;
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(parsed.data));
    renameSync(`${path}.tmp`, path);
  } catch {
    // Remembering the window is a comfort; failing to write it never stops Branch.
  }
}
