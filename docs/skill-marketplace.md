# Skill marketplace

Add a skill → Skill library opens an owner-curated catalogue of HTTPS registry indexes. The owner can save up to ten sources, browse and search their entries, and inspect a document before approving an inactive install. No trusted public catalogue is shipped. Adding a source does not pin its advertised signing key.

Sources use the existing `branch-skill-registry` version 1 or signed version 2 format in `src/registry-install.ts`. Its network policy, redirect refusal, 500-entry/512-KiB index limit, 48-KiB document limit, SHA-256 verification and pinned Ed25519 signature checks apply. Documents must also pass the existing SKILL.md parser (16,000 characters). Publisher descriptions and documents are escaped in the UI. They are untrusted content, not instructions to the app.

Inspect shows the fetched document, source and document URLs, fingerprint, signature status and existing static scanner findings. A matching fingerprint proves consistency; a pinned valid signature identifies the publisher. Neither proves safety. The scanner does not execute code or certify behavior. Review findings follow the existing owner's block/review skill policy.

The app keeps at most eight inspection tickets for ten minutes. Approve this inactive install consumes its ticket once, fetches and compares the exact entry/document/metadata/findings/trust again, and rechecks owner, source, session lock, lockdown and current trust immediately before the synchronous inactive installer. Changed content or trust requires a fresh inspection. Short-lived keys, signed-person calls and non-owner profiles cannot use the marketplace. There is no model tool for approval.

Publisher key trust has its own explicit confirmation displaying the source and fingerprint. Verify that fingerprint independently before approving it. Existing registry trust storage remains local; catalogue sources are also excluded from portable backups so restoring data does not endorse a source on another computer.

This implementation installs one SKILL.md through the existing registry protocol. It does not import plugin archives, scripts or reference files, adapt the ClawHub API, activate a skill, or replace the separate pinned GitHub import. PRs #1094 (GitHub import), #985 (metadata), #1051 (stronger scanning) and #1066 (references) remain complementary changes; their unmerged behavior is not claimed here. Catalogue strings currently use English. Runtime/provider and test validation remain outstanding for this code-only delivery.
