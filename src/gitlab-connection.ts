import { z } from "zod";
import { FeatureModeSchema } from "./feature-switches.js";
import { gitlabAccountKey, gitlabConnected, gitlabLaunch, gitlabMode, gitlabSwitchKey, gitlabToolNames } from "./gitlab-switch.js";
import { GitLabAccess, GitLabConfigSchema } from "./integrations/gitlab.js";
import type { NetworkPolicy } from "./network-policy.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js";
import type { Store } from "./store.js";

/**
 * RES-719: GitLab as a connection of its own, set up in the window (Settings › Advanced › GitLab).
 *
 * The owner pastes a personal access token and, for their own server, its address. The token is checked with GitLab
 * once (who it belongs to) and only then kept, in the locker of the project that is active at that moment, under
 * GITLAB_TOKEN, where Settings › Secrets shows it. It is read from there at the moment of each call, sent only in the
 * request header and scrubbed out of every answer (src/integrations/gitlab.ts). Nothing else is written: the account
 * record holds the address, the name the token belongs to and where the token is kept.
 *
 *   GET  /api/gitlab             the switch, whether it is connected and to whom, and the tools
 *   POST /api/gitlab             { mode } the switch (the owner only)
 *   POST /api/gitlab/connect     { token, apiBase? } check the token with GitLab, then keep it (the owner only)
 *   POST /api/gitlab/disconnect  {} take the token out of the locker (the owner only)
 *
 * A launch settings file that names GitLab (`git.gitlab`, src/integrations/bootstrap.ts) still works: its address and
 * token name are used, the token read from the active project as before, until the owner connects here.
 */
export const gitlabTokenName = "GITLAB_TOKEN";
const defaultApi = "https://gitlab.com/api/v4";
const AccountSchema = z.object({
  connected: z.boolean().default(false), apiBase: z.string().url().default(defaultApi),
  who: z.string().max(200).default(""), project: z.string().max(80).default(""),
}).strip();
type Account = z.infer<typeof AccountSchema>;

/** An address as the owner types it (a server, or its API address) as the API address, https only. */
export const gitlabApiBase = z.string().trim().max(300).transform((value, ctx) => {
  let url: URL;
  try { url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`); } catch {
    ctx.addIssue({ code: "custom", message: "Write your GitLab's address, like gitlab.example.org." }); return z.NEVER;
  }
  // Plain http only for a GitLab on this computer itself (a local one, or a stand-in); anywhere else the token would travel in the clear.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    ctx.addIssue({ code: "custom", message: "Write your GitLab's https address, without a sign-in or anything after it." }); return z.NEVER;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${/\/api\/v4$/.test(path) ? path : `${path}/api/v4`}`;
});
const ConnectSchema = z.object({ token: z.string().trim().min(8).max(400), apiBase: gitlabApiBase.optional() }).strict();
const SwitchSchema = z.object({ mode: FeatureModeSchema }).strict();

export class GitLabApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface GitLabDeps {
  store: Store;
  policy: NetworkPolicy;
  fetchImpl?: typeof fetch;
}

export class GitLabConnection {
  constructor(private readonly deps: GitLabDeps) {}

  account(owner: string): Account {
    return AccountSchema.parse(this.deps.store.get("settings", owner, gitlabAccountKey)?.data ?? {});
  }

  /** The connection for one call, or the plain sentence saying why there is none. */
  access(owner: string): GitLabAccess {
    const { store, policy, fetchImpl } = this.deps;
    if (gitlabMode(store, owner) === "off") throw new Error("GitLab is switched off. The owner can switch it on in Settings › Advanced › GitLab.");
    if (!gitlabConnected(store, owner)) throw new Error("GitLab isn't connected yet. The owner connects it in Settings › Advanced › GitLab with a personal access token.");
    const account = this.account(owner);
    if (account.connected) {
      const token = async () => {
        const value = (await store.secrets.resolve(owner, account.project, [gitlabTokenName], { purpose: "GitLab connection" }).catch(() => ({})) as Record<string, string>)[gitlabTokenName];
        if (!value) throw new Error("The GitLab token is no longer in the locker. Connect GitLab again in Settings › Advanced.");
        return value;
      };
      return new GitLabAccess({ apiBase: account.apiBase, tokenSecret: gitlabTokenName }, policy, token, fetchImpl);
    }
    const launch = GitLabConfigSchema.parse(gitlabLaunch.get(store) ?? {});
    const token = async () => {
      const project = store.projects.active(owner).id;
      const value = (await store.secrets.resolve(owner, project, [launch.tokenSecret], { purpose: "GitLab connection" }).catch(() => ({})) as Record<string, string>)[launch.tokenSecret];
      if (!value) throw new Error(`Connect GitLab first: save a secret called ${launch.tokenSecret} in the active project holding a GitLab personal access token.`);
      return value;
    };
    return new GitLabAccess(launch, policy, token, fetchImpl);
  }

  view(owner: string) {
    const account = this.account(owner), launched = gitlabLaunch.get(this.deps.store), launch = !account.connected && launched !== null;
    return {
      settings: { mode: gitlabMode(this.deps.store, owner) },
      account: { connected: gitlabConnected(this.deps.store, owner), fromLaunchFile: launch,
        server: new URL(launch ? GitLabConfigSchema.parse(launched ?? {}).apiBase : account.apiBase).host, who: account.connected ? account.who : "" },
      tools: gitlabToolNames,
    };
  }

  /** Checks the token with GitLab before anything is kept, so a wrong one is refused in GitLab's own words. */
  async connect(owner: string, input: unknown) {
    const { token, apiBase = defaultApi } = ConnectSchema.parse(input);
    const probe = new GitLabAccess({ apiBase, tokenSecret: gitlabTokenName }, this.deps.policy, async () => token, this.deps.fetchImpl);
    let who: { username: string; name: string };
    try { who = await probe.whoami(); } catch (error) { throw new GitLabApiError(400, (error as Error).message); }
    const project = this.deps.store.projects.active(owner).id;
    await this.deps.store.secrets.put(owner, project, gitlabTokenName, token);
    this.deps.store.save("settings", owner, gitlabAccountKey, { connected: true, apiBase, who: who.name || who.username, project });
    return this.view(owner);
  }

  disconnect(owner: string) {
    const account = this.account(owner);
    if (account.connected && account.project) this.deps.store.secrets.remove(owner, account.project, gitlabTokenName);
    this.deps.store.save("settings", owner, gitlabAccountKey, { connected: false, apiBase: account.apiBase, who: "", project: "" });
    return this.view(owner);
  }
}

export const handlesGitLabPath = (path: string): boolean => path === "/api/gitlab" || path === "/api/gitlab/connect" || path === "/api/gitlab/disconnect";

export async function gitlabApi(deps: { connection: GitLabConnection; store: Store; owner: string; requireOwner: (what: string) => void },
  method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  const { connection, store, owner } = deps;
  if (method === "GET" && path === "/api/gitlab") return connection.view(owner);
  if (method !== "POST") throw new GitLabApiError(405, "Read GitLab's connection with GET, or change it with POST.");
  deps.requireOwner("The GitLab connection");
  if (path === "/api/gitlab/connect") return connection.connect(owner, await body());
  if (path === "/api/gitlab/disconnect") { z.object({}).strict().parse(await body()); return connection.disconnect(owner); }
  const input = SwitchSchema.parse(await body());
  recordedWrite(store, owner, byCard("gitlab"), [gitlabSwitchKey], () => store.save("settings", owner, gitlabSwitchKey, input));
  return connection.view(owner);
}
