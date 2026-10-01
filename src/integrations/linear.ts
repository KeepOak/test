import { assertHealthCurrent, healthSignal } from "../health-check.js";
import { z } from "zod";
import { scrubSecrets } from "../locker.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { TrackerIssue } from "./issue-context.js";

/**
 * Linear, the other place people keep their issues. Linear has one address and one query language
 * rather than a path per thing, so this is a single request with a query in it. The key the owner
 * saved travels only in the request header, is never written into a web address, and is scrubbed
 * out of anything reported back — the same rules the GitHub connection keeps to.
 */
export const LinearConfigSchema = z.object({
  apiBase: z.string().url().default("https://api.linear.app/graphql"),
  /** Name of the secret in the owner's project locker that holds the Linear API key. */
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).default("LINEAR_API_KEY"),
  timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  maxBytes: z.number().int().min(4096).max(1048576).default(262144),
}).strict();
export type LinearConfig = z.infer<typeof LinearConfigSchema>;
export type LinearTokenSource = () => Promise<string>;

/** An issue reference such as ENG-214. */
export const linearIssueKey = z.string().regex(/^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/, "Write a Linear issue as TEAM-123");

const issueFields = "id identifier title description url state { name } comments(first: 20) { nodes { body createdAt user { name } } }";

export class LinearAccess {
  private readonly config: LinearConfig;
  constructor(input: unknown, private readonly policy: NetworkPolicy, private readonly token: LinearTokenSource,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly userAgent = "BranchAgent") {
    this.config = LinearConfigSchema.parse(input);
  }
  get tokenSecret(): string { return this.config.tokenSecret; }

  /** Read only the authenticated viewer's id, then discard it.
   * https://linear.app/developers/graphql */
  async checkAccount(): Promise<void> {
    z.object({ viewer: z.object({ id: z.string().min(1) }) }).parse(await this.query("query BranchConnectionCheck { viewer { id } }", {}));
  }

  /** One query: the network policy decides whether the address may be reached at all. */
  private async query(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.token();
    const url = new URL(this.config.apiBase);
    await this.policy.assertAllowed(url, "Linear address");
    assertHealthCurrent();
    const response = await this.fetchImpl(url, {
      method: "POST", redirect: "error", signal: healthSignal(AbortSignal.timeout(this.config.timeoutMs))!,
      headers: { authorization: token, "content-type": "application/json", accept: "application/json", "user-agent": this.userAgent },
      body: JSON.stringify({ query, variables }),
    });
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    assertHealthCurrent();
    if (!response.ok) throw new Error(explainLinear(response.status, text));
    const parsed = (text ? JSON.parse(text) : {}) as { data?: Record<string, unknown>; errors?: { message?: string }[] };
    if (parsed.errors?.length) throw new Error(`Linear would not accept that: ${String(parsed.errors[0]?.message ?? "").slice(0, 200)}`);
    return parsed.data ?? {};
  }

  /** Issues whose words match, newest first. */
  async search(input: { query: string; limit: number }): Promise<{ tracker: "linear"; issues: { key: string; title: string; state: string; address: string }[] }> {
    const data = await this.query(
      "query($term: String!, $first: Int!) { issueSearch(filter: { title: { containsIgnoreCase: $term } }, first: $first) { nodes { identifier title url state { name } } } }",
      { term: input.query.slice(0, 200), first: input.limit });
    const nodes = ((data.issueSearch as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Record<string, unknown>[];
    return {
      tracker: "linear",
      issues: nodes.slice(0, input.limit).map((node) => ({
        key: String(node.identifier ?? ""), title: String(node.title ?? "").slice(0, 200),
        state: String((node.state as { name?: unknown } | undefined)?.name ?? ""), address: String(node.url ?? ""),
      })),
    };
  }

  /** One issue with what was written on it, in the shape every tracker answers in. */
  async get(input: { key: string }): Promise<TrackerIssue> {
    linearIssueKey.parse(input.key);
    const data = await this.query(`query($key: String!) { issue(id: $key) { ${issueFields} } }`, { key: input.key });
    const issue = data.issue as Record<string, unknown> | null;
    if (!issue) throw new Error(`Linear has no issue called ${input.key}`);
    const comments = ((issue.comments as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Record<string, unknown>[];
    return {
      tracker: "linear", reference: String(issue.identifier ?? input.key),
      title: String(issue.title ?? "").slice(0, 300), body: String(issue.description ?? "").slice(0, 20000),
      state: String((issue.state as { name?: unknown } | undefined)?.name ?? ""),
      address: String(issue.url ?? ""),
      comments: comments.slice(0, 20).map((comment) => ({
        author: String((comment.user as { name?: unknown } | undefined)?.name ?? "someone"),
        at: String(comment.createdAt ?? ""), body: String(comment.body ?? "").slice(0, 4000),
      })),
    };
  }

  /** Writes a comment on an issue. */
  async comment(input: { key: string; body: string }): Promise<{ tracker: "linear"; key: string; added: boolean }> {
    linearIssueKey.parse(input.key);
    const found = await this.query("query($key: String!) { issue(id: $key) { id } }", { key: input.key });
    const id = (found.issue as { id?: unknown } | null)?.id;
    if (!id) throw new Error(`Linear has no issue called ${input.key}`);
    const data = await this.query(
      "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
      { issueId: String(id), body: input.body.slice(0, 8000) });
    return { tracker: "linear", key: input.key, added: Boolean((data.commentCreate as { success?: unknown } | undefined)?.success) };
  }
}

/** Linear's answers in words the owner can act on; the reply body is already scrubbed. */
export function explainLinear(status: number, text: string): string {
  const detail = (/"message"\s*:\s*"([^"]{0,200})"/.exec(text)?.[1] ?? "").trim();
  if (status === 400) return `Linear would not accept that${detail ? `: ${detail}` : ""}.`;
  if (status === 401 || status === 403) return "Linear did not accept the key. Save a new Linear API key in your secrets.";
  if (status === 404) return "Linear could not find that, or the key cannot see it.";
  if (status === 429) return "Linear says you have made too many requests. Try again shortly.";
  if (status >= 500) return "Linear is having trouble right now. Try again shortly.";
  return `Linear answered ${status}${detail ? `: ${detail}` : ""}.`;
}
