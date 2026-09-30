# MCP tool names and saved access

Connected and cached server tools now use `mcp__<server>__<tool>` callable names.
Names use lowercase letters, digits, underscores and hyphens and fit the provider's
64-character limit. Names shortened or changed by sanitization receive a stable
16-hex-character suffix derived from the original server/tool pair. This avoids
case, punctuation and truncation collisions; registration refuses a residual
collision instead of silently replacing a tool. Dispatch still sends the original
remote tool name to its server.

Access migration is a compatibility projection, not a destructive database edit:

- The permission remains `mcp.<server>.<sha256(originalTool)[0:16]>`. Existing saved
  grants, schedules, delegated permission sets and resumed tasks therefore keep
  exactly the same permission identity; no access is broadened by rewriting names.
- Once a configured or cached tool's name has been computed, policy evaluates each
  rule against both spellings. The first matching rule still wins, with unchanged
  targets, resources, Trunk scope and read/change restrictions. Old exact and
  wildcard rules (including hash-prefix patterns) keep their original coverage.
- Newly saved rules may use readable names. Old stored calls remain dispatchable
  through registry lookup aliases; only the readable name is listed to the model.
- Source metadata identifies the server for context modes, tool removal and MCP
  app events instead of parsing the callable spelling.

The mapping is rebuilt from configured original tool names on every launch. An
unavailable/unconfigured tool is never made callable merely because a saved rule
or permission names it. Existing one-time approval fingerprints are not rewritten;
a newly spelled call can require a fresh one-time approval.

Adapted from Hermes's pinned MIT naming implementation (see third-party notices),
with Branch's lowercase registry syntax, collision handling and stable permissions.
No tests, builds, app launches or remote tool calls were run for this delivery at
the owner's request. Before release, validate restart/cache paths, persisted exact
and wildcard rules in both spellings, saved/delegated/resumed grants, collision
cases, provider dispatch and server removal. Integrate alongside MCP drafts #962,
#971 and #1044 without discarding their changes.
