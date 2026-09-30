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

SDK 1.30 push questions must originate inside a single live tool call on the same connection. The
call's real running task, original permission, exact arguments, current policy and role are checked
before handing off. Interactive legacy calls on one connection cannot overlap because the legacy
request lacks a reliable parent-call identifier. Consent can finish the tool while the completion UI
remains bound to that original task's lifetime; no later task inherits it.

SDK 2.2 modern questions use the named embedded input request and the exact returned request state.
A local request generation pins even state-free questions to the actual originating response. Modern
URL capability is advertised only with the live native owner handoff. After opening, the owner must
explicitly continue the exact task/tool/arguments; this sends `action: accept` in the original named
input response. There is no invented modern completion notification. The server checks its external
authorization when the request continues. If it omitted request state, the owner still sees and
approves repeating the exact original request. State idempotency remains the server's responsibility.
Held continuation state is consumed before sending so ambiguous failures cannot silently reuse it.

The `-32042` URL-required error list is handled on the same source connection, with at most four
questions. Legacy completion notifications can advance a browser step; the owner can also explicitly
finish waiting and review a retry when no notification arrives. Modern steps require owner continuation.
After all steps, a separate native form names the exact original task, tool and arguments and warns
that the first attempt might already have changed something. Only “Retry this exact tool once” permits
one retry, after fresh current permission, role, policy, owner, settings, connection and task checks.
Neither transport failures nor a second URL error are automatically retried. No exactly-once execution
or authentication success is inferred from browser consent or the server's completion claim.

Web-only owner pages have no native handoff and do not advertise URL capability. Per-server request
rates are shared with forms and sampling; at most eight browser questions wait globally, and each
connection accepts at most 256 unique IDs before reconnecting. Modern calls retain the existing two
minute hard deadline, which can cancel a browser step sooner than its five minute ceiling. This change
uses the pinned SDK 2.2 dependencies from the modern MCP prerequisite stack, without another dependency.

The protocol was checked against the official [2025-11-25 elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
and SDK types at `2d889f2b329e46680ec9bdd565de4616c497825a` (tag 1.30.0, MIT, Anthropic PBC).
The current SDK example at `7f4c12a6ae6b8f22411f7772c88036e1c8055423` was also reviewed to distinguish
legacy notifications from modern request-state handling. This is an independent implementation using
the pinned SDK dependency; no upstream implementation code was copied. SDK 2.2 package metadata declares
MIT; its source license also contains the project's Apache-2.0/MIT transition notice, which was read.

Tests, builds and browser/authentication/provider/runtime executions were intentionally deferred by
the owner's instruction. Review is limited to source, diff and GitHub metadata.
