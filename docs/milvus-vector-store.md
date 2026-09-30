# Milvus vector store

RES-321 adds Milvus to the existing Library vector chooser. Name the existing service's base
address, database (default `default`) and optional locker token reference. The address excludes
the native `/v2` suffix, which the adapter appends. A token is sent as Authorization Bearer,
following the actual Node HTTP client. Saving settings makes no request and installs nothing.
The adapter depends on #1087/#1077/#1036/#997's guarded, pinned-project vector/embedding stack.

On first upload, only a generated Branch collection for this owner, embedding generation and
dimension is created, with a nonautomatic VarChar primary key, FloatVector field, dynamic
metadata and COSINE index. The returned native schema and index are checked before upload or
search, and a matching collection is loaded if needed. Neither incompatible dimensions nor
equal-sized different model/version generations are mixed. Stored rows contain vectors and
owner/collection/document/chunk identifiers, model identity and fingerprints, with no text.

Native upsert/search/query/delete routes implement the live knowledge-base backend. Strong
`count(*)` queries and strictly ordered primary-key pagination feed fingerprints and bounded
inventory. A changed inventory, incompatible schema, nonzero service result code, omitted
metadata or an unordered/repeated cursor fails visibly. This requires a native v2 server that
supports `orderByFields` and the schema fields documented by the pinned actual server source.
The code was reviewed against those source contracts, not a running service.

Delete everything journals the current connection and deletes only this owner's entities in
strict Branch collection namespaces. Each owner/collection/document filter is explicit. A
Strong zero-count query confirms removal; no database, service collection or other owner's
entries are dropped. Offline/removed/changed settings, denied policy, unavailable key or
remaining counts retain pending cleanup. Restore the original selected connection/project
reference to retry. As with #1036, earlier destinations left by switching require owner cleanup.

Current owner/profile/role, lock, Lockdown, forwarded-loopback locality, network policy,
configuration pairing and late exact-project locker resolution retain the existing gates.
Bounds are 2,048 listed collections, 50,000 passages per generation, 128-row inventory pages,
64-row uploads, 100 search hits and 8 MiB responses. The server's own limits can refuse a request.
Source attribution and full Apache-2.0 texts appear in THIRD_PARTY_NOTICES.md and licenses/.
No tests, builds, app runs, service calls or real credentials were used at the owner's request;
CI is skipped and runtime/compile/UI/service compatibility remains unvalidated. Other named
vector/session adapters remain gaps and QMD remains declined. Roll back by selecting Branch's
database and retain the original connection journal to finish namespace entity cleanup.
