import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";
import { markChosen, sentKeys, shippedUnlessChosen } from "./ship-on.js";

/**
 * w911 (A0743, A1452): the switch for reading whole web pages (`web.page`) and following a site's
 * own links (`web.crawl`). It ships "when needed" (the owner's ship-on rule, src/ship-on.ts): a page is read only when a
 * task calls the tool, and a crawl waits between pages.
 */
export const WebPagesSchema = z.object({
  /** The three-way switch. Off until the owner turns it on. */
  mode: FeatureModeSchema.default("off"),
  /** The pause between two pages of one crawl, in milliseconds, so a site is not hammered. */
  crawlDelayMs: z.number().int().min(250).max(10000).default(1000),
}).strict();
export type WebPagesSettings = z.infer<typeof WebPagesSchema>;

export const webPagesSettingsKey = "web-pages";
// The owner's rule (ships on, 2026-09-26): reads a page only when a task asks, the way a web search already does; none of (a)–(f).
export const webPagesShipAs: FeatureMode = "when-needed";
export function readWebPagesSettings(store: Pick<Store, "get">, owner: string): WebPagesSettings {
  const saved = WebPagesSchema.safeParse(store.get("settings", owner, webPagesSettingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, webPagesSettingsKey, saved.data, { mode: webPagesShipAs }) : WebPagesSchema.parse({});
}
export function saveWebPagesSettings(store: Store, owner: string, input: unknown): WebPagesSettings {
  const given = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const value = WebPagesSchema.parse({ ...readWebPagesSettings(store, owner), ...given });
  store.save("settings", owner, webPagesSettingsKey, value);
  markChosen(store, owner, webPagesSettingsKey, sentKeys(given));
  return value;
}
export const webPagesMode = (store: Pick<Store, "get">, owner: string): FeatureMode =>
  readWebPagesSettings(store, owner).mode;

/** The one sentence both tools say while the switch is off. */
export const webPagesOff =
  "Reading whole web pages and following their links is switched off; the owner can turn it on with the web-pages setting.";

/** The tools this switch owns. */
export const webPageToolNames = ["web.page", "web.crawl"] as const;
