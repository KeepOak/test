# Older web MCP servers

Branch first connects to a web server with Streamable HTTP. If connection fails without an authentication challenge and there is time left in the startup deadline, it closes that transport and tries the SDK's older SSE transport once at the same address. This applies to saved connections, first-time tool discovery, and the manual workbench.

A 401 or the SDK's `UnauthorizedError` asks the owner to open the server under Customize → Tools and choose Sign in. Branch does not treat that challenge as a transport mismatch or open a browser automatically. Both attempts carry the same server-bound OAuth provider when one was supplied, or the explicitly configured key, through the existing guarded, pinned, bounded fetch. The SDK requires an SSE POST endpoint to share the stream's origin. Redirects remain refused. Failed transports are closed; one startup deadline includes waiting for a legacy stream to announce its endpoint.

Fallback happens only while connecting. Version mismatches, missing allowlisted tools, incompatible schemas, and later tool failures never select another transport. There is no transport retry loop or remembered downgrade.

The connection sequence is adapted from [Gemini CLI's MCP client](https://github.com/google-gemini/gemini-cli/blob/40d4dccfa9aec692b27798ca819b918609e2bc60/packages/core/src/tools/mcp-client.ts#L1903-L1980), Copyright 2025 Google LLC, Apache-2.0. It uses the existing MCP SDK dependency; no transport implementation was vendored.

This change depends on the SDK OAuth provider in #998. Integrate the independent tool-output, live catalogue, secret binding, and timeout drafts separately. No server was contacted and no OAuth flow or runtime check was executed. Compatibility with a real legacy server remains unverified. Rollback removes this draft's connection helper and restores direct Streamable HTTP connection while retaining #998's sign-in implementation.
