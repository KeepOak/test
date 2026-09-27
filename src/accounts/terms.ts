import type { AccountKind } from "./settings.js";

/**
 * The plain Terms line on each accounts list, and the reasoning behind the design. Read at the
 * primary sources on 2026-09-17; docs/configuration.md ("Several accounts per connection") has the
 * full decision with quotes.
 *
 * - OpenAI: its terms forbid "circumvent[ing] any rate limits or restrictions"
 *   (https://openai.com/policies/row-terms-of-use/, the page refuses automated reads, so this is the
 *   search index's copy), and API rate limits are set per organization and project, not per key
 *   (https://developers.openai.com/api/docs/guides/rate-limits).
 * - Anthropic: "You may not share your Account login information, Anthropic API key, or Account
 *   credentials with anyone else" (https://www.anthropic.com/legal/consumer-terms); the usage policy
 *   forbids getting round a ban with another account (https://www.anthropic.com/legal/aup); other
 *   apps may not handle Claude.ai sign-ins (https://code.claude.com/docs/en/legal-and-compliance).
 * - Google: "You agree to, and will not attempt to circumvent, such limitations"
 *   (https://developers.google.com/terms); reusing Gemini CLI's sign-in from other software is a
 *   violation (https://geminicli.com/docs/resources/tos-privacy/).
 * - GitHub: "One person or legal entity may maintain no more than one free Account", and "a single
 *   login may not be shared by multiple people"
 *   (https://docs.github.com/en/site-policy/github-terms/github-terms-of-service).
 *
 * So (owner decision 2026-09-27, Hermes Agent's credential pools): keys and sign-ins alike move on to the owner's
 * next account by themselves when one runs out, and the card says plainly that switching doesn't merge plans, that each
 * account's own terms apply, that the prompt cache starts again after a switch, and that a key made only to multiply a
 * limit is not allowed. Sign-ins are never shared with other people on this computer.
 */
/** `name` (integration review, phase2/accounts): whose page it is, for the window's own words; `guide` when it is not terms. */
export interface AccountTerms { text: string; links: { label: string; url: string; name: string; guide?: true }[] }

const openai = { label: "OpenAI terms", name: "OpenAI", url: "https://openai.com/policies/row-terms-of-use/" };
const anthropic = { label: "Anthropic terms", name: "Anthropic", url: "https://www.anthropic.com/legal/consumer-terms" };
const google = { label: "Google API terms", name: "Google API", url: "https://developers.google.com/terms" };
const github = { label: "GitHub terms", name: "GitHub", url: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service" };
const claudeCode = { label: "Claude Code terms", name: "Claude Code", url: "https://code.claude.com/docs/en/legal-and-compliance" };
const geminiCli = { label: "Gemini CLI terms", name: "Gemini CLI", url: "https://geminicli.com/docs/resources/tos-privacy/" };

export const termsKeys = {
  "api-key": "accounts.terms.api-key",
  chatgpt: "accounts.terms.sign-in",
  cli: "accounts.terms.sign-in",
} as const;

export function accountTerms(kind: AccountKind, pool: string): AccountTerms & { key: string } {
  if (kind === "api-key") return {
    key: termsKeys[kind],
    text: "Add only keys you are entitled to use. When a key is rate limited twice in a row, runs out of credit or is refused, Branch moves the work to your next key by itself; each key's own terms apply. Opening extra accounts only to get past a service's limits is against OpenAI's, Google's and other providers' terms.",
    links: [openai, google, anthropic],
  };
  const links = kind === "chatgpt" ? [openai, { label: "ChatGPT sign-in", name: "ChatGPT", guide: true as const, url: "https://learn.chatgpt.com/docs/auth" }]
    : pool === "cli-claude-code" ? [claudeCode, anthropic]
    : pool === "cli-gemini-cli" ? [geminiCli, google]
    : pool === "cli-copilot" ? [github] : [openai];
  return {
    key: termsKeys[kind],
    text: "Each sign-in is one person's own account and is never shared with others on this computer. When one reaches its plan limit, Branch moves the work to your next account by itself (switch this off in Settings › Accounts). Switching doesn't merge plans: each account's own terms apply, and the provider's prompt cache starts again, so the first reply after a switch can use more of the new account's limit.",
    links,
  };
}
