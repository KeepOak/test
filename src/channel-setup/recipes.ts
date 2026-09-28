import { readFileSync } from "node:fs";
import { z } from "zod";
import { channelEntries } from "../channels/catalog.js";
import { parityKinds } from "../channels/parity-config.js";

/**
 * How a person gets each chat app and makes its bot, kept as data in `data/channel-setup.json`:
 * one recipe per channel Branch can connect (owner request, 2026-09-17). Everything in a recipe is
 * an official package or an official page; a link or package that could not be checked against the
 * vendor's own site is left out rather than guessed, and the recipe says why in plain words.
 */

/** The channels Branch connects that are written with their own `type` in the connections file. */
export const coreChannelKinds = ["telegram", "discord", "slack", "whatsapp", "email", "messenger", "instagram", "matrix", "signal"] as const;

const https = z.string().max(400).regex(/^https:\/\/[^\s]+$/, "Only https addresses");
/** An https address that may start with the owner's own server, filled in before use. */
const httpsOrServer = z.string().max(400).regex(/^(https:\/\/|\{\{server\}\})[^\s]*$/, "Only https addresses");
const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const fieldName = z.string().regex(/^[a-z][A-Za-z]{0,30}$/);
const words = z.string().min(1).max(400);
const packageId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/);

export const AppSchema = z.object({
  name: z.string().min(1).max(60),
  download: https,
  winget: packageId.optional(),
  /** A Homebrew cask, not a formula. */
  brew: packageId.optional(),
  /** Only packages Flathub marks as verified by the vendor. */
  flatpak: packageId.optional(),
  /** Only snaps whose publisher Snapcraft marks as verified. */
  snap: packageId.optional(),
  /** The app's bundle name in /Applications, so a Mac can tell it is there. */
  macApp: z.string().regex(/^[A-Za-z0-9 .]{1,60}\.app$/).optional(),
}).strict();

export const CreateSchema = z.object({
  url: httpsOrServer,
  /** The app's own link to the same place, opened when the app is installed. */
  app: z.string().max(300).regex(/^tg:\/\/[^\s]+$/).optional(),
  /** True only when the vendor documents that the link arrives filled in. */
  prefilled: z.boolean(),
  how: words,
}).strict();

export const PasteSchema = z.object({
  secret: secretName,
  what: z.string().min(1).max(160),
  pattern: z.string().max(200).optional(),
  optional: z.boolean().optional(),
}).strict();
export const FieldSchema = z.object({
  name: fieldName,
  what: z.string().min(1).max(160),
  kind: z.enum(["url", "text"]),
  pattern: z.string().max(200).optional(),
}).strict();

const template = z.string().max(300);
export const CheckSchema = z.object({
  method: z.enum(["GET", "POST"]),
  url: httpsOrServer,
  auth: z.object({
    kind: z.enum(["none", "path", "bearer", "bot", "oauth", "basic", "header"]),
    secret: secretName.optional(),
    header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,40}$/).optional(),
    user: template.optional(),
  }).strict(),
  headers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,40}$/), template).optional(),
  body: z.record(z.string().max(40), template).optional(),
  encoding: z.enum(["json", "form"]).optional(),
  /** Dotted path that must be present (and equal `okValue`, when given) in a good answer. */
  ok: z.string().min(1).max(60),
  okValue: z.union([z.boolean(), z.number(), z.string()]).optional(),
  /** Dotted path to the bot's name, to say back which bot was found. */
  name: z.string().max(60).optional(),
  docs: https,
}).strict();

export const RecipeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/),
  name: z.string().min(1).max(60),
  /** What it lets the owner do, in one plain line (the window's "What can Branch do"); a recipe without one is not listed there. */
  what: words.optional(),
  /** Where the channel comes from: its own type, a row of data/channels.json, or the wave mac3 services. */
  family: z.enum(["core", "chat", "parity"]),
  /** How it is switched on: the Telegram card, the More chat apps switch, or a line in the connections file. */
  turnOn: z.enum(["guided", "switch", "file"]),
  app: AppSchema.optional(),
  noApp: words.optional(),
  stores: z.object({ ios: https.optional(), android: https.optional() }).strict().optional(),
  create: CreateSchema.optional(),
  noCreate: words.optional(),
  steps: z.array(words).max(6).optional(),
  manifest: z.record(z.string(), z.unknown()).optional(),
  fields: z.array(FieldSchema).max(6),
  paste: z.array(PasteSchema).max(6),
  check: CheckSchema.optional(),
  noCheck: words.optional(),
  entry: z.record(z.string(), z.unknown()).optional(),
  pairing: words.optional(),
  /** A risk said plainly before anything is set up (a personal number through an unofficial client can be banned). */
  warning: words.optional(),
  /** "bridge": the setup links an account by the QR code a bridge on this computer makes (GET /api/channel-setup/<id>/link). */
  link: z.literal("bridge").optional(),
  sources: z.array(https).max(10),
}).strict()
  .refine((recipe) => Boolean(recipe.app) !== Boolean(recipe.noApp), "A recipe has an app or says why there is none")
  .refine((recipe) => Boolean(recipe.create) !== Boolean(recipe.noCreate), "A recipe has a create link or says why there is none")
  .refine((recipe) => Boolean(recipe.check) !== Boolean(recipe.noCheck), "A recipe has a check or says why there is none")
  .refine((recipe) => recipe.turnOn === "guided" || recipe.entry !== undefined, "A recipe says what goes in the connections file");
export type Recipe = z.infer<typeof RecipeSchema>;

export const RecipeBookSchema = z.object({
  version: z.literal(1),
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: words,
  recipes: z.array(RecipeSchema).min(1).max(120),
}).strict();
export type RecipeBook = z.infer<typeof RecipeBookSchema>;

const bundled = [new URL("../channel-setup.json", import.meta.url), new URL("../../data/channel-setup.json", import.meta.url)];
let loaded: RecipeBook | undefined;

/** The recipes, read once and checked; a damaged file fails loudly. */
export function recipeBook(): RecipeBook {
  if (loaded) return loaded;
  for (const source of bundled) {
    let text: string;
    try { text = readFileSync(source, "utf8"); } catch { continue; }
    return (loaded = RecipeBookSchema.parse(JSON.parse(text) as unknown));
  }
  throw new Error("The chat app setup list (channel-setup.json) is missing from this installation");
}
export function recipes(): Recipe[] { return recipeBook().recipes; }
export function recipeFor(id: string): Recipe | undefined {
  const wanted = id.trim().toLowerCase();
  return recipes().find((recipe) => recipe.id === wanted);
}

/** Every channel Branch can connect, counted from the code: its own types, chat services and wave mac3 services. */
export function supportedChannels(): { id: string; family: Recipe["family"] }[] {
  return [
    ...coreChannelKinds.map((id) => ({ id, family: "core" as const })),
    ...channelEntries().map((entry) => ({ id: entry.id, family: "chat" as const })),
    ...parityKinds().map((id) => ({ id, family: "parity" as const })),
  ];
}

/** The create link with the owner's server and, for Slack, Branch's own settings filled in. */
export function createLink(recipe: Recipe, server?: string): string | null {
  if (!recipe.create) return null;
  let url = recipe.create.url;
  if (url.includes("{{server}}")) {
    if (!server) return null;
    url = url.replace("{{server}}", server.replace(/\/+$/, ""));
  }
  if (url.includes("{{manifest}}")) url = url.replace("{{manifest}}", encodeURIComponent(JSON.stringify(recipe.manifest ?? {})));
  return url;
}
