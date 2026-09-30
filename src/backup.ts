import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ensureFlyTables, flyTables } from "./fly-core/state.js";
import { dropIndex } from "./fly-core/fast-index.js";
import { ensureContractTable } from "./self-development-contract.js";
import { reachKey, reachParts } from "./reach/settings.js";
import { safetyKey, safetyParts } from "./safety-extras/settings.js";
import { neverTouched, settingsCatalogue } from "./settings-kit/catalogue.js";
import { coveredSettings } from "./lockdown.js";
import { ensureWikiTables, wikiTables } from "./wiki.js";
import { settleForgotten } from "./conversation-residue.js";
import { defaultGreeting, introPrompt, introSystem } from "./trunks/intro.js";
import { holdRestoredTrunks, narrowTrunk, restoredTrunksKey, type HeldTrunk } from "./trunks/restore-narrow.js";
import { MemoryFileSchema, memoryFileName } from "./trunks/files.js"; // workbench (SELF-311)

/**
 * Whole-application backup: every table that holds the person's state, as plain rows, so it can be
 * restored into a fresh install. Secrets are left out on purpose: they are encrypted with a key that
 * never leaves the device, so a copy would be unreadable elsewhere.
 */
export const maximumBackupBytes = 64 * 1024 * 1024;
const requiredTables = [
  "sessions", "tasks", "messages", "events", "usage", "compactions",
  "memory", "memory_limits", "memory_suppressions", "memory_archive", "memory_versions", "memory_proposals", "memory_checkpoints",
  "specialists", "procedures", "schedules", "settings", "deliveries",
  "installed_skills", "skill_versions", "session_branches", "session_origins",
  "file_versions", "workspace_snapshots",
  // Wave 6 (collaboration and workflows): labels, project notes, workflows and their per-step state.
  "labels", "project_notes", "workflows", "workflow_state",
  // Wave 7 (tool loading): what this computer has learned about which tools a request needs.
  "tool_usage", "tool_notes",
  // Wave 7: the knowledge bases themselves — their names, the folders they point at and whether they
  // are in use. Their passages, vectors and cached readings are left out on purpose: those are worked
  // out again from the person's own files by pressing "Read it again", and they would multiply the
  // size of a backup for nothing.
  "kb_collections",
] as const;
/**
 * mac2/fly-core-2: what the learning core has learned, with the wiring seed its weights depend on.
 * These tables only exist once the core has been switched on, so an archive may leave them out.
 */
/**
 * Q12: rows written once and never changed or removed (the self-development contracts, see
 * src/self-development-contract.ts). An archive from before them may leave them out. A restore adds
 * the revisions this install does not have and never replaces or removes one, so each row keeps the
 * hash it was written with.
 */
const appendOnlyTables = ["self_development_contracts"] as const;
const appendOnly = (table: string): boolean => (appendOnlyTables as readonly string[]).includes(table);
/**
 * Pass 17: which messages are left out of what the model sees, and the names and models of a
 * conversation's paths. An archive from before them may leave them out. Without the first, a
 * restore would send a message the owner left out to the model again.
 */
const conversationTables = ["session_left_out", "conversation_paths", "conversation_marks"] as const;
/**
 * #484: the owner's Trunks, which live in `governance` under `trunk:<id>` (src/trunks/record.ts). Only those rows travel
 * (the rest of the table stays here, `staysHere`); a restore brings each back cut down and holds what it had for the
 * owner's yes (src/trunks/restore-narrow.ts), and a replacing restore leaves this computer's Trunks as they are.
 */
const trunkTables = ["governance"] as const;
const trunkRow = (id: string): boolean => /^trunk:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const trunkFilesRow = (id: string): boolean => trunkRow(id.replace(/^trunk-files:/, "trunk:")) && id.startsWith("trunk-files:");
const restoredFiles = (data: string): string | null => {
  const schema = z.object({ files: z.object({
    "IDENTITY.md": z.string().max(8000).optional(), "SOUL.md": z.string().max(8000).optional(),
    "AGENTS.md": z.string().max(8000).optional(), "USER.md": z.string().max(8000).optional(),
    "MEMORY.md": z.string().max(8000).optional(), "TOOLS.md": z.string().max(8000).optional(),
    "HEARTBEAT.md": z.string().max(8000).optional(),
  }).strict(), memories: z.record(memoryFileName, MemoryFileSchema).optional() }).strict(); // workbench (SELF-311)
  try { return JSON.stringify(schema.parse(JSON.parse(data))); } catch { return null; }
};
export const backupTables = [...requiredTables, ...flyTables, ...appendOnlyTables, ...wikiTables, ...conversationTables, ...trunkTables] as const;
const RowSchema = z.record(z.string().regex(/^[a-z_]+$/), z.union([z.string(), z.number(), z.null()]));
const TablesSchema = z.object({
  ...Object.fromEntries(requiredTables.map((table) => [table, z.array(RowSchema)])) as Record<(typeof requiredTables)[number], z.ZodArray<typeof RowSchema>>,
  ...Object.fromEntries(flyTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof flyTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
  ...Object.fromEntries(appendOnlyTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof appendOnlyTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
  // The wiki's pages and their history (src/wiki.ts). A backup from before the wiki has none.
  ...Object.fromEntries(wikiTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof wikiTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
  ...Object.fromEntries(conversationTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof conversationTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
  // A backup from before Trunks travelled has none.
  ...Object.fromEntries(trunkTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof trunkTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
}).strict();
export const BackupArchiveSchema = z.object({
  format: z.literal("branch-agent-backup"),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  appVersion: z.string().max(40),
  tables: TablesSchema,
}).strict();
export type BackupArchive = z.infer<typeof BackupArchiveSchema>;

export function parseBackupArchive(input: unknown): BackupArchive {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized) > maximumBackupBytes) throw new Error("Backup exceeds 64 MiB");
  const archive = BackupArchiveSchema.parse(input);
  // NAS f5ce37d: a task with no id cannot be settled, and at the next start the store's recovery would take it for the
  // task whose id is the text "null" (or fail to start at all). Such a file is refused whole, before anything is written.
  if (archive.tables.tasks.some((task) => task.id === null || task.id === undefined || task.id === ""))
    throw new Error("This backup has a task with no id, so it cannot be restored as it is.");
  return archive;
}

/**
 * Sign-ins stay on this computer. A backup never carries these settings, and a restore neither writes nor removes them:
 * a passkey the owner took away came back with an older backup, and one planted in a changed file let its holder sign in
 * as a person here (Mac mini 6534228). The people's passkeys, whether they may sign in from elsewhere, OIDC sign-ins
 * waiting, which steps a phone must pass, and the paired devices' secret fingerprints.
 * Also everything else paired with this computer (NAS review of #186): the devices it lends itself to, with their
 * keys (`devices-book`), and the other Branch installs it sends work to with their keys (`remote-agent:<id>`). An
 * older backup must not let a revoked device back in, nor a changed one plant one. Which chat senders may reach the
 * assistant (`sender-allowlist`, each `channel-pair:<chat>:<sender>`) travel, but a restore holds them for the
 * owner's yes (Q168 B, `heldSettings` below), and this computer's own stay until the owner answers.
 */
export const signInSettings: readonly string[] = ["people-passkeys", "people-signin", "people-oidc-waiting", "remote-gateway-auth",
  "remote-devices", "devices-book"];
/** Settings kept on this computer by the start of their id: one row per other install. */
export const signInPrefixes: readonly string[] = ["remote-agent:"];
/**
 * What else is about this computer and whom it trusts, not about the owner's work (Q168 A), so it stays here
 * too: which workspaces' integration files are trusted to load, and which copies of a trusted folder share its
 * decision (`folder-trust-copies`, NAS ecd115b), the outside assistants this Branch pairs with, the SSH computers
 * and the programs Branch may run on them, the commands that fetch secrets, which Keychain passwords Branch may
 * read (`keychain-entries`, Q175), and which computer each Trunks inbox key stands for (`reach-remote-trunks-keys`,
 * Q173). From a file, each one could point Branch at a program, a machine, a folder or a person the owner never
 * chose here; their paths and names only mean something on this disk.
 */
export const thisComputerSettings: readonly string[] = [
  // RES-600: the phones registered for push here, tied to this computer's pairing keys.
  "mobile-push-devices",
  // Marketplace source selection belongs to this computer; restoring data must not endorse new remote sources.
  "skill-marketplace-sources",
  "folder_trust", "folder_trust_mode", "folder-trust-real", "folder-trust-copies", "remote-agent-pairing", "remote-computers",
  "secret-commands", "keychain-entries", "reach-remote-trunks-keys",
  // RES-719: which GitLab this computer is connected to and where its token sits; the token itself is in the locker, which
  // no backup carries, so the account stays with it.
  "gitlab-account",
  // NAS 49b183b's unchecked class: this computer's OS sandbox, whether its emergency stop is pressed (letting it go
  // needs the authenticator code, which a replacing restore would skip), and which tools need that code.
  "os-sandbox", "safety-emergency-stop", "safety-code-approvals-setup",
  // Q193 (NAS a870cea): which release failed to install on this computer, so update by itself skips it here only.
  "comfort-update-failed",
  // NAS 2db8099's unclassified ids: where this computer's door listens (a file may never open it to the network),
  // this computer's name among the others, and its place at a chat relay: its id there, and the envelopes it has
  // already taken, whose older list would let one be taken twice.
  "listen-address", "reach-machine-name", "reach-relay-settings", "reach-relay-seen",
  // NAS 23e7382: Lockdown, like the stop. Its `before` holds this computer's own values, which "Lockdown off" writes
  // back as they are, so a file's copy would put held rows in place with nobody asked, or release a pressed Lockdown.
  "lockdown",
  // NAS dfb2136: the rows that name a program on this disk and its arguments, which Branch runs as they are: the
  // speech engines, the voice's local speech program, and where ffmpeg and yt-dlp live.
  "speech-engines", "voice", "media-programs",
  // NAS f30facf: the same class, run with no approval by a read (language servers, debug adapters), after a patch (the
  // project check), or by name (background programs), and the container image code runs in.
  "language-servers", "debug-adapters", "code-check", "background-processes", "sandbox-backends",
  // NAS dd7589d: running code names its Python program in full, the same class. And the records Branch writes about
  // its own state here, which the catalogue never touches either: the switch migration and which chat service is
  // being turned away (a file must never say a service is fine while it is refused).
  "code-run", "feature-switches-migration", "policy-commands-allow-migration", "webhook-waits",
  // NAS 360099c: a program on this disk and its arguments, which the decision judge starts as they are, and the folder
  // the vector store makes its database in. Both only mean something on this computer.
  "jev-decisions", "vector-store",
  // NAS f7e95b5: the folder each task's trace is written to, the same class.
  "trace",
  // Q230: this computer's own folders, devices, jobs, scheduler records, tallies for caps and setup records.
  "adapt-stops", "channel-setup-done", "coding-worktree-forks", "dashboard-paused", "devices-join", "devices-picks",
  "git-checkpoints", "heartbeat-state", "learning-more-readback-last", "obsidian", "onboarding",
  "practice-previous-project", "practice-session", "reach-remote-trunks-inbox", "reach-video-count", "run_queue",
  "studies", "trunk-receipts",
  // Q230, keys worked out in code: the shell a coding task snapshots, and this computer's memory-history status.
  "coding-shell-snapshot", "memory-history-status",
  // RES-251: which hand-placed plugins on this disk were kept running inside Branch when the wall began shipping on.
  "add-ons-plugin-wall-kept",
];
/** NAS 23e7382: one row per add-on file on this disk, its fingerprint (src/safety-extras/wasm-add-ons.ts). */
const thisComputerPrefixes: readonly string[] = ["safety-wasm-add-on:",
  // NAS f30facf: whether each hook configured on this computer is on, and how it last failed.
  "hook:",
  // NAS dd7589d: Branch's own records here: work put off, a move-in under way, and each flow run's limit and origin
  // (a file must never loosen a limit a task set, or say who started a run).
  "deferred:", "move-in:", "flow-run-limit:", "flow-run-source:",
  // Q230 (NAS eba8bd8): a conversation's live waiting line, whose words run by themselves; this computer's MCP tool
  // cache, plugins and their fingerprints; and a running task's shared notes.
  "followups:", "mcp-tools:", "plugin-catalog:", "plugin:", "scratch:",
  // #890: this computer's installed plugin and add-on code versions kept for rollback, a staged candidate's local
  // folder, the evaluation evidence and the "not yet proven" mark: a file must never supply code or clear the mark.
  "plugin-version:", "plugin-review:", "plugin-evaluation:", "add-on-version:", "add-on-candidate:",
  // workbench (SELF-305): a wake-up set in a conversation, whose words later run as the owner's own task; like the
  // waiting line, a file must never put one in place.
  "wakeup:",
  // workbench (SELF-307): which plan window a conversation was last asked to write a handoff in; this computer's own.
  "handoff-asked:",
  // Q230, keys worked out in code: this computer's place in each chat stream and its offsets, its holds against redoing
  // a chat task, its webhook word, its MCP sign-in clients, which Trunk a flow run works as, the file-undo slots, a
  // "Watch me" under way, kept answers (a planted one comes back as if real) and the yeses carried over a restart.
  "channel-mark:", "channel-position:", "channel-replay:", "webhook-address:", "mcp-oauth:", "flow-run-trunk:",
  "settings-kit-file-undo-", "trunk-watch:", "cache:", "session-carry:",
  // NAS dc50a36: the memory a conversation's next turn reads, kept for that conversation here.
  "memory-snapshot:",
  // The programs each Trunk has opened on this computer (src/desktop-app-ask.ts): the record stands in for the owner's
  // yes to opening them again, so a file must never write one.
  "desktop-apps-used:"];
/** The restore's own list of rows waiting for the owner's yes (src/restore-held.ts): about this computer, so it stays too. */
export const restoreHeldKey = "restore-held";
/**
 * Whether a settings row stays on this computer: never in a backup, never taken from one, and kept by a replacing
 * restore. One test for all three, so what a backup leaves out and what a replace keeps can never drift apart.
 */
export const staysOnThisComputer = (id: string): boolean =>
  signInSettings.includes(id) || thisComputerSettings.includes(id) || [...signInPrefixes, ...thisComputerPrefixes].some((start) => id.startsWith(start))
  || id === restoreHeldKey || id === restoredTrunksKey;
/**
 * The owner's own preferences that say where their words go or who gets in (Q168 B): the model accounts and
 * connections, approved chat senders and the allow list, who may view or drive the owner's conversations, each
 * person's role, the approval rules, and what a chat sender's task may use and say yes to (`chat-permissions`, NAS
 * 49b183b). They are worth bringing back, so a backup carries them, but a restore
 * never puts one in place by itself: it holds it for the owner's yes, row by row, and this computer's own stays
 * until then. One that is the same as this computer's is not held at all (a restore point minutes old).
 */
export const heldSettings: readonly string[] = ["accounts", "model-connections", "sender-allowlist", "people-shares", "people-groups", "policy",
  "chat-permissions",
  // What works by itself, and how much of it: standing instructions every automatic turn reads, and its limits. The
  // agent market's index addresses, and whether the password book fills sign-ins.
  "autonomy-limits", "autonomy-kept-instructions", "interop-market-indexes", "vault-autofill",
  // NAS 2db8099's unclassified ids. The checks that stand between a task and the owner's yes: the second look before
  // an approval, the repeated-step guard, the security check and each safety part, so an older file cannot switch
  // one off. What reaches further than this computer, or acts by itself: the screen and keyboard, each reach part's
  // switch, the chats a relay may bring, the USB rules that start a task, and the git sources the assistant shares to.
  "desktop-control", "approval_reviewer", "loop_guard", "security-check", ...safetyParts.map(safetyKey), ...reachParts.map(reachKey),
  "reach-relay-chats", "reach-usb-rules", "reach-agent-git-sources",
  // RES-719: the GitLab switch reaches a server, so a file cannot switch it on by itself.
  "gitlab-connection",
  // NAS 23e7382: which chat accounts count as the owner for `/platform`, read before the sender list is.
  "reach-platform-settings",
  // NAS f30facf: where the owner's words and records are sent: the trace export's endpoint and the memory service.
  "trace_export", "memory-provider",
  // NAS 2a15d6b: the month's spending limit and pause, and how a skill with findings is handled (block → review).
  "usage_budget", "skill-scan",
  // NAS 0f26219: the Schedules check-in (its switch, the words it runs and the chat its news goes to) and the daily
  // brief (its template and the chat it is sent to) run by themselves, as a heartbeat does. `heartbeat-state` travels.
  "quiet-jobs", "heartbeat", "brief",
  // Seasons: whether Rings runs by itself at night, whether it may use a connection billed per call, and the gates a
  // fact passes before it is kept for good. A file must not switch on spending or loosen the gates.
  "seasons",
  // NAS 63d028c: automatic problem reports send by themselves to the place the file names (a repository, a chat), and
  // the owner's own prices set when the month's dollar limit trips.
  "automatic-problem-reports", "pricing",
  // NAS f7e95b5: where the owner's browsing runs (a server's address, with the owner's own token sent to it), the
  // video part's price, daily count and locker secret, and the words every turn reads as the assistant's identity.
  "browser-container", "reach-video-settings", "assistant-identity",
  // Q230: the notices card's record also holds automatic installing and the update channel, which install by themselves.
  "comfort-notify",
  // NAS dc50a36: whether the model's own memory changes wait for the owner (read and written with raw SQL).
  "learning",
  // Q230 (NAS a1291bd, eba8bd8): every other settings id src reads, classified one by one. Each of these could make
  // something run by itself, send somewhere or name a connection or account, run or name a program, carry words a turn
  // reads, or loosen a limit, price or safety switch. The one-line reasons are in tests/backup-classified.test.mjs.
  "batch-inference", "channel-parity-switches", "channel-setup", "chat-live-switches", "command-catalog",
  "context-files", "conversation-mode-settings", "dashboard", "documents", "embeds", "flowboards-install-list",
  "flowboards-kanban-settings", "flowboards-widget-ideas", "gemini-signin", "governance", "interop-modes-list",
  "knowledge", "live-scoring", "local-models", "mcp-connections", "mcp-sharing", "media", "memory-consolidation",
  "memory-retrieval", "metering", "model-profiles", "models", "orchestration", "page-notes", "page-notes:list",
  "projects", "repository-context", "retention", "routing", "screen-watch", "second-opinion", "session-limits", "helper-defaults", "codex-models",
  "slack-automations", "tool-meaning-search", "troubleshoot", "trunk-routines", "update-keeper", "web-pages"];
/** One row per automatic job: a loop, a heartbeat, a standing order or a procedure runs its words by itself (as a schedule does, Q168 C). */
const heldPrefixes: readonly string[] = ["channel-pair:", "profile-role:", "autonomy-loop:", "autonomy-heartbeat:", "autonomy-order:", "autonomy-procedure:",
  // NAS f30facf: each outside service the assistant may call, by its address.
  "openapi-service:",
  // NAS 2a15d6b: every ask part, its switch and its settings (Hindsight's address and the secret it sends, analytics'
  // `sendTo`, the answer engine, nodes and runtimes): each reaches past this computer or says where words go.
  "asks-",
  // Q230: a chat made known for sends, a plan the next message carries on, a project's every-turn instructions and
  // branch, a registry address, a conversation's connection, and a skill's trial, origin and package.
  "channel-session:", "plan:", "project:", "registry-index:", "session-model:", "skill-candidate:", "skill-draft:",
  "skill-origin:", "skill-package:",
  // #890: an API skill learned from a browser recording names an outside address and the request it sends.
  "captured-api-skill:",
  // A registry signing key the owner trusted: a file must never make a key trusted by itself.
  "registry-key:",
  // Q230, keys worked out in code: each coding, interop, learning-more, Trunks and model-savings part (they run
  // programs, reach other assistants or outside services, or choose where the words go), a conversation's mode, goal,
  // checklist, pinned skill and autonomy, a procedure's recipe checks, and a specialist's handoff list.
  "coding-", "interop-", "learning-more-", "trunks-", "model-savings-", "conversation-mode:", "goal:", "coding-checklist:",
  "pinned-skill:", "plan-act:", "flowboards-recipe-checks:", "handoffs:",
  // What each person here is called (src/person-about.ts): the owner's name is weighed against the household's names,
  // which they sign in by, so a file does not rename anybody by itself.
  "person-about:",
  // Each person's picture: a restore would put back its type and bytes as the file wrote them, never checked the way an
  // upload is (src/person-about.ts sniffs an upload's bytes), so a file's copy waits for the owner's yes too.
  "person-picture:"];
/**
 * Q230 (NAS a1291bd): the settings ids and prefixes that travel in a backup and are put in place by a restore, each
 * with why any value a file carries is harmless. tests/backup-classified.test.mjs fails for an id src reads that is in
 * none of this list, the held lists or this computer's, so a new id never travels by accident.
 */
export const travelsWithBackup: Readonly<Record<string, string>> = {
  "mcp-serving": "two timeouts for serving Branch's own tools; no address, program or switch",
  "channel-usage:": "only adds a tokens-and-cost line to replies that already go to that chat",
  "delight-achievements": "achievement progress only",
  "prompt-library-items": "a saved prompt only becomes a message the owner sends",
  "reflection-cursor:": "how far a look back has read; nothing runs from it",
  "reflection-note:": "what accepting a queued note would do; it still needs the owner's yes",
  "skill-install-log": "install history for display only",
  "stays-here:": "only keeps a conversation that held personal details on this computer; it can never send anything elsewhere",
  "tool-context-modes": "only how much of an already-permitted tool's or skill's description a request carries",
  "ask-first": "askFirst and maxQuestions only decide whether clarifying questions are asked",
  "calendar": "country, days off, working days, timezone and quiet hours only skip or hold existing work",
  "chat-engine": "whether a follow-up is rewritten before searching documents",
  "delight": "pets, achievements, look and background are display preferences",
  "diagnostic-log": "shapes a local, scrubbed log that sends nothing",
  "event-loop-watch": "local event-loop measurement",
  "flowboards-busy-mode": "what the owner's own typing does while a task works",
  "fly-core": "only reorders what a task already has",
  "knowledge-retention": "only creates archive suggestions",
  "learn": "a feature switch and tour length",
  "look": "appearance only",
  "milestone:": "nothing reads it",
  "preferences": "layout only",
  "prompt-library": "a feature mode; a prompt only becomes a typed message",
  "qa-scenarios": "a feature mode",
  "reach-arena-ratings": "leaderboard scores",
  "reach-note:": "the owner's own notes, read only when asked",
  "reflection-batch:": "look-back history shown on a review card",
  "reflection-jobs": "recent job outcomes the owner sees",
  "request-cache": "whether plain answers are reused",
  "reranking": "only reorders passages",
  "retrieval-pipelines": "only changes search order",
  "run-recording": "what a saved recording contains",
  "settings-history": "change history the owner sees; undo is gated",
  "ship-on-chosen": "which settings the owner set, so a restored off stays off; it only keeps a saved value, never turns one on",
  "shell-look": "how the window is drawn",
  "skill-draft-offered:": "a marker that only stops an offer",
  "skill-retire-offered:": "only holds back an offer",
  "suggestions": "ask/never answers to a suggestion bar",
  "terminal-switches": "terminal display switches",
  "tool_catalog_health": "a nightly cache the owner sees",
  "trunk-seen": "unread badge counts",
  "usage-glance": "display and offers only",
  "usage-report": "a local report never sent",
};
/**
 * NAS dfb2136: naming the ids by hand kept missing some, so every setting the catalogue itself marks as taking a
 * protection away or reaching further (a field whose guard is not "plain") is held too, unless it stays here. Read at
 * first use, because the catalogue imports much of the app.
 */
let guardedByCatalogue: ReadonlySet<string> | null = null;
const catalogueGuards = (id: string): boolean =>
  (guardedByCatalogue ??= new Set(settingsCatalogue.filter((spec) => spec.fields.some((field) => field.guard !== "plain")).map((spec) => spec.key)))
    .has(id);
/**
 * NAS dd7589d: the most sensitive records are kept out of the catalogue on purpose and named in its `neverTouched`
 * list ("the one a crafted file meets first"), and Lockdown names what reaches past this app. A restore meets both
 * lists too, and the privacy guard, whose masking a file could otherwise switch off.
 */
const codeOwnedLists = (id: string): boolean =>
  id === "privacy-guard" || neverTouched.some((pattern) => pattern.test(id)) || coveredSettings.some((pattern) => pattern.test(id));
/** A catalogue setting whose every field is plain: the settings kit already treats any value of it as harmless. */
const cataloguePlain = (id: string): boolean => settingsCatalogue.some((spec) => spec.key === id) && !catalogueGuards(id);
/** Q230: what travels, by name or by a travelling prefix, or as a plain catalogue setting. */
const travels = (id: string): boolean => id in travelsWithBackup || cataloguePlain(id)
  || Object.keys(travelsWithBackup).some((key) => key.endsWith(":") && id.startsWith(key));
/**
 * Q230 (NAS dc50a36): an id in none of the lists waits for the owner's yes. Reading every id by hand kept missing one
 * (a raw query, a single-quoted key), so an id nobody classified is held rather than put in place from a file.
 */
export const heldForTheOwner = (id: string): boolean => heldSettings.includes(id) || heldPrefixes.some((start) => id.startsWith(start))
  || (!staysOnThisComputer(id) && (catalogueGuards(id) || codeOwnedLists(id) || !travels(id)));
/** A settings row from a backup, waiting for the owner's yes: its owner, its id and its data as the file had it. */
export interface HeldRow { owner: string; id: string; data: string }
const staysHere = (table: string, row: Record<string, unknown>): boolean =>
  (table === "settings" && staysOnThisComputer(String(row.id))) || (table === "governance" && !trunkRow(String(row.id)) && !trunkFilesRow(String(row.id)));

/**
 * A restored schedule keeps its job but not its standing yes (Q168 C). Its check script waits for the
 * owner to approve it again (the scheduler pauses it and asks), and its webhook gets a token made on
 * this computer. Without this, a changed backup could bring a check program that approves itself, or a
 * webhook whose token the file's maker already holds.
 *
 * A schedule whose data is not a plain JSON object is left out of the restore (null): it cannot be disarmed, and
 * SQLite reads JSON5, so the next start would rewrite it into a job that still carries the file's yes (NAS 54d30f2).
 */
function disarmed<Row extends Record<string, unknown>>(table: string, row: Row): Row | null {
  if (table === "deliveries") return undelivered(row);
  if (table !== "schedules") return row;
  if (typeof row.data !== "string") return null;
  let job: unknown;
  try { job = JSON.parse(row.data); } catch { return null; }
  if (!job || typeof job !== "object" || Array.isArray(job)) return null;
  const kept: Record<string, unknown> = { ...job };
  if ("gateApproved" in kept) kept.gateApproved = null;
  // Only a job that has a webhook gets a new token; an empty one would otherwise switch a webhook on.
  if (typeof kept.hookToken === "string" && kept.hookToken) kept.hookToken = randomBytes(24).toString("hex");
  return { ...row, data: JSON.stringify(kept) } as Row;
}

/**
 * NAS dc50a36: a chat message the file says is still waiting to go is restored as not sent, so it waits among the
 * owner's undelivered messages for a Retry instead of being sent by the owner's own bot at the next flush.
 */
function undelivered<Row extends Record<string, unknown>>(row: Row): Row | null {
  if (typeof row.data !== "string") return null;
  let message: unknown;
  try { message = JSON.parse(row.data); } catch { return null; }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const kept = message as Record<string, unknown>;
  if (kept.status !== "pending") return row;
  return { ...row, data: JSON.stringify({ ...kept, status: "dead", lastError: "Restored from a backup and not sent. Retry it to send it." }) } as Row;
}

/** Tables whose rows SQLite itself reads by field (`json_extract`, `json_set` in src/store.ts). */
const readByField = (table: string): boolean => table === "schedules" || table === "workflows";

/** Reads every backed-up table in insertion order. */
export function exportBackup(db: DatabaseSync, appVersion: string): BackupArchive {
  const tables: Record<string, Record<string, string | number | null>[]> = {};
  for (const table of backupTables) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().filter((row) => !staysHere(table, row)
      && (table !== "governance" || !trunkFilesRow(String(row.id))
        || !!db.prepare("SELECT 1 FROM governance WHERE owner=? AND id=?").get(String(row.owner), String(row.id).replace("trunk-files:", "trunk:")))).map((row) => {
      const out: Record<string, string | number | null> = {};
      for (const [key, value] of Object.entries(row)) out[key] = typeof value === "bigint" ? Number(value) : (value as string | number | null);
      return out;
    });
  }
  return { format: "branch-agent-backup", version: 1, exportedAt: new Date().toISOString(), appVersion, tables: tables as BackupArchive["tables"] };
}

/**
 * Whether this install already holds someone's state; restoring over it is refused. A Branch whose only conversations
 * are the introductions the engine asked its new Trunks for (setup's first Trunks) holds nothing the person wrote, so it
 * still counts as empty; any word the person wrote anywhere in a conversation makes it not empty.
 */
export function hasState(db: DatabaseSync): boolean {
  return setupTrunks(db) === null;
}

/** One of setup's Trunks that nobody has touched: its record and the conversation that holds only its introduction. */
export interface SetupTrunk { owner: string; id: string; name: string; chat: string }

/**
 * The lead's call for #484: null when this install holds someone's state; otherwise setup's untouched Trunks (possibly
 * none), which a restore replaces with the backup's ("Replace this setup with the backup"). A Trunk is listed only when
 * its conversation is proven to hold nothing but the engine's introduction (onlyIntroduction).
 */
export function setupTrunks(db: DatabaseSync): SetupTrunk[] | null {
  const count = (table: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
  // NAS review of #194: a Branch holding only wiki pages has work in it too, so a restore does not merge over them.
  const wiki = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages'").get() ? count("wiki_pages") : 0;
  if (count("memory") > 0 || count("installed_skills") > 0 || wiki > 0) return null;
  const sessions = (db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((row) => row.id);
  const trunks = trunkChats(db);
  if (sessions.some((id) => !trunks.has(id) || !onlyIntroduction(db, id, trunks.get(id)!))) return null;
  return sessions.flatMap((id) => trunks.get(id) ?? []);
}

/** Each Trunk's own conversation now (governance `trunk:<id>` records), where the engine asks for its introduction. */
function trunkChats(db: DatabaseSync): Map<string, SetupTrunk[]> {
  const chats = new Map<string, SetupTrunk[]>();
  for (const row of db.prepare("SELECT owner, id, data FROM governance WHERE id LIKE 'trunk:%'").all() as { owner: string; id: string; data: string }[]) {
    try {
      const { chatSessionId: chat, name } = JSON.parse(row.data) as { chatSessionId?: unknown; name?: unknown };
      if (typeof chat === "string") chats.set(chat, [...(chats.get(chat) ?? []), { owner: row.owner, id: row.id.slice("trunk:".length), name: String(name ?? ""), chat }]);
    } catch { continue; } // a record that does not read names no conversation, so its conversation counts as the person's
  }
  return chats;
}

/**
 * What the engine itself keeps by a conversation or its tasks while it runs them (their session_id and run_id rows): the
 * task's events, cost, trace, snapshots, tool and learning notes, working summary, what was read and what was folded.
 * These go with an untouched setup Trunk's introduction. The two tamper-evident records (audit, activity_chain) are never
 * touched. A row in any other table that names the conversation or its tasks (a pin, a mark, a share, a branch, a
 * left-out message, a queued turn, a to-do) is the person's doing, so the conversation is not an untouched introduction.
 */
const engineRows = new Set(["events", "usage", "spans", "turn_snapshots", "tool_usage", "fly_traces", "session_work", "session_summaries", "message_reads", "compactions"]);
const keptRecords = new Set(["audit", "activity_chain"]);

/** Every table with a session_id or run_id column, by which of the two it has. */
function tablesByConversation(db: DatabaseSync): { table: string; session: boolean; run: boolean }[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).flatMap(({ name }) => {
    const columns = new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name));
    return columns.has("session_id") || columns.has("run_id") ? [{ table: name, session: columns.has("session_id"), run: columns.has("run_id") }] : [];
  });
}

/** Whether a table other than the conversation's own and the engine's names this conversation or one of its tasks. */
function markedByThePerson(db: DatabaseSync, sessionId: string, runs: readonly string[]): boolean {
  for (const { table, session, run } of tablesByConversation(db)) {
    if (table === "tasks" || table === "messages" || engineRows.has(table) || keptRecords.has(table)) continue;
    if (session && db.prepare(`SELECT 1 FROM "${table}" WHERE session_id=? LIMIT 1`).get(sessionId)) return true;
    if (run && runs.some((id) => db.prepare(`SELECT 1 FROM "${table}" WHERE run_id=? LIMIT 1`).get(id))) return true;
  }
  return false;
}

/**
 * Takes setup's untouched Trunks away, inside the restore's own transaction: each Trunk's record, its introduction
 * conversation with its tasks and messages, the engine's own rows for them (engineRows), and the settings kept under the
 * conversation's or the Trunk's id. Only what setupTrunks proved engine-made; the audit keeps its record.
 */
function removeSetupTrunks(db: DatabaseSync, trunks: readonly SetupTrunk[]): void {
  const engine = tablesByConversation(db).filter(({ table }) => engineRows.has(table));
  for (const trunk of trunks) {
    const runs = (db.prepare("SELECT id FROM tasks WHERE session_id=?").all(trunk.chat) as { id: string }[]).map((row) => row.id);
    for (const { table, session, run } of engine) {
      if (run) for (const id of runs) db.prepare(`DELETE FROM "${table}" WHERE run_id=?`).run(id);
      if (session) db.prepare(`DELETE FROM "${table}" WHERE session_id=?`).run(trunk.chat);
    }
    db.prepare("DELETE FROM messages WHERE session_id=?").run(trunk.chat);
    db.prepare("DELETE FROM tasks WHERE session_id=?").run(trunk.chat);
    db.prepare("DELETE FROM sessions WHERE id=?").run(trunk.chat);
    // Only ever by uuids, which no setting the owner can pin holds (tests/pinned-settings.test.mjs P14).
    if (trunkRow(`trunk:${trunk.chat}`) && trunkRow(`trunk:${trunk.id}`))
      db.prepare("DELETE FROM settings WHERE instr(id, ?) > 0 OR instr(id, ?) > 0").run(trunk.chat, `trunk:${trunk.id}`);
    db.prepare("DELETE FROM governance WHERE owner=? AND id=?").run(trunk.owner, `trunk:${trunk.id}`);
    db.prepare("DELETE FROM governance WHERE owner=? AND id=?").run(trunk.owner, `trunk-files:${trunk.id}`);
  }
}

/**
 * A conversation holding the engine's introduction ask and the Trunk's answer, and nothing else: its tasks are the
 * opening row the engine writes when it makes the conversation (src/trunks/index.ts conversation: "Trunk: <name>",
 * "Opened") and that ask, its one message from the "user" side is the ask marked as the engine's (src/trunks/intro.ts),
 * and the answers used no tool. A message the person wrote, a tool call, or a second ask means the person has been here.
 */
function onlyIntroduction(db: DatabaseSync, sessionId: string, setup: readonly SetupTrunk[]): boolean {
  const tasks = db.prepare("SELECT id, owner, prompt, output, status FROM tasks WHERE session_id=?").all(sessionId) as {
    id: string; owner: string; prompt: string; output: string; status: string
  }[];
  const engines = (task: { prompt: string; output: string }) => task.prompt === introPrompt || (task.prompt.startsWith("Trunk: ") && task.output === "Opened");
  if (!tasks.every(engines)) return false;
  if (markedByThePerson(db, sessionId, tasks.map((task) => task.id))) return false;
  const messages = db.prepare("SELECT body FROM messages WHERE session_id=?").all(sessionId) as { body: string }[];
  // The default is created quietly, with no model introduction: its exact engine opening, and at most the greeting the
  // engine writes for it (src/trunks/intro.ts defaultGreeting), count as setup.
  const quiet = tasks.length === 1 && tasks[0]!.status === "completed" && tasks[0]!.output === "Opened"
    && setup.some((trunk) => tasks[0]!.owner === trunk.owner && tasks[0]!.prompt === `Trunk: ${trunk.name}`);
  if (!messages.length) return quiet;
  if (quiet && messages.length === 1) {
    try {
      const only = JSON.parse(messages[0]!.body) as { role?: unknown; content?: unknown; toolCalls?: unknown };
      if (only.role === "assistant" && only.toolCalls === undefined && setup.some((trunk) => only.content === defaultGreeting(trunk.name))) return true;
    } catch { return false; }
  }
  let asks = 0;
  for (const row of messages) {
    let message: { role?: unknown; content?: unknown; system?: unknown; toolCalls?: unknown };
    try { message = JSON.parse(row.body) as typeof message; } catch { return false; }
    if (message.role === "user" && message.system === introSystem && message.content === introPrompt) asks++;
    else if (message.role !== "assistant" || message.toolCalls !== undefined) return false;
  }
  return asks === 1;
}

export interface RestoreOptions {
  /**
   * Empties the backed-up tables first, so a safety copy can be put back over work that is already
   * there. Only the update screen uses it, and only after a new version failed its first health check.
   */
  replaceExisting?: boolean;
}

/** Inserts every row of the archive into a fresh install, in one transaction; unknown columns are refused. */
export function importBackup(db: DatabaseSync, input: unknown, options: RestoreOptions = {}): { tables: number; rows: number; held: HeldRow[]; replaced: SetupTrunk[] } {
  const archive = parseBackupArchive(input);
  const setup = options.replaceExisting ? [] : setupTrunks(db);
  if (setup === null) throw new Error("This copy already has conversations, memory or skills. Restore into a fresh install (empty data folder) instead.");
  let tables = 0, rows = 0;
  const held: HeldRow[] = [], trunksHeld = new Map<string, HeldTrunk[]>();
  db.exec("BEGIN");
  try {
    removeSetupTrunks(db, setup); // setup's untouched Trunks make way for the backup's
    if (options.replaceExisting)
      for (const table of [...backupTables].reverse())
        if (!appendOnly(table) && table !== "governance" && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
          if (table === "settings") {
            // What stays on this computer stays, and so does this computer's value of anything held for the owner's yes.
            const kept = (db.prepare("SELECT DISTINCT id FROM settings").all() as { id: string }[]).map((row) => row.id)
              .filter((id) => staysOnThisComputer(id) || heldForTheOwner(id));
            db.prepare(`DELETE FROM settings WHERE id NOT IN (${kept.map(() => "?").join(",")})`).run(...kept);
          }
          else db.exec(`DELETE FROM ${table}`);
    prepareFlyRestore(db, archive);
    if (archive.tables.self_development_contracts?.length) ensureContractTable(db);
    if (wikiTables.some((table) => archive.tables[table]?.length)) ensureWikiTables(db);
    for (const table of backupTables) {
      const list = archive.tables[table];
      if (!list?.length) continue;
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      tables++;
      for (let given of list) {
        if (staysHere(table, given)) continue;
        if (table === "governance") {
          if (trunkFilesRow(String(given.id))) {
            const trunkId = String(given.id).replace("trunk-files:", "trunk:");
            const linked = list.some((row) => row.id === trunkId && row.owner === given.owner && narrowTrunk(String(row.data ?? "")));
            const files = options.replaceExisting || !linked ? null : restoredFiles(String(given.data ?? ""));
            if (!files) continue;
            given = { ...given, data: files };
          } else {
          // A replacing restore keeps this computer's Trunks; any other brings each back cut down, holding what it had.
          const cut = options.replaceExisting ? null : narrowTrunk(String(given.data ?? ""));
          if (!cut) continue;
          const owner = String(given.owner);
          trunksHeld.set(owner, [...(trunksHeld.get(owner) ?? []), { id: String(given.id).slice("trunk:".length), ...cut.held }]);
          given = { ...given, data: cut.data };
          }
        }
        if (table === "settings" && heldForTheOwner(String(given.id))) {
          const here = db.prepare("SELECT data FROM settings WHERE owner=? AND id=?").get(String(given.owner), String(given.id)) as { data: string } | undefined;
          if (here?.data !== given.data) held.push({ owner: String(given.owner), id: String(given.id), data: String(given.data) });
          continue;
        }
        const row = disarmed(table, given);
        if (!row) continue;
        // These two tables are read field by field with SQLite's own JSON functions. A row it refuses (JSON.parse
        // takes nesting SQLite will not) would stop every due job at each beat and the next start, so it is left
        // out like one that cannot be disarmed (NAS 91388a7).
        if (readByField(table) && !(db.prepare("SELECT json_valid(?) AS ok").get(String(row.data ?? "")) as { ok: number }).ok) continue;
        const keys = Object.keys(row).filter((k) => columns.has(k));
        if (keys.length !== Object.keys(row).length) throw new Error(`Backup row for ${table} has a column this version does not know`);
        // An append-only row gets a fresh id and is skipped when this install already has that revision.
        const kept = appendOnly(table) ? keys.filter((k) => k !== "id") : keys;
        db.prepare(`INSERT OR ${appendOnly(table) ? "IGNORE" : "REPLACE"} INTO ${table}(${kept.join(",")}) VALUES(${kept.map(() => "?").join(",")})`).run(...kept.map((k) => row[k] ?? null));
        rows++;
      }
    }
    for (const [owner, trunks] of trunksHeld) holdRestoredTrunks(db, owner, trunks);
    settleRestoredTasks(db, archive);
    settleFlyRestore(db);
    // A conversation deleted for good that the file still has goes back into Recently Deleted, without what memory
    // learned only from it (src/conversation-residue.ts); the list of them is this computer's, never in a backup.
    settleForgotten(db, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  dropIndex(db);
  return { tables, rows, held, replaced: setup };
}

/** What a task the backup says was working or cut off shows the owner, with Continue and Stop, after a restore. */
export const restoredTaskNote = "Restored from a backup. Continue it to carry on, or stop it.";
/**
 * Q227 (NAS f7e95b5): a task the file says was working or cut off is offered to the owner, never carried on by itself at
 * the next start. never-break reads `run.can_continue` as settled, so a date far in the future cannot make it resume
 * with the file's words; the owner's Continue still does.
 */
function settleRestoredTasks(db: DatabaseSync, archive: BackupArchive): void {
  const now = new Date().toISOString();
  for (const task of archive.tables.tasks ?? []) {
    const status = String(task.status ?? "");
    if (status !== "running" && status !== "interrupted") continue;
    // NAS d96cab6: bound exactly as the import bound it. A file's number id (5) is stored as the text "5.0", and so are
    // the events written for it here, so String(5) would miss the row and leave it to be carried on by itself.
    const id = task.id;
    // A file with a task of no id is refused when it is read (parseBackupArchive); this only narrows the type.
    if (id === null || id === undefined || !db.prepare("SELECT 1 FROM tasks WHERE id=?").get(id)) continue;
    db.prepare("UPDATE tasks SET status='interrupted' WHERE id=?").run(id);
    // NAS 5653d17: `run.restored` is what never-break asks for by name, however many events the file gave the task.
    db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(id, "run.restored", "{}", now);
    db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(id, "run.can_continue", JSON.stringify({ note: restoredTaskNote }), now);
  }
}

/**
 * mac2/fly-core-2. The core's weights only mean something under the wiring seed they were learned
 * with, so an owner's learning is restored whole or not at all: whatever this install already holds
 * for an owner named in the archive's `fly_*` rows is cleared first. The tables are made if this
 * install never switched the core on.
 */
function prepareFlyRestore(db: DatabaseSync, archive: BackupArchive): void {
  const owners = new Set(flyTables.flatMap((table) => (archive.tables[table] ?? []).map((row) => String(row.owner ?? ""))));
  if (!owners.size) return;
  ensureFlyTables(db);
  for (const owner of owners)
    for (const table of flyTables) db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(owner);
}
/**
 * No trace may point at a task that is not there or that is someone else's (same owner and same
 * conversation), and no weight may outlive its wiring seed.
 */
function settleFlyRestore(db: DatabaseSync): void {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fly_traces'").get()) return;
  db.exec(`DELETE FROM fly_traces WHERE NOT EXISTS (SELECT 1 FROM tasks
      WHERE tasks.id = fly_traces.run_id AND tasks.owner = fly_traces.owner AND tasks.session_id = fly_traces.session_id);
    DELETE FROM fly_traces WHERE owner NOT IN (SELECT owner FROM fly_wiring);
    DELETE FROM fly_synapses WHERE owner NOT IN (SELECT owner FROM fly_wiring);`);
}
