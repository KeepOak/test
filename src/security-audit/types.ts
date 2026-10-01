/**
 * The shapes the security self-check works with. Every check is a pure function over one
 * `SecuritySnapshot`, which is gathered once (src/security-audit/collect.ts); nothing a check does
 * touches the disk, the network or a program, so every check can be tested on every system.
 *
 * The idea of one list of named checks, each with a severity and an optional repair, comes from
 * OpenClaw's `src/security/audit.ts` (MIT). The checks themselves are Branch's own: each is decided
 * from something Branch actually stores or a file that actually exists.
 */

export type Severity = "critical" | "warn" | "info";

/** What a file or folder is to Branch, so the owner is told "the key that opens your saved passwords", not a path. */
export type PathRole =
  | "data-folder" | "database" | "locker-key" | "chatgpt-sign-in" | "session-token"
  | "integrations" | "plugins-folder" | "plugin-file" | "browser-profiles" | "artifacts" | "kept"
  | "logs" | "update-backups" | "diagnostics" | "shell-program" | "workspace";

/** Who besides the owner can reach a file, as far as this computer says. */
export interface PathFact {
  role: PathRole;
  path: string;
  kind: "file" | "folder" | "link" | "missing";
  /** Permission bits on macOS and Linux; null on Windows or when unknown. */
  mode: number | null;
  /** Other people on this computer can read it (or look inside the folder). */
  othersRead: boolean;
  /** Other people on this computer can change it. */
  othersWrite: boolean;
  /** On Windows: the broad groups that hold rights on it, as icacls names them. */
  broadGroups?: string[];
}

/** A repair the check can make by itself: take other people's access away from one path. */
export interface FixPlan {
  path: string;
  target: "file" | "folder";
  /** Plain words for what will happen. */
  sentence: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  /** What was found, in plain words. */
  detail: string;
  /** What to do about it, in plain words. */
  advice: string;
  /** Present when "Fix it" can put this right from here. */
  fixes?: FixPlan[];
}

/** What a check returns when it finds something; the id, title and severity come from the check. */
export interface Verdict {
  detail: string;
  advice: string;
  fixes?: FixPlan[];
  /** When one check can find something more or less serious depending on what else is on. */
  severity?: Severity;
}

export type CheckArea = "files" | "secrets" | "remote" | "approvals" | "commands" | "web" | "add-ons" | "models" | "channels";

export interface SecurityCheck {
  id: string;
  area: CheckArea;
  severity: Severity;
  /** The check's name in plain words; shown whether or not it found anything. */
  title: string;
  decide(snapshot: SecuritySnapshot): Verdict | null;
}

export type SwitchMode = "off" | "when-needed" | "on";

export interface McpFact {
  id: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  envKeys: string[];
}
export interface ChannelFact {
  id: string;
  type: string;
  activation: "mention" | "always";
  pairing: boolean;
  allowlist: string[];
  /** Only email has this; true everywhere else. */
  tls: boolean;
}
export interface HookFact { id: string; event: string; executable: string; args: string[]; onTimeout: "allow" | "ask" }
export interface ShellFact {
  executables: { alias: string; path: string; args: string[] }[];
  netless: boolean;
  useJobObject: boolean;
  inheritEnv: string[];
}

/** The launch settings file (BRANCH_INTEGRATIONS), read loosely so a broken file can still be reported. */
export interface IntegrationFacts {
  path: string;
  /** Why the file could not be read or understood, when it could not. */
  problem: string | null;
  mcp: McpFact[];
  shell: ShellFact | null;
  browser: { allowedOrigins: string[]; downloadTypes: string[] } | null;
  channels: ChannelFact[];
  hooks: HookFact[];
  /** As written in the file. Checks read network reach from SecuritySnapshot.network (the live policy,
      which is authoritative); only `injection` is taken from here. */
  web: { allowPrivateAddresses: boolean; allowedHosts: string[] | null; injection: string } | null;
  /** Where in the file a value that looks like a real key or password was written. */
  keyLikeValues: string[];
}

export interface PolicyRuleFact {
  tool: string;
  match: string;
  applies: "any" | "changes" | "reads";
  decision: "allow" | "ask" | "deny";
  remember: "never" | "session" | "always";
  sandbox?: string;
  backend?: string;
  hasResource: boolean;
}

export interface SecuritySnapshot {
  platform: NodeJS.Platform;
  home: string;
  dataDir: string;
  workspace: string;
  /** Paths Branch keeps, with who else can reach them. */
  paths: PathFact[];
  /** Folders found inside the workspace that hold sign-in keys (.ssh, .aws, .gnupg, …). */
  workspaceKeyFolders: string[];
  /** macOS: iCloud is keeping Desktop and Documents, so anything in them is copied to Apple's servers. */
  icloudDesktopDocuments: boolean;
  integrations: IntegrationFacts | null;
  policy: { preset: string; rules: PolicyRuleFact[]; limits: { toolCallsPerMinute: number; modelRoundsPerMinute: number }; unmatchedCommands: "ask" | "allow" };
  /** Null when this check cannot know (the command line has no phone door). */
  remoteEnabled: boolean | null;
  gatewayChain: string[];
  knownDevices: number;
  /** bucket 19 (integration review): people signing in from their own device; null when this check cannot know. */
  people?: { mode: string; chain: string[]; sessionMinutes: number; signedIn: number; waiting: number } | null;
  sessionLock: { idleMinutes: number; secretsWhileLocked: boolean };
  privacy: { outbound: string; moderation: boolean };
  /** The network policy Branch is running with right now; authoritative over integrations.web. */
  network: { allowPrivateAddresses: boolean; fakeIpProxy?: boolean; allowedHosts: string[] | null; blockedHosts: number };
  traceExport: { enabled: boolean; endpoint: string; plainHeaders: string[] };
  tokens: { name: string; scope: string; expiresAt: string; revoked: boolean }[];
  now: string;
  models: { id: string; name: string; model: string; provider: string }[];
  tools: string[];
  plugins: { id: string; enabled: boolean; fingerprinted: boolean; unchanged: boolean; permissions: string[] }[];
  skills: { id: string; name: string; active: boolean; findings: number }[];
  switches: { audit: SwitchMode; malware: SwitchMode };
  /** The container image scripts run in when a rule sends them to a container. */
  sandboxImage: string;
  /** Group chats the owner set to answer every message (Settings › Chat apps or /activation), whatever the app's default. */
  alwaysGroups?: { channel: string; title: string }[];
}

export interface CheckOutcome { id: string; area: CheckArea; title: string; severity: Severity; ok: boolean }

export interface AuditReport {
  checkedAt: string;
  platform: NodeJS.Platform;
  summary: { critical: number; warn: number; info: number; passed: number; checks: number };
  findings: Finding[];
  checks: CheckOutcome[];
}

export interface FixResult {
  path: string;
  outcome: "fixed" | "already" | "skipped" | "failed";
  reason: string;
}
