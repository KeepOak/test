# Teams transcript notes

This increment of RES-123 supports an existing Teams transcript, private manual editing, and an explicitly approved append to an existing Google Docs tab. It remains partial meeting-bot coverage.

The composer + menu and Voice advanced settings open the same form. The owner names a Microsoft account ID and Teams URL, then presses **Approve transcript access and fetch**. Existing delegated Graph account permissions and personal connector enablement apply. Work/school accounts, calendar-backed nonexpired meetings, an existing transcript and tenant Graph transcript permission are required. Personal Microsoft accounts, live events and calendarless online meetings are unsupported by this API. Existing provider errors are shown; no recording is started or enabled.

The returned normalized transcript excerpt is edited privately, up to 6,000 characters. This form invokes no model. Source account, meeting and transcript IDs accompany the draft. SHA-256 covers the connector's normalized text capped at 60,000 characters, not the complete original VTT. Metadata is untrusted and escaped in the window. No attendees are fetched or inferred.

The owner names a Google account ID, existing document ID and tab ID, then reviews the exact title, destination, revision and appended text. The preview warns that all document readers may see the notes; this increment does not inspect the document's audience. A separate **Approve append to document** press consumes a one-use, ten-minute ticket before sending. Source drafts expire after thirty minutes, eight concurrent drafts/previews are permitted, and tickets and note content are not persisted. Account changes, disabled source access, non-owner profiles, chat identities, short-lived keys, Lockdown, remote doors and app lock fail closed. Guards run again at fetch boundaries. Google reconsent for the explicit Docs write scope and requiredRevisionId checks reuse PR #1213. Provider acknowledgement is reported without claiming read-back or recipient delivery.

Guest joining, browser bots, live recording/transcription, Meet, Zoom, automatic summaries, calendar autojoin, inferred guest addresses and mail delivery are not implemented. The existing unavailable guest-join controls stay unavailable. Joining requires a separate consent-aware recording integration; upstream OpenClaw/Hermes bot code was inspected as reference, not copied or executed. No new dependencies.

Stack prerequisite: PR #1213 (`feat/docs-clickup-confirmed-writes`), including multiple personal accounts from #1142. Narrow shared seams: personal construction, Microsoft transcript source IDs, the authenticated HTTP dispatch, composer action registration and Calls settings. No MCP/runtime modification.

Source review only; no tests, builds, application, OAuth, provider, model, database or credential execution was performed under the delivery instruction. Live end-to-end verification remains required before release.

Primary protocol references: [Microsoft list transcripts](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts?view=graph-rest-1.0), [Docs concurrency and tabs](https://developers.google.com/workspace/docs/api/how-tos/best-practices), [Docs insertText](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request).
