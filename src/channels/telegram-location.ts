/**
 * Adapted from OpenClaw extensions/telegram/src/bot/body-helpers.ts (extractTelegramLocation) and
 * src/channels/location.ts (formatLocationText), MIT, Copyright (c) 2026 OpenClaw Foundation.
 * See THIRD_PARTY_NOTICES.md. Telegram location labels stay quoted as user-provided material.
 */
import { z } from "zod";

export const telegramLocationSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  horizontal_accuracy: z.number().nonnegative().max(1500).optional(),
  live_period: z.number().int().nonnegative().optional(),
}).passthrough();
export const telegramVenueSchema = z.object({
  location: telegramLocationSchema, title: z.string().max(500), address: z.string().max(1000),
}).passthrough();
type Location = z.infer<typeof telegramLocationSchema>;
type Venue = z.infer<typeof telegramVenueSchema>;

/** A venue wins over a bare pin; live-location edits are still the same received message. */
export function telegramLocationText(message: { venue?: Venue | undefined; location?: Location | undefined }): string | undefined {
  const { venue, location } = message;
  const pin = venue?.location ?? location;
  if (!pin) return undefined;
  const isLive = !venue && typeof pin.live_period === "number" && pin.live_period > 0;
  const coords = `${pin.latitude.toFixed(6)}, ${pin.longitude.toFixed(6)}`;
  const accuracy = pin.horizontal_accuracy === undefined ? "" : ` ±${Math.round(pin.horizontal_accuracy)}m`;
  const text = isLive ? `🛰 Live location: ${coords}${accuracy}` : `📍 ${coords}${accuracy}`;
  return venue ? `${text}\nVenue supplied by sender: ${JSON.stringify(venue.title)}\nAddress supplied by sender: ${JSON.stringify(venue.address)}` : text;
}
