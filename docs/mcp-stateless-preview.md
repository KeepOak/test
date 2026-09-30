# Stateless MCP opt-in

Legacy connections continue to use SDK 1.30.0. The opt-in 2026-07-28 path uses the official TypeScript SDK's client, server and core packages, pinned to 2.2.0. These dependencies replace the handwritten preview transport and provide modern wire codecs, discovery, method/header validation, MRTR, cancellation, and request-scoped subscription routing. Published metadata declares MIT; the original package license also carries the project's Apache-2.0 transition notice and original license texts, retained in third-party notices.

## Server

In the owner-local MCP sharing settings (`POST /api/mcp/settings`), set `statelessPreview: true` alongside `enabled: true` and the shared tool choices. `/mcp` serves discovery, tools, resources, prompts and `subscriptions/listen` through the SDK. Tool execution uses the original registry, runtime, receipts, source `mcp`, capped policy and native owner questions. `branch.ask` uses the real runtime with shared permissions and the request's cancellation signal.

Every HTTP request supplies modern per-request metadata and matching routing headers. Existing authentication, origin and caller guards run before the SDK. Modern GET/DELETE session operations are refused. HTTP bodies are bounded at 64 KiB and subscriptions at 32. Disconnect cancels the request; owner, sharing, policy, registry-generation, lock and Lockdown changes close streams. Resource notifications contain URIs, not task contents.

### Owner approval and MRTR

When native approval remains pending, `input_required` returns a random opaque `requestState`. A retry binds it to the same authenticated principal, owner, exact tool/argument fingerprint and registry generation. State expires after ten minutes, is bounded to 100 pending calls, and is consumed before effects. Concurrent retries are refused. A retry neither creates another question nor executes until the native owner has answered and current policy still permits the call. Client `inputResponses` never grant Branch permission. Restart, owner change and token expiry invalidate pending state.

Calls are rate limited per hashed authenticated principal and bounded by the existing concurrent-call limit. Credentials are not included in state or persisted as principals. Tool arguments and results follow the existing credential redaction and receipt paths.

## Client and stdio

HTTP and stdio configurations accept `protocol: "stateless-preview"` or `protocol: "auto"`; omission remains legacy. Preview pins 2026-07-28 through SDK discovery. Auto may negotiate legacy before tool execution, then uses the existing legacy connection path. Reviewed server-version, tool allowlist, schema size, pagination, child environment and credential checks still apply. Modern calls echo request state byte-for-byte with fresh request IDs and at most ten rounds in a two-minute flow, with thirty-second transport requests. Pending native approval can be retried by the same task; other tasks do not inherit that state. Undeclared interactive capabilities are refused.

The modern client advertises the UI extension only when Apps is enabled, reads only the reviewed tool's declared UI resource and passes it through the existing sandbox/nonce bridge. App tool calls keep the original server and permission boundaries and the existing native confirmation; this integration adds no second confirmation for the same App call. App-only tool visibility and cached UI metadata remain intact.

Form, sampling and roots capabilities are advertised only when the visible unlocked owner window and saved per-server settings enable them at connection time. Embedded MRTR requests are fulfilled through the existing owner-request forms, with at most eight requests per round and the same rate and size limits. Each request is bound to the initiating live run, owner, exact tool permission and signal. Sampling retains the allowed model/provider/token constraints, reserves the initiating task's step/token budget, and records its parent run. Each roots request asks the owner before returning just that task's workspace root. Decline/cancel does not restore a prior answer, and request responses are carried only to the immediate next MRTR leg.

With server sharing's modern opt-in enabled, CLI stdio uses SDK `serveStdio` and pins modern connections; legacy openings on that opted-in stdio process are refused. With the opt-in off, the existing legacy stdio server remains. Stdio subscriptions receive Branch's resource/tool changes and close on access changes or EOF. A modern process does not silently fall back after negotiation.

## Scope and evidence

Custom logging/progress and task extensions are not advertised by this adapter. The server offers its implemented registry/resource/prompt methods; it does not advertise UI resources or interactive client features it does not host. The official SDK validates modern method schemas and envelopes, while Branch validates its restricted interactive forms and sampled messages. Full protocol/extension conformance and external interoperability remain unverified without runtime validation.

Only source inspection, official source/API review, dependency lock resolution with lifecycle scripts disabled, and whitespace validation were performed. No tests, builds, servers, runtimes, credentials or providers were exercised.

Primary references: [2026 protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).

Official implementation references: [SDK v2.2.0](https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.2.0), [HTTP factory](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md), [MRTR](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/input-required.md), [stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md). Original dependency licenses remain in their packages and packaged dependency notices.
