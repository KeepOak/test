import { leastPermissions, reachWords } from "./schedule-reach.js"; // dogfood
import { retiredPhoneWorker } from "./retired-phone-worker.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { changeContextMode, contextSources } from "./tool-context-api.js";
import { picturesMessage, tryReadDocument } from "./document-readers.js"; // dogfood-ux-2
import { maxArtifactBytes } from "./artifacts.js"; // dogfood-ux-2
import { EmptySchema } from "./conversation-actions.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { liveWindowCommit, liveWindowFile, liveWindowNames, ownBuild } from "./hot-update/window-files.js"; // hot-update
import { readFile, writeFile, lstat, rename } from "node:fs/promises";
import { dirname, extname, join, resolve as resolvePath } from "node:path"; // R17-S-B: resolvePath
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TeamHandoffs, TeamHandoffRefusedError } from "./team-handoff.js";
import { quietJobsApi } from "./scheduler.js";
import { finishChatGPTSignIn, syncChatGPTPresets } from "./chatgpt-presets.js";
import { embedSettings, widgetOrigin } from "./embeds.js";
import { RunInputSchema, errorText, maximumImagesPerTurn, runBodyLimit, type Run } from "./contracts.js";
import type { ImagePart } from "./contracts.js";
import { isRequestShapeError, requestErrorText } from "./request-errors.js";
import { CompletionCheckSchema } from "./reliability.js";
import { liveActivity, staleAfterMs, queuedActivity, type RunActivity } from "./activity.js";
import { runResult } from "./results.js";
import { PlanStepSchema, orchestrationSettings, saveOrchestrationSettings } from "./orchestration.js";
import {
  PlanActSettingsSchema, autonomyWords, planModeWords, projectPlanAct, saveProjectPlanAct,
  saveSessionPlanAct, sessionPlanAct, clearSessionPlanAct,
} from "./plan-act.js";
import { secondOpinionSettings, saveSecondOpinionSettings } from "./second-opinion.js";
import { checkCodexModels, chooseCodexModel, codexModelsView } from "./codex-models-api.js"; // QA 2026-09-28
import { usageByTrunk } from "./usage-by-trunk.js"; // models-ui (MODEL-052)
import { helperDefaultsView, saveHelperDefault } from "./helper-defaults-api.js"; // models-ui (MODEL-051)
import { classifyToolEvent } from "./receipts.js";
import { SkillScanPolicySchema } from "./skill-scan.js";
import { PackageInstallSchema } from "./skill-packages.js";
import { browserSkillList, browserSkillPackage } from "./browser-skills.js";
import { readAttachSettings, saveAttachSettings } from "./integrations/browser-attach.js";
import { refusedHosts } from "./integrations/desktop-config.js";
import { draftFromRuns, testSkill, writeSkill } from "./skill-authoring.js";
import { suggestSkills } from "./skill-suggest.js";
import { healthReport, startedCleanly } from "./health.js";
import { noModelWords } from "./no-model.js";
import { maximumBackupBytes } from "./backup.js";
import { chatCompletion, modelsList } from "./openai-compat.js";
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from "./providers.js";
import { allPresets, findPreset } from "./providers/presets.js";
import { testRouteFor } from "./provider-factory.js";
import { connectFromPreset, forgetConnection } from "./connections-preset.js";
import { catalogEntries, catalogEntry, providerCatalog } from "./provider-catalog.js";
import { localModelsApi } from "./local-models-api.js";
import { ollamaHome } from "./local-models.js";
import type { PressContext } from "./local-one-button.js";
import { handlesRemovePath, removeBranchApi } from "./remove-branch.js";

/** mac7/clean-uninstall: the folder holding this copy's package.json, as `branch uninstall` reads it. */
const packageRootHere = (): string => dirname(dirname(fileURLToPath(import.meta.url)));
import { localRuntimes } from "./local-runtimes.js";
// Wave mac5 (local models): the one-click pieces kept beside this app's store.
import { localKitFor } from "./local-kit.js";
import { adaptApi, handlesAdaptPath } from "./adapt/api.js"; // mac7/adapt
import { streamLiveSteps, streamOwnerEvents, streamRunEvents } from "./streams.js";
import { liveSteps, specialistName } from "./live-steps.js"; // live steps: watch Branch think and work
// Web app (wave 6): "Look inside" a task, and "Try a tool" in the developer playground.
import { inspectRun } from "./inspect.js";
import { buildTrajectory, trajectoryLines } from "./trajectory.js";
import { replayRun } from "./replay.js";
import { MeteringExportSchema, meteringFolder, meteringSettings, saveMeteringSettings, writeMeteringFile } from "./metering.js";
import { TryToolSchema, toolForms, tryToolByHand } from "./playground.js";
import { ApprovalRequiredError, PolicyRefusedError } from "./approvals.js";
import { exportTemplate, importTemplate } from "./templates.js";
import { agentSections, agentSummary, exportAgent } from "./agent-export.js"; // p17: whole-agent export from the window
import { applyPiiGuard } from "./pii.js"; // p17: memory leaves with personal details masked
import { serveRunSocket, tokenFromProtocol, tokenFromSocket } from "./ws.js";
// Bucket 13 (mac4): seeing what a task did, step by step, afterwards.
import { handlesRecordingPath, recordingApi, startEventLoopWatch } from "./run-recording-api.js";
import { liveHooks } from "./realtime-socket.js";
import { readBodyWithRaw, type TriggerState } from "./triggers.js";
import { knowledgeApi } from "./knowledge-tools.js";
import { knowledgeExtrasApi } from "./knowledge-more.js";
import { WhatsAppAdapter } from "./channels/whatsapp.js";
import { WebhookChatAdapter } from "./channels/webhook-chat.js";
// Wave mac3 (channels-parity).
import { isPostedChannel, type PostedChannel } from "./channels/parity-switch.js";
import { isSignedQueryChannel, readRawBody, type SignedQueryChannel } from "./channels/signed-query.js"; // mac6/bucket-16
import { saveSlackAutomations } from "./channels/slack-automations.js"; // mac6/bucket-16
import { wechatXmlLimit } from "./channels/wechat-crypto.js"; // mac6/bucket-16 integration
import type { ChannelAdapter } from "./channels/router.js";
import { parityApi } from "./channels/parity-api.js";
// Batch 20 (wave 8): the unguessable word on the end of every inbound webhook address.
import { rotateWebhookSecret, saveWebhookAddressSettings, webhookAddress, webhookAddressVerdict,
  webhookAddressSettings, webhookSecret, wrongWebhookAddress } from "./channels/webhook-address.js";
import { noteWebhookWait, webhookWaits } from "./channels/webhook-waits.js";
import { channelEntries } from "./channels/catalog.js";
import { MetaMessagingAdapter } from "./channels/meta-graph.js";
import { standardSuite } from "./evaluation.js";
import { allSuites, saveSuite, removeSuite, suiteFromRun } from "./evaluation-suites.js";
// Wave 7 (a coder's toolbox): the two Developer switches.
import { languageServerSettings, saveLanguageServerSettings } from "./language-server.js";
import { debugSettings, saveDebugSettings } from "./debug-adapter.js";
// Wave 7 (benchmarks and experiments).
import { scorerKinds } from "./evaluation-scorers.js";
import { benchmarkAdapters } from "./benchmark-adapters.js";
import { notIntegratedBenchmarks } from "./benchmarks.js";
import { compareStudies, comparisonTable, studyTable, type StudyRunResult } from "./study.js";
import { runToolChecksSafely } from "./tool-evaluations.js";

import { McpSharingSchema, shareableTools, type McpServer } from "./mcp-server.js";
// Wave 7: Branch as a first-class MCP citizen — streaming, preflight, records of what a client was
// shown, connection lifecycle, the "try a server" bench, and small pages an outside server sends.
import { hiddenToolsText } from "./mcp-policy.js";
import { listSnapshots } from "./mcp-snapshots.js";
import { readLifecycleSettings, saveLifecycleSettings } from "./mcp-lifecycle.js";
import { tryServer } from "./mcp-workbench.js";
// mac3/security-check: the self-check card's routes.
import { securityCheckApi } from "./security-audit/api.js";
import { signIn as mcpSignIn } from "./integrations/mcp-oauth.js";
import { AppResourceSchema, appHeaders, appPage, type AppResource } from "./mcp-apps.js";
// mac2/fly-core-2: the learning core's owner routes.
import { handlesLearningCorePath, learningCoreApi, LearningCoreApiError } from "./fly-core-api.js";
// Wave 8: artifacts out of a reply, shown in the same locked-down frame an MCP app gets.
import { conversationPathsApi, conversationPathsRoute, readMarksPath } from "./conversation-paths-api.js";
import { ArtifactPageSchema, ArtifactSaveSchema, artifactPageRoute, holdArtifactPage } from "./artifact-pages.js";
import { readServingSettings, saveServingSettings } from "./mcp-server.js";
import { meaningSearchExplanation, meaningSearchOn, meaningSearchSetting } from "./tool-loading.js";
import { handleA2a, remoteAgentsApi } from "./a2a-routes.js";
import type { createBranch } from "./index.js";
import { goalApi } from "./goal-mode.js";
import { diagramFrameRoute } from "./diagram-frame.js";
import { rewindApi } from "./rewind.js";
import { PreferencesSchema, preferences } from "./preferences.js";
import { asksApi, AsksHttpError, handlesAsksPath } from "./asks/api.js"; // mac6/bucket-23: the smaller asks
import { autonomyApi, AutonomyHttpError, handlesAutonomyPath } from "./autonomy/api.js"; // r17-b
import { handlesTrunksPath, trunksApi, TrunksHttpError } from "./trunks/api.js"; // R17-A: Trunks
import { handlesShellLookPath, shellLookApi, ShellLookError } from "./shell-look.js"; // phase2/shell
import { codingApi, CodingHttpError, handlesCodingPath } from "./coding/api.js"; // mac7/r17-d: coding polish
import { handlesPersonalPath, personalApi, PersonalHttpError } from "./personal/api.js"; // R17-C
import { handlesReachPath, reachApi, ReachHttpError } from "./reach/api.js"; // r17-i
import { handlesSafetyPath, safetyApi, SafetyHttpError } from "./safety-extras/api.js"; // mac7/r17-g: the safety extras
import { codesResting, confirmWithCode, restingRefusal } from "./safety-extras/code-approvals.js"; // mac7/r17-g
import { safetyMode } from "./safety-extras/settings.js";
import { runSteps } from "./run-steps.js"; // pass 17: Timeline and Helpers
import { projectsApi, secretsApi } from "./owner-data-api.js";
import { HttpError, readJsonBody as readBody } from "./server-http.js";
import { connectorsApi } from "./connectors-api.js"; // eng-connectors
import { handlesSourceRequestPath, sourceRequestsApi } from "./self-development-requests.js";
import { handlesSourceMergePath, sourceMergeApi } from "./self-development-merge.js";
import { flowsBoardsApi, FlowsBoardsHttpError, handlesFlowsBoardsPath } from "./flows-boards/api.js"; // r17-h
import { handlesLearningMorePath, learningMoreApi, LearningMoreHttpError } from "./learning-more/api.js"; // R17-F
import { handlesSeasonsPath, seasonsApi, SeasonsHttpError } from "./seasons/api.js"; // Seasons
import { handlesLearnPath, learnApi, LearnHttpError } from "./learn/api.js"; // mac7/learn
// mac4/bucket-20: the Agent Protocol, programs lending tools, and the owner's interop routes.
import { handleInterop, handlesInteropPath } from "./interop/api.js";
import { clientToolsPath, serveClientToolSocket } from "./interop/client-tools.js";
import { LOOK_LANGUAGES, lookApi } from "./terminal-theme.js";
// Wave mac3: the owner's control dashboard, a page of its own at /dashboard.
import {
  DashboardApiError, dashboardAccess, dashboardApi, dashboardSettings, handlesDashboardPath, isDashboardFile, registerRestartTool,
} from "./dashboard-api.js";
// Wave mac3 (commands): the one slash-command table's routes.
import { CommandApiError, commandsApi, handlesCommandsPath } from "./commands/api.js";
import { tokenReport } from "./commands/tokens.js";
import { handlesPromptsPath, promptsApi } from "./prompt-library-api.js"; // bucket 12
import { handlesWikiPath, wikiApi } from "./wiki.js";
import { handlesSkillInstallsPath, skillInstallsApi } from "./skill-installs.js"; // bucket 12
import { PolicyRememberSchema, nextPolicy, policyPresets, readPolicy, savePolicy } from "./policy.js";
import { looseningRefusal, policyChangeRefusal, withoutConfirm } from "./policy-change-guard.js"; // Q257
import { PrivacyChangeRefused } from "./privacy-guard.js"; // the privacy checks are held to the same yes
import { mayAnswerHere, nothingWaitingRefusal, personConversation, personTaskHere, unnamedAnswerRefusal } from "./household-approvals.js"; // Q257, Q259
import { householdStateParts, ownerStateParts } from "./household-state.js"; // Q258
import { archiveBodyLimit } from "./session-library.js";
import { maximumMemoryArchiveBytes } from "./memory.js";
import { conversationMarkdown, maximumImportBytes } from "./memory-export.js";
import { saveAssistantIdentity } from "./identity.js";
import { contextFileStatus, saveContextFileSettings, contextFileSettings } from "./context-files.js";
// mac3/reflection-skills: the learning loop's routes.
import { reflectionApi } from "./reflection/api.js";
import { handlesSettingsKitPath, settingsKitApi, settingsKitBodyBytes, SettingsKitError } from "./settings-kit/api.js"; // R17-S-A
import { settingsKitWriters } from "./settings-kit/writers.js";
import { PinnedSettingError, pins } from "./settings-kit/pins.js"; // mac7/wake-pins
import { StartsElsewhereError } from "./trunks/starts-in.js"; // Q44
import { saveWakeWordSettings, wakeWordSettings, wakeWordView } from "./voice-wake.js"; // mac7/wake-pins
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48 review
import { dictationOwnerOnlyRefusal, dictationSettings, dictationView, saveDictationSettings } from "./voice-dictation.js"; // mac7/live-voice
import { HearRefused, hearInWindow } from "./voice-dictation-window.js"; // RES-709
import { voiceSettings, saveVoiceSettings } from "./voice.js";
import { voiceApi } from "./voice-api.js";
// bucket-18: pull requests from changes (A0300), and which requests came with a short-lived key.
import { pullRequestHookSettings, savePullRequestHookSettings } from "./pr-hook.js";
import { markShortLivedKey, startedWithShortLivedKey } from "./key-context.js";
import { noteSetupOrigin, setupOriginHeader } from "./setup-origin.js";
import { onboardingRecord, saveOnboarding } from "./onboarding.js"; // setup-resume: how far setup got, merged
import { connectionCheck } from "./local-connection-policy.js"; // mac5/key-sweep: Test this connection
import type { NetworkPolicy } from "./network-policy.js";
// ---- bucket 19: people signing in from their own device (src/people/). ----
import { notPeople, PeopleHttpError, peopleApi, peopleSignInRoute } from "./people/api.js";
import { People } from "./people/index.js";
import { peopleEnabled } from "./people/settings.js";
import { interopMode } from "./interop/settings.js";
import { requireBoundSession } from "./people/access.js";
import { keyAnswerRefusal, keyStopRefusal, shortLivedKeyMark } from "./key-context.js";
import { ownersOwnTask } from "./asked-task.js"; // Q050
import { helperMark, needsYou } from "./needs-you.js"; // Q050
import { currentPerson, enterPairedDoor, enterPerson } from "./people/context.js";
import { type CallerFacts, enterCaller, resolveCaller } from "./caller.js";
import { callerRefusal, offLimitsToHousehold } from "./caller-policy.js";
// ---- end bucket 19 ----
// bucket-18: code editor (A0098)
import { handlesWorkspaceEditorPath, workspaceEditorApi, workspaceEditorSettings, WorkspaceEditorApiError } from "./workspace-editor-api.js";
import { isVideoPath, readWorkspaceVideo, VideoFileError } from "./media-file.js"; // FQ-collaboration: media-comments
import { protectedTarget } from "./never-break/protected.js"; // bucket-18 integration review
// mac7/bind: where this door listens, and who may change that (src/listen-address.ts).
import {
  addressCheckMs, decideListenHere, fromThisComputer, type ListenDecision, listenAsked, listenChangeRefusal,
  listenNowHereReason, listenReadRefusal, type ListenState, listenView, type OwnAddress,
  ownAddresses, saveListenSettings, thisComputerAddress, watchAddresses,
} from "./listen-address.js";
import type { ProbeTailscale } from "./remote/tailscale.js";
import { lockdownActive, onLockdownChange } from "./lockdown.js";
import { handlesYourDataPath, resumeUnfinishedDeletes, yourDataApi } from "./your-data.js";
import { helperParent, helperSteerRefusal, helperStopRefusal } from "./helper-control.js"; // DESIGN-DIRECTION PR 1
import { parseModelCommand } from "./model-switch.js";
import { pricingSettings, savePricingSettings, pricingTableInUse, estimateCost, formatCost, tokenCountsOf } from "./pricing.js";
import { usageReportRoute } from "./usage-report-api.js"; // bucket 14 (A0367)
import { conversationBootstrapIds } from "./conversation-bootstrap.js";
import { builtInImagePrices, imagePricedAt, knownPictureModels, mediaSettings, saveMediaSettings } from "./media-settings.js";
import { providerImages } from "./media-images.js";
// Bucket 17.
import { bucket17Api, handlesBucket17, readMediaBody } from "./media-understand-api.js";
import { troubleshootApi } from "./troubleshoot.js"; // w911 (A0374) hook.
import { handlesQa, qaApi, qaDeps } from "./qa-api.js"; // w911 (A1753) hook.
import { browserContainerApi, handlesBrowserContainer } from "./browser-container-api.js"; // w911 (A2019) hook: import
import { handlesPageNotes, pageNotesApi } from "./browser-notes-api.js"; // w911 (A2144) hook: page notes
import { buildTraceDocument, traceSettings, saveTraceSettings } from "./trace.js";
import { writeDiagnosticsBundle } from "./diagnostics.js";
import { handlesUpdateFailurePath, updateFailureApi } from "./update-failure.js";
import { dataCopyApi, DataCopyRefusal } from "./install/data-copy.js";
import { handlesUpdateFixPath, updateFixApi } from "./update-fix.js";
import { attachmentForWindow, rangeWanted, shownInPage } from "./attachments.js";
import { diagnosticApi, handlesDiagnosticPath, installTypeOf, newRequestId, startDiagnosticLog } from "./diagnostic-api.js"; // mac7/diagnostics
import { diagnose } from "./diagnostic-log.js";
import { toolCatalogReport } from "./tool-report.js";
// Wave 5 (deployment): installing, background running and reaching Branch from a phone.
import { RemoteAccess } from "./remote/remote-access.js";
import { cliAgentRows } from "./providers/cli-agent.js";
import { addProgram, forgetProgram } from "./accounts/saved-sign-ins.js";
import { GatewayAuth } from "./remote/gateway-auth.js";
import { answerHeader, answerProof, answerShort, askHeader, atWindowAddress, isSessionKey, markFor, newBoot, ProofDoor, proofPath, sameKey, sessionKey } from "./engine-proof.js";
import { hereOnly, keyMayTravel, lockdownOffHereOnly, markDoorRequest, renewPath, throughADoor, writeNewWindowKey } from "./remote/window-key.js";
// ---- mac7/nodes: the owner's devices (src/devices/) ----
import type { Duplex } from "node:stream";
import { devicesApi, DevicesHttpError, handlesDevicesPath, openDevicePaths, openDevicesApi } from "./devices/api.js";
import { handlesPhoneAppPath, PhoneApp, phoneAppApi, PhoneAppRefusal } from "./phone-app/index.js";
import { claimedDevice, refuseUpgrade } from "./devices/hub.js";
import { decide as allowlistSays, readSenderAllowlist } from "./channels/allowlist.js";
import { remoteChannel } from "./remote/gateway-auth.js";
import { socketPath as deviceSocketPath } from "./devices/protocol.js";
// ---- end mac7/nodes ----
import { deploymentApi, shipAutostart, type DeploymentContext } from "./deployment-api.js";
import { shipKeepRunningOn } from "./keep-running.js"; // the ship-on rule: keeping Branch running
import { quitRequest } from "./install/quit.js"; // bucket 22
import { changeSelfRule, SelfRuleRefusal, selfRulesPath, selfRulesView } from "./self-rules.js";
import { clearRunning, writeRunning } from "./install/running.js";
import { readFirstStart, recordFirstStart } from "./install/update-backup.js";
import { readDesktopSettings, saveDesktopSettings } from "./integrations/desktop-config.js";
import { readCredentialSettings, saveCredentialSettings } from "./credential-cli.js";
// mac7/vault-autofill (R17-068): the owner's book of saved sign-ins Branch may fill into a page.
import { readVaultAutofillSettings, saveVaultAutofillSettings } from "./vault-autofill.js";
import { keychainApi, keychainSettingsPath, permissionsContext } from "./keychain-api.js";
import { optionalFields } from "./feature-switches.js";
import { auditCsvResponse, handlesMiscPath, miscApi, MiscApiError } from "./misc-api.js";
// Batch 19 (wave 7): spans, sending traces somewhere, the counters page and the rule sentences.
import { handlesTracingPath, logsResponse, metricsResponse, tracingApi, TracingApiError } from "./tracing-api.js";
// Batch 26 (wave 8): where scripts run, what may reach the internet, how much one person may ask
// for, the owner's other computers, marks, and how long conversations are kept.
import { handlesSandboxRemotePath, sandboxRemoteApi, SandboxRemoteApiError } from "./sandbox-remote-api.js";
// FQ-execution.host-bridge: running a program on an explicitly chosen other computer, straight from Settings.
import { handlesHostBridgePath, hostBridgeApi, HostBridgeApiError } from "./host-bridge-api.js";
// Wave mac2 (move-in): bringing chats and memory over from another assistant.
import { contextFileSinkFor, defaultMoveInOptions, handlesMoveInPath, moveInApi, MoveInApiError } from "./migrate-api.js";
// Wave mac2 (guards): which workspace folders are trusted, and the loop guard switch.
import { guardsApi, GuardsApiError, handlesGuardsPath } from "./run-guards.js";
// R17-S-B: the hidden knobs, with plain labels, and the launch settings file as a card.
import { handlesKnobsPath, knobsApi, KnobsApiError } from "./knobs/api.js";
// R17-E: models, cheaper and smarter (src/model-savings/).
import { syncMixtures } from "./model-savings/mixture.js"; // a forgotten connection takes its mixtures with it
import { readChatIntake, saveChatIntake } from "./channels/intake-settings.js"; // Settings › Chat apps
import { channelFormats, saveChannelFormatting } from "./channels/formatting-settings.js";
import { replyStyles, saveReplyStyle } from "./channels/reply-style.js";
import { practiceRunsEnabled, savePracticeRuns } from "./practice-runs.js";
import { setupIds } from "./channel-setup/service.js";
import { siteSkillsFor, type SiteSkillSource } from "./integrations/browser-sites.js"; // Settings › Site skills
import { handlesSavingsPath, savingsApi, SavingsApiError } from "./model-savings/api.js";
// mac7/usage-bar: how much of each connection's allowance is left (src/usage-limits.ts).
import { panelsWork, panelsWorkPath } from "./panels-work.js"; // phase2/panels
import { liveStage, liveStagePath } from "./live-stage.js"; // live-stage
import { streamLiveStage } from "./live-stage-stream.js";
import { streamLiveScreen, stopLiveScreen, liveScreenPath, LiveScreenRefusal, screenControl, screenTakeOverPath, screenHandBackPath } from "./live-screen.js"; // parity-b2
import { MiniAppDoor } from "./miniapp/door.js";
import { PhoneAccess, type Runner as TailscaleRunner } from "./miniapp/phone-access.js";
import { handlesMiniAppPath, MiniAppApi } from "./miniapp/api.js";
import { BrowserControlApi, browserApiPath, handlesBrowserApiPath, requireBrowserOwner } from "./browser-control-api.js";
import { CapturedApiSkillsApi, capturedApiSkillsPath } from "./captured-api-skills-api.js";
import { TasteApi, handlesTasteApiPath } from "./taste/api.js";
import { conversationModeApi, ConversationModeError, handlesConversationModePath, modeRefusal, planAgreed } from "./conversation-mode-api.js";
// mac7/smoke-fixes (B4): the terminal beside an open window — keys, one task's trace, the places that only look.
import { traceReport } from "./trace-report.js";
import { scopeDescriptions } from "./session-tokens.js";
import { readOnlyTerminalCommands, runTerminalCommand } from "./terminal-cli.js";
import { handlesUsageLimitsPath, readUsageGlance, usageGlancePath, usageLimitsRoute, UsageLimitsError } from "./usage-limits-api.js";
import { DelightError, delightRoute, handlesDelightPath, setupTaskIds } from "./delight.js"; // phase2/delight
import { appAskSettings, saveAppAskSettings } from "./desktop-app-ask.js"; // unhold-control
// R17-S-C: the comfort settings (src/comfort/); every change is the owner's.
import { ComfortApiError, comfortApi, handlesComfortPath } from "./comfort/api.js";
// mac3/never-break: the gateway switch and suggested changes (src/never-break/api.ts).
import { handlesNeverBreakPath, NeverBreakApiError, neverBreakApi, type NeverBreakExtras } from "./never-break/api.js";
import { channelSetupApi, handlesChannelSetupPath } from "./channel-setup/api.js"; // mac7/connect
import { SetupRefusal } from "./channel-setup/check.js"; // mac7/connect
// mac6/accounts: several accounts per connection (src/accounts/api.ts).
import { AccountsApiError, accountsApi, handlesAccountsPath } from "./accounts/api.js";
import { accountsServiceFor } from "./accounts/service.js";
import { mergeChatGPTDuplicates } from "./accounts/dedupe.js";
import { snapshotData } from "./never-break/canary.js";
// Wave mac3 (tool-safety): the second look before an approval.
import { reviewerView, saveReviewerSettings } from "./approval-reviewer.js";
import { helpApi } from "./help.js";
import { AuthLimiter, noteAuthFailure, requestSource, tunnelSource, webhookLimitKey } from "./auth-limits.js";
import { handlesOrchestrationPath, orchestrationApi, OrchestrationApiError } from "./orchestration-api.js";
// Batch 21 (wave 8): the app's own OpenAPI description, Lockdown, kept answers, whole sets of
// questions at once, and what each project has cost.
import { handlesOtherPath, otherApi, OtherApiError } from "./other-api.js";
import { handlesSdkKitPath, sdkKitApi, SdkKitError } from "./sdk-kit.js"; // bucket 21
import { gitlabApi, GitLabApiError, handlesGitLabPath } from "./gitlab-connection.js"; // RES-719
import { webPagesApi, WebPagesApiError } from "./web-pages.js"; // w911 (A0743, A1452) hook
import { audit, csvCell } from "./audit.js";
import { AppLockRefusal } from "./session-lock.js";
import { unifiedSearch } from "./unified-search.js";
import { proposeSchedule } from "./schedule-words.js";
import { proposeTrigger } from "./trigger-words.js";
import { ownerTimezone } from "./person-about.js"; // your-profile
import { workbooksRoute } from "./workbooks.js"; // P17-D §3
import type { AnswerShape, ShapedAnswer } from "./answer-shape.js";
// Wave 6 (collaboration and workflows): sharing pages and links, labels and notes, workflows,
// the waiting line for tasks, days off and quiet hours, and the household's profiles.
import { collabApi, collabState, notCollab, runForCurrentPerson } from "./collab-server.js";
import { shareHtml, RedactionSchema } from "./conversation-share.js";
import { askSpreadsheet } from "./data-ask.js"; // p17: Ask a spreadsheet
import { longTaskDeadlineMs } from "./long-work.js"; // long-work

type Branch = Awaited<ReturnType<typeof createBranch>>;
const actionSchema = z
  .object({
    tool: z.string().min(1).max(100),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
/**
 * The owner's answer to a plan waiting for them: yes, yes with the wording of a step changed, or
 * no with the reason. A body with nothing but steps in it is a yes, which is what it always was.
 */
const PlanAnswerSchema = z.object({
  decision: z.enum(["approve", "reject"]).optional(),
  steps: z.array(PlanStepSchema).min(1).max(8).optional(),
  reason: z.string().trim().max(500).optional(),
}).strict();
/** Which of the two modes this conversation is in, and how far it may go before checking back. */
const PlanActChoiceSchema = optionalFields(PlanActSettingsSchema).extend({
  sessionId: z.string().max(64).optional(),
  /** "conversation" sets this one apart; "project" changes what every conversation starts from. */
  scope: z.enum(["conversation", "project"]).default("conversation"),
  /** Puts this conversation back on whatever the project says. */
  followProject: z.boolean().optional(),
}).strict();
/** A monthly limit in tokens, in dollars, or both. Older settings that only set tokens still parse. */
const budgetSchema = z
  .object({
    maxMonthlyTokens: z.number().int().positive().optional(),
    maxMonthlyDollars: z.number().positive().max(1_000_000).optional(),
    pauseAtBudget: z.boolean(),
  })
  .strict()
  .refine((b) => b.maxMonthlyTokens !== undefined || b.maxMonthlyDollars !== undefined, {
    message: "Set a monthly limit in tokens, in dollars, or both",
  });
/** What a new monthly limit lets Branch spend beyond the saved one, in words, or null when it lets it spend no more. */
function budgetLooser(before: z.infer<typeof budgetSchema> | undefined, after: z.infer<typeof budgetSchema>): string | null {
  if (!before) return null;
  const found: string[] = [];
  const more = (was: number | undefined, now: number | undefined): boolean => was !== undefined && (now === undefined || now > was);
  if (more(before.maxMonthlyDollars, after.maxMonthlyDollars))
    found.push(after.maxMonthlyDollars === undefined ? "there would be no monthly limit in dollars" : `the monthly limit would go up from $${before.maxMonthlyDollars} to $${after.maxMonthlyDollars}`);
  if (more(before.maxMonthlyTokens, after.maxMonthlyTokens))
    found.push(after.maxMonthlyTokens === undefined ? "there would be no monthly limit in tokens" : `the monthly limit would go up from ${before.maxMonthlyTokens} to ${after.maxMonthlyTokens} tokens`);
  if (before.pauseAtBudget && !after.pauseAtBudget) found.push("work would no longer pause at the monthly limit");
  return found.length ? found.join("; ") : null;
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
async function sessionToken(dataDir: string): Promise<string> {
  const path = join(dataDir, "session-token");
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Session token must not be a link");
    const token = (await readFile(path, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(token)) return token;
    // QA retest 2026-09-28 (TRUNK-180): a damaged token file used to stop every start ("Invalid saved session token"),
    // and `branch quit` could not ask the gateway to close either. A damaged token matches no window, so a new one is
    // made; the window asks for the new one (`branch token` shows it), as after a first start.
    const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(path, aside);
    console.error(`The saved session token was damaged; it was put aside as ${aside} and a new one made.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(path, token, { mode: 0o600, flag: "wx" });
  return token;
}
/**
 * Which addresses a request may claim it was sent to. Normally only this computer's own loopback
 * address; while "reach Branch from my phone" is on, also the private Tailscale address and name;
 * and while the door is open to the private network (mac7/bind, src/listen-address.ts), the names
 * and addresses this computer answers on.
 * Everything else is refused, which is what stops a web page elsewhere talking to Branch.
 */
/** The name part of a `host:port`, with an IPv6 address left in its brackets. */
function hostOf(value: string): string {
  const text = value.trim().toLowerCase();
  if (text.startsWith("[")) { const end = text.indexOf("]"); return end < 0 ? text : text.slice(0, end + 1); }
  const colon = text.indexOf(":");
  return colon < 0 ? text : text.slice(0, colon);
}
/**
 * An allowed entry that carries no port. Branch inside a container cannot know which port of the
 * host it was published on, so a name it answers to is allowed whatever port the request arrived
 * at. The port never kept anyone out; the local key does, and the name is still what stops a page
 * elsewhere from pointing its own address at this computer.
 */
const anyPortEntry = (entry: string): boolean => (entry.startsWith("[") ? entry.endsWith("]") : !entry.includes(":"));
export function hostAllowed(
  host: string | undefined, origin: string | undefined, url: string, extra: readonly string[] = [],
): boolean {
  const hosts = [new URL(url).host, ...extra];
  const anyPort = extra.filter(anyPortEntry).map((entry) => entry.toLowerCase());
  if (!host || (!hosts.includes(host) && !anyPort.includes(hostOf(host)))) return false;
  if (!origin) return true;
  // bucket 19 (integration review): the same host served over TLS (a paired door behind https) is the same place.
  if (hosts.some((allowed) => origin === `http://${allowed}` || origin === `https://${allowed}`)) return true;
  // mac7/bind (integration review): a portless entry lets a request SAY it was sent to any port,
  // because Branch inside a container cannot know which port of the host it was published on. It
  // must not also let a PAGE on another port of this same computer call itself Branch's own page: a
  // development server, another app's dashboard or a plugin's own page on 127.0.0.1:8080 is a
  // different origin, and `sec-fetch-site` calls it same-site because a port is not part of a site.
  // Branch's own page is served by Branch, so its Origin always carries the very host and port the
  // request arrived at — which is the test here, and it keeps the published-port case working.
  const from = /^https?:\/\/([^/?#]+)$/.exec(origin.trim())?.[1]?.toLowerCase();
  return !!from && from === host.trim().toLowerCase() && anyPort.includes(hostOf(from));
}
function authorize(
  request: IncomingMessage, url: string, token: string, extra: readonly string[] = [],
  /** Batch 19 (wave 7): counts wrong keys per place, so the key cannot be guessed at speed. */
  limits?: { limiter: AuthLimiter; onFailure: (source: string) => void },
  /**
   * Batch 20 (wave 8): a short-lived key made with `branch token create`. It is only looked at
   * after the master key has already failed, so a mistake here can hold up a script and never the
   * owner's own app. It answers the plain reason it refused, or null to let the request through.
   */
  scoped?: (supplied: string) => string | null,
  /**
   * mac5/key-sweep (integration review): whether a key is one of this computer's working keys. A
   * working key refused one route is not a guess, so it is not counted: otherwise a script bumping
   * into the owner's routes would make every short-lived key from that place wait (the dashboard, a
   * paired phone behind the same address) and write a false "wrong key" line into the record.
   */
  working?: (supplied: string) => boolean,
): void {
  if (!hostAllowed(request.headers.host, undefined, url, extra))
    throw new HttpError(403, "Host rejected");
  if (!hostAllowed(request.headers.host, request.headers.origin, url, extra))
    throw new HttpError(403, "Origin rejected");
  if (request.headers["sec-fetch-site"] === "cross-site")
    throw new HttpError(403, "Cross-site request rejected");
  // A bare "Bearer" (the header's trailing space is trimmed on the way) carries no key at all.
  const supplied = request.headers.authorization?.replace(/^Bearer(?: |$)/, "") ?? "";
  const correct =
    supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  const from = requestSource(request.socket?.remoteAddress, request.headers);
  // The right key is checked first and clears the count at once, so the owner's own app can never
  // shut itself out. Only a wrong key is counted, and a place that keeps guessing is made to wait.
  if (correct) { limits?.limiter.succeed(from); return; }
  // Dogfood E7: no key is no guess. The window asks for its data before it is signed in; counting those
  // made this computer wait (429) for its own scripts' keys and wrote a false "wrong tries" line.
  if (!supplied) throw new HttpError(401, "Local session token required");
  const waiting = limits?.limiter.refusal(from, "key");
  if (waiting) throw new HttpError(429, waiting);
  const refusal = supplied && scoped ? scoped(supplied) : "Local session token required";
  if (refusal === null) { limits?.limiter.succeed(from); return; }
  if (!(supplied && working?.(supplied))) limits?.onFailure(from);
  throw new HttpError(401, refusal);
}
/** A study result without its thousands of rows, for the list on the Evaluation screen. */
const studySummary = (result: StudyRunResult) => ({
  id: result.id, studyId: result.studyId, name: result.name, startedAt: result.startedAt,
  rows: result.rows, tasks: result.tasks.length, resumed: result.resumed, stoppedEarly: result.stoppedEarly,
});

/** The new window's files (public/app/**) and its art (public/art/**), served by exact name only. */
const windowFolders = ["app", "art"];
const windowTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".webm": "video/webm", ".mp4": "video/mp4", ".woff2": "font/woff2",
};
let windowFileList: Map<string, [string, string]> | undefined;
/** hot-update: the live build the list was made from (null: the engine's own files). */
let windowFileListOf: string | null = null;
/**
 * Redesign: the list is read from the folders once, at the first request, and never again. A request only ever
 * picks an entry from it; nothing from the request is joined onto a disk path. Links, hidden files, names with
 * anything but letters, digits, dot, dash or underscore, and unknown kinds of file are left out.
 */
function windowFiles(): Map<string, [string, string]> {
  // hot-update: a live build's window files, checked against its record (src/hot-update/window-files.ts), replace the list.
  const live = liveWindowNames(), commit = liveWindowCommit();
  if (windowFileList && windowFileListOf === commit) return windowFileList;
  const found = new Map<string, [string, string]>();
  windowFileListOf = commit;
  if (live) {
    for (const inside of live) {
      const parts = inside.split("/");
      if (!windowFolders.includes(parts[0]!) || parts.length < 2 || !parts.every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part))) continue;
      const type = windowTypes[extname(inside).toLowerCase()];
      if (type) found.set(`/${inside}`, [inside, type]);
    }
    windowFileList = found;
    return found;
  }
  const walk = (relative: string): void => {
    const folder = fileURLToPath(new URL(`../public/${relative}/`, import.meta.url));
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(entry.name)) continue;
      const inside = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(inside);
      const type = entry.isFile() ? windowTypes[extname(entry.name).toLowerCase()] : undefined;
      if (type) found.set(`/${inside}`, [inside, type]);
    }
  };
  for (const folder of windowFolders) walk(folder);
  windowFileList = found;
  return found;
}

async function staticFile(
  path: string,
  response: ServerResponse,
  request?: IncomingMessage,
): Promise<boolean> {
  // Keep the old worker URL updateable, so previously installed registrations can retire.
  if (path === "/service-worker.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    response.end(retiredPhoneWorker);
    return true;
  }
  const assets: Record<string, [string, string]> = {
    // The window (public/index.html, public/app.css; its modules and art under /app/ and /art/ are served by exact file).
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
    "/fonts/archivo.woff2": ["fonts/archivo.woff2", "font/woff2"],
    "/fonts/geist.woff2": ["fonts/geist.woff2", "font/woff2"],
    "/fonts/geist-mono.woff2": ["fonts/geist-mono.woff2", "font/woff2"],
    // The window's manifest and icons; no offline shell is registered.
    "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
    "/assets/icon-192.png": ["assets/icon-192.png", "image/png"],
    "/assets/icon-512.png": ["assets/icon-512.png", "image/png"],
    "/assets/icon-maskable-512.png": ["assets/icon-maskable-512.png", "image/png"],
    "/assets/favicon-16.png": ["assets/favicon-16.png", "image/png"],
    "/assets/favicon-32.png": ["assets/favicon-32.png", "image/png"],
    "/assets/apple-touch-icon.png": ["assets/apple-touch-icon.png", "image/png"],
    // Pairing a phone in its browser (src/remote), and the page people sign in on (bucket 19); both use the shared tokens.
    "/pair": ["pair.html", "text/html; charset=utf-8"],
    "/pair.js": ["pair.js", "text/javascript; charset=utf-8"],
    "/pair.css": ["pair.css", "text/css; charset=utf-8"],
    // A phone paired in its browser sends its own secret on every request (public/app/main.js installs it).
    "/device-headers.js": ["device-headers.js", "text/javascript; charset=utf-8"],
    "/people": ["people.html", "text/html; charset=utf-8"],
    "/people.js": ["people.js", "text/javascript; charset=utf-8"],
    "/people.css": ["people.css", "text/css; charset=utf-8"],
    "/tokens.css": ["tokens.css", "text/css; charset=utf-8"],
    // The people page's words (public/people.js imports it; the owner's dashboard does too).
    "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
    // Every language the look setting takes has its words served (src/terminal-theme.ts LOOK_LANGUAGES), and no other file.
    ...Object.fromEntries(LOOK_LANGUAGES.map((code): [string, [string, string]] => [`/locales/${code}.json`, [`locales/${code}.json`, "application/json; charset=utf-8"]])),
    // Wave mac3: the owner's dashboard (the old window's card that switched it on left with that window). While it is off, isDashboardFile keeps
    // every /dashboard path unserved. Its stylesheets and modules, including its own copies of the words, the theme
    // bridge, the oak, the look and the event reader that left public/ with the old window (#291):
    "/dashboard": ["dashboard/index.html", "text/html; charset=utf-8"],
    "/dashboard/dashboard.css": ["dashboard/dashboard.css", "text/css; charset=utf-8"],
    "/dashboard/style.css": ["dashboard/style.css", "text/css; charset=utf-8"],
    "/dashboard/layout.css": ["dashboard/layout.css", "text/css; charset=utf-8"],
    "/dashboard/control-styles.css": ["dashboard/control-styles.css", "text/css; charset=utf-8"],
    "/dashboard/dashboard.js": ["dashboard/dashboard.js", "text/javascript; charset=utf-8"],
    "/dashboard/commands.js": ["dashboard/commands.js", "text/javascript; charset=utf-8"],
    "/dashboard/sections.js": ["dashboard/sections.js", "text/javascript; charset=utf-8"],
    "/dashboard/feed.js": ["dashboard/feed.js", "text/javascript; charset=utf-8"],
    "/dashboard/look.js": ["dashboard/look.js", "text/javascript; charset=utf-8"],
    "/dashboard/i18n.js": ["dashboard/i18n.js", "text/javascript; charset=utf-8"],
    "/dashboard/theme-bridge.js": ["dashboard/theme-bridge.js", "text/javascript; charset=utf-8"],
    "/dashboard/grove.js": ["dashboard/grove.js", "text/javascript; charset=utf-8"],
    "/dashboard/appearance.js": ["dashboard/appearance.js", "text/javascript; charset=utf-8"],
    "/dashboard/activity-feed.js": ["dashboard/activity-feed.js", "text/javascript; charset=utf-8"],
    // One theme's colours under Branch's token names; the engine reads it too (src/terminal-theme.ts, src/achievements.ts).
    "/theme-catalogue.js": ["theme-catalogue.js", "text/javascript; charset=utf-8"],
    // Wave 8: the small box a page of the owner's own can include; served only while the owner has switched it on.
    "/widget.js": ["widget.js", "text/javascript; charset=utf-8"],
  };
  const asset = Object.hasOwn(assets, path) ? assets[path] : windowFiles().get(path);
  if (!asset) return false;
  // hot-update: the live build's checked bytes when one is in use; the engine's own file otherwise.
  const body = liveWindowFile(asset[0]) ?? await readFile(
    new URL("../public/" + asset[0], import.meta.url),
  );
  /* rw4-language: the words (public/locales, ~465 KB for English) are kept by the browser and asked about again on
     every start: an unchanged file answers 304 with no body, and a new build's words differ, so they come fresh. */
  const words = path.startsWith("/locales/");
  const etag = words ? `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"` : "";
  if (words && request?.headers["if-none-match"] === etag) {
    response.writeHead(304, { etag, "cache-control": "no-cache" });
    response.end();
    return true;
  }
  response.writeHead(200, {
    "content-type": asset[1],
    "cache-control": words ? "no-cache" : "no-store",
    ...(words ? { etag } : {}),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      // The manifest can name the web app; worker-src permits the legacy retirement update.
      // phase2/delight: blob: lets the owner's own background picture or video, kept in the window's own
      // storage, be shown without ever being sent anywhere. Only the page's own script can make one.
      // Integration review: blob: is allowed for pictures and sound/video only, never for scripts,
      // workers, frames, objects or connections, and it stays on for everyone rather than following the
      // background switch: reading answers aloud (public/voice.js, voice-talk.js) plays blob: sound too,
      // which the old media rule silently refused; img-src already takes data:, which untrusted text could
      // reach more easily than blob: (a blob: address is minted only by this page's own script, every
      // artifact frame is sandboxed without scripts, and chat text renders no pictures).
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  response.end(body);
  return true;
}
/** p17: which parts of the assistant go into the one file. */
const AgentExportSchema = z.object({ sections: z.array(z.enum(agentSections)).min(1).max(agentSections.length) }).strict();
/** Setup as the window sees it (src/onboarding.ts): whether it is over, and how far it got. `done` is the install's,
 *  so a household person's window reads it too; how far setup got and the pop-ups switch are the owner's alone, and
 *  anybody else reads the defaults with `mine: false`. */
function onboardingState(app: Branch): Record<string, unknown> {
  const saved = onboardingRecord(app.store, app.runtime.owner);
  if (!app.store.profiles.isOwner()) return { done: saved.done, completed: [], trust: false, popups: true, welcomed: false, skipped: false, finishHidden: false, mine: false };
  const { completedAt: _when, ...view } = saved;
  return { ...view, mine: true };
}
/** A real, tiny completion through the chosen preset so setup ends with evidence, not a saved form. */
async function testModel(app: Branch, body: unknown): Promise<unknown> {
  const { preset } = z.object({ preset: z.string().min(1).max(64).nullable().optional() }).strict().parse(body);
  const owner = app.runtime.owner;
  if (!preset && !app.runtime.models.configured) throw new HttpError(400, noModelWords);
  const chosen = preset ? app.runtime.models.presets.get(preset) : app.runtime.models.plan(owner, "").candidates[0];
  if (!chosen) throw new HttpError(400, "That model is not configured");
  const started = Date.now();
  try {
    const completion = await chosen.provider.complete({
      messages: [
        { role: "system", content: "You are Branch Agent. Reply with the single word OK." },
        { role: "user", content: "Connection test" },
      ],
      tools: [], maxTokens: 16, signal: AbortSignal.timeout(30000),
    });
    return { ok: true, presetId: chosen.id, presetName: chosen.name, model: chosen.model,
      reply: completion.content.slice(0, 80), ms: Date.now() - started };
  } catch (error) {
    throw new HttpError(502, `${chosen.name} did not answer: ${errorText(error)}`);
  }
}

function providersCatalog(): unknown {
  return { presets: allPresets() };
}

const providerTestInput = z.object({
  preset: z.string().min(1).max(64).optional(), endpoint: z.string().url().max(2048).optional(),
  model: z.string().min(1).max(256).optional(), apiKey: z.string().min(1).max(4096).optional(),
}).strict();

/** Sends one tiny request through the same provider classes the assistant uses, so URL rules and errors match real use. */
async function testProvider(body: unknown, policy: NetworkPolicy): Promise<unknown> {
  const input = providerTestInput.parse(body);
  const chosen = input.preset ? findPreset(input.preset) : undefined;
  if (input.preset && !chosen) throw new HttpError(400, "Unknown provider preset");
  const endpoint = input.endpoint ?? chosen?.baseUrl, model = input.model ?? chosen?.modelIds[0];
  if (!endpoint || !model || !input.apiKey) throw new HttpError(400, "Provide the address, a model name and the key to test");
  // mac5/key-sweep: the typed key goes nowhere the network rules refuse; a catalogue service on this
  // computer keeps the same narrow allowance as a saved connection (src/local-connection-policy.ts).
  const check = connectionCheck(policy, chosen ? catalogEntry(chosen.id) : undefined, endpoint);
  const fetchImpl = (async (target: string | URL | Request, init?: RequestInit) => {
    await check(new URL(target instanceof Request ? target.url : String(target)), "model connection test");
    return fetch(target, { ...init, redirect: "error" });
  }) as typeof fetch;
  const started = Date.now();
  try {
    await check(new URL(endpoint), "model connection test");
    const options = { endpoint, model, apiKey: input.apiKey, fetchImpl };
    // --- mac5/providers: services whose route the header-style guess below gets wrong (Perplexity's
    // Agent API) or that have ended (GitHub Models). See src/provider-factory.ts testRouteFor.
    const ownRoute = chosen ? testRouteFor(chosen.id, endpoint, model, input.apiKey, fetchImpl) : null; // key-sweep review: redirects checked too
    // --- end mac5/providers
    const provider = ownRoute ? ownRoute : chosen?.headerStyle === "google-key" ? new GeminiProvider(options)
      : chosen?.headerStyle === "x-api-key" ? new AnthropicProvider(options) : new OpenAIProvider(options);
    const completion = await provider.complete({
      messages: [{ role: "system", content: "You are Branch Agent. Reply with the single word OK." }, { role: "user", content: "Connection test" }],
      tools: [], maxTokens: 16, signal: AbortSignal.timeout(20000),
    });
    return { ok: true, model, reply: completion.content.slice(0, 80), ms: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: providerFailureReason(error), ms: Date.now() - started };
  }
}

function providerFailureReason(error: unknown): string {
  const text = errorText(error);
  if (/\b(401|403)\b|invalid.*key|unauthori|forbidden/i.test(text)) return "The key was not accepted. Check it and try again.";
  if (/\b404\b|not found|no such model|does not exist/i.test(text)) return "That model name was not found at this address.";
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|timed? ?out|abort/i.test(text)) return "Could not reach that address. Check the URL and your connection.";
  if (/private|blocked|policy|requires HTTPS/i.test(text)) return "That address is not allowed: " + text.slice(0, 120);
  return "The provider answered with an error: " + text.slice(0, 160);
}

async function localProviders(): Promise<unknown> {
  const found: Array<{ runtime: string; baseUrl: string; models: string[] }> = [];

  // Probe Ollama where it answers (127.0.0.1:11434 unless BRANCH_OLLAMA_URL moves it)
  try {
    const response = await fetch(`${ollamaHome}/api/tags`, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (response.ok) {
      const data = (await response.json().catch(() => ({ models: [] }))) as { models?: Array<{ name?: string }> };
      const models = (data.models || [])
        .filter((m) => m.name && typeof m.name === "string")
        .map((m) => m.name!.split(":")[0]!);
      if (models.length > 0) {
        found.push({
          runtime: "ollama",
          baseUrl: `${ollamaHome}/v1`,
          models,
        });
      }
    }
  } catch {
    // Ollama not running
  }

  // Probe LM Studio at 127.0.0.1:1234
  try {
    const response = await fetch("http://127.0.0.1:1234/v1/models", {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (response.ok) {
      const data = (await response.json().catch(() => ({ data: [] }))) as { data?: Array<{ id?: string }> };
      const models = (data.data || [])
        .filter((m) => m.id && typeof m.id === "string")
        .map((m) => m.id!);
      if (models.length > 0) {
        found.push({
          runtime: "lm-studio",
          baseUrl: "http://127.0.0.1:1234/v1",
          models,
        });
      }
    }
  } catch {
    // LM Studio not running
  }

  return { local: found };
}

/** Q259: which conversations are the household person's at the window own, for narrowing the owner's usage to them. */
const ownConversationOf = (app: Branch) => (sessionId: string): boolean => personConversation(app.store, app.runtime.owner, sessionId);

/** The preset that actually served a run: the last recorded selection or fallback, if any. */
function modelUsed(app: Branch, runId: string) {
  const events = app.store.events(runId).filter((event) => ["model.selected", "model.fallback"].includes(event.kind));
  const last = events.at(-1);
  if (!last) return null;
  const data = last.data;
  return last.kind === "model.fallback"
    ? { presetId: data.to, provider: data.provider, model: data.model, fellBackFrom: data.from }
    : { presetId: data.presetId, presetName: data.presetName, provider: data.provider, model: data.model, reasoning: data.reasoning };
}
/** Tools that exist right now, grouped by permission, with what makes each group ready. */
function toolInventory(app: Branch) {
  const readiness: Record<string, string> = {
    "web.read": app.web.settings().allowPrivateAddresses ? "ready (private addresses allowed)"
      : app.web.settings().fakeIpProxy === true ? "ready (a fake-IP proxy does the resolving)" : "ready",
    "shell.execute": "ready (configured host commands)",
    "git.remote": "ready (sending to a server switched on)",
    "github.manage": "ready (GitHub token saved)",
    "gitlab.read": "ready (GitLab connected)", "gitlab.manage": "ready (GitLab connected)",
    "browser.read": "ready (configured origins)", "browser.act": "ready (configured origins)",
    "browser.interact": "ready (configured origins)",
  };
  const channels = app.channels.summary().channels.map((c) => c.id);
  return {
    tools: app.registry.inventory().map((tool) => ({ ...tool, readiness: readiness[tool.permission] ?? "ready" })),
    permissions: app.registry.permissions(),
    channels,
    models: [...app.runtime.models.presets.keys()],
  };
}
/**
 * Tasks waiting for the person: each conversation's newest task when it stopped to ask, or when Branch closed on it
 * and it can be continued. Read with store.waitingRuns, as the Activity list reads its waiting tasks, so the two lists
 * agree and a question stays listed however much other work finishes after it.
 */
/**
 * Dogfood A6/B6: an answer settles the task that stopped to ask. A task stops on its question, so a yes alone
 * carried nothing on, and the task went on waiting in the banner. Now a yes to the owner's own task, given in the
 * owner's window, carries that same task on (Q050: under its own id, with no words written for the owner and no second
 * task beside it), and so does a no (dogfood D5: told of the no, it replies with what it can do instead). Any other
 * answer (to a chat's or a schedule's task, which carries on from where it came) ends its wait. A task with another
 * question still waiting is left for that one.
 */
/** What an answer did to the task that asked (NAS bd6cf44): the window says so, rather than always "it carries on". */
type Settled = "carrying-on" | "still-waiting" | "settled";
async function settleAsked(app: Branch, asked: { runId: string; sessionId: string; source: string; label: string; fingerprint: string }, decision: "allow" | "deny"): Promise<Settled> {
  const run = app.store.run(asked.runId);
  if (!run || run.status !== "needs_input" || app.runtime.approvals.waiting(asked.sessionId).length) return "still-waiting";
  // Only the owner's own task, answered by the owner at the window: never a key's (it records source "owner" too,
  // and a carry-on would lose its key mark), a household person's, or one that came from elsewhere (NAS 618407c).
  // Pass 17 (Helpers): nor a helper's. Its carry-on would start in the helper's conversation as a task of the owner's
  // own, without the narrower reach the helper was given; its question is answered and the helper is settled instead.
  const owners = asked.source === "owner" && ownersOwnTask(app.store, run.id);
  const transferred = app.reachParts.continuity.canContinueAfterApproval(run.id);
  if ((owners || transferred) && app.store.profiles.isOwner() && !startedWithShortLivedKey() && carryOnAllowed(app, run)) {
    // The conversation busy with another task: the carry-on is not started, and this task keeps waiting (the one-time
    // yes is still there for the owner's next message), rather than being marked done with its work undone.
    // A carry-on refused as it starts (the monthly budget, the owner's inlet filter, a closing app) leaves the task waiting
    // and writes down why, where the task's own record shows it (NAS bd6cf44).
    let refused = false;
    // Q050: the task that asked carries on itself, told of the yes to its exact request; nothing is said in the owner's
    // name, and no second task starts. Dogfood D5: a No carries it on the same way, told of the No, so the owner gets a
    // reply and another way rather than silence.
    const started = transferred ? app.reachParts.continuity.continueAfterApproval(run.id, decision, asked.fingerprint)
      : decision === "allow" ? app.runtime.continueAsked(run.id) : app.runtime.continueRefused(run.id, asked.fingerprint);
    const carry = started
      .catch((error: unknown) => { refused = true; app.store.event(run.id, "run.carry_on_refused", { reason: errorText(error).slice(0, 300) }); });
    // NAS 0adb368: a refusal as it starts (the budget, an inlet filter, a busy conversation) settles within microtasks,
    // so one turn of the event loop tells it apart, and the window never says "it carries on" when nothing did.
    await Promise.race([carry, new Promise((resolve) => setTimeout(resolve, 0))]);
    if (decision === "allow") return refused ? "still-waiting" : "carrying-on";
    if (!refused) return "carrying-on";
    // A No always ends this task's wait: one that could not carry on is ended here.
    app.store.finish(run.id, "cancelled", run.output);
    return "settled";
  }
  if (decision === "allow" && (owners || transferred) && app.store.profiles.isOwner() && !startedWithShortLivedKey()) return "still-waiting";
  app.store.finish(run.id, decision === "allow" ? "completed" : "cancelled", run.output);
  return "settled";
}
/**
 * Whether the owner's answer may carry the task on in its conversation now. With a plan waiting for the owner's own
 * answer, a carry-on would read as agreeing to it (NAS 06a9508, dead082); a newer task, or words written after the task
 * stopped, would be answered by it instead (NAS 166fbe3, 3fd7700).
 */
function carryOnAllowed(app: Branch, run: Run): boolean {
  // NAS 06a9508: the carry-on reads as the owner saying yes, so with a plan waiting for the owner's own answer in
  // that conversation it would agree to the plan too. Then nothing carries on by itself: the task keeps waiting,
  // and the owner answers the plan, then carries on. So too for an agreed plan stopped at a check-back (NAS dead082):
  // its "go ahead" would clear the next step. Only the plan's own task asking carries on (pausePlan keeps its runId).
  const plan = app.runtime.orchestration.plan(run.sessionId);
  if (plan && (!plan.approved || (plan.waitingOnOwner && plan.runId !== run.id))) return false;
  // NAS 166fbe3: only the conversation's newest task carries on. A newer one there may have stopped on its own
  // question (`user.ask` takes the owner's next message as the answer), and carrying on would talk over it.
  if (app.store.newestIn(run.owner, run.sessionId)?.id !== run.id) return false;
  // NAS 3fd7700: nor after words written there with no task behind them (a heartbeat's note, a Trunk routine's
  // report): the carry-on's model reads the conversation, so it would take the answer as theirs. A task with no
  // record of where it stopped (asked before this was kept) is left for the owner too.
  const stopped = app.store.events(run.id).filter((event) => event.kind === "run.stopped_to_ask").at(-1)?.data.lastMessageId;
  return typeof stopped === "number" && app.store.lastMessageId(run.sessionId) === stopped;
}
/**
 * Q257: refuses a household person an answer to a question that is not their own task's, in the same words and with
 * the same 404 whether it is live, answered already, made up, or in a conversation that is not theirs. The question
 * looked at is the one the answer would land on: the fingerprint's, or without one (or with one that matches nothing)
 * the conversation's oldest, which is where Runtime.approve would otherwise fall back to.
 */
function refuseForeignQuestion(app: Branch, sessionId: string, fingerprint: string | undefined): void {
  if (app.store.profiles.isOwner()) return;
  const approvals = app.runtime.approvals;
  const asked = approvals.questionFor(sessionId, fingerprint) ?? approvals.questionFor(sessionId);
  if (!asked || !mayAnswerHere(app.store, asked)) throw new HttpError(404, nothingWaitingRefusal);
}
function attention(app: Branch) {
  type Waiting = { runId: string; sessionId: string; question: string; createdAt: string; parentRunId?: string; canContinue?: true; who?: string; room?: string; open?: string };
  // Q257: a household person reads their own tasks' waits only (their conversations, runs started for them), never
  // the owner's; the owner's list is as it was.
  const profiles = app.store.profiles;
  const runs = profiles.isOwner() ? app.store.waitingRuns(app.runtime.owner)
    : app.store.waitingRuns(profiles.scope()).filter((run) => mayAnswerHere(app.store, { runId: run.id, sessionId: run.sessionId }));
  return runs.map((run): Waiting => {
    // phase2/rooms (integration review): a Trunk's question says which Trunk, and a room member's opens the room.
    const by = app.trunks.conversations.answerer(run.sessionId);
    return { runId: run.id, sessionId: run.sessionId, question: waitingWords(app, run), createdAt: run.createdAt, ...helperMark(app, run.id),
      ...(run.status === "interrupted" ? { canContinue: true as const } : {}),
      ...(by ? { who: by.name, open: by.sessionId, ...(by.room ? { room: by.room } : {}) } : {}) };
  });
}
/** What a waiting task says: its question, or for one Branch closed on, the note that it can be continued. */
function waitingWords(app: Branch, run: Run): string {
  if (run.status !== "interrupted") return run.output;
  const note = app.store.events(run.id).filter((event) => event.kind === "run.can_continue").at(-1)?.data.note;
  return typeof note === "string" && note ? note : "Branch closed while this task was working. Continue it when you are ready.";
}
/**
 * Overview: the tasks nobody asked for in words, which recent activity leaves out: what setup started (#386), and
 * what the engine marked as its own where it made them (Store.engineOwnRuns): helpers, learning passes, a conversation's
 * opening row, a Trunk's introduction, reading a schedule, and tasks in a temporary conversation.
 */
function asideRuns(app: Branch, scope: string, runs: readonly Run[]): ReadonlySet<string> {
  const setup = setupTaskIds(app.store, scope), found = app.store.engineOwnRuns(runs.map((run) => run.id));
  for (const run of runs) if (setup.has(run.id)) found.add(run.id);
  return found;
}
/** models-ui: the latest moves of Trunks' work between accounts (the last ten minutes), each named by its Trunk. */
function trunkMoves(app: Branch) {
  const since = Date.now() - 10 * 60_000;
  return (accountsServiceFor(app.runtime.models)?.trunkMoves ?? []).filter((move) => Date.parse(move.at) >= since).map((move) => {
    const by = app.trunks.conversations.answerer(move.sessionId);
    return { ...move, ...(by ? { who: by.name, open: by.sessionId } : {}) };
  });
}
function state(app: Branch): unknown {
  const owner = app.runtime.owner;
  // Wave 6: conversations and saved facts are read under whoever's profile is switched on.
  const scope = app.store.profiles.scope();
  const bootstrap = conversationBootstrapIds(app.store.sqlite, scope);
  const runs = app.store.runs(scope).filter((run) => !bootstrap.has(run.id)), aside = asideRuns(app, scope, runs);
  const titles = app.store.runTitles(runs); // DESIGN-DIRECTION PR 2: a room turn is listed by its room, never its framing
  return {
    collab: collabState(app),
    provider: app.runtime.provider.name,
    // No model set up: nothing is named as answering, and the window shows these words with the way to set one up.
    activeModel: app.runtime.models.configured ? app.runtime.models.plan(owner, "").choice : null,
    modelNeeded: app.runtime.models.configured ? null : noModelWords,
    onboarding: onboardingState(app),
    attention: attention(app),
    needsYou: needsYou(app), // Q050: the one count every "needs you" in the window reads
    // mac7/residuals (integration): a Trunk's message whose task stopped to ask; its card offers Answer and Not now. The owner's alone.
    trunkWaiting: app.store.profiles.isOwner() && !startedWithShortLivedKey() ? app.trunks.messages.waiting() : [],
    // models-ui: a Trunk's work moved to another account at a limit; the window tells the owner which (shell/notify.js).
    trunkMoves: app.store.profiles.isOwner() && !startedWithShortLivedKey() ? trunkMoves(app) : [],
    version: app.version,
    chatgpt: { configured: Boolean(app.chatgpt) },
    preferences: preferences(app.store, owner),
    runs: runs
      .map((run) => ({ ...run, title: titles.get(run.id) ?? "", usage: app.store.usage(run.id), cost: runCost(app, run.id), model: modelUsed(app, run.id), changes: fileChanges(app, run.id),
        ...(aside.has(run.id) ? { aside: true } : {}) })),
    models: app.runtime.models.summary(owner),
    memory: app.store.list("memory", scope),
    memoryCapacity: app.store.memoryCapacity(scope),
    // The app's own tool list is for a person to read, so it keeps the full description.
    tools: app.registry.descriptions(new Set(app.registry.permissions()), { diet: false }),
    lock: app.sessionLock.state(),
    // Q258: the owner's own records and settings (what was allowed, approval categories, projects, automations, skills,
    // secret reminders, the assistant's instructions, every owner setting) go to the owner only. A household person at
    // the window gets the same keys holding their own tasks' part, or nothing (src/household-state.ts).
    ...(app.store.profiles.isOwner() ? ownerStateParts(app) : householdStateParts(app)),
  };
}
/** mac7/diagnostics: what kind of install this engine is, and when it started, for the report. */
const diagnosticInstall = { type: "package", startedAt: Date.now() };

/** Restores owner data with the profile guard attached to the operation, not only its current route. */
export async function restoreBackup(
  app: Pick<Branch, "store">,
  read: () => Promise<unknown>,
  replaceExisting: boolean,
): Promise<unknown> {
  app.store.profiles.requireOwner("Restoring a backup");
  return app.store.restore(await read(), { replaceExisting });
}
/**
 * Who is calling a team route, from the signed-in context only (Q61): a person's key, a short-lived
 * key, a household profile, or the owner's window. A request body can never say who it is.
 */
function teamCaller(app: Branch): string {
  const person = currentPerson(), profile = app.store.profiles.active();
  return person ? `person:${person.profileId}` : startedWithShortLivedKey() ? `key:${shortLivedKeyMark().keyId ?? `unnamed:${crypto.randomUUID()}`}`
    : profile && !app.store.profiles.isOwner() ? `profile:${profile.id}` : "window";
}

/**
 * Q62: a recipient lists the team-task offers waiting for it, and accepts or rejects one. The
 * recipient is whoever is signed in (see teamCaller); the body carries at most a reason.
 */
async function teamHandoffApi(app: Branch, request: IncomingMessage, teamId: string, offerId?: string, answer?: string) {
  const handoffs = new TeamHandoffs(app.store);
  const who = { owner: app.runtime.owner, id: teamCaller(app) };
  if (request.method === "GET" && !offerId) return { offers: handoffs.addressedTo(who).filter((offer) => offer.teamId === teamId) };
  if (request.method !== "POST" || !offerId) throw new HttpError(405, "Use GET to list offers, or POST to accept or reject one");
  const { reason } = z.object({ reason: z.string().max(500).optional() }).strict().parse(await readBody(request));
  if (handoffs.get(who.owner, offerId)?.teamId !== teamId) throw new HttpError(404, "There is no such handoff offer for this team");
  try {
    if (answer === "reject") return handoffs.reject(who, offerId, reason ?? "");
    const claim = handoffs.accept(who, offerId);
    return { offerId, taskId: claim.taskId, state: "accepted" as const, generation: claim.generation };
  } catch (error) {
    if (error instanceof TeamHandoffRefusedError) throw new HttpError(409, error.message);
    throw error;
  }
}

/**
 * The requests that came in through the paired door (a phone paired with the owner's own key). The key cannot tell
 * them from the app window on this computer, so a choice kept for that window alone asks the door (the update
 * channel, the copies of the data folder: src/comfort/api.ts, src/install/data-copy.ts).
 */
const pairedDoorRequests = new WeakSet<IncomingMessage>();
/**
 * Whether a request came through a door rather than this computer's own window: the paired door, a phone's own key,
 * or a caller beyond this computer. The same answer the caller layer gives (src/caller.ts `throughDoor`), so every
 * route that keeps something to this computer's window asks the one question.
 */
const throughDoor = (request: IncomingMessage): boolean => pairedDoorRequests.has(request) || throughADoor(request)
  || !fromThisComputer(request.socket?.remoteAddress, request.headers);

async function api(
  app: Branch,
  request: IncomingMessage,
  path: string,
  dataDir: string,
  /** mac7/bind: where this door is listening now, and why, for `/api/listen` to show. */
  listen: ListenState,
  gatewayPower?: NeverBreakExtras["gatewayPower"],
): Promise<unknown> {
  // Batch 19 (wave 6): the record of what it was allowed to do, approval kinds, ask-first,
  // the practice workspace, how passages are ordered, plugin model connections, issue context.
  if (handlesMiscPath(path))
    return miscApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof MiscApiError ? new HttpError(error.status, error.message) : error;
    });
  // A change to Branch itself asked for from a chat (src/self-development-requests.ts): reading the requests
  // and answering them is the owner's alone, in the app window. Short-lived keys and household persons are
  // refused before this (src/short-lived-keys.ts, src/household-routes.ts), and each answer checks again.
  if (handlesSourceRequestPath(path)) {
    app.store.profiles.requireOwner("The list of requests to change Branch itself");
    return sourceRequestsApi(app.sourceRequests, request.method ?? "GET", path, () => readBody(request));
  }
  if (path === "/api/self-development/publications" || path === "/api/self-development/publications/cancel" || path === "/api/self-development/publications/retry") {
    app.store.profiles.requireOwner("Queued source publications");
    if (throughADoor(request)) throw new HttpError(403, hereOnly);
    if (startedWithShortLivedKey() || currentPerson()) throw new HttpError(401, "Only the owner at this window may manage source publications.");
    if (request.method === "GET" && path === "/api/self-development/publications")
      return { publications: app.sourcePublications.list() };
    if (request.method === "POST" && path === "/api/self-development/publications/cancel") {
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await readBody(request));
      return { publication: app.sourcePublications.cancel(id) };
    }
    if (request.method === "POST" && path === "/api/self-development/publications/retry") {
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await readBody(request));
      return { publication: await app.sourcePublications.retry(id, AbortSignal.timeout(240000)) };
    }
    throw new HttpError(404, "Endpoint not found");
  }
  if (handlesSourceMergePath(path)) {
    if (throughADoor(request)) throw new HttpError(403, hereOnly);
    return sourceMergeApi(app.sourceMerges, request.method ?? "GET", path, () => readBody(request));
  }
  // bucket-18: code editor (A0098)
  if (handlesWorkspaceEditorPath(path))
    return workspaceEditorApi({
      files: app.files, store: app.store, owner: app.runtime.owner, readBody,
      runTool: (name, args) => app.runtime.executeTool(name, args, { mode: "owner" }), // mac5/manual-actions
      // Integration review: Branch's own program, settings and saved work stay out of reach here too.
      guard: (target, readOnly) => protectedTarget({ tool: readOnly ? "files.read" : "files.write", readOnly, args: { path: target },
        target, workspace: app.files.base }, app.runtime.protectedAreas),
    }, request, path, new URL(request.url ?? "/", "http://local")).catch((error: unknown) => {
      throw error instanceof WorkspaceEditorApiError ? new HttpError(error.status, error.message) : error;
    });
  // Batch 19 (wave 7): spans, sending traces out, and the approval rules read as sentences.
  if (handlesTracingPath(path))
    return tracingApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof TracingApiError ? new HttpError(error.status, error.message) : error;
    });
  // w911 (A0743, A1452) hook: the switch for reading and crawling web pages (owner-only change).
  if (path === "/api/web-pages")
    return webPagesApi({ store: app.store, owner: app.runtime.owner, requireOwner: (what) => app.store.profiles.requireOwner(what) },
      request.method ?? "GET", () => readBody(request)).catch((error: unknown) => {
      throw error instanceof WebPagesApiError ? new HttpError(error.status, error.message) : error;
    });
  // RES-719: GitLab set up in the window: its switch, the token checked and kept in the locker, and taking it out.
  if (handlesGitLabPath(path))
    return gitlabApi({ connection: app.gitlab, store: app.store, owner: app.runtime.owner,
      requireOwner: (what) => app.store.profiles.requireOwner(what) }, request.method ?? "GET", path, () => readBody(request)).catch((error: unknown) => {
      throw error instanceof GitLabApiError ? new HttpError(error.status, error.message) : error;
    });
  // ── Bucket 21: the switch for building on Branch, and flows written out and read back as YAML. ──
  if (handlesSdkKitPath(path))
    return sdkKitApi({ store: app.store, owner: app.runtime.owner, flows: app.flows,
      requireOwner: (what) => app.store.profiles.requireOwner(what) }, request.method ?? "GET", path, () => readBody(request)).catch((error: unknown) => {
      throw error instanceof SdkKitError ? new HttpError(error.status, error.message) : error;
    });
  // Batch 20 (wave 7): flows as boxes and arrows, jobs handed over to finish later, programs left
  // running, and the switches for the project's check, those programs, and small scripts.
  if (handlesOrchestrationPath(path))
    return orchestrationApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof OrchestrationApiError ? new HttpError(error.status, error.message) : error;
    });
  // Batch 26 (wave 8): sandboxes, the firewall card, per-person ceilings, other computers, marks,
  // and how long conversations are kept.
  if (handlesSandboxRemotePath(path))
    return sandboxRemoteApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof SandboxRemoteApiError ? new HttpError(error.status, error.message) : error;
    });
  // FQ-execution.host-bridge: the owner runs a program on one computer they name explicitly, and
  // gets back which computer answered together with what it said.
  if (handlesHostBridgePath(path))
    return hostBridgeApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof HostBridgeApiError ? new HttpError(error.status, error.message) : error;
    });
  // Wave mac2 (move-in): the preview of what another assistant left behind, and bringing it over.
  if (handlesMoveInPath(path))
    return moveInApi(app, request, path, readBody, { ...defaultMoveInOptions(), contextFiles: contextFileSinkFor(app) }).catch((error: unknown) => {
      throw error instanceof MoveInApiError ? new HttpError(error.status, error.message) : error;
    });
  // Wave mac2 (guards): which workspace folders are trusted, what each carries, and both switches.
  if (handlesGuardsPath(path))
    return guardsApi(app, request, path, readBody).catch((error: unknown) => { throw error instanceof GuardsApiError ? new HttpError(error.status, error.message) : error; });
  // R17-S-B: the hidden knobs. Every change is the owner's (see offLimitsToShortLivedKeys).
  if (handlesKnobsPath(path))
    return knobsApi(app, request, path, readBody, () => (process.env.BRANCH_INTEGRATIONS ? resolvePath(process.env.BRANCH_INTEGRATIONS) : null))
      .catch((error: unknown) => { throw error instanceof KnobsApiError ? new HttpError(error.status, error.message) : error; });
  // R17-E: how models are chosen and what they may spend; every change is the owner's.
  if (handlesSavingsPath(path))
    return savingsApi(app, request, path, new URL(request.url ?? "/", "http://branch.invalid"), readBody)
      .catch((error: unknown) => { throw error instanceof SavingsApiError ? new HttpError(error.status, error.message) : error; });
  // R17-S-C: shortcuts, status line, notifications, voice keys, browser care, proxy and certificates.
  if (handlesComfortPath(path))
    return comfortApi({ store: app.store, runtime: app.runtime, outbound: app.comfort.outbound, pairedDoor: throughDoor(request) }, request, path, readBody)
      .catch((error: unknown) => { throw error instanceof ComfortApiError ? new HttpError(error.status, error.message) : error; });
  // mac6/accounts: the accounts of each connection, and switching between them.
  if (handlesAccountsPath(path))
    return accountsApi(request, path, {
      service: accountsServiceFor(app.runtime.models), readBody: () => readBody(request, 16 * 1024),
      requireOwner: (what) => app.store.profiles.requireOwner(what), oauth: app.oauth,
    }).catch((error: unknown) => {
      throw error instanceof AccountsApiError ? new HttpError(error.status, error.message) : error;
    });
  // mac7/bind: where Branch's own door listens (src/listen-address.ts). The owner's alone, in the
  // app window: a short-lived key (which is how a Trunk's message arrives), a household person, a
  // chat message's task and work another program started are all refused, and so is Lockdown.
  if (path === "/api/listen") {
    if (request.method === "GET") {
      // Integration review: where the door is is where to knock, so looking is guarded too.
      const hidden = listenReadRefusal(app.store, app.runtime.owner);
      if (hidden) throw new HttpError(403, hidden);
      return listenView(app.store, app.runtime.owner, listen);
    }
    if (request.method !== "POST") throw new HttpError(405, "Use GET or POST here.");
    const refused = listenChangeRefusal(app.store, app.runtime.owner);
    if (refused) throw new HttpError(403, refused);
    const where = await readBody(request, 4096);
    recordedWrite(app.store, app.runtime.owner, byCard("listen-address"), ["listen-address"],
      () => saveListenSettings(app.store, app.runtime.owner, where));
    return { ...listenView(app.store, app.runtime.owner, listen), note: "Saved. It takes effect the next time Branch starts." };
  }
  // mac3/never-break: the gateway switch and the changes the assistant suggested for it.
  if (handlesNeverBreakPath(path))
    return neverBreakApi(dataDir, request, path, readBody, {
      snapshot: () => snapshotData({ dataDir, database: app.store.sqlite, journal: app.neverBreak.journal.database }),
      telegram: app.neverBreak.telegram,
      ...(gatewayPower ? { gatewayPower } : {}),
    }).catch((error: unknown) => {
      throw error instanceof NeverBreakApiError ? new HttpError(error.status, error.message) : error;
    });
  // --- mac7/connect: the Set up panel for each chat app (src/channel-setup/) ---
  if (handlesChannelSetupPath(path))
    return channelSetupApi({ store: app.store, owner: app.runtime.owner, fetch: app.web.policy.guard(globalThis.fetch),
      telegram: app.neverBreak.telegram, live: app.channelSetup, thisComputer: !throughADoor(request),
      requireOwner: (what) => app.store.profiles.requireOwner(what) },
    request.method ?? "GET", path, () => readBody(request)).catch((error: unknown) => {
      throw error instanceof SetupRefusal ? new HttpError(error.status, error.message) : error;
    });
  // --- end mac7/connect ---
  // Wave mac3 (tool-safety): the second look before an approval — its switch, connection and rules.
  if (path === "/api/approval-reviewer" && request.method === "GET") return reviewerView(app.store, app.runtime.owner);
  if (path === "/api/approval-reviewer" && request.method === "POST") {
    const reviewer = await readBody(request);
    recordedWrite(app.store, app.runtime.owner, byCard("approval_reviewer"), ["approval_reviewer"],
      () => saveReviewerSettings(app.store, app.runtime.owner, reviewer));
    return reviewerView(app.store, app.runtime.owner);
  }
  // Batch 21 (wave 8): the description of this API, Lockdown, kept answers, whole sets, project cost.
  if (handlesOtherPath(path))
    return otherApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof OtherApiError ? new HttpError(error.status, error.message) : error;
    });
  // The owner's handbook, so Help opens beside the screen a person is on. Reading only.
  if (request.method === "GET" && (path === "/api/help" || path.startsWith("/api/help/"))) {
    const answer = helpApi(path);
    if (answer === undefined) throw new HttpError(404, "There is no handbook chapter by that name");
    return answer;
  }
  // ── mac2/fly-core-2: the learning core's switch, what it has learned, and forgetting it. ──
  if (handlesLearningCorePath(path))
    return learningCoreApi({ store: app.store, owner: app.runtime.owner, configure: (input: unknown) =>
      recordedWrite(app.store, app.runtime.owner, byCard("fly-core"), ["fly-core"], () => app.learningCore.configure(input)) },
      request.method ?? "GET", path, () => readBody(request)).catch((error: unknown) => {
      throw error instanceof LearningCoreApiError ? new HttpError(error.status, error.message) : error;
    });
  // P17-D §4: decision models on the owner's own connections. Reading names the connections; deciding asks a model.
  if (path === "/api/decisions" || path === "/api/decisions/settings" || path === "/api/decisions/decide" || path === "/api/decisions/urgency") {
    app.store.profiles.requireOwner("Decision models");
    if (path === "/api/decisions") {
      if (request.method === "GET") return app.decisionModels.overview();
      throw new HttpError(405, "Use GET here.");
    }
    if (request.method !== "POST") throw new HttpError(405, "Use POST here.");
    const body = await readBody(request, 256 * 1024);
    // Sort the Inbox by urgency: scores for the rows Needs you shows (refused while the switch is off).
    if (path === "/api/decisions/urgency") return app.decisionModels.urgency(body).catch((error: unknown) => {
      throw (error as { status?: unknown }).status === 409 ? new HttpError(409, (error as Error).message) : error;
    });
    return path === "/api/decisions/settings" ? { settings: app.decisionModels.configure(body) } : app.decisionModels.decide(body);
  }
  // P17-D §3: behaviour workbooks. Starting one, running it again and making a skill are the owner's.
  if (path === "/api/workbooks" || path.startsWith("/api/workbooks/")) {
    app.store.profiles.requireOwner("Learn this app or workflow");
    return workbooksRoute(app.workbooks, request.method ?? "GET", path, () => readBody(request, 16 * 1024)).catch((error: unknown) => {
      const status = (error as { status?: unknown }).status;
      throw typeof status === "number" && error instanceof Error ? new HttpError(status, error.message) : error;
    });
  }
  // Optional JEV decisions are the owner's: even reading this card names a local program and provider.
  if (path === "/api/jev") {
    app.store.profiles.requireOwner("JEV decision support");
    if (request.method === "GET") return app.decisions.settings();
    if (request.method === "POST") return app.decisions.configure(await readBody(request, 16 * 1024));
    throw new HttpError(405, "Use GET or POST here.");
  }
  // ── R17-S-A (understandable settings): presets, putting settings back, one settings file, and the files you write. ──
  if (handlesSettingsKitPath(path))
    return settingsKitApi({
      store: app.store, owner: app.runtime.owner, workspace: app.runtime.workspace, appVersion: app.version,
      // One set of writers for the window and for the assistant changing a setting (src/settings-kit/writers.ts).
      writers: settingsKitWriters(app),
      // A move of the approval preset is weighed on the tools Branch has (src/preset-moves.ts).
      tools: app.registry,
      guard: (target) => protectedTarget({ tool: "files.write", readOnly: false, args: { path: target }, target,
        workspace: app.runtime.workspace }, app.runtime.protectedAreas),
    }, request.method ?? "GET", path, () => readBody(request, settingsKitBodyBytes)).catch((error: unknown) => {
      throw error instanceof SettingsKitError ? new HttpError(error.status, error.message) : error;
    });
  // ── mac7/wake-pins ──
  // Which settings the owner pinned, for anybody who uses this computer: somebody on a household
  // profile is shown the pinned setting and told it is pinned, which is the whole point of a pin.
  // Only the names and the fixed values are here, and every change goes through settings-kit above.
  if (request.method === "GET" && path === "/api/pins")
    return { pins: pins(app.store, app.store.profiles.ownerName).map(({ key, field, value, name, label }) => ({ key, field, value, name, label })) };
  // The word that starts a turn. Reading it says what this computer could really do; changing it,
  // like every other setting, is the owner's.
  if (path === "/api/voice/wake") {
    // mac7/wake-mic: whether it is listening this moment comes from the listener itself, so the
    // card cannot say one thing while the microphone does another.
    if (request.method === "GET")
      return wakeWordView(app.store, app.runtime.owner, process.platform, app.store.profiles.isOwner(), app.wake.listening);
    app.store.profiles.requireOwner("The word that starts a turn");
    const wake = await readBody(request);
    recordedWrite(app.store, app.runtime.owner, { writer: "owner-in-window", source: "card", detail: "wake-word" }, ["wake-word"],
      () => saveWakeWordSettings(app.store, app.runtime.owner, wake));
    app.wake.refresh(); // the switch going on or off starts or stops the listener at once
    return { settings: wakeWordSettings(app.store, app.runtime.owner),
      state: wakeWordView(app.store, app.runtime.owner, process.platform, true, app.wake.listening) };
  }
  // ── end mac7/wake-pins ──
  // ── mac7/live-voice: speak, and see the words as you say them ──
  // Reading the card says what this computer could really do and whether the microphone is open
  // this moment; everything else is the owner's, at this window. A chat's task, a short-lived key,
  // a household profile, a Trunk and another computer all arrive here as something that is not the
  // owner at this window, and all five are refused by the two guards below and by the fail-closed
  // rule for short-lived keys in src/short-lived-keys.ts, which never lists this path.
  // RES-709: a piece of what the window's own microphone heard, written out on this computer (hearInWindow below).
  if (request.method === "POST" && path === "/api/voice/dictation/hear") {
    const host = { store: app.store, owner: app.runtime.owner, isOwner: app.store.profiles.isOwner(),
      locked: app.sessionLock.locked(), voice: app.voice, platform: app.dictation.platform, present: app.dictation.present };
    try { return await hearInWindow(host, request); } catch (error) {
      throw new HttpError(error instanceof HearRefused ? error.status : 400, errorText(error));
    }
  }
  if (path === "/api/voice/dictation" || path === "/api/voice/dictation/listen") {
    if (request.method === "GET") {
      // Whether the microphone is open comes from the listener itself, so the card cannot say one
      // thing while the microphone does another.
      const mine = app.store.profiles.isOwner();
      const view = dictationView(app.store, app.runtime.owner, app.dictation.platform, mine, app.dictation.open, app.dictation.present, app.voice.localSpeech(app.runtime.owner));
      // The words are screen state: they go to the window that is dictating and nowhere else. They
      // are never written to disk, never traced, never kept past the phrase, and never sent. Anybody
      // else on this computer is not shown them, because they are not shown any of this.
      return mine ? { ...view, words: app.dictation.words, settled: app.dictation.settled } : view;
    }
    // Not `requireOwner`, whose sentence is about a setting belonging to the owner. This one is
    // about a microphone, and a person reading it should be told that rather than something milder.
    if (!app.store.profiles.isOwner()) throw new HttpError(403, dictationOwnerOnlyRefusal);
    if (path === "/api/voice/dictation/listen") {
      const body = await readBody(request) as { on?: unknown };
      // Starting is the only thing that opens a microphone anywhere in this feature, and it happens
      // here, once, on a press. It answers with the refusal rather than opening one when anything
      // — the switch, Lockdown, the lock, a missing speech program — says it must not.
      const refusal = body?.on === true ? app.dictation.start() : (app.dictation.stop(), null);
      return { open: app.dictation.open, refusal,
        state: dictationView(app.store, app.runtime.owner, app.dictation.platform, true, app.dictation.open, app.dictation.present, app.voice.localSpeech(app.runtime.owner)) };
    }
    const dictation = await readBody(request);
    recordedWrite(app.store, app.runtime.owner, byCard("live-dictation"), ["live-dictation"],
      () => saveDictationSettings(app.store, app.runtime.owner, dictation));
    app.dictation.refresh(); // the switch going off stops it and lets go of the microphone at once
    return { settings: dictationSettings(app.store, app.runtime.owner),
      state: dictationView(app.store, app.runtime.owner, app.dictation.platform, true, app.dictation.open, app.dictation.present, app.voice.localSpeech(app.runtime.owner)) };
  }
  // ── end mac7/live-voice ──
  if (request.method === "GET" && path === "/api/state") {
    // The owner's triggers and webhooks ride along here too, so their secrets stay off a door as on their own routes.
    const answer = state(app) as Record<string, unknown>;
    // hot-update: the change the window's files come from, so an open window can tell it was updated live.
    answer.windowBuild = liveWindowCommit() ?? ownBuild();
    for (const part of ["triggers", "webhooks"]) if (part in answer) answer[part] = withoutSecretToADoor(request, answer[part]);
    return answer;
  }
  // FQ-collaboration.unified-search: one query across conversations, saved workflows and the
  // record of what the assistant was allowed to do. Owner-only: it reads across everything the
  // owner has done, so a short-lived key and a household profile are both refused (src/short-lived-keys.ts),
  // and unifiedSearch itself refuses anyone but the owner as well.
  if (request.method === "GET" && path === "/api/search") {
    const q = new URL(request.url ?? "/", "http://local").searchParams.get("q") ?? "";
    return { results: unifiedSearch(app, app.runtime.owner, q) };
  }
  // Wave 6: sharing, labels and notes, workflows, the waiting line, days off, and profiles.
  const collab = await collabApi(app, request, path, (maximumBytes) => readBody(request, maximumBytes));
  if (collab !== notCollab) return collab;
  if (request.method === "GET" && path === "/api/tools") return toolInventory(app);
  // The developer playground: the form for every tool, and running one by hand through the gate.
  if (request.method === "GET" && path === "/api/tools/forms") return { tools: toolForms(app.registry) };
  if (request.method === "POST" && path === "/api/tools/try") {
    // mac5/manual-actions: the same hand-pressed gate as /api/action, with its question kept, the
    // two-minute ceiling and the secret scrub; shared with the host-bridge card (src/playground.ts).
    // A megabyte: room for an OpenAPI description a person chose in Settings › Developer (src/openapi-tools.ts).
    const tried = TryToolSchema.parse(await readBody(request, 1024 * 1024));
    // unhold-control: a key bound to one conversation keeps what it runs in that conversation only.
    if (tried.sessionId) requireBoundSession(shortLivedKeyMark().sessionId, tried.sessionId);
    return tryToolByHand(app, tried);
  }
  // Wave 8: an artifact out of a reply. Minting an address puts the page behind an unguessable
  // name the frame can fetch; saving keeps it beside the task, where the Documents list finds it.
  if (request.method === "POST" && path === "/api/artifacts/page")
    return { url: `/artifact/${holdArtifactPage(ArtifactPageSchema.parse(await readBody(request, 512_000)))}` };
  if (request.method === "POST" && path === "/api/artifacts/save") {
    const wanted = ArtifactSaveSchema.parse(await readBody(request, 512_000));
    const kept = await app.artifacts.write(wanted.runId, wanted.name, wanted.mediaType, Buffer.from(wanted.code, "utf8"));
    return { ...kept, name: wanted.name, runId: wanted.runId };
  }
  // eng-connectors: the connector catalogue, the owner's own servers and command-line tools, What's new, flagged replies.
  const connectors = await connectorsApi(app, request, path);
  if (connectors !== undefined) return connectors;
  if (request.method === "GET" && path === "/api/mcp/connection") return mcpConnectionSnippets(app, request, dataDir);
  if (path.startsWith("/api/mcp/")) return mcpApi(app, request, path);
  // Assistants elsewhere: the ones added, looking for more, and the link that pairs two installs.
  if (path.startsWith("/api/agents/"))
    return remoteAgentsApi(app.remoteAgents, request, path, () => readBody(request), {
      base: `http://${request.headers.host ?? "127.0.0.1:3210"}`,
      // A pairing link carries a key of its own that reaches only the A2A door and runs out; never the caller's key.
      pairingKey: () => app.sessionTokens.createPairingKey(app.runtime.owner),
    });
  // A phone-sized list of conversations. It goes through the same door and needs the same key as
  // everything else, so a paired phone can pick up what was started at the computer.
  if (request.method === "GET" && path === "/api/sessions") {
    const scope = app.store.profiles.scope();
    const params = new URL(request.url ?? "/", "http://x").searchParams;
    const recent = app.store.recentSessions(scope, Number(params.get("limit") ?? 20) || 20, Number(params.get("offset") ?? 0));
    // Pass 17: whether each has something the person has not seen (src/read-marks.ts).
    // Archived and Recently Deleted, counted, so the list shows either entry only when it holds something.
    const away = app.store.putAwayConversations(scope, { limit: 1 });
    // defaulttrunk: which Trunk each is a thread with (its own chat, a room side, a thread), so the list shows it under that
    // Trunk with its face. The owner's Trunks only: a household person's list names none.
    const personal = app.store.profiles.isOwner() ? null : app.trunks.personDefault();
    const trunkOf = (sessionId: string) => app.store.profiles.isOwner()
      ? app.trunks.trunkForConversation(sessionId)?.trunkId ?? null
      : personal?.threads.get(sessionId)?.trunkId ?? null;
    return { ...recent, profileId: app.store.profiles.active()?.id ?? null, isOwner: app.store.profiles.isOwner(), sessions: recent.sessions.map((s) => ({ ...s, unread: app.store.readMarks.unread(scope, s.sessionId), trunkId: trunkOf(s.sessionId) })),
      archived: away.totals.archived, deleted: away.totals.deleted };
  }
  // Pass 17: named paths of a conversation, leaving a message out of context, and read marks.
  if (conversationPathsRoute.test(path) || path === readMarksPath) return conversationPathsApi(app, request, path, () => readBody(request));
  // Wave mac2 (goal-undo): working toward a goal in rounds, and going back to an earlier message.
  if (path === "/api/goals" || path === "/api/goal-undo/settings" || /^\/api\/sessions\/[a-f0-9-]{36}\/(goal|rewind|unrevert)$/.test(path))
    return goalUndoApi(app, request, path);
  if (path.startsWith("/api/sessions/")) return sessionApi(app, request, path);
  if (path.startsWith("/api/memory/")) return memoryApi(app, request, path);
  if (path.startsWith("/api/history/")) return historyApi(app, request, path);
  // Wave 7: the two coder switches in Settings → Developer, kept in one small block.
  if (path.startsWith("/api/developer/")) return developerApi(app, request, path);
  if (path.startsWith("/api/skills/")) return skillsApi(app, request, path);
  if (path.startsWith("/api/chatgpt/")) return chatgptApi(app, request, path);
  if (path.startsWith("/api/projects")) return projectsApi(app, request, path);
  if (path.startsWith("/api/secrets")) return secretsApi(app, request, path);
  if (path.startsWith("/api/lock") || path.startsWith("/api/privacy")) return guardApi(app, request, path);
  if (path.startsWith("/api/connections/")) return connectionsApi(app, request, path);
  if (path.startsWith("/api/channels")) return channelsApi(app, request, path);
  // Wave mac2 (quiet-jobs): the check-in, and the owner's yes to a job's check script.
  if (path.startsWith("/api/heartbeat") || /^\/api\/schedules\/[a-f0-9-]{36}\/gate$/.test(path)) {
    app.store.profiles.requireOwner("Your schedules");
    const answer = await quietJobsApi(app.scheduler, request.method ?? "GET", path, () => readBody(request));
    if (answer !== undefined) return answer;
    throw new HttpError(404, "Endpoint not found");
  }
  if (path === "/api/schedules" || path.startsWith("/api/schedules/")) return schedulesApi(app, request, path);
  if (path.startsWith("/api/documents")) return documentsApi(app, request, path);
  // p17: "Ask a spreadsheet" in Library › Documents, one read-only question over one of the owner's spreadsheets.
  if (path === "/api/data/ask" && request.method === "POST") {
    app.store.profiles.requireOwner("Asking a spreadsheet");
    return askSpreadsheet({ documents: app.documents.list(app.runtime.owner), tables: app.dataTables,
      uploadedBytes: (id) => app.documents.uploadedBytes(app.runtime.owner, id) }, await readBody(request));
  }
  // FQ-collaboration: a comment pinned to a moment in a media file (video today), so it can be
  // reopened at the same position later.
  if (path.startsWith("/api/media-comments")) return mediaCommentsApi(app, request, path);
  // Knowledge bases: named sets of folders and files, searched by words and by meaning at once.
  if (path.startsWith("/api/knowledge")) {
    const answer = await knowledgeApi(app.knowledgeBases, app.runtime.models, app.runtime.owner,
      request.method ?? "GET", path, () => readBody(request));
    if (answer !== undefined) return app.runtime.hideSecrets(answer);
    // Batch 20 (wave 8): summaries, the map of names, pictures in words, housekeeping and limits.
    const more = await knowledgeExtrasApi(app.knowledgeParts, app.store, app.runtime.owner,
      request.method ?? "GET", path, () => readBody(request));
    if (more !== undefined) return app.runtime.hideSecrets(more);
    throw new HttpError(404, "Not found");
  }
  if (path.startsWith("/api/research") || path.startsWith("/api/monitors") || path.startsWith("/api/brief"))
    return researchApi(app, request, path);
  if (path.startsWith("/api/triggers")) return withoutSecretToADoor(request, await triggersApi(app, request, path));
  // finish-soon-a: moving or taking out a saved recipe's steps, saved as a new version that must be verified again.
  const recipeSteps = /^\/api\/recipes\/([a-f0-9-]{36})\/steps$/.exec(path);
  if (recipeSteps && request.method === "POST") {
    app.store.profiles.requireOwner("Your saved recipes");
    const recipe = app.knowledge.reorderProcedure(app.runtime.context(), recipeSteps[1]!, await readBody(request));
    return { recipe, said: `Saved as version ${String(recipe.data.version)}. It is not used until it is verified again, so anything that replays it waits: ask Branch to verify it in a task.` };
  }
  if (path.startsWith("/api/webhooks")) return withoutSecretToADoor(request, await webhooksApi(app, request, path));
  // w911 (A2019) hook: where the browser runs (on this computer, in Docker, or on a server elsewhere).
  if (handlesBrowserContainer(path))
    return browserContainerApi({ store: app.store, owner: app.runtime.owner, secrets: () => app.store.secrets,
      requireOwner: (what) => app.store.profiles.requireOwner(what) }, request.method ?? "GET", () => readBody(request));
  // w911 (A2144) hook: page notes, before the browser routes read the body.
  if (handlesPageNotes(path)) return pageNotesApi(app, request.method ?? "GET", path, new URL(request.url ?? "/", "http://local").searchParams, () => readBody(request, 262144));
  if (path.startsWith("/api/browser/")) return browserApi(app, request, path);
  if (request.method === "POST" && path === "/api/identity")
    return saveAssistantIdentity(app.store, app.runtime.owner, await readBody(request));
  // The owner's own instruction files: what each one is set to, and what that produced this time.
  if (request.method === "GET" && path === "/api/context-files")
    return {
      settings: contextFileSettings(app.store, app.runtime.owner),
      files: contextFileStatus(app.store, app.runtime.owner, app.runtime.workspace),
    };
  if (request.method === "POST" && path === "/api/context-files") {
    const chosen = await readBody(request);
    return recordedWrite(app.store, app.runtime.owner, byCard("context-files"), ["context-files"],
      () => saveContextFileSettings(app.store, app.runtime.owner, chosen));
  }
  // ── mac3/reflection-skills: looking back over conversations and skills written from experience. ──
  if (path.startsWith("/api/reflection")) {
    // What the assistant learns is the owner's, so only the owner changes how it learns.
    if (request.method !== "GET") app.store.profiles.requireOwner("Changing what the assistant learns");
    const answer = await reflectionApi(app.learningLoop, app.store, request.method ?? "GET", path, () => readBody(request));
    if (answer === undefined) throw new HttpError(404, "Not found");
    return app.runtime.hideSecrets(answer);
  }
  if (request.method === "POST" && path === "/api/models")
    return app.runtime.models.configure(app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/models/test") return testModel(app, await readBody(request));
  if (request.method === "GET" && path === "/api/providers/catalog") return providersCatalog();
  if (request.method === "POST" && path === "/api/providers/test") return testProvider(await readBody(request), app.web.policy);
  if (request.method === "GET" && path === "/api/providers/local") return localProviders();
  // Batch 20 (wave 8): coding assistants already installed here, used as a model through their own
  // command line and their own sign-in. Listing them installs nothing and signs in to nothing.
  if (request.method === "GET" && path === "/api/providers/cli-agents") return { agents: cliAgentRows() };
  if (request.method === "POST" && path === "/api/providers/cli-agents")
    return addProgram(app.runtime.models, app.store, app.runtime.owner, await readBody(request, 8 * 1024)); // written down, so it comes back after a restart
  // Models on this computer: what is installed, downloads, hardware advice and task routing.
  if (path === "/api/local-models" || path.startsWith("/api/local-models/"))
    return localModelsApi(
      { runtimes: localRuntimes(), store: app.store, models: app.runtime.models, owner: app.runtime.owner, kit: localKitFor(app.store),
        caller: windowCaller(app) },
      request.method ?? "GET", path, () => readBody(request),
    );
  // mac7/adapt: what a stopped task is missing, and getting it on the owner's yes. Looking only
  // describes; everything that fetches or changes anything is the owner's own step in the window.
  if (handlesAdaptPath(path))
    return adaptApi({ store: app.store, owner: app.runtime.owner,
      requireOwner: (what) => app.store.profiles.requireOwner(what) },
    request.method ?? "GET", path, () => readBody(request, 16 * 1024), windowCaller(app));
  // mac7/clean-uninstall: the danger zone — what removing Branch would take away, and removing it.
  // The owner's alone, in the app window; the remover itself is the one `branch uninstall` uses.
  if (handlesRemovePath(path))
    return removeBranchApi(
      { store: app.store, owner: app.runtime.owner, platform: process.platform, env: process.env,
        sourceCheckout: existsSync(join(packageRootHere(), ".git")),
        manage: { env: process.env, platform: process.platform, version: app.version, packageRoot: packageRootHere(), print: () => undefined } },
      request.method ?? "GET", path, () => readBody(request, 4 * 1024), windowCaller(app),
    );
  // How far setup got, and the pop-ups switch (src/onboarding.ts): the owner's, merged. A household person's read is
  // refused before this (Q261, src/household-routes.ts); their window reads the defaults in GET /api/state.
  if (request.method === "GET" && path === "/api/onboarding") return onboardingState(app);
  if (request.method === "POST" && path === "/api/onboarding") {
    if (!app.store.profiles.isOwner()) throw new HttpError(403, "Setting up Branch belongs to the owner. Switch back to the owner's profile to use it.");
    const saved = saveOnboarding(app.store, app.runtime.owner, await readBody(request));
    // defaulttrunk: setup finished or skipped with no Trunk made: the engine makes the default Trunk, quietly.
    if (saved.done || saved.skipped) app.trunks.ensureDefault();
    return onboardingState(app);
  }
  // Wave mac3 (terminal): the theme `branch theme` and Settings › Appearance share (src/terminal-theme.ts).
  if (path === "/api/look" && request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "Use GET or POST");
  if (path === "/api/look") return lookApi(app.store, app.runtime.owner, request.method ?? "GET", () => readBody(request));
  if (request.method === "POST" && path === "/api/preferences") {
    const value = PreferencesSchema.parse(await readBody(request));
    app.store.save("settings", app.runtime.owner, "preferences", value);
    return value;
  }
  if (request.method === "GET" && path === "/api/voice/settings")
    return voiceSettings(app.store, app.runtime.owner);
  // mac7/wake-pins integration review: these settings name the speech program on this computer, and
  // the wake word's spotter IS that program. Choosing a program for Branch to run is the owner's.
  if (request.method === "POST" && path === "/api/voice/settings")
    app.store.profiles.requireOwner("The speech settings");
  // Wave 7: voice routes and plans, routing profiles, switching model mid-conversation, and a live
  // check of what each connection can do. The bodies of all of these live in src/voice-api.ts.
  // phase2/rooms: Talk live's own start was never in this list, so the button could not open a
  // conversation. Its tools run as the owner, so it is the owner's alone (src/short-lived-keys.ts no
  // longer lets a key or a household person reach it).
  if (path === "/api/voice/live"
    || path === "/api/voice/settings" || path === "/api/voice/plan" || path === "/api/voice/voices"
      || path.startsWith("/api/models/profiles") || path === "/api/models/switch" || path === "/api/models/probe"
      || path === "/api/models/gemini-signin")
    return voiceApi(voiceDeps(app), request.method ?? "GET", path, () => readBody(request));
  // Pictures and sounds (wave 5): what the media tools should use, and everything they have made.
  if (request.method === "GET" && path === "/api/media/settings")
    return { settings: mediaSettings(app.store, app.runtime.owner), prices: builtInImagePrices, pricedAt: imagePricedAt,
      pictures: picturesNow(app), pictureModels: knownPictureModels };
  if (request.method === "POST" && path === "/api/media/settings")
    return { settings: saveMediaSettings(app.store, app.runtime.owner, await readBody(request)) };
  // w911 (A1753) hook: plain-language page test scenarios, drafted, accepted and run as suites.
  if (handlesQa(path)) return qaApi(qaDeps(app), request.method ?? "GET", path, () => readBody(request));
  // w911 (A0374) hook: the switch and limit for fixing failed commands, and what it did.
  if (path === "/api/troubleshoot") return troubleshootApi(app.store, app.runtime.owner, request.method ?? "GET", () => readBody(request));
  // Bucket 17 hook: watching videos, where ffmpeg and yt-dlp are, and speech plug-ins.
  if (handlesBucket17(path))
    return bucket17Api(
      { store: app.store, owner: app.runtime.owner, understanding: app.understanding, engines: app.voice.engines },
      request.method ?? "GET", path, () => readBody(request), () => readMediaBody(request),
    );
  // dogfood-ux-2: Library › Made for you › Open reads one kept file in the window. A picture or a sound is shown from
  // /api/artifacts/file; anything else is read to its words by the document library's own readers, never run or opened
  // in another program. Only a file the assistant kept is found, as /api/artifacts/file finds it.
  if (request.method === "GET" && path === "/api/artifacts/read") {
    const wanted = new URL(request.url ?? "/", "http://local").searchParams.get("path") ?? "";
    const entry = (await app.artifacts.list(500)).find((kept) => kept.path === wanted);
    if (!entry) throw new HttpError(404, "That file was not made by the assistant");
    if (/^(image|audio)\//.test(entry.mediaType)) return { name: entry.name, mediaType: entry.mediaType, shown: true };
    const read = tryReadDocument(await app.artifacts.read(entry.path), entry.name, { byteLimit: maxArtifactBytes });
    const text = read.document && !read.document.pictures ? read.document.text : null;
    return { name: entry.name, mediaType: entry.mediaType, text,
      note: !read.document ? read.reason : read.document.pictures ? picturesMessage : read.document.limits.join(" ") };
  }
  if (request.method === "GET" && path === "/api/artifacts") {
    const type = new URL(request.url ?? "/", "http://local").searchParams.get("type") ?? "";
    // SCREEN-162: the same rule as the file route, so the gallery lists only files this profile can open.
    const scope = scopeWhileUnlocked(app);
    const kept = (await app.artifacts.list()).filter((entry) => !!scope && ownArtifact(app, scope, entry.runId));
    return { artifacts: type ? kept.filter((entry) => entry.mediaType.startsWith(`${type}/`)) : kept };
  }
  // Batch 26 (wave 8): what Windows itself allows, with the page that turns each one on.
  if (request.method === "GET" && path === "/api/os-permissions")
    return { permissions: await app.osPermissions.all(), ...permissionsContext() };
  // Batch 26 (wave 8): reading passwords out of the password manager the owner already has.
  // Q255: the owner's alone, read and write; a household person is refused here, a short-lived key at the door.
  if (path === "/api/credentials/settings" && (request.method === "GET" || request.method === "POST"))
    app.store.profiles.requireOwner("Your password manager");
  if (request.method === "GET" && path === "/api/credentials/settings") // `platform`: Windows Credential Manager is only on Windows
    return { ...readCredentialSettings(app.store, app.runtime.owner), platform: process.platform };
  if (request.method === "POST" && path === "/api/credentials/settings")
    return saveCredentialSettings(app.store, app.runtime.owner, await readBody(request));
  // mac7/vault-autofill (R17-068): which saved sign-in goes with which site. Names and website names
  // only; no password ever travels this route, because nothing here asks a password manager anything.
  // The owner's alone: a household person is refused here, a short-lived key at the door below.
  if (path === "/api/vault-autofill/settings") {
    app.store.profiles.requireOwner("Your saved sign-ins");
    if (request.method === "GET") return readVaultAutofillSettings(app.store, app.runtime.owner);
    if (request.method === "POST") {
      const autofill = await readBody(request);
      return recordedWrite(app.store, app.runtime.owner, byCard("vault-autofill"), ["vault-autofill"],
        () => saveVaultAutofillSettings(app.store, app.runtime.owner, autofill));
    }
    throw new HttpError(405, "That is not something Branch can do with your saved sign-ins");
  }
  // mac2/desktop-ui: which Keychain entries Branch may read on a Mac (names only, off by default).
  if (path === keychainSettingsPath)
    return keychainApi(app.store, app.runtime.owner, request.method ?? "GET", () => readBody(request));
  // Using this computer's screen and keyboard: off until the owner turns it on here.
  if (request.method === "GET" && path === "/api/desktop/settings")
    return readDesktopSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/desktop/settings") {
    const desktop = await readBody(request);
    return recordedWrite(app.store, app.runtime.owner, byCard("desktop-control"), ["desktop-control"],
      () => saveDesktopSettings(app.store, app.runtime.owner, desktop));
  }
  // unhold-control: "Ask before opening an app it hasn't used", once per app, per Trunk (src/desktop-app-ask.ts).
  // Reading it is a look; changing it is the owner's alone, and every change is written in the audit log.
  if (request.method === "GET" && path === "/api/desktop/app-ask")
    return appAskSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/desktop/app-ask") {
    app.store.profiles.requireOwner("Asking before a new app");
    const before = appAskSettings(app.store, app.runtime.owner);
    const after = saveAppAskSettings(app.store, app.runtime.owner, await readBody(request));
    audit(app.store, app.runtime.owner, { action: "policy.changed", actor: app.runtime.owner,
      subject: `Ask before opening an app it hasn't used: ${after.on ? "on" : "off"}`, reason: `Was ${before.on ? "on" : "off"}.`, outcome: "saved" });
    return after;
  }
  // FQ-execution.desktop: the shared Linux desktop's switch, and the owner taking it over and handing
  // it back. Reading the card is a look (it never carries the VNC password); every change is the
  // owner's alone, and no tool reaches these, so the assistant can never hand the desktop to itself.
  if (request.method === "GET" && path === "/api/linux-desktop")
    return app.linuxDesktop.status(app.runtime.owner);
  if (request.method === "POST" && path === "/api/linux-desktop") {
    app.store.profiles.requireOwner("The shared Linux desktop");
    return app.linuxDesktop.saveSettings(app.runtime.owner, await readBody(request));
  }
  if (request.method === "POST" && path === "/api/linux-desktop/take-over") {
    app.store.profiles.requireOwner("The shared Linux desktop");
    await app.linuxDesktop.takeOver(app.runtime.owner);
    return app.linuxDesktop.status(app.runtime.owner);
  }
  if (request.method === "POST" && path === "/api/linux-desktop/hand-back") {
    app.store.profiles.requireOwner("The shared Linux desktop");
    await app.linuxDesktop.handBack(app.runtime.owner);
    return app.linuxDesktop.status(app.runtime.owner);
  }
  if (request.method === "GET" && path === "/api/linux-desktop/viewer") {
    app.store.profiles.requireOwner("The shared Linux desktop");
    return app.linuxDesktop.viewerInfo(app.runtime.owner);
  }
  const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(cancel|pause|resume|receipts|result|steer|plan))?$/.exec(path);
  if (match) {
    const run = app.store.run(match[1]!);
    // Live household helpers: the person's own task is theirs to stop, and a helper of it theirs to steer, while the
    // lending files them under the owner (src/household-approvals.ts personTaskHere). Nothing else widens.
    const own = !!run && request.method === "POST" && personTaskHere(app.store, app.runtime.owner, run.id)
      && (match[2] === "cancel" || (match[2] === "steer" && helperParent(app.store, run.id) !== null));
    if (!run || (run.owner !== app.store.profiles.scope() && !own))
      throw new HttpError(404, "Run not found");
    if (request.method === "POST" && match[2] === "cancel") {
      // Q221, Q226 (NAS 39e8973, 9ec0d3a): a short-lived key stops only a task it started, working or waiting, as it answers one.
      const keyRefusal = keyStopRefusal(app.store, run.id);
      if (keyRefusal) throw new HttpError(401, keyRefusal);
      // DESIGN-DIRECTION PR 1: a helper is stopped by the owner or its own person; its siblings and parent carry on.
      const helperRefusal = helperStopRefusal(app.store, run.id);
      if (helperRefusal) throw new HttpError(helperRefusal.status, helperRefusal.message);
      // A live conversation's task has no model turn to stop; one that never connected is stopped by the live side.
      if (app.runtime.cancel(run.id) || app.live.cancel(run.id)) return { cancelled: true };
      // Dogfood F8: a task waiting for an answer, or cut off by a restart, is stopped too, and its question goes with it.
      if (run.status !== "needs_input" && run.status !== "interrupted") return { cancelled: false };
      // Q222: by the task, so a question with no fingerprint never takes another task's question with it.
      app.runtime.approvals.dropFor(run.sessionId, run.id);
      // Q229 (NAS d157ab3): a plan waiting for the owner's yes, or stopped at a check-back, goes with its task, so a
      // later "ok" in the conversation never starts a plan the owner stopped.
      if (app.runtime.orchestration.plan(run.sessionId)?.runId === run.id) app.runtime.orchestration.clearPlan(run.sessionId);
      app.store.finish(run.id, "cancelled", run.output);
      return { cancelled: true };
    }
    // long-work: Pause stops a working task after the step it is on; Resume (below) carries it on from there.
    if (request.method === "POST" && match[2] === "pause") {
      const keyRefusal = keyStopRefusal(app.store, run.id);
      if (keyRefusal) throw new HttpError(401, keyRefusal);
      const paused = app.runtime.pause(run.id);
      return { paused, ...(paused ? { message: "Paused after this step. Nothing is lost." } : {}) };
    }
    if (request.method === "POST" && match[2] === "resume")
      return app.runtime.resume(run.id);
    // Steering a task that is working, and editing or approving the plan it is waiting on.
    if (request.method === "POST" && match[2] === "steer") {
      const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).strict().parse(await readBody(request));
      // DESIGN-DIRECTION PR 1: a helper is steered by the owner or its own person only, never by a key or into Lockdown.
      const helperRefusal = helperSteerRefusal(app.store, app.runtime.owner, run.id);
      if (helperRefusal) throw new HttpError(helperRefusal.status, helperRefusal.message);
      // The Steer chip's note, too late for the task to read, runs as its own next turn (the runtime says whose may).
      return app.runtime.steer(run.id, text, undefined, { lateTurn: true });
    }
    if (request.method === "GET" && match[2] === "plan")
      return { plan: app.runtime.orchestration.plan(run.sessionId) ?? null };
    if (request.method === "POST" && match[2] === "plan") {
      const body = PlanAnswerSchema.parse(await readBody(request));
      // Saying yes answers here and now; saying no asks for another plan, which takes a model turn.
      if (body.decision !== "reject") {
        const decided = await app.runtime.orchestration.decidePlan(run.id, body);
        // Redesign phase 1: a Plan conversation may act once its plan is agreed (only after the answer landed).
        planAgreed(app, run.sessionId);
        return decided;
      }
      const { plan, asked } = await app.runtime.answerPlan(run.id, body);
      return { ...plan, asked: asked ? { id: asked.id, status: asked.status, output: asked.output } : null };
    }
    if (request.method === "GET" && match[2] === "receipts") return receiptsView(app, run.id);
    // Q52: what the task made and how that was checked, from its own record (src/results.ts).
    if (request.method === "GET" && match[2] === "result") return runResult(app.store.receipts, run, app.store.events(run.id));
    if (request.method === "GET" && !match[2])
      return {
        run,
        // The events carry what each tool was given, so they go out through the same scrub as the run's streams.
        events: app.runtime.hideSecrets(app.store.events(run.id)),
        messages: app.store.messages(run.sessionId),
        usage: app.store.usage(run.id),
        cost: runCost(app, run.id),
        // Shown beside the answer, never folded into it: the owner reads both and decides.
        advice: app.runtime.advice(run.id),
      };
  }
  if (request.method === "GET" && path === "/api/activity") {
    // Q51: `?waiting=1` adds the tasks waiting for the owner; stale is judged by the owner's own model and tool limits.
    // Q58: queued tasks show they are waiting their turn, with position and what they wait behind.
    const waiting = new URL(request.url ?? "/", "http://local").searchParams.get("waiting") === "1";
    const staleMs = staleAfterMs(app.store, app.runtime.owner, app.runtime.reliability);
    // Dogfood B1: what a running task's model is thinking now, from memory only (never the record).
    // Redesign security review: whose tasks these are follows who is at the window. A household profile sees its own
    // tasks only, never the owner's (their prompts and what waits for the owner), as every other read of runs does.
    // Live helpers for household people: their own tasks working under the owner's name while lent are theirs too.
    const lent = app.store.profiles.isOwner() ? []
      : liveActivity(app.store, app.runtime.owner, { waiting, staleMs }).filter((a) => personTaskHere(app.store, app.runtime.owner, a.runId));
    const activities = [...liveActivity(app.store, app.store.profiles.scope(), { waiting, staleMs }), ...lent].map((a) => {
      const thinking = app.runtime.thinkingOf(a.runId);
      return { ...a, followUps: app.runtime.queued(a.sessionId).length, ...(thinking ? { thinking } : {}) };
    });
    if (!waiting) return activities;
    // Q58: add queued tasks for each conversation using pure function
    const result: RunActivity[] = [];
    for (const activity of activities) {
      result.push(activity);
      const queued = app.runtime.queued(activity.sessionId);
      if (queued.length) result.push(...queuedActivity(activity, queued));
    }
    return result;
  }
  // QA 2026-09-28: which model Codex answers with, and which ones it takes (src/codex-models.ts).
  if (request.method === "GET" && path === "/api/codex-models") return codexModelsView(app.runtime.models);
  if (request.method === "POST" && path === "/api/codex-models") return chooseCodexModel(app.runtime.models, await readBody(request));
  if (request.method === "POST" && path === "/api/codex-models/check") return checkCodexModels(app.runtime.models);
  // models-ui (MODEL-052): who spent what: the owner's own tasks and each Trunk's, with the accounts they used.
  if (request.method === "GET" && path === "/api/usage/by-trunk")
    return usageByTrunk({ store: app.store, owner: app.runtime.owner, trunkName: (id) => app.trunks.records.find(id)?.name ?? null,
      costOf: (runId) => runCost(app, runId).amount ?? null }, Object.fromEntries(new URL(request.url ?? "/", "http://local").searchParams));
  if (request.method === "GET" && path === "/api/second-opinion")
    return secondOpinionSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/second-opinion")
    return saveSecondOpinionSettings(app.store, app.runtime.owner, await readBody(request));
  // models-ui (MODEL-051): each specialist's own model and account when a call names none (src/helper-defaults.ts).
  if (request.method === "GET" && path === "/api/helper-defaults")
    return helperDefaultsView(app.store, app.runtime.owner, app.runtime.models);
  if (request.method === "POST" && path === "/api/helper-defaults") {
    saveHelperDefault(app.store, app.runtime.owner, app.runtime.models, await readBody(request));
    return helperDefaultsView(app.store, app.runtime.owner, app.runtime.models);
  }
  if (request.method === "GET" && path === "/api/orchestration")
    return orchestrationSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/orchestration")
    return saveOrchestrationSettings(app.store, app.runtime.owner, await readBody(request));
  // Wave 9: "Just do it" or "Show me the plan first", per conversation and per project.
  if (path === "/api/plan-act" && (request.method === "GET" || request.method === "POST"))
    return planActApi(app, request, await (request.method === "POST" ? readBody(request) : Promise.resolve({})));
  // ── mac7/smoke-fixes (B4): the terminal while the window is open ──────────────────────────────
  // A second Branch may not open the same saved work, so `branch token`, `branch trace` and the
  // places that only look go through the Branch already running, exactly as `branch schedule` does.
  // All three are the owner's alone, at this computer: a household profile and a short-lived key are
  // refused before they arrive here (offLimitsToShortLivedKeys, offLimitsToHousehold).
  if (path === "/api/tokens" && (request.method === "GET" || request.method === "POST")) {
    if (request.method === "GET") return { tokens: app.sessionTokens.list(app.runtime.owner) };
    const made = app.sessionTokens.create(app.runtime.owner, await readBody(request));
    return { token: made.token, entry: made.entry, scopeNote: scopeDescriptions[made.entry.scope] };
  }
  const takingBack = /^\/api\/tokens\/([^\/]{1,64})\/revoke$/.exec(path);
  if (takingBack && request.method === "POST")
    return { id: takingBack[1]!, revoked: app.sessionTokens.revoke(app.runtime.owner, takingBack[1]!) };
  const tracing = /^\/api\/runs\/([a-f0-9-]{36})\/trace$/.exec(path);
  if (tracing && request.method === "GET") {
    const run = app.store.run(tracing[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    // Two consumers, two shapes. The CLI (branch trace) reads this as TraceReport (simple format with
    // runId, traceId, spans count, kinds array, sending status). A tracing viewer reads ?format=document
    // to get OpenTelemetry TraceDocument (hierarchical resourceSpans). Default to TraceReport for
    // backward compatibility; the viewer test requests format=document explicitly.
    const url = new URL(request.url ?? "/", "http://local");
    if (url.searchParams.get("format") === "document") {
      return buildTraceDocument(app.store, run.id, app.version);
    }
    // Default: return TraceReport for the CLI
    return (await import("./trace-report.js")).traceReport(app.store, app.traceExport.settings(), run.id);
  }
  if (request.method === "GET" && path === "/api/terminal") return terminalReadApi(app, request);
  // ── end mac7/smoke-fixes (B4) ─────────────────────────────────────────────────────────────────
  if (request.method === "GET" && path === "/api/alive") return { ok: true, version: app.version };
  if (request.method === "GET" && path === "/api/health")
    return healthReport(app, { probeProvider: new URL(request.url ?? "/", "http://local").searchParams.get("probe") === "1" });
  if (request.method === "GET" && path === "/api/backup") {
    audit(app.store, app.runtime.owner, { action: "data.exported", actor: app.runtime.owner, subject: "a full backup",
      reason: "Everything except the saved secrets was written out as one file", outcome: "saved" });
    return app.store.backup(app.version);
  }
  // Q168 B: what a restore is waiting to hear about, and the owner's answer; the owner's alone (checked inside).
  if (path === "/api/restore/held" && request.method === "GET") return app.store.restoreHeld.list();
  if (path === "/api/restore/held" && request.method === "POST") return app.store.restoreHeld.answer(await readBody(request));
  // #484: the Trunks a restore brought back cut down, and the owner's answer for each; the owner's alone (checked inside).
  if (path === "/api/restore/trunks" && request.method === "GET") return app.store.restoredTrunks.list();
  if (path === "/api/restore/trunks" && request.method === "POST") return app.store.restoredTrunks.answer(await readBody(request));
  if (request.method === "POST" && path === "/api/restore") {
    const replaceExisting = new URL(request.url ?? "/", "http://local").searchParams.get("replace") === "1";
    return restoreBackup(app, () => readBody(request, maximumBackupBytes), replaceExisting);
  }
  if (request.method === "GET" && path === "/v1/models") return modelsList(app);
  if (request.method === "GET" && path === "/api/hooks") return { hooks: app.hooks.list() };
  if (request.method === "GET" && path === "/api/teams") return { teams: app.teams.list() };
  if (request.method === "POST" && path === "/api/teams") return app.teams.save(await readBody(request));
  const team = /^\/api\/teams\/([a-f0-9-]{36})(?:\/(room|run|remove|tasks))?$/.exec(path);
  if (team && request.method === "GET" && !team[2]) return app.teams.get(team[1]!);
  if (team && request.method === "GET" && team[2] === "room") return { messages: app.teams.room(team[1]!) };
  // Q64: the team's recent tasks, who holds them, their members, handoffs, blockers and results. The owner's
  // alone: a short-lived key and a household profile are refused before this (ownerOnlyReads, src/short-lived-keys.ts).
  if (team && request.method === "GET" && team[2] === "tasks") return { tasks: app.teams.taskViews(team[1]!) };
  if (team && request.method === "POST" && team[2] === "run") {
    // Q61: owner and source come from who signed in, never the body (strict refuses such fields).
    const { prompt, requestId } = z.object({ prompt: z.string().trim().min(1).max(8000), requestId: z.string().uuid().optional() }).strict().parse(await readBody(request));
    return app.teams.run(app.runtime, app.knowledge, team[1]!, prompt, { requestId, source: teamCaller(app) });
  }
  const handoff = /^\/api\/teams\/([a-f0-9-]{36})\/handoffs(?:\/([a-f0-9-]{36})\/(accept|reject))?$/.exec(path);
  if (handoff) return teamHandoffApi(app, request, handoff[1]!, handoff[2], handoff[3]);
  if (team && request.method === "POST" && team[2] === "remove") return app.teams.remove(team[1]!);
  if (request.method === "POST" && path === "/api/registry/browse") {
    const { url } = z.object({ url: z.string().url().max(2000) }).strict().parse(await readBody(request));
    return app.skillRegistry.browse(url);
  }
  // The owner's yes to a registry's signing key, by the fingerprint browsing showed them (src/registry-install.ts).
  if (request.method === "POST" && path === "/api/registry/trust") {
    const { url, fingerprint } = z.object({ url: z.string().url().max(2000), fingerprint: z.string().regex(/^[0-9a-fA-F]{64}$/) }).strict().parse(await readBody(request));
    return { key: await app.skillRegistry.trustKey(url, fingerprint) };
  }
  if (request.method === "POST" && path === "/api/registry/install") {
    const { url, skillId } = z.object({ url: z.string().url().max(2000), skillId: z.string().min(1).max(64) }).strict().parse(await readBody(request));
    return app.skillRegistry.install(url, skillId);
  }
  // Wave 4: newer versions of skills installed from a registry, and a way back to the old one.
  if (request.method === "GET" && path === "/api/registry/updates") return app.skillRegistry.updates();
  if (request.method === "POST" && (path === "/api/registry/update" || path === "/api/registry/rollback")) {
    const { skillId } = z.object({ skillId: z.string().uuid() }).strict().parse(await readBody(request));
    return path.endsWith("update") ? app.skillRegistry.update(skillId) : app.skillRegistry.rollback(skillId);
  }
  // Wave 7: what the assistant is carrying, what it has learned, and a way to delete the learning.
  // What the assistant has learned is the owner's, exactly like their projects and their locker:
  // somebody else on a shared computer must not read it away or throw it away.
  if (request.method === "GET" && path === "/api/tools/catalog") {
    app.store.profiles.requireOwner("What the assistant has learned about its tools");
    return toolCatalogReport(app);
  }
  if (path === "/api/tools/meaning-search") {
    app.store.profiles.requireOwner("How the assistant finds its tools");
    if (request.method === "POST") {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await readBody(request));
      app.store.save("settings", app.runtime.owner, meaningSearchSetting, { enabled });
    }
    const reader = app.knowledgeBases.embeddings(app.runtime.owner);
    return { enabled: meaningSearchOn(app.store, app.runtime.owner),
      available: reader !== null,
      explanation: meaningSearchExplanation(meaningSearchReceiver(app, reader)) };
  }
  // Which servers, plugins and skills travel with every request and which wait until a task needs them, with what each
  // costs a request (src/tool-context-api.ts). The owner's setup: a household profile or a short-lived key is refused.
  if (path === "/api/tools/context") {
    app.store.profiles.requireOwner("What goes with every request");
    const deps = { store: app.store, registry: app.registry, owner: app.runtime.owner };
    if (request.method === "GET") return contextSources(deps);
    if (request.method === "POST") return changeContextMode(deps, await readBody(request));
  }
  if (request.method === "POST" && path === "/api/tools/forget") {
    app.store.profiles.requireOwner("What the assistant has learned about its tools");
    const { what } = z.object({ what: z.enum(["history", "notes", "all"]).default("all") }).strict().parse(await readBody(request));
    return app.store.toolUsage.forget(app.runtime.owner, what);
  }
  const toolNote = /^\/api\/tools\/notes\/([a-f0-9-]{36})$/.exec(path);
  if (toolNote && request.method === "DELETE") {
    app.store.profiles.requireOwner("What the assistant has learned about its tools");
    return app.store.toolUsage.removeNote(app.runtime.owner, toolNote[1]!);
  }
  if (request.method === "GET" && path === "/api/plugins") return { plugins: await app.plugins.list(), problems: app.pluginProblems };
  const plugin = /^\/api\/plugins\/([a-z][a-z0-9-]{0,39})\/(inspect|enable|disable)$/.exec(path);
  if (plugin && request.method === "POST") {
    if (plugin[2] === "inspect") return app.plugins.inspect(plugin[1]!);
    if (plugin[2] === "disable") return app.plugins.disable(plugin[1]!);
    // Batch 26 (wave 8): the permissions the owner ticked. Left out, the plugin gets everything its
    // own manifest declared, exactly as switching one on did before.
    const body = z.object({ allow: z.array(z.string().trim().max(64)).max(20).optional() })
      .strict().parse((await readBody(request).catch(() => ({}))) ?? {});
    return app.plugins.enable(plugin[1]!, body.allow);
  }
  if (request.method === "GET" && path === "/api/evaluation") return { results: app.evaluation.list(), standard: standardSuite };
  if (request.method === "POST" && path === "/api/evaluation") { const body = await readBody(request) as Record<string, unknown>; return app.evaluation.run(app.runtime, Object.keys(body).length ? body : undefined); }
  // Suites kept as data: the five that ship, the owner's own, their history and model comparison.
  if (request.method === "GET" && path === "/api/evaluation/suites")
    return { suites: allSuites(app.store, app.runtime.owner) };
  if (request.method === "POST" && path === "/api/evaluation/suites")
    return saveSuite(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/evaluation/suites/from-run")
    return suiteFromRun(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/evaluation/suites/remove") {
    const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(await readBody(request));
    return removeSuite(app.store, app.runtime.owner, id);
  }
  if (request.method === "POST" && path === "/api/evaluation/run")
    return app.evaluationSuites.run(await readBody(request));
  if (request.method === "POST" && path === "/api/evaluation/compare")
    return app.evaluationSuites.compare(await readBody(request));
  if (request.method === "GET" && path === "/api/evaluation/history") {
    const suite = new URL(request.url ?? "/", "http://local").searchParams.get("suite") ?? undefined;
    return { runs: app.evaluationSuites.history(suite), trend: app.evaluationSuites.trend(suite) };
  }
  // Wave 7 (benchmarks and experiments): scorers, benchmarks read from the owner's own files,
  // studies with checkpoints and resume, comparison with an interval, and the tool checks.
  if (request.method === "GET" && path === "/api/evaluation/benchmarks")
    return { adapters: benchmarkAdapters.map(({ id, name, format, layout }) => ({ id, name, format, layout })), notIntegrated: notIntegratedBenchmarks, scorers: scorerKinds };
  if (request.method === "GET" && path === "/api/studies")
    return { studies: app.studies.list(), results: app.studies.results().map(studySummary) };
  if (request.method === "POST" && path === "/api/studies") return app.studies.save(await readBody(request));
  // Batch 20 (wave 8): the one folder outside the workspace a study may read a benchmark from.
  if (path === "/api/studies/settings")
    return { settings: request.method === "POST" ? app.studies.configure(await readBody(request)) : app.studies.settings() };
  if (request.method === "POST" && path === "/api/studies/run") {
    const body = z.object({ id: z.string().min(1).max(64), fresh: z.boolean().default(false) }).strict().parse(await readBody(request));
    const result = await app.studies.run(body.id, { fresh: body.fresh });
    return { result, table: studyTable(result) };
  }
  if (request.method === "POST" && path === "/api/studies/compare") {
    const body = z.object({ a: z.string().uuid(), b: z.string().uuid() }).strict().parse(await readBody(request));
    const all = app.studies.results();
    const left = all.find((entry) => entry.id === body.a), right = all.find((entry) => entry.id === body.b);
    if (!left || !right) throw new Error("One of those study results is not on file");
    const comparison = compareStudies(left, right);
    return { comparison, table: comparisonTable(comparison) };
  }
  // Wave 9: the same scorers held against the real work, so a quiet break shows up on ordinary
  // tasks rather than only on the test set.
  if (path === "/api/evaluation/live") {
    if (request.method === "POST") return { settings: app.liveScoring.configure(await readBody(request)) };
    return { settings: app.liveScoring.settings(), recent: app.liveScoring.recent(50), summary: app.liveScoring.summary(100) };
  }
  if (request.method === "POST" && path === "/api/evaluation/tools")
    // The checks really write files and really save facts, so they do it in a project and under a
    // name of their own: nothing they do reaches the owner's folder or the owner's memory.
    return runToolChecksSafely(app, AbortSignal.timeout(120000));
  if (path === "/api/practice-runs") {
    if (request.method === "GET") return { enabled: practiceRunsEnabled(app.store, app.runtime.owner) };
    if (request.method !== "POST") throw new HttpError(405, "Use GET or POST here.");
    app.store.profiles.requireOwner("Practice run availability");
    try { return { enabled: savePracticeRuns(app.store, app.runtime.owner, await readBody(request)) }; }
    catch (error) { throw new HttpError(400, errorText(error)); }
  }
  if (request.method === "GET" && path === "/api/policy")
    // Q259: the owner's approval rules (paths, commands, limits) are theirs; a household person is sent none of them.
    return { policy: app.store.profiles.isOwner() ? readPolicy(app.store, app.runtime.owner) : null, presets: policyPresets(),
      // Q257: a household person is shown only their own tasks' questions (the Inbox and the chat card read this).
      waiting: app.runtime.approvals.waiting().filter((asked) => mayAnswerHere(app.store, asked))
        .map((asked) => ({ ...asked, ...helperMark(app, asked.runId) })) };
  if (request.method === "POST" && path === "/api/policy") {
    // Q257: refused under Lockdown (409, as the rules and the settings kit are), and a change that makes Branch less
    // careful needs the owner's separate yes, weighed on exactly the policy it would save.
    const { confirmLoosening, input } = withoutConfirm(await readBody(request));
    const current = readPolicy(app.store, app.runtime.owner);
    const refusal = policyChangeRefusal(app.store, app.runtime.owner, nextPolicy(current, input), confirmLoosening, app.registry);
    if (refusal) throw new HttpError(409, refusal);
    return { policy: recordedWrite(app.store, app.runtime.owner, { writer: "owner-in-window", source: "card", detail: "policy" }, ["policy"],
      () => savePolicy(app.store, app.runtime.owner, input)) };
  }
  // Settings › Branch itself: what Branch may do about itself, as approval rules (src/self-rules.ts); owner only.
  if (path === selfRulesPath && (request.method === "GET" || request.method === "POST")) {
    app.store.profiles.requireOwner("What Branch may do about itself");
    const names = app.registry.names();
    if (request.method === "GET") return selfRulesView(app.store, app.runtime.owner, names);
    if (startedWithShortLivedKey()) throw new HttpError(401, "A short-lived key cannot change what Branch may do about itself. Do that in the app window.");
    const { confirmLoosening, input } = withoutConfirm(await readBody(request));
    try { return changeSelfRule(app.store, app.runtime.owner, input, confirmLoosening, app.registry, names); } catch (error) {
      throw error instanceof SelfRuleRefusal ? new HttpError(409, error.message) : error;
    }
  }
  if (request.method === "POST" && path === "/api/policy/approve") {
    const input = z.object({ sessionId: z.string().uuid(), decision: z.enum(["allow", "deny"]),
      remember: PolicyRememberSchema.default("session"),
      // Batch 19 (wave 7): the fingerprint the person was shown, so a yes cannot land on a changed request.
      fingerprint: z.string().regex(/^[a-f0-9]{32}$/).optional(),
      // mac7/r17-g: the six-digit code from the owner's authenticator app, for a yes that needs one.
      code: z.string().max(12).optional(),
      // Dogfood A6/B6: the window's own cards ask for the task to be settled (carried on, or its wait ended).
      // Scripts, the terminal and phones send their next message themselves, as before.
      carryOn: z.boolean().optional(),
      // Redesign: "Always allow for <Trunk>": the Trunk the standing yes is kept for; it must be the Trunk that asked.
      trunk: z.string().min(1).max(100).optional() }).strict().parse(await readBody(request));
    // Q257: first of all, a household person answers only their own task's question; anything else reads as nothing
    // waiting, before the room check, the code, the answer or the carry-on can say or change anything.
    refuseForeignQuestion(app, input.sessionId, input.fingerprint);
    // Q257: a bare yes lands on whatever the conversation is asking now, which need not be what the person saw. Every
    // question carries a fingerprint, so an answer that names no request is refused whenever one is waiting, before
    // anything is answered or settled.
    if (input.fingerprint === undefined && app.runtime.approvals.questionFor(input.sessionId)?.fingerprint)
      throw new HttpError(409, unnamedAnswerRefusal);
    // mac5/key-sweep: answering is a run key's job, but "always" would write a standing rule.
    if (input.remember === "always" && startedWithShortLivedKey())
      throw new HttpError(401, "A short-lived key can answer this once or for this conversation, but cannot make a standing rule. Do that in the app window.");
    // bucket 19: a short-lived key answers only the questions of tasks it started itself.
    requireBoundSession(shortLivedKeyMark().sessionId, input.sessionId);
    // phase2/rooms (integration review): a yes that holds for a Trunk in a room is the owner's, given in the room.
    if (input.remember !== "never" && app.trunks.conversations.kind(input.sessionId) === "member"
      && (startedWithShortLivedKey() || !app.store.profiles.isOwner()))
      throw new HttpError(401, "A yes that holds in a room is given by the owner, in the room. Answer this once instead.");
    // With nothing waiting, the answer below says so in its own words.
    const asked = app.runtime.approvals.questionFor(input.sessionId, input.fingerprint);
    const keyRefusal = asked ? keyAnswerRefusal(app.store, asked.runId) : null;
    if (keyRefusal) throw new HttpError(401, keyRefusal);
    // mac7/r17-g: a code typed with the answer is checked first; a wrong one is said plainly.
    if (input.code !== undefined && asked && !(await confirmWithCode(app.store, app.runtime.owner, input.sessionId, asked.fingerprint, input.code)))
      throw new HttpError(401, codesResting(app.store, app.runtime.owner) ? restingRefusal : "That authenticator code did not match, or it was already used. Wait for the next code.");
    const answered = app.runtime.approve(input.sessionId, input.decision, input.remember, input.fingerprint, undefined, input.trunk);
    if (asked && input.carryOn) return { ...answered, task: await settleAsked(app, asked, input.decision) };
    return answered;
  }
  if (request.method === "GET" && path === "/api/governance")
    return { settings: app.store.governance.settings(), setAside: app.store.governance.exclusions(), benchmarks: app.store.governance.benchmarks() };
  if (request.method === "POST" && path === "/api/governance") return app.store.governance.configure(await readBody(request));
  const restoreSkill = /^\/api\/governance\/set-aside\/([a-f0-9-]{36})\/restore$/.exec(path);
  if (restoreSkill && request.method === "POST") { app.store.governance.restore(restoreSkill[1]!); return { restored: true }; }
  const hookEnable = /^\/api\/hooks\/([a-z][a-z0-9_-]{0,39})\/enable$/.exec(path);
  if (hookEnable && request.method === "POST") return app.hooks.enable(hookEnable[1]!);
  const template = /^\/api\/templates\/(specialist|procedure)\/([a-f0-9-]{36})$/.exec(path);
  if (template && request.method === "GET") return exportTemplate(app.store, app.runtime.owner, template[1] as "specialist" | "procedure", template[2]!);
  // p17 (whole-agent export from the window): what each part holds, then the one file. The owner's alone; a
  // short-lived key is refused the POST by the fail-closed rule, and memory always leaves with personal details masked.
  if (path === "/api/agent-export") {
    app.store.profiles.requireOwner("Taking the whole assistant with you");
    if (request.method === "GET") return { sections: agentSummary(app.store, app.runtime.owner) };
    if (request.method !== "POST") throw new HttpError(405, "Use GET or POST");
    const { sections } = AgentExportSchema.parse(await readBody(request));
    const { bytes, manifest } = exportAgent(app.store, app.runtime.owner, app.version, {
      sections, memory: sections.includes("memory"), redact: (text) => applyPiiGuard(text, "mask").text });
    return { manifest, data: bytes.toString("base64") };
  }
  if (request.method === "POST" && path === "/api/templates/import") return importTemplate(app.knowledge, app.runtime.context(), await readBody(request, 256 * 1024));
  if (request.method === "POST" && path === "/api/receipts/verify") {
    const body = z.object({ runId: z.string().min(1).max(64), data: z.record(z.string(), z.unknown()) }).strict().parse(await readBody(request));
    return app.store.receipts.verify(body.runId, body.data);
  }
  if (request.method === "POST" && path === "/api/run") {
    const input = RunInputSchema.parse(await readBody(request, runBodyLimit));
    requireBoundSession(shortLivedKeyMark().sessionId, input.sessionId); // bucket 19
    // Redesign phase 1 (integration review): a new conversation's mode is held to what the picker allows here.
    const modeRefused = input.mode && !input.sessionId ? modeRefusal(app, input.mode) : null;
    if (modeRefused) throw new HttpError(403, modeRefused);
    // QA retest 2026-09-28 (m10): which model a new conversation answers with is the owner's pick at the window, as it
    // is in its model menu; a short-lived key or a household person does not choose one.
    if (input.preset && !input.sessionId && (!app.store.profiles.isOwner() || startedWithShortLivedKey()))
      throw new HttpError(403, "Only the owner, at the app, picks the model a new conversation answers with.");
    // Wave 6: a task started while somebody's profile is switched on is filed under their name.
    let userMessageId: number | undefined;
    // defaulttrunk: a new conversation that names nobody is a thread with the default Trunk (a temporary one stays nobody's).
    const home = !input.sessionId && !input.temporary ? app.trunks.homeForNew() : null;
    const run = await runForCurrentPerson(app, {
      prompt: input.prompt,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(home ? { trunkId: home } : {}),
      ...(input.temporary ? { temporary: true } : {}),
      ...(input.checks ? { checks: CompletionCheckSchema.parse(input.checks) } : {}),
      ...(input.dryRun ? { dryRun: true } : {}),
      // A picture that was attached is also shown to the model, so the page sends its bytes once.
      ...picturesFor(input),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      // Files sent ahead are taken only for the one who sent them (src/attachments.ts staged).
      ...(input.uploads?.length ? { uploads: { who: app.store.profiles.scope(), ids: input.uploads } } : {}),
      ...(input.plan !== undefined ? { plan: input.plan } : {}),
      ...(input.verify !== undefined ? { verify: input.verify } : {}),
      ...(input.mode && !input.sessionId ? { conversationMode: input.mode } : {}),
      ...(input.reasoning && !input.sessionId ? { conversationReasoning: input.reasoning } : {}),
      ...(input.preset && !input.sessionId ? { conversationPreset: input.preset } : {}),
      // long-work: a task started from the window may work for hours; its budgets and the stall watch still hold it.
      timeoutMs: longTaskDeadlineMs,
      // Projects are the owner's: a household person's new conversation is never filed under one of them by name. A task
      // reaches its project's folder and secrets (src/project-scope.ts), so naming one is the owner's own act in the app,
      // never a short-lived key's: a key's new conversation goes where the owner's pick files it, as it always did.
      ...(input.project && !input.sessionId && app.store.profiles.isOwner() && !startedWithShortLivedKey() ? { conversationProject: input.project } : {}),
      personReply: true, // Q050: the person's own message may answer the question its conversation waits on
      onUserMessageId: (id) => { userMessageId = id; },
      // Live steps: the model is asked to stream, so its reasoning summaries reach the window's live step list while it
      // works (runtime.thoughtsOf); the words themselves still arrive with the finished answer, as before.
      onTextDelta: () => undefined,
    });
    return userMessageId !== undefined ? { ...run, userMessageId } : run;
  }
  // phase2/panels: what the side panel's Browser and Terminal tabs show (src/panels-work.ts); owner only.
  if (request.method === "GET" && path === panelsWorkPath)
    return panelsWork(app.store, app.runtime.owner, new URL(request.url ?? "/", "http://local").searchParams.get("session") ?? "");
  // live-stage: the full-size view of Branch's browser, a frame of what a conversation's task sees now (src/live-stage.ts).
  if (request.method === "GET" && path === liveStagePath) {
    const query = new URL(request.url ?? "/", "http://local").searchParams;
    const replay = query.has("step") ? { step: query.get("step"), runId: query.get("run"), planAt: query.get("plan") } : undefined;
    return liveStage({ store: app.store, owner: app.runtime.owner, profiles: app.store.profiles, browser: app.browser,
      plan: session => app.runtime.orchestration.plan(session), observeSteps: query.get("observe") === "steps" }, query.get("session") ?? "", replay);
  }
  // Redesign phase 1: the mode chip in the message box (src/conversation-mode-api.ts).
  if (handlesConversationModePath(path))
    return conversationModeApi(app, request.method ?? "GET", new URL(request.url ?? "/", "http://local"), () => readBody(request))
      .catch((error: unknown) => { throw error instanceof ConversationModeError ? new HttpError(error.status, error.message) : error; });
  if (request.method === "POST" && path === "/api/action") {
    const action = actionSchema.parse(await readBody(request));
    // mac5/manual-actions: the owner pressed it in the app window (src/tool-gate.ts). A short-lived
    // key goes through the same gate held to the full rules; its refusal is a 401 (mac5/key-sweep).
    return asKeyRefusal(() => app.runtime.executeTool(action.tool, action.args, { mode: "owner" }));
  }
  // Usage and observability routes
  if (request.method === "GET" && path === "/api/usage") {
    const url = new URL(request.url ?? "/", "http://local");
    const range = (url.searchParams.get("range") ?? "30d") as "7d" | "30d" | "90d" | "all";
    const by = (url.searchParams.get("by") ?? "day") as "day" | "model" | "conversation" | "source";
    const { overrides } = pricingSettings(app.store, app.runtime.owner);
    // Q259: the owner's spending is theirs; a household person is sent their own conversations' usage and nothing else.
    if (!app.store.profiles.isOwner())
      return { data: app.store.usageStore().aggregateUsage(range, by, overrides, ownConversationOf(app)), stats: null, statistics: null, pricing: null };
    const data = app.store.usageStore().aggregateUsage(range, by, overrides);
    const budget = app.store.get("settings", app.runtime.owner, "usage_budget")?.data as { maxMonthlyTokens?: number } | undefined;
    const stats = app.store.usageStore().getMonthlyStats(budget?.maxMonthlyTokens, overrides);
    // Wave 7: the few numbers that say how it is behaving, beside what it cost.
    const statistics = app.store.usageStore().statistics(app.runtime.owner, range === "7d" ? 7 : range === "90d" ? 90 : 30);
    return { data, stats, statistics, pricing: pricingTableInUse(app.store, app.runtime.owner) };
  }
  if (request.method === "GET" && path === "/api/pricing")
    return pricingTableInUse(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/pricing")
    return savePricingSettings(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "GET" && path === "/api/trace/settings")
    return traceSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/trace/settings")
    return saveTraceSettings(app.store, app.runtime.owner, app.runtime.workspace, await readBody(request));
  // mac7/diagnostics: the activity log and "Report a problem" (src/diagnostic-api.ts), the owner's alone.
  if (handlesDiagnosticPath(path))
    return diagnosticApi({ app, dataDir, installType: diagnosticInstall.type, startedAt: diagnosticInstall.startedAt },
      request.method ?? "GET", path, new URL(request.url ?? "/", "http://local"), () => readBody(request, 8 * 1024 * 1024));
  // Owner item 19: an update that did not go through, and its file (src/update-failure.ts), the owner's alone.
  // Owner item 21: Fix update and who does it (src/update-fix.ts), the owner's alone.
  if (handlesUpdateFixPath(path))
    return updateFixApi({ app, dataDir, installType: diagnosticInstall.type, startedAt: diagnosticInstall.startedAt }, request.method ?? "GET", path, () => readBody(request));
  // The copies of the data folder taken before each update, and putting one back at the next start (src/install/data-copy.ts).
  if (path === "/api/updates/data-copies")
    return dataCopyApi({ requireOwner: (what) => app.store.profiles.requireOwner(what), pairedDoor: throughDoor(request), dataDir,
      method: request.method ?? "GET", readBody: () => readBody(request) })
      .catch((error: unknown) => { throw error instanceof DataCopyRefusal ? new HttpError(403, error.message) : error; });
  if (handlesUpdateFailurePath(path))
    return updateFailureApi({ app, dataDir, installType: diagnosticInstall.type, startedAt: diagnosticInstall.startedAt }, request.method ?? "GET", path);
  if (request.method === "POST" && path === "/api/diagnostics/bundle")
    return writeDiagnosticsBundle(app.store, app.runtime.owner, dataDir, {
      health: await healthReport(app), version: app.version, memory: app.memory.tidy.health(app.runtime.owner),
    });
  const traceMatch = /^\/api\/runs\/([a-f0-9-]{36})\/trace$/.exec(path);
  if (request.method === "GET" && traceMatch) {
    const run = app.store.run(traceMatch[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    // Two consumers, two shapes: CLI (TraceReport) by default, viewer (TraceDocument) with ?format=document
    const url = new URL(request.url ?? "/", "http://local");
    if (url.searchParams.get("format") === "document") {
      return buildTraceDocument(app.store, run.id, app.version);
    }
    return (await import("./trace-report.js")).traceReport(app.store, app.traceExport.settings(), run.id);
  }
  // "Look inside" a task: rounds, tool calls, plan, verdicts and steering in one answer.
  // Q259: this, /steps and /trajectory are open to a household person at the window, so each finds only a task
  // filed under whoever is there (profiles.scope()); the owner's tasks read as not found, as on /trace and /timeline.
  const inspectMatch = /^\/api\/runs\/([a-f0-9-]{36})\/inspect$/.exec(path);
  if (request.method === "GET" && inspectMatch) {
    const run = app.store.run(inspectMatch[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    // A tool call's raw arguments are read back off the assistant message, which the runtime never
    // scrubbed; nothing leaves here carrying a saved password or key.
    return app.runtime.hideSecrets(inspectRun(app.store, run.id, await trajectoryOptions(app, run.id)));
  }
  // Pass 17 (Timeline, Helpers): one task's steps in order, its helpers, and its links in the activity chain.
  const stepsMatch = /^\/api\/runs\/([a-f0-9-]{36})\/steps$/.exec(path);
  if (request.method === "GET" && stepsMatch) {
    const run = app.store.run(stepsMatch[1]!);
    // Q259: household profiles are not refused this route (a GET a short-lived key may read), so whose task it is
    // follows who is at the window (profiles.scope(), as the activity list does since #324 and /trace does); a household
    // person also reads their own task and its helpers while the lending files them under the owner (personTaskHere).
    if (!run || (run.owner !== app.store.profiles.scope() && !personTaskHere(app.store, app.runtime.owner, run.id))) throw new HttpError(404, "Run not found");
    // Tool inputs are read back off the conversation, and helpers' words and questions too: nothing leaves with a secret.
    return app.runtime.hideSecrets(await stepsOf(app, run.id));
  }
  // Batch 26 (wave 8): "Do this again" — the same words, the same tools and the same model, in a
  // conversation of its own, so the two can be read side by side.
  const replay = /^\/api\/runs\/([a-f0-9-]{36})\/replay$/.exec(path);
  if (request.method === "POST" && replay) {
    // Q259: the task done again runs in the owner's name (not through runForCurrentPerson), so it is the owner's alone:
    // a household person at the window may not do the owner's task again, nor their own as the owner.
    app.store.profiles.requireOwner("Doing a task again");
    const run = app.store.run(replay[1]!);
    if (!run || run.owner !== app.runtime.owner) throw new HttpError(404, "Run not found");
    const done = await replayRun(app.runtime, app.store, run.id);
    return { original: done.original, replay: done.replay, status: done.run.status, plan: done.plan };
  }
  // Wave 7: the same task as a trajectory — "Look inside" plus the conversation's messages and the
  // spans — in the documented shape, for keeping or for feeding an evaluation run.
  const trajectory = /^\/api\/runs\/([a-f0-9-]{36})\/trajectory$/.exec(path);
  if (request.method === "GET" && trajectory) {
    const run = app.store.run(trajectory[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    return app.runtime.hideSecrets(buildTrajectory(app.store, run.id, await trajectoryOptions(app, run.id)));
  }
  if (request.method === "GET" && /^\/api\/runs\/([a-f0-9-]{36})\/timeline$/.test(path)) {
    const match = /^\/api\/runs\/([a-f0-9-]{36})\/timeline$/.exec(path);
    if (!match) throw new HttpError(400, "Invalid run ID");
    const run = app.store.run(match[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    return { timeline: app.store.usageStore().getRunTimeline(run.id) };
  }
  // Wave 7: writing the month's usage out as a spreadsheet, on a schedule, into your workspace.
  if (path === "/api/usage/metering") {
    const deps = meteringDeps(app);
    if (request.method === "GET") return { metering: meteringSettings(app.store, app.runtime.owner) };
    if (request.method === "POST") {
      const settings = saveMeteringSettings(app.store, app.runtime.owner, await readBody(request));
      /* A folder that would climb out of the workspace is refused now, not at the next beat. */
      meteringFolder(deps.workspace, settings.folder);
      return { metering: settings };
    }
  }
  if (request.method === "POST" && path === "/api/usage/metering/now") {
    const { range } = MeteringExportSchema.parse(await readBody(request, 1024).catch(() => ({})) ?? {});
    const written = await writeMeteringFile(meteringDeps(app), new Date(), range);
    return { ...written, metering: meteringSettings(app.store, app.runtime.owner) };
  }
  if (request.method === "GET" && path === "/api/usage/budget") {
    const budget = app.store.get("settings", app.runtime.owner, "usage_budget")?.data;
    return { budget: budget || null };
  }
  if (request.method === "POST" && path === "/api/usage/budget") {
    // A monthly limit raised or taken away needs the owner's yes, and never under Lockdown (src/policy-change-guard.ts).
    const { confirmLoosening, input: asked } = withoutConfirm(await readBody(request));
    const input = budgetSchema.parse(asked);
    const before = app.store.get("settings", app.runtime.owner, "usage_budget")?.data as z.infer<typeof budgetSchema> | undefined;
    const refusal = looseningRefusal(budgetLooser(before, input), confirmLoosening, lockdownActive(app.store, app.runtime.owner));
    if (refusal) throw new HttpError(409, refusal);
    app.store.save("settings", app.runtime.owner, "usage_budget", input);
    return { budget: input };
  }
  // --- bucket 14 (A0367, A1751): the usage report and sending the task counters; src/usage-report-api.ts ---
  if (["/api/usage/report", "/api/usage/report/settings", "/api/usage/counters", "/api/usage/counters/send"].includes(path))
    return usageReportRoute(app, request, path, () => readBody(request));
  // --- end bucket 14 ---
  // --- mac7/usage-bar: what each connection has left, in its honest state; src/usage-limits-api.ts ---
  // Redesign phase 1: the ring under the message box. Somebody other than the owner gets an empty answer, never an error.
  if (path === usageGlancePath && request.method === "GET") return readUsageGlance(app);
  if (handlesUsageLimitsPath(path))
    return usageLimitsRoute(app, request, path, () => readBody(request))
      .catch((error: unknown) => { throw error instanceof UsageLimitsError ? new HttpError(error.status, error.message) : error; });
  // --- end mac7/usage-bar ---
  // phase2/delight: the pet, achievements and your own background; the owner's alone (src/delight.ts).
  if (handlesDelightPath(path))
    return delightRoute(app, request.method ?? "GET", path, () => readBody(request),
      new URL(request.url ?? "/", "http://local").searchParams.get("lang")) // mac7/residuals: the achievements' words in French
      .catch((error: unknown) => { throw error instanceof DelightError ? new HttpError(error.status, error.message) : error; });
  throw new HttpError(404, "Endpoint not found");
}
async function sessionApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  // Wave 6: conversations belong to whoever's profile is switched on, not always to the owner.
  const owner = app.store.profiles.scope();
  if (request.method === "POST" && path === "/api/sessions/search")
    return app.store.searchSessions(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/sessions/import")
    return app.store.importSession(owner, await readBody(request, archiveBodyLimit));
  const put = await conversationActions(app, request, path, owner);
  if (put !== undefined) return put;
  const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(export|duplicate|model|discard|skill|followups|memory-policy|summary|pins|tree|merge-note|context|cost))?$/.exec(path);
  // Wave 8: conversations branched off this one as a tree, and carrying one branch's answer back.
  if (match && match[2] === "tree" && request.method === "GET") return app.sessionTree.tree(owner, match[1]!);
  if (match && match[2] === "merge-note" && request.method === "POST")
    return app.sessionTree.mergeNote(owner, { sessionId: match[1]! });
  if (match && match[2] === "summary" && request.method === "GET") return app.store.sessionSummary(owner, match[1]!);
  // How full the next request of this conversation is (the meter under the message box, and /tokens).
  if (match && match[2] === "context" && request.method === "GET") {
    if (!app.store.ownsSession(owner, match[1]!)) throw new HttpError(404, "Session not found");
    return tokenReport(app.runtime, match[1]!, owner);
  }
  // DG-101: what the whole conversation probably cost, for the line under the message box.
  if (match && match[2] === "cost" && request.method === "GET") return conversationCost(app, owner, match[1]!);
  if (match && match[2] === "pins") {
    if (request.method === "GET") return { pins: app.store.sessionSummary(owner, match[1]!).pins };
    if (request.method === "POST") {
      const value = z.object({ messageId: z.number().int().positive(), pinned: z.boolean().default(true) }).strict().parse(await readBody(request));
      return app.store.pinMessage(owner, match[1]!, value.messageId, value.pinned);
    }
  }
  if (match && match[2] === "memory-policy") {
    if (!app.store.ownsSession(owner, match[1]!)) throw new HttpError(404, "Session not found");
    if (request.method === "GET") return { remember: !app.store.memorySuppressed(owner, match[1]!) };
    if (request.method === "POST") {
      const { remember } = z.object({ remember: z.boolean() }).strict().parse(await readBody(request));
      return { remember: !app.store.setMemorySuppressed(owner, match[1]!, !remember) };
    }
  }
  if (match && match[2] === "followups") {
    // bucket 19: only whoever the conversation belongs to may read or add its queued messages.
    if (!app.store.ownsSession(owner, match[1]!)) throw new HttpError(404, "Session not found");
    if (request.method === "GET") return { followUps: app.runtime.queued(match[1]!) };
    if (request.method === "POST") {
      const { prompt } = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict().parse(await readBody(request));
      return app.runtime.followUp(match[1]!, prompt, windowCaller(app).person ?? null);
    }
  }
  if (match && request.method === "GET" && !match[2]) {
    const person = app.store.profiles.active();
    const shared = person && app.trunks.rooms.forPerson(person.id).some((room) => room.sessionId === match[1]);
    const view = app.store.sessionView(shared ? app.runtime.owner : owner, match[1]!);
    // Dogfood D14: the project the conversation is filed under, so the window can say so; projects are the owner's.
    return app.store.profiles.isOwner() ? { ...view, project: app.store.sessionProject(match[1]!) ?? null } : view;
  }
  if (match && match[2] === "skill") {
    if (!app.store.ownsSession(owner, match[1]!)) throw new HttpError(404, "Session not found");
    const key = `pinned-skill:${match[1]}`;
    if (request.method === "POST") {
      const { skillId } = z.object({ skillId: z.string().uuid().nullable() }).strict().parse(await readBody(request));
      if (skillId && !app.store.skills.catalog(owner).some((s) => s.id === skillId)) throw new HttpError(400, "That skill is not enabled");
      if (skillId) app.store.save("settings", owner, key, { skillId }); else app.store.delete("settings", owner, key);
      return { skillId };
    }
    if (request.method === "GET") return { skillId: (app.store.get("settings", owner, key)?.data as { skillId?: string } | undefined)?.skillId ?? null };
  }
  if (match && match[2] === "model") {
    if (request.method === "POST")
      return app.runtime.models.configureSession(owner, match[1]!, await readBody(request));
    if (request.method === "GET") {
      if (!app.store.ownsSession(owner, match[1]!)) throw new HttpError(404, "Session not found");
      return { ...app.runtime.models.session(owner, match[1]!), effective: app.runtime.models.plan(owner, match[1]!).choice };
    }
  }
  if (match && request.method === "GET" && match[2] === "export") {
    audit(app.store, owner, { action: "data.exported", actor: owner, subject: `conversation ${match[1]!.slice(0, 8)}`,
      reason: "One conversation was written out as a file", outcome: "saved" });
    return app.store.exportSession(owner, match[1]!);
  }
  if (match && request.method === "POST" && match[2] === "discard") {
    z.object({}).strict().parse(await readBody(request));
    return app.store.discardSession(owner, match[1]!);
  }
  if (match && request.method === "POST" && match[2] === "duplicate") {
    z.object({}).strict().parse(await readBody(request));
    return app.store.duplicateSession(owner, match[1]!);
  }
  throw new HttpError(404, "Endpoint not found");
}
/**
 * Conversations, like iMessage (src/conversation-actions.ts): pin, rename, archive, delete into Recently Deleted,
 * restore, and delete for good. A person acts on their own conversations only (profiles.scope()); deleting for good
 * is refused through a door (src/caller-policy.ts hereOnlyRefusal) and to a short-lived key (it is not a task route).
 */
async function conversationActions(app: Branch, request: IncomingMessage, path: string, owner: string): Promise<unknown> {
  if (path === "/api/sessions/put-away") {
    if (request.method === "GET") return app.store.putAwayConversations(owner, Object.fromEntries(new URL(request.url ?? "/", "http://x").searchParams));
    return undefined;
  }
  if (path === "/api/sessions/put-away/empty" && request.method === "POST") {
    EmptySchema.parse(await readBody(request));
    return app.store.emptyRecentlyDeleted(owner);
  }
  const match = /^\/api\/sessions\/([a-f0-9-]{36})\/(pin|rename|archive|delete|restore|delete-now)$/.exec(path);
  if (!match) return undefined;
  const [, id, action] = match as unknown as [string, string, string];
  if (action === "delete-now" && request.method === "GET") return app.store.deleteNowPreview(owner, id);
  if (request.method !== "POST") return undefined;
  const body = await readBody(request);
  if (action === "pin") return app.store.pinConversation(owner, id, body);
  if (action === "rename") return app.store.renameConversation(owner, id, body);
  if (action === "archive") return app.store.archiveConversation(owner, id, body);
  EmptySchema.parse(body);
  if (action === "delete") return app.store.deleteConversation(owner, id);
  if (action === "restore") return app.store.restoreConversation(owner, id);
  return app.store.deleteConversationNow(owner, id);
}
/** Wave mac2 (goal-undo): both answer only for conversations of the profile that is switched on. */
async function goalUndoApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.store.profiles.scope(), method = request.method ?? "GET", body = () => readBody(request);
  const answer = path.endsWith("/goal") || path === "/api/goals" || path === "/api/goal-undo/settings"
    ? await goalApi(app.goals, (id) => app.store.ownsSession(owner, id), method, path, body)
    : await rewindApi(app.rewinds, owner, method, path, body);
  if (answer === undefined) throw new HttpError(404, "Endpoint not found");
  return answer;
}
async function historyApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const history = app.store.workspaceHistory;
  if (request.method === "GET" && path === "/api/history/files")
    return { versions: history.history(new URL(request.url ?? "/", "http://local").searchParams.get("path") ?? "") };
  if (request.method === "POST" && path === "/api/history/restore")
    return history.restore(z.object({ versionId: z.string().uuid() }).strict().parse(await readBody(request)).versionId, { anyScope: true });
  if (request.method === "GET" && path === "/api/history/snapshots") return { snapshots: history.snapshots() };
  if (request.method === "POST" && path === "/api/history/snapshots") return history.snapshot(await readBody(request));
  const restore = /^\/api\/history\/snapshots\/([a-f0-9-]{36})\/restore$/.exec(path);
  if (restore && request.method === "POST") return history.restoreSnapshot(restore[1]!);
  throw new HttpError(404, "Endpoint not found");
}
/**
 * Settings → Developer: the language servers and the debuggers the owner has on this computer.
 * Both are off until they say otherwise, and saving refuses a program that is not there.
 */
async function developerApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (path === "/api/developer/language-servers")
    return request.method === "POST"
      ? saveLanguageServerSettings(app.store, owner, await readBody(request))
      : languageServerSettings(app.store, owner);
  if (path === "/api/developer/debug-adapters")
    return request.method === "POST"
      ? saveDebugSettings(app.store, owner, await readBody(request))
      : debugSettings(app.store, owner);
  if (path === "/api/developer/running" && request.method === "GET")
    return { languageServers: app.languageServers.list(), services: app.openApiTools.list() };
  // bucket-18 (A0300): pull requests from a task's changes; off until the owner says otherwise.
  if (path === "/api/developer/pull-requests") {
    if (request.method !== "POST") return pullRequestHookSettings(app.store, owner);
    const hook = await readBody(request);
    return recordedWrite(app.store, owner, byCard("pull-request-hook"), ["pull-request-hook"],
      () => savePullRequestHookSettings(app.store, owner, hook));
  }
  throw new HttpError(404, "Endpoint not found");
}

async function memoryApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  // Wave 6: saved facts belong to whoever's profile is switched on, not always to the owner.
  const owner = app.store.profiles.scope();
  // bucket-18 (A2317): the history of what is remembered; the owner's switch and the versions so far.
  if (path === "/api/memory/history") {
    if (request.method !== "POST")
      return { ...app.memoryHistory.settings(app.runtime.owner), ...app.memoryHistory.status(app.runtime.owner), versions: await app.memoryHistory.versions(30) };
    const history = await readBody(request);
    return recordedWrite(app.store, app.runtime.owner, byCard("memory-history"), ["memory-history"],
      () => app.memoryHistory.configure(app.runtime.owner, history));
  }
  if (request.method === "GET" && path === "/api/memory/export") {
    audit(app.store, owner, { action: "data.exported", actor: owner, subject: "your saved notes",
      reason: "The facts the assistant remembers were written out", outcome: "saved" });
    return app.store.exportMemory(owner);
  }
  if (request.method === "POST" && path === "/api/memory/import") {
    const body = await readBody(request, maximumMemoryArchiveBytes);
    // Facts arrive either as the whole-archive file or as JSON Lines; the second kind is deduplicated.
    const lines = z.object({ jsonl: z.string().max(maximumImportBytes) }).strict().safeParse(body);
    return lines.success ? app.memory.transfer.import(owner, lines.data.jsonl) : app.store.importMemory(owner, body);
  }
  if (request.method === "POST" && path === "/api/memory/capacity")
    return app.store.configureMemory(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/memory/forget/preview") {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).strict().parse(await readBody(request));
    return app.memory.backend.forgetPreview(owner, sessionId); // FQ-memory.providers: wherever the facts were saved
  }
  if (request.method === "POST" && path === "/api/memory/forget")
    return app.memory.backend.forgetConversation(owner, await readBody(request));
  if (path === "/api/memory/retrieval") {
    if (request.method === "GET") return app.memory.retrieval.view(owner);
    if (request.method === "POST") return app.memory.retrieval.configure(owner, await readBody(request));
  }
  // FQ-memory.providers: where facts are kept — this computer's database, or an outside memory
  // service the owner has switched on instead. Reading and saving both go through the same object
  // that decides, at every call, which one actually answers `memory.put`/`memory.search`/etc.
  if (path === "/api/memory/provider") {
    if (request.method === "GET") return app.memory.backend.view(owner);
    if (request.method === "POST") return app.memory.backend.configure(owner, await readBody(request));
  }
  if (request.method === "POST" && path === "/api/memory/index") {
    z.object({}).strict().parse(await readBody(request));
    return app.memory.retrieval.index(owner);
  }
  if (request.method === "POST" && path === "/api/memory/search") {
    const { query, limit } = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).default(20) })
      .strict().parse(await readBody(request));
    return { results: await app.memory.retrieval.search(owner, query, undefined, limit) };
  }
  // "Tidy my memory" in one screen: the four checks together, and the same call with stage on.
  if (request.method === "GET" && path === "/api/memory/tidy/all") return app.memory.tidy.run(owner);
  if (request.method === "POST" && path === "/api/memory/tidy/all") return app.memory.tidy.run(owner, await readBody(request));
  if (request.method === "GET" && path === "/api/memory/health") return app.memory.tidy.health(owner);
  // Wave 9: what the assistant has noticed for itself, and turning it into suggestions. Looking
  // changes nothing at all; the second call only ever adds to the queue the owner decides on.
  if (request.method === "GET" && path === "/api/memory/learned") return { noticed: app.learning.notice(owner) };
  if (request.method === "POST" && path === "/api/memory/learned") {
    z.object({}).strict().parse(await readBody(request));
    return app.learning.propose(owner);
  }
  // Wave 9: what reading recent conversations again for fact cards would cost. Worked out here
  // with no model call at all, so the owner sees it before anything is sent anywhere. The reading
  // itself is POST /api/knowledge/refresh, which answers with the same reckoning afterwards.
  if (request.method === "GET" && path === "/api/memory/refresh") return app.knowledgeCards.cost(owner);
  const keep = /^\/api\/memory\/([^/]{1,200})\/keep$/.exec(path);
  if (request.method === "POST" && keep) return app.store.promoteMemory(owner, decodeURIComponent(keep[1]!));
  if (request.method === "GET" && path === "/api/memory/tidy") return app.memory.hygiene.review(owner);
  if (request.method === "POST" && path === "/api/memory/tidy") {
    z.object({}).strict().parse(await readBody(request));
    const { staged, review } = app.memory.hygiene.suggest(owner);
    return { suggested: staged.length, proposals: staged, review };
  }
  if (request.method === "POST" && path === "/api/memory/hygiene") return app.store.memoryHygiene(owner, await readBody(request));
  if (request.method === "GET" && path === "/api/memory/archive") return { archived: app.store.archivedMemory(owner), total: app.store.archivedMemoryCount(owner) };
  // Purge all: every archived fact removed for good, the owner's alone. The confirm step is the word and how
  // many archived facts the owner was shown; a count that no longer matches removes nothing.
  if (request.method === "POST" && path === "/api/memory/archive/purge") {
    app.store.profiles.requireOwner("Purging archived facts");
    const { count } = z.object({ confirm: z.literal("purge"), count: z.number().int().min(1).max(1_000_000) }).strict().parse(await readBody(request));
    return app.store.purgeArchivedMemory(owner, count);
  }
  // Seasons: "look over what happened" is the owner's night of Rings, run now (src/seasons/rings.ts).
  if (request.method === "POST" && path === "/api/memory/consolidate") return app.rings.night({ scope: app.runtime.owner, person: null });
  if (request.method === "GET" && path === "/api/memory/settings") return app.store.review.settings(owner);
  if (request.method === "POST" && path === "/api/memory/settings") return app.store.review.configure(owner, await readBody(request));
  if (request.method === "GET" && path === "/api/memory/proposals") return { proposals: app.store.review.proposals(owner) };
  // Batch 27 (wave 8): write the Markdown mirror of what is remembered by hand. It also writes
  // itself after every task, so this is for the owner who wants it now.
  if (request.method === "POST" && path === "/api/memory/mirror")
    return app.memoryMirror.regenerate(owner, await readBody(request));
  const decide = /^\/api\/memory\/proposals\/([a-f0-9-]{36})\/(accept|reject)$/.exec(path);
  if (decide && request.method === "POST") return app.store.review.decide(owner, decide[1]!, decide[2] === "accept");
  if (request.method === "GET" && path === "/api/memory/versions")
    return { versions: app.store.review.versions(owner, new URL(request.url ?? "/", "http://local").searchParams.get("id") ?? "") };
  if (request.method === "POST" && path === "/api/memory/versions/restore") {
    const body = z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive() }).strict().parse(await readBody(request));
    return app.store.review.restoreVersion(owner, body.id, body.revision);
  }
  if (request.method === "GET" && path === "/api/memory/checkpoints") return { checkpoints: app.store.review.checkpoints(owner) };
  if (request.method === "POST" && path === "/api/memory/checkpoints") return app.store.review.checkpoint(owner, await readBody(request));
  const restoreCheckpoint = /^\/api\/memory\/checkpoints\/([a-f0-9-]{36})\/restore$/.exec(path);
  if (restoreCheckpoint && request.method === "POST") return app.store.review.restoreCheckpoint(owner, restoreCheckpoint[1]!);
  const restore = /^\/api\/memory\/archive\/([^/]{1,200})\/restore$/.exec(path);
  if (restore && request.method === "POST") {
    z.object({}).strict().parse(await readBody(request));
    return app.store.restoreMemory(owner, decodeURIComponent(restore[1]!));
  }
  throw new HttpError(404, "Endpoint not found");
}
/**
 * App lock: whose records an open stream or socket may still carry. Once Branch locks with a PIN set
 * the answer is nobody's, so a stream opened before the lock ends there instead of flowing on.
 */
/** A kept file is this profile's when the task that made it is theirs, in a conversation they own. */
const ownArtifact = (app: Branch, scope: string, runId: string): boolean => {
  const run = app.store.run(runId);
  return !!run && run.owner === scope && app.store.ownsSession(scope, run.sessionId);
};
const scopeWhileUnlocked = (app: Branch): string => (app.sessionLock.refusal("GET", "/api/events/stream") ? "" : app.store.profiles.scope());
/** An App lock refusal answered with its own status (400, 403 or 429); anything else as it was. */
async function appLockAnswer(step: () => Promise<unknown>): Promise<unknown> {
  return step().catch((error: unknown) => {
    throw error instanceof AppLockRefusal ? new HttpError(error.status, error.message) : error;
  });
}
/** Locking the app, and the privacy checks on messages that leave this computer. */
async function guardApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  if (request.method === "GET" && path === "/api/lock") return app.sessionLock.state();
  if (request.method === "POST" && path === "/api/lock") return app.sessionLock.lock();
  // App lock: with a PIN set, unlocking asks for it; setting, changing or removing it is the owner's.
  // A wrong PIN is 403 and a wait 429, never 401, which the window reads as a wrong session key.
  if (request.method === "POST" && path === "/api/lock/unlock") return appLockAnswer(async () => app.sessionLock.unlock(await readBody(request)));
  if (request.method === "POST" && path === "/api/lock/pin") return appLockAnswer(async () => app.sessionLock.setPin(await readBody(request)));
  if (request.method === "POST" && path === "/api/lock/settings") return app.sessionLock.configure(await readBody(request));
  if (request.method === "GET" && path === "/api/privacy") return app.privacy.settings();
  if (request.method === "POST" && path === "/api/privacy") {
    // Turning a check down needs the owner's yes, and nothing changes under Lockdown (src/privacy-guard.ts).
    const { confirmLoosening, input } = withoutConfirm(await readBody(request));
    try { return app.privacy.configure(input, confirmLoosening, lockdownActive(app.store, app.runtime.owner)); }
    catch (error) { throw error instanceof PrivacyChangeRefused ? new HttpError(409, error.message) : error; }
  }
  throw new HttpError(404, "Endpoint not found");
}
/** Signing in to an outside service: the app opens the address this returns in the browser. */
async function connectionsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  if (request.method === "POST" && path === "/api/connections/oauth/start") {
    const started = await app.oauth.start(await readBody(request, 16 * 1024));
    // The flow finishes on its own when the service calls back; nothing here waits for it.
    app.oauth.waitFor(started.id).catch(() => undefined);
    return started;
  }
  const cancel = /^\/api\/connections\/oauth\/([a-z][a-z0-9-]{0,39})\/cancel$/.exec(path);
  if (cancel && request.method === "POST") {
    z.object({}).strict().parse(await readBody(request));
    await app.oauth.cancel(cancel[1]!);
    return { cancelled: cancel[1] };
  }
  // Batch 19 (wave 7): adding a model service from the catalog, checked before anything is saved.
  if (request.method === "POST" && path === "/api/connections/from-preset")
    return connectFromPreset(
      { models: app.runtime.models, locker: app.store.locker, owner: app.runtime.owner, policy: app.web.policy, store: app.store },
      await readBody(request, 16 * 1024),
    );
  // Taking one back out again: the model list, the written-down record and the key, all at once.
  if (request.method === "POST" && path === "/api/connections/forget") {
    const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(await readBody(request, 4 * 1024));
    const forgotten = await forgetConnection(
      { models: app.runtime.models, locker: app.store.locker, owner: app.runtime.owner, policy: app.web.policy, store: app.store },
      id,
    );
    forgetProgram(app.store, app.runtime.owner, id); // a coding assistant taken out stays out after a restart
    syncMixtures(app.store, app.runtime.owner, app.runtime.models); // a mixture that used it leaves the model picker
    return forgotten;
  }
  if (request.method === "GET" && path === "/api/connections/catalog")
    return { pricedAt: providerCatalog().pricedAt, services: catalogEntries() };
  const status = /^\/api\/connections\/oauth\/([a-z][a-z0-9-]{0,39})$/.exec(path);
  if (status && request.method === "GET") {
    const tokens = await app.oauth.saved(status[1]!);
    return { id: status[1], signedIn: tokens !== null, expiresAt: tokens?.expiresAt ?? null, scope: tokens?.scope ?? null };
  }
  throw new HttpError(404, "Endpoint not found");
}
async function schedulesApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  // Batch 20 (wave 8): adding, listing and removing a schedule over the local API, so `branch
  // schedule` works against the engine already running rather than starting a second one.
  if (path === "/api/schedules" || path === "/api/schedules/") {
    app.store.profiles.requireOwner("Your schedules");
    if (request.method === "GET") return { schedules: app.store.list("schedules", owner) };
    if (request.method === "POST") return app.scheduler.create(scheduleContext(app), await readBody(request));
    throw new HttpError(404, "Endpoint not found");
  }
  // Words to a schedule (src/schedule-words.ts): a proposal only, which the owner confirms with POST /api/schedules.
  if (path === "/api/schedules/propose" && request.method === "POST") {
    app.store.profiles.requireOwner("Your schedules");
    const proposal = await proposeSchedule(await readBody(request), { now: new Date(),
      defaultTimezone: ownerTimezone(app.store, owner), askModel: (question, shape) => askAside(app, question, shape) });
    // Dogfood: the card shows what the schedule may use, the least its words need, and saving keeps exactly that.
    const permissions = leastPermissions(proposal.schedule.prompt, [...scheduleContext(app).permissions]);
    return { proposal: { ...proposal, schedule: { ...proposal.schedule, permissions }, reach: reachWords(permissions) } };
  }
  const match = /^\/api\/schedules\/([a-f0-9-]{36})(?:\/(trigger|remove))?$/.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found");
  const record = app.store.get("schedules", owner, match[1]!);
  if (!record) throw new HttpError(404, "Schedule not found");
  if (request.method === "GET" && !match[2]) return { ...record, hookPath: record.data.hookToken ? `/hooks/${record.id}` : null };
  if (request.method === "POST" && match[2] === "trigger") {
    z.object({}).strict().parse(await readBody(request));
    return app.scheduler.trigger(owner, record.id, undefined, "local", triggerSlot(request));
  }
  if (request.method === "POST" && match[2] === "remove") {
    z.object({}).strict().parse(await readBody(request));
    return app.scheduler.remove(scheduleContext(app), record.id);
  }
  throw new HttpError(404, "Endpoint not found");
}
/**
 * One question to the model in use, with no tools and a fixed answer shape, for words the engine cannot
 * read itself. It is asked under a task of its own, kept like the morning brief's, so what it spent
 * counts in the owner's usage and spending limits like any other model call.
 */
async function askAside(app: Branch, question: string, shape: AnswerShape, title = "Reading a schedule from your words"): Promise<ShapedAnswer> {
  const run = app.store.createRun(app.runtime.owner, title, undefined, false, "owner");
  // overview: the engine's own task, set aside in GET /api/state; fix399: and its conversation kept out of Recent.
  app.store.markAside(run.id, { recent: false });
  let answer: ShapedAnswer | undefined;
  try {
    const context = app.runtime.context({ runId: run.id, permissions: [], signal: AbortSignal.timeout(60_000) });
    answer = await app.runtime.shaped(run, context, question, shape);
    return answer;
  } finally {
    app.store.finish(run.id, answer?.status === "resolved" ? "completed" : "failed", answer?.status === "refused" ? answer.reason : "");
  }
}
/** The owner's own hands, for a schedule they are adding or removing from the command line. */
function scheduleContext(app: Branch) {
  return app.runtime.context({ signal: AbortSignal.timeout(30000), source: "owner" });
}
/** Webhook triggers carry their own per-schedule token instead of the session token. */
async function hook(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const match = /^\/hooks\/([a-f0-9-]{36})$/.exec(path);
  if (!match || request.method !== "POST") throw new HttpError(404, "Endpoint not found");
  const record = app.store.get("schedules", app.runtime.owner, match[1]!);
  const expected = typeof record?.data.hookToken === "string" ? record.data.hookToken : "";
  const supplied = String(request.headers["x-branch-hook-token"] ?? "");
  const same = expected.length > 0 && supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!record || !same) throw new HttpError(401, "Hook token rejected");
  const payload = await readBody(request, 16 * 1024).catch(() => ({}));
  const run = await app.scheduler.trigger(app.runtime.owner, record.id, payload, "webhook", triggerSlot(request));
  return { runId: run.id, status: run.status };
}
/** The caller's Idempotency-Key, when it sent one: the same key starts a schedule once (src/scheduler.ts). */
function triggerSlot(request: IncomingMessage): string | null {
  const header = request.headers["idempotency-key"];
  const value = String((Array.isArray(header) ? header[0] : header) ?? "").trim();
  if (!value) return null;
  if (!/^[!-~]{1,200}$/.test(value)) throw new HttpError(400, "Idempotency-Key must be 1 to 200 printable characters");
  return value;
}
/**
 * WhatsApp sends messages to this address instead of holding a connection open, so the route has
 * to work without the app's session token. WhatsApp checks the address once with a challenge it
 * expects echoed back as plain text, and signs every later request with the app secret.
 */
async function whatsAppWebhook(app: Branch, request: IncomingMessage, response: ServerResponse, path: string,
  limiter: AuthLimiter, beyond: () => boolean): Promise<boolean> {
  const match = /^\/webhooks\/whatsapp\/([a-z][a-z0-9_-]{0,29})(?:\/([a-f0-9]{32}))?$/.exec(path);
  if (!match) return false;
  // mac7/channel-leaks: this address carries no key either, so a place that keeps posting rubbish
  // to it is made to wait, exactly as the chat address's callers are.
  // The random word on the end of the address is what makes it unguessable. Checked before the
  // channel is even looked up, so a wrong address tells nobody which names exist.
  const verdict = webhookAddressVerdict(app.store, app.runtime.owner, match[1]!, match[2],
    widerThanThisComputer(request, beyond));
  const limit = chatWebhookLimit(request, limiter, "whatsapp", match[1]!, verdict);
  if (verdict === "refused") return refuseWebhookAddress(app, request, response, limit, true);
  const adapter = app.channels.adapter(match[1]!);
  if (!(adapter instanceof WhatsAppAdapter)) {
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(404, "No WhatsApp channel with that name is connected");
  }
  if (request.method === "GET") {
    let challenge: string;
    try { challenge = adapter.verify(new URL(request.url ?? "/", "http://127.0.0.1").searchParams); }
    catch (error) {
      if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
      throw new HttpError(403, errorText(error));
    }
    limiter.succeed(limit.from);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(challenge);
    return true;
  }
  if (request.method !== "POST") {
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(404, "Endpoint not found");
  }
  const read = await readBodyWithRaw(request, 256 * 1024).catch(() => undefined);
  if (!read) {
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(400, "That message could not be read");
  }
  const result = await adapter.receive(read.raw, typeof request.headers["x-hub-signature-256"] === "string"
    ? request.headers["x-hub-signature-256"] : undefined)
    .catch((error: unknown) => { throw refusedChatPost(app, match[1]!, "whatsapp", error, limit); });
  limiter.succeed(limit.from);
  send(response, 200, result);
  return true;
}
/**
 * The one address every other chat service posts to. Which signature has to be there, and what the
 * post looks like inside, comes from that service's row in `data/channels.json`; this route only
 * hands over the exact bytes and the headers. Like the WhatsApp route it carries no session key,
 * so the signature check is the only thing letting a post through.
 */
async function chatWebhook(app: Branch, request: IncomingMessage, response: ServerResponse, path: string,
  limiter: AuthLimiter, beyond: () => boolean): Promise<boolean> {
  const match = /^\/webhooks\/chat\/([a-z][a-z0-9_-]{0,29})(?:\/([a-f0-9]{32}))?$/.exec(path);
  if (!match) return false;
  // Nothing here carries the session key, so a place that keeps posting rubbish is made to wait,
  // exactly as somewhere guessing the key is. That also keeps a flood off the record of refusals.
  // The random word on the end of the address is what makes it unguessable. Checked before the
  // channel is even looked up, so a wrong address tells nobody which channel names exist.
  const verdict = webhookAddressVerdict(app.store, app.runtime.owner, match[1]!, match[2],
    widerThanThisComputer(request, beyond));
  // mac7/channel-leaks: everything below asks `limit.proven` before it says anything at all. A
  // caller who has shown the word on the end holds a secret only this computer and the chat service
  // have, so it is worth telling them what is wrong; a caller who has not gets one sentence,
  // whether the name is connected, misspelt or was never used by anybody.
  const limit = chatWebhookLimit(request, limiter, "chat", match[1]!, verdict);
  if (verdict === "refused") return refuseWebhookAddress(app, request, response, limit, true);
  const adapter = app.channels.adapter(match[1]!);
  if (adapter instanceof MetaMessagingAdapter) return metaWebhook(app, adapter, request, response, limit);
  // mac6/bucket-16: WeChat and WeCom check the address with a GET and sign XML posts in the query.
  if (isSignedQueryChannel(adapter)) return signedQueryWebhook(app, adapter, request, response, limit);
  // Wave mac3 (channels-parity): services that are posted to and prove the post in their own way.
  if (isPostedChannel(adapter)) return postedChatWebhook(app, adapter, request, response, limit);
  if (!(adapter instanceof WebhookChatAdapter)) {
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(404, "No chat service with that name is connected");
  }
  if (request.method !== "POST") {
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(404, "Endpoint not found");
  }
  const read = await readBodyWithRaw(request, 256 * 1024).catch(() => undefined);
  if (!read) {
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(400, "That message could not be read");
  }
  const result = await adapter.receive(read.raw, request.headers)
    .catch((error: unknown) => { throw refusedChatPost(app, match[1]!, adapter.kind, error, limit); });
  limiter.succeed(limit.from);
  // Some services will not send anything until the address echoes a word back once.
  send(response, 200, result.challenge === undefined ? { accepted: result.accepted } : { challenge: result.challenge });
  return true;
}
/**
 * mac7/channel-leaks: the one answer at a webhook address, and the only one a caller who has not
 * shown the word on the end ever gets.
 *
 * The body is read and thrown away first, to the same limit a post that is taken seriously is read
 * to, so a name nobody has connected is not answered sooner than one that is: a quicker "no such
 * thing" is still an answer. The try is counted, so a place working through channel names is made
 * to wait. Nothing is written into the owner's record here — the address was never proved, and
 * anybody at all could otherwise fill that record with names they made up.
 */
async function refuseWebhookAddress(app: Branch, request: IncomingMessage, response: ServerResponse,
  limit: ChatWebhookLimit, wrongAddress = false): Promise<true> {
  await readBodyWithRaw(request, 256 * 1024).catch(() => undefined);
  noteWrongWebhook(app, limit, "a webhook address");
  // mac7/lockout: the wait is read here, after the address was found to be wrong, and never before.
  // A caller that has shown the word on the end of the address never reaches this line at all, so
  // no wait can ever turn away a correctly addressed post — which is the whole point of counting
  // each service separately. A caller that has not is told it is waiting, in the same words for
  // every name, only once its own wrong tries have earned that.
  const waiting = wrongAddress ? limit.limiter.waitMs(limit.from) : 0;
  if (waiting > 0) send(response, 429, { error: `${wrongWebhookAddress}. Wait ${Math.ceil(waiting / 60000)} minute(s).` });
  else send(response, 404, { error: wrongWebhookAddress });
  return true;
}
/**
 * mac7/lockout: who this post is counted as. The place it came from AND the service its address
 * names, so a chat service retrying an address the owner has replaced slows only itself down.
 * See `webhookLimitKey` in src/auth-limits.ts for why neither half can be forged.
 */
function chatWebhookLimit(request: IncomingMessage, limiter: AuthLimiter, kind: string, channel: string,
  verdict: ReturnType<typeof webhookAddressVerdict>): ChatWebhookLimit {
  const proven = verdict === "proven";
  const source = requestSource(request.socket?.remoteAddress, request.headers);
  return { limiter, from: webhookLimitKey(source, kind, channel, proven), proven, channel };
}
/**
 * mac7/lockout: the old shape of address — no word on the end at all — is refused outright once
 * the webhook door is carrying the internet, exactly as it is once Branch listens beyond this
 * computer. Both are the same fact: an address anybody can find by guessing the name is worth less
 * than the convenience the moment strangers can reach it. Keeping the grace loopback-only is also
 * what makes it safe never to turn an old-shape post away for waiting (see `refuseWebhookAddress`).
 */
function widerThanThisComputer(request: IncomingMessage, beyond: () => boolean): boolean {
  return beyond() || requestSource(request.socket?.remoteAddress, request.headers) === tunnelSource;
}
/**
 * One wrong try at a webhook address, counted, and — when it starts a wait — written where the
 * owner will see it: a line in the record of refusals naming the service, and a note on that
 * service's own row on the Connections card. A service being turned away for five minutes at a
 * time used to be completely silent; the owner only saw their messages stop.
 */
function noteWrongWebhook(app: Branch, limit: ChatWebhookLimit, what: string): void {
  const now = Date.now();
  const state = noteAuthFailure(limit.limiter, app.store, app.runtime.owner, limit.from, what, now, {
    actor: `posts to the ${limit.channel} address`,
    subject: `${what} for ${limit.channel}`,
  });
  if (state.until) noteWebhookWait(app.store, app.runtime.owner, limit.channel, state.until, limit.proven, now);
}
/** Wave mac3 (channels-parity): hands the exact bytes to a service that checks its own signature. */
async function postedChatWebhook(app: Branch, adapter: ChannelAdapter & PostedChannel, request: IncomingMessage, response: ServerResponse, limit: ChatWebhookLimit): Promise<boolean> {
  if (request.method !== "POST" || adapter.accepting?.() === false) {
    // Whether a service is switched off in Customize is state, so it is only said to a caller who
    // has shown the word on the end of the address.
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(request.method === "POST" ? 503 : 404,
      request.method === "POST" ? "That chat service is switched off in Customize" : "Endpoint not found");
  }
  const { raw } = await readBodyWithRaw(request, 256 * 1024).catch(() => { throw new HttpError(400, "That message could not be read"); });
  const result = await adapter.receivePost(raw, request.headers)
    .catch((error: unknown) => { throw refusedChatPost(app, adapter.id, adapter.kind, error, limit); });
  limit.limiter.succeed(limit.from);
  send(response, 200, result.reply ?? { accepted: result.accepted });
  return true;
}
/** mac6/bucket-16: hands a WeChat or WeCom request over whole and answers with the plain text it returns. */
async function signedQueryWebhook(app: Branch, adapter: ChannelAdapter & SignedQueryChannel, request: IncomingMessage, response: ServerResponse, limit: ChatWebhookLimit): Promise<boolean> {
  if ((request.method !== "POST" && request.method !== "GET") || adapter.accepting?.() === false) {
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(adapter.accepting?.() === false ? 503 : 404,
      adapter.accepting?.() === false ? "That chat service is switched off in Customize" : "Endpoint not found");
  }
  const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
  const raw = request.method === "POST"
    ? await readRawBody(request, wechatXmlLimit).catch((error: unknown) => { throw new HttpError(/exceeds/.test(errorText(error)) ? 413 : 400, "That message could not be read"); })
    : Buffer.alloc(0);
  const text = await adapter.receiveSigned(request.method, query, raw)
    .catch((error: unknown) => { throw refusedChatPost(app, adapter.id, adapter.kind, error, limit); });
  limit.limiter.succeed(limit.from);
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end(text);
  return true;
}
/**
 * Where a post came from, so repeated refusals from one place can be counted and slowed down, and
 * whether the caller showed the word on the end of the address — which decides whether they are
 * told anything beyond the one sentence.
 */
interface ChatWebhookLimit {
  limiter: AuthLimiter; from: string; proven: boolean;
  /** The service the address named, for the line the owner reads and for the Connections card. */
  channel: string;
}
/** A post that did not prove it came from the service is refused, and the refusal is written down. */
function refusedChatPost(app: Branch, channel: string, kind: string, error: unknown, limit: ChatWebhookLimit): HttpError {
  // mac7/lockout: read before this try is counted, so a run of wrong signatures is answered exactly
  // as it was before each service got its own count. A correctly signed post never reaches this
  // function at all, so no wait here can ever turn one away.
  const waiting = limit.limiter.refusal(limit.from, "signature");
  // The post itself is never written down: it was not proved genuine, so nothing inside it is kept.
  noteWrongWebhook(app, limit, "a chat service's signature");
  // mac7/channel-leaks: a caller who never showed the word on the end of the address is told the
  // one sentence and leaves no row behind. The service's own words — "not signed by Slack", "no
  // shared secret is saved", "too old" — name the service and say whether it is set up, and the
  // record of refusals is the owner's, not something anybody on the network may fill.
  if (!limit.proven) return new HttpError(404, wrongWebhookAddress);
  audit(app.store, app.runtime.owner, {
    action: "auth.refused", actor: `the ${kind} connection`, subject: `/webhooks/chat/${channel}`, source: "system",
    reason: "A message arrived claiming to come from that chat service, but it was not proved to have come from it",
    outcome: "refused",
  });
  // A caller that has shown the word on the end is counted in an entry of its own, which nobody
  // without the word can reach, so saying it is waiting cannot tell a stranger the name is real.
  return new HttpError(waiting ? 429 : 401, waiting ?? errorText(error));
}
/** Messenger and Instagram answer Meta's one-off check and sign every later post, as WhatsApp does. */
async function metaWebhook(app: Branch, adapter: MetaMessagingAdapter, request: IncomingMessage, response: ServerResponse, limit: ChatWebhookLimit): Promise<boolean> {
  if (request.method === "GET") {
    let challenge: string;
    try { challenge = adapter.verify(new URL(request.url ?? "/", "http://127.0.0.1").searchParams); }
    catch (error) {
      if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
      throw new HttpError(403, errorText(error));
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(challenge);
    return true;
  }
  if (request.method !== "POST") {
    if (!limit.proven) return refuseWebhookAddress(app, request, response, limit);
    throw new HttpError(404, "Endpoint not found");
  }
  const { raw } = await readBodyWithRaw(request, 256 * 1024).catch(() => { throw new HttpError(400, "That message could not be read"); });
  const signature = request.headers["x-hub-signature-256"];
  const result = await adapter.receive(raw, typeof signature === "string" ? signature : undefined)
    .catch((error: unknown) => { throw refusedChatPost(app, adapter.id, adapter.kind, error, limit); });
  limit.limiter.succeed(limit.from);
  send(response, 200, result);
  return true;
}
const triggerBodyLimit = 256 * 1024;
/**
 * mac7/channel-leaks: the one answer a caller who has not proved a trigger gets. The route used to
 * say "Trigger not found" for an id nobody had made and "Invalid secret", "Missing signature",
 * "Invalid signature algorithm", "timestamp too old" or "nonce reused" for one that existed, all
 * before any key was checked — so the ids the owner really has could be found by trying them.
 */
const triggerRefused = "That request was not accepted";
/** A trigger that is not on the list, so an id nobody made is still checked rather than skipped. */
const decoyTrigger: TriggerState = {
  id: "", name: "", prompt: "", enabled: false, rateLimitPerMinute: 1, replayProtection: false,
  replayWindowSeconds: 300, secret: randomBytes(32).toString("hex"),
  createdAt: "", updatedAt: "",
};
async function triggerFire(app: Branch, request: IncomingMessage, triggerId: string, limit: ChatWebhookLimit): Promise<unknown> {
  const trigger = app.triggers.get(app.runtime.owner, triggerId);
  if (Number(request.headers["content-length"] ?? 0) > triggerBodyLimit)
    throw new HttpError(413, `Request exceeds ${triggerBodyLimit / 1024} KiB`);

  const { raw, parsed } = await readBodyWithRaw(request, triggerBodyLimit).catch((error: unknown) => {
    const message = errorText(error);
    throw new HttpError(message.includes("exceeds") ? 413 : 400, message);
  });

  // A trigger that was never made is checked against a secret that belongs to nothing, so the work
  // done and the answer given are the same as for one that exists but was not proved. A copied
  // request cannot be sent again either: when the owner asked for it, the timestamp must be fresh
  // and the nonce one nobody has used before.
  const against = trigger ?? { ...decoyTrigger, id: triggerId };
  const verified = app.triggers.verify(against, request.headers, raw);
  const fresh = verified.valid ? app.triggers.checkFreshness(against, request.headers) : { valid: false };
  if (!trigger || !verified.valid || !fresh.valid) {
    // mac7/lockout: the wait is read only once this caller's own secret has been found wrong, so a
    // caller holding the right secret clears its wait rather than being held by it.
    const waiting = limit.limiter.waitMs(limit.from);
    noteAuthFailure(limit.limiter, app.store, app.runtime.owner, limit.from, "a trigger's secret", Date.now(),
      { actor: `posts to trigger ${limit.channel}`, subject: `a trigger's secret for ${limit.channel}` });
    throw new HttpError(waiting > 0 ? 429 : 401, triggerRefused);
  }
  limit.limiter.succeed(limit.from);

  return app.triggers.fire(app.runtime.owner, triggerId, parsed).catch((error: unknown) => {
    const message = errorText(error);
    if (message.includes("disabled")) throw new HttpError(403, message);
    if (message.includes("Rate limit")) throw new HttpError(429, message);
    throw error;
  });
}
/**
 * A trigger's secret starts a task from anywhere, and a webhook's signs what is sent in Branch's name, so neither is
 * handed through a door: a phone would keep it after it is removed (src/remote/window-key.ts). The rest is as before.
 */
function withoutSecretToADoor(request: IncomingMessage, answer: unknown): unknown {
  if (!throughADoor(request)) return answer;
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([name]) => name !== "secret").map(([name, each]) => [name, strip(each)]));
  };
  return strip(answer);
}
async function triggersApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  const context = app.runtime.context();

  if (request.method === "GET" && path === "/api/triggers")
    return { triggers: app.triggers.list(owner) };

  if (request.method === "POST" && path === "/api/triggers")
    return app.triggers.create(context, await readBody(request));

  // finish-soon-a: words to a trigger (src/trigger-words.ts), a proposal only; the owner confirms it with POST /api/triggers
  // or, for work after one of their tasks, POST /api/autonomy/procedures.
  if (request.method === "POST" && path === "/api/triggers/propose") {
    app.store.profiles.requireOwner("Your triggers");
    if (!app.runtime.models.configured) throw new HttpError(400, noModelWords); // words to a trigger need the model
    return { proposal: await proposeTrigger(await readBody(request), (question, shape) => askAside(app, question, shape, "Reading a trigger from your words")) };
  }

  const match = /^\/api\/triggers\/([a-f0-9-]{36})(?:\/(log|rotate-secret|enabled|remove))?$/.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found");

  const trigger = app.triggers.get(owner, match[1]!);
  if (!trigger) throw new HttpError(404, "Trigger not found");

  if (request.method === "GET" && !match[2])
    return trigger;

  if (request.method === "GET" && match[2] === "log")
    return { log: app.triggers.getLog(match[1]!, owner) };

  if (request.method === "POST" && match[2] === "rotate-secret") {
    z.object({}).strict().parse(await readBody(request));
    const secret = app.triggers.rotateSecret(owner, match[1]!);
    return { secret };
  }

  if (request.method === "POST" && match[2] === "enabled") {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await readBody(request));
    // A trigger switched back on keeps working after the phone that did it is removed (src/remote/window-key.ts).
    if (enabled && throughADoor(request)) throw new HttpError(403, hereOnly);
    return app.triggers.setEnabled(owner, match[1]!, enabled);
  }

  if (["POST", "DELETE"].includes(request.method ?? "") && match[2] === "remove") {
    app.triggers.remove(owner, match[1]!);
    return { removed: true };
  }

  throw new HttpError(404, "Endpoint not found");
}
async function webhooksApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  const context = app.runtime.context();

  if (request.method === "GET" && path === "/api/webhooks")
    return { webhooks: app.webhooks.list(owner) };

  if (request.method === "POST" && path === "/api/webhooks")
    return app.webhooks.create(context, await readBody(request));

  const match = /^\/api\/webhooks\/([a-f0-9-]{36})(?:\/(log|test|remove|enable|preview))?$/.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found");

  const webhook = app.webhooks.get(owner, match[1]!);
  if (!webhook) throw new HttpError(404, "Webhook not found");

  if (request.method === "GET" && !match[2])
    return webhook;

  if (request.method === "GET" && match[2] === "log")
    return { log: app.webhooks.getLog(match[1]!, owner) };

  if (request.method === "POST" && match[2] === "test") {
    z.object({}).strict().parse(await readBody(request));
    return app.webhooks.test(owner, match[1]!);
  }

  if (["POST", "DELETE"].includes(request.method ?? "") && match[2] === "remove") {
    app.webhooks.remove(owner, match[1]!);
    return { removed: true };
  }

  // The shape editor in Settings: what one event would be sent as, without sending anything.
  if (request.method === "POST" && match[2] === "preview") {
    const body = z.object({ event: z.string().min(1).max(50), sample: z.record(z.string().max(60), z.unknown()).default({}) })
      .strict().parse(await readBody(request));
    return app.webhooks.preview(owner, match[1]!, body.event, body.sample);
  }

  if (request.method === "POST" && match[2] === "enable") {
    z.object({}).strict().parse(await readBody(request));
    return app.webhooks.enable(owner, match[1]!);
  }

  throw new HttpError(404, "Endpoint not found");
}
async function channelsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  // mac7/channels-owner: the chats are the owner's, so the whole of /api/channels is theirs.
  //
  // Until now only `/api/channels/permissions` asked who was there (the check inside
  // `saveChatPermissionSettings`). Everything else — the live switches, the parity switches, the
  // pairing approvals and removals, the link to a conversation, a test message, the webhook
  // addresses and their rotation — was open to anybody signed in on this computer under their own
  // profile. A household person could approve their own pairing code, point a chat at a
  // conversation, or read the secret address each chat service posts to.
  //
  // The check is here, once, before the routes rather than on each of them, so a route added
  // tomorrow is the owner's without anybody having to remember. The reads are the owner's too: the
  // summary carries their pairings and chats, the addresses carry a secret, and the waiting Slack
  // events carry message text. The catalogue of supported services holds no secret and is guarded
  // with the rest on purpose — one exception here is how the next one gets written.
  //
  // This does not change what the owner or the app window can do, and it is not on the path a chat
  // service posts in on (`/webhooks/...`, answered further up with its own unguessable word), so
  // pairing, the setup cards and the parity checks work exactly as before.
  app.store.profiles.requireOwner("Your chat apps");
  const owner = app.runtime.owner;
  if (path === "/api/channels/formatting") {
    if (request.method === "GET") return { formats: channelFormats(app.store, owner) };
    if (request.method !== "POST") throw new HttpError(405, "Use GET or POST here.");
    try { return { formats: saveChannelFormatting(app.store, owner, await readBody(request), setupIds()) }; }
    catch (error) { throw new HttpError(400, errorText(error)); }
  }
  // Settings › Chat apps › Replies in each app: quoting the person's message, and the reaction on it (src/channels/reply-style.ts).
  if (path === "/api/channels/reply-style") {
    if (request.method === "GET") return { styles: replyStyles(app.store, owner) };
    if (request.method !== "POST") throw new HttpError(405, "Use GET or POST here.");
    try { return { styles: saveReplyStyle(app.store, owner, await readBody(request), setupIds()) }; }
    catch (error) { throw new HttpError(400, errorText(error)); }
  }
  // Wave mac3 (channels-parity): the list of added chat services and their off / on / when-needed switches.
  if (path === "/api/channels/parity")
    return parityApi(app.store, owner, app.channels, request.method ?? "GET", request.method === "POST" ? await readBody(request) : undefined);
  if (request.method === "GET" && path === "/api/channels") return { ...app.channels.summary(), outstanding: app.channels.outstanding() };
  // mac6/bucket-16: automations started by Slack's own events, and starting one that is waiting.
  if (path === "/api/channels/slack-automations") return request.method === "POST"
    ? saveSlackAutomations(app.store, owner, await readBody(request), (id) => !!app.triggers.get(owner, id))
    : app.slackAutomations.list();
  if (request.method === "POST" && path === "/api/channels/slack-automations/run") return app.slackAutomations.run(await readBody(request));
  // The chat services this copy knows how to talk to, so the Connections card lists them from data
  // rather than from a piece of hand-written page per service. No secret is involved either way.
  if (request.method === "GET" && path === "/api/channels/catalog")
    return { services: channelEntries().map((entry) => ({
      id: entry.id, name: entry.name, docs: entry.docs, needs: entry.needs, note: entry.note,
      can: entry.can, maxTextLength: entry.maxTextLength, canReceive: entry.receive !== null,
    })) };
  const retry = /^\/api\/channels\/deliveries\/([^/]{1,220})\/retry$/.exec(path);
  if (request.method === "POST" && retry) return app.channels.retryDelivery(decodeURIComponent(retry[1]!));
  if (request.method === "POST" && path === "/api/channels/pairings/approve") {
    const { firstOwner, pin, ...code } = z.object({ code: z.unknown(), firstOwner: z.boolean().optional(), pin: z.string().max(64).optional() })
      .strict().parse(await readBody(request));
    // owner-dm-signin: naming the sender as the owner's own account is guarded as "Commands from your own chat" is below:
    // the window on this computer, unlocked, with the PIN where one is set. A plain approval is unchanged.
    if (firstOwner) {
      if (throughDoor(request)) throw new HttpError(403, "Your own chat account is named in Branch's window on this computer.");
      if (app.sessionLock.locked()) throw new HttpError(423, "Unlock Branch before naming your own chat account.");
      if (app.sessionLock.pinSet()) await appLockAnswer(async () => app.sessionLock.unlock({ pin }));
    }
    return app.channels.approve(owner, code, { firstOwner: firstOwner === true });
  }
  if (request.method === "POST" && path === "/api/channels/link") return app.channels.link(owner, await readBody(request));
  // Wave mac2 (chat-live): the on / off / when-needed switches for typing, commands, steering and splitting.
  if (request.method === "POST" && path === "/api/channels/live") return { live: app.channels.setSwitches(await readBody(request)) };
  // Settings › Chat apps › Show steps in chats: detail, grouping, line length, commands, long lists, tidying up, apps
  // that cannot edit and groups, for every app and for each one (src/channels/steps-display.ts).
  if (path === "/api/channels/steps") {
    if (request.method === "GET") return { steps: app.channels.stepsView() };
    if (request.method !== "POST") throw new HttpError(405, "Use GET or POST here.");
    app.channels.setStepsSettings(await readBody(request));
    return { steps: app.channels.stepsView() };
  }
  if (request.method === "POST" && path === "/api/channels/owner-commands") {
    if (throughDoor(request)) throw new HttpError(403, "Commands from your own chat are enabled in Branch's window on this computer.");
    if (app.sessionLock.locked()) throw new HttpError(423, "Unlock Branch before changing commands from your own chat.");
    const { pin, ...settings } = z.object({ pin: z.string().max(64).optional(), on: z.boolean(),
      accounts: z.array(z.object({ channel: z.string(), sender: z.string() }).strict()).max(10) }).strict().parse(await readBody(request));
    // Re-authenticate even an unlocked window whenever a PIN is set. Wrong attempts share the lock's backoff.
    if (app.sessionLock.pinSet()) await appLockAnswer(async () => app.sessionLock.unlock({ pin }));
    return { ownerCommands: app.channels.setOwnerCommandSettings(settings) };
  }
  // Settings › Chat apps: what the Trunk sees and staying connected (src/channels/intake-settings.ts).
  if (path === "/api/channels/intake") {
    if (request.method === "GET") return { intake: readChatIntake(app.store, owner) };
    if (request.method !== "POST") throw new HttpError(405, "Use GET or POST here.");
    const before = readChatIntake(app.store, owner).presence, intake = saveChatIntake(app.store, owner, await readBody(request));
    if (intake.presence !== before) await app.channels.presenceChanged(intake.presence);
    return { intake };
  }
  // mac7/chat-allowlist: the switch and the list for what a chat's task may use beyond talking.
  if (request.method === "POST" && path === "/api/channels/permissions") {
    const permissions = await readBody(request);
    return { permissions: recordedWrite(app.store, app.runtime.owner, byCard("chat-permissions"), ["chat-permissions"],
      () => app.channels.setPermissionSettings(permissions)) };
  }
  if (request.method === "POST" && path === "/api/channels/test") {
    const { channel, chatId } = z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict().parse(await readBody(request));
    return app.channels.deliver(channel, chatId, "Test message from Branch Agent: this channel is connected and working.", `test:${Date.now()}`);
  }
  if (request.method === "POST" && path === "/api/channels/pairings/remove") return app.channels.remove(owner, await readBody(request));
  // Batch 20 (wave 8): the address each chat service posts to, with its own unguessable word on the
  // end. Shown on the Connections card with a button that copies it, and rotatable.
  if (request.method === "GET" && path === "/api/channels/addresses") return channelAddresses(app, owner);
  if (request.method === "POST" && path === "/api/channels/addresses/rotate") {
    const { channel } = z.object({ channel: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/) }).strict().parse(await readBody(request));
    rotateWebhookSecret(app.store, owner, channel);
    return channelAddresses(app, owner);
  }
  if (request.method === "POST" && path === "/api/channels/addresses/settings")
    return { ...channelAddresses(app, owner), settings: saveWebhookAddressSettings(app.store, owner, await readBody(request)) };
  throw new HttpError(404, "Endpoint not found");
}
/** Every connected channel that is posted to, with the whole address to paste into that service. */
function channelAddresses(app: Branch, owner: string): {
  addresses: { channel: string; kind: string; address: string }[];
  settings: ReturnType<typeof webhookAddressSettings>;
  /** mac7/lockout: services whose posts are being turned away, so the card can say so. */
  waits: ReturnType<typeof webhookWaits>;
} {
  const addresses = app.channels.summary().channels
    .filter((channel) => channel.kind === "whatsapp" || app.channels.adapter(channel.id) instanceof WebhookChatAdapter
      || app.channels.adapter(channel.id) instanceof MetaMessagingAdapter || isPostedChannel(app.channels.adapter(channel.id))
      || isSignedQueryChannel(app.channels.adapter(channel.id)))
    .map((channel) => ({
      channel: channel.id, kind: channel.kind,
      address: webhookAddress(channel.kind === "whatsapp" ? "whatsapp" : "chat", channel.id,
        webhookSecret(app.store, owner, channel.id)),
    }));
  return { addresses, settings: webhookAddressSettings(app.store, owner), waits: webhookWaits(app.store, owner) };
}
async function chatgptApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const auth = app.chatgpt, owner = app.runtime.owner;
  if (!auth) throw new HttpError(404, "ChatGPT sign-in is not available in this launch");
  // accounts-wizard-plans (security): a waiting sign-in carries its one-time code, which would link Branch to whoever
  // types it, so the status is the owner's alone: short-lived keys are refused (ownerOnlyReads) and so are household people.
  if (request.method === "GET" && path === "/api/chatgpt/status") { app.store.profiles.requireOwner("The ChatGPT sign-in"); return auth.status(); }
  if (request.method === "POST" && path === "/api/chatgpt/login") {
    z.object({}).strict().parse(await readBody(request));
    app.store.profiles.requireOwner("The ChatGPT sign-in");
    // Already signed in (this launch or an earlier one): nothing to type, the window goes straight to connected.
    if ((await auth.status()).signedIn) return { signedIn: true };
    const prompt = await auth.startDeviceLogin();
    void finishChatGPTSignIn(app.runtime.models, auth, owner, app.userAgent)
      .then(async () => { const service = accountsServiceFor(app.runtime.models); if (service) { await mergeChatGPTDuplicates(service, { fresh: "primary" }); await service.ensureChatGPTPresets(); } })
      .catch(() => undefined); // mac6/accounts; the same account signed in again is merged (src/accounts/dedupe.ts)
    return { userCode: prompt.userCode, verificationUrl: prompt.verificationUrl, expiresAt: prompt.expiresAt };
  }
  // The window's Back or close while the code is shown: the engine stops asking OpenAI and drops the code.
  if (request.method === "POST" && path === "/api/chatgpt/cancel") {
    z.object({}).strict().parse(await readBody(request));
    app.store.profiles.requireOwner("The ChatGPT sign-in");
    return auth.cancelDeviceLogin();
  }
  if (request.method === "POST" && path === "/api/chatgpt/logout") {
    z.object({}).strict().parse(await readBody(request));
    const status = await auth.signOut();
    syncChatGPTPresets(app.runtime.models, auth, false, app.userAgent);
    await accountsServiceFor(app.runtime.models)?.ensureChatGPTPresets(); // mac6/accounts: other ChatGPT accounts stay
    return status;
  }
  throw new HttpError(404, "Endpoint not found");
}
/** Files a run changed, with the kept version to undo each change. */
function fileChanges(app: Branch, runId: string) {
  return app.store.events(runId).filter((e) => e.kind === "file.changed").slice(0, 10)
    .map((e) => ({ path: e.data.path, versionId: e.data.versionId, existed: e.data.existed, added: e.data.added, removed: e.data.removed, diff: e.data.diff }));
}
/** What one task probably cost: a dollar figure when the model it used has a price on file. */
/**
 * DG-101: the whole conversation's probable cost, summed over every one of its tasks (never the recent-task window).
 * One task with no price on file makes the whole answer unknown, so a partial sum is never shown as a total. The
 * line asks every few seconds, so a finished task's cost is kept (keyed by the price overrides it was worked out
 * with) rather than read again from its events each time (Q35).
 */
const finishedCosts = new Map<string, { prices: string; amount: number | null }>();
function conversationCost(app: Branch, owner: string, sessionId: string): { amount: number | null; currency: "USD" } {
  requireBoundSession(shortLivedKeyMark().sessionId, sessionId);
  if (!app.store.ownsSession(owner, sessionId)) throw new HttpError(404, "Session not found");
  const prices = JSON.stringify(pricingSettings(app.store, app.runtime.owner).overrides ?? {});
  const runs = app.store.sessionRuns(owner, sessionId);
  let amount = 0;
  for (const run of runs) {
    const kept = finishedCosts.get(run.id), fresh = !kept || kept.prices !== prices;
    const cost = fresh ? runCost(app, run.id).amount : kept.amount;
    if (fresh && ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status)) {
      if (finishedCosts.size > 20000) finishedCosts.clear();
      finishedCosts.set(run.id, { prices, amount: typeof cost === "number" ? cost : null });
    }
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return { amount: null, currency: "USD" };
    amount += cost;
  }
  return { amount: runs.length ? amount : null, currency: "USD" };
}
/**
 * models-ui: the connection that makes pictures now (src/media.ts preset: the owner's plan for "media") and the kind of
 * picture route it has, or null when it has none, so Settings › Models › Media offers only models that route can make.
 */
function picturesNow(app: Branch): { connection: string; kind: "openai" | "gemini"; defaultModel: string } | null {
  const preset = app.runtime.models.plan(app.runtime.owner, "media").candidates[0];
  const where = preset ? providerImages(preset.provider) : null;
  return preset && where ? { connection: preset.name, kind: where.kind, defaultModel: where.defaultModel } : null;
}
function runCost(app: Branch, runId: string) {
  const usage = app.store.usage(runId);
  const named = app.store.events(runId).filter((e) => e.kind.startsWith("model.") && e.data.model !== undefined);
  const model = String(named.at(-1)?.data.model ?? "");
  if (!model) return { amount: null, currency: "USD" as const, confidence: "unknown" as const, note: "no price on file", display: "no price on file", model: null };
  const { overrides } = pricingSettings(app.store, app.runtime.owner);
  // Cache reads and writes are priced at their own rates (src/pricing.ts tokenCountsOf).
  const estimate = estimateCost(model, tokenCountsOf(usage), overrides);
  return { ...estimate, display: formatCost(estimate), model };
}
/**
 * Which of the two modes a conversation is in, and how far it may go before checking back. Reading
 * gives the project's choice, this conversation's own if it has one, and the words for both; writing
 * sets either, or puts the conversation back on whatever the project says.
 */
function planActApi(app: Branch, request: IncomingMessage, body: unknown): unknown {
  const owner = app.runtime.owner, projectId = app.store.projects.active(owner).id;
  const url = new URL(request.url ?? "/", "http://local");
  const asked = request.method === "POST" ? PlanActChoiceSchema.parse(body ?? {}) : null;
  const sessionId = asked?.sessionId ?? url.searchParams.get("sessionId") ?? "";
  const choice = { ...(asked?.planMode ? { planMode: asked.planMode } : {}),
    ...(asked?.autonomy ? { autonomy: asked.autonomy } : {}) };
  if (asked?.followProject && sessionId) clearSessionPlanAct(app.store, owner, sessionId);
  else if (asked && asked.scope === "project") saveProjectPlanAct(app.store, owner, projectId, choice);
  else if (asked && sessionId) saveSessionPlanAct(app.store, owner, sessionId, projectId, choice);
  // mac7/smoke-fixes (B5): a choice for one conversation with no conversation named used to be
  // dropped without a word, and the answer still showed the project's setting as if it had stuck.
  // Integration review: a POST that asks for nothing at all is a read, not a dropped choice, so it
  // is answered rather than told to name a conversation it never had one for.
  else if (asked && (Object.keys(choice).length > 0 || asked.followProject))
    throw new HttpError(400, 'Say which conversation this choice is for, or send scope "project" to change '
      + "what every conversation in this project starts from. Nothing was changed.");
  const effective = sessionPlanAct(app.store, owner, sessionId, projectId);
  return { projectId, project: projectPlanAct(app.store, owner, projectId), effective,
    words: { planMode: planModeWords, autonomy: autonomyWords },
    plan: sessionId ? app.runtime.orchestration.plan(sessionId) ?? null : null };
}
/**
 * mac7/smoke-fixes (B4): one of the terminal's own commands that only looks, run here and handed
 * back as the very lines it would have printed. The Branch that is running owns the saved work, so
 * this is how a second terminal reads it without opening the same files.
 */
async function terminalReadApi(app: Branch, request: IncomingMessage): Promise<unknown> {
  const url = new URL(request.url ?? "/", "http://local");
  const command = (url.searchParams.get("command") ?? "").trim();
  // Integration review: the old sentence said every name here "changes things", which is wrong for a
  // name that is not a command at all. It now says what this door is for and names what fits through.
  if (!readOnlyTerminalCommands.has(command))
    throw new HttpError(400, `"${command}" is not one of the terminal commands that only look, so it cannot be run `
      + `against the Branch that is already open. These can: ${[...readOnlyTerminalCommands].sort().join(", ")}. `
      + "Anything else needs that Branch closed first.");
  const args = url.searchParams.getAll("arg").map((word) => word.slice(0, 200)).slice(0, 8);
  const json = url.searchParams.get("json") === "1";
  // The owner's saved language wins; "auto" follows the terminal that asked, as it would have here.
  const locale = (url.searchParams.get("locale") ?? "").slice(0, 40);
  const lines: string[] = [];
  await runTerminalCommand(app, command, args, {
    interactive: false, env: locale ? { LANG: locale } : {}, json, write: (line) => { lines.push(line); },
  });
  return { command, lines };
}
/** Every tool event of a run with its verified outcome: success with a genuine receipt, or why not. */
async function receiptsView(app: Branch, runId: string) {
  const events = app.store.events(runId).filter((e) => e.kind.startsWith("tool."));
  const items = [];
  for (const event of events) {
    const outcome = await classifyToolEvent(app.store.receipts, runId, event.kind, event.data);
    if (outcome) items.push({ eventId: event.id, kind: event.kind, name: event.data.name ?? null, id: event.data.id ?? null, outcome, at: event.createdAt });
  }
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
  return { runId, counts, items, usage: app.store.usage(runId), cost: runCost(app, runId) };
}
async function skillsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner, skills = app.store.skills;
  if (path === "/api/skills/policy") {
    if (request.method === "GET") return { policy: skills.policy(owner) };
    if (request.method === "POST") {
      const value = SkillScanPolicySchema.parse(await readBody(request));
      app.store.save("settings", owner, "skill-scan", value);
      return value;
    }
  }
  if (request.method === "POST" && path === "/api/skills/install")
    return skills.install(owner, await readBody(request, 128 * 1024));
  // Wave 4: packages people share, help with writing a skill, and suggestions from recent tasks.
  if (request.method === "GET" && path === "/api/skills/packages") return { packages: app.skillPackages.list(), problems: app.packageProblems };
  if (request.method === "GET" && path === "/api/skills/suggest") return suggestSkills(app.store, owner);
  if (request.method === "POST" && (path === "/api/skills/package/inspect" || path === "/api/skills/package/install")) {
    const body = PackageInstallSchema.parse(await readBody(request, 2 * 1024 * 1024));
    const bytes = Buffer.from(body.file, "base64");
    return path.endsWith("inspect") ? app.skillPackages.inspect(bytes) : app.skillPackages.install(bytes, body.approve, body.allow);
  }
  // Wave 7: the three browser skills that come with Branch. Listing shows what they are; installing
  // puts one in as an ordinary skill package, switched off until the owner turns it on.
  if (request.method === "GET" && path === "/api/skills/browser") return { skills: browserSkillList() };
  if (request.method === "POST" && path === "/api/skills/browser") {
    const body = (await readBody(request)) as { name?: unknown };
    return app.skillPackages.install(browserSkillPackage(String(body.name ?? "")), true);
  }
  if (request.method === "POST" && path === "/api/skills/draft-from-runs")
    return draftFromRuns(app.store, owner, app.runtime, await readBody(request));
  // finish-soon-a: "Write one with Branch" drafts a skill file from the owner's words for review; nothing is installed.
  if (request.method === "POST" && path === "/api/skills/write") {
    app.store.profiles.requireOwner("Writing a skill");
    if (!app.runtime.models.configured) throw new HttpError(400, noModelWords); // the draft is the model's
    return writeSkill(app.store, owner, app.runtime, await readBody(request));
  }
  const match = /^\/api\/skills\/([a-f0-9-]{36})(?:\/(update|activate|disable|remove|read|benchmark|draft|pack|test))?$/.exec(path);
  if (match && request.method === "POST" && match[2] === "pack") return app.skillPackages.pack(match[1]!, await readBody(request));
  if (match && request.method === "POST" && match[2] === "test") return testSkill(app.store, owner, app.runtime, match[1]!, await readBody(request));
  if (match && request.method === "POST" && match[2] === "benchmark") return app.store.governance.benchmark(app.runtime, { ...(await readBody(request) as Record<string, unknown>), skillId: match[1]! });
  if (match && request.method === "POST" && match[2] === "draft") {
    const { runId } = z.object({ runId: z.string().uuid() }).strict().parse(await readBody(request));
    return app.store.governance.proposeFromRun(app.runtime, match[1]!, runId);
  }
  if (match && request.method === "GET" && !match[2]) return skills.view(owner, match[1]!);
  if (match && request.method === "POST" && match[2]) {
    const input = await readBody(request, 128 * 1024), id = match[1]!;
    switch (match[2]) {
      case "update": return skills.update(owner, id, input);
      case "activate": return skills.activate(owner, id, input);
      case "disable": return skills.disable(owner, id, input);
      case "remove": { const removed = skills.remove(owner, id, input); app.skillPackages.forget(id); return removed; }
      case "read": return skills.read(owner, id, input);
    }
  }
  throw new HttpError(404, "Endpoint not found");
}
/** A 20 MB file arrives base64 encoded, which is a third larger again. */
const documentBodyBytes = 28 * 1024 * 1024;
async function documentsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner, library = app.documents;
  if (path === "/api/documents/settings") {
    if (request.method === "GET") return library.settings(owner);
    if (request.method === "POST") return library.configure(owner, await readBody(request));
  }
  if (request.method === "GET" && path === "/api/documents") return library.view(owner);
  if (request.method === "POST" && path === "/api/documents")
    return library.add(owner, await readBody(request, documentBodyBytes));
  if (request.method === "POST" && path === "/api/documents/search")
    return { results: await library.search(owner, await readBody(request)) };
  if (request.method === "POST" && path === "/api/documents/reindex") {
    const { id } = z.object({ id: z.string().min(1).max(100) }).strict().parse(await readBody(request));
    return library.reindex(owner, id);
  }
  const one = /^\/api\/documents\/([a-f0-9-]{36})$/.exec(path);
  if (one && request.method === "DELETE") return library.remove(owner, one[1]!);
  // Dogfood D6: Library › Documents › Open reads one document's words.
  if (one && request.method === "GET") return library.read(owner, one[1]!);
  throw new HttpError(404, "Endpoint not found");
}
/**
 * FQ-collaboration: comments pinned to a moment in a media file. `GET ?fileId=` lists them for one
 * file, earliest first; `POST` adds one. Opened from the Files browser (public/code-editor.js), which
 * plays the video itself through `/api/media-comments/media` (in `rawApi`, below).
 */
async function mediaCommentsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner, comments = app.store.mediaComments;
  if (request.method === "GET" && path === "/api/media-comments") {
    const fileId = new URL(request.url ?? "/", "http://local").searchParams.get("fileId") ?? "";
    if (!fileId) throw new HttpError(400, "fileId is required");
    return { comments: comments.list(owner, fileId) };
  }
  if (request.method === "POST" && path === "/api/media-comments")
    return comments.add(owner, owner, await readBody(request));
  const one = /^\/api\/media-comments\/([a-f0-9-]{36})$/.exec(path);
  if (one && request.method === "DELETE") return comments.remove(owner, one[1]!);
  throw new HttpError(404, "Endpoint not found");
}
/**
 * The reports the assistant has written, the watches that are running, and the morning brief.
 * These are the routes only; no screen in the app calls them yet.
 */
async function researchApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (request.method === "GET" && path === "/api/research") return { reports: app.research.list(owner) };
  if (request.method === "GET" && path === "/api/monitors") return { monitors: app.monitors.list(owner) };
  if (request.method === "POST" && path === "/api/monitors") return app.monitors.create(owner, await readBody(request));
  const watch = /^\/api\/monitors\/([a-f0-9-]{36})(?:\/(check))?$/.exec(path);
  if (watch && request.method === "DELETE" && !watch[2]) return app.monitors.remove(owner, watch[1]!);
  if (watch && request.method === "POST" && watch[2] === "check") return app.monitors.check(owner, watch[1]!);
  if (request.method === "GET" && path === "/api/brief") return app.brief.preview(owner);
  if (request.method === "POST" && path === "/api/brief") return app.brief.configure(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/brief/send") return app.brief.send(owner);
  throw new HttpError(404, "Endpoint not found");
}
async function mcpApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const extra = await mcpModeApi(app, request, path);
  if (extra !== undefined) return extra;
  if (path === "/api/mcp/settings") {
    const mcp = app.mcpServer;
    if (!mcp) throw new HttpError(500, "Sharing is not available");
    if (request.method === "GET")
      return { ...mcp.sharing(), ...readServingSettings(app.store, app.runtime.owner), tools: shareableTools(app.registry) };
    if (request.method === "POST") {
      const body = await readBody(request);
      // How long a quiet connection is kept and how long a call waits for the owner's yes are
      // saved separately, so a screen that does not know about them cannot reset them by saving.
      const { idleMinutes, askWaitSeconds, ...rest } = (body as Record<string, unknown> | null) ?? {};
      const serving = saveServingSettings(app.store, app.runtime.owner,
        { ...(idleMinutes === undefined ? {} : { idleMinutes }), ...(askWaitSeconds === undefined ? {} : { askWaitSeconds }) });
      const sharing = McpSharingSchema.parse(rest);
      const known = new Set(app.registry.names());
      const exposedTools = sharing.exposedTools.filter((name) => known.has(name));
      // A screen that does not know about answering other assistants must not switch it off by saving.
      const said = (body as Record<string, unknown> | null)?.a2a;
      const a2a = typeof said === "boolean" ? said : mcp.sharing().a2a;
      app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: sharing.enabled, exposedTools, a2a });
      return { ...mcp.sharing(), ...serving, tools: shareableTools(app.registry) };
    }
  }
  throw new HttpError(404, "Endpoint not found");
}
/**
 * Wave 7. What this connection is being offered and what is held back, the records of tool lists
 * other tools were shown, how the connections to outside servers are set up and faring, and the
 * "try a server" bench. `undefined` means this path is not one of these.
 */
async function mcpModeApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const mcp = app.mcpServer;
  if (path === "/api/mcp/preflight" && request.method === "GET" && mcp) {
    const result = mcp.preflight();
    return { ...result, explanation: hiddenToolsText(result), tools: mcp.listTools().map((tool) => tool.name) };
  }
  if (path === "/api/mcp/snapshots" && request.method === "GET")
    return { snapshots: listSnapshots(app.store, app.runtime.owner).map((s) => ({ ...s, tools: s.tools.length })) };
  if (path === "/api/mcp/connections") {
    const scope = app.store.profiles.scope();
    if (request.method === "GET")
      return { settings: readLifecycleSettings(app.store, scope), servers: app.mcpConnections.health(), known: app.mcpConnections.known() };
    if (request.method === "POST")
      return { settings: saveLifecycleSettings(app.store, scope, await readBody(request)), servers: app.mcpConnections.health() };
  }
  if (path === "/api/mcp/signin" && request.method === "POST") {
    app.store.profiles.requireOwner("Signing in to another AI tool's server");
    // The address to open in the owner's own browser; the key lands in the locker, never here.
    const started = await mcpSignIn(await readBody(request), {
      store: app.store, owner: app.runtime.owner, connections: app.oauth, policy: app.web.policy,
    });
    return { url: started.url, redirectUri: started.redirectUri, expiresInMs: started.expiresInMs };
  }
  if (path === "/api/mcp/try" && request.method === "POST") {
    // Trying a server starts a program on this computer, or reaches out to a web address, so it
    // stays with the owner even where several people share the app.
    app.store.profiles.requireOwner("Trying another AI tool's server");
    const trying = await readBody(request, 65536);
    await vetTriedServer(app, trying); // mac3/security-check
    return tryServer(app.store, app.runtime.owner, trying, process.env, app.web.policy);
  }
  // The pages outside servers offered during one conversation, newest first. The page itself
  // travels with the answer so the card can hand it straight back for a one-time address; it is
  // never put in a frame here, only listed.
  if (path === "/api/mcp/apps" && request.method === "GET") {
    const sessionId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("session") ?? "";
    const scope = app.store.profiles.scope();
    const apps: { server: string; uri: string; html: string; runId: string }[] = [];
    for (const run of app.store.runs(scope).slice(0, 12)) {
      if (sessionId && run.sessionId !== sessionId) continue;
      for (const event of app.store.events(run.id))
        if (event.kind === "mcp.app")
          apps.push({ server: String(event.data.server ?? "a server"), uri: String(event.data.uri ?? ""),
            html: String(event.data.html ?? ""), runId: run.id });
      if (apps.length >= 5) break;
    }
    return { apps: apps.slice(0, 5) };
  }
  if (path === "/api/mcp/app" && request.method === "POST") {
    const resource = AppResourceSchema.parse(await readBody(request, 512_000));
    return { url: `/mcp-app/${holdApp(resource)}` };
  }
  return undefined;
}
/**
 * A small page an outside server sent, shown in its own frame. It is served without the session
 * key because a frame cannot carry one; instead the address is a one-time unguessable name that
 * stops working after five minutes, and the page is locked down so hard by its content rules that
 * it can neither run a script nor reach anything at all.
 */
const heldApps = new Map<string, { resource: AppResource; until: number }>();
function holdApp(resource: AppResource): string {
  for (const [id, held] of heldApps) if (held.until < Date.now()) heldApps.delete(id);
  // At the limit the oldest waiting page goes, rather than every page anyone is still looking at.
  while (heldApps.size > 20) heldApps.delete(heldApps.keys().next().value!);
  const id = randomBytes(24).toString("base64url");
  heldApps.set(id, { resource, until: Date.now() + 300_000 });
  return id;
}
export function mcpAppPage(request: IncomingMessage, response: ServerResponse, path: string): boolean {
  const match = /^\/mcp-app\/([A-Za-z0-9_-]{32,48})$/.exec(path);
  if (!match || request.method !== "GET") return false;
  const held = heldApps.get(match[1]!);
  // The name is good for one fetch. It is handed over without the session key, so it stops working
  // the moment it has been used, as well as after five minutes.
  heldApps.delete(match[1]!);
  if (!held || held.until < Date.now()) {
    send(response, 404, { error: "That page has expired. Open it again from Settings." });
    return true;
  }
  const page = appPage(held.resource);
  response.writeHead(200, { ...appHeaders(), "x-mcp-app-removed": String(page.removed) });
  response.end(page.body);
  return true;
}
async function handleMcpRequest(
  app: Branch,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path !== "/mcp") return false;
  if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) return false;

  try {
    const owner = app.runtime.owner;
    const mcp = app.mcpServer;
    if (!mcp) throw new HttpError(500, "MCP server not initialized");

    const sessionId = request.headers["mcp-session-id"] as string | undefined;

    if (request.method === "DELETE") {
      if (sessionId) {
        mcp.deleteSession(sessionId);
      }
      response.writeHead(204);
      response.end();
      return true;
    }

    // A name Branch never handed out is not a conversation. Only the very first message may bring
    // one of its own; after that a made-up name is refused, rather than quietly opening a second
    // conversation or letting anything read a stream it was never given.
    const unknownSession = sessionId !== undefined && !mcp.hasSession(sessionId);

    if (request.method === "GET") {
      // The spec's streaming half: a client that says it wants an event stream gets one, and
      // messages Branch starts itself — "the tools have changed", "that task has finished" — come
      // down it. A plain GET is still refused, because a plain GET cannot carry them.
      if (!/text\/event-stream/i.test(String(request.headers.accept ?? "")))
        throw new HttpError(405, "Use POST for JSON-RPC requests, or ask for text/event-stream to open a stream");
      if (unknownSession) throw new HttpError(404, "That conversation is not open. Send initialize first.");
      openEventStream(mcp, request, response, sessionId);
      return true;
    }

    const body = request.method === "POST" ? await readBody(request, 65536) : undefined;

    if (request.method === "POST" && body) {
      const JsonRpcSchema = z
        .object({
          jsonrpc: z.literal("2.0"),
          id: z.union([z.string(), z.number()]),
          method: z.string(),
          params: z.record(z.string(), z.unknown()).optional().default({}),
        })
        .strict();
      const jsonRpcRequest = JsonRpcSchema.parse(body) as { jsonrpc: "2.0"; id: string | number; method: string; params?: Record<string, unknown> };
      if (unknownSession && jsonRpcRequest.method !== "initialize")
        throw new HttpError(404, "That conversation is not open. Send initialize first.");
      // A client that did not bring a conversation of its own is given one, named in the reply to
      // its first message, so everything it does afterwards is kept together.
      const opened = !sessionId && jsonRpcRequest.method === "initialize" ? mcp.getSession().id : undefined;
      const session = mcp.getSession(sessionId ?? opened);
      const result = await mcp.handle(jsonRpcRequest, session.id);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "mcp-protocol-version": session.protocolVersion,
        ...(opened ? { "mcp-session-id": opened } : {}),
      });
      response.end(JSON.stringify(result));
      return true;
    }

    throw new HttpError(405, "Only POST is supported for MCP");
  } catch (e) {
    if (!response.headersSent) {
      const status = e instanceof HttpError ? e.status : 400;
      send(response, status, { error: errorText(e) });
    } else {
      response.end();
    }
    return true;
  }
}
/**
 * The stream half of the modern MCP transport. The connection stays open and Branch writes down it
 * whenever something changes on this side; a colon line every half minute keeps it from being
 * closed by something in the middle for going quiet.
 */
function openEventStream(
  mcp: McpServer, request: IncomingMessage, response: ServerResponse, sessionId?: string,
): void {
  const session = mcp.getSession(sessionId);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "mcp-session-id": session.id,
    "mcp-protocol-version": session.protocolVersion,
  });
  response.write(": connected\n\n");
  const stop = mcp.openStream(session.id, (notification) => {
    response.write(`event: message\ndata: ${JSON.stringify(notification)}\n\n`);
  });
  const beat = setInterval(() => response.write(": keep-alive\n\n"), 30000);
  beat.unref?.();
  const end = () => { clearInterval(beat); stop(); response.end(); };
  request.on("close", end);
  request.on("error", end);
}
/**
 * How another AI tool starts Branch as a child program on this machine. The child is given this
 * install's data and workspace paths, because it inherits the other tool's working directory.
 */
function stdioCommand(dataDir: string, workspace: string): {
  command: string; args: string[]; env: Record<string, string>; packaged: boolean;
} {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const packaged = Boolean(process.versions.electron) && !(process as { defaultApp?: boolean }).defaultApp;
  const env = { BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: workspace };
  return packaged
    ? { command: process.execPath, args: [cli, "mcp-serve"], env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, packaged }
    : { command: "branch", args: ["mcp-serve"], env, packaged };
}
/** Ready-to-paste settings for the other AI tool, using this server's own address and key. */
function mcpConnectionSnippets(app: Branch, request: IncomingMessage, dataDir: string): unknown {
  const url = `http://${request.headers.host ?? "127.0.0.1:3210"}`;
  const token = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "YOUR_SESSION_KEY";
  const stdio = stdioCommand(dataDir, app.runtime.workspace);
  const stdioConfig = JSON.stringify({ mcpServers: { branch: {
    command: stdio.command, args: stdio.args, env: stdio.env,
  } } }, null, 2);
  const httpConfig = JSON.stringify({ mcpServers: { branch: {
    type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` },
  } } }, null, 2);
  return {
    httpEndpoint: `${url}/mcp`,
    bearerToken: token,
    stdio: { ...stdio, configExample: stdioConfig },
    claudeDesktop: {
      configExample: stdioConfig,
      note: "Paste this into Claude Desktop's settings file, then restart it. On Windows the file is %APPDATA%/Claude/claude_desktop_config.json; on macOS and Linux it is ~/.config/Claude/claude_desktop_config.json. Claude Desktop starts its own copy of Branch, so close this app first — two copies cannot share the same records.",
    },
    claudeCode: {
      configExample: `claude mcp add --transport http branch ${url}/mcp --header "Authorization: Bearer ${token}"`,
      note: "Run this once in a terminal. Claude Code then talks to Branch while Branch is open.",
    },
    cursor: {
      configExample: httpConfig,
      note: "Paste this into Cursor's MCP settings. It talks to Branch over this computer's own address, so Branch has to be open.",
    },
  };
}
/** The pairing door, open only on the phone's listener and only for the invitation on offer. */
export async function pairingRequest(
  remote: RemoteAccess, request: IncomingMessage, response: ServerResponse, path: string,
  /** Batch 20 (wave 8): writes the phone down and hands it a secret and a key of its own. */
  gateway: Pick<GatewayAuth, "remember">,
): Promise<boolean> {
  if (request.method !== "POST" || path !== "/api/pair") return false;
  const body = z.object({ id: z.string().max(64), code: z.string().max(16), name: z.string().trim().max(80).default("A phone") })
    .strict().parse(await readBody(request, 1024));
  remote.pairing.redeem(body.id, body.code);
  // The phone is remembered the moment it is let in, so the "this exact phone" step of the chain
  // has something to check against from the very next request. It is handed a key of its own, never
  // the window's: removing it takes that key away and nothing else (src/remote/window-key.ts).
  const device = gateway.remember(body.name);
  send(response, 200, { token: device.key, deviceId: device.device.id, deviceKey: device.secret });
  return true;
}
/**
 * Q45 leaf 0: listens on `port`; when it is taken and `anyPortIfTaken` is set, on any free port instead, on the same
 * server, so nothing set up before listening is set up twice.
 */
export function listenOn(server: Server, port: number, address: string, anyPortIfTaken = false): Promise<void> {
  const bind = (at: number) => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(at, address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return bind(port).catch((error: NodeJS.ErrnoException) => {
    if (anyPortIfTaken && port && error?.code === "EADDRINUSE") return bind(0);
    throw error;
  });
}

export { offLimitsToHousehold, offLimitsToShortLivedKeys };
import { offLimitsToShortLivedKeys } from "./caller-policy.js";
/** Settings › Chat apps: phone access through Tailscale for the Telegram Mini App (src/miniapp/phone-access.ts). */
const phoneAccessPath = "/api/miniapp/phone-access";
/** Tests only: see `policyProbe` below. */
export const policyProbeHeader = "x-branch-policy-probe";
/** selfdev: an engine the desktop app runs in a process of its own, whose engine host starts it again when it stops. */
function hostedEngine(options: { presence?: "app" | "daemon" | undefined; presencePid?: number | undefined }): boolean {
  return options.presence === "app" && options.presencePid !== undefined && options.presencePid !== process.pid && typeof process.send === "function";
}

export async function startServer(
  app: Branch,
  options: {
    dataDir: string; port?: number;
    /** Q45 leaf 0: when the asked-for port is taken, take any free one instead of failing the start. */
    anyPortIfTaken?: boolean;
    /** The installed program file and folder, when Branch runs from an install rather than source. */
    executable?: string | null; installRoot?: string | null;
    /** Starting at sign-in: stand-ins for the registry tool (tests), and the desktop app's Mac login item. */
    autostartDeps?: DeploymentContext["autostartDeps"]; loginItem?: DeploymentContext["loginItem"];
    /** Announce this engine to other launches, so a second window joins it instead of starting again. */
    presence?: "app" | "daemon";
    /**
     * The process the "already running here" note names, which must be gone before the app counts as closed: the
     * desktop app's main process when this engine runs in a process of its own under it. This process when left out.
     */
    presencePid?: number;
    /** How many wrong keys a place may try before it waits; the defaults suit a real install. */
    authLimits?: { attempts?: number; lockoutMs?: number; windowMs?: number };
    /** bucket 22: what `branch quit` does to this launch (src/install/quit.ts); without it, it refuses. */
    quit?: () => void;
    /** Trusted desktop broker status over the private engine Link; never supplied by a web request. */
    gatewayPower?: NeverBreakExtras["gatewayPower"];
    /** How `tailscale` is run to learn the Mini App's HTTPS address (src/miniapp/phone-access.ts); tests stand in for it. */
    tailscaleServe?: TailscaleRunner;
    /** The desktop app's engine process tells the window's main process each new window key, which signs its requests. */
    onWindowKey?: (key: string) => void;
    /** mac7/bind: this computer's addresses for the door's decision; read from the system when left out. */
    listenAddresses?: readonly OwnAddress[];
    /**
     * mac7/bind: how the door reads this computer's addresses again while it is open wider than this
     * computer. `listenAddresses` when those are given, which never change, and the system otherwise.
     */
    readListenAddresses?: () => readonly OwnAddress[];
    /** mac7/bind: how often it reads them again; `addressCheckMs` when left out. */
    listenCheckMs?: number;
    /** mac7/bind: how the door asks Tailscale for this computer's address; tests hand in their own. */
    tailscale?: ProbeTailscale;
    /**
     * Tests only (tests/caller-policy.test.mjs): a request carrying `policyProbeHeader` is answered 204 at the exact
     * point the route's own code would start, so every route can be asked who may call it without running it.
     * Never set by the app, the CLI or the desktop app.
     */
    policyProbe?: boolean;
  },
) {
  // Removing a phone that was handed this key makes a new one (rotateWindowKey below), so it is read where it is used.
  let token = await sessionToken(options.dataDir);
  /** This engine's process, named for the desktop window's proof, session key and marks (src/engine-proof.ts). */
  const boot = newBoot();
  /** How many keyless proofs are answered, and how many window connections are held open (src/engine-proof.ts). */
  const proofDoor = new ProofDoor();
  /**
   * The desktop window's side of a request, only at 127.0.0.1 and never through a door: its session key for this
   * process stands for the window key, and the mark it asked for is returned, to go on the answer.
   */
  const windowSession = (request: IncomingMessage, viaRemote: boolean): string | null => {
    if (viaRemote || !fromThisComputer(request.socket?.remoteAddress, request.headers)) return null;
    const local = { port: request.socket?.localPort, address: request.socket?.localAddress };
    if (atWindowAddress(local) === null) return null;
    const supplied = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
    if (isSessionKey(supplied, token, boot)) request.headers.authorization = `Bearer ${token}`;
    return markFor(request.headers[askHeader], sessionKey(token, boot), local, boot);
  };
  diagnosticInstall.type = installTypeOf({ installRoot: options.installRoot ?? null, presence: options.presence ?? "app", packageRoot: packageRootHere() });
  diagnosticInstall.startedAt = Date.now();
  const stopDiagnosticLog = startDiagnosticLog(
    app, options.dataDir, diagnosticInstall.type, diagnosticInstall.startedAt,
  ); // mac7/diagnostics
  let url = "";
  // The same count the waiting line uses, so the two together never run more than this computer is
  // meant to handle.
  const executions = app.executions;
  const remote = new RemoteAccess(() => token, options.tailscale);
  // mac7/phone-qr: the "Get Branch on your phone" download door; closed until the owner shows the code.
  const phoneApp = new PhoneApp();
  // mac7/bind: where this door listens. 127.0.0.1 unless the owner said otherwise and every
  // protection the wider door needs is really on; see src/listen-address.ts for what is refused.
  // An address in Tailscale's range counts only when Tailscale itself reports it, so it is asked here.
  // The same decision is made again while Branch runs when this computer's addresses change.
  const fixedAddresses = options.listenAddresses;
  const readAddresses = options.readListenAddresses ?? (fixedAddresses ? () => fixedAddresses : ownAddresses);
  const startAddresses = fixedAddresses ?? readAddresses();
  const decideHere = (addresses: readonly OwnAddress[]): Promise<ListenDecision> => decideListenHere({
    where: listenAsked(app.store, app.runtime.owner),
    lockdown: lockdownActive(app.store, app.runtime.owner),
    token, addresses, tailscale: options.tailscale,
  });
  const listen: ListenState = { ...await decideHere(startAddresses), closedWhileRunning: false, restartOpens: false };
  /** Every name a request may say it was sent to: the paired address, and the wider door's own. */
  const allowedHosts = (): string[] => [...remote.allowedHosts(), ...listen.extraHosts];
  // Batch 20 (wave 8): what a phone must satisfy on the extra door, as a chain of named steps.
  const gateway = new GatewayAuth(app.store, app.runtime.owner);
  /** Requests let in with a paired phone's own key (src/remote/gateway-auth.ts keyDevice), which counts as the owner's. */
  const phoneKeyed = new WeakSet<IncomingMessage>();
  const bearerOf = (request: IncomingMessage): string => /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
  /** The key that counts as the owner's for this request: the phone's own when it came with one, the window's otherwise. */
  const ownerKeyFor = (request: IncomingMessage): string => (phoneKeyed.has(request) ? bearerOf(request) : token);
  const browserControls = new BrowserControlApi(app);
  const capturedApiSkills = new CapturedApiSkillsApi(app);
  const tasteApi = new TasteApi(app.taste);
  /** The Telegram Mini App's one way into a task's browser, with its own checks instead of a key (src/miniapp/api.ts). */
  const miniApp = new MiniAppApi(app, browserControls);
  /** A task's socket asked for with a paired phone's own key, offered the same two ways the window's key is. */
  const socketPhoneKey = (request: IncomingMessage): boolean => {
    const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((part) => part.trim());
    const supplied = offered[0] === "bearer" ? offered[1] ?? "" : bearerOf(request);
    return gateway.keyDevice(supplied) !== null;
  };
  // Wrong keys, PINs and pairing codes are counted per place they came from; five in a row and that
  // place is made to wait, with a line written into the record of what the assistant was allowed to do.
  const authLimiter = new AuthLimiter(options.authLimits);
  // Counted separately from the session key, so a chat service that is set up wrongly can slow
  // itself down without ever standing between the owner and their own app.
  const webhookLimiter = new AuthLimiter(options.authLimits);
  /**
   * The Telegram Mini App's API, on Branch's own port and on the Mini App's door (src/miniapp/door.ts). A place that
   * keeps sending launch data that isn't Telegram's, or a token that isn't live, waits like any wrong key; through the
   * door every phone arrives from 127.0.0.1 and so shares that wait, which only the owner's own tailnet can reach.
   */
  const miniAppAnswer = async (path: string, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const from = requestSource(request.socket?.remoteAddress, request.headers);
    const waiting = authLimiter.refusal(from, "Telegram Mini App");
    if (waiting) { send(response, 429, { error: waiting }); return; }
    const stopped = new AbortController();
    request.once("aborted", () => stopped.abort());
    response.once("close", () => { if (!response.writableEnded) stopped.abort(); });
    try {
      send(response, 200, await miniApp.handle(path, { method: request.method ?? "GET", token: bearerOf(request),
        body: () => readBody(request, 16_384), signal: stopped.signal }));
    } catch (error) {
      if (error instanceof z.ZodError) { send(response, 400, { error: "That request wasn't understood." }); return; }
      const refused = miniApp.error(error);
      if (!refused) { send(response, 500, { error: "Something went wrong." }); return; }
      if (refused.status === 401) noteAuthFailure(authLimiter, app.store, app.runtime.owner, from, "the Telegram Mini App's launch data");
      send(response, refused.status, { error: refused.message });
    }
  };

/**
 * The widget sits on a page of the owner's own, so its call to the paired listener is cross-origin
 * and the browser asks permission before sending it. Permission is given only to a website the owner
 * listed, named exactly rather than with a star, and only while the widget switch is on. Without
 * this the browser never sends the call at all, so the box on the owner's page could not ask
 * anything; with a star, any page that had got hold of the pairing key could.
 */
function widgetCors(app: Branch, request: IncomingMessage, response: ServerResponse): boolean {
  const allowed = widgetOrigin(embedSettings(app.store, app.runtime.owner), request.headers.origin);
  if (!allowed) return false;
  response.setHeader("access-control-allow-origin", allowed);
  response.setHeader("vary", "Origin");
  if ((request.method ?? "GET") !== "OPTIONS") return false;
  response.setHeader("access-control-allow-methods", "POST, GET");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-max-age", "600");
  response.writeHead(204).end();
  return true;
}
  const handle = async (request: IncomingMessage, response: ServerResponse, viaRemote: boolean): Promise<void> => {
    if (viaRemote) pairedDoorRequests.add(request);
    const mark = windowSession(request, viaRemote);
    if (mark) response.setHeader(answerHeader, mark);
    try {
      const path = new URL(request.url ?? "/", url || "http://127.0.0.1")
        .pathname;
      if (!hostAllowed(request.headers.host, undefined, url, allowedHosts()))
        throw new HttpError(403, "Host rejected");
      if (viaRemote && widgetCors(app, request, response)) return;
      if (viaRemote && (await pairingRequest(remote, request, response, path, gateway))) return;
      // The widget's own script is not served while the switch is off, so turning it off takes the
      // box off the owner's page rather than only hiding the setting.
      if (path === "/widget.js" && !embedSettings(app.store, app.runtime.owner).widget)
        throw new HttpError(404, "Not found");
      // Wave mac3: while the dashboard switch is off its page and files are not served at all.
      if (isDashboardFile(path) && dashboardSettings(app.store, app.runtime.owner).mode === "off")
        throw new HttpError(404, "Not found");
      // bucket 19: the person's page is only served while signing in, or handing a conversation over, is on.
      if (["/people", "/people.js", "/people.css"].includes(path) && !peopleEnabled(app.store, app.runtime.owner)
        && interopMode(app.store, app.runtime.owner, "handoff") === "off")
        throw new HttpError(404, "Not found");
      if (request.method === "GET" && (await staticFile(path, response, request)))
        return;
      // A ```mermaid block's sealed frame and its two scripts (src/diagram-frame.ts): its own policy, nothing private in it.
      if (await diagramFrameRoute(request, response, path)) return;
      if (path.startsWith("/hooks/")) {
        send(response, 200, await hook(app, request, path));
        return;
      }
      if (await whatsAppWebhook(app, request, response, path, webhookLimiter, () => listen.beyond)) return;
      if (await chatWebhook(app, request, response, path, webhookLimiter, () => listen.beyond)) return;
      // Wave 6: a read-only shared conversation carries its own code instead of the session key.
      if (await sharePage(app, request, response, path)) return;
      // Wave 7: a page an outside AI-tool server sent, shown in a frame that can do nothing at all.
      // A frame cannot carry the session key, so the address itself is the one-time secret.
      // mac7/channel-leaks: and only to a caller on this very computer, as the artifact page below
      // already is. The frame is always local, so the gate costs nothing and the address — whose
      // whole secret is the address — is not offered to the private network.
      if (fromThisComputer(request.socket?.remoteAddress, request.headers) && mcpAppPage(request, response, path)) return;
      // Wave 8: an artifact out of a reply, in that same frame. Its address is not used up by the
      // first fetch, so the frame may reload and "open larger" may show the same one again.
      // mac7/bind (integration review): the same gate the live surface gets just below, and for the
      // builder's own reason. This page's address is NOT used up by the first fetch (see the note in
      // src/artifact-pages.ts), so for ten minutes it is a page whose whole secret is its address.
      // The single-use MCP page above burns its address on the first GET, so it does not need this.
      if (fromThisComputer(request.socket?.remoteAddress, request.headers) && artifactPageRoute(request, response, path)) return;
      // ---- bucket 19: signing a person in needs no key yet; only this app's own pages may ask. ----
      if (path.startsWith("/api/people/sign-in")) {
        if (!hostAllowed(request.headers.host, request.headers.origin, url, allowedHosts()) || request.headers["sec-fetch-site"] === "cross-site")
          throw new HttpError(403, "Origin rejected");
      }
      // Integration review: the identity service's way back is a navigation from its own site, so it
      // has no origin check, but on the paired door it passes the door's chain like the rest.
      if ((path.startsWith("/api/people/sign-in") || path === "/api/people/oidc/callback") && viaRemote) {
        const refused = gateway.check(request, true);
        if (refused) throw new HttpError(401, refused);
      }
      if (await peopleSignInRoute(app, request, response, path, () => readBody(request), (status, value) => send(response, status, value))) return;
      // ---- end bucket 19 ----
      // A phone that still belongs collects the window's key again after it was rotated, with its own secret.
      if (path === renewPath) { await renewWindowKey(request, response, viaRemote); return; }
      // The desktop window asks this with no key before it sends the key here again (src/engine-proof.ts).
      if (path === proofPath && request.method === "GET" && !viaRemote && fromThisComputer(request.socket?.remoteAddress, request.headers)) {
        const search = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
        // Held open only for the desktop window, on the connection it has just proved, with its session key (which
        // windowSession above has already taken for the window key); a keyless asker gets one short answer.
        if (search.get("hold") === "1") {
          if (!sameKey(request.headers.authorization, `Bearer ${token}`)) throw new HttpError(404, "Not found");
          if (!proofDoor.hold(response)) answerShort(response, 429, { error: "Too many held connections." });
          return;
        }
        if (!proofDoor.mayAnswer()) { answerShort(response, 429, { error: "Too many questions; ask again in a moment." }); return; }
        const answer = answerProof(search, token, { port: request.socket?.localPort, address: request.socket?.localAddress }, boot);
        if (!answer) throw new HttpError(404, "Not found");
        answerShort(response, 200, answer);
        return;
      }
      // ---- mac7/nodes: a device answering an invitation has no key; its number and its signature are checked. ----
      if (openDevicePaths.includes(path)) {
        if (request.headers.origin && !hostAllowed(request.headers.host, request.headers.origin, url, allowedHosts()))
          throw new HttpError(403, "Origin rejected");
        // mac7/channel-leaks: a six-digit number is small enough that the five tries per invitation
        // are not the whole answer. A place that keeps getting it wrong now waits, counted where
        // every other wrong key and PIN is counted — which is what the note by `authLimiter` above
        // has always said happens to pairing codes, and until now did not.
        // mac7/lockout: the wait is read only after this device's own number has been found wrong,
        // never before, so a phone typing the right number is let in while somebody else is being
        // made to wait. The five tries per invitation, which burn the invitation, are the guard
        // against guessing; this wait is the second one and must not stand in a real device's way.
        // It matters most behind the never-break gateway, where every device on the private network
        // reaches the engine from 127.0.0.1 and so shares one entry.
        const from = requestSource(request.socket?.remoteAddress, request.headers);
        // B6: the phone let in from "Pair a phone" collects what POST /api/pair hands over (below): the window's key
        // and its own "this exact phone" secret. Once, signed with its pairing key; src/devices/book.ts collectPhoneSession.
        const answer = await openDevicesApi({ devices: app.devices, method: request.method ?? "GET", readBody: () => readBody(request, 4096),
          // The window's key never travels as plain HTTP across a home network: src/remote/window-key.ts keyMayTravel.
          ...(keyMayTravel(request, viaRemote) ? { phone: { remember: (name: string) => gateway.remember(name) } } : {}) },
          path, from).catch((error: unknown) => {
          if (!(error instanceof DevicesHttpError)) throw error;
          if (error.status !== 403) throw new HttpError(error.status, error.message);
          const pairingWait = authLimiter.refusal(from, "pairing code");
          noteAuthFailure(authLimiter, app.store, app.runtime.owner, from, "a device's pairing code");
          throw new HttpError(pairingWait ? 429 : error.status, pairingWait ?? error.message);
        });
        authLimiter.succeed(from);
        send(response, 200, answer);
        return;
      }
      // ---- end mac7/nodes ----
      // mac6/bucket-23 (A2240): a live page in the same sealed frame, under its own long random name;
      // only on this computer's own listener, since the name does not run out as an artifact's does.
      // mac7/bind: and only to a caller on this very computer. Opening the door to the private
      // network must not quietly widen a page whose whole secret is its address.
      if (!viaRemote && fromThisComputer(request.socket?.remoteAddress, request.headers)
        && app.asks.surfaces.serve(request, response, path)) return;
      // ---- The Telegram Mini App (src/miniapp/api.ts): no Branch key; Telegram's signed launch data and the App lock PIN
      // open a session held to one task's browser, and its token is good for these routes only. A place that keeps
      // sending launch data that isn't Telegram's, or a token that isn't live, waits like any wrong key. ----
      if (handlesMiniAppPath(path)) { await miniAppAnswer(path, request, response); return; }
      const triggerFireMatch = /^\/api\/triggers\/([a-f0-9-]{36})\/fire$/.exec(path);
      if (triggerFireMatch && request.method === "POST") {
        // Counted on the webhook limiter, not the key's: a service set up with the wrong secret
        // slows itself down and never stands between the owner and their own app.
        // mac7/lockout: and counted per trigger, not per door. Every trigger fired through the
        // webhook door used to share one entry with every chat service, so one caller with a stale
        // secret silenced all of them. The wait is now read inside `triggerFire`, after the
        // signature has been checked, so a correctly signed fire is never turned away by it.
        const from = webhookLimitKey(requestSource(request.socket?.remoteAddress, request.headers),
          "trigger", triggerFireMatch[1]!);
        send(response, 200, await triggerFire(app, request, triggerFireMatch[1]!,
          { limiter: webhookLimiter, from, proven: false, channel: triggerFireMatch[1]! }));
        return;
      }
      // ---- Who is calling: worked out once here (src/caller.ts); what each caller may reach is decided once, below,
      // by src/caller-policy.ts. Reading the key only says whose it is and whether it still works. ----
      const who: { key: CallerFacts["key"]; supplied: string; person: { profileId: string; keyId: string; setupOnly: boolean } | null }
        = { key: "window", supplied: "", person: null };
      authorize(request, url, token, allowedHosts(), {
        limiter: authLimiter,
        onFailure: (from) => noteAuthFailure(authLimiter, app.store, app.runtime.owner, from, "the local key"),
      }, (offered) => {
        who.supplied = offered;
        // A paired phone's own key counts as the owner's, as the window's key does; the request is marked as the phone's.
        if (gateway.keyDevice(offered)) { phoneKeyed.add(request); who.key = "phone"; return null; }
        // bucket 19: a person's own key (src/people).
        if (People.isPersonKey(offered)) {
          const found = app.people.identify(offered);
          if (typeof found === "string") return found;
          who.person = found; who.key = "person";
          return null;
        }
        const scope = app.sessionTokens.scopeOf(app.runtime.owner, offered);
        if (scope === null) return app.sessionTokens.check(app.runtime.owner, offered, { method: request.method ?? "GET", executes: false, path });
        // A pairing key is judged as a "run" key, and its own check (session-tokens.ts) keeps it to the A2A door.
        who.key = scope === "a2a" ? "run" : scope;
        return null;
      }, (offered) => app.sessionTokens.scopeOf(app.runtime.owner, offered) !== null
        || app.people.keys.working(offered)); // bucket 19
      const { key, supplied, person } = who;
      const here = fromThisComputer(request.socket?.remoteAddress, request.headers);
      // The extra door has its own chain on top of the key: see src/remote/gateway-auth.ts. The
      // window on this computer never goes through it.
      if (viaRemote) {
        const refused = gateway.check(request, true);
        if (refused) throw new HttpError(401, refused);
        enterPairedDoor(); // the phone is the owner's, never whoever this window is switched to (src/profiles.ts)
      }
      const caller = resolveCaller({
        key, pairedDoor: viaRemote, fromThisComputer: here, windowHousehold: key !== "person" && !app.store.profiles.isOwner(),
        lockdown: lockdownActive(app.store, app.runtime.owner), appLocked: app.sessionLock.shut(),
      });
      // Wave mac3 (commands): a read key's command is sent with POST but only looks.
      const look = key === "read" || key === "run" ? commandLook(app, request, path, supplied) : null;
      const onlyLooking = look !== null;
      const refusal = callerRefusal(caller, request.method, path, { setupOnly: person?.setupOnly === true, onlyLooking });
      // A short-lived key's own limits (the one conversation it may be held to) and its count of uses, where they were
      // always asked: after its own reach, before anything else. A refusal of its reach is not counted as a use.
      if (key === "read" || key === "run") {
        const held = refusal?.status === 401 ? null : app.sessionTokens.check(app.runtime.owner, supplied, { ...(look ?? {
          method: request.method ?? "GET", executes: isExecution(request, path),
        }), path });
        if (held) throw new HttpError(401, held);
      }
      if (refusal) throw new HttpError(refusal.status, refusal.message);
      // A phone's own key, the paired door, or a caller beyond this computer: what only this computer's window may do
      // (switching Lockdown off, src/other-api.ts) is refused to it where it is handled.
      if (caller.throughDoor) markDoorRequest(request);
      // bucket-18 (A0300): everything this request starts knows it came with a short-lived key, which one, and the one
      // conversation it may be held to; a person's own key is one too (bucket 19), and the rest of the request is theirs.
      if (key === "read" || key === "run") markShortLivedKey(app.sessionTokens.markOf(app.runtime.owner, supplied) ?? {});
      if (person) {
        enterPerson({ profileId: person.profileId, keyId: person.keyId });
        markShortLivedKey({ keyId: `person:${person.keyId}` });
      }
      enterCaller(caller);
      if (options.policyProbe && request.headers[policyProbeHeader] !== undefined) { response.writeHead(204).end(); return; }
      // Setup polish 2: what setup asks for is first-run configuration, set aside by achievements (src/setup-origin.ts).
      noteSetupOrigin(request.headers[setupOriginHeader]);
      // Doing something counts as activity; merely looking does not, or the app's own three-second
      // refresh of the screen would keep it awake for ever and it would never lock itself.
      if (request.method !== "GET" && path !== "/api/lock" && !onlyLooking) app.sessionLock.touch();
      if (await handleMcpRequest(app, request, response)) return;
      // parity-b2: the owner's live view of this computer's screen, a stream of frames for as long as the view is open
      // (src/live-screen.ts). Every check above has already run; its own are asked again before every frame.
      if (request.method === "GET" && path === liveScreenPath) {
        try {
          streamLiveScreen({ store: app.store, owner: app.runtime.owner, profiles: app.store.profiles, viaDoor: throughDoor(request),
            locked: () => app.sessionLock.refusal("GET", liveScreenPath), desktop: app.desktop ?? null }, request, response);
        } catch (error) { throw error instanceof LiveScreenRefusal ? new HttpError(error.status, error.message) : error; }
        return;
      }
      // "Take over" and "Hand back" for this computer's screen: the owner at this computer's own window, and nobody else.
      if (request.method === "POST" && (path === screenTakeOverPath || path === screenHandBackPath)) {
        z.object({}).strict().parse(await readBody(request));
        try {
          send(response, 200, screenControl({ store: app.store, owner: app.runtime.owner, profiles: app.store.profiles, viaDoor: throughDoor(request),
            locked: () => app.sessionLock.refusal("POST", path) }, app.desktop ?? null, path));
        } catch (error) { throw error instanceof LiveScreenRefusal ? new HttpError(error.status, error.message) : error; }
        return;
      }
      // ---- Wave mac3: the owner's dashboard (src/dashboard-api.ts). What this key may do is worked
      // out once here, so the page can show a read-only view to a key that may only look. ----
      if (handlesDashboardPath(path)) {
        // The key was already checked and its use counted above; this only reads what it may do.
        const access = dashboardAccess(request, ownerKeyFor(request), (supplied) => app.sessionTokens.scopeOf(app.runtime.owner, supplied));
        const answer = await dashboardApi(app, request, path, {
          dataDir: options.dataDir, access, readBody: () => readBody(request), deps: { hosted: hostedEngine(options) },
        }).catch((error: unknown) => {
          throw error instanceof DashboardApiError ? new HttpError(error.status, error.message) : error;
        });
        send(response, 200, answer);
        return;
      }
      // ---- end of the dashboard block ----
      const executes = isExecution(request, path);
      const place = executes ? executions.take() : null;
      if (executes && !place)
        throw new HttpError(429, "Too many active executions");
      try {
        if (handlesTasteApiPath(path)) {
          const suppliedKey = request.headers.authorization?.replace(/^Bearer(?: |$)/, "") ?? "";
          const authorizeTaste = () => {
            app.store.profiles.requireOwner("Learned preferences");
            if (key !== "window" || suppliedKey.length !== token.length || !timingSafeEqual(Buffer.from(suppliedKey), Buffer.from(token))
              || throughDoor(request) || startedWithShortLivedKey() || currentPerson())
              throw new HttpError(403, "Learned preferences belong to the owner at this window.");
            if (app.sessionLock.shut()) throw new HttpError(423, "Branch is locked.");
          };
          authorizeTaste();
          const input = request.method === "GET" ? Object.fromEntries(new URL(request.url ?? "/", "http://local").searchParams) : await readBody(request);
          send(response, 200, await tasteApi.handle(app.runtime.owner, request.method ?? "GET", path, input, authorizeTaste));
          return;
        }
        if (handlesBrowserApiPath(path) || path === capturedApiSkillsPath) {
          const stopped = new AbortController();
          request.once("aborted", () => stopped.abort());
          response.once("close", () => { if (!response.writableEnded) stopped.abort(); });
          const browserKey = request.headers.authorization?.replace(/^Bearer(?: |$)/, "") ?? "";
          const authorizeBrowser = () => requireBrowserOwner(app, key === "window" && browserKey.length === token.length
            && timingSafeEqual(Buffer.from(browserKey), Buffer.from(token)), throughDoor(request));
          try { authorizeBrowser(); } catch (error) { const refused = browserControls.error(error); throw new HttpError(refused.status, refused.message); }
          const browserQuery = new URL(request.url ?? "/", "http://local").searchParams;
          const input = request.method === "GET" && path === browserApiPath
            ? { sessionId: browserQuery.get("sessionId"), clientId: browserQuery.get("clientId"), profile: browserQuery.get("profile"),
              ...(browserQuery.has("id") ? { id: browserQuery.get("id"), epoch: Number(browserQuery.get("epoch")) } : {}) } : await readBody(request);
          if (path === capturedApiSkillsPath && request.method !== "POST") throw new HttpError(404, "Endpoint not found");
          const action = path === capturedApiSkillsPath
            ? capturedApiSkills.handle(input, { authorize: authorizeBrowser, signal: stopped.signal })
            : browserControls.handle(request.method ?? "GET", path, input, { authorize: authorizeBrowser, signal: stopped.signal });
          const answer = await action
            .catch((error: unknown) => { if (error instanceof z.ZodError) throw error; const refused = browserControls.error(error); throw new HttpError(refused.status, refused.message); });
          send(response, 200, answer); return;
        }
        // ---- The owner's phone through Tailscale (src/miniapp/phone-access.ts): what "Turn on phone access" and "Turn off"
        // run, and running it once the owner has seen that exact command and said yes, in Branch's window on this computer. ----
        if (path === phoneAccessPath) {
          if (request.method === "GET") { send(response, 200, await phoneAccessView()); return; }
          if (request.method !== "POST") throw new HttpError(405, "Use GET or POST here.");
          if (key !== "window" || throughDoor(request)) throw new HttpError(403, "Phone access is turned on and off in Branch's window on this computer.");
          app.store.profiles.requireOwner("Phone access");
          if (app.sessionLock.locked()) throw new HttpError(423, "Unlock Branch before changing phone access.");
          if (lockdownActive(app.store, app.runtime.owner)) throw new HttpError(403, "Lockdown is on, so your phone can't be let in.");
          const input = z.object({ turn: z.enum(["on", "off"]), command: z.array(z.string().max(300)).max(12) }).strict().parse(await readBody(request));
          if (input.turn === "on" && !app.sessionLock.pinSet())
            throw new HttpError(409, "Set an App lock PIN first. Your phone asks for it each time it takes a task's browser.");
          const noted = (outcome: string) => audit(app.store, app.runtime.owner, { action: "phone.access", actor: "owner",
            subject: "the Telegram Mini App through Tailscale", reason: input.command.join(" ").slice(0, 400), outcome });
          try { await phoneAccess.turn(input.turn, input.command); }
          catch (error) { noted("refused"); throw new HttpError(409, errorText(error)); }
          noted(input.turn === "on" ? "turned on" : "turned off");
          send(response, 200, await phoneAccessView());
          return;
        }
        // ---- Wave mac3 (commands): the one slash-command table, for the window, the phone and the
        // dashboard (src/commands/api.ts). What the key may do is read the way the dashboard reads it,
        // and checked command by command; running one takes a place like any other task. ----
        if (handlesCommandsPath(path)) {
          const access = dashboardAccess(request, ownerKeyFor(request), (supplied) => app.sessionTokens.scopeOf(app.runtime.owner, supplied));
          const answer = await commandsApi(app, path, {
            method: request.method ?? "GET", url: new URL(request.url ?? "/", "http://local"), access, readBody: () => readBody(request),
            ...(throughADoor(request) ? { lockdownOffRefusal: lockdownOffHereOnly, throughADoor: true } : {}),
          }).catch((error: unknown) => {
            throw error instanceof CommandApiError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end of the commands block ----
        // ---- bucket 12: saved prompts (src/prompt-library-api.ts) and the skill install record
        // (src/skill-installs.ts). Every change there is the owner's; short-lived keys never get this far. ----
        if (handlesPromptsPath(path) || handlesSkillInstallsPath(path)) {
          const method = request.method ?? "GET", body = () => readBody(request, 2 * 1024 * 1024);
          const answer = handlesPromptsPath(path) ? await promptsApi(app, method, path, body)
            : await skillInstallsApi(app, method, new URL(request.url ?? "/", "http://local"), body);
          if (answer === undefined) throw new HttpError(404, "Endpoint not found");
          send(response, 200, answer);
          return;
        }
        // ---- end of the bucket 12 block ----
        // ---- the wiki: pages with names, and links between them (src/wiki.ts). The owner check is
        // inside wikiApi, at the top, so it travels with the operation rather than living only here. ----
        if (handlesWikiPath(path)) {
          const answer = await wikiApi(
            { wiki: app.wiki, owner: app.runtime.owner, profiles: app.store.profiles },
            request, path, () => readBody(request, 128 * 1024),
            new URL(request.url ?? "/", "http://local").searchParams,
          );
          if (answer === null) throw new HttpError(404, "Endpoint not found");
          send(response, 200, answer);
          return;
        }
        // ---- end of the wiki block ----
        // ---- mac4/bucket-20: the Agent Protocol and /api/interop (src/interop/api.ts). ----
        if (handlesInteropPath(path)) {
          app.store.profiles.requireOwner("Working with other agents");
          await handleInterop({
            interop: app.interop, store: app.store, owner: app.runtime.owner, runtime: app.runtime, flows: app.flows,
            fleet: { runtime: app.runtime, knowledge: app.knowledge, teams: app.teams, remoteAgents: app.remoteAgents, clients: app.interop.clients },
            readBody: () => readBody(request, 131072), baseUrl: remote.status().url ?? url,
            requireOwner: (what) => app.store.profiles.requireOwner(what),
          }, request, response, path);
          return;
        }
        // ---- end of the bucket-20 block ----
        // ---- bucket 19: a person's own page, a handed-over conversation, and the owner's card. ----
        if (path.startsWith("/api/people/")) {
          const answer = await peopleApi(app, request, path, () => readBody(request, 262144)).catch((error: unknown) => {
            throw error instanceof PeopleHttpError ? new HttpError(error.status, error.message) : error;
          });
          if (answer !== notPeople) { send(response, 200, answer); return; }
        }
        // ---- end bucket 19 ----
        // ---- mac7/phone-qr: the "Get Branch on your phone" card (src/phone-app/); the owner's alone. ----
        if (handlesPhoneAppPath(path)) {
          app.store.profiles.requireOwner("Getting Branch on your phone");
          const answer = await phoneAppApi(phoneApp, { store: app.store, owner: app.runtime.owner, method: request.method ?? "GET",
            readBody: () => readBody(request, 4096) }, path).catch((error: unknown) => {
            throw error instanceof PhoneAppRefusal ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end mac7/phone-qr ----
        // ---- mac7/nodes: the Devices card's routes (src/devices/api.ts); the owner's alone. ----
        if (handlesDevicesPath(path)) {
          app.store.profiles.requireOwner("Your devices");
          const answer = await devicesApi({ devices: app.devices, store: app.store, owner: app.runtime.owner, method: request.method ?? "GET",
            readBody: () => readBody(request, 16384), baseUrl: remote.status().url ?? url,
            trunkOf: (sessionId) => app.trunks.trunkForConversation(sessionId)?.trunkId ?? null,
            forgetGateway: (id) => void gateway.forget(id),
            heldWindowKey: (id) => gateway.heldWindowKey(id),
            gatewayPhones: () => gateway.devices(),
            // A removed phone that was handed this window's key takes it with it: a new key replaces it.
            rotateKey: () => rotateWindowKey(request.socket),
            // Never a phone's own key, even arriving from this computer (a local proxy): it is not the window.
            keyHere: !throughADoor(request),
            // B6: the paired door, or any caller not on this computer (a widened listener, the webhook door), is a door.
            // A phone's own key counts too, even arriving from this computer (a local proxy).
            viaDoor: throughADoor(request) }, path).catch((error: unknown) => {
            throw error instanceof DevicesHttpError ? new HttpError(error.status, error.message) : error;
          });
          if (answer === undefined) throw new HttpError(404, "Endpoint not found");
          send(response, 200, answer);
          return;
        }
        // ---- end mac7/nodes ----
        // ---- mac6/bucket-23: the smaller asks under /api/asks (src/asks/api.ts); the owner's alone. ----
        if (handlesAsksPath(path)) {
          app.store.profiles.requireOwner("These parts of Branch");
          const answer = await asksApi({
            asks: app.asks, runtime: app.runtime, method: request.method ?? "GET",
            query: new URL(request.url ?? "/", "http://local").searchParams, readBody: () => readBody(request, 131072),
          }, path).catch((error: unknown) => {
            throw error instanceof AsksHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end of the bucket-23 block ----
        // ---- r17-b: suggestions, standing orders, loops and procedures under /api/autonomy; the owner's alone. ----
        if (handlesAutonomyPath(path)) {
          app.store.profiles.requireOwner("Automations that run on their own");
          const answer = await autonomyApi({
            autonomy: app.autonomy, method: request.method ?? "GET",
            query: new URL(request.url ?? "/", "http://local").searchParams, readBody: () => readBody(request, 131072),
          }, path).catch((error: unknown) => {
            throw error instanceof AutonomyHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end of the r17-b block ----
        // ---- mac7/r17-d: coding polish under /api/coding (src/coding/api.ts); the owner's alone. ----
        if (handlesCodingPath(path)) {
          app.store.profiles.requireOwner("These parts of Branch");
          const answer = await codingApi({
            coding: app.coding, runtime: app.runtime, method: request.method ?? "GET",
            query: new URL(request.url ?? "/", "http://local").searchParams, readBody: () => readBody(request, 131072),
          }, path).catch((error: unknown) => {
            throw error instanceof CodingHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end of the r17-d block ----
        // ---- R17-A: Trunks under /api/trunks (src/trunks/api.ts); the owner's, bar talking to them. ----
        if (handlesTrunksPath(path)) {
          const active = app.store.profiles.active();
          const answer = await trunksApi({ trunks: app.trunks, method: request.method ?? "GET",
            readBody: () => readBody(request, 524288), person: active ? { id: active.id, name: active.name } : null,
            requireOwner: (what) => app.store.profiles.requireOwner(what) }, path)
            .catch((error: unknown) => { throw error instanceof TrunksHttpError ? new HttpError(error.status, error.message) : error; });
          send(response, 200, answer);
          return;
        }
        // ---- end of the R17-A block ----
        // ---- phase2/shell: the strip and 3D faces switches (src/shell-look.ts); changing them is the owner's. ----
        if (handlesShellLookPath(path)) {
          const answer = await shellLookApi(app.store, app.runtime.owner, request.method ?? "GET", () => readBody(request, 4096))
            .catch((error: unknown) => { throw error instanceof ShellLookError ? new HttpError(error.status, error.message) : error; });
          send(response, 200, answer);
          return;
        }
        // ---- end phase2/shell ----
        // ---- R17-C: files, voice, devices and personal connectors under /api/personal (src/personal/api.ts). ----
        if (handlesPersonalPath(path)) {
          app.store.profiles.requireOwner("Your personal connectors");
          const answer = await personalApi({ personal: app.personal, runtime: app.runtime, method: request.method ?? "GET",
            readBody: () => readBody(request, 4 * 1024 * 1024) }, path).catch((error: unknown) => {
            throw error instanceof PersonalHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end of the R17-C block ----
        // ---- r17-i: reach and platform under /api/reach; the owner's alone (one peer route: src/reach/api.ts). ----
        if (handlesReachPath(path)) {
          app.store.profiles.requireOwner("Reach and platform");
          const answer = await reachApi({
            reach: app.reachParts, method: request.method ?? "GET",
            query: new URL(request.url ?? "/", "http://local").searchParams, readBody: () => readBody(request, 262144),
            // mac7/reach-leftovers: which short-lived key this came with, for the Trunks inbox.
            keyId: shortLivedKeyMark().keyId,
          }, path).catch((error: unknown) => {
            throw error instanceof ReachHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end of the r17-i block ----
        // ---- mac7/r17-g: the safety extras under /api/safety-extras (src/safety-extras/api.ts); the owner's alone. ----
        if (handlesSafetyPath(path)) {
          app.store.profiles.requireOwner("The safety extras");
          const answer = await safetyApi({
            extras: app.safetyExtras, runtime: app.runtime, method: request.method ?? "GET",
            query: new URL(request.url ?? "/", "http://local").searchParams, // Only an add-on install carries a WebAssembly file; everything else keeps the usual small limit.
            readBody: () => readBody(request, path === "/api/safety-extras/wasm" ? 11_000_000 : 131072),
          }, path).catch((error: unknown) => {
            throw error instanceof SafetyHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end of the mac7/r17-g block ----
        // ---- r17-h: flows and boards under /api/flows-boards; the owner's alone. ----
        if (handlesFlowsBoardsPath(path)) {
          app.store.profiles.requireOwner("Flows and boards");
          const answer = await flowsBoardsApi({
            boards: app.flowsBoards, method: request.method ?? "GET",
            query: new URL(request.url ?? "/", "http://local").searchParams, readBody: () => readBody(request, 131072),
          }, path).catch((error: unknown) => {
            throw error instanceof FlowsBoardsHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end of the r17-h block ----
        // ---- R17-F: learning, deeper under /api/learning-more (src/learning-more/api.ts); the owner's alone. ----
        if (handlesLearningMorePath(path)) {
          app.store.profiles.requireOwner("Learning, deeper");
          const answer = await learningMoreApi({
            more: app.learningMore, runtime: app.runtime, method: request.method ?? "GET", scope: app.store.profiles.scope(),
            query: new URL(request.url ?? "/", "http://local").searchParams, readBody: () => readBody(request, 131072),
          }, path).catch((error: unknown) => {
            throw error instanceof LearningMoreHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end R17-F ----
        // ---- Seasons: Rings' journal under /api/seasons (src/seasons/api.ts); each person reads and undoes only their own. ----
        if (handlesSeasonsPath(path)) {
          const answer = await seasonsApi({
            store: app.store, rings: app.rings, gardener: app.gardener, budding: app.budding, method: request.method ?? "GET", scope: app.store.profiles.scope(),
            owner: app.runtime.owner, readBody: () => readBody(request, 16384),
            requireOwner: (what) => app.store.profiles.requireOwner(what),
          }, path).catch((error: unknown) => {
            throw error instanceof SeasonsHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- mac7/learn: the map and the tour under /api/learn (src/learn/api.ts); the owner's alone. ----
        if (handlesLearnPath(path)) {
          app.store.profiles.requireOwner("Understanding something");
          const answer = await learnApi({
            learn: app.learn, runtime: app.runtime, method: request.method ?? "GET",
            scope: app.store.profiles.scope(), readBody: () => readBody(request, 131072),
          }, path).catch((error: unknown) => {
            throw error instanceof LearnHttpError ? new HttpError(error.status, error.message) : error;
          });
          send(response, 200, answer);
          return;
        }
        // ---- end mac7/learn ----
        if (await rawApi(app, request, response, path)) return;
        if (path.startsWith("/api/deployment")) {
          // bucket 22: `branch quit`, from this computer with the master key only (src/install/quit.ts).
          if (path === "/api/deployment/quit") {
            const answer = await quitRequest(request, { dataDir: options.dataDir, quit: options.quit, viaRemote })
              .catch((error: unknown) => { throw new HttpError(request.method === "POST" ? 403 : 405, errorText(error)); });
            send(response, 200, answer);
            return;
          }
          // The phone door is switched on and off at this computer only: a phone it let in may not reopen or hold it.
          if (path === "/api/deployment/remote" && (viaRemote || (throughADoor(request) && request.method !== "GET")))
            throw new HttpError(403, "Reaching Branch from your phone is switched on and off on this computer only.");
          const result = await deploymentApi(app, request, path, deployment(), (r) => readBody(r), remoteHandler);
          if (result !== undefined) { send(response, 200, result); return; }
        }
        // mac3/security-check: the self-check card, which needs to know whether the phone door is open.
        if (path.startsWith("/api/security-check")) {
          // Switches and repairs stay with the owner, like trying a server does.
          if (request.method !== "GET" && path !== "/api/security-check/run")
            app.store.profiles.requireOwner("The security check's switches and repairs");
          const answer = await securityCheckApi(app.security, request.method ?? "GET", path, () => readBody(request), remote.status().enabled);
          if (answer !== undefined) { send(response, 200, answer); return; }
        }
        // privacy: Settings › Your data (src/your-data.ts), which needs the phone door, the paired phones and where Branch listens.
        if (handlesYourDataPath(path)) {
          const answer = await yourDataApi(app, request, response, path, { phoneDoor: () => remote.status().enabled,
            beyondThisComputer: () => listen.beyond === true, phones: () => gateway.devices() });
          if (answer !== undefined) send(response, 200, answer);
          return;
        }
        send(response, 200, await api(app, request, path, options.dataDir, listen, options.gatewayPower));
      } finally {
        place?.();
      }
    } catch (e) {
      // mac7/diagnostics: every failed request is one line in the activity log, with an id of its own.
      // An unexpected failure carries the same id back, so what the window saw can be found in the log.
      const shapeError = isRequestShapeError(e);
      // Q44: a turn for a Trunk that starts on another computer is refused with a 409, whichever route queued it.
      const expected = e instanceof HttpError || e instanceof PinnedSettingError || e instanceof StartsElsewhereError || shapeError;
      const status = e instanceof HttpError ? e.status : e instanceof PinnedSettingError ? 403 : e instanceof StartsElsewhereError ? 409 : 400;
      const requestId = newRequestId();
      diagnose("gateway", status >= 500 || !expected ? "warn" : "info", `${request.method ?? "GET"} ${new URL(request.url ?? "/", "http://local").pathname} failed (${status})`,
        { requestId, fields: { error: requestErrorText(e).slice(0, 300) } });
      if (!response.headersSent)
        // mac7/wake-pins: a setting the owner pinned is refused the way every other thing of
        // theirs is, in the same words and with the same 403, wherever the write came from.
        send(response, status, {
          // A saved password or key can never travel back out in a failure message.
          error: app.runtime.hideSecrets(requestErrorText(e)),
          // Only on unexpected failures: a refusal (a wrong key, say) must read the same every time.
          ...(expected ? {} : { requestId }),
        });
      else response.end();
    }
  };
  const server = createServer((request, response) => void handle(request, response, false));
  const remoteHandler = (request: IncomingMessage, response: ServerResponse) =>
    void handle(request, response, true);
  const deployment = (): DeploymentContext => ({
    dataDir: options.dataDir, workspace: app.runtime.workspace, port: new URL(url).port ? Number(new URL(url).port) : 0,
    executable: options.executable ?? null, installRoot: options.installRoot ?? null, remote,
    ...(options.autostartDeps ? { autostartDeps: options.autostartDeps } : {}), ...(options.loginItem ? { loginItem: options.loginItem } : {}),
  });
  // mac7/nodes: one upgrade handler for this computer's door and the paired door (`viaRemote`).
  const upgrade = (request: IncomingMessage, socket: Duplex, viaRemote: boolean): void => {
    const mark = windowSession(request, viaRemote);
    void (async () => {
      const path = new URL(request.url ?? "/", url || "http://127.0.0.1").pathname;
      // ---- mac7/nodes: a device's socket. Its own signature is the key; never the window's key. ----
      if (path === deviceSocketPath) {
        const hosts = allowedHosts();
        const refused = app.devices.hub.refusal(request, requestSource(request.socket?.remoteAddress),
          hostAllowed(request.headers.host, undefined, url, hosts), hostAllowed(request.headers.host, request.headers.origin, url, hosts));
        // Integration review: the door's chain is not run here. Its `token` and `device` steps are the
        // phone window's key and secret, which a device never holds; the device's own signature over a
        // fresh challenge stands in for them. The door's one allowlist still holds: "never" wins.
        const neverOnDoor = viaRemote && allowlistSays(readSenderAllowlist(app.store, app.runtime.owner), remoteChannel, claimedDevice(request)) === "block";
        if (refused || neverOnDoor) { refuseUpgrade(socket); return; }
        app.devices.hub.attach(request, socket);
        return;
      }
      // Integration review: the paired door serves the device socket and nothing else. It had no
      // upgrade handler before this branch, and a task's socket stays on this computer's own door.
      if (viaRemote) { refuseUpgrade(socket); return; }
      // ---- end mac7/nodes ----
      // App lock: a locked Branch with a PIN opens no socket for a task or a program lending tools.
      // Asked only once the key has passed, so the answer tells nobody else that Branch is locked.
      const refusedLocked = (): boolean => {
        if (!app.sessionLock.refusal("GET", path)) return false;
        socket.end("HTTP/1.1 423 Locked\r\nConnection: close\r\n\r\n");
        return true;
      };
      // Q261: a socket is a read, so a household person at the window opens only one listed in householdReads (none
      // is listed now). Asked once the key has passed, like the lock above.
      const refusedHousehold = (): boolean => {
        if (app.store.profiles.isOwner() || offLimitsToHousehold("GET", path) === null) return false;
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return true;
      };
      // mac4/bucket-20: a program on this computer lending tools, behind the key and while the switch is on.
      if (path === clientToolsPath) {
        // Integration review: "a program on this computer" — the paired address never lends tools.
        const sameHost = hostAllowed(request.headers.host, request.headers.origin, url);
        if (!sameHost || !tokenFromProtocol(request, token) || !app.interop.clients.enabled()) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          return;
        }
        if (refusedLocked() || refusedHousehold()) return;
        serveClientToolSocket(app.interop.clients, request, socket);
        return;
      }
      const match = /^\/api\/runs\/([a-f0-9-]{36})\/ws$/.exec(path);
      const run = match && app.store.run(match[1]!);
      const sameHost = hostAllowed(request.headers.host, request.headers.origin, url, allowedHosts());
      if (!match || !run || run.owner !== app.store.profiles.scope() || !sameHost || !(tokenFromSocket(request, token) || socketPhoneKey(request))) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      if (refusedLocked() || refusedHousehold()) return;
      // Wave 8: the same socket also carries a live voice conversation, when the browser asks for
      // one. Nothing is opened until it does, so an ordinary task is unchanged.
      // Q254: the socket follows who is at the window, as /api/events/stream does since #339. Once the
      // window switches profile it ends, and opening it again is refused unless the run is theirs.
      await serveRunSocket(app.store, run.id, request, socket, {
        ...(mark ? { answerHeaders: [`${answerHeader}: ${mark}`] } : {}),
        ...liveHooks(app.live, run.id, run.sessionId), owner: run.owner, scopeNow: () => scopeWhileUnlocked(app), scrub: app.runtime.hideSecrets });
    })().catch(() => socket.destroy());
  };
  server.on("upgrade", (request, socket) => upgrade(request, socket, false));
  remote.upgrade = (request, socket) => upgrade(request, socket, true);
  configureLimits(server);
  startEventLoopWatch(app); // bucket 13: runs from the start only when the owner has it on
  // mac7/bind (integration review): kept so that dropping the wider door can drop what is already
  // connected through it, rather than leaving an open conversation on the network behind.
  const liveConnections = new Set<{ remoteAddress?: string | undefined; destroy: () => void; once: (event: string, listener: () => void) => unknown }>();
  server.on("connection", (socket) => {
    liveConnections.add(socket);
    socket.once("close", () => liveConnections.delete(socket));
  });
  /**
   * A new window key in place of the one a removed phone was handed (src/remote/window-key.ts). Saved first, then
   * used; then every connection from beyond this computer but `keep` (the request that removed the phone) is ended,
   * so nothing opened with the old key goes on. One at a time, so two removals never write the file at once.
   */
  let rotating: Promise<unknown> = Promise.resolve();
  function rotateWindowKey(keep?: unknown): Promise<string> {
    const next = rotating.then(async () => {
      const key = await writeNewWindowKey(options.dataDir);
      token = key;
      browserControls.revoke();
      capturedApiSkills.close();
      options.onWindowKey?.(key);
      for (const socket of liveConnections) if (socket !== keep && !fromThisComputer(socket.remoteAddress)) socket.destroy();
      remote.dropConnections(keep);
      audit(app.store, app.runtime.owner, { action: "channel.paired", actor: app.runtime.owner, subject: "the window's key",
        reason: "A removed phone had been handed the window's key, so a new key replaced it", outcome: "removed" });
      return key;
    });
    rotating = next.catch(() => undefined);
    return next;
  }
  /** POST /api/pair/renew: a phone still on the list, proving itself with its own secret, collects the current key. */
  async function renewWindowKey(request: IncomingMessage, response: ServerResponse, viaRemote: boolean): Promise<void> {
    if (request.method !== "POST") throw new HttpError(405, "Use POST");
    if (request.headers.origin && !hostAllowed(request.headers.host, request.headers.origin, url, allowedHosts()))
      throw new HttpError(403, "Origin rejected");
    const from = requestSource(request.socket?.remoteAddress, request.headers);
    // The secret is checked before any wait is read, so a phone whose old key was just refused is not kept out.
    const device = keyMayTravel(request, viaRemote) ? gateway.proven(request) : null;
    if (!device) {
      const wait = authLimiter.refusal(from, "key");
      noteAuthFailure(authLimiter, app.store, app.runtime.owner, from, "a phone's own secret");
      throw new HttpError(wait ? 429 : 401, wait ?? "This phone is not the one that was let in. Accept a fresh invitation on the computer.");
    }
    authLimiter.succeed(from);
    // A key of the phone's own, never the window's; a phone paired before phones had keys moves to one here.
    const key = gateway.newKey(device.id);
    if (!key) throw new HttpError(401, "This phone is not the one that was let in. Accept a fresh invitation on the computer.");
    send(response, 200, { token: key, deviceId: device.id });
  }
  await listenOn(server, options.port ?? 3210, listen.address, options.anyPortIfTaken === true);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to bind loopback server");
  // mac7/bind: the address Branch tells everything else about stays this computer's own, whatever
  // the door listens on: the window, the webhook door and every test reach Branch here as before.
  url = `http://127.0.0.1:${address.port}`;
  if (listen.refusal) console.log(`Branch Agent: ${listen.refusal}`);
  else if (listen.beyond)
    console.log((listen.ipv4Only ? `Branch Agent: ${listen.ipv4Only}`
      : "Branch Agent is listening on every address this computer answers on, not only this computer.")
      + " Anyone who can reach it still needs the local session token.");
  // mac7/bind (integration review): switching Lockdown on while the wide door is already open has
  // to TAKE THE DOOR AWAY, not merely refuse what arrives at it. Without this the socket stays open on
  // every address until the next restart — which is the one thing Lockdown is for. The listening
  // socket is closed, everything already connected from beyond this computer is dropped, and the door
  // comes back on 127.0.0.1 alone.
  const boundPort = address.port;
  let closing = false;
  /** The door coming back on 127.0.0.1, which closing Branch waits for so no socket outlives it. */
  let narrowing: Promise<void> = Promise.resolve();
  const stopWatchingLockdown = onLockdownChange((_store, _owner, on) => {
    // mac7/phone-qr: Lockdown also ends a phone download link that is showing.
    if (on) phoneApp.stop();
    // Lockdown shuts the door to the phone too, and an opening still waiting on Tailscale never opens.
    if (on) void remote.disable();
    if (on) narrowToThisComputer("Lockdown is on, so Branch is listening on this computer only.", "Lockdown");
  });
  /**
   * Takes the wider door away, keeps 127.0.0.1 answering, and says `why` once. Lockdown and a change
   * of this computer's addresses both close the door here. What the door answers to narrows with the
   * socket, before it is back on 127.0.0.1, so no name, webhook or card treats Branch as reachable
   * from beyond this computer in between.
   */
  function narrowToThisComputer(why: string, closedBy: string): void {
    if (closing || listen.address === thisComputerAddress) return;
    // `close` gives the listening handle up at once; its callback waits for every open connection
    // to end, which is why it is not awaited — the wide ones are dropped by hand just below.
    server.close();
    for (const socket of liveConnections)
      if (!fromThisComputer(socket.remoteAddress)) socket.destroy();
    listen.address = thisComputerAddress;
    listen.beyond = false;
    listen.extraHosts = [];
    listen.ipv4Only = null;
    listen.refusal = why;
    listen.closedWhileRunning = true;
    console.log(`Branch Agent: ${why}`);
    narrowing = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(boundPort, thisComputerAddress, () => { server.off("error", reject); resolve(); });
    }).catch((error: unknown) => {
      // The wide socket is already given up by the time anything here can fail, so the door is
      // closed. What can still go wrong is coming back on 127.0.0.1 — say so plainly rather than
      // leaving a promise nobody caught, because a door nobody can open is a different problem from
      // a door open too wide, and the owner has to be told which one it is.
      console.log(`Branch Agent: ${closedBy} closed the wider door, but Branch could not start`
        + ` listening on this computer again (${errorText(error)}). Restart Branch.`);
    });
  }
  // mac7/bind: the door was decided on the addresses this computer had at the start. While it is
  // open wider than this computer they are read again, and when they change the same decision is
  // made again. Reading goes on after the door has closed, so the card can say when a start would
  // open it again; nothing here ever opens it.
  const stopWatchingAddresses = listen.beyond
    ? watchAddresses({
      read: readAddresses, everyMs: options.listenCheckMs ?? addressCheckMs, first: startAddresses,
      changed: async (addresses) => { follow(await decideHere(addresses)); },
    })
    : () => undefined;
  /** What a decision made again does to the door as it stands now: it can narrow it, and never widen it. */
  function follow(next: ListenDecision): void {
    if (closing) return;
    if (!listen.beyond) {
      // Closed while Branch runs: only a start opens it again, so the card is told when a start would.
      listen.restartOpens = next.beyond;
      return;
    }
    if (!next.beyond) {
      narrowToThisComputer(next.refusal ?? listenNowHereReason, "A change in this computer's addresses");
      return;
    }
    // Still the same wide socket: the names it answers to can shrink with the addresses, never grow.
    listen.extraHosts = listen.extraHosts.filter((name) => next.extraHosts.includes(name));
    listen.ipv4Only = next.ipv4Only;
  }
  app.localAddress = url; // R17-C: the webhook door passes requests on to this address (handed on once that part is built)
  app.scheduler.start();
  // The ship-on rule: the installed app's first start keeps Branch running without a setup step (src/keep-running.ts).
  // How earlier versions' first starts went is read here, before noteFirstStart below writes this one's.
  if (options.executable) {
    const firstStart = await readFirstStart(options.dataDir);
    void shipKeepRunningOn({ store: app.store, owner: app.runtime.owner, dataDir: options.dataDir, version: app.version, firstStart,
      startAtSignIn: () => shipAutostart(deployment()) }).catch((error: unknown) => console.error(`Could not keep Branch running: ${errorText(error)}`));
  }
  settleSupersededAsks(app); // Q050, before settleLostQuestions offers any of them to be carried on
  void resumeUnfinishedDeletes(app); // your-data/for-good: a Delete everything cut short carries on (never throws)
  // mac3/never-break: a real start settles work a restart cut off (nothing, with the switch off).
  if (options.presence || process.env.BRANCH_GATEWAY_CHILD === "1") {
    settleLostQuestions(app); // dogfood F8, before recoverOnStart asks its own questions
    registerRestartTool(app, options.dataDir, { hosted: hostedEngine(options) }); // selfdev: only a real start can be started again by what watches it
    void app.neverBreak.recoverOnStart(options.dataDir).catch((error: unknown) => console.error(`Could not pick up interrupted work: ${errorText(error)}`));
    void app.neverBreak.telegram.connect().then((why) => { if (why && !/switched off/.test(why)) console.log(why); },
      (error: unknown) => console.error(`Telegram did not connect: ${errorText(error)}`));
    // CHAT-147: every other chat app set up in the window; each problem goes to the diagnostics.
    void app.channelSetup.connectSaved().catch((error: unknown) => console.error(`Chat apps did not connect: ${errorText(error)}`));
  }
  // The Telegram Mini App's own door on this computer's loopback address, and where the owner's phone reaches it.
  const miniAppDoor = new MiniAppDoor(app.store, app.runtime.owner, miniAppAnswer);
  await miniAppDoor.open().catch((error: unknown) => console.error(`The Telegram Mini App's door did not open: ${errorText(error)}`));
  const phoneAccess = new PhoneAccess(() => miniAppDoor.port, options.tailscaleServe);
  /** Where the phone reaches the Mini App now, and the exact commands the window shows before turning it on or off. */
  const phoneAccessView = async () => ({ phoneAccess: { url: await phoneAccess.refresh(), pinSet: app.sessionLock.pinSet(),
    on: phoneAccess.command("on"), off: phoneAccess.command("off") } });
  void phoneAccess.refresh(); // so a task's first picture already knows whether the phone can reach the Mini App
  app.channels.miniAppUrl = (runId) => {
    const base = app.sessionLock.pinSet() ? phoneAccess.address() : null;
    return base ? `${base}?run=${encodeURIComponent(runId)}` : null;
  };
  if (options.presence) {
    await writeRunning(options.dataDir, { port: address.port, pid: options.presencePid ?? process.pid, url, mode: options.presence, version: app.version }).catch(() => undefined);
    await noteFirstStart(app, options.dataDir).catch(() => undefined);
  }
  return {
    url,
    /** The Telegram Mini App's door (src/miniapp/door.ts) and where the owner's phone reaches it. */
    miniAppDoor, phoneAccess,
    /** The window's key as it is now; removing a phone that was handed it replaces it. */
    get token(): string { return token; },
    remote,
    /**
     * The same handler the paired listener is given. It is exposed so the behaviour that only
     * happens on that door — the question a browser asks before letting a page of the owner's own
     * send anything — can be tested without a Tailscale address and a real network.
     */
    remoteHandler,
    /**
     * mac7/bind: the address the door is really on now, which Lockdown or a change of this
     * computer's addresses can narrow while it runs.
     */
    listeningOn: (): string => listen.address,
    close: async () => {
      closing = true;
      stopWatchingAddresses(); // mac7/bind
      stopDiagnosticLog(); // mac7/diagnostics
      stopWatchingLockdown();
      browserControls.close();
      capturedApiSkills.close();
      miniApp.close();
      app.channels.miniAppUrl = undefined;
      await miniAppDoor.close();
      stopLiveScreen(); // parity-b2: and every live view of the screen, with the program behind it
      phoneApp.stop();
      await narrowing; // mac7/bind: a door coming back on 127.0.0.1 is back before the server stops
      await remote.close().catch(() => undefined); // every door it opened, and none opens after this
      if (options.presence) await clearRunning(options.dataDir).catch(() => undefined);
      await stopServer(app, server);
    },
  };
}
/** Q050: the plain words a task left waiting on an answer already given is closed with. */
export const supersededAskNote = "This question was answered, or overtaken by a later message in the conversation, so it no longer waits for you.";
/**
 * Q050: a yes carried a task on as a second task, so the task that asked was left waiting for good, and the Inbox,
 * Overview and Health kept asking for an answer already given. On start, a task still waiting that is no longer the
 * newest in its conversation (the conversation went on from it) stops waiting, with the reason on its record. Its
 * question is never answered for it: nothing is allowed, and a question still open in this engine is left alone.
 */
export function settleSupersededAsks(app: Branch): number {
  const waiting = app.store.sqlite.prepare("SELECT id FROM tasks WHERE status='needs_input'").all() as { id: unknown }[];
  let settled = 0;
  for (const row of waiting) {
    const run = app.store.run(String(row.id));
    if (!run || app.store.newestIn(run.owner, run.sessionId)?.id === run.id) continue;
    if (app.runtime.approvals.waiting(run.sessionId).some((question) => question.runId === run.id)) continue;
    app.store.event(run.id, "run.ask_resolved", { reason: "superseded", note: supersededAskNote, by: app.store.newestIn(run.owner, run.sessionId)?.id ?? null });
    app.store.finish(run.id, "cancelled", supersededAskNote, { mend: false });
    settled++;
  }
  return settled;
}
/** What a stop leaves a task waiting on: the last of these events says which question it was. */
const askedKinds = new Set(["policy.ask", "user.ask", "attention.needed", "plan.awaiting_approval", "folder.trust_needed", "web.challenge"]);
export const lostQuestionNote = "Branch restarted before you answered its question. Continue it to be asked again, or stop it.";
/**
 * Dogfood F8: an approval question is held in memory, so a task left waiting on one when Branch stopped could never be
 * answered again ("Nothing … is waiting"), could not be stopped, and held every update. On a real start each such task
 * is marked as cut off, with the note the window shows: the owner carries it on (it asks again) or stops it. A question
 * that outlives a restart (one the owner's next message answers, a plan, a check after a restart) is left alone.
 */
function settleLostQuestions(app: Branch): void {
  const waiting = app.store.sqlite.prepare("SELECT id FROM tasks WHERE status='needs_input'").all() as { id: unknown }[];
  for (const row of waiting) {
    const run = app.store.run(String(row.id));
    if (!run) continue;
    // Every question also writes "attention.needed" after it; that one is a question of its own only after a restart.
    const asked = app.store.events(run.id)
      .filter((event) => askedKinds.has(event.kind) && (event.kind !== "attention.needed" || event.data.afterRestart === true)).at(-1);
    if (asked?.kind !== "policy.ask" || app.runtime.approvals.waiting(run.sessionId).some((question) => question.runId === run.id)) continue;
    app.store.finish(run.id, "interrupted", run.output);
    // The call it asked about never ran, so carrying on repeats it without a check first (src/runtime.ts resumeNote).
    // Q223: only when the question was about that call's own tool. The network wall asks about a site after its
    // command has already run, under the command's id, and that command did run.
    const call = typeof asked.data.id === "string"
      ? app.store.events(run.id).find((event) => event.kind === "tool.started" && event.data.id === asked.data.id) : undefined;
    if (call && call.data.name === asked.data.name) app.store.event(run.id, "run.call_not_run", { id: asked.data.id });
    app.store.event(run.id, "run.can_continue", { note: lostQuestionNote });
  }
}
/** Records whether a version that has just replaced another one came up healthy the first time (dogfood F6: the program's own checks). */
async function noteFirstStart(app: Branch, dataDir: string): Promise<void> {
  if ((await readFirstStart(dataDir))?.version === app.version) return;
  await recordFirstStart(dataDir, app.version, startedCleanly(await healthReport(app)));
}
/** Endpoints that write the response themselves (streams and the OpenAI-style chat). */
async function rawApi(app: Branch, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  if (request.method === "GET" && path === liveStagePath
    && new URL(request.url ?? "/", "http://local").searchParams.get("stream") === "1") {
    const session = new URL(request.url ?? "/", "http://local").searchParams.get("session") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(session)) throw new HttpError(400, "Choose a conversation for the live view.");
    const scope = scopeWhileUnlocked(app);
    const readable = () => !!scope && scopeWhileUnlocked(app) === scope && app.store.profiles.isOwner()
      && app.store.ownsSession(scope, session);
    if (!readable()) throw new HttpError(404, "Conversation not found");
    // The stream is read only while the view shows the browser, so it observes plan steps as a fast read does (#996).
    await streamLiveStage({ store: app.store, owner: app.runtime.owner, profiles: app.store.profiles, browser: app.browser,
      plan: session => app.runtime.orchestration.plan(session), observeSteps: true }, session, response, readable);
    return true;
  }
  // ---- bucket 13 (mac4): recordings of a task, the path it took, the run monitor and the event-loop
  // watch (src/run-recording-api.ts). It answers errors itself. ----
  if (handlesRecordingPath(path)) {
    await recordingApi(app, request, response, path, { readBody: () => readBody(request) });
    return true;
  }
  // ---- end of the bucket 13 block ----
  // Batch 19 (wave 7): the counters, as the plain text a monitoring tool reads rather than JSON.
  if (request.method === "GET" && path === "/api/metrics") { metricsResponse(app, response); return true; }
  // Batch 20 (wave 8): what every task wrote down, as one JSON object per line, for a log shipper.
  if (request.method === "GET" && path === "/api/logs") { logsResponse(app, request, response); return true; }
  // Talking to other assistants: the card and the task endpoint, which streams when asked to.
  if (path === "/a2a" || path === "/.well-known/agent.json")
    if (await handleA2a(app.a2a, request, response, path, () => readBody(request, 131072))) return true;
  // Wave 7: everything happening on this computer, filtered by kind, as one live stream.
  if (request.method === "GET" && path === "/api/events/stream") {
    const query = new URL(request.url ?? "/", "http://local").searchParams;
    const kinds = (query.get("kind") ?? "").split(",").map((kind) => kind.trim()).filter(Boolean).slice(0, 20);
    // "after=0" means "everything you have"; leaving it out means "only what happens from now on",
    // so zero has to be told apart from absent rather than treated as nothing.
    const asked = query.get("after");
    const after = asked === null || !/^\d+$/.test(asked) ? undefined : Number(asked);
    await streamOwnerEvents(app.store, app.store.profiles.scope(), response, {
      ...(after === undefined ? {} : { after }), kinds,
      // The stream carries tool arguments and results, so nothing goes out of it carrying a saved
      // password or key; how long it may run and how much it may send are both capped inside.
      scrub: app.runtime.hideSecrets,
      // Q253: an open stream follows who is at the window (as the activity list does since #324). Once
      // the window switches profile it ends, and the window's reconnect opens it under the new scope.
      scopeNow: () => scopeWhileUnlocked(app),
      ...(Number(query.get("maxMs")) ? { maxMs: Number(query.get("maxMs")) } : {}),
    });
    return true;
  }
  // Live steps: one task's step lines while it runs (thoughts, tool calls, questions, helpers), scrubbed, for the window's
  // reply area. Whose task it is follows who is at the window, as the run stream and /steps do (Q254, Q259).
  const live = /^\/api\/runs\/([a-f0-9-]{36})\/live$/.exec(path);
  if (live && request.method === "GET") {
    const run = app.store.run(live[1]!);
    // Live household helpers: a household person also follows their own task's steps while the lending files it under
    // the owner (personTaskHere), and only while it stays theirs to read (asked before every poll).
    const readable = () => {
      const scope = scopeWhileUnlocked(app), now = app.store.run(run!.id);
      return !!scope && !!now && (now.owner === scope || personTaskHere(app.store, app.runtime.owner, now.id));
    };
    if (!run || !readable()) throw new HttpError(404, "Run not found");
    // The list is built again only when something it is made of has changed: a new event of this person's tasks, a
    // thought, a question waiting or answered, or the task's status. Otherwise each poll costs one small read.
    let seen = "", list: ReturnType<typeof liveSteps> | null = null;
    const snapshot = () => {
      const now = app.store.run(run.id);
      if (!now) return null;
      const deps = liveDeps(app);
      const mark = [now.status, app.store.recentEvents(run.owner, 1)[0]?.id ?? 0, app.runtime.thoughtsChanged, app.store.secrets.scrubber.size,
        deps.waiting.map((q) => `${q.runId}:${q.fingerprint ?? ""}`).join(",")].join("|");
      if (mark !== seen || !list) { seen = mark; list = app.runtime.hideSecrets(liveSteps(app.store, run.id, deps)); }
      return list;
    };
    await streamLiveSteps(response, snapshot, { owner: run.owner, scopeNow: () => scopeWhileUnlocked(app), stillHere: readable });
    return true;
  }
  const stream = /^\/api\/runs\/([a-f0-9-]{36})\/stream$/.exec(path);
  if (stream && request.method === "GET") {
    const run = app.store.run(stream[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    const after = Number(new URL(request.url ?? "/", "http://local").searchParams.get("after") ?? 0) || 0;
    // Q254: the stream follows who is at the window, as /api/events/stream does since #339. Once the
    // window switches profile it ends (reason "profile"), and opening it again answers 404 unless the
    // run belongs to whoever is there now.
    await streamRunEvents(app.store, run.id, response, after, { owner: run.owner, scopeNow: () => scopeWhileUnlocked(app), scrub: app.runtime.hideSecrets });
    return true;
  }
  // One kept picture or sound, so the gallery can show it. Anything outside the artifacts folder
  // is refused by RunArtifacts itself, and only kinds the browser can safely display are served.
  if (request.method === "GET" && path === "/api/artifacts/file") {
    const requestingScope = scopeWhileUnlocked(app);
    const wanted = new URL(request.url ?? "/", "http://local").searchParams.get("path") ?? "";
    const entry = (await app.artifacts.list(500)).find((kept) => kept.path === wanted);
    if (!entry) throw new HttpError(404, "That file was not made by the assistant");
    const readable = () => !!requestingScope && scopeWhileUnlocked(app) === requestingScope && ownArtifact(app, requestingScope, entry.runId);
    if (!readable()) throw new HttpError(404, "That file is not available in this profile");
    if (!/^(image|audio)\//.test(entry.mediaType)) throw new HttpError(415, "Only pictures and sounds are shown here");
    const bytes = await app.artifacts.read(entry.path);
    if (!readable()) throw new HttpError(404, "That file is not available in this profile");
    response.writeHead(200, {
      "content-type": entry.mediaType, "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-disposition": `inline; filename="${entry.name}"`,
      "content-security-policy": "default-src 'none'; sandbox",
    });
    response.end(bytes);
    return true;
  }
  // FQ-collaboration: the raw bytes of one video in the workspace, so the Files browser can play it
  // and a comment's timestamp can reopen it at the same position (public/media-comments.js). Held to
  // the same switch as the rest of the code editor, since that is the screen this is opened from.
  if (request.method === "GET" && path === "/api/media-comments/media") {
    if (workspaceEditorSettings(app.store, app.runtime.owner).mode === "off")
      throw new HttpError(403, "The Files browser is switched off. Turn it on in Settings → Advanced to open a video there.");
    const wanted = new URL(request.url ?? "/", "http://local").searchParams.get("fileId") ?? "";
    const played = await readWorkspaceVideo(app.files, wanted, (target) =>
      protectedTarget({ tool: "files.read", readOnly: true, args: { path: target }, target, workspace: app.files.base }, app.runtime.protectedAreas),
    ).catch((error: unknown) => {
      throw error instanceof VideoFileError ? new HttpError(error.status, error.message) : error;
    });
    response.writeHead(200, {
      "content-type": played.contentType, "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(played.name)}`,
      "content-security-policy": "default-src 'none'; sandbox",
    });
    response.end(played.bytes);
    return true;
  }
  // attach-anything: a file sent ahead of its message, streamed straight to disk as it arrives (never held whole in
  // memory), counted as it goes and cut off at the limit. It is bound to whoever sent it (the owner, or the household
  // person at the window), and only a message of theirs can take it. Nothing here is a path: the name is words and
  // the file is kept under a random id. Short-lived keys never reach this (offLimitsToShortLivedKeys: /api/attachments/).
  if (path === "/api/attachments/upload" && (request.method === "POST" || request.method === "DELETE")) {
    const wanted = new URL(request.url ?? "/", "http://local").searchParams;
    if (!app.attachments) throw new HttpError(503, "Files cannot be attached here.");
    const who = app.store.profiles.scope();
    if (request.method === "DELETE") {
      send(response, 200, { removed: await app.attachments.unstage(who, wanted.get("id") ?? "") });
      return true;
    }
    const length = request.headers["content-length"] ? Number(request.headers["content-length"]) : null;
    try {
      send(response, 200, await app.attachments.stage(who, {
        name: wanted.get("name") ?? "", mediaType: wanted.get("type") || "application/octet-stream",
        length: Number.isFinite(length) ? length : null,
      }, request));
      return true;
    } catch (error) {
      // The rest of a refused file is not read; the connection is closed once the answer is written.
      response.setHeader("connection", "close");
      throw new HttpError(/too big|does not fit/.test((error as Error).message) ? 413 : 400, (error as Error).message);
    }
  }
  // A file a person attached, handed back to their own window (src/attachments.ts): the owner's, or a household
  // person's own conversation's, checked first so the guard moves with the route; nothing the caller sends is a path.
  if (request.method === "GET" && path === "/api/attachments/file") {
    const wanted = new URL(request.url ?? "/", "http://local").searchParams;
    // Who may open it is decided at the top of attachmentForWindow, so it cannot be left behind here.
    const found = await attachmentForWindow(
      {
        profiles: app.store.profiles, attachments: app.attachments,
        temporaryConversation: (session) => app.store.sessionTemporary(session),
        ownsConversation: (owner, session) => app.store.ownsSession(owner, session),
      },
      { session: wanted.get("session") ?? "", id: wanted.get("id") ?? "" },
    ).catch(() => null);
    if (!found) throw new HttpError(404, "That file is not attached to this conversation");
    // The type is the one kept with the file, never anything the request said.
    const inline = shownInPage(found.ref.mediaType);
    const headers = {
      "content-type": found.ref.mediaType, "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
      "accept-ranges": "bytes",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${(found.ref.name.split("/").pop() ?? "file").replace(/[^\w. -]/g, "_")}"`,
    };
    const part = rangeWanted(request.headers.range, found.size);
    if (part === "outside") {
      response.writeHead(416, { ...headers, "content-range": `bytes */${found.size}` });
      response.end();
      return true;
    }
    // Sent from the file rather than from a copy of all of it: asking for the first kilobyte of a
    // thirty-megabyte film should not cost thirty megabytes of memory.
    if (part) {
      response.writeHead(206, { ...headers, "content-length": String(part.end - part.start + 1),
        "content-range": `bytes ${part.start}-${part.end}/${found.size}` });
    } else {
      response.writeHead(200, { ...headers, "content-length": String(found.size) });
    }
    const sending = found.open(part);
    sending.on("error", () => response.destroy());
    sending.pipe(response);
    return true;
  }
  if (request.method === "POST" && path === "/api/voice/transcribe") {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("audio/") && !contentType.includes("application/octet-stream")) {
      throw new HttpError(415, "Use audio/* content-type");
    }
    const maxBytes = 25 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) throw new HttpError(413, "Audio exceeds 25 MiB");
      chunks.push(Buffer.from(chunk));
    }
    const audio = new Uint8Array(Buffer.concat(chunks));
    try {
      // One service decides which route writes this out, and refuses outright when the owner has
      // said audio must stay on this computer. The length comes from the recorder, for the cost.
      const seconds = Number(new URL(request.url ?? "/", "http://local").searchParams.get("seconds"));
      const written = await app.voice.transcribe(app.runtime.owner, {
        bytes: audio, mediaType: (contentType.split(";")[0] ?? "audio/webm").trim(), name: "recording",
        ...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}),
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      // Bucket 17 hook: a short phrase such as "stop" is marked as a spoken command (null while that switch is off).
      const command = app.voice.engines?.command(app.runtime.owner, written.text) ?? null;
      response.end(JSON.stringify({ text: written.text, via: written.route, language: written.language, cost: written.cost, command }));
    } catch (e) {
      const msg = errorText(e);
      throw new HttpError(400, msg);
    }
    return true;
  }
  if (request.method === "POST" && path === "/api/voice/speak") {
    const body = z.object({
      text: z.string().max(4000), voice: z.string().max(80).optional(), speed: z.number().min(0.5).max(2).optional(),
    }).strict().parse(await readBody(request));
    try {
      const spoken = await app.voice.speak(app.runtime.owner, {
        text: body.text, voice: body.voice ?? "", speed: body.speed ?? 1,
      });
      response.writeHead(200, {
        "content-type": spoken.mediaType, "cache-control": "no-store",
        "x-voice-route": spoken.route, "x-voice-name": encodeURIComponent(spoken.voice),
      });
      response.end(Buffer.from(spoken.bytes));
    } catch (e) {
      const msg = errorText(e);
      throw new HttpError(400, msg);
    }
    return true;
  }
  if (request.method === "GET" && path === "/api/memory/export"
      && new URL(request.url ?? "/", "http://local").searchParams.get("format") === "jsonl") {
    const jsonl = app.memory.transfer.export(app.runtime.owner);
    response.writeHead(200, {
      "content-type": "application/jsonl; charset=utf-8",
      "content-disposition": 'attachment; filename="memory.jsonl"',
      "cache-control": "no-store",
    });
    response.end(jsonl);
    return true;
  }
  // Wave 6: one conversation as a single page, with keys blanked out, ready to keep or send on.
  const htmlExport = /^\/api\/sessions\/([a-f0-9-]{36})\/export$/.exec(path);
  if (htmlExport && request.method === "GET"
      && new URL(request.url ?? "/", "http://local").searchParams.get("format") === "html") {
    const sessionId = htmlExport[1]!, query = new URL(request.url ?? "/", "http://local").searchParams;
    if (!app.store.ownsSession(app.store.profiles.scope(), sessionId)) throw new HttpError(404, "Conversation not found");
    const redact = RedactionSchema.parse({ secrets: query.get("secrets") !== "0",
      contactDetails: query.get("contactDetails") === "1", toolResults: query.get("toolResults") === "0" });
    const view = app.store.sessionView(app.store.profiles.scope(), sessionId) as { createdAt?: string; title?: string };
    const page = shareHtml({ sessionId, ...(view.createdAt ? { createdAt: view.createdAt } : {}),
      ...(view.title ? { title: view.title } : {}) }, app.store.messages(sessionId), redact);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="conversation-${sessionId.slice(0, 8)}.html"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff",
      "x-branch-share-receipt": JSON.stringify(page.receipt),
    });
    response.end(page.html);
    return true;
  }
  const sessionExport = /^\/api\/sessions\/([a-f0-9-]{36})\/export$/.exec(path);
  if (sessionExport && request.method === "GET"
      && new URL(request.url ?? "/", "http://local").searchParams.get("format") === "markdown") {
    const sessionId = sessionExport[1]!;
    // Q259: conversations belong to whoever's profile is switched on (as the JSON export in sessionApi reads them),
    // so a household person saves only their own; the owner's reads exactly like one that is not there.
    const scope = app.store.profiles.scope();
    if (!app.store.ownsSession(scope, sessionId)) throw new HttpError(404, "Conversation not found");
    const view = app.store.sessionView(scope, sessionId) as { createdAt?: string; title?: string };
    const markdown = conversationMarkdown({ sessionId, ...(view.createdAt ? { createdAt: view.createdAt } : {}), ...(view.title ? { title: view.title } : {}) },
      app.store.messages(sessionId));
    response.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="conversation-${sessionId.slice(0, 8)}.md"`,
      "cache-control": "no-store",
    });
    response.end(markdown);
    return true;
  }
  if (request.method === "GET" && path === "/api/usage/export.csv") {
    const url = new URL(request.url ?? "/", "http://local");
    const range = (url.searchParams.get("range") ?? "30d") as "7d" | "30d" | "90d" | "all";
    const { overrides } = pricingSettings(app.store, app.runtime.owner);
    // Q259: as GET /api/usage: a household person's file holds their own conversations' days only.
    const data = app.store.usageStore().aggregateUsage(range, "day", overrides, app.store.profiles.isOwner() ? undefined : ownConversationOf(app));
    // estimatedCostUsd covers only the tasks with a price; runsWithoutPrice says how many had none.
    // Wave 7: the money columns a spreadsheet needs — what the day cost, what one task cost on
    // average, and the model that cost the most — with an empty cell wherever nobody knows.
    const csv = ["date,runs,toolCalls,tokensInput,tokensOutput,estimatedCostUsd,costPerRunUsd,dearestModel,dearestModelCostUsd,runsWithPrice,runsWithoutPrice,failures"]
      .concat(
        data.map((d) => {
          const dearest = [...d.presets].filter((p) => p.cost !== null).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))[0];
          return [d.date, d.runs, d.toolCalls, d.tokens.input, d.tokens.output,
            d.pricedRuns ? d.estimatedCost.toFixed(4) : "",
            d.pricedRuns ? (d.estimatedCost / d.pricedRuns).toFixed(6) : "",
            csvCell(dearest?.id ?? ""), dearest ? (dearest.cost ?? 0).toFixed(4) : "",
            d.pricedRuns, d.unpricedRuns, d.failures].join(",");
        })
      )
      .join("\n");
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="usage-${range}.csv"`,
      "cache-control": "no-store",
    });
    response.end(csv);
    return true;
  }
  if (request.method === "GET" && path === "/api/audit/export.csv") {
    auditCsvResponse(app, request, response);
    return true;
  }
  // Wave 7: many tasks as JSON Lines, one trajectory per line, for feeding an evaluation run.
  if (request.method === "GET" && path === "/api/runs/trajectories.jsonl") {
    await trajectoriesResponse(app, request, response);
    return true;
  }
  if (request.method === "POST" && path === "/v1/chat/completions") {
    await chatCompletion(app, request, response, await readBody(request, 1024 * 1024));
    return true;
  }
  return false;
}
/**
 * Saved browser sign-ins. "Sign in once" opens a real browser window the person can see and use;
 * only the cookies that keep them signed in are kept, and the assistant is not part of any of it.
 */
async function browserApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (request.method === "GET" && path === "/api/browser/profiles")
    return { profiles: await app.browserProfiles.list(owner), canSignIn: !!app.browser };
  // Settings › Computer & browser › Site skills: the websites the owner's switched-on skills know about, each with the
  // skill it came from and that skill's revision, so Forget (POST /api/skills/<id>/remove) names what was shown.
  if (request.method === "GET" && path === "/api/browser/site-skills") {
    app.store.profiles.requireOwner("Site skills");
    const revisions = new Map(app.store.skills.list(owner).map((skill) => [skill.id, skill.revision]));
    return { sites: siteSkillsFor(app.store as unknown as SiteSkillSource, owner).list()
      .map((site) => ({ ...site, revision: site.skillId ? revisions.get(site.skillId) ?? null : null })) };
  }
  // Wave 7: "Let Branch use my browser for this task". Off unless the owner turns it on, tied to
  // one task, and it runs out on its own after a quarter of an hour.
  if (request.method === "GET" && path === "/api/browser/attach")
    return { settings: readAttachSettings(app.store, owner), refusedSites: refusedHosts.length };
  if (request.method === "POST" && path === "/api/browser/attach")
    return { settings: saveAttachSettings(app.store, owner, await readBody(request)) };
  const body = (await readBody(request)) as { name?: unknown; url?: unknown };
  const name = String(body.name ?? "");
  if (request.method === "POST" && path === "/api/browser/profiles")
    return { profile: await app.browserProfiles.create(owner, name) };
  if (request.method === "POST" && path === "/api/browser/profiles/remove")
    return { removed: await app.browserProfiles.remove(owner, name) };
  if (request.method === "POST" && path === "/api/browser/signin") {
    if (!app.browser) throw new HttpError(400, "The browser is not switched on in this launch's integration settings");
    return { signedIn: await app.browser.signIn(owner, name, String(body.url ?? ""), 240000) };
  }
  throw new HttpError(404, "Not found");
}
/**
 * Wave 6: a shared conversation page. It needs the code the owner was shown, works once, and stops
 * at its expiry. It is served by this app on this computer, so it needs no session key of its own;
 * nothing is published anywhere.
 */
async function sharePage(app: Branch, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  const match = /^\/share\/([a-f0-9-]{36})$/.exec(path);
  if (!match) return false;
  if (request.method !== "GET") throw new HttpError(404, "Endpoint not found");
  const code = new URL(request.url ?? "/", "http://local").searchParams.get("code") ?? "";
  let body: string, status = 200;
  try { body = app.store.shares.open(match[1]!, code); }
  catch {
    // mac7/channel-leaks: the page used to say which of the reasons it was — "that link is not
    // valid", "that code is not right", "already used once", "expired", "closed after too many
    // wrong codes". This address answers before any key, so the difference told anyone who tried a
    // made-up link apart from anyone who had a real one. One page now, for all five.
    status = 403;
    body = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Not available</title></head>`
      + `<body style="font:16px system-ui;margin:3rem auto;max-width:32rem"><h1>This link is not available</h1>`
      + `<p>Ask whoever sent it to share it again.</p></body></html>`;
  }
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(body);
  return true;
}
/** Everything the voice and model-routing screens need, gathered in one place (wave 7). */
/**
 * Every task in the range as JSON Lines, written one line at a time so a thousand of them never
 * become one enormous string first. Only this person's own tasks are in it.
 */
async function trajectoriesResponse(app: Branch, request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Every task at once, messages and tool arguments included, is the owner's own record: a second
  // person's profile may not have it, not even the part of it that belongs to them.
  app.store.profiles.requireOwner("Saved records of your tasks");
  const query = new URL(request.url ?? "/", "http://local").searchParams;
  const limit = Math.min(Math.max(Number(query.get("limit") ?? 50) || 50, 1), 500);
  const runs = app.store.runs(app.runtime.owner).slice(0, limit);
  const options = new Map<string, Awaited<ReturnType<typeof trajectoryOptions>>>();
  for (const run of runs) options.set(run.id, await trajectoryOptions(app, run.id));
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "content-disposition": `attachment; filename="branch-trajectories.jsonl"`,
    "cache-control": "no-store",
  });
  for (const line of trajectoryLines(app.store, runs.map((run) => run.id), (id) => options.get(id)!,
    app.runtime.hideSecrets))
    response.write(line + "\n");
  response.end();
}
/**
 * Everything "Look inside" and a trajectory both need about one task: its receipts, its timeline,
 * and the workspace's own price table so each model round is costed the way the Usage screen does.
 */
export async function trajectoryOptions(app: Branch, runId: string) {
  const receipts = await receiptsView(app, runId);
  const { overrides } = pricingSettings(app.store, app.runtime.owner);
  return {
    receipts, version: app.version, cost: receipts.cost,
    timeline: app.store.usageStore().getRunTimeline(runId),
    price: (model: string, tokens: { input: number; output: number }) => {
      const estimate = estimateCost(model, tokens, overrides);
      return { amount: estimate.amount, display: formatCost(estimate) };
    },
  };
}
/** Live steps: the thoughts held in memory, the questions waiting, and the helpers' names (as /steps names them). */
function liveDeps(app: Branch) {
  return { thoughtsOf: (id: string) => app.runtime.thoughtsOf(id), waiting: app.runtime.approvals.waiting(), helperName: helperNameOf(app),
    scrub: (text: string) => app.runtime.hideSecrets(text) };
}
/** A helper's name, never its raw id (QA Q049): the specialist's name while it is saved, else the name recorded when the
    helper started (run.started agentName), else "A helper". A mode is named by the mode, else its slug. */
function helperNameOf(app: Branch): (agent: string, recorded?: string) => string | null {
  const owner = app.runtime.owner;
  return (agent, recorded) => {
    if (agent.startsWith("mode:")) { try { return app.interop.modes.find(agent.slice(5)).name; } catch { return agent.slice(5); } }
    return specialistName(app.store, owner, agent) ?? (recorded?.trim() || "A helper");
  };
}
/** Pass 17: what GET /api/runs/:id/steps reads — the prices, the questions waiting, the answers given, the chain. */
async function stepsOf(app: Branch, runId: string) {
  const owner = app.runtime.owner, run = app.store.run(runId)!;
  const { price } = await trajectoryOptions(app, runId);
  const helperName = helperNameOf(app);
  return runSteps(app.store, runId, {
    price, waiting: app.runtime.approvals.waiting(),
    decided: app.store.audit.list(owner, { action: "approval.decided", from: run.createdAt, limit: 1000 }),
    chain: { mode: safetyMode(app.store, owner, "activity-chain"), entries: app.safetyExtras.chain.forRun(owner, runId) },
    thinkingOf: (id) => app.runtime.thinkingOf(id), helperName, cost: (id) => runCost(app, id),
  });
}
/** What the metering export needs: the ledger, the workspace it may write into, and the prices. */
function meteringDeps(app: Branch) {
  return {
    store: app.store, owner: app.runtime.owner, workspace: app.files.root,
    overrides: () => pricingSettings(app.store, app.runtime.owner).overrides,
  };
}
/**
 * Who would actually receive the tool descriptions, named, so the sentence the owner reads before
 * switching meaning search on says where their words go rather than gesturing at "a model".
 */
function meaningSearchReceiver(app: Branch, reader: { local: boolean } | null): string | undefined {
  if (!reader) return undefined;
  if (reader.local) return "the model running on this computer, so nothing leaves it";
  const provider = app.runtime.models.plan(app.runtime.owner, "").candidates[0]?.provider.name;
  return provider ? `${provider}, the model service you have connected` : undefined;
}

function voiceDeps(app: Branch) {
  return {
    store: app.store, models: app.runtime.models, owner: app.runtime.owner,
    voice: app.voice, policy: app.web.policy, fetch: app.web.policy.guard(globalThis.fetch),
    // Wave 7: the Gemini card's "Sign in with Google" needs the workspace's OAuth connections.
    oauth: app.oauth,
    liveRefusal: (sessionId: string) => liveRefusalFor(app, sessionId), // phase2/rooms
    liveWaits: (runId: string) => app.live.expect(runId),
  };
}
/**
 * phase2/rooms: Talk live runs its tools as your assistant, so it is refused in a conversation a
 * Trunk answers in (its own chat, one chosen for it, its seat in a room) and in a room: there it
 * would step round the Trunk's own limits.
 */
function liveRefusalFor(app: Branch, sessionId: string): string | null {
  // Integration review: the same words LiveConversations.start answers with (src/live-refusal.ts).
  return app.live.refuse(sessionId);
}
/**
 * Batch 20 (wave 8): the doors a short-lived key never opens, whatever its scope. A "run" key is
 * described to its holder as one that may start a task but may not change what Branch is allowed to
 * do — and naming a program for Branch to run, or writing into the locker, is exactly that. Those
 * two are the owner's own step, in the app window, with the master key.
 */
/**
 * Wave mac3 (commands, integration review): a key that may only look sends its commands with POST
 * too, so what it typed never lands in an address or a log. For that one route its POST counts as
 * looking; `src/commands/api.ts` then lets it carry out only the commands that look.
 */
function commandLook(app: Branch, request: IncomingMessage, path: string, supplied: string): { method: string; executes: boolean } | null {
  if (request.method !== "POST" || path !== "/api/commands/run") return null;
  return app.sessionTokens.scopeOf(app.runtime.owner, supplied) === "read" ? { method: "GET", executes: false } : null;
}

/**
 * The pictures among a message's attachments, in the shape the model is shown. The file itself is
 * kept whatever happens; this is only so a picture does not have to be uploaded twice.
 */
/**
 * What the model looks at this turn: the pictures the page sent to be looked at — a still out of a
 * film — together with the pictures among the files the message carries. The two are different
 * things, so one never hides the other: a message with a film and a photograph shows the model both.
 */
function picturesFor(input: { images?: ImagePart[] | undefined; attachments?: { mediaType: string; name: string; data: string }[] | undefined }): { images?: ImagePart[] } {
  const all = [...(input.images ?? []), ...(picturesAmong(input.attachments).images ?? [])]
    .slice(0, maximumImagesPerTurn);
  return all.length ? { images: all } : {};
}
function picturesAmong(attachments?: { mediaType: string; name: string; data: string }[]): { images?: ImagePart[] } {
  const pictures = (attachments ?? [])
    .filter((one) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(one.mediaType))
    .slice(0, maximumImagesPerTurn)
    .map((one) => ({ mediaType: one.mediaType as ImagePart["mediaType"], data: one.data, name: one.name }));
  return pictures.length ? { images: pictures } : {};
}
/**
 * mac5/key-sweep + mac5/manual-actions (integration review): a tool run by hand with a short-lived
 * key is decided by the one gate (src/tool-gate.ts: never-break, the role, the rules, the leak guard;
 * only "allow" runs). What that gate refuses for the key is answered as the key's refusal, a 401.
 */
async function asKeyRefusal<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (startedWithShortLivedKey() && (error instanceof PolicyRefusedError || error instanceof ApprovalRequiredError))
      throw new HttpError(401, error.message);
    throw error;
  }
}
/**
 * Who is asking over HTTP, for the guards that decide it themselves (the one button, `/adapt`): the
 * app window, as whichever household profile it is switched to, and whether the request came with a
 * short-lived key (a person's own key is one too). A chat app and a Trunk never arrive this way.
 */
function windowCaller(app: Branch): PressContext {
  return { source: "owner", person: app.store.profiles.active()?.id ?? null, shortLivedKey: startedWithShortLivedKey() };
}
/** mac3/security-check: a server tried from Settings is looked up in the malware list before it starts. */
async function vetTriedServer(app: Branch, input: unknown): Promise<void> {
  const server = (input as { server?: { transport?: unknown; command?: unknown; args?: unknown } } | null)?.server;
  if (server?.transport !== "stdio" || typeof server.command !== "string") return;
  await app.security.malware.vet(server.command, Array.isArray(server.args) ? server.args.map(String) : []);
}
function isExecution(request: IncomingMessage, path: string): boolean {
  return (
    (request.method === "POST" && (handlesTasteApiPath(path) || path === capturedApiSkillsPath || path === "/api/self-development/publications/retry")) ||
    request.method === "POST" && (["/api/run", "/api/commands/run", "/api/action", "/v1/chat/completions", "/api/restore", "/api/deployment/restore-point", "/api/deployment/close", "/a2a", "/api/tools/try", "/api/tools/forget", "/api/tools/meaning-search", "/api/tools/context", "/api/firewall/test", "/api/sandboxes", "/api/os-sandbox", "/api/limits", "/api/host-bridge/run"].includes(path) || /^\/api\/(sessions|memory|skills|chatgpt|projects|secrets|channels|teams|registry|evaluation|documents|browser|agents|plugins|local-models|connections|monitors|brief|ask-first|retrieval|issues|practice|workflows|queue|profiles|labels|shares|calendar|knowledge|tracing|rules|flows|deferred|processes|skill-revisions|plugin-catalog|developer|studies|batch|artifacts|reports|todos|obsidian|log|remotes|marks|retention|heartbeat)(\/|$)/.test(path) || /^\/api\/mcp\/(try|signin|servers)(\/|$)/.test(path) || /^\/api\/clis(\/|$)/.test(path) || /^\/api\/triggers\/[a-f0-9-]{36}\/fire$/.test(path) || /^\/api\/runs\/[a-f0-9-]{36}\/replay$/.test(path) || /^\/webhooks\/(whatsapp|chat)\//.test(path))
    // mac4/bucket-20: an Agent Protocol step, and every change under /api/interop, start or change work.
    || (request.method !== "GET" && handlesInteropPath(path))
    // mac6/bucket-23: every change under /api/asks may start work (an answer, an article, a send).
    || (request.method !== "GET" && handlesAsksPath(path))
    // r17-b: every change under /api/autonomy may start work (a schedule, an order's turn, a procedure).
    || (request.method !== "GET" && handlesAutonomyPath(path))
    // R17-A: every change under /api/trunks may start work (a Trunk's turn, a room's rounds).
    || (request.method !== "GET" && handlesTrunksPath(path))
    // mac7/r17-d: every change under /api/coding may start work (a snapshot, the checks, a fork).
    || (request.method !== "GET" && handlesCodingPath(path))
    // R17-C: every change under /api/personal may reach an outside service or start a program.
    || (request.method !== "GET" && handlesPersonalPath(path))
    // r17-i: every change under /api/reach may start work (a task elsewhere, a video, a send, an import).
    || (request.method !== "GET" && handlesReachPath(path))
    // mac7/r17-g: every change under /api/safety-extras may run something (a WebAssembly add-on).
    || (request.method !== "GET" && handlesSafetyPath(path))
    // r17-h: every change under /api/flows-boards may start work (a flow copy, a procedure, a card's task).
    || (request.method !== "GET" && handlesFlowsBoardsPath(path))
    // R17-F: every change under /api/learning-more may ask a model or an outside service.
    || (request.method !== "GET" && handlesLearningMorePath(path))
    // Seasons: running a night asks a model, and undo and veto change what is remembered.
    || (request.method !== "GET" && handlesSeasonsPath(path))
    // mac7/learn: building a map reads the whole folder, and a tour may ask a model.
    || (request.method !== "GET" && handlesLearnPath(path))
  );
}
function configureLimits(server: Server): void {
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  // Node's own 5 seconds let the server drop an idle connection just as the window (or any fetch
  // pool) sent its next request down it, which arrives as ECONNRESET after a few quiet seconds.
  server.keepAliveTimeout = 65000;
  server.maxHeadersCount = 40;
}
async function stopServer(app: Branch, server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  const schedulesStopped = app.scheduler.stop();
  await app.runtime.shutdown();
  await schedulesStopped;
  server.closeAllConnections();
  await closed;
}
