# MCP browser questions

URL elicitation starts off for every server. In the local desktop owner window, open Server questions,
approve exact HTTPS origins, enable browser questions and reconnect the server. Keep the questions
dialog open while completing the browser step. Closing it stops waiting; it cannot revoke authorization
already granted in the external browser.

Each question identifies its server and approved origin. Opening requires an explicit click. The native
main process consumes an expiring opaque ticket, retrieves the vetted URL privately, opens the OS browser
and returns a separate one-use handoff proof. The UI never receives the URL query or proof. URLs remain
in bounded process memory and do not enter Branch events, model input, elicitation response content or
saved settings. Messages supplied by servers are displayed as untrusted text.

Consent returns `action: accept` after the native browser handoff. It does not mean authentication
succeeded. Completion is displayed only for a matching `notifications/elicitation/complete` on the same
live connection and elicitation ID, after handoff. Unknown, pre-handoff, repeated and closed-connection
notifications cannot complete a question. The UI can decline before opening or stop waiting afterwards.
Questions expire after five minutes; handoffs expire after thirty seconds. Owner changes, app lock,
settings changes, disconnect, cancellation and a stale questions heartbeat invalidate pending work.

Initial URLs require HTTPS, no userinfo or fragment, an exact owner-approved origin, and current network
policy approval both when received and when handed off. An external browser controls its own redirects,
cookies and navigation; Branch does not claim to intercept those or prove that the user logged in. The
server remains responsible for its third-party callback, user binding and token storage. A server's
completion notification is its claim, not independent verification of the external service.

This implements negotiated SDK 1.30 push URL requests. Modern request-state continuations and the
`-32042` error containing an elicitation list are separate integration work; they are not advertised or
automatically retried here. Retrying the original tool uses normal current tool approval. Web-only owner
pages have no native handoff and do not advertise URL capability. Per-server request rates are shared
with forms and sampling; at most eight browser questions wait globally, and each connection accepts at
most 256 unique IDs before reconnecting. No new dependency is added.

The protocol was checked against the official [2025-11-25 elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
and SDK types at `2d889f2b329e46680ec9bdd565de4616c497825a` (tag 1.30.0, MIT, Anthropic PBC).
The current SDK example at `7f4c12a6ae6b8f22411f7772c88036e1c8055423` was also reviewed to distinguish
legacy notifications from modern request-state handling. This is an independent implementation using
the repository's existing SDK dependency; no upstream implementation code was copied.

Tests, builds and browser/authentication/provider/runtime executions were intentionally deferred by
the owner's instruction. Review is limited to source, diff and GitHub metadata.
