import { z } from "zod";

/** Public identity fields only; status output, tokens and credential locations never travel to a screen. */
export interface AccountIdentity {
  email?: string; name?: string; organization?: string; organizationId?: string; authMethod?: "claude.ai" | "api-key" | "unknown";
  /** provider-audit: the subscription plan `auth status` names (`subscriptionType`, e.g. "max"), which decides 1M context. */
  plan?: string;
}
export interface AccountSignIn { installed: boolean; signedIn: boolean | null; identity?: AccountIdentity; message: string; checkedAt: number }
const email = z.string().max(320).email();
const words = z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/);

/** Claude's documented `auth status` JSON. Extra fields are deliberately ignored, never forwarded. */
export function claudeIdentity(stdout: string): { signedIn: boolean; identity?: AccountIdentity } | null {
  if (stdout.length > 32 * 1024) return null;
  let data: Record<string, unknown>;
  try { data = JSON.parse(stdout); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.loggedIn !== "boolean") return null;
  if (!data.loggedIn) return { signedIn: false };
  const identity: AccountIdentity = { authMethod: data.authMethod === "claude.ai" ? "claude.ai"
    : ["api_key", "apiKey", "env_api_key", "console"].includes(String(data.authMethod)) ? "api-key" : "unknown" };
  const address = email.safeParse(data.email).data;
  if (address) identity.email = address;
  const name = words.safeParse(data.name).data, organization = words.safeParse(data.orgName).data;
  if (name) identity.name = name;
  if (organization) identity.organization = organization;
  const organizationId = words.safeParse(data.orgId).data;
  if (organizationId) identity.organizationId = organizationId;
  const plan = words.safeParse(data.subscriptionType).data;
  if (plan) identity.plan = plan;
  return { signedIn: true, ...(Object.keys(identity).length ? { identity } : {}) };
}

export function identityKey(identity: AccountIdentity | undefined): string | null {
  return identity?.email ? `${identity.email.toLowerCase()}\n${identity.organizationId ?? ""}` : null;
}
const genericLabel = /^(first sign-in|your (usual )?sign-in|claude(?: code)?\s*\d*|chatgpt\s*\d*)$/i;
export function accountPresentation(label: string, identity?: AccountIdentity) {
  const verified = identity?.email ?? identity?.name;
  return { label: verified ?? label, savedLabel: label,
    ...(verified && label !== verified && !genericLabel.test(label) ? { customLabel: label } : {}),
    ...(identity ? { identity } : {}) };
}
