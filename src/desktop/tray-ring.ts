/**
 * The tray icon's usage ring (Settings › Data & usage › "Show usage in the tray"): the logo, a little smaller, inside a
 * ring that fills clockwise from the top with the share the connection in use has left, the same share the ring under
 * the message box shows (GET /api/usage/glance "tightest"). Where the engine gives no share (money, nothing measured, a
 * household person at the window, the switch off) the tray is the logo alone and says so in its tooltip.
 *
 * Nothing here needs Electron: the ring is drawn into a raw BGRA bitmap (the order NativeImage.toBitmap and
 * createFromBitmap use), so it is tested as plain data (tests/tray-ring.test.mjs). On macOS the tray icon is a template
 * image the system colours for the menu bar, so the ring is drawn in black and told apart by its alpha alone.
 */
import { z } from "zod";

export interface TrayUsage { percentLeft: number; label: string }

const glanceSchema = z.object({
  available: z.boolean(),
  settings: z.object({ tray: z.enum(["shown", "hidden"]).optional() }).passthrough().optional(),
  tightest: z.object({
    connectionName: z.string(), accountLabel: z.string().nullable().optional(), windowTitle: z.string(), percentLeft: z.number(),
  }).passthrough().nullable().optional(),
}).passthrough();

/** What the tray should show, read from this computer's engine only; null draws the logo alone. */
export async function readTrayUsage(url: string, token: string, call: typeof fetch = fetch): Promise<TrayUsage | null> {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") return null;
  const response = await call(`${origin.origin}/api/usage/glance`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const glance = glanceSchema.safeParse(await response.json());
  if (!glance.success || !glance.data.available || glance.data.settings?.tray === "hidden") return null;
  const tightest = glance.data.tightest;
  if (!tightest) return null;
  const who = tightest.accountLabel ? `${tightest.connectionName} — ${tightest.accountLabel}` : tightest.connectionName;
  return { percentLeft: Math.max(0, Math.min(100, Math.floor(tightest.percentLeft))), label: `${who}, ${tightest.windowTitle}` };
}

/** The tray's tooltip: the name, and the share when there is one. */
export const trayTip = (usage: TrayUsage | null): string =>
  usage ? `Branch Agent · ${usage.percentLeft}% left · ${usage.label}` : "Branch Agent";

/** How big the logo is inside the ring, as a share of the icon's side. */
export const logoShare = 0.62;

/** The ring's colour for a share left, as [blue, green, red]: plenty, getting low, nearly out; black for a template. */
export function ringColour(percentLeft: number, template: boolean): [number, number, number] {
  if (template) return [0, 0, 0];
  if (percentLeft >= 50) return [0x5a, 0xa8, 0x3f];
  if (percentLeft >= 20) return [0x2e, 0x98, 0xc9];
  return [0x3a, 0x3a, 0xd0];
}

/** How much of a pixel the ring covers (soft at both edges), and whether it is on the filled part. */
function ringAt(x: number, y: number, side: number, percentLeft: number): { cover: number; filled: boolean } {
  const centre = side / 2, outer = side / 2, inner = outer - Math.max(1.5, side * 0.14);
  const dx = x + 0.5 - centre, dy = y + 0.5 - centre, r = Math.hypot(dx, dy);
  const cover = Math.max(0, Math.min(1, outer - r + 0.5)) * Math.max(0, Math.min(1, r - inner + 0.5));
  const turn = ((Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI); // 0 at the top, clockwise
  return { cover, filled: turn < percentLeft / 100 };
}

/**
 * The icon for one size: a transparent square of `side`, the logo bitmap (`logoSide` square, BGRA) in its middle, and
 * the ring round its edge. The unfilled part of the ring is a faint track.
 */
export function trayBitmap(side: number, logo: Uint8Array, logoSide: number, percentLeft: number, template: boolean): Buffer {
  if (logo.length !== logoSide * logoSide * 4) throw new Error("The logo bitmap is not the size it says.");
  const out = Buffer.alloc(side * side * 4);
  const offset = Math.floor((side - logoSide) / 2);
  for (let row = 0; row < logoSide; row++)
    out.set(logo.subarray(row * logoSide * 4, (row + 1) * logoSide * 4), ((row + offset) * side + offset) * 4);
  const [blue, green, red] = ringColour(percentLeft, template);
  const track: [number, number, number] = template ? [0, 0, 0] : [0x8a, 0x8a, 0x8a];
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const { cover, filled } = ringAt(x, y, side, percentLeft);
    if (cover <= 0) continue;
    const at = (y * side + x) * 4, colour = filled ? [blue, green, red] : track;
    out[at] = colour[0]!; out[at + 1] = colour[1]!; out[at + 2] = colour[2]!;
    out[at + 3] = Math.round(255 * cover * (filled ? 1 : 0.35));
  }
  return out;
}
