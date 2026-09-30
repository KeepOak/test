# Questions and model requests from an MCP server

UP-RESEARCH-011 adds working `sampling/createMessage` and form
`elicitation/create` handlers. Both features are off for every server until the
owner enables them. They are independent of Branch's shared MCP server settings.

Open **Server questions** in the local window, choose the configured server ID,
select the features, limits and allowed model connections, and save. Reconnect
that server with this dialog open. MCP capabilities are declared at connection
initialization only when the feature is enabled and a visible owner form recently
renewed its heartbeat. Servers connected earlier must reconnect to renegotiate.
Closing the dialog cancels pending requests; a missing/hidden window expires its
15-second heartbeat. Household profiles, remote-door/LAN callers, short-lived
keys and Lockdown cannot authorize requests. Each approval is a one-time answer
to an immutable server request, not a saved policy grant.

Sampling shows the exact messages, chosen model and output limit before sending.
The owner can allow, decline or cancel each request. No Branch or native program
tools, implicit conversation history or other servers' context are supplied.
Only text messages and no-context sampling are supported; image/audio, tool-use,
URL elicitation and task-based requests are not advertised. Model hints must name
an allowed preset ID or its exact model ID. There is no fallback outside the
server's model allowlist.

Every server has one shared rolling minute request limit for both features (default
3, maximum 20), maximum sampling output tokens (default 2048, maximum 8192), and an
explicit model allowlist. The output cap is clamped against the server's request
and transmitted through audited adapters. Input and owner-visible request payloads
are separately limited to 32 KiB; token limits do not pretend to measure arbitrary
providers' input tokenization. Generation times out after 30 seconds. Each request
waits for the owner for at most two minutes; SDK cancellation, disabling settings,
window disappearance and changing household identity also stop pending requests.
Model calls are recorded as their own run with reported/estimated usage, without
saving prompt or returned content in the run log.

Supported sampling adapters: OpenAI-compatible, OpenAI Responses, Anthropic,
Anthropic Vertex, Gemini, Bedrock, Cohere, Azure OpenAI and Ollama. This uses existing
model connections and does not read or configure credentials. ChatGPT subscription
is unavailable because its current adapter omits the output cap. CLI/subscription
program adapters are unavailable because their native tools/time do not provide
the required guarantee. These connections are omitted from the settings list.

Elicitation displays the server's message and individual schema fields. Accepted
answers are validated against the SDK's requested form schema before completing
the request; unknown properties are refused. Decline/cancel responses send no form
content. Text is inserted using DOM textContent, never HTML from the server. List
answers use a JSON array entry; primitive fields use text, number or checkbox inputs.

Protocol/source review: installed MCP SDK 1.30.0 request/capability schemas and
client handler implementation; official MCP 2025-11-25 sampling/elicitation specs;
Hermes a9a54245 tools/mcp_tool_sampling.py lines 90-120 and 178-186 and its MIT
license. Hermes was used as a limit/gate comparison; implementation is independent.

No tests, builds, app launches, model/provider/tool calls, databases or credentials
were exercised for this draft by owner instruction. Before release, verify owner
identity/remote boundaries, window closure and cancellation, capability handshake,
exact request approval, form schemas, allowlist/rate/token limits and provider caps.
Integrate with readable-name PR #1124: this feature keys settings/requests by the
original server ID and does not rename tool names or permission identities.
