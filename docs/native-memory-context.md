# Native memory context

RES-321 / TRUNK-105 adds optional native Mem0 self-hosted and Honcho v2 recall/sync alongside
accepted Branch facts. It ships off. Library → Managing what it reads → Native memory context
selects an existing service, its base address, optional locker name, the exact locker project,
and whether a loopback connection forwards to another computer. Opening or saving settings
makes no service request and installs nothing. Advanced text/time limits are available through
the owner-window `/api/memory/native` settings API.

Only the owner's own lasting app or CLI conversations participate. Tasks from keys, phones,
channels, people, helpers, Trunks, isolated work and practice runs do not. Before model work,
native recall can add up to the configured estimated token budget as explicitly untrusted
context. Completed turns asynchronously sync bounded, scrubbed prompt/output text. Defaults
are 450 characters per message, 300 estimated context tokens and an eight-second timeout per
request. Accepted fact records, their revisions/tombstones, tool receipts, attachment bytes
and image-reference metadata are not exported; explicit resource/image URIs are redacted from
text. The service's inferred output never becomes an accepted Branch fact.

The current profile, origin, session ownership, temporary-session flag, task permissions,
approval policy, Lockdown, app lock, local-only routing and selected settings are checked
before requests and after asynchronous boundaries. A captured validator runs immediately
before recalled context is published. Network policy applies to the actual target before
locker access and again before dispatch, including explicit loopback host/path denials.
Forwarded services remain outside for local-only tasks. Lock and shutdown cancel tracked
native work; configuration changes cancel work paired with the earlier destination.

Each connection creates a random namespace belonging only to this Branch owner. Durable
destination intent, including the original endpoint, provider, project/name credential
references and locality flag, is written before upload. No credential value is journaled.
Mem0 uses the namespace as `user_id`, filters returned metadata and disables inference.
Honcho uses a dedicated generated workspace, per-session IDs and person/assistant peers.
It never chooses a shared user or configured shared workspace.

Your data lists outside destinations, including forwarded loopback services. Delete everything
captures all recorded native destinations in the same transaction as the local purge, blocks
further sync/recall, and retries native deletion through the existing durable cleanup journal.
Mem0 deletes only the generated `user_id` and verifies the scoped list is empty; its current
server requires an admin-capable credential for bulk deletion. Honcho deletes only the generated
workspace, including its derived conclusions. A queued (202) response stays pending until a retry
confirms absence. Offline services, unavailable credentials or changed/removed settings stay
pending. Earlier settings can be filled from the chooser, then saved with their original locker
project/name to finish cleanup. Removing configuration never cancels the journal. Requests
cannot prove deletion inside a service that falsely acknowledges or hides retained data.

This stack also fixes the selected Qdrant/Chroma connection's locker project: resave a connection
from #1036 once in its intended project before resolving its key. The saved project is used at
runtime rather than whichever project becomes active later. This depends on #997 and #1036;
it preserves the existing accepted-fact backend and its revision/forget protections.

Source versions, actual adapted helpers and upstream licenses are in THIRD_PARTY_NOTICES.md.
No tests, builds or service calls were run at the owner's request; CI is skipped. Native service
compatibility and lifecycle behavior remain unvalidated. Mem0 Cloud APIs are not the self-hosted
contract implemented here. Multi-agent shared sync, other named stores and pluggable session
storage remain separate RES-321 gaps. QMD remains explicitly declined. A lost sync response can
cause duplicate service context if the caller later sends the turn again; no exactly-once claim
is made. Roll back by setting the provider off; retained data still needs its journaled cleanup.
