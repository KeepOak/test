# Stateless MCP opt-in

Legacy connections continue to use SDK 1.30.0. The opt-in 2026-07-28 path uses the official TypeScript SDK's client, server and core packages, pinned to 2.2.0. These dependencies replace the handwritten preview transport and provide modern wire codecs, discovery, method/header validation, MRTR, cancellation, and request-scoped subscription routing. Published metadata declares MIT; the original package license also carries the project's Apache-2.0 transition notice and original license texts, retained in third-party notices.

## Server

In the owner-local MCP sharing settings (`POST /api/mcp/settings`), set `statelessPreview: true` alongside `enabled: true` and the shared tool choices. `/mcp` serves discovery, tools, resources, prompts and `subscriptions/listen` through the SDK. Tool execution uses the original registry, runtime, receipts, source `mcp`, capped policy and native owner questions. `branch.ask` uses the real runtime with shared permissions and the request's cancellation signal.

Every HTTP request supplies modern per-request metadata and matching routing headers. Existing authentication, origin and caller guards run before the SDK. Modern GET/DELETE session operations are refused. HTTP bodies are bounded at 64 KiB and subscriptions at 32. Disconnect cancels the request; owner, sharing, policy, registry-generation, lock and Lockdown changes close streams. Resource notifications contain URIs, not task contents.

### Owner approval and MRTR

When native approval remains pending, `input_required` returns a random opaque `requestState`. A retry binds it to the same authenticated principal, owner, exact tool/argument fingerprint and registry generation. State expires after ten minutes, is bounded to 100 pending calls, and is consumed before effects. Concurrent retries are refused. A retry neither creates another question nor executes until the native owner has answered and current policy still permits the call. Client `inputResponses` never grant Branch permission. Restart, owner change and token expiry invalidate pending state.

Calls are rate limited per hashed authenticated principal and bounded by the existing concurrent-call limit. Credentials are not included in state or persisted as principals. Tool arguments and results follow the existing credential redaction and receipt paths.

## Client and stdio

HTTP and stdio configurations accept `protocol: "stateless-preview"` or `protocol: "auto"`; omission remains legacy. Preview pins 2026-07-28 through SDK discovery. Auto may negotiate legacy before tool execution, then uses the existing legacy connection path. Reviewed server-version, tool allowlist, schema size, pagination, child environment and credential checks still apply. Modern calls echo request state byte-for-byte with fresh request IDs and at most ten rounds in a thirty-second window. Pending native approval can be retried by the same task; other tasks do not inherit that state. Undeclared interactive capabilities are refused.

With server sharing's modern opt-in enabled, CLI stdio uses SDK `serveStdio` and pins modern connections; legacy openings on that opted-in stdio process are refused. With the opt-in off, the existing legacy stdio server remains. Stdio subscriptions receive Branch's resource/tool changes and close on access changes or EOF. A modern process does not silently fall back after negotiation.

## Scope and evidence

MCP Apps bridge, embedded elicitation, sampling, roots, custom logging/progress and task extensions are not advertised by this adapter. The parallel legacy Apps bridge requires explicit modern capability and resource-wrapper integration before it can be enabled here. SDK support for a protocol feature does not by itself enable a Branch feature. No full conformance or external interoperability claim is made without runtime validation.

Only source inspection, official source/API review, dependency lock resolution with lifecycle scripts disabled, and whitespace validation were performed. No tests, builds, servers, runtimes, credentials or providers were exercised.

Primary references: [2026 protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).

Official implementation references: [SDK v2.2.0](https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.2.0), [HTTP factory](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md), [MRTR](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/input-required.md), [stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md). Original dependency licenses remain in their packages and packaged dependency notices.
