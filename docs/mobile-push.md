# Mobile push sender

Mobile push is off by default. The engine can send a generic "finished" or "needs you" notice to registered paired phones using FCM HTTP v1 on Android and APNs HTTP/2 on iOS. Payloads contain only the notice kind, run ID and a fixed sentence asking the owner to open Branch. Prompts, answers, approval questions and credentials never enter the payload.

## Configure in the owner window

Store credentials in the existing encrypted locker first. Configuration accepts secret references, never private keys or bearer tokens. With the local window's existing authenticated API client, POST `/api/mobile-push`:

```json
{
  "enabled": true,
  "fcm": {
    "project": "your-firebase-project",
    "credential": "secret://default/FCM_SERVICE_ACCOUNT"
  },
  "apns": {
    "teamId": "ABCDEFGHIJ",
    "keyId": "ABCDEFGHIJ",
    "topic": "com.keepoak.branchagent",
    "sandbox": false,
    "credential": "secret://default/APNS_PRIVATE_KEY"
  }
}
```

FCM_SERVICE_ACCOUNT contains the Google service-account JSON with `client_email` and `private_key`; grant it permission to send FCM messages in the configured project. APNS_PRIVATE_KEY contains the Apple `.p8` signing key for the team/key IDs. APNs topic must match the app's bundle ID, and sandbox must match its provisioning environment. No additional SDK dependencies are needed: Node signs JWTs and sends HTTP/2 requests directly.

Only an unlocked owner window on this computer may configure or inspect `/api/mobile-push`. Phones, household profiles and short-lived script keys cannot configure the sender. POST the full configuration with `enabled: false` to stop sending and abort pending requests.

## Registration and revocation

The native clients register their received provider token through `/api/mobile-push/register` only when the phone's push switch permits it. The phone must use its own currently paired key. The server derives device identity from that key, rather than accepting a caller-supplied device ID. Tokens are encrypted in the locker; settings and GET responses contain no token values.

Registrations expire after 24 hours and renew when the app reads its paired session, pairs or changes its push switch. There are at most 20 registrations and 20 active deliveries. Turning the switch off or forgetting the paired session requests `/api/mobile-push/unregister`. An owner can immediately revoke a registration in the local window by POSTing `{ "id": "paired-device-id" }` to `/api/mobile-push/revoke`. Removing a paired device, rotating its key or blocking it in the remote sender allowlist also prevents subsequent push sends.

If a phone is offline when forgotten or switched off, its unregister request may not reach the computer. Its registration then expires within 24 hours; remove the device or revoke its registration in the owner window to stop sends sooner. A notification already accepted by Apple or Google cannot be recalled.

Lock and Lockdown suppress delivery; app lock and shutdown abort in-flight requests. Credentials resolve through the normal secret lock gate. Fixed official provider hosts follow the current network policy. Delivery uses a ten-second deadline, bounded responses, no retries, and at most 200 in-memory duplicate keys. Invalid/unregistered provider tokens are removed. Minimal `mobile_push.delivery` events record provider and acceptance booleans only. Provider acceptance is not proof that a phone displayed a notification.

## Provider setup and verification boundary

Android still requires the existing push build flavor and the owner's Firebase `google-services.json`; iOS requires push entitlement/provisioning and Apple credentials. The sender code does not create provider projects or accounts. No live push, credential read or device delivery was exercised for this implementation.

Protocol references: [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [APNs notification requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [APNs connections](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns).
