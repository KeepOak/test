import { z } from "zod";
import { audit } from "../audit.js";
import { FeatureModeSchema, settleSwitch, type FeatureMode } from "../feature-switches.js";
import type { Store } from "../store.js";

/**
 * Bucket 19: the owner's settings for people signing in from their own device.
 *
 * One three-way switch, off by default. While it is off nothing here answers, and no person's key
 * works. "When needed" and "on" behave the same for this feature: it has no tools for the model, so
 * there is nothing to tier.
 *
 * The sign-in chain says which checks every person must pass, all of them, in order. A profile may
 * be given extra checks of its own on top; it can never be given fewer. OpenID Connect providers
 * (a company or family identity service, or Google, Microsoft or GitLab) prove who somebody is, and
 * only for a profile the owner linked by hand: they never create a profile or pick one.
 */
export const signInMethods = ["pin", "passkey", "oidc"] as const;
export type SignInMethodId = (typeof signInMethods)[number];

export const OidcProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use a short name such as family-sso"),
  label: z.string().trim().min(1).max(60),
  /** The identity service's issuer address; its discovery document is read from under it. */
  issuer: z.string().url().max(300).refine((value) => value.startsWith("https://"), "The issuer must be an https address"),
  clientId: z.string().min(1).max(300),
  /** The name of a secret in the locker holding the client secret, for services that insist on one. */
  clientSecretName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  scopes: z.array(z.string().regex(/^[\w:./-]{1,60}$/)).max(10).default(["openid", "email", "profile"]),
}).strict();
export type OidcProvider = z.infer<typeof OidcProviderSchema>;

/** One outside identity the owner said belongs to one profile. */
export const IdentityLinkSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  profileId: z.string().uuid(),
  /** The identity service's own id for the person; the safest thing to link. */
  subject: z.string().min(1).max(255).optional(),
  /** Or a verified email address, when the subject is not known yet. */
  email: z.string().email().max(254).optional(),
}).strict().refine((link) => link.subject || link.email, "Link a subject or an email address");
export type IdentityLink = z.infer<typeof IdentityLinkSchema>;

/** Said when the last check is taken away (Team › Signing in), shown to the owner as it is. */
export const peopleChainEmpty = "Keep at least one way for people to prove it's them: a PIN, a passkey or an identity service.";
export const PeopleSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  /** Every person passes all of these. At least one; the PIN alone to start with. */
  chain: z.array(z.enum(signInMethods)).min(1, peopleChainEmpty).max(3).default(["pin"]),
  /** Extra checks for particular profiles, added to the chain above. */
  extra: z.record(z.string().uuid(), z.array(z.enum(signInMethods)).max(3)).default({}),
  /** How long a person stays signed in, in minutes. */
  sessionMinutes: z.number().int().min(5).max(60 * 24 * 7).default(12 * 60),
  providers: z.array(OidcProviderSchema).max(10).default([]),
  links: z.array(IdentityLinkSchema).max(200).default([]),
}).strict();
export type PeopleSettings = z.infer<typeof PeopleSettingsSchema>;

/** Ready-made identity services; the owner still brings their own client id from that service. */
export const oidcPresets: Record<string, { label: string; issuer: string; note: string }> = {
  google: { label: "Google", issuer: "https://accounts.google.com", note: "Make a web client in Google Cloud; add the address below as a redirect." },
  microsoft: { label: "Microsoft", issuer: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0", note: "Personal Microsoft accounts. For a work tenant, put its own id in the address." },
  gitlab: { label: "GitLab", issuer: "https://gitlab.com", note: "Add an application under your GitLab profile with the openid scope." },
};

const key = "people-signin";

export function peopleSettings(store: Pick<Store, "get">, owner: string): PeopleSettings {
  const saved = PeopleSettingsSchema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return saved.success ? saved.data : PeopleSettingsSchema.parse({});
}

export function peopleEnabled(store: Pick<Store, "get">, owner: string): boolean {
  return peopleSettings(store, owner).mode !== "off";
}

/** Saves a change; only the fields sent change. Every save is written into the record. */
export function savePeopleSettings(store: Store, owner: string, input: unknown): PeopleSettings {
  const current = peopleSettings(store, owner);
  const sent = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const merged = PeopleSettingsSchema.parse({ ...current, ...sent, mode: current.mode });
  const mode: FeatureMode = settleSwitch(current, {
    mode: sent.mode === undefined ? undefined : FeatureModeSchema.parse(sent.mode),
    enabled: typeof sent.enabled === "boolean" ? sent.enabled : undefined,
  }).mode;
  const next = { ...merged, mode };
  store.save("settings", owner, key, next);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "signing in from other devices",
    reason: `${mode}; every person passes ${next.chain.join(" and ")}`, outcome: "saved",
  });
  return next;
}

/** The checks one profile must pass: the chain, plus anything added for them. Never fewer. */
export function chainFor(settings: PeopleSettings, profileId: string): SignInMethodId[] {
  const extra = settings.extra[profileId] ?? [];
  return signInMethods.filter((method) => settings.chain.includes(method) || extra.includes(method));
}
