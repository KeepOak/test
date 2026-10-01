# GitHub device connection

In Settings → Developer, supply the public client ID of an OAuth app registered for Branch with GitHub's device flow enabled. Branch has no bundled OAuth identity and does not use another provider's client ID. See [GitHub's device flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

Choose **Connect with GitHub**, open the consent link, and enter the displayed code. GitHub asks for `repo read:user`; review the app identity and access on GitHub before approving. Branch verifies the resulting account, shows its login, and saves the access token in the encrypted default-project locker. Neither the API nor the model receives the token. Device codes are private to one in-memory flow, disappear on cancellation/lock/close, and expire after the provider's lifetime, capped at 30 minutes. Pending, slow-down and rate-limit replies retain the server's polling floor.

The connection supplies a missing token to already configured public GitHub integrations. Enable those integrations through the existing launch file, for example:

```json
{ "git": { "github": {} } }
```

Existing project tokens take precedence. The existing GitHub App selection takes precedence and a failing App does not fall back to this connection. Enterprise origins keep their existing credentials; this token reaches only `https://api.github.com/`. Tool permissions and review/merge approvals retain their existing gates.

**Disconnect** removes the local token and cancels pending sign-in. Changing the client ID also disconnects. Removing or rotating its locker entry invalidates it. To revoke authorization at GitHub as well, remove the OAuth app under GitHub's authorized applications. Expiring tokens require a new sign-in; refresh tokens are not stored or used by this implementation.

Only the unlocked owner's local app window can configure or complete the flow. Short-lived keys, task tools, household profiles, remote callers and Lockdown cannot do so. Configuration/account changes and local revocation are checked again after network reads and locker writes; a token from a stale flow is removed. A process restart abandons pending consent. The UI refreshes the flow on return from the consent tab rather than relying on a browser redirect callback.
