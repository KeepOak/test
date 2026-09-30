# Plain-text plugin window contributions

An enabled Branch plugin may export `window` alongside its existing tools/hooks/providers/channels. The manifest must declare `ui.contribute`, and that permission must survive the owner's enable grant. Otherwise the loader leaves its window entries out and explains why. Disabling/unloading removes the entries from the live loader; restored plugins pass the same grant and schema checks.

Each entry has a local `id` and existing owner `sessionId`. The host namespaces its id and attaches plugin provenance. At most 20 entries per plugin and 100 per response are accepted. These are static data declarations, not callbacks or renderer code. No HTML is executed, no new screen is registered, and no contribution can change the model or send a message.

```typescript
export default {
  id: "draft-helper", name: "Draft helper", permissions: ["ui.contribute"],
  window: [
    { id: "review", sessionId: "EXISTING-OWNER-SESSION-UUID", slot: "row-badge", messageId: 12, text: "Needs review" },
    { id: "label", sessionId: "EXISTING-OWNER-SESSION-UUID", slot: "model-pill", text: "Draft helper active" },
    { id: "draft", sessionId: "EXISTING-OWNER-SESSION-UUID", slot: "composer-draft", label: "Review this plan", text: "Please review this plan before proceeding." },
  ],
};
```

Replace the illustrative session placeholder with a real UUID before loading. Row message ids are positive integers from that conversation. Labels are 1–80 characters; draft text is 1–4000 characters. Unknown fields, executable functions and duplicate local ids are rejected. The host renders only escaped text with an attributed plugin name. Row badges appear in message rows, additive labels appear inside the existing model pill, and composer draft buttons open an exact-text preview.

Append to draft requires an owner click, re-reads the enabled contribution through the guarded API, compares the exact preview, and verifies that the profile, conversation and current composer text stayed unchanged across the request. It appends while retaining existing text, dispatches the usual draft input event, and leaves Send to the owner. No model call occurs. It refuses signed-person callers, short-lived keys, non-owner profiles, locked sessions and lockdown. Household-profile contributions are intentionally not supported. Labels refresh on normal window redraws, with a five-second read throttle; approval always revalidates live enablement.

The existing loader is trusted in-process plugin code; this data-only renderer contract does not sandbox that code. Walled plugin forwarding of window entries is not added here. Sources: the named contribution areas and provenance idea were reviewed in [Hermes plugin.ts at f42f579](https://github.com/NousResearch/hermes-agent/blob/f42f579cf8bac4918ac9599bece71618afadd846/apps/desktop/src/contrib/plugin.ts) and its [MIT licence](https://github.com/NousResearch/hermes-agent/blob/f42f579cf8bac4918ac9599bece71618afadd846/LICENSE). This is an independent Branch implementation, without copied renderer code.

This narrow PR starts at frozen a0ff8588241c35dee31a0bb806e3571e0e3f703b; it does not stack other plugin PRs. Integrations are limited to the existing loader, guarded plugin API, message action row, model pill and composer. Source review and diff checks are the delivery evidence; tests/builds/app/provider/model/database/credential execution were forbidden. Runtime/UI verification and localization remain outstanding.
