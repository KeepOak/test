// Public API. Runtime entries import branch.js directly, so unused public exports do not load at startup.
export { createBranch } from "./branch.js";
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
export * from "./keepoak-connection.js";
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
export * from "./vector-store-remote.js";
export * from "./vector-store-pinecone.js";
export * from "./native-memory.js";
export * from "./native-memory-clients.js";
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
export * from "./voice-whisper.js"; // RES-709
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

export * from "./routine-usage.js";
