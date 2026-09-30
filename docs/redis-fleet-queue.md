# Optional Redis fleet coordination

RES-339 / A1378 asks for distributed queue coordination for multi-machine fleets. Branch's SQLite `RunQueue` remains the executor on this computer. This optional adapter coordinates prompt **data** across computers; it does not start work, move execution authority, copy credentials, or replace the local scheduler.

The adapter speaks the [Redis REST JSON command protocol](https://upstash.com/docs/redis/features/restapi) over HTTPS to an owner-configured compatible endpoint supporting Redis 7+ `EVAL` and `TIME`. There is no Redis client dependency or raw TCP connection. Tools register with the existing Fleet switch; both Fleet and this adapter must be enabled explicitly.

## Owner configuration

In the unlocked owner window, the existing authenticated local API accepts `GET` and `POST /api/interop/redis-queue`. GET returns only settings and locker names. POST accepts exactly one of:

```json
{"mode":"off"}
```

```json
{"mode":"on","endpoint":"https://YOUR-REDIS-REST-HOST/","fleet":"12345678-1234-4234-8234-123456789abc","project":"default","tokenName":"REDIS_FLEET_TOKEN"}
```

The example is configuration syntax, not a provisioned service. Save the token through the existing project locker. Only the named token in the current active project can be resolved; another project is refused. Endpoint credentials, paths, query strings and fragments are refused. Use the same owner identity and fleet UUID on participating computers to share one queue. Different owners or fleet UUIDs have separate cluster hash-tagged key namespaces. Changing settings aborts active calls.

Use a dedicated compatible database or a restricted Redis ACL token permitting the declared `branch:fleet:{FLEET:OWNER_DIGEST}:*` keys and `EVAL`, `TIME`, `TYPE`, `EXPIRE`, `ZRANGEBYSCORE`, `ZREM`, `ZCARD`, `ZSCORE`, `ZADD`, `ZRANGE`, `HGET`, `HSET`, `HDEL`, `HLEN`, `SET`, and `INCR`. Actual ACL syntax/availability belongs to the service. Never paste a token into a prompt or endpoint. Known secrets are scrubbed before prompt upload and after claim decoding; scrubbing cannot discover arbitrary unknown secrets in text.

## Registered tools and guarantees

- `fleet.queue.submit`: stable UUID `id` and scrubbed `prompt`. Repeating the same queued UUID/payload is idempotent; differing queued payloads report `conflict`. Completed UUIDs report `completed` while their bounded receipt remains. Never reuse job IDs for different work.
- `fleet.queue.claim`: optional `leaseSeconds`, default 60, range 15–300. Returns one job, opaque lease token and Redis-clock expiry. No process or model is started.
- `fleet.queue.complete` / `fleet.queue.release`: exact UUID and token, from the same claiming owner turn on the same process. Expired or superseded tokens report `stale` and cannot remove or release a replacement lease.
- `fleet.queue.status`: waiting and leased counts. Expired leases count as leased until reclaimed.

All operations use one fixed bounded Lua script with seven declared keys in one Redis cluster slot. Up to five expired leases are reclaimed per claim. Queue size is 100 pending plus leased jobs; each prompt is at most 8,000 characters and its serialized job at most 12,000 bytes. Completion receipts become eligible for pruning after 24 hours and are capped at 1,000; a full receipt store refuses completion before removing the job. Eligible receipt pruning is bounded to 100 per call, so receipts can remain longer when idle. Queue keys expire after seven days without submit/claim/complete/release activity, so this is not archival storage; status reads do not extend retention. A Redis restart/eviction, incompatible API, operator key edits, or TTL expiry may lose queue data. Dedicated queue keys must not be edited out of band.

Leases provide at-least-once delivery, not exactly-once execution. A crashed or timed-out consumer can have performed an external action before its lease expires. Consumers must independently make effects idempotent and revalidate local owner permissions, source, sandbox, budget and approval before any execution. The tool never imports the submitting machine's authority. Release/claim after restart requires a new lease; leases cannot be renewed. Automatic fleet workers, authority transport, native RESP/TCP Redis, general Redis memory storage, and a Settings GUI for these fields are not implemented.

Calls require the unlocked owner, original `source: owner`, `specialists.use`, Fleet enabled, current-project locker scope and unrestricted permitted network scope. Isolated/dry runs, short-lived keys, no-internet and narrower OS network walls are refused. Existing host/path/private-address policy and DNS-pinned TLS transport apply; no redirects are followed. Scope/settings/policy are rechecked after credential resolution, after DNS judgment immediately before bytes, during calls and before returning data. Calls have a 15-second deadline, at most two concurrent operations, and a 64 KiB/1,024-chunk response ceiling. Server/transport error text is suppressed; writes are never automatically retried. If a request fails after sending, its outcome is unknown: inspect state and use the same submission UUID, and do not blindly execute a newly claimed job.

## Source and license

The queue script and adapter are original Branch code. Protocol references: [Upstash REST](https://upstash.com/docs/redis/features/restapi), [Redis EVAL and declared keys](https://redis.io/docs/latest/commands/eval/), [Redis TIME](https://redis.io/docs/latest/commands/time/). No Redis server or SDK implementation is copied, installed or bundled. The upstream [Redis license](https://github.com/redis/redis/blob/unstable/LICENSE.txt) distinguishes Redis 8's tri-license and older versions; operators choose their own service/version and terms. This change adds no third-party dependency or source-license obligation.

Development verification is source inspection and `git diff --check` only. No tests, builds, Redis/network calls, credential reads, apps or runtime were executed for this change; interoperability and runtime behavior remain unproven.
