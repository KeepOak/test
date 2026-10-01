# Stateless MCP HTTP foundation

The existing SDK 1.30.0 supports handshake-based revisions through 2025-11-25. It is not used to manufacture a 2026 protocol version label. This foundation adds a separate HTTP request adapter and client for the request-local wire format described by the published 2026-07-28 specification. Legacy behavior remains the default.

## Server read preview

In the existing owner-local MCP sharing settings (`POST /api/mcp/settings`), explicitly set `statelessPreview: true` alongside `enabled: true` and the existing shared tool choices. `/mcp` then accepts request-local `server/discover`, `ping`, resource list/read and prompt list/get requests. It never creates an MCP session for those requests, inherits no connection approvals and does not execute tools. Discovery advertises resources and prompts only, with zero cache lifetime and private scope. Every result contains `resultType: "complete"` and per-response server identity.

Each request must provide `params._meta` containing `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`. HTTP headers must mirror the version, RPC method and relevant resource URI/prompt name; names support the specification's UTF-8 Base64 sentinel encoding. Missing metadata, mismatched headers and protocol sessions fail before dispatch. Modern GET/DELETE are refused. Authentication, origin validation, app lock, Lockdown and the owner's sharing/policy checks remain on the existing request path. No client identity or capabilities are inferred from another request.

## External HTTP client preview

HTTP MCP connection configuration accepts `protocol: "stateless-preview"` or `protocol: "auto"`. The default is `"legacy"`. The preview sends fresh protocol/capability/client metadata and routing headers on every POST, supports bounded JSON or request-scoped SSE results, checks JSON-RPC response identity and requires `resultType: "complete"`. It discovers reviewed allowlisted tools, validates their header annotations, mirrors statically reachable primitive `x-mcp-header` parameters, and invokes them through the existing registry and runtime permission gates. The preview retains the configured server-version review check and credential redaction. It opens no GET stream and sends no session ID or initialization notification.

`auto` probes only the side-effect-free `server/discover` method. A recognized modern error remains modern; an unsupported-version error can negotiate to an advertised compatible legacy revision through the installed SDK. A legacy probe rejection can fall back to initialization. Header/capability errors do not fall back. A failed tool call is never automatically retried or repeated as legacy execution.

## Remaining migration work

This is a coherent foundation, not full 2026-07-28 conformance. The server preview is read-only; executing shared tools with request-local approval context remains unimplemented. MRTR `input_required`, elicitation/sampling/roots round trips, notification/subscription streams, logging/progress, tasks/extensions, stdio migration, full method-specific schema validation and interoperability testing remain gaps. The client rejects `input_required` or unknown result types and does not advertise those capabilities. Stateless preview does not advertise or host the MCP Apps extension; the existing legacy Apps path is separate. No global legacy supported-version list is relabeled as fully 2026-capable.

No SDK dependencies were changed. No servers, tests, builds, runtimes, credentials or providers were exercised for this delivery. Source inspection and whitespace validation establish code-review evidence only.

Primary references: [2026 protocol overview](https://modelcontextprotocol.io/specification/2026-07-28/basic), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).
