# Pinecone vector store

RES-321 adds Pinecone to Library's vector-store chooser, stacked on #1077's pinned locker
project repair and the #1036/#997 vector/embedding separation. Use the data-plane base address
of an existing dense cosine serverless index and an optional locker reference. Saving settings
does not contact Pinecone, create an index or install anything. The native protocol version is
2026-07, taken from the pinned official TypeScript client's actual generated source.

Before upload or search, the adapter reads native index statistics and requires cosine similarity
and the selected embedding dimension. Other metrics, sparse indexes or missing compatibility
fields fail closed. Embedding route/model/version and dimension stay isolated in generated
Branch namespaces. A different dimension requires a different compatible existing index; no
vector conversion is attempted. Only vectors, passage IDs and fingerprints are sent, with no
passage text or hosted embedding call. Native list/fetch pagination feeds fingerprints and
scoped document/collection deletion; search validates returned namespace and metadata.

The existing network policy, configuration pairing and late exact-project locker resolution
apply before every request; active configuration/policy are rechecked after response waits.
The shared factory also rechecks the current owner profile/role, app lock and Lockdown before
each vector request and after response waits, including the earlier Qdrant/Chroma adapters.
The chooser also marks forwarded loopback services as outside for local-only tasks, for all
native vector backends. This locality field is included in the existing captured cleanup
configuration. Your data inventory includes such forwarded destinations.

Delete everything retains the currently selected destination in the existing journal. Native
cleanup inventories only strict Branch namespaces for this owner, validates all returned passage
metadata before namespace deletion, sends `deleteAll:true` only with each generated namespace,
and verifies their count is zero. It never deletes the index or another owner's namespace. The
service's eventual consistency may leave cleanup pending after a successful deletion response;
retry once statistics settle. An unavailable/removed/changed connection retains pending cleanup
and blocks new meaning indexing until the original connection is restored. Earlier destinations
left by switching still need owner cleanup, as documented for #1036.

The adapter bounds index inventory to 2,048 namespaces and reading to 50,000 passages per
namespace; responses are capped at 8 MiB, list pages at 100 IDs, fetches at 32 and upserts at 64
vectors. Pinecone's native listing requires serverless indexes. No tests, builds, app runs or
service calls were run at the owner's request; compatibility and UI/runtime behavior remain
unvalidated and CI is skipped. Exact source files/license modifications appear in
THIRD_PARTY_NOTICES.md. Other named vector/session adapters remain separate RES-321 gaps;
QMD remains declined. Roll back by selecting Branch's database and retaining pending cleanup
for the original index namespace.
