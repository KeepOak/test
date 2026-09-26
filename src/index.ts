import { OwnMcpServers } from "./mcp-own-servers.js"; // eng-connectors
import { OwnClis } from "./own-clis.js"; // eng-connectors
import { ReplyFlags } from "./reply-flags.js"; // eng-connectors
import { mkdir } from "node:fs/promises";
import { currentTaskRun, currentTool } from "./task-scope.js"; // mac7/walk-rules
import { allowAll, byFullAddress, WalkRules } from "./walk-rules.js"; // mac7/walk-rules
import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve, join, relative, isAbsolute, basename } from "node:path";
import { Store } from "./store.js";
import { ToolRegistry } from "./registry.js";
import { WorkspaceFiles, registerFiles } from "./files.js";
import { registerWorkspaceHistory } from "./workspace-history.js";
import { WorkspaceSearch, registerCodeSearch } from "./code-search.js";
// R17-S-C (comfort): shortcuts, status line, notifications, voice keys, browser care, proxy and certificates.
import { OutboundNetwork } from "./comfort/network.js";
import { readComfort } from "./comfort/settings.js";
import { CodeEditor, registerCodeEdit } from "./code-edit.js";
import { CodeChanges, registerCodeChanges } from "./code-change.js";
import { registerHumanTasks } from "./deferred.js";
import { BackgroundProcesses, registerProcesses } from "./processes.js";
import { CodeRunner, registerCodeRun } from "./code-run.js";
import { HandOff, registerHandOff } from "./coding/hand-off.js";
import { CredentialResolver } from "./credential-cli.js";
import { OsPermissions, probeReader } from "./os-permissions.js";
import { Runtime, argumentFingerprint } from "./runtime.js";
import { gateRefusal } from "./tool-gate.js"; // integration review (mac5/manual-actions)
import { DemoProvider } from "./demo.js";
import { watchSetupOrigin } from "./delight.js"; // setup polish 2
import { Knowledge, registerKnowledge } from "./knowledge.js";
import { registerOrchestration } from "./orchestration-tools.js";
import { registerOrchestrationModes } from "./orchestration-modes.js";
import { registerSecondOpinion } from "./second-opinion-tools.js";
import { memoryScope, registerMemory } from "./memory.js";
import { MemoryRetrieval } from "./memory-retrieval.js";
import { MemoryHygiene } from "./memory-hygiene.js";
import { chooseForInjection } from "./memory-layers.js";
import { MemoryTidy, registerMemoryTidy, shipTidyProcedure } from "./memory-tidy.js";
import { memorySnapshotLimits } from "./memory-review.js";
import { catalogHealthTick } from "./tool-usage.js";
import { MemoryTransfer } from "./memory-export.js";
import { SqliteMemoryBackend } from "./memory-backend.js";
import { MemoryProvider } from "./memory-provider.js"; // FQ-memory.providers
import { Scheduler, registerSchedules, nextTurn } from "./scheduler.js";
import { registerHistory } from "./history.js";
import { registerRunExport } from "./trajectory.js";
import { meteringTick } from "./metering.js";
import { pricingSettings } from "./pricing.js";
import { registerSessions } from "./sessions.js";
// Wave 8: conversations branched off other conversations, seen as a tree, and one answer carried back.
import { SessionTree, registerSessionTree } from "./session-tree.js";
import { lockedDown, lockdownRefusal } from "./lockdown.js";
import { registerSkills } from "./skill-tools.js";
import { registerContextFiles } from "./context-files.js";
import { startMcpServer } from "./mcp-server.js";
// Wave 7: opening other AI tools' servers only while a task needs them, and the two look-only
// tools that report what a call would do and how those connections are faring.
import { McpConnections, readLifecycleSettings } from "./mcp-lifecycle.js";
import { integrationsFileTrusted, recordWorktreeCopy } from "./folder-trust.js";
import type { CachedMcpTool } from "./integrations/mcp.js";
import { registerMcpTools } from "./mcp-tools.js";
import { A2aServer } from "./a2a.js";
import { RemoteAgents, registerRemoteAgents } from "./a2a-client.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { ModelRouter, type ModelPreset } from "./models.js";
import type { ChatGPTAuth } from "./chatgpt-auth.js";
import { syncChatGPTPresets } from "./chatgpt-presets.js";
import { startAccounts } from "./accounts/service.js"; // mac6/accounts
import { People } from "./people/index.js"; // bucket 19
import { FileLockerKey, type LockerKeySource } from "./locker.js";
import { SessionLock } from "./session-lock.js";
import { Moderation } from "./moderation.js";
import { PrivacyGuard } from "./privacy-guard.js";
import { OAuthConnections } from "./oauth.js";
import { RunArtifacts } from "./artifacts.js";
import { Attachments } from "./attachments.js";
import { BrowserProfiles } from "./integrations/browser-profiles.js";
import { ChannelRouter } from "./channels/router.js";
import { ChannelConnectors, registerChannelTools } from "./channels/connectors.js";
import { WebAccess, registerWeb } from "./integrations/web.js";
import { Hooks } from "./hooks.js";
import { Teams } from "./teams.js";
import { Triggers } from "./triggers.js";
import { SlackAutomations } from "./channels/slack-automations.js"; // mac6/bucket-16
import { Webhooks } from "./webhooks.js";
import { recordUncaughtErrors } from "./tracing.js";
import { TraceExporter, traceExportSettings } from "./tracing-export.js";
import { afterTaskMetrics, executionMetricsDeps } from "./execution-metrics.js"; // bucket 14 (A1751)
import { SessionTokens } from "./session-tokens.js";
import { CommandSecrets, KeychainSecrets } from "./vault-sources.js";
import { SkillRegistry } from "./registry-install.js";
import { SkillPackages } from "./skill-packages.js";
import { Plugins } from "./plugins.js";
import { Evaluation } from "./evaluation.js";
import { SuiteRunner } from "./evaluation-runner.js";
import { StudyRunner } from "./study.js";
import { liveScores, liveScoreSummary, liveScoringSettings, saveLiveScoringSettings, watchFinishedRuns } from "./evaluation-live.js";
import { NeedsInputError, type ToolContext } from "./contracts.js";
import { defaultPreset } from "./providers.js";
import { restoreConnections } from "./connections-preset.js";
import { restoreSignIns } from "./accounts/saved-sign-ins.js"; // accounts-wizard-plans
import { JevDecisions, registerJevDecisions, type JevRunner } from "./jev-decisions.js";
import { DecisionModels } from "./decision-models.js"; // P17-D §4
import { Workbooks, registerWorkbookTools } from "./workbooks.js"; // P17-D §3
import type { ShapedAnswer } from "./answer-shape.js"; // P17-D §4
// Wave mac5 (local models): one-click models on this computer, restored and resumed at start.
import { localKitFor, startLocalModels } from "./local-kit.js";
import type { Provider } from "./contracts.js";
import { parseRetryPolicy, type RetryPolicyInput } from "./provider-retry.js";
import type { ReliabilityInput } from "./reliability.js";
import { DocumentLibrary, registerDocuments } from "./documents.js";
import { MediaTools, registerMedia } from "./media.js";
import { VoiceService, registerVoice } from "./voice-service.js";
import { startWakeWord, type ProgramPresent, type WakeCaptureRunner, type WakeRunner } from "./voice-wake.js"; // mac7/wake-mic
import { startDictation, type SoundStreamRunner, type SpeechStreamRunner } from "./voice-dictation-run.js"; // mac7/live-voice
import { soundStreamRunner, speechStreamRunner } from "./voice-dictation-host.js"; // mac7/live-voice
import { wakeCaptureRunner, wakeRunner } from "./voice-wake-host.js"; // mac7/wake-mic
// Bucket 17.
import { MediaUnderstanding, registerMediaUnderstanding } from "./media-understand.js";
import { SpeechEngineService } from "./speech-engine-service.js";
import { registerTroubleshoot } from "./troubleshoot.js"; // w911 (A0374) hook.
import { builtInSpeech } from "./speech-engines.js";
import { LiveConversations } from "./realtime-voice.js";
import { liveRefusal } from "./live-refusal.js"; // phase2/rooms
import { registerModelSwitch } from "./model-switch.js";
import { registerSettingsTools } from "./settings-kit/tools.js";
import { registerHelpSearch } from "./help-search.js";
import { settingsKitWriters } from "./settings-kit/writers.js";
import { GitTools } from "./integrations/git.js";
import { GitCheckpoints, GitWorkspaces, type GitRun } from "./git-checkpoint.js";
import { RemoteWorkspaces, registerRemoteWorkspaces, sshRunner } from "./remote/ssh-workspace.js";
import { SessionLimiter } from "./session-limits.js";
import { ConversationRetention } from "./retention.js";
import { GitRunner, type GitRunOptions } from "./integrations/git-run.js";
import { registerGit } from "./integrations/git-tools.js";
import { offerSelfDevelopment, type SelfDevelopmentDeps } from "./self-development.js";
import { offerSourceRequests, SourceChangeRequests } from "./self-development-requests.js";
import { ContractBook, contractGuard, contractPreflight } from "./self-development-contract.js"; // Q12
import { jsonWriteProblem } from "./approvals.js";
import { Flows, registerFlows } from "./flows.js";
import { registerSdkKit } from "./sdk-kit.js"; // bucket 21
import { WebPages, registerWebPages } from "./web-pages.js"; // w911 (A0743, A1452) hook
import { PluginCatalog } from "./plugin-catalog.js";
import { AddOns } from "./add-ons/index.js"; // bucket-15: add-ons other people wrote
import { SkillRevisions, registerSkillSync } from "./skill-revisions.js";
import { DataTables, registerData } from "./data-tools.js";
import { DocumentAnalysis, registerDocumentAnalysis } from "./document-analysis.js";
import { Research, registerResearch } from "./research.js";
import { Monitors, registerMonitors, trunksSwitchedOff } from "./monitors.js";
// Wave 8: watching a rectangle of the screen for a change, off unless the owner asks twice.
import { ScreenWatches, registerScreenWatches } from "./screen-watch.js";
import { MorningBrief, registerBrief } from "./brief.js";
import { DesktopControl } from "./integrations/desktop.js";
import { LinuxDesktopSandbox } from "./integrations/linux-desktop.js";
import { TakeOverBanner } from "./integrations/linux-desktop-banner.js";
import { registerLinuxDesktop } from "./integrations/linux-desktop-tools.js";
import { screenControlParts, type BannerWindowFactory } from "./integrations/desktop-banner.js";
import { migrateFeatureSwitches } from "./feature-switch-migration.js";
import { registerDesktop } from "./integrations/desktop-tools.js";
import { registerComputer, type ComputerLayers } from "./integrations/computer.js";
import { audit } from "./audit.js";
import { DocumentRetriever, MemoryRetriever, Retrieval } from "./retrieval.js";
// Knowledge bases: whole folders read into passages, searched by words and by meaning at once.
import { KnowledgeBases } from "./knowledge-bases.js";
import { chooseVectorStore } from "./vector-store-file.js";
import { ContextProviders, providerFrom, RepositoryContextProvider,
  repositoryContextSettings } from "./context-providers.js";
import { KnowledgeRetriever, registerKnowledgeBases } from "./knowledge-tools.js";
import { KnowledgeCards, registerKnowledgeCards } from "./knowledge-cards.js";
// Batch 20 (wave 8): writing Office files, a map of what a knowledge base mentions, summaries,
// pictures described in words, a Markdown mirror of what is remembered, and text held for one job.
import { DocumentAuthoring, registerDocumentAuthoring } from "./document-authoring.js";
import { GraphRetriever, KnowledgeGraph } from "./knowledge-graph.js";
import { KnowledgeSummaries } from "./knowledge-summary.js";
import { KnowledgeManagement } from "./knowledge-manage.js";
import { KnowledgePictures } from "./knowledge-pictures.js";
import { registerKnowledgeExtras, type KnowledgeParts } from "./knowledge-more.js";
import { Learn, registerLearn } from "./learn/index.js"; // mac7/learn
import { lookLanguage, readLook } from "./terminal-theme.js"; // mac7/learn: the workspace language for a tour
import { MemoryMirror, readOnlyRefusal, registerMemoryMirror } from "./memory-mirror.js";
// bucket-18: memory history (A2317)
import { MemoryHistory, registerMemoryHistory } from "./memory-git.js";
import { EphemeralDocuments, EphemeralRetriever, registerEphemeralDocuments } from "./memory-ephemeral.js";
import { CachedEmbeddings, asEmbeddings } from "./embeddings.js";
import { MemoryConsolidation } from "./memory-consolidate.js";
import { PracticeWorkspace } from "./practice-workspace.js";
import { ProviderPlugins } from "./provider-plugins.js";
import type { IssueAccess } from "./integrations/issue-tools.js";
// Wave 6 (collaboration and workflows): labels, durable workflows, the waiting line and days off.
import { registerLabels } from "./labels.js";
import { Workflows, registerWorkflows } from "./workflows.js";
// Wave 8: the to-do list, and reports saved in several forms.
import { Todos, registerTodos } from "./todos.js";
import { Wiki, registerWiki } from "./wiki.js";
import { MemoryLearning } from "./memory-learning.js";
import { ObsidianBridge, registerObsidian } from "./obsidian.js";
import { RunQueue } from "./run-queue.js";
import { ExecutionLimit } from "./execution-limit.js";
import { CalendarSettingsStore } from "./calendar.js";
// Wave 7 (a coder's toolbox): the project map, language servers, debug adapters, plan branches,
// checkpoints with undo and redo, kept build outputs, agent export and OpenAPI-defined tools.
import { ProjectMap, registerProjectMap } from "./code-map.js";
import { LanguageServers } from "./language-server.js";
import { registerLanguageServers } from "./language-server-tools.js";
import { DebugAdapters, registerDebug } from "./debug-adapter.js";
import { registerCheckpoints, SnapshotStore, systemGit, type GitCall } from "./checkpoints.js";
// Wave mac2 (goal-undo): working toward a goal in rounds, and going back to an earlier message.
import { GoalMode, goalUndoSettings } from "./goal-mode.js";
import { Rewinds } from "./rewind.js";
import { isReadOnlyPermission } from "./policy.js";
import { KeptArtifacts, registerKeptArtifacts } from "./build-artifacts.js";
import { registerArtifactVersions } from "./artifact-versions.js"; // bucket-18 (A1183)
import { offerPullRequestFromChanges, watchFinishedTasks, type PullRequestDeps } from "./pr-hook.js"; // bucket-18 (A0300)
import { protectedTarget } from "./never-break/protected.js"; // bucket-18 integration review
import { OpenApiTools, registerOpenApiTools } from "./openapi-tools.js";
import { redactLeaksIn } from "./leak-guard.js";
// mac3/security-check: the security self-check and the malware check on add-ons.
import { SecurityService } from "./security-audit/service.js";
// mac2/fly-core: the learning core switch and its on-demand tool.
import { flyCoreSettings } from "./fly-core/settings.js";
import { setWallEdge } from "./sandbox-wall.js"; // wave mac3 (os-sandbox)
import { setFlyCoreMode, syncSuggestTool } from "./fly-core/tool.js";
// mac3/never-break: the gateway's settings and the one tool that suggests a change to them.
import { loadGatewayConfig } from "./never-break/gateway-config.js";
import { gatewayDryRun, registerNeverBreak } from "./never-break/api.js";
import { journalHook, openJournal, type TaskJournal } from "./never-break/journal.js";
import { assertFormatReadable, dataOpenError, formatOf, migrate, storeMigrations, type MigrateReport } from "./never-break/migrations.js";
import { activationJournalName, openActivationJournal, settleActivation, type ActivationJournal } from "./never-break/activation.js";
import { databaseName } from "./install/layout.js";
import { formatCopiesToPrune } from "./install/update-backup.js";
import { recoverOnStart } from "./never-break/resume.js";
import { connectGuidedTelegram, saveTelegramSetup, telegramSetupView } from "./never-break/telegram-setup.js";
import { fileURLToPath } from "node:url";
import { Asks } from "./asks/index.js"; // mac6/bucket-23: the smaller asks
import { Devices } from "./devices/index.js"; // mac7/nodes: the owner's other devices
import { Autonomy } from "./autonomy/index.js"; // r17-b: it suggests, and runs things on its own
import { trunkMode } from "./trunks/settings.js"; // Q153
import { Trunks } from "./trunks/index.js"; // R17-A: Trunks, named long-lived agents
import { computerPlatforms } from "./trunks/starts-in.js"; // Q44
import { accountsSettings, saveSessionChoice } from "./accounts/settings.js"; // R17-A: a Trunk's account (R17-005)
import { Coding } from "./coding/index.js"; // mac7/r17-d: coding polish
import { worktreeScope } from "./coding/worktrees.js"; // mac7/r17-d
import { Personal } from "./personal/index.js"; // R17-C: files, voice, devices and personal connectors
import { unsetConnectorTools } from "./personal/settings.js"; // ships-on sweep
import { Reach } from "./reach/index.js"; // r17-i: reach and platform
import { platformRunners } from "./reach/host.js"; // r17-i
import { trunkRoster } from "./reach/trunk-roster.js"; // r17-i
import { askMode } from "./asks/settings.js"; // r17-i: other computers follow bucket 23's switch
import { SafetyExtras } from "./safety-extras/index.js"; // mac7/r17-g: the safety extras
import { assertAddressNotStopped } from "./safety-extras/emergency-stop.js"; // mac7/r17-g
import { FlowsBoards } from "./flows-boards/index.js"; // r17-h: flows and boards
// R17-F: learning, deeper (src/learning-more/).
import { homedir as learningHome } from "node:os";
import { LearningMore } from "./learning-more/index.js";
// mac4/bucket-20: talking to other agents and tools.
import { Interop } from "./interop/index.js";
// mac3/reflection-skills: looking back over conversations, and skills written from experience.
import { LearningLoop } from "./reflection/loop.js";
import { attachLearningLoop } from "./reflection/hook.js";
// mac2/fly-core-2: advice that acts, the owner's view of what was learned, and skill ideas as drafts.
import { advisedFacts } from "./fly-core/apply.js";
import { warmLearningCore } from "./fly-core/hook.js";
// R17-S-B: the hidden knobs, with plain labels (src/knobs/).
import { memorySnapshotBudget as knobSnapshotLimits } from "./knobs/apply.js";
import { leakOptions } from "./knobs/leak-options.js";
// R17-E: mixtures of models offered as connections (src/model-savings/).
import { syncMixtures } from "./model-savings/mixture.js";
import { skillIdeaDraft } from "./fly-core/skill-idea.js";
import { forgetLearning, learningCoreView } from "./fly-core-api.js";
import { ReadFirstGuard } from "./coding/read-first.js"; // mac7/coding-next
import { allowedForThisRun, projectTestsVerdict } from "./coding/project-tests.js"; // mac7/coding-next, mac7/tests-unattended
import { codingOn } from "./coding/settings.js"; // mac7/coding-next

/**
 * The scripted test fixture (src/demo.ts), and only while Node's test runner runs this process: `node --test` sets
 * NODE_TEST_CONTEXT in every test file's process, which is the fixture flag here. It keeps the hundreds of tests that
 * open Branch without naming a model working. Branch itself (`branch start`, the desktop app) always passes its
 * presets, even an empty list, so it never reaches this and never meets a made-up model.
 */
function testFixturePresets(): ModelPreset[] {
  return process.env.NODE_TEST_CONTEXT ? [defaultPreset(new DemoProvider())] : [];
}

export async function createBranch(options: {
  workspace: string;
  dataDir: string;
  provider?: Provider;
  /**
   * Named model presets; the first is the default. Overrides `provider`. An empty list, or neither this nor
   * `provider`, means no model is set up yet: every request is refused in plain words until one is added.
   */
  presets?: ModelPreset[];
  /** ChatGPT account sign-in; when present and signed in, ChatGPT presets are registered. */
  chatgpt?: ChatGPTAuth;
  /** Key for the secrets locker; defaults to a private key file inside the data directory. */
  lockerKey?: LockerKeySource;
  /** Web reading settings (search endpoint, address allow/block lists). */
  web?: unknown;
  owner?: string;
  retryPolicy?: RetryPolicyInput;
  /** Stall, tool time and context-size limits for ordinary runs. */
  reliability?: ReliabilityInput;
  /* mac2/desktop-ui: the desktop app's own Stop notice window, for screen control on macOS and Linux. */
  bannerWindow?: BannerWindowFactory;
  /** Wave mac2: how the hidden snapshot store runs git; null means "git is not installed". */
  snapshotGit?: GitCall | null;
  /** mac3/security-check: the home folder the security check looks under; this computer's own when left out. */
  home?: string;
  /**
   * mac7/wake-mic: fakes for the one part of Branch that opens a microphone. Left out, the real
   * programs on this computer are used; a test hands in its own so no microphone is ever opened.
   */
  wake?: { runner?: WakeRunner; capture?: WakeCaptureRunner; present?: ProgramPresent; platform?: string };
  /**
   * mac7/live-voice: fakes for live dictation, the other part of Branch that opens a microphone.
   * Left out, the real programs on this computer are used; a test hands in its own, so no
   * microphone is opened, no sound is recorded and no speech program is started by the tests.
   */
  dictation?: { speech?: SpeechStreamRunner; sound?: SoundStreamRunner; present?: ProgramPresent; platform?: string };
  /** Test-only: clock function for deterministic rate limiting. Normal production uses Date.now. */
  clock?: () => number;
  /** Test-only: a JEV process double. Production runs the owner's configured JEV command. */
  jev?: { runner?: JevRunner };
}) {
  const retryPolicy = parseRetryPolicy(options.retryPolicy);
  const workspace = resolve(options.workspace),
    dataDir = resolve(options.dataDir);
  const dataRelative = relative(workspace, dataDir);
  if (
    dataRelative === "" ||
    (!dataRelative.startsWith("..") && !isAbsolute(dataRelative))
  )
    throw new Error(
      "Private data directory must be outside the tool workspace",
    );
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const files = new WorkspaceFiles(workspace);
  await files.checked(".", true);
  // mac2/desktop-ui: whether this is a new install decides whether the three-way switches start off.
  const existedBefore = existsSync(join(dataDir, "branch.sqlite"));
  // --- mac7/install-torture: the saved work is looked at before it is opened for writing, so data
  // from a newer Branch is refused while it is still untouched, and a damaged or unwritable folder
  // is said in plain words instead of SQLite's own. ---
  const databasePath = join(dataDir, "branch.sqlite");
  assertFormatReadable(databasePath, storeMigrations);
  let store: Store;
  try { store = new Store(databasePath); }
  catch (error) { throw dataOpenError(databasePath, error); }
  // --- end mac7/install-torture ---
  // --- mac3/never-break: the data format stamp (refuses data newer than this version can read) and
  // the task journal beside the database, flushed before every step.
  const { journal, reset: journalReset } = openNeverBreak(store, dataDir);
  if (journalReset) console.error(journalReset);
  // --- end mac3/never-break ---
  migrateFeatureSwitches(store, options.owner ?? "local", existedBefore);
  const lockerKey = options.lockerKey ?? new FileLockerKey(join(dataDir, "locker.key"));
  store.openLocker(lockerKey);
  // One scrubber in front of the whole event log: no saved password or key can be written down.
  store.guardEvent = (data) => store.secrets.scrubber.deep(data);
  // Screenshots and saved pages, and the saved sign-ins for the browser: both live beside the
  // private database, never in the person's workspace.
  const artifacts = new RunArtifacts(join(dataDir, "artifacts"));
  /**
   * Files a person attached to a message. They live beside the private database rather than with what
   * the assistant made: a run artifact is capped at 8 MB and read back only as a picture or a sound,
   * and neither suits a video or a document. A conversation's files go when the conversation does.
   */
  const attachments = new Attachments(join(dataDir, "attachments"));
  // A copy of a conversation — a branch, a duplicate, an archive read back — is given its own copy
  // of every file the original holds. The store is opened before this folder is, so it is handed
  // over here rather than built with it.
  store.useFiles(attachments);
  store.onSessionClosed((sessionId) => {
    // A listener may not throw and is never awaited, so a delete that fails cannot be retried from
    // here. It is no longer thrown away in silence either: `forget` writes what happened and says
    // whether the files really went.
    void attachments.forget(sessionId);
    void attachments.forget(sessionId, { temporary: true });
  });
  // A stop at the wrong moment must not turn a temporary conversation's files into permanent ones.
  // The list of what to sweep is read here, before anything else can start, and only those folders are
  // removed — so even a slow sweep that outlives this line cannot touch a conversation begun later.
  const sweeping = attachments.sweepTemporary().catch(() => 0);
  await Promise.race([sweeping, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
  const browserProfiles = new BrowserProfiles(join(dataDir, "browser-profiles"), lockerKey);
  const registry = new ToolRegistry();
  // mac7/r17-d: a task working in its own copy of the project (src/coding/worktrees.ts) reads and writes there.
  files.scope = () => worktreeScope() ?? store.projects.active(options.owner ?? "local").folder;
  registry.pathScope = () => files.scope(); // integration (hardening-3): folder rules see the path from the workspace too
  // mac7/coding-next: read before edit (src/coding/read-first.ts), the owner's switch, on as shipped (Q250).
  const readFirst = new ReadFirstGuard(() => codingOn(store, options.owner ?? "local", "read-first"));
  files.readFirst = readFirst;
  registry.afterWrites = (context) => readFirst.settle(context.runId);
  registry.onRunFinished(async (context) => readFirst.forget(context.runId));
  const history = store.openWorkspaceHistory(files, options.owner ?? "local");
  let documents: DocumentLibrary | undefined;
  const writeObserver = {
    before: (path: string, context: ToolContext) => history.before(path, context),
    after: async (path: string, context: ToolContext, token: unknown) => {
      const change = await history.change(path, token as Awaited<ReturnType<typeof history.before>>);
      if (context.runId) store.event(context.runId, "file.changed", { ...change });
      try { await documents?.refreshPath(context.owner, path, context.signal); } catch { /* indexing never fails a file change */ }
      const problem = await jsonWriteProblem((p) => files.read(p), path).catch(() => null);
      if (problem && context.runId)
        store.event(context.runId, "file.invalid_json", { path, problem,
          message: `${path} was saved, but it is not valid JSON: ${problem}` });
    },
  };
  registerFiles(registry, files, writeObserver);
  registerWorkspaceHistory(registry, history);
  // Points to come back to, the last change put back, and that change put forward again.
  registerCheckpoints(registry, store, history);
  // Files a task produced that are not text, kept version by version with their checksums.
  const keptArtifacts = new KeptArtifacts(join(dataDir, "kept"));
  registerKeptArtifacts(registry, keptArtifacts, files);
  // bucket-18 (A1183): put a kept version back, or let one go.
  registerArtifactVersions(registry, keptArtifacts, files);
  const workspaceSearch = new WorkspaceSearch(files); // R17-S20: the ignore-file choice is set below
  registerCodeSearch(registry, workspaceSearch);
  // The project map: built once, then kept up to date file by file, and ordered around a request.
  const projectMap = new ProjectMap(files);
  registerProjectMap(registry, projectMap);
  const editor = new CodeEditor(files, writeObserver);
  // Wave 9: a patch going in is its own event, so a hook can fire on it (issue #55, workflow-hooks).
  editor.onPatched = (changed, context) => {
    if (!context.runId) return;
    store.event(context.runId, "patch.applied", { files: changed.length,
      paths: changed.map((file) => file.path).slice(0, 20),
      added: changed.reduce((total, file) => total + file.added, 0),
      removed: changed.reduce((total, file) => total + file.removed, 0) });
  };
  registerCodeEdit(registry, files, editor);
  // Multi-file changes: a whole patch or a set of edits, shown first, written all at once, and
  // followed by the check the owner set up for this project.
  const codeChanges = new CodeChanges(store, options.owner ?? "local", files, editor, workspace);
  registerCodeChanges(registry, codeChanges);
  // Language servers and debuggers the owner already has on this computer. Both are switched off
  // until they turn them on, both are started from a full address and never downloaded, and both
  // are held under the same job object as every other program the app starts.
  const languageServers = new LanguageServers(store, options.owner ?? "local", files);
  registerLanguageServers(registry, languageServers, codeChanges);
  const debugAdapters = new DebugAdapters(store, options.owner ?? "local", files);
  registerDebug(registry, debugAdapters);
  // ── mac2/fly-core: the learning core's on-demand tool, present only while its switch is not off. ──
  syncSuggestTool(registry, store, options.owner ?? "local");
  // mac2/fly-core-2: accepting the core's skill idea opens a pre-filled draft in the skill editor.
  store.review.acceptSkillIdea = (_ideaOwner, proposal) => ({ skillDraft: skillIdeaDraft(proposal) });
  warmLearningCore(store, options.owner ?? "local");
  // Programs left running (a preview server, a watcher) and small scripts run on their own. Both
  // go through the same approval a host command does, and both are off until the owner sets them up.
  const processes = new BackgroundProcesses(store, options.owner ?? "local", workspace);
  registerProcesses(registry, processes);
  store.onSessionClosed((sessionId) => { void processes.closeSession(sessionId); });
  // Batch 20 (wave 8): a language server or a program being debugged that a task started goes when
  // that task is over, the same way a program started in a conversation goes when it closes. The
  // owner can keep either running instead, with a switch in Settings under Developer.
  //
  // "A task" means a task in a conversation. Pressing a tool's own button is one short task per
  // press, so tearing down at the end of one of those would stop the debugger between "start it"
  // and "what is this name"— the opposite of what was asked for. A press is left alone, and closing
  // the app still stops everything.
  const startedInAConversation = (runId: string): boolean => {
    const run = store.run(runId);
    return !!run && store.messages(run.sessionId).length > 0;
  };
  store.onRunFinished((runId) => {
    if (!startedInAConversation(runId)) return;
    void languageServers.closeRun(runId).catch(() => undefined);
    void debugAdapters.closeRun(runId).catch(() => undefined);
  });
  registerCodeRun(registry, new CodeRunner(store, options.owner ?? "local", workspace));
  // Version control on this computer only; sending work to a server is switched on separately.
  const gitRunner = new GitRunner();
  const git = new GitTools(files, gitRunner);
  git.onCopy = ({ source, copy, made }) => recordWorktreeCopy(store, options.owner ?? "local", source, copy, made);
  registerGit(registry, git);
  // Batch 26 (wave 8): a way back to before a set of changes was written, a project that carries
  // its own line of work, and folders on other computers reached with the OpenSSH client Windows
  // already has. All three are the owner's own tools, borrowed rather than installed.
  const gitRun: GitRun = async (cwd, args, signal) => {
    const out = await gitRunner.run({ cwd, args }, signal);
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode };
  };
  const checkpoints = new GitCheckpoints(store, options.owner ?? "local", gitRun);
  codeChanges.checkpoints = checkpoints;
  const gitWorkspaces = new GitWorkspaces(checkpoints, gitRun);
  store.projects.onSwitched((owner, project) => {
    if (!project.branch) return;
    void gitWorkspaces.switchTo(join(workspace, project.folder), project.branch, AbortSignal.timeout(30_000))
      .catch(() => undefined);
  });
  const remotes = new RemoteWorkspaces(store, options.owner ?? "local", sshRunner());
  registerRemoteWorkspaces(registry, remotes);
  // Batch 26 (wave 8): how much one conversation, or one person messaging from outside, may ask for
  // in a minute and in an hour; and letting conversations older than the owner's cut-off go.
  const sessionLimiter = new SessionLimiter(store, options.owner ?? "local");
  const retention = new ConversationRetention(store, options.owner ?? "local");
  // This computer's screen and keyboard. The tools are always here so they can explain themselves,
  // but every one of them refuses until the owner turns the switch on in Settings.
  // mac2/desktop-ui: on a Mac or Linux the screen is used only while the app's Stop notice shows.
  const desktop = new DesktopControl(store, {
    artifacts, ...screenControlParts(options.bannerWindow ? { window: options.bannerWindow } : {}),
  });
  // Batch 26 (wave 8): Windows has switches of its own under Privacy & security, and a refusal
  // there looks like nothing happening at all. The screen is probed by asking for the window list;
  // the microphone and the camera are read out of what the person already chose.
  const osPermissions = new OsPermissions(probeReader(() => desktop.probe()));
  desktop.permissions = osPermissions;
  registerDesktop(registry, desktop);
  // FQ-execution.desktop: a throwaway Linux desktop of its own, drawn by Xvfb and served over VNC,
  // which the owner may watch or take over — separate from this computer's own screen above.
  // On a Mac or Linux its "Take over" notice is the desktop app's own window, the same maker the
  // Stop notice above uses, handed the notice's own words.
  const linuxDesktop = new LinuxDesktopSandbox(store, {
    banner: new TakeOverBanner(undefined, options.bannerWindow ? { window: options.bannerWindow } : {}),
  });
  registerLinuxDesktop(registry, linuxDesktop);
  // Wave 7: one short way of saying "look at this, press that" for both a web page and a window.
  // The page half is filled in later, if and when a browser is configured for this launch.
  const computer: ComputerLayers = { window: desktop };
  registerComputer(registry, computer);
  const presets = options.presets ?? (options.provider ? [defaultPreset(options.provider)] : testFixturePresets());
  const runtime = new Runtime(
    store,
    registry,
    new ModelRouter(store, presets),
    workspace,
    options.owner ?? "local",
    retryPolicy,
    options.reliability,
    options.clock,
  );
  const decisions = new JevDecisions(store, runtime.owner, options.jev?.runner);
  registerJevDecisions(registry, decisions);
  // P17-D §3: learn an app or workflow and prove it, as a narrowed task that saves a workbook (src/workbooks.ts).
  const workbooks = new Workbooks({ store, owner: runtime.owner, registry, run: (options) => runtime.run(options) });
  registerWorkbookTools(registry, workbooks);
  runtime.learningRules = (sessionId) => workbooks.rules(sessionId); // sealed: only its own tools, every browser step asks
  // P17-D §4: small decisions on the owner's own connections, asked with no tools (src/decision-models.ts).
  const decisionModels = new DecisionModels(store, runtime.owner, runtime.models, async (text, shape, preset) => {
    // Temporary, so a decision never adds a conversation to the list.
    const run = store.createRun(runtime.owner, "Making a small decision", undefined, true, "owner");
    let answer: ShapedAnswer | undefined;
    try {
      answer = await runtime.shaped(run, runtime.context({ runId: run.id, permissions: [], signal: AbortSignal.timeout(60_000) }), text, shape, preset);
      return answer;
    } finally {
      store.finish(run.id, answer?.status === "resolved" ? "completed" : "failed", answer?.status === "refused" ? answer.reason : "");
    }
  });
  runtime.journal = journalHook(journal, (text) => runtime.hideSecrets(text)); // mac3/never-break: nothing secret is written down
  // FQ-execution.browser: a tool's own steps (a browser.flow click) are judged as the tool they stand for.
  registry.judgeStep = (tool, args, context, target, index) => runtime.judgeStep(tool, args, context, target, index);
  // FQ-execution.browser: consume the one-time yeses after all flow steps pass judgment.
  registry.takeStepYeses = (fingerprints, context) => runtime.consumeStepYeses(fingerprints, context);
  // mac7/walk-rules: a task's folder walks are held to its rules for every file and folder (src/walk-rules.ts).
  files.walkRules = (outside) => {
    const runId = currentTaskRun(), tool = currentTool();
    if (!runId && !tool && !outside) return allowAll; // the owner's own window
    return runtime.pathCheck({ tool: tool ?? "files.list", runId: runId || undefined, source: outside?.source });
  };
  runtime.artifacts = artifacts;
  runtime.attachments = attachments;
  // mac7/coding-next: "Let Branch run this project's tests?", answered through the ordinary questions.
  codeChanges.testsPermission = (context, folder) => projectTestsVerdict({ store, owner: runtime.owner,
    approvals: runtime.approvals, sessionId: runtime.approvalSessionOf(context),
    allowedForThisRun: allowedForThisRun(store, runtime.owner, context) }, folder); // mac7/tests-unattended: --allow-tests
  // Locking the app: after a quiet spell the locker stays shut until the owner unlocks it again.
  const sessionLock = new SessionLock(store, runtime.owner);
  store.secrets.gate = () => sessionLock.require();
  // Batch 26 (wave 8): the owner's own password manager, asked at the call boundary and only when
  // they have switched it on. It waits for the same unlock the locker does.
  const credentials = new CredentialResolver(store, runtime.owner, store.secrets.scrubber);
  credentials.gate = () => sessionLock.require();
  store.secrets.credentials = credentials;
  // Batch 20 (wave 8): a password fetched by a command of the owner's own, behind the same lock.
  const commandSecrets = new CommandSecrets(store, runtime.owner, store.secrets.scrubber);
  commandSecrets.gate = () => sessionLock.require();
  store.secrets.sources.push(commandSecrets);
  // Wave mac1: the Keychain on a Mac, for the entries the owner listed, behind the same lock.
  const keychainSecrets = new KeychainSecrets(store, runtime.owner, store.secrets.scrubber);
  keychainSecrets.gate = () => sessionLock.require();
  store.secrets.sources.push(keychainSecrets);
  const knowledge = new Knowledge(store, registry, runtime);
  // Facts are found by their words and, where the provider allows it, by meaning; the most useful come first.
  const memory = {
    retrieval: new MemoryRetrieval(store, runtime.models),
    hygiene: undefined as unknown as MemoryHygiene,
    tidy: undefined as unknown as MemoryTidy,
    // FQ-memory.providers: set once `web` exists, below — an outside memory service can then
    // replace this computer's database rather than only sit beside it.
    backend: undefined as unknown as MemoryProvider,
    transfer: new MemoryTransfer(store),
  };
  memory.hygiene = new MemoryHygiene(store, memory.retrieval);
  memory.tidy = new MemoryTidy(store, memory.hygiene, memory.retrieval);
  registerMemoryTidy(registry, memory.tidy);
  // "Tidy my memory" arrives as a recipe the owner can look at and check, like any other.
  try { shipTidyProcedure(store, runtime.owner); } catch { /* an older store simply keeps what it has */ }
  // What goes in front of a task is taken layer by layer in the documented order and budget: what
  // is happening now, then the job in hand, then everything the assistant knows for good.
  // mac2/fly-core-2: with the learning core "on", the facts that helped in similar tasks go first.
  store.review.orderFacts = (factOwner, agent, sessionId) =>
    chooseForInjection(advisedFacts(sessionId, memory.retrieval.ranking(factOwner, agent).map((entry) => entry.record)), knobSnapshotLimits(store, runtime.owner)).records;
  // ── R17-S-B: the owner's memory budget and the leak guard's sensitivity, read fresh each time. ──
  store.review.snapshotLimits = () => knobSnapshotLimits(store, runtime.owner);
  runtime.leakGuard.options = () => leakOptions(store, runtime.owner);
  // ── end R17-S-B ──
  syncMixtures(store, runtime.owner, runtime.models); // R17-051: none until the owner makes one
  registerHistory(registry, store);
  registerSessions(registry, store);
  const sessionTree = new SessionTree(store.sqlite);
  registerSessionTree(registry, store, sessionTree);
  // Wave mac2 (goal-undo): a hidden snapshot of the workspace before each task, kept in the private
  // data folder, so an earlier message can take back files and conversation together; and goal mode.
  const snapshots = new SnapshotStore(join(dataDir, "snapshots"), workspace,
    options.snapshotGit === undefined ? systemGit() : options.snapshotGit);
  const rewinds = new Rewinds(store.sqlite, runtime.owner, sessionTree, history, snapshots, files,
    () => goalUndoSettings(store, runtime.owner).snapshots,
    (tool) => { const permission = registry.permissionOf(tool); return permission !== "" && !isReadOnlyPermission(permission); });
  runtime.turnStarted = (run) => rewinds.turnStarted(run);
  const goals = new GoalMode(runtime, store);
  registerSkills(registry, store);
  registerContextFiles(registry, store);
  documents = new DocumentLibrary(store, runtime.models, files);
  registerDocuments(registry, documents);
  runtime.documents = documents;
  registry.register({
    name: "user.ask", permission: "user.ask",
    description: "Stop and ask the person a question when you cannot proceed without their answer. The task pauses; their next message in this conversation is the answer.",
    parameters: z.object({ question: z.string().trim().min(1).max(2000) }).strict(),
    execute: async ({ question }) => {
      const asked = new NeedsInputError(question);
      asked.spoken = true;
      throw asked;
    },
  });
  // Handing something to the person and carrying on: the plainest deferred tool call there is.
  registerHumanTasks(registry);
  registerKnowledge(registry, knowledge);
  // Working with several specialists at once, handing work over, and the shared scratch area.
  registerOrchestration(registry, runtime, knowledge);
  // Batch 26 (wave 8): a supervisor over named workers, a swarm over one shared list, and a router
  // that sorts a request to the one specialist it belongs to.
  registerOrchestrationModes(registry, runtime, knowledge);
  registerSecondOpinion(registry, runtime);
  const web = new WebAccess(options.web ?? {}, globalThis.fetch, `BranchAgent/${String(createRequire(import.meta.url)("../package.json").version)}`);
  // Q12: Branch changing its own source is held to a contract written before anything changes.
  const selfContracts = new ContractBook(store.sqlite);
  // Branch builds Branch: a coding job handed to the owner's own Claude Code or Codex, inside one folder (src/coding/hand-off.ts).
  registerHandOff(registry, new HandOff({ store, owner: runtime.owner, workspace, dataDir, book: selfContracts,
    git: (options, signal) => gitRunner.run(options, signal) }));
  // FQ-memory.providers: an outside memory service the owner switches on in Settings replaces this
  // computer's database for the assistant's remember/recall/forget loop, not only sits beside it —
  // src/memory-provider.ts reads the owner's choice fresh on every call, and web.policy is the same
  // guard every other outside address in Branch is checked against.
  memory.backend = new MemoryProvider(store, new SqliteMemoryBackend(store), web.policy, globalThis.fetch,
    async (name) => (await store.secrets.resolve(runtime.owner, store.projects.active(runtime.owner).id, [name], { purpose: "an outside memory service" }))[name]!);
  // An accepted put/update/delete suggestion in the Memory review screen goes wherever memory.put/
  // update/delete themselves would go right now, rather than always landing in this computer's
  // database — see the comment on `MemoryReview.provider`.
  store.review.provider = memory.backend;
  registerMemory(registry, store, memory.retrieval, memory.backend);
  const selfDevelopment: SelfDevelopmentDeps = {
    workspace, owner: options.owner ?? "local", projects: store.projects, registry, policy: web.policy,
    git: (input, signal) => gitRunner.run(input, signal), contracts: selfContracts, store,
  };
  offerSelfDevelopment(selfDevelopment);
  // A change to Branch itself asked for from a chat: the chat only files it, and only the owner answers,
  // in the Branch app; a yes is prepared exactly as the owner's own (src/self-development-requests.ts).
  const sourceRequests = new SourceChangeRequests(selfDevelopment);
  offerSourceRequests(runtime, sourceRequests);
  const contractChecks = { store, owner: options.owner ?? "local", workspace, registry, book: selfContracts,
    git: (input: GitRunOptions, signal: AbortSignal) => gitRunner.run(input, signal) };
  registry.beforeTool = contractGuard(contractChecks);
  const selfDevelopmentPreflight = contractPreflight(contractChecks);
  registerWeb(registry, web, (context, info) => { if (context.runId) store.event(context.runId, "content.flagged", info); });
  // ── R17-S-C (comfort): the owner's proxy and extra certificates for every call Branch makes, and
  // which ignore files hide paths from searches (src/comfort/). Both do nothing until set. ──
  const outbound = new OutboundNetwork();
  outbound.apply(readComfort(store, runtime.owner, "network"));
  workspaceSearch.ignoreChoice = projectMap.search.ignoreChoice = () => readComfort(store, runtime.owner, "files");
  // ── end R17-S-C ──
  // ---- wave mac3 (os-sandbox): the wall's door asks the same network rules as the web, and never
  // lets a program behind the wall read Branch's own data folder.
  setWallEdge(store, { siteCheck: (target) => web.policy.assertAllowed(target),
    fakeIpProxy: () => web.policy.settings().fakeIpProxy === true, dataDir });
  // ---- end wave mac3 (os-sandbox)
  // A paid search service's key comes out of the locker for the one request and is written down
  // nowhere else: the settings file only ever holds the name of the secret, never its value.
  web.searchKey = async (name: string) => {
    const project = store.projects.active(runtime.owner).id;
    const value = (await store.secrets.resolve(runtime.owner, project, [name], { purpose: "web search" }))[name]!;
    audit(store, runtime.owner, { action: "secret.used", actor: "the search service you chose", subject: `${name} (project ${project})`,
      reason: "Searching the web needed it", outcome: "handed over" });
    return value;
  };
  // Batch 19 (wave 7): the model services the owner added from the catalog are built again from
  // what was written down, with each key taken out of the locker, so they survive a restart.
  await restoreConnections({
    models: runtime.models, locker: store.locker, owner: runtime.owner, policy: web.policy, store,
  });
  // ---- Wave mac5 (local models) hook: off by default; see src/local-kit.ts. ----
  await startLocalModels({ store, owner: runtime.owner, models: runtime.models, policy: web.policy, dataDir });
  // ---- end wave mac5 hook ----
  // Pictures, speech and what a video's headers say. Every one of these refuses in plain words
  // when the connected model has no such service, and keeps what it makes beside the database.
  // A service that describes itself in OpenAPI becomes tools, one per operation the owner allows.
  const openApiTools = new OpenApiTools(registry, { store, policy: web.policy, files });
  // ---- bucket-18: open pull-request hook (A0300); off until the owner switches it on ----
  const pullRequestStop = new AbortController();
  const pullRequestWork = new Set<Promise<unknown>>();
  const pullRequestDeps: PullRequestDeps = {
    store, owner: runtime.owner, files, policy: web.policy, registry,
    git: (options, signal) => gitRunner.run(options, AbortSignal.any([signal, pullRequestStop.signal])),
    // mac5/manual-actions: inside a task the call that got here was already gated as a whole; the
    // hook working by itself after a task is held to the full rules, "ask" included.
    runTool: (name, args, runId) => runtime.executeTool(name, args, { mode: runId ? "owner" : "policy" }),
    // Integration review: the same gate, asked before anything is pushed.
    // Q12: and, inside a self-development worktree, the contract must list the pull request step too.
    preflight: (name, args, runId) => {
      const context = runtime.context(runId ? { runId } : {});
      return gateRefusal(runtime, name, args, context, argumentFingerprint(JSON.stringify(args ?? {})), runId ? "owner" : "policy")
        ?? selfDevelopmentPreflight(name, args, context);
    },
    // Integration review: Branch's saved work and keys never leave in a pull request.
    guard: (path) => protectedTarget({ tool: "files.read", readOnly: true, args: { path }, target: path, workspace: files.base }, runtime.protectedAreas),
  };
  const stopOfferingPullRequests = offerPullRequestFromChanges(pullRequestDeps);
  const stopPullRequests = watchFinishedTasks(pullRequestDeps, (work) => {
    const pending = work().catch(() => undefined);
    pullRequestWork.add(pending);
    void pending.finally(() => pullRequestWork.delete(pending));
  });
  // ---- end of the pull-request hook block ----
  registerOpenApiTools(registry, openApiTools);
  // Batch 20 (wave 8): the services the owner turned into tools are built back from what was
  // written down, so they survive a restart. Nothing is fetched; each key still comes from the
  // locker at the moment of the call.
  openApiTools.restore(runtime.owner);
  const media = new MediaTools(store, files, runtime.models, web.policy, globalThis.fetch);
  media.artifacts = artifacts;
  registerMedia(registry, media);
  // Wave 7: one place that turns speech into words and words into speech, whichever service does
  // the work, plus switching model in one conversation. Voice notes on chat apps come through here.
  const voice = new VoiceService(store, runtime.models, web.policy, web.policy.guard(globalThis.fetch));
  // Wave 8: live conversations. Every connection that stays open leaves a span and a line in the
  // record of what the assistant was allowed to do — the host and the path only, never the whole
  // address, because a key can travel in the query string.
  const live = new LiveConversations({ store, runtime, models: runtime.models, policy: web.policy, owner: runtime.owner });
  // A live conversation belongs to one task. When that task finishes for any reason, the
  // conversation and the socket it holds finish with it rather than being left open.
  registry.onRunFinished(async (context) => { if (context.runId) live.stop(context.runId, "The task ended"); });
  web.policy.watchSockets = (record, outcome, reason) => {
    const span = runtime.tracer.start(record.runId ?? "", "delivery", `live connection to ${record.host}`, {
      host: record.host, path: record.pathname, what: record.what, outcome,
    });
    span?.end(outcome === "refused" ? "error" : "ok", reason);
    audit(store, runtime.owner, {
      action: "network.connected", actor: runtime.owner, subject: `${record.host}${record.pathname}`,
      reason: record.what, source: "owner", runId: record.runId, outcome,
    });
  };
  registerVoice(registry, voice, store);
  registerModelSwitch(registry, store, runtime.models);
  media.voice = voice;
  // Bucket 17 hook: videos understood through the owner's own ffmpeg and yt-dlp, and speech plug-ins.
  const understanding = new MediaUnderstanding({ store, media, policy: web.policy });
  registerMediaUnderstanding(registry, understanding);
  registerTroubleshoot(registry, runtime); // w911 (A0374) hook: the troubleshoot.run tool (switched, off by default).
  voice.engines = new SpeechEngineService({
    store, registry: builtInSpeech(), policy: web.policy, fetch: web.policy.guard(globalThis.fetch),
    secret: async (owner, name, purpose) =>
      (await store.secrets.resolve(owner, "default", [name], { purpose }).catch((error: Error) => {
        if (/is not available/.test(error.message)) return {} as Record<string, string>;
        throw error;
      }))[name] ?? null,
  });
  const channels = new ChannelRouter(store, runtime);
  channels.transcribeVoice = async (clip) => (await voice.transcribe(runtime.owner, clip)).text;
  channels.speakReply = async (text) => {
    const settings = voice.settings(runtime.owner);
    // "Keep audio on this computer" wins over every other voice choice, including this one: a
    // spoken reply made here would still be uploaded to the chat app, and the Voice screen tells
    // the owner nothing containing sound leaves. The words are sent instead, as they always are.
    if (!settings.replyWithVoiceOnChannels || settings.keepAudioOnThisComputer) return null;
    const spoken = await voice.speak(runtime.owner, { text: text.slice(0, 1500), voice: "", speed: 1 });
    return { bytes: spoken.bytes, mediaType: spoken.mediaType };
  };
  // Personal details and, when the owner switches it on, a content check, either side of the model.
  const moderation = new Moderation({}, web.policy, web.policy.guard(globalThis.fetch),
    (reference) => store.secrets.fill(runtime.owner, "default", reference, { purpose: "content check" }));
  const privacy = new PrivacyGuard(store, runtime.owner, moderation);
  moderation.configure(privacy.settings().moderation);
  // Wave 8 (the long tail): while Lockdown is on, nothing is sent out of a messaging account at all.
  channels.outboundGuard = async (text) =>
    lockedDown(store, runtime.owner)
      ? { text: "", blocked: true, reason: lockdownRefusal }
      : privacy.outbound(text);
  // Wave mac2 (chat-live): typing, reactions and progress messages stop under Lockdown as well.
  channels.liveAllowed = () => !lockedDown(store, runtime.owner);
  // ...and nothing key-shaped or secret shows in a step label or streamed text (mac2/leak-guard).
  channels.hideLeaks = (text) => redactLeaksIn(store.secrets.scrubber.deep(text)).value;
  runtime.hideSecrets = (value) => {
    // mac2/leak-guard: key-shaped values nobody looked up are hidden in logs and question cards too.
    const scrubbed = redactLeaksIn(store.secrets.scrubber.deep(value)).value;
    // The privacy settings live in the database; a failure reported while the app is closing
    // must still go out scrubbed rather than throw a second time from inside the error path.
    try { return privacy.inbound(scrubbed); } catch { return scrubbed; }
  };
  // Spans are written straight to their own table rather than through the event log, so the same
  // scrubber is put in front of them explicitly: no attribute can carry a saved password or key.
  runtime.tracer.scrub = (value) => runtime.hideSecrets(value);
  // Locking Branch ends every "yes, for this conversation" as well as closing the secrets locker,
  // and lets go of anything an integration was holding on the owner's behalf — above all a browser
  // of theirs a task had borrowed.
  const releaseOnLock: (() => Promise<unknown>)[] = [];
  /**
   * Integration review (mac7/wake-mic): what comes back by itself when the lock ends. Letting go on
   * the lock has to be answered here or it is one-way, and the owner is left with a part of Branch
   * silently off until some setting happens to be saved.
   */
  const resumeOnUnlock: (() => void)[] = [];
  sessionLock.onUnlock = () => { for (const resume of resumeOnUnlock) { try { resume(); } catch { /* one part coming back must not stop the rest */ } } };
  sessionLock.onLock = () => {
    runtime.approvals.forgetAll();
    // Wave 8: a connection that stays open would otherwise outlive the lock. Every live
    // conversation ends, and every outbound socket with it.
    live.closeAll("Branch was locked");
    for (const release of releaseOnLock) void release().catch(() => undefined);
  };
  releaseOnLock.push(async () => runtime.keepAlive.stop()); // R17-050 (integration review): locking Branch stops cache pings
  // Signing in to outside services the ordinary way, with the answer coming back to this computer.
  const oauth = new OAuthConnections(runtime.owner, store.secrets, web.policy, web.policy.guard(globalThis.fetch));
  // accounts-wizard-plans: the coding assistants and the Gemini sign-in the owner added come back (src/accounts/saved-sign-ins.ts).
  await restoreSignIns({ store, owner: runtime.owner, models: runtime.models, oauth });
  const hooks = new Hooks(store, runtime.owner);
  const teams = new Teams(store, runtime.owner);
  const version = String(createRequire(import.meta.url)("../package.json").version);
  const userAgent = `BranchAgent/${version}`;
  // Wave 7: one finished task's full record, in the documented trajectory shape.
  registerRunExport(registry, store, version);
  const skillRegistry = new SkillRegistry(store, runtime.owner, web.policy);
  // Skill packages people can hand to each other, and single-file plugins the owner switches on.
  const skillPackages = new SkillPackages(store, runtime.owner, registry, { store, policy: web.policy });
  skillPackages.replayRecipe = (recipe, _event, runId) => replayNamedRecipe(knowledge, store, runtime, recipe, runId);
  const packageProblems = skillPackages.restore();
  // Model connections a plugin brought; nothing is registered until a plugin is switched on, so
  // this has to exist before the plugins the owner already chose are loaded back.
  const providerPlugins = new ProviderPlugins(runtime.models, web.policy, globalThis.fetch, userAgent);
  const plugins = new Plugins(store, runtime.owner, registry, join(dataDir, "plugins"));
  plugins.providers = providerPlugins;
  // Chat services a plugin brought, registered the same way a model connection is: available to
  // connect, never connected on the plugin's own say-so.
  const lockerSecret = (purpose: string) => async (name: string) =>
    (await store.secrets.resolve(runtime.owner, "default", [name], { purpose }))[name]!;
  const channelConnectors = new ChannelConnectors(channels, web.policy, lockerSecret("channel"), globalThis.fetch);
  plugins.channels = channelConnectors;
  // Where plugins come from: a folder or one file on this computer, shown in full before it is
  // copied in, with its fingerprint kept so a file that changes later is noticed.
  const pluginCatalog = new PluginCatalog(store, runtime.owner, join(dataDir, "plugins"));
  // ── bucket-15: add-ons other people wrote (src/add-ons/). Every part ships off; a plugin from a
  // package runs walled, so this has to be set before the plugins the owner chose are loaded back. ──
  // The malware check lives in the security service, made further down; until it is there, a look
  // at a package is refused in a sentence rather than reaching a name that does not exist yet.
  let vetAddOn: (command: string, args: readonly string[]) => Promise<void> = async () => {
    throw new Error("Branch is still starting, so the malware check is not ready. Try again in a moment.");
  };
  const addOns = new AddOns({ store, runtime, registry, plugins, dataDir, policy: web.policy,
    vet: (command, args) => vetAddOn(command, args),
    secret: async (name) => (await store.secrets.resolve(runtime.owner, "default", [name], { purpose: "pipelines" }).catch(() => ({} as Record<string, string>)))[name] ?? null });
  // ── end bucket-15 ──
  // Drafts of better versions of a skill, tried against real tasks as a practice run first.
  const skillRevisions = new SkillRevisions(store, runtime.owner);
  registerSkillSync(registry, store, files);
  // ── mac3/reflection-skills: the learning loop, its runtime hook, and what accepting a skill note does. ──
  const learningLoop = new LearningLoop(store, runtime, registry, runtime.owner);
  attachLearningLoop(runtime, learningLoop);
  store.review.applySkillNote = (noteOwner, proposal) => learningLoop.notes.apply(noteOwner, proposal);
  const pluginProblems = await plugins.restore();
  const evaluation = new Evaluation(store, runtime.owner);
  const triggers = new Triggers(store, runtime);
  // mac6/bucket-16: automations started by Slack's own events; off until the owner turns them on.
  const slackAutomations = new SlackAutomations(store, () => runtime.owner, (id, payload) => triggers.fire(runtime.owner, id, payload),
    undefined, (channelId, user) => channels.senderAllowed(channelId, user));
  const webhooks = new Webhooks(store, web.policy);
  // One trace crosses the boundary: a delivery and a question to another assistant both carry the
  // traceparent of the task behind them.
  webhooks.traceparentFor = (runId) => runtime.tracer.traceparent(runId);
  // A webhook's signing key lives in the locker with the other secrets, named rather than copied.
  webhooks.secretFor = lockerSecret("webhook");
  // Wave 8: while Lockdown is on, no note about what happened reaches another program either.
  const notify = webhooks.notifier(runtime.owner);
  const guardedNotify: typeof notify = (event, payload) => {
    if (!lockedDown(store, runtime.owner)) notify(event, payload);
  };
  runtime.notifyEvent = guardedNotify;
  channels.deliveries.notifyEvent = guardedNotify;
  store.onEvent((runId, kind, data) => hooks.fire(kind, runId, data));
  watchSetupOrigin(store); // setup polish 2: what setup causes is never counted toward achievements
  // Batch 26 (wave 8): the owner's own checks get a say before a tool call goes ahead, and may only
  // make the answer stricter — hold it for a yes, or refuse it.
  runtime.askHooks = (runId, about) => hooks.decide(runId, about);
  // Wave mac2 (goal-undo): with snapshots "when needed", the workspace is recorded just before a
  // task's first call that can change something, then the owner's own checks are asked as before.
  const decideHooks = runtime.askHooks;
  runtime.askHooks = async (runId, about) => {
    await rewinds.beforeChange(runId, String(about.tool ?? ""));
    return decideHooks(runId, about);
  };
  // Batch 26 (wave 8): the owner's own task waits for its window to free up; somebody messaging from
  // outside is told in one sentence and their message is let go. Both are written into the record.
  runtime.sessionCeiling = (sessionId, tokens) =>
    sessionLimiter.check({ scope: "conversation", id: sessionId, tokens }, "owner");
  channels.senderCeiling = (channel, senderId) =>
    sessionLimiter.check({ scope: "sender", id: `${channel}:${senderId}` }, "stranger");
  const scheduler = new Scheduler(store, runtime, (channel, chatId, text, key) => channels.deliver(channel, chatId, text, key));
  registerSchedules(registry, scheduler);
  // wave mac2 (quiet-jobs follow-up): a program left running that finishes wakes the check-in; wake() does nothing while it is off.
  processes.finished.add(() => { void scheduler.heartbeat.wake("a background command finished").catch(() => undefined); });
  // Figures, looking things up properly, watching pages, and the one message first thing.
  const deliverMessage = (channel: string, chatId: string, text: string, key: string) => channels.deliver(channel, chatId, text, key);
  const dataTables = new DataTables(files, web, writeObserver);
  registerData(registry, dataTables, artifacts);
  // Writing Word, spreadsheet, slide, Markdown and web-page files, and changing Word and
  // spreadsheet files in place with every untouched part kept byte for byte.
  registerDocumentAuthoring(registry, new DocumentAuthoring(files, dataTables, artifacts, writeObserver));
  // Asking a question of one document, and holding two up against each other. Tables inside a
  // document are opened as figures, so the spreadsheet tools above can be pointed straight at them.
  const documentAnalysis = new DocumentAnalysis(files, dataTables, runtime.models);
  registerDocumentAnalysis(registry, documentAnalysis);
  const research = new Research(store, web, files, documents, writeObserver);
  // bucket-18 (A2128): research reads a page built by script with the browser, when one is set up.
  research.pageFallback = async (url, context) => {
    const names = registry.names();
    if (!names.includes("browser.navigate") || !names.includes("browser.snapshot") || !context.permissions.has("browser.read")) return null;
    // Integration review: only where the owner's approval rules already let the browser open this page
    // without asking; a rule that asks (or refuses) leaves the plain read's answer standing.
    for (const [tool, args] of [["browser.navigate", { url }], ["browser.snapshot", {}]] as const)
      if (runtime.checkPolicy(tool, args, context).decision !== "allow") return null;
    await registry.execute("browser.navigate", { url }, context);
    const snapshot = await registry.execute("browser.snapshot", {}, context) as { url?: string; accessibility?: string };
    return { url: snapshot.url ?? url, title: snapshot.url ?? url, text: String(snapshot.accessibility ?? "") };
  };
  registerResearch(registry, research);
  // Q141: a watch a Trunk made sends to its chat only while that Trunk may still send to chats, asked of the Trunk
  // as it is now. A Trunk that is gone, or that cannot be asked here, may not, so its news is kept in the app.
  const watchTrunks = {
    atWork: () => runtime.trunkAtWork(),
    maySend: (trunkId: string) => {
      // Q153: nor while Trunks are switched off, as a Trunk's own schedule does not run then (Q146).
      if (trunkMode(store, runtime.owner, "trunks") === "off") return false;
      try { return runtime.trunkShape({ prompt: "", trunkId })?.permissions.includes("channels.send") ?? false; }
      catch { return false; }
    },
    // While Trunks are switched off, the news a Trunk's watch keeps says so, not that the Trunk may no longer send.
    offReason: () => (trunkMode(store, runtime.owner, "trunks") === "off" ? trunksSwitchedOff : null),
  };
  const monitors = new Monitors(store, web, deliverMessage, watchTrunks);
  registerMonitors(registry, monitors);
  // Wave 8: watching one rectangle of the screen for a change. Off unless the owner switches it on
  // AND has using the screen switched on; the picture is never kept, only a fingerprint of it.
  const screenWatches = new ScreenWatches(store, (region) => desktop.captureRegion(region),
    () => desktop.enabled(runtime.owner), deliverMessage, watchTrunks);
  registerScreenWatches(registry, screenWatches);
  const brief = new MorningBrief(store, monitors, documents, deliverMessage);
  registerBrief(registry, brief);
  // Sending on the assistant's own initiative: one message to several chats, and the brief on demand.
  registerChannelTools(registry, channels, brief, store.profiles);
  scheduler.onTick.add(async (now) => { await monitors.tick(runtime.owner, now); await brief.tick(runtime.owner, now); });
  // Wave 7: once a night, a plain-language look at how the assistant is finding its tools.
  scheduler.onTick.add(async (now) => { catalogHealthTick(store, runtime.owner, now); });
  // Test suites kept as data, their history, and comparing one suite across model choices.
  const evaluationSuites = new SuiteRunner(store, runtime, version);
  scheduler.evaluations = evaluationSuites;
  // Wave 7: written-down experiments — a benchmark or suite across several model choices, run
  // several at a time, checkpointed so a stopped study carries on rather than starting again.
  const studies = new StudyRunner(store, runtime, version);
  // Wave 9: the same scorers held against real work rather than a test set. Off until switched on,
  // and never the scorer that asks a model, so ordinary tasks are never billed twice.
  const stopLiveScoring = watchFinishedRuns(store, runtime.owner, () => runtime.workspace);
  // Wave 6: labels and project notes, durable workflows, the waiting line, and days off and quiet hours.
  registerLabels(registry, store.labels);
  const workflows = new Workflows(store, runtime, knowledge);
  registerWorkflows(registry, workflows);
  // The same workflows seen as boxes and arrows, with a way in over HTTP and a note sent out as
  // each box finishes.
  const flows = new Flows(store, runtime.owner, workflows, runtime);
  flows.notifyEvent = guardedNotify;
  registerFlows(registry, flows);
  // Bucket 21: tools for people building on Branch (switched off until the owner turns them on).
  registerSdkKit(registry, store);
  // w911 (A0743, A1452) hook: web.page and web.crawl (switched off until the owner turns them on).
  const webPages = new WebPages({ store, web, registry, runtime }); registerWebPages(registry, webPages);
  // "workflows.resume" is the one way in for carrying anything saved on, a graph flow included, so
  // the schedules toolbox does not grow a second tool that says the same thing.
  workflows.resumeGraph = (id, within, source) => (flows.isGraph(id) // mac7/lockdown-fix: within; mac7/outside-resume: source
    ? flows.resumeGraph(id, { ...(within ? { within } : {}), ...(source ? { source } : {}) }) : null);
  // Wave 8: a plain list of what is still to be done — the assistant's plan and the owner's own
  // items in one place, with a due day handed on to the schedules rather than timed here.
  const todos = new Todos(store.sqlite);
  // Pages with names, and links between them written [[like this]] (src/wiki.ts).
  const wiki = new Wiki(store.sqlite);
  registerWiki(registry, wiki, runtime.owner, store);
  registerTodos(registry, todos, runtime.owner);
  // --- mac3/never-break: with the switch on, the assistant may suggest gateway settings (never apply them) ---
  if ((await loadGatewayConfig(dataDir)).config.mode !== "off")
    registerNeverBreak(registry, dataDir, gatewayDryRun(fileURLToPath(new URL("./cli.js", import.meta.url))));
  // --- end mac3/never-break ---
  // Wave 8: the owner's notes folder, written into and read back from. A folder bridge, not an
  // Obsidian plugin: Obsidian keeps ordinary Markdown in an ordinary folder.
  const obsidian = new ObsidianBridge(store, runtime.owner);
  // mac7/walk-rules: a notes folder inside the workspace is held to the rules like any other folder.
  obsidian.readRules = () => byFullAddress(new WalkRules(files.walkRules()), files.base);
  registerObsidian(registry, obsidian);
  // One count of what is working at once, shared by the web routes and the waiting line.
  const executions = new ExecutionLimit();
  const runQueue = new RunQueue(store, runtime, executions);
  // Whenever anything finishes — a task from the line or a request from the app's own screen — the
  // line is looked at again, so a task never sits waiting for room that is already there.
  executions.onRoom = () => {
    try { runQueue.drain(runtime.owner); } catch { /* the line must never break a finished request */ }
  };
  // Batch 20 (wave 8): a study's cells are work like any other, so they take places from the same
  // count. The study runs its first cell on the place it already holds, so it can never be starved.
  studies.executions = executions;
  const calendar = new CalendarSettingsStore(store, dataDir);
  await calendar.seed();
  scheduler.calendar = calendar;
  channels.deliveries.holdUntil = (at) => calendar.holdUntil(runtime.owner, at);
  const chatgpt = options.chatgpt;
  if (chatgpt) {
    await chatgpt.load();
    syncChatGPTPresets(runtime.models, chatgpt, (await chatgpt.status()).signedIn, userAgent);
  }
  // ---- mac6/accounts: several accounts per connection (src/accounts/); off by default ----
  await startAccounts({
    store, owner: runtime.owner, models: runtime.models, policy: web.policy, dataDir, userAgent,
    ...(chatgpt ? { chatgpt } : {}),
  });
  // ---- end mac6/accounts ----
  // Nothing is shared with other AI tools until the owner turns it on in Settings.
  const mcpServer = await startMcpServer(registry, store, runtime, knowledge, files);
  // Integration (mac7/walk-rules): another program is not told the name of a document the owner's rules refuse.
  mcpServer.documents = { list: (who: string) => documents.listFor(who, { source: "mcp" }).documents as unknown[] };
  // Somebody else's AI-tool server is opened only when a task first needs it, and closed when that
  // task ends. Each household profile keeps its own settings for how long and how many.
  const mcpConnections = new McpConnections(store, () => store.profiles.scope());
  registry.onRunFinished(async (context) => mcpConnections.releaseRun(context.runId));
  registerMcpTools(registry, store, files.base, mcpConnections);
  // Talking to assistants elsewhere: answering them (A2A server) and handing them work (A2A client).
  const a2a = new A2aServer(store, runtime, registry, mcpServer, version);
  const remoteAgents = new RemoteAgents(store, runtime.owner, web.policy, globalThis.fetch);
  remoteAgents.traceparentFor = (runId) => runtime.tracer.traceparent(runId);
  registerRemoteAgents(registry, remoteAgents);
  // Documents and saved facts are both asked the same way, and the best answer is put first.
  const retrieval = new Retrieval(store, runtime.owner, runtime.models);
  // What is put in front of a task, in order: see src/context-providers.ts.
  const contextProviders = new ContextProviders();
  retrieval.add(new DocumentRetriever(documents));
  retrieval.add(new MemoryRetriever(memory.retrieval));
  documents.reranker = (owner, query, passages, signal) => retrieval.order(owner, query, passages, signal);
  // Knowledge bases. Reading passages is charged to the task that asked for it, exactly the way a
  // model answer is; background reading has no task, so it is recorded as an event instead.
  // Batch 20 (wave 8): every passage sent to a provider that is not on this computer goes through
  // the owner's network rules, exactly as every other provider call does. A reader running here is
  // reached directly, because those rules refuse local addresses on purpose.
  const guardedFetch = web.policy.guard(globalThis.fetch);
  documents.embeddingFetch = guardedFetch;
  memory.retrieval.embeddingFetch = guardedFetch;
  const knowledgeBases = new KnowledgeBases(store, files, runtime.models,
    { charge: (runId, tokens) => store.addUsage(runId, tokens, 0, undefined, false) }, undefined, guardedFetch);
  knowledgeBases.reranker = (owner, query, passages, signal) => retrieval.order(owner, query, passages, signal);
  // Wave 9: the vectors go wherever the owner asked. A file that cannot be opened is one sentence on
  // the Documents panel and Branch's own database carries on holding them, so nothing is ever lost.
  {
    const chosen = chooseVectorStore(knowledgeBases.vectorStoreSettings(runtime.owner), knowledgeBases.vectors);
    knowledgeBases.vectors = chosen.backend;
    knowledgeBases.backendNote = chosen.note;
  }
  registerKnowledgeBases(registry, knowledgeBases, store, runtime.models);
  // What was said in a conversation, written up as fact cards the owner can accept into a
  // knowledge base. Accepting one indexes it exactly like a passage from a file.
  const knowledgeCards = new KnowledgeCards(store, knowledgeBases, runtime.models);
  registerKnowledgeCards(registry, knowledgeCards);
  store.review.acceptCard = (cardOwner, card) => knowledgeBases.addCard(cardOwner, card.collection,
    { title: card.title, body: card.body, source: card.sourceTurn });
  retrieval.add(new KnowledgeRetriever(knowledgeBases));
  // A summary of a whole knowledge base, a map of the names it mentions, pictures described in
  // words, and the housekeeping: renaming, merging, splitting, saving out and bringing back.
  const knowledgeGraph = new KnowledgeGraph(store, knowledgeBases, runtime.models);
  const knowledgeSummaries = new KnowledgeSummaries(store, knowledgeBases, runtime.models);
  const knowledgeManagement = new KnowledgeManagement(store, knowledgeBases, knowledgeSummaries);
  const knowledgePictures = new KnowledgePictures(store, knowledgeBases, files, runtime.models);
  const knowledgeParts: KnowledgeParts = { bases: knowledgeBases, graph: knowledgeGraph,
    summaries: knowledgeSummaries, management: knowledgeManagement, pictures: knowledgePictures,
    cards: new KnowledgeCards(store, knowledgeBases, runtime.models) };
  registerKnowledgeExtras(registry, knowledgeParts, store);
  // ── mac7/learn: "Understanding something" -- a map of a folder of code or a knowledge base and a
  // guided walk through it, every claim carrying the line or passage it came from. Ships off. ──
  const learn = new Learn({ store, registry, owner: runtime.owner, models: runtime.models,
    bases: knowledgeBases, project: projectMap,
    language: () => lookLanguage(readLook(store, runtime.owner), process.env) });
  registerLearn(registry, learn);
  // ── end mac7/learn ──
  // One hop through that map is another way of finding passages, beside words and meaning.
  retrieval.add(new GraphRetriever(knowledgeGraph, knowledgeBases));
  // Text pasted in for one job: searchable while the job runs, gone the moment it ends.
  const taskText = new EphemeralDocuments();
  registerEphemeralDocuments(registry, taskText);
  retrieval.add(new EphemeralRetriever(taskText));
  // What the assistant remembers, mirrored into the workspace as Markdown it may read but not change.
  const memoryMirror = new MemoryMirror(store, files);
  registerMemoryMirror(registry, memoryMirror);
  files.readOnly = (path) => (memoryMirror.owns(path) ? readOnlyRefusal : "");
  // And a knowledge base never reads those notes back in: they are the assistant's own writing.
  knowledgeBases.skip = (path) => memoryMirror.owns(path);
  // bucket-18: memory history (A2317): what is remembered, committed to a private repository in the data folder.
  const memoryHistory = new MemoryHistory(dataDir, store, memoryMirror, (options, signal) => gitRunner.run(options, signal), web.policy);
  registerMemoryHistory(registry, memoryHistory, runtime.owner);
  // Saved facts are read through the same store of already-read passages, so nothing is sent twice.
  memory.retrieval.wrapEmbedder = (embedder) => new CachedEmbeddings(asEmbeddings(embedder), knowledgeBases.cache);
  const consolidation = new MemoryConsolidation(store, memory.retrieval, memory.hygiene);
  // Facts written during a task are compared by meaning as soon as it finishes, never during it.
  registry.onRunFinished(async (context) => { await consolidation.embedNew(context.owner).catch(() => undefined); });
  // Notes a task made only for itself go when the task ends, unless the owner asked to keep one.
  registry.onRunFinished(async (context) => { try { store.clearTaskScratch(context.owner, context.runId); } catch { /* nothing to clear */ } });
  // FQ-memory.providers: and the ones an outside memory service holds, when one is switched on.
  registry.onRunFinished(async (context) => { await memory.backend.clearOutsideScratch(memoryScope(store, context), context.runId).catch(() => undefined); });
  // Wave 9: what the assistant notices for itself from what actually happened. It only ever
  // suggests; every suggestion carries what it was learned from, and turning one down is final.
  const learning = new MemoryLearning(store);
  const documentContext = documents;
  // A knowledge base the owner ticked is put in front of a task first; documents follow, and the
  // files of the project last when the owner asked for them. They are stages of one list now rather
  // than one expression, so a fourth can be added without editing this line. Turning "Use my
  // documents when answering" off deliberately turns all of them off, so one switch means one thing.
  contextProviders.add(providerFrom("knowledge", "Your knowledge bases",
    (owner, prompt, signal) => knowledgeBases.contextFor(owner, prompt, signal)));
  contextProviders.add(providerFrom("documents", "Your documents",
    (owner, prompt, signal) => documentContext.contextFor(owner, prompt, signal)));
  contextProviders.add(new RepositoryContextProvider(projectMap, (owner) => repositoryContextSettings(store, owner)));
  runtime.documents = {
    contextFor: async (owner, prompt, signal) => {
      if (documentContext.settings(owner).useDocuments === false) return null;
      return contextProviders.contextFor(owner, prompt, signal);
    },
  };
  // Finding a tool by meaning, through the same reader and the same store of already-read
  // passages as everything else: a tool description that has not changed is never read twice.
  // The switch is checked in the runtime at the moment of the search, so this seam being here
  // does not by itself send anything anywhere.
  runtime.toolMeaning = {
    embed: async (texts, runId) => {
      const reader = knowledgeBases.embeddings(runtime.owner);
      if (!reader) return [];
      // Charged to the task that searched, the same way its model answers are, so the owner can
      // see what finding tools by meaning actually costs instead of it being spent out of sight.
      const vectors = await reader.embedFor(runId, [...texts], AbortSignal.timeout(20_000));
      return vectors.map((vector) => Array.from(vector));
    },
  };
  scheduler.onTick.add(async (now) => { await consolidation.tick(runtime.owner, now); });
  // Wave 7: the month's usage written out as a spreadsheet, into a folder of the owner's own
  // workspace, on the schedule they set. Nothing leaves this computer.
  scheduler.onTick.add(async (now) => {
    await meteringTick({
      store, owner: runtime.owner, workspace: files.root,
      overrides: () => pricingSettings(store, runtime.owner).overrides,
    }, now);
  });
  // A safe folder of made-up files to try things in before pointing the app at real work.
  const practice = new PracticeWorkspace(store, files);
  // Sending traces out. Off until the owner turns it on; the headers an endpoint needs are kept as
  // secret:// references and filled in only at the moment of the call.
  const traceExport = new TraceExporter({
    store, owner: runtime.owner, policy: web.policy, version,
    fillSecrets: (headers) =>
      store.secrets.fill(runtime.owner, store.projects.active(runtime.owner).id, headers, { purpose: "sending traces" }),
  });
  // Short-lived, scoped keys for anything that is not the app window. The master session key is
  // never one of these; see src/session-tokens.ts.
  const sessionTokens = new SessionTokens(store.sqlite, store);
  // ── bucket 19: people signing in from their own device, groups and sharing (src/people/). Ships off. ──
  const people = new People({ store, owner: runtime.owner, db: store.sqlite, roles: runtime.roles, tokens: sessionTokens,
    fetch: web.policy.guard(globalThis.fetch),
    secret: async (name: string) => {
      const project = store.projects.active(runtime.owner).id;
      const value = (await store.secrets.resolve(runtime.owner, project, [name], { purpose: "signing a person in" }))[name];
      audit(store, runtime.owner, { action: "secret.used", actor: "an identity service you set up", subject: `${name} (project ${project})`,
        reason: "Signing a person in needed it", outcome: "handed over" });
      return value;
    } });
  // ── end bucket 19 ──
  // ── mac4/bucket-20: talking to other agents and tools (src/interop/). Every part ships off. ──
  const interop = new Interop({ runtime, registry, knowledge, teams, flows, remoteAgents,
    tokens: sessionTokens, files, policy: web.policy, version });
  // ── mac6/bucket-23: the smaller asks (src/asks/). Every part ships off. ──
  const asks = new Asks({ runtime, registry, web, files, flows, fetch: web.policy.guard(globalThis.fetch),
    secret: async (name, purpose) => (await store.secrets.resolve(runtime.owner, store.projects.active(runtime.owner).id, [name], { purpose }))[name]!,
    telegramInUse: () => channels.summary().channels.some((channel) => channel.kind === "telegram"), version,
    assertHost: (host, port) => web.policy.assertAllowed(new URL(`https://${host}:${port}/`), "mail server address") });
  // ── end mac6/bucket-23 ──
  // ── mac7/nodes: the owner's other devices lending Branch a few abilities (src/devices/). Ships off. ──
  const devices = new Devices({ store, owner: runtime.owner, registry, files, join: { nodeDir: join(dataDir, "node") } }); // phase2/shell: join
  // ── end mac7/nodes ──
  // ── r17-b: suggestions, standing orders, loops, self-starting procedures (src/autonomy/). Every part ships off. ──
  const autonomy = new Autonomy({ runtime, registry, scheduler, chats: channels, handoff: interop.handoffParts,
    unsetTools: () => unsetConnectorTools(store, runtime.owner), // ships-on sweep: listed is not connected
    hasSecret: (name) => {
      try { return store.secrets.list(runtime.owner, store.projects.active(runtime.owner).id).some((entry) => entry.name === name); } catch { return false; }
    } });
  scheduler.onTick.add(() => autonomy.tick());
  // ── end r17-b ──
  // ── R17-A (wave mac7): Trunks (src/trunks/). Every part ships off. ──
  // R17-005: a Trunk's account is its own conversation's choice in the accounts work (src/accounts/).
  const trunkAccounts = {
    get connected() { return accountsSettings(store, runtime.owner).mode !== "off"; },
    pools: () => accountsSettings(store, runtime.owner).pools.map((pool) => ({ id: pool.pool, label: pool.pool,
      accounts: pool.accounts.map((account) => ({ id: account.id, label: account.label, signIn: pool.kind !== "api-key" })) })),
    choose: (sessionId: string, pool: string, account: string | null) => saveSessionChoice(store, runtime.owner, sessionId, pool, account),
  };
  const trunks = new Trunks({ runtime, registry, knowledge, scheduler, workflows, accounts: trunkAccounts,
    // Q44: the paired computers a Trunk may start in; a phone is a device but never a computer.
    computers: () => devices.book.devices().filter((device) => computerPlatforms.includes(device.platform))
      .map((device) => ({ id: device.id, name: device.name })),
    picture: async (prompt) => {
      const made = await runtime.executeTool("media.image", { prompt, size: "256x256" }, { mode: "owner" }) as { path?: string; mediaType?: string };
      if (!made.path || !runtime.artifacts) throw new Error("The picture model did not hand back a picture");
      return { bytes: await runtime.artifacts.read(made.path), mediaType: made.mediaType ?? "image/png" };
    } });
  devices.computerRule = trunks.computerRule; // P17-D §9: the device tools and the pick route follow each Trunk's computers
  retention.keeps = (sessionId) => trunks.keeps(sessionId);
  // phase2/rooms (integration review): a Trunk's side of a room stays out of Recents (the room is what is
  // opened), and Talk live is refused where it would step round a Trunk, Lockdown or an outside hold.
  store.hiddenSessions = () => [...trunks.rooms.memberConversations().keys()];
  live.refuse = (sessionId) => liveRefusal({ store, owner: runtime.owner, kind: (id) => trunks.conversations.kind(id) }, sessionId);
  channels.trunkReach = (channel, sessionId) => {
    const owned = trunks.trunkForConversation(sessionId);
    const trunk = owned ? trunks.records.find(owned.trunkId) : undefined;
    return trunk && !trunk.reach.channels.includes(channel) // whatever the switch says, reach only narrows
      ? `${trunk.name} does not answer on ${channel}. The owner can allow it under Customize → Trunks.`
      : trunks.pausedForConversation(sessionId, "it did not answer"); // eng-trunk-controls
  };
  // eng-trunk-controls: a trigger or a standing order aimed at a paused Trunk's conversation does not start, and says why.
  triggers.held = (sessionId) => trunks.pausedForConversation(sessionId, "this trigger did not start anything");
  autonomy.runner.sessionHeld = (sessionId) => trunks.pausedForConversation(sessionId, "this did not start");
  // ── end R17-A ──
  // ── mac7/r17-d: coding polish (src/coding/). Every part ships off. ──
  const coding = new Coding({ runtime, registry, files, servers: languageServers, git, gitRun });
  runtime.coding = coding;
  // ── end mac7/r17-d ──
  // ── R17-C: files, voice, devices and personal connectors (src/personal/). Every part ships off. ──
  const personalSecret = async (name: string, purpose: string) =>
    (await store.secrets.resolve(runtime.owner, store.projects.active(runtime.owner).id, [name], { purpose }))[name]!;
  const personal = new Personal({ runtime, registry, files, oauth, fetch: web.policy.guard(globalThis.fetch), secret: personalSecret,
    assertHost: (host, port) => web.policy.assertAllowed(new URL(`https://${host}:${port}/`), "mail server address"),
    channels: { adapter: (id) => channels.adapter(id), outboundGuard: (text) => channels.outboundGuard(text),
      reachable: (id, chatId) => channels.chats(runtime.owner).some((chat) => chat.channel === id && chat.chatId === chatId) },
    holdsKnownSecret: (text) => store.secrets.scrubber.deep(text) !== text,
    requireOwner: (what) => store.profiles.requireOwner(what),
    morningBrief: () => brief.preview(runtime.owner).markdown,
    speak: async (text) => { const spoken = await voice.speak(runtime.owner, { text, voice: "", speed: 1 }); return { bytes: spoken.bytes, mediaType: spoken.mediaType }; },
    transcribe: async (clip) => (await voice.transcribe(runtime.owner, { ...clip, name: "spoken answer" })).text,
    lockdownRefusal: () => (lockedDown(store, runtime.owner) ? lockdownRefusal : null) });
  releaseOnLock.push(() => personal.close()); // locking Branch stops the tunnel and forgets spoken answers
  // ── end R17-C ──
  // ── mac7/wake-mic: the word that starts a turn, actually listening. Ships off, like everything else. ──
  // It runs only while the switch is on, a word is chosen, and this computer can really listen, and
  // it asks again before every window, so Lockdown or the switch going off stops it within one
  // window whoever turned it. Hearing the word starts an ordinary turn: the same run a typed
  // message starts, with no permissions of its own and every question still asked.
  const wake = startWakeWord({
    store, owner: runtime.owner, runner: options.wake?.runner ?? wakeRunner(),
    capture: options.wake?.capture ?? wakeCaptureRunner(),
    // Integration review: being locked is a state the listener asks about before every window and
    // before every start, so a settings save cannot reopen the microphone on a locked Branch.
    locked: () => sessionLock.locked(),
    ...(options.wake?.present ? { present: options.wake.present } : {}),
    ...(options.wake?.platform ? { platform: options.wake.platform } : {}),
    // The turn the word starts is an ordinary one: the same call a typed message makes, with no
    // permissions of its own, nobody else's source, and every question still asked.
    onHeard: (text) => { if (text.trim()) void runtime.run({ prompt: text.trim() }).catch(() => undefined); },
  });
  releaseOnLock.push(() => wake.stop()); // locking Branch lets go of the microphone
  resumeOnUnlock.push(() => wake.refresh()); // ...and unlocking it listens again, with no save needed
  // ── end mac7/wake-mic ──
  // ── mac7/live-voice: speak and see the words. Ships off, and never opens a microphone unpressed. ──
  // Unlike the word that starts a turn, this holds the microphone open for as long as it listens,
  // which is the feature. Every way it lets go of it again is built here and in
  // src/voice-dictation-run.ts: a press, a quiet room, Lockdown, the switch, the lock, and the app
  // closing. There is deliberately no resumeOnUnlock: unlocking Branch must not reopen a
  // microphone, because nothing here may open one without the owner pressing Dictate.
  const dictation = startDictation({
    store, owner: runtime.owner,
    speech: options.dictation?.speech ?? speechStreamRunner(),
    sound: options.dictation?.sound ?? soundStreamRunner(),
    locked: () => sessionLock.locked(),
    ...(options.dictation?.present ? { present: options.dictation.present } : {}),
    ...(options.dictation?.platform ? { platform: options.dictation.platform } : {}),
    // The words are screen state: they go out to whoever is watching and are never written down,
    // never traced, never kept and never sent. They fill the message box; they do not send it.
    onHeard: () => undefined,
  });
  releaseOnLock.push(async () => dictation.stop()); // locking Branch lets go of the microphone
  // ── end mac7/live-voice ──
  // ── r17-i: reach and platform (src/reach/). Every part ships off. ──
  const reachParts = new Reach({ runtime, registry, router: channels, files, policy: web.policy, fetch: web.policy.guard(globalThis.fetch),
    secret: async (name, purpose) => (await store.secrets.resolve(runtime.owner, store.projects.active(runtime.owner).id, [name], { purpose }))[name]!,
    machines: { list: () => (askMode(store, runtime.owner, "nodes") === "off" ? [] : asks.nodes.nodes()) }, version, ...platformRunners() });
  scheduler.onTick.add(() => reachParts.tick());
  reachParts.remoteTrunks.useRoster(trunkRoster(trunks, runtime, registry, reachParts)); // R17-077 on R17-A's Trunks
  // ── end r17-i ──
  // ── mac7/r17-g: the safety extras (src/safety-extras/). Every part ships off; the emergency stop is unpressed. ──
  const safetyExtras = new SafetyExtras({ runtime, registry, dataDir });
  web.policy.emergencyStop = (target) => assertAddressNotStopped(store, runtime.owner, target);
  // ── end mac7/r17-g ──
  // ── r17-h: flows and boards (src/flows-boards/). Every part ships off. ──
  const flowsBoards = new FlowsBoards({ runtime, registry, flows, knowledge, queue: runQueue, asks,
    fetch: () => web.policy.guard(globalThis.fetch), ...(process.env.BRANCH_OSV_ENDPOINT ? { osvEndpoint: process.env.BRANCH_OSV_ENDPOINT } : {}) });
  // ── end r17-h ──
  // ── R17-F: learning, deeper (src/learning-more/). Every part ships off. ──
  const learningMore = new LearningMore({ store, registry, owner: runtime.owner, models: runtime.models,
    fetch: () => web.policy.guard(globalThis.fetch), hindsight: asks.hindsight, mirror: memoryMirror, files,
    secret: async (name, purpose) => (await store.secrets.resolve(runtime.owner, store.projects.active(runtime.owner).id, [name], { purpose }))[name]!,
    // A home folder given to createBranch is where to look, so the assistants' own override variables are not read then.
    place: () => (options.home ? { platform: process.platform, env: {}, home: resolve(options.home) } : { platform: process.platform, env: process.env, home: learningHome() }),
    provider: () => runtime.models.plan(runtime.owner, "").candidates[0]?.provider,
    wrapEmbedder: (embedder) => new CachedEmbeddings(asEmbeddings(embedder), knowledgeBases.cache) });
  // ── end R17-F ──
  // ── mac3/security-check: the self-check and the malware check (src/security-audit). Both ship off. ──
  const security = new SecurityService(
    { store, runtime, registry, sessionLock, privacy, web, sessionTokens, plugins, pluginCatalog, people },
    { dataDir, ...(options.home ? { home: resolve(options.home) } : {}), integrationsPath: () => (process.env.BRANCH_INTEGRATIONS ? resolve(process.env.BRANCH_INTEGRATIONS) : null),
      ...(process.env.BRANCH_OSV_ENDPOINT ? { osvEndpoint: process.env.BRANCH_OSV_ENDPOINT } : {}) });
  security.start();
  vetAddOn = (command, args) => security.malware.vet(command, args); // bucket-15: the add-ons' malware check is ready now
  // ── end mac3/security-check ──
  // eng-connectors: whether another person's server is started as Branch starts or only when a task needs it, and
  // what it last said its tools are. The launch file's servers and the owner's own (kept in the store) share it.
  const mcpHost = {
    connectWhen: () => readLifecycleSettings(store, store.profiles.scope()).connect,
    cache: {
      read: (id: string) =>
        ((store.get("settings", runtime.owner, `mcp-tools:${id}`)?.data as { tools?: CachedMcpTool[] } | undefined)?.tools) ?? [],
      write: (id: string, tools: CachedMcpTool[]) =>
        void store.save("settings", runtime.owner, `mcp-tools:${id}`, { tools, at: new Date().toISOString() }),
    },
    connections: mcpConnections,
    startupTimeoutMs: () => readComfort(store, runtime.owner, "mcp").startupTimeoutSeconds * 1000, // R17-S20
    // mac3/security-check: a server fetched from a package registry is looked up first.
    vetLaunch: (command: string, args: readonly string[]) => security.malware.vet(command, args),
  };
  // eng-connectors: the owner's own servers (a command asks through the approval gate before it starts), the
  // command-line tools the owner allowed, and replies the owner flagged.
  const ownMcp = new OwnMcpServers({ store, owner: () => runtime.owner, registry, approvals: runtime.approvals, workspace: () => runtime.workspace,
    policy: () => web.policy, host: () => mcpHost, vet: (command, args) => security.malware.vet(command, args) });
  const ownClis = new OwnClis({ store, owner: () => runtime.owner, workspace: () => runtime.workspace });
  const replyFlags = new ReplyFlags(store, () => runtime.owner);
  const stopWatchingErrors = recordUncaughtErrors(store.spans, runtime.owner, (value) => runtime.hideSecrets(value));
  // A finished task's spans go out on their own once sending is on; the exporter itself does
  // nothing at all while it is off, so this stays quiet until the owner turns it on.
  runtime.exportSpans = async (runId) => {
    const settings = traceExportSettings(store, runtime.owner);
    if (!settings.enabled) return;
    const spans = store.spans.forRun(runId).filter((span) => span.endedAt !== null);
    if (!spans.length) return;
    const crashes = settings.includeErrors ? store.spans.recent(runtime.owner, 50).filter((span) => span.kind === "error") : [];
    const results = await traceExport.sendSpans([...spans, ...crashes], "A finished task's steps were sent to the address you chose");
    // Batch 20 (wave 8): the same send carries the task's own story as OpenTelemetry log records,
    // tied to the trace by its id, so a collector shows the words beside the shape.
    const root = spans.find((span) => !span.parentSpanId) ?? spans[0];
    await traceExport.sendLogs(store.events(runId).map((event) => ({
      runId, kind: event.kind, createdAt: event.createdAt, data: event.data,
      ...(root ? { traceId: root.traceId, spanId: root.spanId } : {}),
    }))).catch(() => null);
    const failed = results.find((result) => !result.ok);
    store.event(runId, failed ? "trace.send_failed" : "trace.sent",
      failed ? { error: failed.error } : { spans: spans.length, endpoint: failed ? "" : settings.destination });
  };
  // --- bucket 14 (A1751): after the steps, the task counters, only when that switch is on ---
  const sendTaskSteps = runtime.exportSpans;
  runtime.exportSpans = async (runId) => {
    await sendTaskSteps(runId);
    await afterTaskMetrics(executionMetricsDeps(store, runtime.owner, traceExport)).catch(() => null);
  };
  // --- end bucket 14 ---
  let closing: Promise<void> | undefined;
  /** Wave mac2 (guards): the sections of the integrations file this start left out, which the launch-file card names. */
  const launchFile = { leftOut: [] as readonly string[] };
  const branch = {
    store,
    registry,
    launchFile,
    /** R17-S-C: the proxy and certificates in force (src/comfort/network.ts). */
    comfort: { outbound },
    /** mac4/bucket-20: the Agent Protocol, lent tools, modes, project routing, fleet, handoff, flow search, market. */
    interop,
    /** bucket-15: add-on packages, lists, filters, Pipelines, drafts, search sources, Branch as a plugin. */
    addOns,
    /** mac6/bucket-23: the smaller asks (src/asks/); every part ships off. */
    asks,
    /** mac7/nodes: paired devices, their switches and the device socket (src/devices/); ships off. */
    devices,
    /** r17-b: suggested automations, standing orders, loops and self-starting procedures; every part ships off. */
    autonomy,
    /** R17-A: Trunks, named long-lived agents (src/trunks/); every part ships off. */
    trunks,
    /** mac7/r17-d: coding polish (src/coding/); every part ships off. */
    coding,
    /** R17-C: files, voice, devices and personal connectors (src/personal/); every part ships off. */
    personal,
    /** r17-i: other computers, Trunks across computers, background apps, videos, relay, send and pause, sharing, USB, notes, arena. */
    reachParts,
    /** mac7/r17-g: tool scripts, WebAssembly add-ons, codes, the emergency stop, scans, the activity chain. */
    safetyExtras,
    /** r17-h: going back in a flow, checked procedures, the shared board, widgets, the waiting line, focus, install requests; every part ships off. */
    flowsBoards,
    /** Requests from a chat to change Branch itself; only the owner answers them (src/self-development-requests.ts). */
    sourceRequests,
    /** R17-F: learning, deeper (src/learning-more/); every part ships off. */
    learningMore,
    /** mac7/learn: the map and the tour (src/learn/); ships off. */
    learn,
    /** Optional, owner-controlled typed judgments from JEV; off until explicitly enabled. */
    decisions,
    /** P17-D §4: small decisions on the owner's own connections (src/decision-models.ts). */
    decisionModels,
    /** P17-D §3: behaviour workbooks, "Learn this app or workflow" (src/workbooks.ts). */
    workbooks,
    runtime,
    /** mac3/never-break: the task journal, and settling interrupted work after a restart. */
    neverBreak: {
      journal,
      recoverOnStart: async (dataFolder: string) => recoverOnStart({ store, runtime, journal, nextTurn,
        mode: (await loadGatewayConfig(dataFolder)).config.mode, askOnly: journalReset !== null }),
      /** The Telegram setup card: its state, saving it, and connecting the bot it set up. */
      telegram: {
        view: () => telegramSetupView(store, runtime.owner, channels),
        save: (input: unknown) => saveTelegramSetup(store, runtime.owner, input),
        connect: () => connectGuidedTelegram({ store, owner: runtime.owner, router: channels, fetch: web.policy.guard(globalThis.fetch) }),
      },
    },
    /** mac3/security-check: the security self-check, its repairs, and the malware check on add-ons. */
    security,
    /** eng-connectors: the owner's own MCP servers, allowed command-line tools, and flagged replies. */
    ownMcp,
    ownClis,
    replyFlags,
    /** mac2/fly-core: the learning core's three-way switch (off, when-needed, on); it ships off. */
    learningCore: {
      settings: () => flyCoreSettings(store, options.owner ?? "local"),
      configure: (input: unknown) => setFlyCoreMode(store, options.owner ?? "local", input, registry),
      /** mac2/fly-core-2: what it has learned, in plain words, and forgetting all of it. */
      view: (viewOwner = options.owner ?? "local") => learningCoreView(store, viewOwner),
      forget: (forgetOwner = options.owner ?? "local") => forgetLearning(store, forgetOwner),
    },
    /** mac3/reflection-skills: looking back over conversations and writing new skills; both switches ship off. */
    learningLoop,
    /** Wave 8: the shape conversations make when one is branched off another, and carrying an answer back. */
    sessionTree,
    /** Wave mac2: going back to an earlier message, and working toward a goal in rounds. */
    rewinds,
    goals,
    files,
    knowledge,
    documents,
    /** Making and reading pictures, speech and sound files. */
    media,
    /** Writing speech out and reading text aloud, whichever service does the work. */
    voice,
    /** Bucket 17: videos and sound understood through the owner's own ffmpeg and yt-dlp. */
    understanding,
    webPages, // w911 (A0743, A1452) hook: reading and crawling web pages
    /** Wave 8: live conversations — talking and being cut off, over a connection that stays open. */
    live,
    /** Finding, tidying and moving saved facts. */
    memory,
    /** Documents and saved facts behind one interface, with the best answer put first. */
    retrieval,
    /** What is put in front of a task before the model reads it, in order. */
    contextProviders,
    /** Named sets of folders and files, read into passages and searched by words and by meaning. */
    knowledgeBases,
    /** Writing conversations up as fact cards, and the refresh that shows its cost before it runs. */
    knowledgeCards,
    /** Facts noticed from what actually happened, offered as suggestions and never written. */
    learning,
    /** Wave 8: summaries, the map of names, pictures in words, and knowledge-base housekeeping. */
    knowledgeParts,
    /** Wave 8: what the assistant remembers, written into the workspace as Markdown. */
    memoryMirror,
    /** Wave 8: text held for one job only. */
    taskText,
    /** The nightly pass that gives new facts a comparison by meaning and suggests merges. */
    consolidation,
    /** The practice workspace: made-up files to try tools on safely. */
    practice,
    /** Model connections plugins have brought. */
    providerPlugins,
    /** Chat services plugins have brought, and the channels connected from them. */
    channelConnectors,
    /**
     * Searching, reading and commenting on issues, once the launcher has loaded the integration
     * settings. It stays null while no tracker is set up.
     */
    issues: null as null | IssueAccess,
    git,
    scheduler,
    chatgpt,
    version,
    userAgent,
    mcpServer,
    /** Other AI tools' servers, opened only while a task needs one and closed when it ends. */
    mcpConnections,
    /** Answering assistants elsewhere over the agent-to-agent protocol. */
    a2a,
    /** Assistants elsewhere this one may hand work to. */
    remoteAgents,
    artifacts,
    /** Files people attached to their messages, kept for as long as the conversation is. */
    attachments,
    /** The screen and keyboard of this computer, and the switch that has to be on to use them. */
    desktop,
    /** FQ-execution.desktop: the shared Linux desktop the owner may watch or take over. */
    linuxDesktop,
    /** What Windows itself allows: the microphone, the camera and taking hold of windows. */
    osPermissions,
    /** Folders on the owner's other computers, reached with the OpenSSH client Windows already has. */
    remotes,
    /** A way back to how a folder was just before a set of changes was written. */
    checkpoints,
    /** Switching a folder to the line of work a project names. */
    gitWorkspaces,
    /** How much one conversation, or one person messaging from outside, may ask for. */
    sessionLimiter,
    /** Letting conversations older than the owner's cut-off go, with a saved copy first. */
    retention,
    browserProfiles,
    /**
     * The live browser, once the launcher has loaded the integration settings, so Settings can
     * offer the sign-in-once window. It stays null when no browser is configured.
     */
    browser: null as null | { signIn(owner: string, name: string, url: string, timeoutMs?: number): Promise<{ name: string; cookies: number; sites: number }> },
    /**
     * Batch 26 (wave 8): what the firewall card needs that only the launch knows — the sites the
     * browser may open at all, and whether commands on this computer are pointed at a dead address.
     * Filled in by the launcher; the defaults say "no browser, and commands can reach out", which is
     * what a launch with no integrations file actually is.
     */
    reach: { browserOrigins: [] as string[], commandsMayReachInternet: true },
    /** Secrets for host commands: only the active project's, never returned to the model. */
    secretsFor: async (context: ToolContext, names: string[]) => {
      const project = store.projects.active(context.owner).id;
      const values = await store.secrets.resolve(context.owner, project, names,
        { runId: context.runId, purpose: "host command" });
      // The names only; a value never leaves the locker, and never reaches this record.
      for (const name of Object.keys(values))
        audit(store, context.owner, { action: "secret.used", actor: "a command you allowed", subject: `${name} (project ${project})`,
          reason: "A command this assistant ran needed it", source: context.source ?? "owner", runId: context.runId, outcome: "handed over" });
      return values;
    },
    /** References, replacement dates, the use audit and the shared scrubber. */
    secrets: store.secrets,
    /** Locking the app, by hand or after a quiet spell. */
    sessionLock,
    /** Signing in to outside services with the standard authorization-code flow and PKCE. */
    oauth,
    /** Personal details and the optional content check, either side of the assistant. */
    privacy,
    moderation,
    channels,
    /** Tables open for a task, reports already written, page watches, and the morning brief. */
    dataTables,
    research,
    monitors,
    brief,
    web,
    hooks,
    teams,
    skillRegistry,
    /** Skill packages: opening, installing and rebuilding the single file people share. */
    skillPackages,
    /** Installed packages whose tools could not be put back this time. */
    packageProblems,
    /** Single-file plugins from the data folder, off until the owner switches one on. */
    plugins,
    /** Plugins that were on but could not be loaded this time. */
    pluginProblems,
    /** Where plugins came from, with the fingerprint each one had when it was accepted. */
    pluginCatalog,
    /** Drafted better versions of a skill: the changed lines, the trial, and the owner's answer. */
    skillRevisions,
    evaluation,
    /** Suites kept as data: running them, their history, and comparing two model choices. */
    evaluationSuites,
    /** Wave 7: written-down experiments over suites and benchmarks, with checkpoints and resume. */
    studies,
    triggers,
    webhooks,
    slackAutomations, // mac6/bucket-16
    /** Wave 6: saved workflows, the waiting line for tasks, and days off with quiet hours. */
    workflows,
    runQueue,
    /** How much may be going on at once, counted once for the whole app. */
    executions,
    calendar,
    /** The same workflows as boxes and arrows, for the API and the picture in Procedures. */
    flows,
    /** Wave 8: the things still to be done, written down where the owner can see them. */
    todos,
    wiki,
    /** Wave 8: notes written into the owner's own notes folder, and the tagged ones read back. */
    obsidian,
    /** Wave 8: watches on one rectangle of the screen, off unless the owner switches them on. */
    screenWatches,
    /** Multi-file changes and the check the owner set up for this project. */
    codeChanges,
    /** The project map, for the screens that show it and for the tests. */
    projectMap,
    /** bucket-18 (A2317): the history of what is remembered, off until the owner switches it on. */
    memoryHistory,
    /** Services turned into tools from their own OpenAPI description. */
    openApiTools,
    /** Files a task produced that are not text, kept version by version. */
    keptArtifacts,
    /** Language servers and debuggers the owner set up; both stop when the app closes. */
    languageServers,
    debugAdapters,
    /** Programs left running, and the switch that stops them all when the app closes. */
    processes,
    /** What integrations need to host messaging channels: the router and default-project secrets. */
    channelHost: {
      router: channels,
      git,
      /** A secret from whichever project is active right now, for GitHub's personal access token. */
      activeSecret: async (name: string) => {
        const project = store.projects.active(runtime.owner).id;
        const value = (await store.secrets.resolve(runtime.owner, project, [name], { purpose: "integration" }))[name]!;
        audit(store, runtime.owner, { action: "secret.used", actor: "a connection you set up", subject: `${name} (project ${project})`,
          reason: "A service this assistant talked to needed it", outcome: "handed over" });
        return value;
      },
      secret: async (name: string) =>
        (await store.secrets.resolve(runtime.owner, "default", [name], { purpose: "channel" }))[name]!,
      web,
      hooks,
      files,
      artifacts,
      browserProfiles,
      computer,
      store,
      tracer: runtime.tracer,
      onLock: (release: () => Promise<unknown>) => { releaseOnLock.push(release); },
      context: (runId: string) => runtime.context({ runId }),
      slackEvents: (channelId: string, event: unknown, bot: string | null) => void slackAutomations.handle(channelId, event, bot), // mac6/bucket-16
      // Wave mac2 (guards): an integrations file inside the workspace is only used when the owner
      // trusts its folder (src/folder-trust.ts), and what was left out is kept for the launch-file
      // card. A file elsewhere is theirs.
      configTrusted: (path: string) => integrationsFileTrusted(store, runtime.owner, runtime.workspace, path),
      leftOut: (sections: readonly string[]) => { launchFile.leftOut = [...sections]; },
      // Whether another person's server is started as Branch starts or only when a task really
      // needs it, and what it last said its tools are, so they can be listed either way.
      mcp: mcpHost,
      ownMcp,
      ownClis,
    },
    /** mac7/wake-mic: the word that starts a turn. The card reads `listening` from this, never guesses it. */
    wake,
    /** mac7/live-voice: live dictation. The card reads `open` from this, never guesses it from the switch. */
    dictation,
    /** Sending traces and counters to an address the owner chose; off until they turn it on. */
    traceExport,
    /** Batch 20 (wave 8): short-lived keys for a script, an extension or the SDK. */
    sessionTokens,
    /** bucket 19: people signing in from their own device, groups and sharing; ships off. */
    people,
    /** Wave 9: scoring the real work as it finishes, and the recent verdicts. */
    liveScoring: {
      settings: () => liveScoringSettings(store, runtime.owner),
      configure: (input: unknown) => saveLiveScoringSettings(store, runtime.owner, input),
      recent: (limit?: number) => liveScores(store, runtime.owner, limit),
      summary: (limit?: number) => liveScoreSummary(liveScores(store, runtime.owner, limit)),
    },
    close: () => (closing ??= (async () => {
      // bucket-18 (A0300): nothing is sent to GitHub while the app is closing.
      stopPullRequests();
      stopOfferingPullRequests();
      pullRequestStop.abort(new Error("Branch is closing"));
      await Promise.allSettled([...pullRequestWork]);
      stopWatchingErrors();
      stopLiveScoring();
      // Wave 8: a connection that stays open must not outlive the app either.
      live.closeAll("Branch closed");
      plugins.stop();
      // A file of the owner's own holding the vectors is let go of; the app's own database is not.
      knowledgeBases.vectors.close?.();
      skillPackages.stop();
      mcpServer.close();
      asks.close(); // mac6/bucket-23: live pages stop asking their tools again
      devices.close(); // mac7/nodes: every device socket is closed
      await wake.stop(); // mac7/wake-mic: the microphone is let go of before the app closes
      dictation.stop(); // mac7/live-voice: and so is the one dictation holds open
      runtime.keepAlive.stop(); // R17-050: no cache ping outlives the app
      await autonomy.close(); // r17-b: nothing more starts by itself, and a turn that is working gets a moment
      await trunks.close(); // R17-A: rooms stop between turns
      await personal.close().catch(() => undefined); // R17-C: the webhook tunnel program stops
      await reachParts.close(); // r17-i: the relay stops asking
      safetyExtras.close(); // mac7/r17-g
      await linuxDesktop.close().catch(() => undefined); // FQ-execution.desktop: no shared desktop outlives the app
      await ownMcp.closeAll(); // eng-connectors: no question watcher or server of the owner's outlives the app
      await mcpConnections.closeAll();
      // Nothing the assistant left running outlives the app.
      await processes.stopAll().catch(() => undefined);
      await languageServers.stopAll().catch(() => undefined);
      await debugAdapters.stopAll().catch(() => undefined);
      // mac3/reflection-skills: a draft or a look back still being written gets a moment to finish.
      await Promise.race([learningLoop.idle(), new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
      try {
        await closeBranch(scheduler, runtime, store, channels, desktop);
      } finally {
        journal.close(); // mac3/never-break
        oauth.closeAll();
        outbound.reset(); // R17-S-C: the program's proxy and certificates go back as they were
      }
    })()),
  };
  // Changing Branch's own settings by asking, saved through the same writers as the window's (src/settings-kit/tools.ts).
  registerSettingsTools(registry, store, () => settingsKitWriters(branch));
  registerHelpSearch(registry); // what Branch knows about itself, from its own handbook
  // Wave 9: a graph flow left working when the app closed picks up at the box after the last one
  // that finished, with the state exactly as that box left it. Nothing is started again from the
  // top, and a launch with no interrupted flow does nothing at all. Last of all (Q121, NAS 7af12b6):
  // a Trunk's run carries on as that Trunk only once every hook it reaches is wired, its own folder
  // (`runtime.coding`) included, rather than in the owner's project.
  try { flows.resumeInterrupted(); } catch { /* a flow that cannot be read must not stop the launch */ }
  // household-followups: with the owner's PIN set, the window comes back on the profile it was left
  // on, once everything above has started as the owner: the launch carry-on of interrupted flows
  // included (NAS 52f87df), which is the owner's and must not meet another person's window.
  store.profiles.resumeWhereLeft();
  return branch;
}
/** Runs one of the owner's own verified recipes by name, for a skill package's event hook. */
async function replayNamedRecipe(knowledge: Knowledge, store: Store, runtime: Runtime, recipe: string, runId: string): Promise<void> {
  const match = store.list("procedures", runtime.owner).find((record) => {
    const state = record.data as unknown as { status?: string; definition?: { name?: string } };
    return state.definition?.name === recipe && state.status === "verified";
  });
  if (!match) throw new Error(`No verified recipe called "${recipe}"`);
  await knowledge.replayProcedure(runtime.context({ runId }), match.id);
}
/**
 * mac7/safe-rollback: tells the activation journal which format changes this version made to the
 * saved work. Best effort throughout: a record that cannot be written only means a later undo is
 * refused for want of one, which is the safe direction, and it must never stop Branch starting.
 */
function noteStoreMigration(dataDir: string, store: Store, report: MigrateReport): void {
  if (report.from === report.to) return;
  let opened: { journal: ActivationJournal } | null = null;
  try {
    opened = openActivationJournal(join(dataDir, activationJournalName));
    const entry = opened.journal.current();
    if (!entry) return;
    const now = formatOf(store.sqlite);
    opened.journal.noteMigration(entry.id, {
      name: databaseName,
      before: { version: report.from, readableBy: report.from },
      after: now,
      ran: storeMigrations.filter((one) => one.version > report.from && one.version <= report.to).map((one) => one.version),
      backup: report.backup,
    });
  } catch { /* see above */ }
  finally { opened?.journal.close(); }
}

/** mac7/install-torture: keeps the newest few copies taken before a change to the database's shape. */
function pruneFormatCopies(dir: string, justTaken: string | null): void {
  try {
    const keep = justTaken ? basename(justTaken) : undefined;
    for (const name of formatCopiesToPrune(readdirSync(dir), undefined, keep)) rmSync(join(dir, name), { force: true });
  } catch { /* tidying is never a reason not to start */ }
}

/** mac3/never-break: stamps the store's data format and opens the journal; the store is closed if the stamp fails. */
function openNeverBreak(store: Store, dataDir: string): { journal: TaskJournal; reset: string | null } {
  try {
    // mac7/safe-rollback: an update the app handed over to a script never saw how it went; the
    // version running now is the answer, so that is settled before anything else is written down.
    try { settleActivation(join(dataDir, activationJournalName), String(createRequire(import.meta.url)("../package.json").version)); }
    catch { /* a record that cannot be settled only means an undo is refused for want of one */ }
    const report = migrate(store.sqlite, storeMigrations, { backupTo: join(dataDir, "update-backups", `before-format-${Date.now()}.sqlite`) });
    // mac7/safe-rollback: the version that was just installed has moved the data on. The record of
    // what the update changed learns it, so an undo knows whether going back is still safe.
    noteStoreMigration(dataDir, store, report);
    // mac7/install-torture: those copies are whole databases; a change that keeps failing would
    // otherwise leave one behind on every start until the disk filled up.
    pruneFormatCopies(join(dataDir, "update-backups"), report.backup);
    // A journal that cannot be read is put aside rather than stopping Branch from starting.
    return openJournal(join(dataDir, "journal.sqlite"));
  } catch (error) {
    store.close();
    // mac7/install-torture: whatever went wrong here is about the owner's saved work, so it reaches
    // them as a sentence rather than as the database's own words.
    throw dataOpenError(join(dataDir, "branch.sqlite"), error);
  }
}
async function closeBranch(
  scheduler: Scheduler,
  runtime: Runtime,
  store: Store,
  channels?: ChannelRouter,
  desktop?: { close(): Promise<void> },
): Promise<void> {
  await desktop?.close().catch(() => undefined);
  await channels?.detachAll();
  const schedulingStopped = scheduler.stop();
  await runtime.shutdown();
  await schedulingStopped;
  localKitFor(store)?.close(); // Wave mac5 (local models): stop what Branch started, keep setups resumable.
  store.close();
}
export * from "./contracts.js";
export * from "./store.js";
export * from "./collab-events.js";
export * from "./registry.js";
export * from "./catalog.js";
// Wave 7 (tool loading): the tiers, the searchable index, and what past tasks taught.
export * from "./tool-loading.js";
export { parallelGroups, parallelLimit, codingWorkingSet, batchingNote, looksLikeCodingWork } from "./coding/fewer-rounds.js"; // mac7/speed
export { lastWordMessages } from "./runtime.js"; // mac7/speed
export { readManyLimit, readManyShareOfRoom } from "./coding/read-many.js"; // mac7/speed
export * from "./tool-index.js";
export * from "./tool-usage.js";
export * from "./runtime.js";
export * from "./demo.js";
export * from "./no-model.js";
export * from "./providers.js";
export * from "./knowledge.js";
export * from "./memory.js";
export * from "./identity.js";
export * from "./context-files.js";
export * from "./security-audit/index.js";
export * from "./skills.js";
export * from "./models.js";
export * from "./chatgpt-auth.js";
export * from "./chatgpt-provider.js";
export * from "./chatgpt-presets.js";
export * from "./projects.js";
export * from "./locker.js";
export * from "./vault.js";
export * from "./pii.js";
export * from "./moderation.js";
export * from "./privacy-guard.js";
export * from "./session-lock.js";
export * from "./oauth.js";
export * from "./integrations/job-object.js";
export * from "./artifacts.js";
export * from "./channels/router.js";
export * from "./channels/telegram.js";
export * from "./channels/discord.js";
export * from "./channels/slack.js";
export * from "./channels/whatsapp.js";
export * from "./channels/email.js";
export * from "./channels/mail-client.js";
export * from "./channels/ws-client.js";
export * from "./integrations/web.js";
export * from "./delegation.js";
export * from "./orchestration.js";
export * from "./plan-act.js";
export * from "./orchestration-tools.js";
export * from "./reliability.js";
export * from "./skill-scan.js";
export * from "./receipts.js";
export * from "./content-guard.js";
export * from "./activity.js";
export * from "./memory-review.js";
export * from "./workspace-history.js";
export * from "./ignore.js";
export * from "./patch.js";
export * from "./code-search.js";
export * from "./code-edit.js";
export * from "./backup.js";
export * from "./health.js";
export * from "./openai-compat.js";
export * from "./a2a.js";
export * from "./a2a-client.js";
export * from "./acp.js";
export * from "./streams.js";
export * from "./recipes.js";
export * from "./templates.js";
export * from "./network-policy.js";
export * from "./policy.js";
export * from "./policy-resources.js";
export * from "./approvals.js";
// Batch 19 (wave 7): spans, sending traces out, the metrics page and the auth rate limit.
export * from "./tracing.js";
export * from "./tracing-shapes.js";
export * from "./tracing-export.js";
export * from "./metrics.js";
export * from "./auth-limits.js";
export * from "./hooks.js";
// bucket-18: Open pull-request hook (A0300)
export * from "./pr-hook.js";
export * from "./key-context.js";
export * from "./ws.js";
export * from "./integrations/process-usage.js";
export * from "./skill-governance.js";
export * from "./teams.js";
export * from "./registry-install.js";
export * from "./skill-package.js";
export * from "./skill-packages.js";
export * from "./skill-http-tools.js";
export * from "./skill-suggest.js";
export * from "./skill-authoring.js";
export * from "./plugins.js";
export * from "./evaluation.js";
export * from "./evaluation-honesty.js";
export * from "./evaluation-suites.js";
export * from "./evaluation-grading.js";
export * from "./evaluation-runner.js";
// Wave 7 (benchmarks and experiments): scorers, gates, benchmark adapters, studies, and the
// deterministic test doubles a plugin author writes their own tests with.
export * from "./evaluation-scorers.js";
export * from "./evaluation-run.js";
export * from "./benchmarks.js";
export * from "./benchmark-adapters.js";
export * from "./benchmark-shell.js";
export * from "./study.js";
export * from "./tool-evaluations.js";
export * from "./answer-metrics.js";
export * from "./html-state.js";
export * from "./trajectory-compare.js";
export * from "./trajectory-report.js";
export * from "./study-journal.js";
export * from "./retrieval-metrics.js";
export * from "./evaluation-live.js";
export * from "./benchmark-nexus.js";
export * from "./testing.js";
export * from "./testing-doubles.js";
export * from "./channels/deliveries.js";
export * from "./channels/catalog.js";
export * from "./channels/webhook-chat.js";
export * from "./channels/meta-graph.js";
export * from "./channels/matrix.js";
export * from "./channels/signal-cli.js";
export * from "./channels/connectors.js";
export * from "./channels/docs-table.js";
export * from "./json-template.js";
export * from "./skill-document.js";
export * from "./scheduler.js";
// Bucket 8 (wave 9): long jobs that survive being interrupted.
export * from "./session-carry.js";
export * from "./shell-session.js";
export * from "./headless.js";
export * from "./dispatch-fallback.js";
export * from "./provider-retry.js";
export * from "./triggers.js";
export * from "./webhooks.js";
export * from "./ignore.js";
export * from "./integrations/git.js";
export * from "./integrations/git-run.js";
export * from "./integrations/git-tools.js";
export * from "./integrations/github.js";
// bucket-18: GitHub App (A2227)
export * from "./integrations/github-app.js";
export * from "./integrations/gitlab.js";
export * from "./integrations/desktop.js";
export * from "./integrations/desktop-tools.js";
export * from "./integrations/desktop-config.js";
export * from "./integrations/desktop-banner.js";
export * from "./pricing.js";
export * from "./local-models.js";
export * from "./local-hardware.js";
export * from "./local-routing.js";
export * from "./local-runtimes.js";
export * from "./trace.js";
export * from "./diagnostics.js";
export * from "./memory-retrieval.js";
export * from "./memory-layers.js";
export * from "./memory-tidy.js";
export * from "./memory-evaluation.js";
export * from "./memory-backend.js";
export * from "./memory-hygiene.js";
export * from "./memory-consolidate.js";
export * from "./embeddings.js";
export * from "./vector-store.js";
export * from "./vector-store-file.js";
export * from "./retrieval-filters.js";
export * from "./retrieval-pipeline.js";
export * from "./context-providers.js";
export * from "./chunking.js";
export * from "./bm25.js";
export * from "./knowledge-bases.js";
export * from "./knowledge-cards.js";
export * from "./knowledge-tools.js";
export * from "./memory-export.js";
export * from "./citations.js";
export * from "./data-table.js";
export * from "./data-chart.js";
export * from "./data-tools.js";
export * from "./research.js";
export * from "./research-claims.js";
export * from "./monitors.js";
export * from "./brief.js";
export * from "./session-summary.js";
export * from "./working-session.js";
// Batch 20 (wave 7) — orchestration, second pass.
export * from "./specialist-styles.js";
export * from "./code-change.js";
export * from "./deferred.js";
export * from "./processes.js";
export * from "./code-run.js";
export * from "./credential-cli.js";
export * from "./sandbox.js";
export * from "./os-permissions.js";
export * from "./profile-roles.js";
export * from "./replay.js";
export * from "./orchestration-modes.js";
export * from "./answer-shape.js";
export * from "./second-opinion.js";
export * from "./flows.js";
export * from "./flow-graph.js";
export * from "./flow-graph-run.js";
// Wave 8: the to-do list, reports in three forms, and artifacts out of a reply.
export * from "./todos.js";
export * from "./wiki.js";
export * from "./reports.js";
export * from "./artifact-pages.js";
export * from "./dashboards.js";
export * from "./memory-learning.js";
export * from "./obsidian.js";
export * from "./embeds.js";
export * from "./screen-watch.js";
export * from "./plugin-catalog.js";
export * from "./skill-revisions.js";
export * from "./media.js";
export * from "./troubleshoot.js"; // w911 (A0374) hook.
export * from "./qa-scenarios.js"; // w911 (A1753) hook.
export * from "./qa-api.js"; // w911 (A1753) hook.
export * from "./voice.js";
export * from "./voice-stt.js";
export * from "./voice-tts.js";
export * from "./voice-talk.js";
export * from "./voice-service.js";
export * from "./realtime.js";
export * from "./realtime-openai.js";
export * from "./realtime-gemini.js";
export * from "./realtime-voice.js";
export * from "./realtime-socket.js";
export * from "./voice-api.js";
export * from "./model-profiles.js";
export * from "./model-switch.js";
export * from "./provider-probe.js";
export * from "./trajectory.js";
export * from "./gemini-signin.js";
export * from "./media-audio.js";
export * from "./media-images.js";
export * from "./media-settings.js";
export * from "./media-video.js";
export * from "./audit.js";
export * from "./tool-categories.js";
export * from "./ask-first.js";
export * from "./practice-workspace.js";
export * from "./retrieval.js";
export * from "./provider-plugins.js";
export * from "./misc-api.js";
export * from "./integrations/linear.js";
export * from "./integrations/issue-context.js";
export * from "./integrations/issue-tools.js";
// bucket-18: Issue-tracker context (A0174) - add Jira and GitLab support
export * from "./integrations/jira.js";
// Wave 6 (collaboration and workflows).
export * from "./labels.js";
export * from "./conversation-share.js";
export * from "./workflows.js";
export * from "./run-queue.js";
export * from "./execution-limit.js";
export * from "./calendar.js";
export * from "./profiles.js";
// Wave 7 (a coder's toolbox).
export * from "./code-scanners.js";
export * from "./code-map.js";
export * from "./stdio-rpc.js";
export * from "./language-server.js";
export * from "./language-server-tools.js";
export * from "./debug-adapter.js";
export * from "./checkpoints.js";
export * from "./build-artifacts.js";
export * from "./openapi.js";
export * from "./openapi-tools.js";
export * from "./agent-export.js";
// Wave 7 (Branch as a first-class MCP citizen, both ways round).
export * from "./mcp-policy.js";
export * from "./mcp-snapshots.js";
export * from "./mcp-lifecycle.js";
export * from "./mcp-apps.js";
export * from "./mcp-workbench.js";
export * from "./integrations/mcp-oauth.js";
// Wave 8 (the long tail in "other"): the app's own OpenAPI description, keeping answers to
// identical requests, whole sets of questions at once, Lockdown, the shape branched conversations
// make, what each project has cost, and watching a folder.
export * from "./api-openapi.js";
// The owner's handbook, which the app serves to itself so Help opens beside the screen you are on.
export * from "./help.js";
export * from "./request-cache.js";
export * from "./batch-inference.js";
export * from "./chat-engine.js"; // w911 (A0847)
export * from "./provider-batch.js";
export * from "./lockdown.js";
export * from "./session-tree.js";
export * from "./goal-mode.js";
export * from "./rewind.js";
export * from "./project-ledger.js";
export * from "./watch.js";
// bucket-18: AI comments (A0344)
export * from "./ai-comments.js";
// bucket-18: memory history (A2317)
export * from "./memory-git.js";
// Batch 20 (wave 8): writing and changing documents, and the rest of what this batch added.
export * from "./document-package.js";
export * from "./document-write.js";
export * from "./document-docx.js";
export * from "./document-xlsx.js";
export * from "./document-pptx.js";
export * from "./document-edit.js";
export * from "./document-authoring.js";
export * from "./knowledge-graph.js";
export * from "./knowledge-summary.js";
export * from "./knowledge-manage.js";
export * from "./knowledge-pictures.js";
export * from "./knowledge-more.js";
export * from "./learn/index.js";
export * from "./learn/api.js";
export * from "./memory-mirror.js";
export * from "./memory-ephemeral.js";
// Batch 20 (wave 8): short-lived keys, the sources a saved password can come from, one list of who
// may message the assistant, the chain a phone must satisfy, and coding assistants as a model.
export * from "./session-tokens.js";
export * from "./vault-sources.js";
export * from "./vault-autofill.js"; // mac7/vault-autofill (R17-068)
export * from "./channels/allowlist.js";
export * from "./remote/gateway-auth.js";
export * from "./providers/cli-agent.js";
export * from "./cli-attach.js";
export * from "./cli-completion.js";
export * from "./cli-run.js";
// mac4/bucket-20: talking to other agents and tools.
export { Interop } from "./interop/index.js";
// bucket-15: add-ons other people wrote.
export { AddOns, applyFilters, branchPluginFiles, definePlugin, addOnApiVersion, readOffer, signListEntry, verifyListEntry, pluginWall } from "./add-ons/index.js";
// Wave mac2 (guards): the loop guard, the folder's own instructions and folder trust.
export * from "./loop-guard.js";
// R17-S-B: the hidden knobs, with plain labels.
export * from "./knobs/settings.js";
export * from "./knobs/apply.js";
export * from "./knobs/environment.js";
export * from "./knobs/thinking.js";
export * from "./knobs/commands.js";
export * from "./knobs/leak-options.js";
export { LaunchFileChangeSchema, launchFileView, saveLaunchFile } from "./knobs/launch-file.js";
// R17-E: models, cheaper and smarter.
export * from "./model-savings/settings.js";
export * from "./model-savings/openrouter.js";
export * from "./model-savings/difficulty.js";
export * from "./model-savings/reported.js";
export * from "./model-savings/rounds.js";
export * from "./model-savings/keep-alive.js";
export * from "./model-savings/mixture.js";
// R17-S-C (comfort): shortcuts, status line, notifications, voice keys, browser care, proxy and certificates.
export * from "./comfort/settings.js";
export * from "./comfort/network.js";
// mac7/node-floor: the oldest Node Branch is supported on, and what to say on an older one.
export * from "./node-floor.js";
export * from "./comfort/browser-safety.js";
export * from "./comfort/ignore-files.js";
export * from "./comfort/status-line.js";
export * from "./comfort/auto-update.js";
export * from "./folder-trust.js";
export * from "./run-guards.js";
// Wave mac3 (tool-safety): "always allow" per subcommand, and the second look before an approval.
export * from "./command-prefix.js";
export * from "./approval-reviewer.js";
// Bucket 14 (A1334, A0367): handing events to an embedding program's logger, and the usage report.
export * from "./log-bridge.js";
export * from "./usage-report.js";
export * from "./execution-metrics.js";
// Bucket 21: a library other people can build on — flows as YAML, and the app-builder tools.
export * from "./flow-yaml.js";
export * from "./sdk-kit.js";
export * from "./web-pages-settings.js"; // w911 (A0743, A1452) hook
export * from "./sdk-starters.js";
