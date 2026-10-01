import { z } from "zod";
import type { OAuthConnections, OAuthProvider } from "./oauth.js";
import { GeminiProvider } from "./providers/gemini.js";
import type { ModelPreset } from "./models.js";

/**
 * Signing in with a Google account to use Gemini, instead of pasting an API key.
 *
 * What is honestly true here, and is repeated in the documentation: Google's Generative Language
 * API accepts an API key from anybody, but it accepts a signed-in person's token only when the
 * request goes to a Google Cloud project that has the API switched on, and it then bills that
 * project. There is no way to check that from this computer without sending a real request, so
 * Branch does not pretend the sign-in will work: it builds the sign-in, puts the token in the
 * ordinary Authorization header, and tells you plainly to fall back to a key if Google refuses.
 * Nothing else in Branch uses Google sign-in; this is only for Gemini.
 */
export const geminiScope = "https://www.googleapis.com/auth/generative-language.retriever";
export const geminiEndpoint = "https://generativelanguage.googleapis.com";

/** The sign-in Branch starts, filled in with the owner's own Google client id. */
export function googleGeminiSignIn(clientId: string): OAuthProvider {
  return {
    id: "google-gemini",
    label: "Google (Gemini)",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId,
    scopes: [geminiScope],
    // Google only hands back a renewal token when it is asked for one, and only the first time.
    extra: { access_type: "offline", prompt: "consent" },
  };
}

export const GeminiSignInSchema = z.object({
  /** The OAuth client id from the owner's own Google Cloud project. Empty means "use a key". */
  clientId: z.string().trim().max(300).default(""),
  /** The Gemini model to use once signed in. */
  model: z.string().trim().max(200).default("gemini-2.5-flash"),
}).strict();
export type GeminiSignInSettings = z.infer<typeof GeminiSignInSchema>;

/** Plain words for the screen and for the report, so nobody is promised more than is true. */
export const geminiSignInNote =
  "Signing in with Google works only if you have your own Google Cloud project with the Gemini API switched on, and Google charges that project. Most people should paste an API key instead; that is still the ordinary way, and nothing here changes it.";

/**
 * A Gemini connection that uses a signed-in person's token rather than a key. The token goes in the
 * Authorization header, never in the address. With `credential`, the connection asks for the token on
 * every call (`OAuthConnections.accessToken`, which renews it when it has run out); `accessToken` is then
 * only the first one.
 */
export function geminiPresetFromToken(id: string, name: string, model: string, accessToken: string,
  credential?: () => Promise<string>): ModelPreset {
  return { id, name, provider: new GeminiProvider({ endpoint: geminiEndpoint, model, apiKey: accessToken, bearer: true, credential }), model };
}

/**
 * Registers a signed-in Gemini connection, renewing the token first when it has run out. Throws in
 * plain words when nothing has been signed in, which is the state everybody starts in.
 */
export async function registerSignedInGemini(
  oauth: OAuthConnections, settings: GeminiSignInSettings, register: (preset: ModelPreset) => void,
): Promise<ModelPreset> {
  if (!settings.clientId) throw new Error(`No Google sign-in is set up. ${geminiSignInNote}`);
  const signIn = googleGeminiSignIn(settings.clientId);
  const token = await oauth.accessToken(signIn);
  // provider-audit: the token is asked for on each call, not fixed here, so the connection outlives its first hour.
  const preset = geminiPresetFromToken("google-gemini", "Gemini (signed in with Google)", settings.model, token,
    () => oauth.accessToken(signIn));
  register(preset);
  return preset;
}
