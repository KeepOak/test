# Elasticsearch vector store

RES-321 adds a native Elasticsearch choice in Library. Supply an existing service base address
and optional locker reference containing the encoded Elasticsearch API key, without an `ApiKey`
prefix. The adapter supplies Authorization ApiKey. Saving configuration makes no service request.
This stacks on #1100/#1087/#1077/#1036/#997; #1091's factory extraction retains the shared guards.

The first upload creates only a generated owner/model-version/dimension index, with strict keyword
metadata and an explicitly indexed float dense_vector COSINE mapping. Every upload, search,
inventory or cleanup validates the returned mapping and actual physical index name; an alias or
incompatible schema fails. Stored rows contain vectors and passage identifiers/fingerprints, with
no text. Native individual document indexing uses refresh and disables the default ingest pipeline;
a configured final pipeline remains a service responsibility, and incompatible responses fail.

Search uses exact native script-score cosine similarity with an owner/collection filter and an
explicit scan cap. Branch removes the positive-score offset before applying its cosine threshold.
The native dense-vector dimension ceiling is 4,096. The index may be refused by a service that
disables expensive queries or scripting. This is not an approximate kNN implementation. Indexing
one document per request is slower than bulk ingestion but retains the existing bounded guarded
JSON transport without a new dependency.

Fingerprint inventory uses a sortable keyword id, search_after pages and complete hit totals.
Shard failures, timeouts, nonexact totals, mismatched owner/generation/id, repeated cursors or
changed counts fail visibly. Limits are 2,048 matching generation indexes, 50,000 passages per
generation, 128 inventory rows, 100 search hits and 8 MiB responses. Closed/hidden generated indexes
are included in mapping discovery; an unavailable index keeps cleanup pending instead of being
silently omitted. Inventory is not a transactional snapshot of concurrent external modifications.

Delete everything retains the existing selected-connection journal and runs native delete_by_query
only against exact Branch generation indexes with an explicit owner filter. It waits for completion,
rejects timeout/version conflicts/failures, refreshes and verifies an owner-scoped zero count. It
never drops indexes or deletes other owners' entries. Offline/changed/removed configuration or
unavailable keys retain pending cleanup. A timed-out server operation may continue, so retry and
verification remain necessary. Earlier destinations left by switching require owner cleanup.

Current owner/profile/role, lock/Lockdown, network policy, forwarded-loopback locality, configuration
freshness and late pinned-project locker resolution reuse the existing gates. Source adaptation
uses the actual Apache-2.0 official JavaScript client request helpers, with full license/attribution.
The differently licensed server mapper was inspected for protocol compatibility only; no server
code was copied. The native cosine formula and mapping limits were checked in official
[script-score](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-script-score-query)
and [dense-vector](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dense-vector)
documentation.

Only static source/diff review was performed. Tests, builds, app/service execution and actual
credentials were not used at the owner's request; CI skipped. Compile/UI/runtime/service acceptance
remains unvalidated. Other named adapters/session contracts remain pending; QMD remains declined.
Rollback by choosing Branch's database and retaining the original connection journal for cleanup.
