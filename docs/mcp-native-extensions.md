# Native MCP settings and composer mentions

Customize → Tools → MCP → **Server settings and mentions** lists reviewed live
connections. Opening this dialog only reads local discovery metadata. Press **Read
server settings** to call the advertised same-server read tool. Native rows support
boolean, string, string enum, number and integer properties, their declared constraints,
ordered groups and an Other settings section. Save sends only changed fields as `{set}`
to the advertised update tool and validates all effective returned values. The server
owns persistence, cross-field validation, atomicity and concurrent-update behavior.

Tool buttons require a separate owner confirmation and call the same-server reviewed
tool with `{}`. Results are displayed as text. MCP App resources returned by these
buttons are not automatically opened or granted scripting permission; the separate Apps
host remains authoritative. Known configured credentials use the existing redaction
path. These native primitive rows are not a password/credential-entry interface; schemas
declaring password formats, write-only values, defaults, references or unions are refused.
Normal manual-tool audit records apply to these tool calls, including returned settings.

Composer search is off until the owner saves the per-server preference. Type `@` and
choose **Search a reviewed MCP server…**, then search a selected server. No query is
sent merely by typing in the composer. The advertised app-visible, read-only mention
tool receives `{query}`. Resource links and SDK resource items become opaque selections,
bound to the owner, original connection and URI for two minutes. Selecting and confirming
one reads only that URI with `resources/read` on that same transport, never fetches the
URI as a URL, and attaches bounded text to the ordinary next-message attachment tray.
The owner can remove the attachment or send it explicitly. Source text is untrusted.

Current role, registry source, native visibility, owner policy, owner identity, window
lock and Lockdown are checked. In-flight requests are cancelled on guard changes;
mutations consume their ticket before sending and are never automatically retried.
Native interactions are limited to 20 requests per minute per owner/server, 64 outstanding
selections, 32 mention results, 60-KiB responses and 40-KiB attached text. Settings support
up to 64 fields and 16 groups. The existing unsafe-pattern guard rejects known unsupported
regular expressions. Resources requiring a policy sandbox are refused rather than read
outside that sandbox. Binary resources are unsupported.

Both existing SDK 1.x and modern SDK 2.2 clients expose these discovery/resource bindings.
Connections must already be live: on-demand servers appear after a task opens them. Search
does not launch, install or reconnect a server. Read/update/button/search tools must be in
the owner's reviewed allowlist. This implementation does not publish Branch to the
Codex/ChatGPT plugin catalogue or `openai/community-plugins`; that separate UP-DOTS-008
distribution requirement remains outstanding.

The actual contract was reviewed from [openai/mcp-extensions specification](https://github.com/openai/mcp-extensions/blob/e314720a0daac326217d1f123fcf51647868fa9f/docs/spec.md),
[settings SDK](https://github.com/openai/mcp-extensions/blob/e314720a0daac326217d1f123fcf51647868fa9f/typescript/src/server/settings.ts)
and [mentions SDK](https://github.com/openai/mcp-extensions/blob/e314720a0daac326217d1f123fcf51647868fa9f/typescript/src/server/mentions.ts).
The upstream license at that commit is Apache-2.0, not MIT. Branch independently binds
the protocol; no upstream implementation code or dependency is imported. Source/diff
review is the only validation in this draft; tests, builds and runtime execution are deferred.
