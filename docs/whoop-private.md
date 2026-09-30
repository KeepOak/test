# Private WHOOP sleep and recovery

Stack prerequisite: Oura connector PR #1257. Its account gates are extracted into a shared implementation without enabling automatic token refresh. Oura configuration keys, grant identities, scopes and fixed loopback redirect remain compatible.

WHOOP is off until the owner saves an application client ID, secret reference and exact registered `http://127.0.0.1:<port>/callback` redirect, then clicks Authorize. It requests only `read:sleep` and `read:recovery`; no offline access. Saved token metadata is not connection proof. Missing returned scope is reported as unknown, and returned expiry requires a new explicit authorization. Configuration changes invalidate local access.

The owner window offers an explicit private read of up to 31 UTC days. Official v2 recovery and sleep collection requests each stop after two pages of 25 records, report truncation, cap response size and have a timeout. Displayed recovery timestamps are creation times, not sleep dates. Provider range semantics apply. Provider responses contain broader metrics than the projected score/duration display; metrics are neither persisted nor sent to models. No background sync, model tools, clinical interpretation or automatic retries are added.

Disable invalidates the local grant. A separate explicit Revoke control calls the official user-access DELETE endpoint; only HTTP 204 is an acknowledged provider revocation. If the token has expired or the request fails, local access is disabled and the UI directs the owner to revoke in WHOOP. No secret or token is returned to the window.

Configuration uses its own strict validated save operation rather than the settings-kit recordedWrite catalogue. Owner profile, private window, original caller and unchanged configuration are checked across asynchronous authorization and read operations.

Primary references: [WHOOP API](https://developer.whoop.com/api/), [OAuth](https://developer.whoop.com/docs/developing/oauth/), [support](https://developer.whoop.com/docs/developing/support/), [terms](https://www.whoop.com/us/en/whoop-terms-of-use/). No SDK or upstream source was copied and no dependency was added. Application approval, membership/device requirements and commercial API pricing remain unverified; the form discloses that before consent.

[Google Health's migration notice](https://developers.google.com/health/about) states that the legacy Fitbit Web API turns down in September 2026. This implements the authorized WHOOP fallback, not a new legacy Fitbit integration. Google Health/Fitbit and native Apple Health require separate connectors. No provider, authentication, model, database or app execution, build or tests were performed during this source-only delivery; live OAuth and provider behavior remain unverified.
